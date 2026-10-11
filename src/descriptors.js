// Wallet descriptors (the public data that locates a wallet: program, cluster genesis,
// salt and the initial owner policy). The extension only ever creates one policy: the
// vault's own SLH-DSA key, threshold 1, no recovery guardian. A descriptor from storage or
// from a backup file is never trusted as given: it is rebuilt from its salt and that
// policy, and refused if the wallet address does not come out the same.
import { sha256 } from '@noble/hashes/sha2.js';
import { PublicKey } from '@solana/web3.js';
import { createDescriptor } from 'quantum-seal-wallet/wallet';
import { hex, fromHex } from 'quantum-seal-wallet/codec';

export const DESCRIPTOR_FORMAT = 'quantum-seal/wallet-descriptor/1';
export const CLUSTERS = Object.freeze(['mainnet-beta', 'devnet', 'localnet']);
const SALT_DOMAIN = new TextEncoder().encode('QuantumSeal/ExtensionSalt/v1');
const FIELDS = ['format', 'program', 'genesis', 'wallet', 'id', 'salt', 'initialPolicy'];

export function ownPolicy(ownerPublicKey) {
  return { keys: [ownerPublicKey], threshold: 1, guardian: null, recoveryDelay: '0' };
}

// The salt for new wallets is derived from the owner key and the deployment, so the
// wallet address on any network can be recomputed from the backup's keys alone.
export function deterministicSalt(ownerPublicKey, genesis, program) {
  const owner = fromHex(ownerPublicKey, 32);
  const g = new PublicKey(genesis).toBytes(),
    p = new PublicKey(program).toBytes();
  const input = new Uint8Array(SALT_DOMAIN.length + 96);
  input.set(SALT_DOMAIN, 0);
  input.set(owner, SALT_DOMAIN.length);
  input.set(g, SALT_DOMAIN.length + 32);
  input.set(p, SALT_DOMAIN.length + 64);
  return sha256(input);
}

export async function ownDescriptor(ownerPublicKey, program, genesis) {
  return createDescriptor({
    program,
    genesis,
    policy: ownPolicy(ownerPublicKey),
    salt: deterministicSalt(ownerPublicKey, genesis, program),
  });
}

export class ForeignDescriptorError extends Error {
  constructor(where) {
    super(
      `The ${where} wallet is not controlled by your key alone (another owner, a recovery ` +
        'guardian, or a different key). It was refused. If it came from a backup file, the file ' +
        'may have been altered: restore from an original backup.',
    );
    this.name = 'ForeignDescriptorError';
  }
}

// Field by field: chrome.storage returns object keys in sorted order.
function samePolicy(a, p) {
  return (
    p &&
    typeof p === 'object' &&
    Object.keys(p).length === 4 &&
    Array.isArray(p.keys) &&
    p.keys.length === a.keys.length &&
    p.keys.every((k, i) => k === a.keys[i]) &&
    p.threshold === a.threshold &&
    p.guardian === a.guardian &&
    p.recoveryDelay === a.recoveryDelay
  );
}

// Returns the canonical descriptor if `d` is a wallet whose only owner is
// ownerPublicKey (threshold 1, no guardian, no recovery delay); throws otherwise.
export async function verifyOwnDescriptor(d, ownerPublicKey, where = 'stored') {
  if (
    !d ||
    typeof d !== 'object' ||
    Array.isArray(d) ||
    Object.keys(d).length !== FIELDS.length ||
    FIELDS.some((k) => !Object.hasOwn(d, k)) ||
    d.format !== DESCRIPTOR_FORMAT
  )
    throw new Error(`The ${where} wallet description is malformed.`);
  let rebuilt;
  try {
    rebuilt = await createDescriptor({
      program: d.program,
      genesis: d.genesis,
      policy: ownPolicy(ownerPublicKey),
      salt: fromHex(d.salt, 32),
    });
  } catch {
    throw new Error(`The ${where} wallet description is malformed.`);
  }
  if (
    rebuilt.wallet !== d.wallet ||
    rebuilt.id !== d.id ||
    rebuilt.program !== d.program ||
    rebuilt.genesis !== d.genesis ||
    !samePolicy(rebuilt.initialPolicy, d.initialPolicy)
  )
    throw new ForeignDescriptorError(where);
  return rebuilt;
}

// The wallet's live on-chain policy must still be exactly the vault key alone, with no
// recovery in progress. (The extension never rotates keys, so any change is foreign.)
export function verifyOwnState(state, ownerPublicKey) {
  const p = state.policy;
  const keys = p.keys.map((k) => hex(k));
  if (
    keys.length !== 1 ||
    keys[0] !== ownerPublicKey ||
    p.threshold !== 1 ||
    p.guardian ||
    BigInt(p.recoveryDelay) !== 0n ||
    state.recoveryOwners
  )
    throw new Error(
      'This wallet’s on-chain owners are no longer just your key. Do not send funds to it. ' +
        'Restore from an original backup and check the wallet on an explorer.',
    );
}

// Stored descriptors: { [cluster]: [descriptor, ...] }, one entry per deployment. Older
// versions stored a single descriptor per cluster; both shapes are read.
export function descriptorLists(map) {
  const out = {};
  for (const [cluster, value] of Object.entries(map ?? {})) {
    const list = Array.isArray(value) ? value : value ? [value] : [];
    if (list.length) out[cluster] = list;
  }
  return out;
}
