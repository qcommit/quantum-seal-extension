// Key vault. At rest: two quantum-seal/keystore/1 envelopes (the SLH-DSA owner key and
// the Ed25519 fee key) under one passphrase, in chrome.storage.local. While unlocked:
// the decrypted secrets live only in chrome.storage.session, which is memory-backed,
// limited to extension pages, and cleared on lock, idle timeout or browser exit.
import { generateKeypair } from 'quantum-seal-wallet/approval';
import { encryptKey, decryptKey, FEE_KEY_ALGORITHM } from 'quantum-seal-wallet/keystore-web';
import { hex, fromHex } from 'quantum-seal-wallet/codec';
import { Keypair } from '@solana/web3.js';
import { CLUSTERS, descriptorLists, verifyOwnDescriptor } from './descriptors.js';
import { withLock } from './locks.js';

export const VAULT_KEY = 'vault';
const SESSION_KEY = 'unlocked';
export const BACKUP_FORMAT = 'quantum-seal/extension-backup/1';
const MAX_BACKUP_BYTES = 256 * 1024;
const LABELS = { 'mainnet-beta': 'Mainnet', devnet: 'Devnet', localnet: 'Local validator' };

// Checks every descriptor in a backup against the decrypted owner key before anything
// is stored. Returns the canonical lists.
async function checkedDescriptors(input, ownerPublicKey) {
  if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input)))
    throw new Error('Not a Quantum Seal backup.');
  const lists = descriptorLists(input);
  const out = {};
  for (const [cluster, list] of Object.entries(lists)) {
    if (!CLUSTERS.includes(cluster)) throw new Error('The backup names an unknown network.');
    out[cluster] = [];
    for (const d of list) {
      const checked = await verifyOwnDescriptor(d, ownerPublicKey, `backup’s ${LABELS[cluster]}`);
      if (!out[cluster].some((x) => x.wallet === checked.wallet)) out[cluster].push(checked);
    }
  }
  return out;
}

export function createVaultStore(storage) {
  // storage: { local: {get,set,remove}, session: {get,set,remove} } with chrome.storage semantics.
  async function read() {
    return (await storage.local.get(VAULT_KEY))[VAULT_KEY] ?? null;
  }
  async function unlockedSecrets() {
    return (await storage.session.get(SESSION_KEY))[SESSION_KEY] ?? null;
  }
  // Session secrets must belong to the stored vault (a create/import race or a stale
  // session could leave others). On mismatch the wallet locks.
  async function mismatch() {
    await storage.session.remove(SESSION_KEY);
    return new Error('Your keys do not match this wallet. Please unlock again.');
  }
  return {
    async exists() {
      return (await read()) !== null;
    },
    async publicInfo() {
      const vault = await read();
      if (!vault) return null;
      return {
        ownerPublicKey: vault.owner.publicKey,
        feePayer: vault.feePayer,
        descriptors: descriptorLists(vault.descriptors),
        // A backup was downloaded, or the wallet was restored from one.
        backedUp: Boolean(vault.backedUpAt),
      };
    },
    async create(password) {
      return withLock('vault', async () => {
        if (await read()) throw new Error('A wallet already exists in this browser profile.');
        const owner = generateKeypair();
        const fee = await Keypair.generate();
        try {
          const vault = {
            version: 1,
            owner: await encryptKey(owner.secretKey, password),
            fee: await encryptKey(fee.secretKey, password, FEE_KEY_ALGORITHM),
            feePayer: fee.publicKey.toBase58(),
            descriptors: {},
            createdAt: new Date().toISOString(),
          };
          await storage.local.set({ [VAULT_KEY]: vault });
          await storage.session.set({
            [SESSION_KEY]: { owner: hex(owner.secretKey), fee: hex(fee.secretKey) },
          });
          return { ownerPublicKey: hex(owner.publicKey), feePayer: vault.feePayer };
        } finally {
          owner.secretKey.fill(0);
          fee.secretKey.fill?.(0);
        }
      });
    },
    async importBackup(text, password) {
      return withLock('vault', async () => {
        if (await read()) throw new Error('A wallet already exists in this browser profile.');
        if (typeof text === 'string' && text.length > MAX_BACKUP_BYTES)
          throw new Error('Not a Quantum Seal backup.');
        let backup;
        try {
          backup = typeof text === 'string' ? JSON.parse(text) : text;
        } catch {
          throw new Error('Not a Quantum Seal backup.');
        }
        if (!backup || backup.format !== BACKUP_FORMAT) throw new Error('Not a Quantum Seal backup.');
        const owner = await decryptKey(backup.owner, password);
        const fee = await decryptKey(backup.fee, password, FEE_KEY_ALGORITHM);
        try {
          const ownerPublicKey = hex(owner.slice(32));
          if (ownerPublicKey !== backup.owner.publicKey) throw new Error('Not a Quantum Seal backup.');
          const descriptors = await checkedDescriptors(backup.descriptors, ownerPublicKey);
          const feePayer = (await Keypair.fromSecretKey(fee)).publicKey.toBase58();
          await storage.local.set({
            [VAULT_KEY]: {
              version: 1,
              owner: backup.owner,
              fee: backup.fee,
              feePayer,
              descriptors,
              createdAt: new Date().toISOString(),
              backedUpAt: new Date().toISOString(),
            },
          });
          await storage.session.set({ [SESSION_KEY]: { owner: hex(owner), fee: hex(fee) } });
          return { ownerPublicKey, feePayer };
        } finally {
          owner.fill(0);
          fee.fill(0);
        }
      });
    },
    async unlock(password) {
      const vault = await read();
      if (!vault) throw new Error('No wallet in this browser profile.');
      const owner = await decryptKey(vault.owner, password);
      const fee = await decryptKey(vault.fee, password, FEE_KEY_ALGORITHM);
      try {
        await storage.session.set({ [SESSION_KEY]: { owner: hex(owner), fee: hex(fee) } });
      } finally {
        owner.fill(0);
        fee.fill(0);
      }
    },
    async lock() {
      await storage.session.remove(SESSION_KEY);
    },
    async isUnlocked() {
      return (await unlockedSecrets()) !== null;
    },
    async feeKeypair() {
      const s = await unlockedSecrets();
      if (!s) throw new Error('Wallet is locked.');
      const vault = await read();
      const keypair = await Keypair.fromSecretKey(fromHex(s.fee, 64));
      if (!vault || keypair.publicKey.toBase58() !== vault.feePayer) throw await mismatch();
      return keypair;
    },
    async ownerSecret() {
      const s = await unlockedSecrets();
      if (!s) throw new Error('Wallet is locked.');
      const vault = await read();
      const secret = fromHex(s.owner, 64);
      if (!vault || hex(secret.slice(32)) !== vault.owner.publicKey) {
        secret.fill(0);
        throw await mismatch();
      }
      return secret;
    },
    async vault() {
      return read();
    },
    // Adds a descriptor for a deployment on `cluster`. Existing descriptors are never
    // replaced or removed, so a wallet from an earlier deployment stays recoverable.
    async addDescriptor(cluster, descriptor) {
      return withLock('vault', async () => {
        const vault = await read();
        if (!vault) throw new Error('No wallet in this browser profile.');
        const descriptors = descriptorLists(vault.descriptors);
        const list = descriptors[cluster] ?? [];
        if (list.some((d) => d.wallet === descriptor.wallet)) return;
        descriptors[cluster] = [...list, descriptor];
        await storage.local.set({ [VAULT_KEY]: { ...vault, descriptors } });
      });
    },
    async exportBackup() {
      // Keystores are already encrypted under the passphrase; the backup is those
      // envelopes plus the public descriptors, so it needs no re-encryption.
      const vault = await read();
      if (!vault) throw new Error('No wallet in this browser profile.');
      return {
        format: BACKUP_FORMAT,
        owner: vault.owner,
        fee: vault.fee,
        feePayer: vault.feePayer,
        descriptors: descriptorLists(vault.descriptors),
        exportedAt: new Date().toISOString(),
      };
    },
    // Re-encrypts both keys under a new passphrase. The current one must open them first.
    // Backup files saved earlier keep the passphrase they were saved with.
    async changePassphrase(current, next) {
      return withLock('vault', async () => {
        const vault = await read();
        if (!vault) throw new Error('No wallet in this browser profile.');
        const owner = await decryptKey(vault.owner, current);
        const fee = await decryptKey(vault.fee, current, FEE_KEY_ALGORITHM);
        try {
          if (hex(owner.slice(32)) !== vault.owner.publicKey) throw new Error('Unable to unlock keystore.');
          if ((await Keypair.fromSecretKey(fee)).publicKey.toBase58() !== vault.feePayer)
            throw new Error('Unable to unlock keystore.');
          await storage.local.set({
            [VAULT_KEY]: {
              ...vault,
              owner: await encryptKey(owner, next),
              fee: await encryptKey(fee, next, FEE_KEY_ALGORITHM),
              passphraseChangedAt: new Date().toISOString(),
            },
          });
        } finally {
          owner.fill(0);
          fee.fill(0);
        }
      });
    },
    // Deletes the keys from this browser profile (encrypted and unlocked copies).
    async remove() {
      return withLock('vault', async () => {
        await storage.session.remove(SESSION_KEY);
        await storage.local.remove(VAULT_KEY);
      });
    },
    // Called once the backup file has been handed to the browser to save. One backup
    // covers every wallet address: they are re-derived from the owner key on restore.
    async markBackedUp() {
      return withLock('vault', async () => {
        const vault = await read();
        if (!vault) throw new Error('No wallet in this browser profile.');
        if (!vault.backedUpAt) await storage.local.set({ [VAULT_KEY]: { ...vault, backedUpAt: new Date().toISOString() } });
      });
    },
  };
}
