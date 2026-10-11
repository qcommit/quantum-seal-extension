// Key vault. At rest: two quantum-seal/keystore/1 envelopes (the SLH-DSA owner key and
// the Ed25519 fee key) under one passphrase, in chrome.storage.local. While unlocked:
// the decrypted secrets live only in chrome.storage.session, which is memory-backed,
// limited to extension pages, and cleared on lock, idle timeout or browser exit.
import { generateKeypair } from 'quantum-seal-wallet/approval';
import { encryptKey, decryptKey, FEE_KEY_ALGORITHM } from 'quantum-seal-wallet/keystore-web';
import { hex, fromHex } from 'quantum-seal-wallet/codec';
import { Keypair } from '@solana/web3.js';

export const VAULT_KEY = 'vault';
const SESSION_KEY = 'unlocked';
export const BACKUP_FORMAT = 'quantum-seal/extension-backup/1';

export function createVaultStore(storage) {
  // storage: { local: {get,set,remove}, session: {get,set,remove} } with chrome.storage semantics.
  async function read() {
    return (await storage.local.get(VAULT_KEY))[VAULT_KEY] ?? null;
  }
  async function unlockedSecrets() {
    return (await storage.session.get(SESSION_KEY))[SESSION_KEY] ?? null;
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
        descriptors: vault.descriptors ?? {},
      };
    },
    async create(password) {
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
      }
    },
    async importBackup(text, password) {
      if (await read()) throw new Error('A wallet already exists in this browser profile.');
      const backup = typeof text === 'string' ? JSON.parse(text) : text;
      if (!backup || backup.format !== BACKUP_FORMAT) throw new Error('Not a Quantum Seal backup.');
      const owner = await decryptKey(backup.owner, password);
      const fee = await decryptKey(backup.fee, password, FEE_KEY_ALGORITHM);
      try {
        const feePayer = (await Keypair.fromSecretKey(fee)).publicKey.toBase58();
        await storage.local.set({
          [VAULT_KEY]: {
            version: 1,
            owner: backup.owner,
            fee: backup.fee,
            feePayer,
            descriptors: backup.descriptors ?? {},
            createdAt: new Date().toISOString(),
          },
        });
        await storage.session.set({ [SESSION_KEY]: { owner: hex(owner), fee: hex(fee) } });
        return { ownerPublicKey: backup.owner.publicKey, feePayer };
      } finally {
        owner.fill(0);
        fee.fill(0);
      }
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
      return await Keypair.fromSecretKey(fromHex(s.fee, 64));
    },
    async ownerSecret() {
      const s = await unlockedSecrets();
      if (!s) throw new Error('Wallet is locked.');
      return fromHex(s.owner, 64);
    },
    async vault() {
      return read();
    },
    async setDescriptor(cluster, descriptor) {
      const vault = await read();
      if (!vault) throw new Error('No wallet in this browser profile.');
      const descriptors = { ...(vault.descriptors ?? {}), [cluster]: descriptor };
      await storage.local.set({ [VAULT_KEY]: { ...vault, descriptors } });
    },
    async exportBackup() {
      // Keystores are already encrypted under the passphrase; the backup is those
      // envelopes plus the public descriptor, so it needs no re-encryption.
      const vault = await read();
      if (!vault) throw new Error('No wallet in this browser profile.');
      return {
        format: BACKUP_FORMAT,
        owner: vault.owner,
        fee: vault.fee,
        feePayer: vault.feePayer,
        descriptors: vault.descriptors ?? {},
        exportedAt: new Date().toISOString(),
      };
    },
  };
}
