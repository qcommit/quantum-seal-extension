// Release-build smoke test: builds exactly what `npm run package` ships (--release) and
// checks that it opens, creates a wallet and reaches the setup screen on its built-in
// devnet pins, with no local-validator network and no loopback permission. Reads the
// public devnet RPC only; nothing is funded or signed.
//
//   node e2e/release-smoke.mjs
//
// Leaves dist/ as a release build; run `npm run build` before `npm run e2e`.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { BUILT_IN, defaultCluster } from '../src/networks.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const PASS = 'release smoke passphrase';
execFileSync(process.execPath, [join(root, 'scripts/build.mjs'), '--release'], { stdio: 'inherit' });

const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
assert.ok(manifest.host_permissions.every((h) => h.startsWith('https://')), 'release requests HTTPS hosts only');
assert.ok(!manifest.content_security_policy.extension_pages.includes('127.0.0.1'), 'release CSP has no loopback');
console.log('PASS release manifest: HTTPS hosts only, no loopback in the CSP');

const work = mkdtempSync(join(tmpdir(), 'qs-release-'));
let context;
try {
  context = await chromium.launchPersistentContext(join(work, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const popup = await context.newPage();
  const errors = [];
  popup.on('pageerror', (e) => errors.push(e.message));
  await popup.setViewportSize({ width: 400, height: 600 });
  await popup.goto(`chrome-extension://${id}/popup.html`);
  // Keep this rehearsal on devnet even after mainnet becomes the install default.
  // No mainnet wallet is funded or initialized by this smoke test.
  await popup.evaluate(async () => {
    await chrome.storage.local.set({ settings: { cluster: 'devnet' } });
  });
  await popup.getByPlaceholder('Passphrase (12+ characters)').fill(PASS);
  await popup.getByPlaceholder('Repeat passphrase').fill(PASS);
  await popup.getByRole('button', { name: 'Create wallet' }).click();
  await popup.getByRole('heading', { name: 'Set up your wallet' }).waitFor({ timeout: 120000 });
  assert.match(await popup.locator('.top-title').textContent(), /Devnet/);
  console.log('PASS release build opens, creates a wallet and shows devnet setup');
  await popup.getByRole('button', { name: /^Viewing/ }).click();
  const networks = await popup.getByRole('dialog').textContent();
  assert.ok(networks.includes('Devnet') && !networks.includes('Local validator'), networks);
  console.log('PASS the network list has no local validator');
  // A development build's saved local-validator choice falls back instead of breaking.
  await popup.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, cluster: 'localnet' } });
  });
  await popup.reload();
  await popup.getByRole('heading', { name: 'Set up your wallet' }).waitFor({ timeout: 120000 });
  assert.equal((await popup.locator('.top-title').textContent()).trim(), BUILT_IN[defaultCluster()].label);
  console.log('PASS a stale local-validator setting falls back to a built-in network');
  assert.deepEqual(errors, []);
  console.log('RELEASE SMOKE PASSED');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  for (const page of context?.pages() ?? [])
    console.error(`--- ${page.url()}\n${(await page.locator('body').innerText().catch(() => '')).slice(0, 1200)}`);
} finally {
  await context?.close().catch(() => {});
  rmSync(work, { recursive: true, force: true });
}
