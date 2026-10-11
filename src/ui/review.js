import { vault, service, h, short, touch, errorText, lamportsToSol } from './common.js';
import { explorerUrl } from '../networks.js';
import { decodeIntent, fromHex } from 'quantum-seal-wallet/codec';

const root = document.getElementById('app');
const id = new URLSearchParams(location.search).get('id');
// Labels the SDK attaches to each transaction, in order.
const STEPS = [
  ['begin-proof', 'Open proof account'],
  ['upload-chunk', 'Upload signature (11 chunks)'],
  ['seal-proof', 'Seal upload'],
  ['verify-batch', 'Verify on-chain (FORS + 7 XMSS layers)'],
  ['execute-wallet-transfer', 'Execute transfer'],
  ['reclaim-proof-rent', 'Reclaim proof rent'],
];

function row(label, value, mono = false) {
  return h('div', { class: 'kv' }, h('span', {}, label), mono ? h('code', {}, value) : h('b', {}, value));
}
function stepState(record, key) {
  const confirmed = record.records.filter((r) => r.phase === 'confirmed' && r.label.startsWith(key));
  const prepared = record.records.filter((r) => r.phase === 'prepared' && r.label.startsWith(key));
  if (key === 'upload-chunk') return { done: confirmed.length, total: 11, active: prepared.length > confirmed.length };
  return { done: confirmed.length ? 1 : 0, total: 1, active: prepared.length > confirmed.length };
}

function progress(record) {
  return h('ol', { class: 'steps' }, ...STEPS.map(([key, label]) => {
    const s = stepState(record, key);
    const state = s.done >= s.total ? 'done' : s.active || s.done ? 'active' : 'pending';
    return h('li', { class: state }, h('span', { class: 'dot' }), label, key === 'upload-chunk' && s.done && s.done < s.total ? ` (${s.done}/11)` : '');
  }));
}

async function render(message) {
  const record = await service.getSend(id);
  if (!record) return root.replaceChildren(h('main', {}, h('p', { class: 'notice error' }, 'This send no longer exists.')));
  if (!(await vault.isUnlocked()))
    return root.replaceChildren(h('main', {}, h('p', { class: 'notice warn' }, 'The wallet is locked. Unlock it from the toolbar button, then reopen this send.')));
  const intent = decodeIntent(fromHex(record.intentHex));
  const a = intent.action;
  const tokenSend = a.kind === 'invoke';
  const amount = tokenSend ? record.display.amount : lamportsToSol(a.lamports);
  const fee = intent.fee ?? null;
  const status = h('div');
  const body = [
    h('h1', {}, record.status === 'review' ? 'Review transfer' : 'Transfer'),
    h('section', { class: 'card review' },
      row('Send', `${amount} ${tokenSend ? short(record.display.asset, 6) : 'SOL'}`),
      row('To', record.display.to, true),
      row('Network', record.cluster),
      row('From wallet', intent.wallet.toBase58(), true),
      fee ? row('Fee refill to your fee key', `${lamportsToSol(fee.lamports)} SOL`) : null,
      row('Refundable proof deposit', `${lamportsToSol(record.refundableRentLamports)} SOL`),
      row('Approval valid until slot', intent.expiry.toString()),
      row('Wallet nonce', intent.nonce.toString()),
    ),
  ];
  if (record.status === 'review') {
    body.push(
      h('p', { class: 'muted small' }, 'Approving signs exactly these details with your post-quantum key. Any change invalidates the signature.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn ghost', type: 'button', onclick: async () => { await service.discardSend(id); window.close(); } }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => run(status, true) }, 'Approve & send')),
    );
  } else {
    body.push(progress(record));
    if (record.status === 'done') {
      const exec = record.records.find((r) => r.phase === 'confirmed' && r.label === 'execute-wallet-transfer');
      body.push(h('p', { class: 'notice ok' }, 'Sent.'),
        exec ? h('a', { href: explorerUrl(record.cluster, 'tx', exec.signature), target: '_blank', rel: 'noopener' }, 'View on Solana Explorer') : null);
    } else if (record.status === 'uncertain') {
      body.push(
        h('p', { class: 'notice warn' }, 'The network did not confirm a transaction in time. Nothing will be re-signed. Check its status before resuming.'),
        h('code', { class: 'address' }, record.uncertainSignature ?? ''),
        h('div', { class: 'actions' },
          h('button', { class: 'btn secondary', type: 'button', onclick: () => check(status) }, 'Check status'),
          h('button', { class: 'btn primary', type: 'button', onclick: () => run(status, false) }, 'Resume')),
      );
    } else if (record.status === 'failed' || record.status === 'signed') {
      body.push(
        record.error ? h('p', { class: 'notice error' }, record.error) : null,
        h('p', { class: 'muted small' }, 'Resuming continues from what is already on-chain, with the same signed approval.'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => run(status, false) }, 'Resume'),
      );
    } else if (record.status === 'submitting') {
      body.push(h('p', { class: 'muted' }, 'Sending… keep this window open.'),
        h('button', { class: 'btn secondary', type: 'button', onclick: () => run(status, false) }, 'Resume if stalled'));
    }
  }
  if (message) body.push(h('p', { class: 'notice error' }, message));
  body.push(status);
  root.replaceChildren(h('main', {}, ...body));
}

let running = false;
async function run(status, sign) {
  if (running) return;
  running = true;
  touch();
  try {
    if (sign) {
      status.replaceChildren(h('p', { class: 'notice' }, 'Signing with your post-quantum key…'));
      await service.approve(id);
    }
    await render();
    await service.execute(id, () => { touch(); render(); });
    await render();
  } catch (error) {
    await render(errorText(error));
  } finally {
    running = false;
  }
}
async function check(status) {
  try {
    const result = await service.checkUncertain(id);
    status.replaceChildren(h('p', { class: 'notice' }, result?.found
      ? `Found on-chain (${result.confirmation}${result.err ? ', failed' : ''}). Resume to continue from there.`
      : 'Not found on-chain. Resume is safe: the next step is rebuilt from on-chain state.'));
  } catch (error) {
    status.replaceChildren(h('p', { class: 'notice error' }, errorText(error)));
  }
}
render();
