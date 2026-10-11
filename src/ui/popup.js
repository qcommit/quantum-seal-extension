import {
  vault,
  service,
  h,
  short,
  qr,
  copy,
  touch,
  errorText,
  getSettings,
  saveSettings,
  lamportsToSol,
} from './common.js';
import { BUILT_IN, deploymentFor, explorerUrl } from '../networks.js';
import { FEE_FLOAT_LAMPORTS } from '../wallet-service.js';

const root = document.getElementById('app');
let view = 'home';
let busy = false;

function screen(title, ...body) {
  root.replaceChildren(
    h(
      'header',
      { class: 'top' },
      h('div', { class: 'brand' }, h('img', { src: 'icons/mark.svg', alt: '' }), h('span', {}, 'Quantum Seal')),
      title ? h('span', { class: 'top-title' }, title) : null,
    ),
    h('main', {}, ...body),
  );
}
function notice(text, kind = 'info') {
  return h('p', { class: `notice ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, text);
}
function button(label, onclick, kind = 'primary', extra = {}) {
  return h('button', { class: `btn ${kind}`, type: 'button', onclick, ...extra }, label);
}
async function guarded(fn, statusEl) {
  if (busy) return;
  busy = true;
  touch();
  try {
    await fn();
  } catch (error) {
    if (statusEl) statusEl.replaceChildren(notice(errorText(error), 'error'));
    else render(errorText(error));
  } finally {
    busy = false;
  }
}

// Renders run one at a time, in order, so a slow screen (e.g. a balance fetch) can
// never paint over a later one such as the lock screen.
let renderChain = Promise.resolve();
function render(errorMessage) {
  renderChain = renderChain.then(() => renderNow(errorMessage)).catch(() => {});
  return renderChain;
}
async function renderNow(errorMessage) {
  if (!(await vault.exists())) return welcome(errorMessage);
  if (!(await vault.isUnlocked())) return unlock(errorMessage);
  const views = { home, receive, send, settings, backup };
  return (views[view] ?? home)(errorMessage);
}

function welcome(errorMessage) {
  const status = h('div');
  const pass = h('input', { type: 'password', placeholder: 'Passphrase (12+ characters)', autocomplete: 'new-password' });
  const confirm = h('input', { type: 'password', placeholder: 'Repeat passphrase', autocomplete: 'new-password' });
  const file = h('input', { type: 'file', accept: 'application/json,.json' });
  const importPass = h('input', { type: 'password', placeholder: 'Backup passphrase', autocomplete: 'current-password' });
  screen(
    null,
    h('h1', {}, 'A post-quantum wallet for Solana'),
    h('p', { class: 'muted' }, 'Your keys are created and encrypted on this device. Transfers are approved with SLH-DSA (FIPS 205).'),
    errorMessage ? notice(errorMessage, 'error') : null,
    h('section', { class: 'card' },
      h('h2', {}, 'Create a wallet'),
      pass,
      confirm,
      button('Create wallet', () =>
        guarded(async () => {
          if (pass.value !== confirm.value) throw new Error('Passphrases do not match.');
          status.replaceChildren(notice('Creating keys…'));
          await vault.create(pass.value);
          view = 'home';
          await render();
        }, status),
      ),
    ),
    h('details', { class: 'card' },
      h('summary', {}, 'Restore from a backup file'),
      file,
      importPass,
      button('Restore', () =>
        guarded(async () => {
          const f = file.files?.[0];
          if (!f) throw new Error('Choose a backup file.');
          status.replaceChildren(notice('Unlocking backup…'));
          await vault.importBackup(await f.text(), importPass.value);
          view = 'home';
          await render();
        }, status), 'secondary'),
    ),
    status,
  );
}

function unlock(errorMessage) {
  const status = h('div');
  const pass = h('input', { type: 'password', placeholder: 'Passphrase', autocomplete: 'current-password', autofocus: true });
  const go = () =>
    guarded(async () => {
      status.replaceChildren(notice('Unlocking…'));
      await vault.unlock(pass.value);
      view = 'home';
      await render();
    }, status);
  pass.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  screen(null, h('h1', {}, 'Welcome back'), errorMessage ? notice(errorMessage, 'error') : null, pass, button('Unlock', go), status);
  pass.focus();
}

function nav(active) {
  const item = (id, label) =>
    h('button', { class: `nav-item${active === id ? ' active' : ''}`, type: 'button', onclick: () => { view = id; render(); } }, label);
  return h('nav', { class: 'nav' }, item('home', 'Home'), item('receive', 'Receive'), item('send', 'Send'), item('settings', 'Settings'));
}

async function home(errorMessage) {
  screen('Loading…', h('div', { class: 'spinner', 'aria-label': 'Loading' }));
  let o;
  try {
    o = await service.overview();
  } catch (error) {
    return screen(
      null,
      notice(errorText(error), 'error'),
      h('p', { class: 'muted' }, 'Choose an available network or check the RPC endpoint in Settings.'),
      nav('home'),
    );
  }
  const status = h('div');
  if (!o.initialized) {
    // Setup keeps a fee float on this address; anything above it moves into the wallet.
    const minimum = FEE_FLOAT_LAMPORTS + 10000000n;
    const enough = o.feeLamports >= minimum;
    return screen(
      o.label,
      h('h1', {}, 'Set up your wallet'),
      h('p', { class: 'muted' }, `Send at least ${lamportsToSol(minimum)} SOL to this setup address. The extension creates your post-quantum wallet, keeps ${lamportsToSol(FEE_FLOAT_LAMPORTS)} SOL here for network fees, and moves everything else into the wallet.`),
      h('div', { class: 'address-card' }, qr(o.feePayer), h('code', { class: 'address' }, o.feePayer),
        button('Copy address', (e) => copy(o.feePayer, e.currentTarget), 'secondary')),
      h('p', {}, `Setup address balance: `, h('b', {}, `${lamportsToSol(o.feeLamports)} SOL`)),
      enough
        ? button('Create my wallet', () =>
            guarded(async () => {
              status.replaceChildren(notice('Creating your wallet on-chain…'));
              await service.setupWallet();
              await render();
            }, status))
        : notice(`Waiting for at least ${lamportsToSol(minimum)} SOL.`),
      button('Refresh', () => render(), 'ghost'),
      status,
      errorMessage ? notice(errorMessage, 'error') : null,
      nav('home'),
    );
  }
  const sends = await service.listSends();
  const lowFees = o.feeLamports < o.feeNeededLamports;
  screen(
    o.label,
    h('section', { class: 'balance' },
      h('p', { class: 'label' }, 'Balance'),
      h('p', { class: 'amount' }, lamportsToSol(o.availableLamports), h('small', {}, ' SOL')),
      h('button', { class: 'chip', type: 'button', onclick: (e) => copy(o.wallet, e.currentTarget) }, short(o.wallet, 6)),
    ),
    h('div', { class: 'actions' },
      button('Receive', () => { view = 'receive'; render(); }, 'secondary'),
      button('Send', () => { view = 'send'; render(); }),
    ),
    lowFees
      ? notice(`Fee balance is low (${lamportsToSol(o.feeLamports)} SOL). Send a little SOL to ${short(o.feePayer, 6)} so transfers can start.`, 'warn')
      : h('p', { class: 'fee-line' }, `Fee balance ${lamportsToSol(o.feeLamports)} SOL · refilled automatically by each send`),
    o.tokens.length
      ? h('section', { class: 'list' }, h('h2', {}, 'Tokens'),
          ...o.tokens.map((t) => h('div', { class: 'row' }, h('span', {}, short(t.mint, 5)), h('b', {}, t.uiAmount))))
      : null,
    sends.length
      ? h('section', { class: 'list' }, h('h2', {}, 'Recent'),
          ...sends.slice(0, 5).map((s) =>
            h('button', { class: 'row link', type: 'button', onclick: () => openReview(s.id) },
              h('span', {}, `${s.display.amount} ${s.display.asset === 'SOL' ? 'SOL' : short(s.display.asset)} → ${short(s.display.to)}`),
              h('span', { class: `pill ${s.status}` }, s.status))))
      : null,
    errorMessage ? notice(errorMessage, 'error') : null,
    status,
    nav('home'),
  );
}

async function receive() {
  const d = await service.descriptor();
  screen(
    'Receive',
    h('p', { class: 'muted' }, 'Send SOL or tokens to your wallet address. It stays the same even if you rotate keys later.'),
    h('div', { class: 'address-card' }, qr(d.wallet), h('code', { class: 'address' }, d.wallet),
      button('Copy address', (e) => copy(d.wallet, e.currentTarget), 'secondary')),
    nav('receive'),
  );
}

async function send() {
  const o = await service.overview();
  const status = h('div');
  const asset = h('select', {}, h('option', { value: 'SOL' }, 'SOL'), ...o.tokens.map((t) => h('option', { value: t.mint }, `${short(t.mint, 5)} (${t.uiAmount})`)));
  const to = h('input', { placeholder: 'Recipient address', spellcheck: 'false', autocomplete: 'off' });
  const amount = h('input', { placeholder: 'Amount', inputmode: 'decimal', autocomplete: 'off' });
  screen(
    'Send',
    h('label', {}, 'Asset', asset),
    h('label', {}, 'To', to),
    h('label', {}, 'Amount', amount),
    h('p', { class: 'muted small' }, `Available: ${lamportsToSol(o.availableLamports)} SOL. You will review the exact transfer in a separate window before signing.`),
    button('Review', () =>
      guarded(async () => {
        status.replaceChildren(notice('Preparing…'));
        const record = await service.prepareSend({
          asset: asset.value === 'SOL' ? 'SOL' : 'TOKEN',
          mint: asset.value === 'SOL' ? undefined : asset.value,
          to: to.value.trim(),
          amount: amount.value.trim(),
        });
        await openReview(record.id);
        status.replaceChildren(notice('Review window opened.'));
      }, status)),
    status,
    nav('send'),
  );
}

async function settings() {
  const s = await getSettings();
  const available = await service.availability();
  const status = h('div');
  const cluster = h('select', {}, ...Object.entries(BUILT_IN).map(([id, n]) =>
    // Only mainnet is locked until the release pins it; test networks can be configured here.
    h('option', { value: id, selected: s.cluster === id, disabled: id === 'mainnet-beta' && !available[id] }, `${n.label}${available[id] ? '' : id === 'mainnet-beta' ? ' (not available yet)' : ' (needs pins)'}`)));
  const current = deploymentFor(s);
  const rpc = h('input', { value: s.rpc?.[s.cluster] ?? '', placeholder: current.rpc, spellcheck: 'false' });
  const lock = h('input', { type: 'number', min: '1', max: '240', value: String(s.autoLockMinutes) });
  const dev = s.deployments?.[s.cluster] ?? {};
  const fields = Object.fromEntries(['program', 'programSha256', 'programSize', 'upgradeAuthority', 'genesis'].map((k) =>
    [k, h('input', { value: dev[k] ?? '', placeholder: k, spellcheck: 'false' })]));
  screen(
    'Settings',
    h('label', {}, 'Network', cluster),
    h('label', {}, 'RPC endpoint (optional)', rpc),
    h('label', {}, 'Auto-lock after (minutes)', lock),
    s.cluster !== 'mainnet-beta'
      ? h('details', { class: 'card' }, h('summary', {}, 'Developer deployment pins'),
          h('p', { class: 'muted small' }, 'For devnet or a local validator only. Mainnet pins are fixed by the release.'),
          ...Object.values(fields))
      : null,
    button('Save', () =>
      guarded(async () => {
        const next = structuredClone(s);
        next.autoLockMinutes = Math.min(240, Math.max(1, Number(lock.value) || 15));
        if (rpc.value.trim()) next.rpc[s.cluster] = rpc.value.trim();
        else delete next.rpc[s.cluster];
        if (s.cluster !== 'mainnet-beta') {
          const pins = Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value.trim() || undefined]).filter(([, v]) => v));
          if (pins.programSize) pins.programSize = Number(pins.programSize);
          if (Object.keys(pins).length) next.deployments[s.cluster] = pins;
          else delete next.deployments[s.cluster];
        }
        next.cluster = cluster.value;
        await saveSettings(next);
        status.replaceChildren(notice('Saved.'));
        await render();
      }, status)),
    button('Back up wallet', () => { view = 'backup'; render(); }, 'secondary'),
    button('Lock now', async () => { await vault.lock(); render(); }, 'ghost'),
    status,
    nav('settings'),
  );
}

async function backup() {
  const status = h('div');
  screen(
    'Backup',
    h('p', {}, 'The backup file holds your keys encrypted with your passphrase, plus your public wallet addresses. Keep it somewhere safe; anyone with the file and the passphrase controls the wallet.'),
    h('p', { class: 'muted small' }, 'The owner key inside also opens with the Quantum Seal command line.'),
    button('Download backup', () =>
      guarded(async () => {
        const data = await vault.exportBackup();
        const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = h('a', { href: url, download: 'quantum-seal-backup.json' });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        status.replaceChildren(notice('Backup downloaded.'));
      }, status)),
    status,
    nav('settings'),
  );
}

async function openReview(id) {
  await chrome.windows.create({ url: chrome.runtime.getURL(`review.html?id=${encodeURIComponent(id)}`), type: 'popup', width: 420, height: 720 });
}

document.addEventListener('click', touch, true);
document.addEventListener('keydown', touch, true);
render();
export { explorerUrl };
