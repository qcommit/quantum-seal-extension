// Devnet smoke test: the built extension, using its built-in devnet pins and the public
// devnet RPC, creates a wallet, is funded once, sets up on-chain and sends 0.01 SOL.
//
//   QS_DEVNET_FUNDER=/path/outside/repo/devnet-keypair.json npm run build && node e2e/devnet-smoke.mjs
//
// Devnet SOL only. The funder keypair must never be a mainnet key.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { confirmByPolling } from '../src/wallet-service.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const PASS = 'devnet smoke passphrase';
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
const funder = await Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(process.env.QS_DEVNET_FUNDER, 'utf8'))),
);
const work = mkdtempSync(join(tmpdir(), 'qs-devnet-'));
const started = Date.now();
let context;
try {
  context = await chromium.launchPersistentContext(join(work, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    viewport: { width: 420, height: 760 },
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 400, height: 600 });
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.getByPlaceholder('Passphrase (12+ characters)').fill(PASS);
  await popup.getByPlaceholder('Repeat passphrase').fill(PASS);
  await popup.getByRole('button', { name: 'Create wallet' }).click();
  await popup.getByRole('heading', { name: 'Set up your wallet' }).waitFor({ timeout: 90000 });
  assert.match(await popup.locator('.top-title').textContent(), /Devnet/);
  const feeKey = new PublicKey((await popup.locator('code.address').first().textContent()).trim());
  console.log('PASS extension uses its built-in devnet pins; setup address', feeKey.toBase58());

  const latest = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: funder.publicKey, recentBlockhash: latest.blockhash });
  tx.add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: feeKey, lamports: 150000000n }));
  await tx.sign(funder);
  const sig = await connection.sendRawTransaction(await tx.serialize());
  await confirmByPolling(connection, sig, latest.lastValidBlockHeight, 'confirmed');
  await popup.getByRole('button', { name: 'Refresh' }).click();
  await popup.getByRole('button', { name: 'Create my wallet' }).click({ timeout: 120000 });
  await popup.locator('.balance .amount').waitFor({ timeout: 240000 });
  console.log('PASS devnet wallet created; balance', await popup.locator('.balance .amount').textContent());

  const recipient = (await Keypair.generate()).publicKey;
  await popup.getByRole('button', { name: 'Send', exact: true }).click();
  await popup.getByPlaceholder('Recipient address').fill(recipient.toBase58());
  await popup.getByPlaceholder('Amount').fill('0.01');
  const reviewPromise = context.waitForEvent('page');
  await popup.getByRole('button', { name: 'Review' }).click();
  const review = await reviewPromise;
  await review.waitForLoadState();
  await review.getByRole('button', { name: 'Approve & send' }).click();
  await review.getByText('Sent.').waitFor({ timeout: 600000 });
  assert.equal(BigInt(await connection.getBalance(recipient, 'confirmed')), 10000000n);
  const seconds = (Date.now() - started) / 1000;
  console.log(`PASS 0.01 SOL sent from the extension on devnet (${seconds.toFixed(0)} s total)`);
  // Activity reads incoming transfers from the public RPC's history (rate-limited).
  await review.close();
  await popup.locator('nav').getByRole('button', { name: 'Activity' }).click();
  await popup.locator('.activity-row .pill.done').first().waitFor({ timeout: 60000 });
  await popup.locator('a.activity-row').filter({ hasText: 'From your fee address' }).first().waitFor({ timeout: 120000 });
  console.log('PASS Activity lists the send and the setup funding received from the fee address');
  mkdirSync(join(root, 'evidence'), { recursive: true });
  writeFileSync(
    join(root, 'evidence/devnet-smoke.json'),
    JSON.stringify(
      {
        status: 'passed',
        finishedAt: new Date().toISOString(),
        cluster: 'devnet',
        recipient: recipient.toBase58(),
        seconds,
        // Which build ran: release (what the store ships) or development.
        build: (({ release, core }) => ({ release, core: core.commit }))(JSON.parse(readFileSync(join(dist, 'build-info.json'), 'utf8'))),
      },
      null,
      2,
    ) + '\n',
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  for (const [i, page] of (context?.pages() ?? []).entries()) {
    try {
      mkdirSync(join(root, '.runtime'), { recursive: true });
      await page.screenshot({ path: join(root, '.runtime', `devnet-failure-${i}.png`) });
      console.error(`--- page ${i}: ${page.url()}\n${(await page.locator('body').innerText()).slice(0, 1200)}`);
    } catch {
      /* closed */
    }
  }
} finally {
  await context?.close().catch(() => {});
  rmSync(work, { recursive: true, force: true });
}
