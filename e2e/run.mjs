// End-to-end test: the built extension in Chromium against a real local validator
// running the wallet program. Covers create → fund → on-chain setup → receive →
// send SOL (interrupted and resumed) → send SPL token → lock/unlock → backup.
//
//   npm run build && npm run e2e
//
// Needs solana-test-validator (QS_SOLANA_BIN or PATH) and the core repository's
// built program at ../quantum-seal-wallet/target/deploy/seal_wallet.so.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { confirmByPolling } from '../src/wallet-service.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = join(root, 'dist');
const programPath = resolve(root, '../quantum-seal-wallet/target/deploy/seal_wallet.so');
const solanaBin = process.env.QS_SOLANA_BIN ?? join(process.env.HOME, '.local/solana/bin');
// The associated-token program binary from Agave 3.1.10 (see e2e/fixtures/README.md).
const ataProgramPath = process.env.QS_ATA_PROGRAM ?? join(here, 'fixtures/spl_associated_token_account-1.1.1.so');
const RPC = 'http://127.0.0.1:8899';
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZ9zbHQBhL1v8Tq9GZy3s3pVm');
const PASS = 'e2e test passphrase 123';
const NEW_PASS = 'a changed e2e passphrase';
const results = [];
const step = (name) => {
  results.push(name);
  console.log(`PASS ${name}`);
};
// QS_E2E_SHOTS=1 saves a screenshot of each listed screen to .runtime/shots/.
const shots = process.env.QS_E2E_SHOTS === '1';
async function shot(page, name) {
  if (!shots) return;
  mkdirSync(join(root, '.runtime/shots'), { recursive: true });
  await sleep(450); // let sheet and fade animations settle
  await page.screenshot({ path: join(root, '.runtime/shots', `${name}.png`) });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Right after a transaction confirms, a 'confirmed' read can still come from the previous
// bank for a moment. Balance checks after a send first wait for the next confirmed slot.
let rpc = null;
async function settled() {
  const start = await rpc.getSlot('confirmed');
  for (let i = 0; i < 100 && (await rpc.getSlot('confirmed')) <= start; i++) await sleep(100);
}
// The send journal: one chrome.storage.local key per send ("send:<id>"), oldest first.
const journal = (page) =>
  page.evaluate(async () =>
    Object.entries(await chrome.storage.local.get(null))
      .filter(([k]) => k.startsWith('send:'))
      .map(([, v]) => v)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  );
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const work = mkdtempSync(join(tmpdir(), 'qs-e2e-'));
let validator, context;
try {
  // 1. Local validator with the wallet program preloaded with no upgrade authority.
  const programId = (await Keypair.generate()).publicKey;
  const binary = readFileSync(programPath);
  validator = spawn(
    join(solanaBin, 'solana-test-validator'),
    ['--ledger', join(work, 'ledger'), '--reset', '--quiet', '--bind-address', '127.0.0.1', '--rpc-port', '8899',
      '--upgradeable-program', programId.toBase58(), programPath, 'none',
      // The associated-token program is not in the validator's default genesis.
      '--bpf-program', ATA_PROGRAM.toBase58(), ataProgramPath],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const connection = new Connection(RPC, 'confirmed');
  rpc = connection;
  for (let i = 0; ; i++) {
    try {
      await connection.getLatestBlockhash();
      break;
    } catch {
      if (i > 120) throw new Error('Validator did not start.');
      await sleep(500);
    }
  }
  const genesis = await connection.getGenesisHash();
  const funder = await Keypair.generate();
  {
    const latest = await connection.getLatestBlockhash('confirmed');
    const sig = await connection.requestAirdrop(funder.publicKey, 50 * LAMPORTS_PER_SOL);
    await confirmByPolling(connection, sig, latest.lastValidBlockHeight, 'confirmed');
  }
  const send = async (instructions, signers) => {
    const latest = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: signers[0].publicKey, recentBlockhash: latest.blockhash });
    tx.add(...instructions);
    await tx.sign(...signers);
    const sig = await connection.sendRawTransaction(await tx.serialize());
    await confirmByPolling(connection, sig, latest.lastValidBlockHeight, 'confirmed');
  };
  step('local validator runs the wallet program');

  // 2. Chromium with the unpacked extension.
  context = await chromium.launchPersistentContext(join(work, 'profile'), {
    // The full Chromium build in new-headless mode loads extensions; the headless shell does not.
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    acceptDownloads: true,
    viewport: { width: 420, height: 760 },
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const popup = await context.newPage();
  // Inject transient storage failures in the real extension page, without replacing
  // the vault/service code. Other pages (including the signing worker) are untouched.
  await popup.addInitScript(() => {
    const get = chrome.storage.local.get.bind(chrome.storage.local);
    const key = new URL(location.href).searchParams.get('failStorage');
    window.__storageFault = { key, remaining: key ? 1 : 0 };
    chrome.storage.local.get = async (keys) => {
      const fault = window.__storageFault;
      if (fault?.remaining && keys === fault.key) {
        fault.remaining--;
        throw new Error('Storage is temporarily unavailable.');
      }
      return get(keys);
    };
  });
  // The toolbar popup is 400x600.
  await popup.setViewportSize({ width: 400, height: 600 });
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  await popup.goto(`${popupUrl}?failStorage=vault`);
  await popup.getByRole('heading', { name: 'Could not open Quantum Seal' }).waitFor();
  await shot(popup, '00-open-error');
  await popup.getByRole('button', { name: 'Try again', exact: true }).click();
  await popup.getByPlaceholder('Passphrase (12+ characters)').waitFor();
  step('a transient wallet-open failure is visible and retry recovers');
  await popup.goto(popupUrl);
  // A development build is pinned to this validator through Settings storage.
  await popup.evaluate(
    (settings) => chrome.storage.local.set({ settings }),
    {
      cluster: 'localnet',
      autoLockMinutes: 15,
      rpc: {},
      deployments: {
        localnet: {
          program: programId.toBase58(),
          programSha256: hex(sha256(binary)),
          programSize: binary.length,
          // solana-test-validator records "no authority" as the system program address.
          upgradeAuthority: '11111111111111111111111111111111',
          genesis,
        },
      },
    },
  );
  await popup.reload();
  step('extension loads and is pinned to the local deployment');

  // 3. Create the vault.
  await shot(popup, '01-welcome');
  // Inter Variable is bundled with the extension and loads under its CSP.
  // Browsers fetch a font only once text uses it: wait for the rendered welcome screen,
  // then request Inter explicitly so a CSP block would show up as a load failure.
  await popup.getByPlaceholder('Passphrase (12+ characters)').waitFor({ timeout: 30000 });
  const fonts = await popup.evaluate(async () => {
    await document.fonts.load('16px "Inter Variable"');
    await document.fonts.ready;
    return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family);
  });
  assert.ok(fonts.some((f) => f.includes('Inter Variable')), `loaded fonts: ${fonts}`);
  await popup.getByPlaceholder('Passphrase (12+ characters)').fill(PASS);
  await popup.getByPlaceholder('Repeat passphrase').fill(PASS);
  await popup.getByRole('button', { name: 'Create wallet' }).click();
  await popup.getByRole('heading', { name: 'Set up your wallet' }).waitFor({ timeout: 60000 });
  await shot(popup, '02-setup');
  // Every non-mainnet screen carries the test-network banner.
  assert.match(await popup.locator('.test-banner').textContent(), /Test network · Local validator/);
  const feeKey = new PublicKey((await popup.locator('code.address').first().textContent()).trim());
  step('wallet keys are created and the setup address is shown');

  // 4. "User" funds the setup address once; the extension creates the wallet.
  await send([SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: feeKey, lamports: 2n * BigInt(LAMPORTS_PER_SOL) })], [funder]);
  assert.match(await popup.locator('main').textContent(), /Send at least 0\.08 SOL/);
  await popup.getByRole('button', { name: 'Refresh' }).click();
  await popup.getByRole('button', { name: 'Create my wallet' }).click({ timeout: 60000 });
  await popup.locator('.balance .amount').waitFor({ timeout: 120000 });
  const balanceText = await popup.locator('.balance .amount').textContent();
  assert.ok(parseFloat(balanceText) > 1.9, `wallet balance after setup: ${balanceText}`);
  await settled();
  const feeAfterSetup = BigInt(await connection.getBalance(feeKey, 'confirmed'));
  assert.ok(feeAfterSetup >= 69000000n && feeAfterSetup <= 70000000n, `fee float ${feeAfterSetup}`);
  await shot(popup, '03-home');
  step('one funding transfer creates the wallet and moves the rest behind the post-quantum key');

  // A settings failure must show an actionable error instead of a permanent spinner.
  await popup.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    window.__storageFault = { key: 'settings', remaining: 1 };
    await chrome.storage.local.set({ settings: { ...settings, autoLockMinutes: 16 } });
  });
  await popup.getByRole('heading', { name: 'Could not load wallet settings' }).waitFor();
  await popup.getByRole('button', { name: 'Try again', exact: true }).click();
  await popup.locator('.balance .amount').waitFor({ timeout: 60000 });
  step('wallet settings recover after a transient storage failure');
  await popup.evaluate(() => { window.__storageFault = { key: 'settings', remaining: 1 }; });
  await popup.getByRole('button', { name: 'Settings', exact: true }).click();
  await popup.getByText('Could not load settings.', { exact: false }).waitFor();
  await popup.getByRole('button', { name: 'Try again', exact: true }).click();
  await popup.getByLabel('Auto-lock after (minutes)').waitFor();
  step('the Settings page reports a failed read and retries successfully');

  // Unknown backup/deposit state must never enable destructive wallet removal.
  await popup.evaluate(() => { window.__storageFault = { key: 'vault', remaining: 1 }; });
  await popup.getByRole('button', { name: /Remove from this browser/ }).click();
  await popup.getByText('Could not check the wallet and unfinished sends.', { exact: false }).waitFor();
  assert.equal(await popup.locator('input[type="checkbox"]').isDisabled(), true);
  assert.equal(await popup.getByRole('button', { name: 'Remove wallet from this browser' }).isEnabled(), false);
  await shot(popup, '02b-removal-error');
  await popup.getByRole('button', { name: 'Try again', exact: true }).click();
  await popup.getByLabel('Type REMOVE to confirm').waitFor();
  assert.equal(await popup.getByRole('button', { name: 'Remove wallet from this browser' }).isEnabled(), false);
  assert.ok((await popup.evaluate(() => chrome.storage.local.get('vault'))).vault);
  await shot(popup, '02b-removal-recovered');
  await popup.getByRole('button', { name: 'Back', exact: true }).click();
  await popup.getByRole('button', { name: 'Back', exact: true }).click();
  await popup.locator('.balance .amount').waitFor({ timeout: 60000 });
  step('wallet removal remains disabled after a prerequisite failure and retry refreshes the warnings');

  // The header's network picker opens a bottom sheet; mainnet stays disabled until pinned.
  await popup.getByRole('button', { name: /^Viewing Local validator/ }).click();
  const networks = popup.getByRole('dialog');
  await networks.getByRole('button', { name: /Devnet/ }).waitFor();
  assert.ok(await networks.getByRole('button', { name: /Mainnet/ }).isDisabled());
  await shot(popup, '03b-network');
  await networks.getByRole('button', { name: 'Close' }).click();

  // 5. Receive (a bottom sheet).
  await popup.getByRole('button', { name: 'Receive', exact: true }).first().click();
  const receiveSheet = popup.getByRole('dialog');
  await receiveSheet.locator('code.address').waitFor({ timeout: 30000 });
  await shot(popup, '04-receive');
  const walletAddress = new PublicKey((await receiveSheet.locator('code.address').textContent()).trim());
  assert.ok((await popup.locator('svg.qr').count()) === 1);
  await receiveSheet.getByRole('button', { name: 'Close' }).click();
  assert.equal(await connection.getAccountInfo(walletAddress).then((a) => a.owner.toBase58()), programId.toBase58());
  step('receive shows the program-owned wallet address with a QR code');

  // 6. Send SOL, interrupt it mid-upload, then resume from on-chain state.
  const recipient = (await Keypair.generate()).publicKey;
  await send([SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: recipient, lamports: 1000000n })], [funder]);
  await popup.getByRole('button', { name: 'Send', exact: true }).click();
  await popup.getByPlaceholder('Recipient address').fill(recipient.toBase58());
  await popup.getByPlaceholder('Amount').fill('0.25');
  await shot(popup, '05a-send');
  const reviewPromise = context.waitForEvent('page');
  await popup.getByRole('button', { name: 'Review' }).click();
  let review = await reviewPromise;
  await review.waitForLoadState();
  await review.getByRole('heading', { name: 'Review transfer' }).waitFor();
  await shot(review, '05-review');
  assert.match(await review.locator('.test-banner').textContent(), /Test network · Local validator/);
  const reviewText = await review.locator('main').textContent();
  assert.match(reviewText, /0\.25 SOL/);
  assert.ok(reviewText.includes(recipient.toBase58()));
  assert.match(reviewText, /Fee refill to your fee address/);
  step('the review window shows the decoded recipient, amount and fee refill before signing');
  const reviewUrl = review.url();
  await review.getByRole('button', { name: 'Approve & send' }).click();
  // Interrupt deterministically: close the window right after the 2nd chunk confirms.
  for (let i = 0; ; i++) {
    const chunks =
      (await journal(popup))[0]?.records.filter((r) => r.phase === 'confirmed' && r.label.includes('upload-chunk')).length ?? 0;
    if (chunks >= 2) break;
    if (i > 2400) throw new Error('Upload never started.');
    await sleep(25);
  }
  await review.close();
  step('a send is interrupted by closing its window mid-upload');
  review = await context.newPage();
  await review.goto(reviewUrl);
  const resume = review.getByRole('button', { name: /Resume/ });
  await resume.first().click();
  await review.getByText('Sent.', { exact: true }).waitFor({ timeout: 180000 });
  await shot(review, '06-sent');
  // The done screen links the executing transaction on the explorer.
  const execRecord = (await journal(review))[0].records.find((r) => r.phase === 'confirmed' && r.label.includes('execute-wallet-transfer'));
  assert.ok(execRecord, 'execute transaction recorded');
  const explorerHref = await review.getByRole('link', { name: /View on Solana Explorer/ }).getAttribute('href');
  assert.ok(explorerHref.includes(`/tx/${execRecord.signature}`), explorerHref);
  await settled();
  const received = BigInt(await connection.getBalance(recipient, 'confirmed'));
  assert.equal(received, 1000000n + 250000000n);
  const sendRecord = (await journal(review))[0];
  const chunks = sendRecord.records.filter((r) => r.phase === 'confirmed' && r.label.includes('upload-chunk')).length;
  assert.equal(chunks, 11);
  step('the resumed send completes with exactly 11 uploaded chunks and the exact amount');
  const feeAfterSend = BigInt(await connection.getBalance(feeKey, 'confirmed'));
  assert.ok(feeAfterSend > feeAfterSetup - 100000n, `fee key ${feeAfterSetup} -> ${feeAfterSend}`);
  step('the fee refund keeps the fee key topped up');
  await review.close();

  // 7. Token balance and token send (classic SPL, recipient account must exist).
  const mint = await Keypair.generate();
  const ataOf = async (owner) => (await PublicKey.findProgramAddress([owner.toBytes(), TOKEN_PROGRAM.toBytes(), mint.publicKey.toBytes()], ATA_PROGRAM))[0];
  const walletAta = await ataOf(walletAddress),
    recipientAta = await ataOf(recipient);
  const ata = (owner) => (owner.equals(walletAddress) ? walletAta : recipientAta);
  const createAta = (owner) =>
    new TransactionInstruction({
      programId: ATA_PROGRAM,
      keys: [
        { pubkey: funder.publicKey, isSigner: true, isWritable: true },
        { pubkey: ata(owner), isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: false },
        { pubkey: mint.publicKey, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]),
    });
  const tokenIx = (keys, data) => new TransactionInstruction({ programId: TOKEN_PROGRAM, keys, data: Buffer.from(data) });
  const u64 = (n) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
    return b;
  };
  await send(
    [
      SystemProgram.createAccount({
        fromPubkey: funder.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports: await connection.getMinimumBalanceForRentExemption(82),
        space: 82,
        programId: TOKEN_PROGRAM,
      }),
      tokenIx([{ pubkey: mint.publicKey, isSigner: false, isWritable: true }], [20, 6, ...funder.publicKey.toBytes(), 0]),
      createAta(walletAddress),
      createAta(recipient),
      tokenIx(
        [
          { pubkey: mint.publicKey, isSigner: false, isWritable: true },
          { pubkey: ata(walletAddress), isSigner: false, isWritable: true },
          { pubkey: funder.publicKey, isSigner: true, isWritable: false },
        ],
        [7, ...u64(5000000n)],
      ),
    ],
    [funder, mint],
  );
  await popup.locator('nav').getByRole('button', { name: 'Home' }).click();
  await popup.locator('.token-row').filter({ hasText: '5' }).first().waitFor({ timeout: 30000 });
  assert.match(await popup.locator('main').textContent(), /Tokens/);
  await shot(popup, '07-home-tokens');
  step('home lists the wallet’s SPL token balance');
  await popup.getByRole('button', { name: 'Send', exact: true }).click();
  await popup.getByRole('button', { name: /^Asset:/ }).click();
  await shot(popup, '07a-asset-picker');
  await popup.getByRole('dialog').locator(`[data-asset="${mint.publicKey.toBase58()}"]`).click();
  await popup.getByPlaceholder('Recipient address').fill(recipient.toBase58());
  await popup.getByPlaceholder('Amount').fill('1.5');
  const tokenReviewPromise = context.waitForEvent('page');
  await popup.getByRole('button', { name: 'Review' }).click();
  const tokenReview = await tokenReviewPromise;
  await tokenReview.waitForLoadState();
  await tokenReview.getByRole('heading', { name: 'Review transfer' }).waitFor();
  const tokenText = await tokenReview.locator('main').textContent();
  assert.ok(tokenText.includes(recipient.toBase58()) && tokenText.includes(recipientAta.toBase58()), 'token review shows recipient and its token account');
  assert.match(tokenText, /1\.5 /);
  await shot(tokenReview, '07b-token-review');
  // Record long main-thread tasks: signing runs in a Web Worker, so the window never freezes.
  await tokenReview.evaluate(() => {
    window.__longTasks = [];
    new PerformanceObserver((list) => window.__longTasks.push(...list.getEntries().map((e) => e.duration))).observe({
      type: 'longtask',
    });
  });
  await tokenReview.getByRole('button', { name: 'Approve & send' }).click();
  await tokenReview.getByText('Sent.', { exact: true }).waitFor({ timeout: 180000 });
  const longest = Math.max(0, ...(await tokenReview.evaluate(() => window.__longTasks)));
  assert.ok(longest < 500, `the review window was blocked for ${Math.round(longest)} ms`);
  await settled();
  const tokenBalance = await connection.getTokenAccountBalance(ata(recipient), 'confirmed');
  assert.equal(tokenBalance.value.amount, '1500000');
  step('an SPL token send completes through the review window without freezing it; Activity shows sends and received transfers');
  await tokenReview.close();
  // Activity lists both sends as done.
  await popup.locator('nav').getByRole('button', { name: 'Activity' }).click();
  await popup.locator('.activity-row').nth(1).waitFor({ timeout: 30000 });
  assert.equal(await popup.locator('.activity-row .pill.done').count(), 2);
  // ...and, from chain history, what came in: the setup funding and the minted tokens.
  await popup.locator('.activity-row .pill.received').nth(1).waitFor({ timeout: 60000 });
  const incoming = await popup.locator('a.activity-row').allTextContents();
  assert.ok(incoming.some((t) => t.includes('Received 5 ') && t.includes(`From ${funder.publicKey.toBase58().slice(0, 4)}`)), incoming.join(' | '));
  assert.ok(incoming.some((t) => /Received [\d.]+ SOL/.test(t) && t.includes('From your fee address')), incoming.join(' | '));
  await shot(popup, '07c-activity');

  // 7a. A token send to someone who never held the token: the Send page offers to open
  // their token account from the fee address first, then reviews as usual.
  const newcomer = (await Keypair.generate()).publicKey;
  await popup.locator('nav').getByRole('button', { name: 'Home' }).click();
  await popup.getByRole('button', { name: 'Send', exact: true }).click();
  await popup.getByRole('button', { name: /^Asset:/ }).click();
  await popup.getByRole('dialog').locator(`[data-asset="${mint.publicKey.toBase58()}"]`).click();
  // Earlier recipients are offered for reuse.
  await popup.getByRole('button', { name: `Recent recipient ${recipient.toBase58()}` }).waitFor({ timeout: 30000 });
  await popup.getByPlaceholder('Recipient address').fill(newcomer.toBase58());
  await popup.getByPlaceholder('Amount').fill('0.5');
  await popup.getByRole('button', { name: 'Review' }).click();
  await popup.getByText('The recipient has no account for this token yet').waitFor({ timeout: 60000 });
  assert.equal(await connection.getAccountInfo(await ataOf(newcomer), 'confirmed'), null, 'nothing created before the user agrees');
  const newcomerReviewPromise = context.waitForEvent('page');
  await popup.getByRole('button', { name: /^Pay [\d.]+ SOL and continue$/ }).click();
  const newcomerReview = await newcomerReviewPromise;
  await newcomerReview.waitForLoadState();
  await newcomerReview.getByRole('button', { name: 'Approve & send' }).click();
  await newcomerReview.getByText('Sent.', { exact: true }).waitFor({ timeout: 180000 });
  await settled();
  assert.equal((await connection.getTokenAccountBalance(await ataOf(newcomer), 'confirmed')).value.amount, '500000');
  await newcomerReview.close();
  step('Send offers recent recipients; a token send to a new holder opens their token account (after asking) and delivers');

  // 7b. An unclear outcome: the RPC fails one transaction submission mid-send. The send
  // stops as "uncertain", the signature is checked, and resuming completes it once.
  const uncertainTo = (await Keypair.generate()).publicKey;
  await send([SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: uncertainTo, lamports: 1000000n })], [funder]);
  let submissions = 0,
    failed = false;
  await context.route('http://127.0.0.1:8899/**', async (route) => {
    const body = route.request().postData() ?? '';
    if (!failed && body.includes('"sendTransaction"') && ++submissions === 5) {
      failed = true;
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"injected"}' });
    }
    return route.continue();
  });
  await popup.locator('nav').getByRole('button', { name: 'Home' }).click();
  await popup.locator('.balance .amount').waitFor({ timeout: 60000 });
  await popup.getByRole('button', { name: 'Send', exact: true }).click();
  await popup.getByPlaceholder('Recipient address').fill(uncertainTo.toBase58());
  await popup.getByPlaceholder('Amount').fill('0.1');
  const uncertainPromise = context.waitForEvent('page');
  await popup.getByRole('button', { name: 'Review' }).click();
  const uncertain = await uncertainPromise;
  await uncertain.waitForLoadState();
  await uncertain.getByRole('button', { name: 'Approve & send' }).click();
  await uncertain.getByText(/gave no clear answer for one transaction/).waitFor({ timeout: 120000 });
  assert.ok(failed);
  await shot(uncertain, '06b-uncertain');
  await uncertain.getByRole('button', { name: 'Check status' }).click();
  await uncertain.getByText(/Not found on-chain|Found on-chain/).waitFor({ timeout: 30000 });
  await context.unroute('http://127.0.0.1:8899/**');
  await uncertain.getByRole('button', { name: 'Resume' }).click();
  await uncertain.getByText('Sent.', { exact: true }).waitFor({ timeout: 180000 });
  await settled();
  assert.equal(BigInt(await connection.getBalance(uncertainTo, 'confirmed')), 1000000n + 100000000n);
  step('an unclear submission stops as uncertain, is checked by signature, and resumes to exactly one transfer');
  await uncertain.close();

  // 7c. Two sends prepared at the same nonce. A is approved and interrupted once its proof
  // account is open; B then runs and moves the nonce on. Resuming A must not report it as
  // sent: it is "Not sent", and A's proof deposit goes back to the fee key.
  const toA = (await Keypair.generate()).publicKey,
    toB = (await Keypair.generate()).publicKey;
  await send(
    [toA, toB].map((to) => SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: to, lamports: 1000000n })),
    [funder],
  );
  const prepare = async (to, amount) => {
    await popup.locator('nav').getByRole('button', { name: 'Home' }).click();
    await popup.locator('.balance .amount').waitFor({ timeout: 60000 });
    await popup.getByRole('button', { name: 'Send', exact: true }).click();
    await popup.getByPlaceholder('Recipient address').fill(to.toBase58());
    await popup.getByPlaceholder('Amount').fill(amount);
    const opened = context.waitForEvent('page');
    await popup.getByRole('button', { name: 'Review' }).click();
    const page = await opened;
    await page.waitForLoadState();
    await page.getByRole('heading', { name: 'Review transfer' }).waitFor();
    return page;
  };
  const reviewA = await prepare(toA, '0.01');
  const reviewB = await prepare(toB, '0.02');
  const [recordA, recordB] = (await journal(popup)).slice(-2);
  assert.equal(recordA.nonce, recordB.nonce);
  const urlA = reviewA.url();
  await reviewA.getByRole('button', { name: 'Approve & send' }).click();
  for (let i = 0; ; i++) {
    const a = (await journal(popup)).find((r) => r.id === recordA.id);
    if (a.records.some((r) => r.phase === 'confirmed' && r.label.includes('begin-proof'))) break;
    if (i > 2400) throw new Error('Send A never opened its proof account.');
    await sleep(25);
  }
  await reviewA.close();
  const [proofA] = await PublicKey.findProgramAddress(
    [Buffer.from('proof'), walletAddress.toBytes(), Buffer.from(recordA.digest, 'hex'), Buffer.from([0]), feeKey.toBytes()],
    programId,
  );
  const proofRent = BigInt((await connection.getAccountInfo(proofA, 'confirmed')).lamports);
  // A's open proof holds most of the fee float, so the user tops up the fee address.
  await send([SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: feeKey, lamports: 50000000n })], [funder]);
  await reviewB.getByRole('button', { name: 'Approve & send' }).click();
  await reviewB.getByText('Sent.', { exact: true }).waitFor({ timeout: 180000 });
  await reviewB.close();
  const feeBeforeResume = BigInt(await connection.getBalance(feeKey, 'confirmed'));
  const resumedA = await context.newPage();
  await resumedA.goto(urlA);
  await resumedA.getByRole('button', { name: /Resume/ }).first().click();
  await resumedA.getByText('Nothing was sent.').waitFor({ timeout: 120000 });
  await resumedA.getByText(/proof deposit .* went back to your fee address/).waitFor({ timeout: 30000 });
  await shot(resumedA, '06c-superseded');
  const finalA = (await journal(resumedA)).find((r) => r.id === recordA.id);
  assert.equal(finalA.status, 'superseded');
  assert.equal(await connection.getAccountInfo(proofA, 'confirmed'), null);
  await settled();
  assert.equal(BigInt(await connection.getBalance(toA, 'confirmed')), 1000000n);
  assert.equal(BigInt(await connection.getBalance(toB, 'confirmed')), 1000000n + 20000000n);
  const feeAfterReclaim = BigInt(await connection.getBalance(feeKey, 'confirmed'));
  assert.ok(feeAfterReclaim >= feeBeforeResume + proofRent - 20000n, `fee key ${feeBeforeResume} -> ${feeAfterReclaim}`);
  await resumedA.close();
  // The extra SOL on the fee address is offered for moving into the wallet.
  await popup.locator('nav').getByRole('button', { name: 'Activity' }).click();
  await popup.locator('.activity-row .pill.superseded').waitFor({ timeout: 30000 });
  await popup.locator('nav').getByRole('button', { name: 'Home' }).click();
  await popup.getByRole('button', { name: 'Move to wallet' }).waitFor({ timeout: 60000 });
  await shot(popup, '07d-home-sweep');
  await popup.getByRole('button', { name: 'Move to wallet' }).click({ timeout: 60000 });
  await popup.getByText('Moved into your wallet.').waitFor({ timeout: 60000 });
  await settled();
  const feeAfterMove = BigInt(await connection.getBalance(feeKey, 'confirmed'));
  assert.ok(feeAfterMove >= 69900000n && feeAfterMove <= 70000000n, `fee float ${feeAfterMove}`);
  step('a send superseded by another at the same nonce is reported "Not sent" and its proof deposit is reclaimed');

  // 7c. Fee key below its float: the extension refills it from the wallet with a sealed send.
  {
    const secretHex = await popup.evaluate(async () => (await chrome.storage.session.get('unlocked')).unlocked.fee);
    const feeSigner = await Keypair.fromSecretKey(Uint8Array.from(secretHex.match(/../g).map((h) => parseInt(h, 16))));
    assert.ok(feeSigner.publicKey.equals(feeKey));
    // Spend 0.009 SOL from the fee key (as fees would over time), leaving it below 0.07 SOL.
    await send([SystemProgram.transfer({ fromPubkey: feeKey, toPubkey: funder.publicKey, lamports: 9000000n })], [feeSigner]);
    const before = BigInt(await connection.getBalance(feeKey, 'confirmed'));
    await popup.locator('nav').getByRole('button', { name: 'Home' }).click();
    const topUpButton = popup.getByRole('button', { name: 'Top up from wallet' });
    await topUpButton.waitFor({ timeout: 60000 });
    await shot(popup, '07e-home-topup');
    const topUpReviewPromise = context.waitForEvent('page');
    await topUpButton.click();
    const topUpReview = await topUpReviewPromise;
    await topUpReview.waitForLoadState();
    assert.ok((await topUpReview.locator('main').textContent()).includes(feeKey.toBase58()));
    await topUpReview.getByRole('button', { name: 'Approve & send' }).click();
    await topUpReview.getByText('Sent.', { exact: true }).waitFor({ timeout: 180000 });
    await settled();
    const after = BigInt(await connection.getBalance(feeKey, 'confirmed'));
    assert.ok(after >= 70000000n - 100000n && after > before, `fee key ${before} -> ${after}`);
    await topUpReview.close();
    step('a fee key below its float is refilled from the wallet through a reviewed sealed send');
  }

  // 8. Lock, wrong passphrase, unlock.
  await popup.getByRole('button', { name: 'Settings', exact: true }).click();
  await popup.getByRole('button', { name: 'Lock now' }).click();
  await popup.getByRole('heading', { name: 'Welcome back' }).waitFor();
  await shot(popup, '08-locked');
  await popup.getByPlaceholder('Passphrase').fill('wrong passphrase!!');
  await popup.getByRole('button', { name: 'Unlock' }).click();
  await popup.getByText('Wrong passphrase. Check it and try again.').waitFor({ timeout: 30000 });
  await popup.getByPlaceholder('Passphrase').fill(PASS);
  await popup.getByRole('button', { name: 'Unlock' }).click();
  await popup.locator('.balance .amount').waitFor({ timeout: 60000 });
  step('lock clears access; a wrong passphrase is refused; the right one unlocks');

  // 9. A cancelled download never counts as a saved backup.
  await popup.getByText('Back up your wallet').waitFor({ timeout: 30000 });
  await popup.getByRole('button', { name: 'Back up now' }).click();
  const cancelledPromise = popup.waitForEvent('download');
  await popup.getByRole('button', { name: 'Download backup' }).click();
  await (await cancelledPromise).cancel();
  await popup.getByRole('button', { name: 'Back', exact: true }).click();
  await popup.getByText('Back up your wallet').waitFor({ timeout: 30000 });
  step('a cancelled backup download leaves the Home reminder in place');
  await popup.getByRole('button', { name: 'Back up now' }).click();
  const downloadPromise = popup.waitForEvent('download');
  await popup.getByRole('button', { name: 'Download backup' }).click();
  const download = await downloadPromise;
  const backupFile = join(work, 'backup.json');
  await download.saveAs(backupFile);
  const backup = JSON.parse(readFileSync(backupFile, 'utf8'));
  assert.equal(backup.format, 'quantum-seal/extension-backup/1');
  assert.equal(backup.owner.format, 'quantum-seal/keystore/1');
  assert.ok(backup.descriptors.localnet.some((d) => d.wallet === walletAddress.toBase58()));
  assert.ok(!JSON.stringify(backup).includes('"secretKey"'));
  await shot(popup, '07b-backup-confirm');
  await popup.getByRole('button', { name: 'I saved my backup file', exact: true }).click();
  await popup.getByText('Backup saved.', { exact: false }).waitFor();
  await popup.getByRole('button', { name: 'Back', exact: true }).click();
  await popup.locator('.balance .amount').waitFor({ timeout: 60000 });
  assert.equal(await popup.getByText('Back up your wallet').count(), 0);
  step('backup downloads encrypted keys plus the wallet descriptor; the Home reminder clears');

  // 9b. Change the passphrase (a wrong current one is refused).
  await popup.getByRole('button', { name: 'Settings', exact: true }).click();
  await popup.getByRole('button', { name: /Change passphrase/ }).click();
  await popup.getByLabel('Current passphrase').fill('not the passphrase');
  await popup.getByLabel('New passphrase (12+ characters)').fill(NEW_PASS);
  await popup.getByLabel('Repeat new passphrase').fill(NEW_PASS);
  await popup.getByRole('button', { name: 'Change passphrase', exact: true }).click();
  await popup.getByText('The current passphrase is wrong.').waitFor({ timeout: 60000 });
  await popup.getByLabel('Current passphrase').fill(PASS);
  await popup.getByLabel('New passphrase (12+ characters)').fill(NEW_PASS);
  await popup.getByLabel('Repeat new passphrase').fill(NEW_PASS);
  await popup.getByRole('button', { name: 'Change passphrase', exact: true }).click();
  await popup.getByText(/Passphrase changed/).waitFor({ timeout: 60000 });
  await popup.locator('nav').getByRole('button', { name: 'Home' }).click();
  step('the passphrase changes only with the current one');

  // 9c. Settings > Security: ask for the passphrase before every approval.
  await popup.getByRole('button', { name: 'Settings', exact: true }).click();
  await popup.getByLabel(/Ask for my passphrase to approve each transfer/).check();
  await popup.getByRole('button', { name: 'Save changes' }).click();
  await popup.getByText('Saved.').waitFor({ timeout: 30000 });
  await popup.locator('nav').getByRole('button', { name: 'Home' }).click();
  const guardedTo = (await Keypair.generate()).publicKey;
  await popup.getByRole('button', { name: 'Send', exact: true }).click();
  await popup.getByPlaceholder('Recipient address').fill(guardedTo.toBase58());
  await popup.getByPlaceholder('Amount').fill('0.02');
  const guardedPromise = context.waitForEvent('page');
  await popup.getByRole('button', { name: 'Review' }).click();
  const guarded = await guardedPromise;
  await guarded.waitForLoadState();
  await guarded.getByRole('button', { name: 'Approve & send' }).click();
  await guarded.getByText('Enter your passphrase to approve. Nothing was signed.').waitFor({ timeout: 60000 });
  await guarded.getByLabel('Passphrase to approve').fill('not the passphrase');
  await guarded.getByRole('button', { name: 'Approve & send' }).click();
  await guarded.getByText('Wrong passphrase. Nothing was signed.').waitFor({ timeout: 60000 });
  await guarded.getByLabel('Passphrase to approve').fill(NEW_PASS);
  await guarded.getByRole('button', { name: 'Approve & send' }).click();
  await guarded.getByText('Sent.', { exact: true }).waitFor({ timeout: 180000 });
  await settled();
  assert.equal(BigInt(await connection.getBalance(guardedTo, 'confirmed')), 20000000n);
  await guarded.close();
  step('with "ask for my passphrase" on, a send is approved only with the right passphrase');

  // 10. Settings UI and auto-lock: set one minute, stay idle, and the wallet locks itself.
  await popup.getByRole('button', { name: 'Settings', exact: true }).click();
  await popup.getByLabel('Auto-lock after (minutes)').fill('1');
  await popup.getByRole('button', { name: 'Save' }).click();
  await popup.getByText('Saved.').waitFor({ timeout: 30000 }).catch(() => {});
  const saved = await popup.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  assert.equal(saved.autoLockMinutes, 1);
  assert.equal(saved.cluster, 'localnet');
  // Settings names the core commit this build bundles.
  const buildInfo = JSON.parse(readFileSync(join(dist, 'build-info.json'), 'utf8'));
  await popup.getByText(`Core ${buildInfo.core.commit.slice(0, 7)}`).waitFor({ timeout: 30000 });
  await shot(popup, '09-settings');
  await sleep(80000);
  assert.equal(await popup.evaluate(async () => Boolean((await chrome.storage.session.get('unlocked')).unlocked)), false);
  await popup.reload();
  await popup.getByRole('heading', { name: 'Welcome back' }).waitFor({ timeout: 30000 });
  step('settings save through the UI and the wallet auto-locks after the idle period');

  // 11. Forgot passphrase: the old one no longer unlocks; remove the wallet from this
  // browser, restore the backup (saved before the change, so its passphrase is the old
  // one) and land on the same wallet with its balance.
  await popup.getByPlaceholder('Passphrase').fill(PASS);
  await popup.getByRole('button', { name: 'Unlock' }).click();
  await popup.getByText('Wrong passphrase. Check it and try again.').waitFor({ timeout: 30000 });
  await popup.getByRole('button', { name: 'Forgot passphrase?' }).click();
  const removeButton = popup.getByRole('button', { name: 'Remove wallet from this browser' });
  assert.equal(await removeButton.isDisabled(), true);
  await popup.getByLabel('I have my backup file and its passphrase.').check();
  await removeButton.click();
  await popup.getByRole('tab', { name: 'From backup' }).click({ timeout: 30000 });
  const left = await popup.evaluate(async () => Object.keys(await chrome.storage.local.get(null)));
  assert.deepEqual(left, ['settings']);
  await popup.getByLabel('Backup file').setInputFiles(backupFile);
  await popup.getByLabel('Backup passphrase').fill(PASS);
  await popup.getByRole('button', { name: 'Restore wallet' }).click();
  await popup.locator('.balance .amount').waitFor({ timeout: 120000 });
  const restored = await popup.evaluate(async () => (await chrome.storage.local.get('vault')).vault);
  assert.ok(restored.descriptors.localnet.some((d) => d.wallet === walletAddress.toBase58()));
  assert.equal(restored.feePayer, backup.feePayer);
  step('forgot passphrase: remove the wallet, restore the backup, and the same wallet returns');

  mkdirSync(join(root, 'evidence'), { recursive: true });
  writeFileSync(
    join(root, 'evidence/e2e.json'),
    JSON.stringify({ status: 'passed', finishedAt: new Date().toISOString(), program: programId.toBase58(), steps: results }, null, 2) + '\n',
  );
  console.log(`E2E PASSED: ${results.length} steps`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  // Leave screenshots and page text for diagnosis (gitignored).
  const out = join(root, '.runtime');
  mkdirSync(out, { recursive: true });
  for (const [i, page] of (context?.pages() ?? []).entries()) {
    try {
      await page.screenshot({ path: join(out, `e2e-failure-${i}.png`) });
      console.error(`--- page ${i}: ${page.url()}\n${(await page.locator('body').innerText()).slice(0, 1500)}`);
    } catch {
      /* page already closed */
    }
  }
} finally {
  await context?.close().catch(() => {});
  validator?.kill('SIGTERM');
  await sleep(1000);
  rmSync(work, { recursive: true, force: true });
}
