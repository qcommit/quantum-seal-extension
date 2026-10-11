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
const ataProgramPath =
  process.env.QS_ATA_PROGRAM ??
  join(process.env.HOME, 'src/agave-3.1.10/program-binaries/src/programs/spl_associated_token_account-1.1.1.so');
const RPC = 'http://127.0.0.1:8899';
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZ9zbHQBhL1v8Tq9GZy3s3pVm');
const PASS = 'e2e test passphrase 123';
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
  await page.screenshot({ path: join(root, '.runtime/shots', `${name}.png`) });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
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
  await popup.getByPlaceholder('Passphrase (12+ characters)').fill(PASS);
  await popup.getByPlaceholder('Repeat passphrase').fill(PASS);
  await popup.getByRole('button', { name: 'Create wallet' }).click();
  await popup.getByRole('heading', { name: 'Set up your wallet' }).waitFor({ timeout: 60000 });
  await shot(popup, '02-setup');
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
  const feeAfterSetup = BigInt(await connection.getBalance(feeKey, 'confirmed'));
  assert.ok(feeAfterSetup >= 69000000n && feeAfterSetup <= 70000000n, `fee float ${feeAfterSetup}`);
  await shot(popup, '03-home');
  step('one funding transfer creates the wallet and moves the rest behind the post-quantum key');

  // 5. Receive.
  await popup.getByRole('button', { name: 'Receive', exact: true }).first().click();
  await shot(popup, '04-receive');
  const walletAddress = new PublicKey((await popup.locator('code.address').textContent()).trim());
  assert.ok((await popup.locator('svg.qr').count()) === 1);
  assert.equal(await connection.getAccountInfo(walletAddress).then((a) => a.owner.toBase58()), programId.toBase58());
  step('receive shows the program-owned wallet address with a QR code');

  // 6. Send SOL, interrupt it mid-upload, then resume from on-chain state.
  const recipient = (await Keypair.generate()).publicKey;
  await send([SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: recipient, lamports: 1000000n })], [funder]);
  await popup.locator('nav').getByRole('button', { name: 'Send' }).click();
  await popup.getByPlaceholder('Recipient address').fill(recipient.toBase58());
  await popup.getByPlaceholder('Amount').fill('0.25');
  const reviewPromise = context.waitForEvent('page');
  await popup.getByRole('button', { name: 'Review' }).click();
  let review = await reviewPromise;
  await review.waitForLoadState();
  await review.getByRole('heading', { name: 'Review transfer' }).waitFor();
  await shot(review, '05-review');
  const reviewText = await review.locator('main').textContent();
  assert.match(reviewText, /0\.25 SOL/);
  assert.ok(reviewText.includes(recipient.toBase58()));
  assert.match(reviewText, /Fee refill to your fee key/);
  step('the review window shows the decoded recipient, amount and fee refill before signing');
  const reviewUrl = review.url();
  await review.getByRole('button', { name: 'Approve & send' }).click();
  // Interrupt deterministically: close the window right after the 2nd chunk confirms.
  for (let i = 0; ; i++) {
    const chunks = await popup.evaluate(async () => {
      const sends = Object.values((await chrome.storage.local.get('sends')).sends ?? {});
      return sends[0]?.records.filter((r) => r.phase === 'confirmed' && r.label === 'upload-chunk').length ?? 0;
    });
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
  await review.getByText('Sent.').waitFor({ timeout: 180000 });
  await shot(review, '06-sent');
  const received = BigInt(await connection.getBalance(recipient, 'confirmed'));
  assert.equal(received, 1000000n + 250000000n);
  const sendRecord = await review.evaluate(async () => Object.values((await chrome.storage.local.get('sends')).sends)[0]);
  const chunks = sendRecord.records.filter((r) => r.phase === 'confirmed' && r.label === 'upload-chunk').length;
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
  await popup.getByText('5').first().waitFor({ timeout: 30000 });
  assert.match(await popup.locator('main').textContent(), /Tokens/);
  await shot(popup, '07-home-tokens');
  step('home lists the wallet’s SPL token balance');
  await popup.locator('nav').getByRole('button', { name: 'Send' }).click();
  await popup.locator('select').selectOption(mint.publicKey.toBase58());
  await popup.getByPlaceholder('Recipient address').fill(recipient.toBase58());
  await popup.getByPlaceholder('Amount').fill('1.5');
  const tokenReviewPromise = context.waitForEvent('page');
  await popup.getByRole('button', { name: 'Review' }).click();
  const tokenReview = await tokenReviewPromise;
  await tokenReview.waitForLoadState();
  await tokenReview.getByRole('button', { name: 'Approve & send' }).click();
  await tokenReview.getByText('Sent.').waitFor({ timeout: 180000 });
  const tokenBalance = await connection.getTokenAccountBalance(ata(recipient), 'confirmed');
  assert.equal(tokenBalance.value.amount, '1500000');
  step('an SPL token send completes through the review window');
  await tokenReview.close();

  // 8. Lock, wrong passphrase, unlock.
  await popup.locator('nav').getByRole('button', { name: 'Settings' }).click();
  await popup.getByRole('button', { name: 'Lock now' }).click();
  await popup.getByRole('heading', { name: 'Welcome back' }).waitFor();
  await shot(popup, '08-locked');
  await popup.getByPlaceholder('Passphrase').fill('wrong passphrase!!');
  await popup.getByRole('button', { name: 'Unlock' }).click();
  await popup.getByText('Unable to unlock keystore.').waitFor({ timeout: 30000 });
  await popup.getByPlaceholder('Passphrase').fill(PASS);
  await popup.getByRole('button', { name: 'Unlock' }).click();
  await popup.locator('.balance .amount').waitFor({ timeout: 60000 });
  step('lock clears access; a wrong passphrase is refused; the right one unlocks');

  // 9. Backup download.
  await popup.locator('nav').getByRole('button', { name: 'Settings' }).click();
  await popup.getByRole('button', { name: 'Back up wallet' }).click();
  const downloadPromise = popup.waitForEvent('download');
  await popup.getByRole('button', { name: 'Download backup' }).click();
  const download = await downloadPromise;
  const backup = JSON.parse(readFileSync(await download.path(), 'utf8'));
  assert.equal(backup.format, 'quantum-seal/extension-backup/1');
  assert.equal(backup.owner.format, 'quantum-seal/keystore/1');
  assert.equal(backup.descriptors.localnet.wallet, walletAddress.toBase58());
  assert.ok(!JSON.stringify(backup).includes('"secretKey"'));
  step('backup downloads encrypted keys plus the wallet descriptor');

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
