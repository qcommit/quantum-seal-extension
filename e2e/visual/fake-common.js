// Visual check only (e2e/visual.mjs): stands in for src/ui/common.js so the real popup and
// review components render fixed states without a chain, a vault or chrome.storage. The
// scene comes from the page URL (?scene=...). Nothing here is shipped.
import { encodeIntent, hex, intentDigest } from 'quantum-seal-wallet/codec';
import { GENESIS } from 'quantum-seal-wallet/network';
import { mergeSettings } from '../../src/networks.js';
import { lamportsToSol, SETTINGS_KEY, EXECUTE_LABEL } from '../../src/wallet-service.js';
import { errorText, friendlyMessage } from '../../src/errors.js';
import { tokenAccountFor } from '../../src/intent.js';

export { lamportsToSol, SETTINGS_KEY, errorText, friendlyMessage };

const params = new URLSearchParams(location.search);
const scene = params.get('scene') ?? 'home';
const SOL = 1000000000n;
const WALLET = '7a9ADva7mjZ4DP5rnRYLQ6X1pqRo2UTUfwoshZX5FSA6';
const FEE = 'DVNoP39iGUR1GZEvgNhBTq859FQCuvpSjGqDrPMRTk3u';
const PROGRAM = '6LBRd57jagVvhmpX1idsw9QXhoNHMHWstvpeGdSZAexT';
const TO = '5vVevv3JNQRKP8Xtqhs5FXLR1vGQ1wVh4HMjqfchFsJy';
const MINT = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';
const cluster = scene.includes('mainnet') ? 'mainnet-beta' : 'devnet';

const settings = mergeSettings({ cluster, autoLockMinutes: 15 });
export async function getSettings() {
  return structuredClone(settings);
}
export async function saveSettings() {}
export async function pinNetworkChoice() {}
export function touch() {}
export function trackActivity() {}
export function onStorageChange() {
  return () => {};
}
export function onSendsChange() {
  return () => {};
}
export function short(address, n = 4) {
  return address ? `${address.slice(0, n)}…${address.slice(-n)}` : '';
}
export function solDisplay(lamports, digits = 4) {
  const full = lamportsToSol(lamports);
  const [whole, frac = ''] = full.split('.');
  const cut = frac.slice(0, digits).replace(/0+$/, '');
  return cut ? `${whole}.${cut}` : whole;
}
export async function openReview(id) {
  window.__opened = id;
}

const never = () => new Promise(() => {});
const fail = (message) => async () => {
  throw new Error(message);
};

export const storage = { local: {}, session: {} };
export const vault = {
  async exists() {
    return !scene.startsWith('welcome');
  },
  async isUnlocked() {
    return !scene.startsWith('unlock') && scene !== 'review-locked';
  },
  unlock: fail('Unable to unlock keystore.'),
  create: never,
  importBackup: fail('The backup could not be opened with this passphrase.'),
  async publicInfo() {
    return { feePayer: FEE, backedUp: !(scene === 'home-nobackup' || scene.startsWith('setup')) };
  },
  async markBackedUp() {},
  exportBackup: never,
  async lock() {},
};

function overview() {
  const base = {
    cluster,
    label: cluster === 'devnet' ? 'Devnet' : 'Mainnet',
    isTestNetwork: cluster !== 'mainnet-beta',
    wallet: WALLET,
    initialized: true,
    balanceLamports: 1928633000n,
    availableLamports: 1926743120n,
    reserveLamports: 1889880n,
    maxSendableLamports: 1926678120n,
    feePayer: FEE,
    feeLamports: 70000000n,
    feeNeededLamports: 57000000n,
    sweepableLamports: 0n,
    topUpLamports: 0n,
    otherWallets: [],
    tokens: [
      { account: 'A1', mint: MINT, amount: '5000000', decimals: 6, uiAmount: '5' },
      { account: 'A2', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amount: '1250000', decimals: 6, uiAmount: '1.25' },
    ],
  };
  switch (scene) {
    case 'setup-waiting':
      return { ...base, initialized: false, feeLamports: 0n, tokens: [] };
    case 'setup-ready':
      return { ...base, initialized: false, feeLamports: 2000000000n, tokens: [] };
    case 'home-empty':
      return { ...base, availableLamports: 0n, balanceLamports: 0n, tokens: [] };
    case 'home-low':
      return { ...base, feeLamports: 12000000n, topUpLamports: 0n };
    case 'home-topup':
      return { ...base, feeLamports: 61000000n, topUpLamports: 9000000n };
    case 'home-sweep':
      return { ...base, feeLamports: 120056912n, sweepableLamports: 50056912n };
    case 'home-other':
      return { ...base, otherWallets: [{ wallet: TO, program: PROGRAM, lamports: 250000000n }] };
    case 'home-long':
      return { ...base, availableLamports: 123456789012345n };
    default:
      return base;
  }
}

// Send journal fixtures: one record per status, with real intent bytes so the review
// window decodes them exactly as it does in the extension.
let sendsPromise;
function sends() {
  sendsPromise ??= buildSends();
  return sendsPromise;
}
async function buildSends() {
  const genesis = GENESIS[cluster];
  const intent = (nonce, action, feeTo = FEE) =>
    encodeIntent({
      genesis,
      program: PROGRAM,
      wallet: WALLET,
      epoch: 0n,
      nonce: BigInt(nonce),
      expiry: 3025n,
      action,
      fee: { to: feeTo, lamports: 65000n },
    });
  const destination = await tokenAccountFor(TO, MINT);
  const token = intent(1, {
    kind: 'invoke',
    program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    metas: [
      { key: '3Kx7HhZbVv8ox3n1ZxB4mF7tqR2rM3wBXtnz1C9YtA6c', writable: true, signer: false },
      { key: MINT, writable: false, signer: false },
      { key: destination, writable: true, signer: false },
      { key: WALLET, writable: false, signer: true },
    ],
    data: Uint8Array.of(12, 0x60, 0xe3, 0x16, 0, 0, 0, 0, 0, 6),
  });
  const chunks = (n, last = 'confirmed') =>
    Array.from({ length: n }, (_, i) => [
      { phase: 'prepared', label: `upload-chunk-${i}`, signature: `sig${i}` },
      { phase: i === n - 1 ? last : 'confirmed', label: `upload-chunk-${i}`, signature: `sig${i}` },
    ]).flat();
  const execute = [
    { phase: 'prepared', label: 'upload-chunk+seal-proof+verify-batch-1-8', signature: 'v' },
    { phase: 'confirmed', label: 'upload-chunk+seal-proof+verify-batch-1-8', signature: 'v' },
    { phase: 'prepared', label: EXECUTE_LABEL, signature: 'x' },
    {
      phase: 'confirmed',
      label: EXECUTE_LABEL,
      signature: '4nC8jQf5f1d1G4H3mXbqvF5n5r6mQd9pMZb2vB8K1t3XzKk1Wq7aB9cV2yD7eR6uT5sQ4pL3oK2jH1gF9eD8cB7a',
    },
  ];
  const t0 = Date.now();
  const make = (i, status, extra = {}, bytes = intent(i, { kind: 'transfer', to: TO, lamports: 250000000n })) => ({
    id: status === 'review' && extra.token ? 'review-token' : status,
    cluster,
    program: PROGRAM,
    genesis,
    wallet: WALLET,
    feePayer: FEE,
    createdAt: new Date(t0 - i * 3600_000 * (i > 4 ? 30 : 1)).toISOString(),
    status,
    intentHex: hex(bytes),
    digest: hex(intentDigest(bytes)),
    display: extra.token
      ? { asset: MINT, amount: '1.5', to: TO, decimals: 6 }
      : { asset: 'SOL', amount: '0.25', to: TO },
    nonce: String(i),
    expiry: '3025',
    feeRefundLamports: '65000',
    refundableRentLamports: '56911920',
    approval: status === 'review' ? null : {},
    records: [],
    error: null,
    ...extra,
  });
  return [
    make(0, 'review'),
    make(1, 'review', { token: true }, token),
    make(2, 'signed'),
    make(3, 'submitting', { records: chunks(4, 'prepared') }),
    make(4, 'done', { records: [...chunks(11), ...execute] }),
    make(5, 'failed', {
      records: chunks(6),
      error: 'Simulation rejected verify-batch-1-8: Program failed to complete: exceeded CUs meter at BPF instruction',
    }),
    make(6, 'uncertain', {
      records: chunks(3),
      uncertainSignature: '2w1dZp8Lr3qXnL1x6dVZzY3a3h3s9uJ6YtB8nP4QeR5kTq7Mb2Vc1Xz9Ws8Ua7Tb6Rc5Qd4Pe3Of2Ng1Mh9Li8',
    }),
    make(7, 'superseded', { records: chunks(2), reclaimSignature: 'r', reclaimedLamports: '56911920' }),
    make(8, 'expired', { reclaimError: 'Could not reach the Solana RPC endpoint.' }),
    make(9, 'discarded'),
    // Its fee refill goes to someone else: the window must refuse to approve it.
    make(10, 'review', { id: 'blocked' }, intent(10, { kind: 'transfer', to: TO, lamports: 250000000n }, TO)),
  ];
}

export const service = {
  async availability() {
    return { 'mainnet-beta': cluster === 'mainnet-beta', devnet: true, localnet: false };
  },
  async reclaimAbandoned() {
    return { reclaimed: 0 };
  },
  async overview() {
    if (scene === 'home-error') throw new Error('Failed to fetch');
    if (scene === 'home-loading') return never();
    return overview();
  },
  async descriptor() {
    return { wallet: WALLET };
  },
  async listSends() {
    if (scene === 'activity-empty') return [];
    return sends();
  },
  async getSend(id) {
    return (await sends()).find((s) => s.id === id) ?? null;
  },
  prepareSend: fail('The recipient has no account for this token yet. Ask them to create one, then send again.'),
  setupWallet: never,
  sweepExcess: never,
  topUpFeeKey: never,
  approve: never,
  execute: never,
  discardSend: never,
  checkUncertain: async () => ({ found: false }),
};
