// Visual check: renders the real popup and review components in every state worth
// looking at (including ones the chain e2e cannot reach, such as a low fee address, a
// failed send or the restore form), saves screenshots and, if axe-core is available,
// runs an accessibility scan on each. Nothing touches a chain, a vault or chrome.storage:
// src/ui/common.js is swapped for e2e/visual/fake-common.js at bundle time.
//
//   node e2e/visual.mjs                    # screenshots to .runtime/shots/visual/
//   QS_AXE=/path/to/axe.min.js node e2e/visual.mjs   # also run axe-core on every scene
//
// It is a look-and-feel aid, not a test of wallet behaviour: run `npm run e2e` for that.
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = join(root, '.runtime/visual-build');
const shots = join(root, '.runtime/shots/visual');
const only = process.argv[2] ? new RegExp(process.argv[2]) : null;

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'icons'), { recursive: true });
mkdirSync(shots, { recursive: true });

const fake = join(here, 'visual/fake-common.js');
const swapCommon = {
  name: 'swap-common',
  setup(b) {
    b.onResolve({ filter: /^\.\/common\.js$/ }, (args) =>
      args.resolveDir === join(root, 'src/ui') ? { path: fake } : undefined,
    );
    // One copy of web3.js and buffer, as in the real build.
    for (const name of ['@solana/web3.js', 'buffer'])
      b.onResolve({ filter: new RegExp(`^${name.replace(/[/.]/g, '\\$&')}$`) }, (args) =>
        args.pluginData?.root ? undefined : b.resolve(args.path, { resolveDir: root, kind: args.kind, pluginData: { root: true } }),
      );
  },
};
await build({
  entryPoints: {
    popup: join(root, 'src/ui/popup.jsx'),
    review: join(root, 'src/ui/review.jsx'),
    styles: join(root, 'src/ui/styles.css'),
  },
  outdir: out,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome120'],
  jsx: 'automatic',
  loader: { '.woff2': 'file' },
  assetNames: 'fonts/[name]-[hash]',
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis', __QS_RELEASE__: 'false' },
  inject: [join(root, 'scripts/buffer-shim.js'), join(here, 'visual/chrome-stub.js')],
  plugins: [swapCommon],
  logLevel: 'warning',
});
for (const f of ['popup.html', 'review.html']) cpSync(join(root, 'src/ui', f), join(out, f));
cpSync(join(root, 'assets/mark.svg'), join(out, 'icons/mark.svg'));

// Scenes: [name, page, query, viewport, steps]. Steps run before the screenshot.
const POPUP = { width: 400, height: 600 };
const REVIEW = { width: 420, height: 720 };
const nav = (name) => async (p) => p.locator('nav').getByRole('button', { name }).click();
const click = (name, opts = {}) => async (p) => p.getByRole('button', { name, ...opts }).first().click({ timeout: 5000 });
const tab = (n) => async (p) => {
  for (let i = 0; i < n; i++) await p.keyboard.press('Tab');
};
const press = (key) => async (p) => p.keyboard.press(key);
const expectNoDialog = async (p) => {
  if (await p.locator('dialog[open]').count()) throw new Error('a sheet is still open after Escape');
};
const scrollEnd = async (p) => p.evaluate(() => document.querySelector('.page-scroll, .review-scroll')?.scrollTo(0, 1e6));
const SCENES = [
  ['welcome', 'popup', 'welcome', POPUP],
  ['welcome-error', 'popup', 'welcome', POPUP, [click('Create wallet')]],
  ['welcome-restore', 'popup', 'welcome', POPUP, [async (p) => p.getByRole('tab', { name: 'From backup' }).click()]],
  ['unlock', 'popup', 'unlock', POPUP],
  ['unlock-error', 'popup', 'unlock', POPUP, [async (p) => p.getByLabel('Passphrase').fill('wrong passphrase'), click('Unlock')]],
  ['setup-waiting', 'popup', 'setup-waiting', POPUP],
  ['setup-waiting-end', 'popup', 'setup-waiting', POPUP, [scrollEnd]],
  ['setup-ready', 'popup', 'setup-ready', POPUP, [scrollEnd]],
  ['home', 'popup', 'home', POPUP],
  ['home-end', 'popup', 'home', POPUP, [scrollEnd]],
  ['home-mainnet', 'popup', 'home-mainnet', POPUP],
  ['home-empty', 'popup', 'home-empty', POPUP, [scrollEnd]],
  ['home-low', 'popup', 'home-low', POPUP],
  ['home-low-end', 'popup', 'home-low', POPUP, [scrollEnd]],
  ['home-topup', 'popup', 'home-topup', POPUP],
  ['home-sweep', 'popup', 'home-sweep', POPUP],
  ['home-other', 'popup', 'home-other', POPUP],
  ['home-long', 'popup', 'home-long', POPUP],
  ['home-error', 'popup', 'home-error', POPUP],
  ['home-loading', 'popup', 'home-loading', POPUP],
  ['receive', 'popup', 'home', POPUP, [click('Receive', { exact: true })]],
  // Keyboard: focus rings are visible, and Escape closes a sheet and returns focus.
  ['home-focus', 'popup', 'home', POPUP, [tab(4)]],
  ['receive-escape', 'popup', 'home', POPUP, [click('Receive', { exact: true }), tab(2), press('Escape'), expectNoDialog]],
  ['send-focus', 'popup', 'home', POPUP, [click('Send', { exact: true }), tab(5)]],
  ['network', 'popup', 'home', POPUP, [click(/^Viewing/)]],
  ['activity', 'popup', 'home', POPUP, [nav('Activity')]],
  ['activity-end', 'popup', 'home', POPUP, [nav('Activity'), scrollEnd]],
  ['activity-empty', 'popup', 'activity-empty', POPUP, [nav('Activity')]],
  ['send', 'popup', 'home', POPUP, [click('Send', { exact: true })]],
  ['send-assets', 'popup', 'home', POPUP, [click('Send', { exact: true }), click(/^Asset/)]],
  [
    'send-error',
    'popup',
    'home',
    POPUP,
    [
      click('Send', { exact: true }),
      async (p) => p.getByLabel('To').fill('5vVevv3JNQRKP8Xtqhs5FXLR1vGQ1wVh4HMjqfchFsJy'),
      async (p) => p.getByLabel('Amount').fill('0.25'),
      click('Review'),
    ],
  ],
  ['settings', 'popup', 'home', POPUP, [click('Settings', { exact: true })]],
  ['settings-pins', 'popup', 'home', POPUP, [click('Settings', { exact: true }), async (p) => p.locator('summary').click(), scrollEnd]],
  ['backup', 'popup', 'home', POPUP, [click('Settings', { exact: true }), click(/Back up wallet/)]],
  ['review', 'review', 'review&id=review', REVIEW],
  ['review-end', 'review', 'review&id=review', REVIEW, [scrollEnd]],
  ['review-token', 'review', 'review&id=review-token', REVIEW],
  ['review-token-end', 'review', 'review&id=review-token', REVIEW, [scrollEnd]],
  ['review-blocked', 'review', 'review&id=blocked', REVIEW],
  ['review-signed', 'review', 'review&id=signed', REVIEW],
  ['review-submitting', 'review', 'review&id=submitting', REVIEW],
  ['review-done', 'review', 'review&id=done', REVIEW],
  ['review-failed', 'review', 'review&id=failed', REVIEW],
  ['review-uncertain', 'review', 'review&id=uncertain', REVIEW],
  ['review-superseded', 'review', 'review&id=superseded', REVIEW],
  ['review-expired', 'review', 'review&id=expired', REVIEW],
  ['review-discarded', 'review', 'review&id=discarded', REVIEW],
  ['review-locked', 'review', 'review-locked&id=review', REVIEW],
  ['review-missing', 'review', 'review&id=nope', REVIEW],
  ['review-mainnet', 'review', 'review-mainnet&id=review', REVIEW],
];

const axePath = process.env.QS_AXE;
const axe = axePath && existsSync(axePath) ? readFileSync(axePath, 'utf8') : null;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const browser = await chromium.launch({ channel: 'chromium', headless: true });
const violations = {};
try {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  await context.route('https://qs.visual/**', (route) => {
    const path = join(out, new URL(route.request().url()).pathname);
    if (!path.startsWith(out) || !existsSync(path)) return route.fulfill({ status: 404 });
    return route.fulfill({ body: readFileSync(path), contentType: TYPES[extname(path)] ?? 'application/octet-stream' });
  });
  for (const [name, page, query, viewport, steps = []] of SCENES) {
    if (only && !only.test(name)) continue;
    const p = await context.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.setViewportSize(viewport);
    await p.goto(`https://qs.visual/${page}.html?scene=${query}`);
    await p.waitForTimeout(400);
    try {
      for (const s of steps) {
        await s(p);
        await p.waitForTimeout(250);
      }
    } catch (error) {
      console.log(`${name}: step failed: ${error.message.split('\n')[0]}`);
    }
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(300);
    await p.screenshot({ path: join(shots, `${name}.png`) });
    if (errors.length) console.log(`${name}: page errors: ${errors.join(' | ')}`);
    if (axe) {
      await p.addScriptTag({ content: axe });
      const result = await p.evaluate(() =>
        window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }),
      );
      for (const v of result.violations)
        for (const n of v.nodes) (violations[`${v.id}: ${v.help}`] ??= []).push(`${name} ${n.target.join(' ')}`);
    }
    console.log(`shot ${name}`);
    await p.close();
  }
} finally {
  await browser.close();
}
if (axe) {
  const ids = Object.keys(violations);
  console.log(ids.length ? `axe: ${ids.length} rule(s) violated` : 'axe: no violations');
  for (const id of ids) console.log(`  ${id}\n    ${[...new Set(violations[id])].slice(0, 12).join('\n    ')}`);
}
