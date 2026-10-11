// Chrome Web Store images, composed from the real popup and review UI.
//
//   node scripts/store-assets.mjs
//
// Renders the mainnet fixture scenes at 2x with e2e/visual.mjs, then lays them out on
// branded canvases and writes store/: four 1280x800 screenshots, the 440x280 small promo
// tile and the 1400x560 marquee. Figures in the screens are fixtures, not real wallets.
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, '.runtime/shots/store');
const out = join(root, 'store');
mkdirSync(out, { recursive: true });

execFileSync(process.execPath, [join(root, 'e2e/visual.mjs'), '^(welcome|home-mainnet|review-mainnet|receive-mainnet|review-done-mainnet)$'], {
  stdio: 'inherit',
  env: { ...process.env, QS_SCALE: '2', QS_SHOTS: shots },
});

const dataUrl = (path, type) => `data:${type};base64,${readFileSync(path).toString('base64')}`;
const shot = (name) => dataUrl(join(shots, `${name}.png`), 'image/png');
const font = dataUrl(join(root, 'node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2'), 'font/woff2');
const mark = dataUrl(join(root, 'assets/mark.svg'), 'image/svg+xml');

const CSS = `
@font-face { font-family: Inter; src: url(${font}) format('woff2'); font-weight: 100 900; }
* { box-sizing: border-box; margin: 0; }
html, body { width: 100%; height: 100%; }
body {
  font-family: Inter, sans-serif; color: #f4f3f8; overflow: hidden; position: relative;
  background:
    radial-gradient(60% 80% at 82% 30%, rgba(164,151,255,.22), transparent 70%),
    radial-gradient(50% 70% at 96% 96%, rgba(255,138,216,.14), transparent 70%),
    radial-gradient(45% 60% at 4% 100%, rgba(143,245,255,.12), transparent 70%),
    #07070c;
}
body::before {
  content: ''; position: absolute; inset: 0; opacity: .5;
  background-image: radial-gradient(rgba(255,255,255,.07) 1px, transparent 1px);
  background-size: 22px 22px;
  mask-image: linear-gradient(90deg, transparent, #000 45%, #000);
}
.holo { background: linear-gradient(100deg, #8ff5ff, #a497ff 48%, #ff8ad8); -webkit-background-clip: text; background-clip: text; color: transparent; }
.brand { display: flex; align-items: center; gap: 14px; font-weight: 650; font-size: 21px; letter-spacing: .01em; }
.brand img { width: 46px; height: 46px; }
.eyebrow { font-size: 15px; font-weight: 650; letter-spacing: .2em; text-transform: uppercase; }
h1 { font-size: 54px; line-height: 1.06; letter-spacing: -.025em; font-weight: 720; }
p.sub { font-size: 21px; line-height: 1.5; color: #b4b2bf; }
.frame {
  border-radius: 22px; overflow: hidden; background: #0a0a0f;
  border: 1px solid rgba(255,255,255,.1);
  box-shadow: 0 40px 90px -20px rgba(0,0,0,.8), 0 0 0 1px rgba(164,151,255,.12), 0 0 80px -10px rgba(164,151,255,.35);
}
.frame img { display: block; }
.shot { position: absolute; inset: 0; display: grid; grid-template-columns: 560px 1fr; align-items: center; padding: 0 0 0 84px; }
.copy { display: grid; gap: 22px; position: relative; z-index: 1; }
.stage { position: relative; height: 100%; }
.chips { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 6px; }
.chip { font-size: 15px; font-weight: 560; color: #d9d7e3; padding: 8px 14px; border-radius: 999px; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.1); }
`;

const brand = `<div class="brand"><img src="${mark}" alt=""><span>Quantum Seal</span></div>`;
const frame = (name, w, h, style) =>
  `<div class="frame" style="position:absolute;${style}"><img src="${shot(name)}" width="${w}" height="${h}" alt=""></div>`;
const screenshot = ({ eyebrow, title, sub, chips = [], stage }) => `
  <div class="shot">
    <div class="copy">
      ${brand}
      <div class="eyebrow holo" style="margin-top:26px">${eyebrow}</div>
      <h1>${title}</h1>
      <p class="sub">${sub}</p>
      ${chips.length ? `<div class="chips">${chips.map((c) => `<span class="chip">${c}</span>`).join('')}</div>` : ''}
    </div>
    <div class="stage">${stage}</div>
  </div>`;

// Popup 400x600, review window 420x720 (CSS pixels; the images are 2x).
const ASSETS = [
  {
    file: 'screenshot-1-approve.png',
    size: [1280, 800],
    html: screenshot({
      eyebrow: 'Post-quantum approvals',
      title: 'Every transfer, sealed with <span class="holo">SLH-DSA</span>.',
      sub: 'Review the exact transfer in Quantum Seal’s own window. Your post-quantum key signs it, and the wallet program verifies it on-chain before anything moves.',
      chips: ['NIST FIPS 205', 'Verified on-chain', 'Solana mainnet'],
      stage: frame('review-mainnet', 420, 720, 'left:120px;top:40px'),
    }),
  },
  {
    file: 'screenshot-2-home.png',
    size: [1280, 800],
    html: screenshot({
      eyebrow: 'Your wallet',
      title: 'SOL and SPL tokens, one calm screen.',
      sub: 'Send and receive SOL and classic SPL tokens. You pay your own network fees from a small fee address, refilled a little with every send.',
      chips: ['Send', 'Receive', 'Activity'],
      stage: frame('home-mainnet', 400, 600, 'left:130px;top:100px'),
    }),
  },
  {
    file: 'screenshot-3-receive.png',
    size: [1280, 800],
    html: screenshot({
      eyebrow: 'Recoverable by design',
      title: 'One address, always recoverable.',
      sub: 'Your wallet address is derived from your keys, so restoring an encrypted backup brings back the same address and funds.',
      stage:
        frame('review-done-mainnet', 420, 720, 'left:250px;top:40px;transform:scale(.9);transform-origin:top left;opacity:.9') +
        frame('receive-mainnet', 400, 600, 'left:40px;top:120px'),
    }),
  },
  {
    file: 'screenshot-4-private.png',
    size: [1280, 800],
    html: screenshot({
      eyebrow: 'Private by default',
      title: 'Keys made and encrypted on your device.',
      sub: 'No account, no analytics, no tracking. A passphrase you choose encrypts your keys, and the wallet locks itself when you step away.',
      chips: ['scrypt + AES-256-GCM', 'Auto-lock', 'No tracking'],
      stage: frame('welcome', 400, 600, 'left:130px;top:100px'),
    }),
  },
  {
    file: 'promo-small-440x280.png',
    size: [440, 280],
    html: `
      <div style="position:absolute;inset:0;display:grid;place-items:center;text-align:center;padding:24px">
        <div style="display:grid;justify-items:center;gap:14px">
          <img src="${mark}" width="84" height="84" alt="" style="filter:drop-shadow(0 0 24px rgba(164,151,255,.45))">
          <div style="font-size:34px;font-weight:720;letter-spacing:-.02em">Quantum Seal</div>
          <div class="holo" style="font-size:16px;font-weight:650;letter-spacing:.14em;text-transform:uppercase">Post-quantum Solana wallet</div>
        </div>
      </div>`,
  },
  {
    file: 'promo-marquee-1400x560.png',
    size: [1400, 560],
    html: `
      <div style="position:absolute;inset:0;display:grid;grid-template-columns:1fr 520px;align-items:center;padding:0 0 0 96px">
        <div style="display:grid;gap:22px">
          ${brand}
          <h1 style="font-size:64px">Solana, sealed for<br>the <span class="holo">quantum era</span>.</h1>
          <p class="sub">Every transfer approved with SLH-DSA (FIPS 205) and verified on-chain.</p>
        </div>
        <div style="position:relative;height:100%">
          ${frame('home-mainnet', 400, 600, 'left:40px;top:70px')}
        </div>
      </div>`,
  },
];

const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  for (const { file, size, html } of ASSETS) {
    const page = await browser.newPage({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${html}</body></html>`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(out, file) });
    await page.close();
    console.log(`store/${file}`);
  }
} finally {
  await browser.close();
}
