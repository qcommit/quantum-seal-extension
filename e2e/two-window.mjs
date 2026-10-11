// Two-window lifecycle check: the built extension in Chromium against a real local
// validator, with several extension pages open at once (as a person with a review window
// and a second popup would have). Complements the deterministic unit race tests.
//
//   npm run build && node e2e/two-window.mjs
//
// 1. The same send opened in two review windows and approved in both: exactly one
//    transfer, and both windows end on "Sent.".
// 2. Wallet removal from another popup while a send is mid-upload: refused, the wallet
//    and the send survive, and the send completes.
// 3. Wallet removal while an unapproved review is open: removal succeeds, and approving
//    in the stale window signs nothing and moves nothing.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { confirmByPolling } from '../src/wallet-service.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = join(root, 'dist');
const programPath = resolve(root, '../quantum-seal-wallet/target/deploy/seal_wallet.so');
const solanaBin = process.env.QS_SOLANA_BIN ?? join(process.env.HOME, '.local/solana/bin');
const ataProgramPath = process.env.QS_ATA_PROGRAM ?? join(here, 'fixtures/spl_associated_token_account-1.1.1.so');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZ9zbHQBhL1v8Tq9GZy3s3pVm');
const RPC = 'http://127.0.0.1:8899';
const PASS = 'two window passphrase 1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const results = [];
const step = (name) => {
  results.push(name);
  console.log(`PASS ${name}`);
};
// Screens a person sees at the key moments, for inspection (gitignored).
const shot = async (page, name) => {
  mkdirSync(join(root, '.runtime/shots'), { recursive: true });
  await sleep(400);
  await page.screenshot({ path: join(root, '.runtime/shots', `two-window-${name}.png`) });
};
const sends = (page) =>
  page.evaluate(async () =>
    Object.entries(await chrome.storage.local.get(null))
      .filter(([k]) => k.startsWith('send:'))
      .map(([, v]) => v),
  );

const work = mkdtempSync(join(tmpdir(), 'qs-2w-'));
let validator, context;
try {
  const programId = (await Keypair.generate()).publicKey;
  const binary = readFileSync(programPath);
  validator = spawn(
    join(solanaBin, 'solana-test-validator'),
    ['--ledger', join(work, 'ledger'), '--reset', '--quiet', '--bind-address', '127.0.0.1', '--rpc-port', '8899',
      '--upgradeable-program', programId.toBase58(), programPath, 'none',
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
  const settled = async () => {
    const start = await connection.getSlot('confirmed');
    for (let i = 0; i < 100 && (await connection.getSlot('confirmed')) <= start; i++) await sleep(100);
  };
  const genesis = await connection.getGenesisHash();
  const funder = await Keypair.generate();
  {
    const latest = await connection.getLatestBlockhash('confirmed');
    const sig = await connection.requestAirdrop(funder.publicKey, 20 * LAMPORTS_PER_SOL);
    await confirmByPolling(connection, sig, latest.lastValidBlockHeight, 'confirmed');
  }

  context = await chromium.launchPersistentContext(join(work, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    acceptDownloads: true,
    viewport: { width: 420, height: 760 },
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  const popupUrl = `chrome-extension://${new URL(worker.url()).host}/popup.html`;
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 400, height: 600 });
  await popup.goto(popupUrl);
  await popup.evaluate((settings) => chrome.storage.local.set({ settings }), {
    cluster: 'localnet',
    autoLockMinutes: 30,
    rpc: {},
    deployments: {
      localnet: {
        program: programId.toBase58(),
        programSha256: hex(sha256(binary)),
        programSize: binary.length,
        upgradeAuthority: '11111111111111111111111111111111',
        genesis,
      },
    },
  });
  await popup.reload();
  await popup.getByPlaceholder('Passphrase (12+ characters)').fill(PASS);
  await popup.getByPlaceholder('Repeat passphrase').fill(PASS);
  await popup.getByRole('button', { name: 'Create wallet' }).click();
  await popup.getByRole('heading', { name: 'Set up your wallet' }).waitFor({ timeout: 60000 });
  const feeKey = new PublicKey((await popup.locator('code.address').first().textContent()).trim());
  {
    const latest = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: funder.publicKey, recentBlockhash: latest.blockhash }).add(
      SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: feeKey, lamports: 3n * BigInt(LAMPORTS_PER_SOL) }),
    );
    await tx.sign(funder);
    await confirmByPolling(connection, await connection.sendRawTransaction(await tx.serialize()), latest.lastValidBlockHeight, 'confirmed');
  }
  await popup.getByRole('button', { name: 'Refresh' }).click();
  await popup.getByRole('button', { name: 'Create my wallet' }).click({ timeout: 60000 });
  await popup.locator('.balance .amount').waitFor({ timeout: 120000 });
  step('a disposable wallet is created and set up on the local validator');

  // Opens Send in `page`, prepares a SOL send and returns the review window it opens.
  const prepare = async (page, to, amount) => {
    await page.locator('nav').getByRole('button', { name: 'Home' }).click();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByPlaceholder('Recipient address').fill(to.toBase58());
    await page.getByPlaceholder('Amount').fill(amount);
    const opened = context.waitForEvent('page');
    await page.getByRole('button', { name: 'Review' }).click();
    const review = await opened;
    await review.waitForLoadState();
    await review.getByRole('heading', { name: 'Review transfer' }).waitFor({ timeout: 60000 });
    return review;
  };

  // 1. One send, two review windows, approved in both at once.
  const r1 = (await Keypair.generate()).publicKey;
  const reviewA = await prepare(popup, r1, '0.03');
  const reviewB = await context.newPage();
  await reviewB.setViewportSize({ width: 420, height: 720 });
  await reviewB.goto(reviewA.url());
  await reviewB.getByRole('heading', { name: 'Review transfer' }).waitFor({ timeout: 60000 });
  await Promise.all([
    reviewA.getByRole('button', { name: 'Approve & send' }).click(),
    reviewB.getByRole('button', { name: 'Approve & send' }).click(),
  ]);
  await reviewA.getByText('Sent.', { exact: true }).waitFor({ timeout: 240000 });
  await reviewB.getByText('Sent.', { exact: true }).waitFor({ timeout: 240000 });
  await settled();
  assert.equal(BigInt(await connection.getBalance(r1, 'confirmed')), 30000000n, 'exactly one transfer');
  const afterDup = (await sends(popup)).filter((s) => s.display.to === r1.toBase58());
  assert.equal(afterDup.length, 1);
  assert.equal(afterDup[0].status, 'done');
  assert.equal(afterDup[0].records.filter((r) => r.phase === 'confirmed' && r.label.includes('execute-wallet-transfer')).length, 1);
  await reviewA.close();
  await reviewB.close();
  step('the same send approved in two review windows at once executes exactly once, and both show Sent');

  // Back up, so removal later needs no typed confirmation.
  await popup.getByRole('button', { name: 'Settings', exact: true }).click();
  await popup.getByRole('button', { name: /Back up wallet/ }).click();
  const download = context.waitForEvent('download');
  await popup.getByRole('button', { name: 'Download backup' }).click();
  await (await download).path();
  await popup.getByRole('button', { name: 'I saved my backup file' }).click();
  await popup.getByText(/Backup saved/).waitFor({ timeout: 30000 });
  await popup.locator('nav').getByRole('button', { name: 'Home' }).click();

  // 2. Removal from a second popup while a send is uploading.
  const r2 = (await Keypair.generate()).publicKey;
  const reviewC = await prepare(popup, r2, '0.05');
  await reviewC.getByRole('button', { name: 'Approve & send' }).click();
  for (let i = 0; ; i++) {
    const s = (await sends(popup)).find((x) => x.display.to === r2.toBase58());
    if (s?.records.some((r) => r.phase === 'confirmed' && r.label.includes('upload-chunk'))) break;
    if (i > 1200) throw new Error('The send never started uploading.');
    await sleep(100);
  }
  const popup2 = await context.newPage();
  await popup2.setViewportSize({ width: 400, height: 600 });
  await popup2.goto(popupUrl);
  await popup2.locator('.balance .amount').waitFor({ timeout: 60000 });
  await popup2.getByRole('button', { name: 'Settings', exact: true }).click();
  await popup2.getByRole('button', { name: /Remove from this browser/ }).click();
  await popup2.getByLabel(/I have my backup file and its passphrase/).check();
  await popup2.getByRole('button', { name: 'Remove wallet from this browser' }).click();
  await popup2.getByText(/running in another window|not finished/).waitFor({ timeout: 60000 });
  await shot(popup2, 'remove-refused');
  assert.ok(await popup2.evaluate(async () => Boolean((await chrome.storage.local.get('vault')).vault)), 'the wallet survives');
  await reviewC.getByText('Sent.', { exact: true }).waitFor({ timeout: 240000 });
  await settled();
  assert.equal(BigInt(await connection.getBalance(r2, 'confirmed')), 50000000n);
  // The other popup's Activity picks the finished send up without a reload.
  await popup2.locator('nav').getByRole('button', { name: 'Activity' }).click();
  await popup2.locator('.activity-row .pill.done').nth(1).waitFor({ timeout: 60000 });
  await reviewC.close();
  step('removing the wallet from another popup while a send uploads is refused; the send completes and Activity updates');

  // 3. Removal while an unapproved review is open; the stale window cannot sign.
  const r3 = (await Keypair.generate()).publicKey;
  const reviewD = await prepare(popup, r3, '0.07');
  await popup2.reload();
  await popup2.locator('.balance .amount').waitFor({ timeout: 60000 });
  await popup2.getByRole('button', { name: 'Settings', exact: true }).click();
  await popup2.getByRole('button', { name: /Remove from this browser/ }).click();
  await popup2.getByLabel(/I have my backup file and its passphrase/).check();
  await popup2.getByRole('button', { name: 'Remove wallet from this browser' }).click();
  await popup2.getByRole('tab', { name: 'From backup' }).waitFor({ timeout: 60000 });
  const left = await popup2.evaluate(async () => Object.keys(await chrome.storage.local.get(null)));
  assert.deepEqual(left, ['settings'], `left after removal: ${left}`);
  // The stale review window must not sign or send anything.
  const approve = reviewD.getByRole('button', { name: 'Approve & send' });
  if (await approve.isVisible().catch(() => false)) await approve.click().catch(() => {});
  await reviewD.getByText(/no longer exists|Wallet locked|locked/i).first().waitFor({ timeout: 60000 });
  await shot(reviewD, 'stale-review');
  await sleep(3000);
  await settled();
  assert.equal(BigInt(await connection.getBalance(r3, 'confirmed')), 0n, 'nothing moved');
  assert.deepEqual(await popup2.evaluate(async () => Object.keys(await chrome.storage.local.get(null))), ['settings']);
  step('removing the wallet with an unapproved review open succeeds; the stale window signs and moves nothing');

  mkdirSync(join(root, 'evidence'), { recursive: true });
  writeFileSync(
    join(root, 'evidence/two-window.json'),
    JSON.stringify({ status: 'passed', finishedAt: new Date().toISOString(), cluster: 'localnet', steps: results }, null, 2) + '\n',
  );
  console.log(`TWO-WINDOW PASSED: ${results.length} steps`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  const out = join(root, '.runtime');
  mkdirSync(out, { recursive: true });
  for (const [i, page] of (context?.pages() ?? []).entries()) {
    try {
      await page.screenshot({ path: join(out, `two-window-failure-${i}.png`) });
      console.error(`--- page ${i}: ${page.url()}\n${(await page.locator('body').innerText()).slice(0, 1200)}`);
    } catch {
      /* closed */
    }
  }
} finally {
  await context?.close().catch(() => {});
  validator?.kill('SIGTERM');
  await sleep(1000);
  rmSync(work, { recursive: true, force: true });
}
