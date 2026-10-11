import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptKey as cliDecrypt } from 'quantum-seal-wallet/crypto';
import { hex } from 'quantum-seal-wallet/codec';
import { Keypair } from '@solana/web3.js';
import { createDescriptor } from 'quantum-seal-wallet/wallet';
import { generateKeypair } from 'quantum-seal-wallet/approval';
import { createVaultStore, BACKUP_FORMAT } from '../src/vault.js';
import { ownDescriptor, deterministicSalt } from '../src/descriptors.js';
import { fakeStorage } from './support/fake-storage.mjs';

const key = async () => (await Keypair.generate()).publicKey.toBase58();

const pass = 'a long test passphrase';

test('create stores only encrypted keys at rest and unlocks into session memory', async () => {
  const storage = fakeStorage();
  const vault = createVaultStore(storage);
  assert.equal(await vault.exists(), false);
  const created = await vault.create(pass);
  assert.equal(await vault.exists(), true);
  assert.equal(await vault.isUnlocked(), true);
  const atRest = JSON.stringify(storage.local.dump());
  const secret = await vault.ownerSecret();
  assert.ok(!atRest.includes(hex(secret)), 'owner secret must not be stored in clear');
  assert.equal(hex(secret.slice(32)), created.ownerPublicKey);
  const fee = await vault.feeKeypair();
  assert.equal(fee.publicKey.toBase58(), created.feePayer);
  assert.ok(!atRest.includes(hex(fee.secretKey)));
  await assert.rejects(vault.create(pass), /already exists/);
});

test('lock clears session secrets; wrong passphrase does not unlock', async () => {
  const vault = createVaultStore(fakeStorage());
  await vault.create(pass);
  await vault.lock();
  assert.equal(await vault.isUnlocked(), false);
  await assert.rejects(vault.ownerSecret(), /locked/);
  await assert.rejects(vault.unlock(pass + 'x'), /Unable to unlock/);
  assert.equal(await vault.isUnlocked(), false);
  await vault.unlock(pass);
  assert.equal(await vault.isUnlocked(), true);
});

test('weak passphrases are refused', async () => {
  const vault = createVaultStore(fakeStorage());
  await assert.rejects(vault.create('short'), /12 characters/);
  assert.equal(await vault.exists(), false);
});

test('backup restores in another profile and its owner key opens with the CLI', async () => {
  const first = createVaultStore(fakeStorage());
  const created = await first.create(pass);
  const d = await ownDescriptor(created.ownerPublicKey, await key(), await key());
  await first.addDescriptor('devnet', d);
  const backup = await first.exportBackup();
  assert.equal(backup.format, BACKUP_FORMAT);
  assert.equal(backup.descriptors.devnet[0].wallet, d.wallet);
  const cliSecret = await cliDecrypt(backup.owner, pass);
  assert.equal(hex(cliSecret.slice(32)), created.ownerPublicKey);
  const second = createVaultStore(fakeStorage());
  await assert.rejects(second.importBackup(JSON.stringify(backup), 'wrong passphrase!!'), /Unable to unlock/);
  assert.equal(await second.exists(), false);
  const restored = await second.importBackup(JSON.stringify(backup), pass);
  assert.equal(restored.feePayer, created.feePayer);
  assert.equal(hex((await second.ownerSecret()).slice(32)), created.ownerPublicKey);
  assert.equal((await second.publicInfo()).descriptors.devnet[0].wallet, d.wallet);
});

test('a wallet counts as backed up once a backup is saved or it was restored from one', async () => {
  const first = createVaultStore(fakeStorage());
  await first.create(pass);
  assert.equal((await first.publicInfo()).backedUp, false);
  const backup = await first.exportBackup();
  assert.equal((await first.publicInfo()).backedUp, false, 'exporting alone is not saving');
  await first.markBackedUp(backup);
  assert.equal((await first.publicInfo()).backedUp, true);
  const second = createVaultStore(fakeStorage());
  await second.importBackup(JSON.stringify(backup), pass);
  assert.equal((await second.publicInfo()).backedUp, true);
  await assert.rejects(createVaultStore(fakeStorage()).markBackedUp(), /No wallet/);
});

test('a backup acknowledgement cannot mark replacement keys or a changed passphrase as saved', async () => {
  const storage = fakeStorage();
  const vault = createVaultStore(storage);
  await vault.create(pass);
  const old = await vault.exportBackup();
  await vault.changePassphrase(pass, 'another long test passphrase');
  await assert.rejects(vault.markBackedUp(old), /changed.*download.*backup/i);
  assert.equal((await vault.publicInfo()).backedUp, false);
  const current = await vault.exportBackup();
  await vault.markBackedUp(current);
  assert.equal((await vault.publicInfo()).backedUp, true);
  await vault.remove();
  await vault.create(pass);
  await assert.rejects(vault.markBackedUp(current), /changed.*download.*backup/i);
  assert.equal((await vault.publicInfo()).backedUp, false);
});

test('a backup acknowledgement requires the exact exported encrypted keys', async () => {
  const vault = createVaultStore(fakeStorage());
  await vault.create(pass);
  await assert.rejects(vault.markBackedUp(), /download.*backup/i);
  const backup = await vault.exportBackup();
  await assert.rejects(vault.markBackedUp({ ...backup, fee: { ...backup.fee, ciphertext: 'changed' } }), /changed.*download.*backup/i);
  assert.equal((await vault.publicInfo()).backedUp, false);
});

// A backup whose keystores are genuine (the real passphrase opens them) but whose public
// descriptors were edited by someone else.
async function tamperedBackup(policyFor) {
  const first = createVaultStore(fakeStorage());
  const created = await first.create(pass);
  const backup = await first.exportBackup();
  const attacker = hex(generateKeypair().publicKey);
  const descriptor = await createDescriptor({
    program: await key(),
    genesis: await key(),
    policy: policyFor(created.ownerPublicKey, attacker),
  });
  return { ...backup, descriptors: { 'mainnet-beta': descriptor } };
}

for (const [name, policyFor] of [
  ['an attacker-only key', (_, attacker) => ({ keys: [attacker], threshold: 1 })],
  ['an extra co-owner', (owner, attacker) => ({ keys: [owner, attacker], threshold: 1 })],
  ['an attacker recovery guardian', (owner, attacker) => ({ keys: [owner], threshold: 1, guardian: attacker, recoveryDelay: 216000n })],
])
  test(`a backup whose wallet has ${name} is refused and nothing is stored`, async () => {
    const backup = await tamperedBackup(policyFor);
    const storage = fakeStorage();
    const vault = createVaultStore(storage);
    await assert.rejects(vault.importBackup(JSON.stringify(backup), pass), /not controlled by your key alone/);
    assert.equal(await vault.exists(), false);
    assert.equal(await vault.isUnlocked(), false);
  });

test('a descriptor edited to another wallet address, or malformed, is refused', async () => {
  const first = createVaultStore(fakeStorage());
  const created = await first.create(pass);
  const d = await ownDescriptor(created.ownerPublicKey, await key(), await key());
  const backup = await first.exportBackup();
  const moved = { ...backup, descriptors: { devnet: [{ ...d, wallet: await key() }] } };
  await assert.rejects(createVaultStore(fakeStorage()).importBackup(JSON.stringify(moved), pass), /not controlled by your key alone/);
  const broken = { ...backup, descriptors: { devnet: [{ ...d, extra: 1 }] } };
  await assert.rejects(createVaultStore(fakeStorage()).importBackup(JSON.stringify(broken), pass), /malformed/);
  const unknown = { ...backup, descriptors: { testnet: [d] } };
  await assert.rejects(createVaultStore(fakeStorage()).importBackup(JSON.stringify(unknown), pass), /unknown network/);
});

test('an older backup (one descriptor per network, random salt) still restores the same wallet', async () => {
  const first = createVaultStore(fakeStorage());
  const created = await first.create(pass);
  // What earlier versions wrote: a random salt and a bare object per cluster.
  const old = await createDescriptor({ program: await key(), genesis: await key(), policy: { keys: [created.ownerPublicKey], threshold: 1 } });
  const backup = { ...(await first.exportBackup()), descriptors: { devnet: old } };
  const second = createVaultStore(fakeStorage());
  await second.importBackup(JSON.stringify(backup), pass);
  assert.deepEqual((await second.publicInfo()).descriptors.devnet, [old]);
});

test('new wallet addresses are a function of the owner key and deployment', async () => {
  const owner = hex(generateKeypair().publicKey);
  const [program, genesis] = [await key(), await key()];
  const a = await ownDescriptor(owner, program, genesis);
  const b = await ownDescriptor(owner, program, genesis);
  assert.equal(a.wallet, b.wallet);
  assert.equal(a.salt, hex(deterministicSalt(owner, genesis, program)));
  assert.notEqual((await ownDescriptor(owner, await key(), genesis)).wallet, a.wallet);
  assert.deepEqual(a.initialPolicy, { keys: [owner], threshold: 1, guardian: null, recoveryDelay: '0' });
});

test('addDescriptor keeps every deployment and never replaces one', async () => {
  const vault = createVaultStore(fakeStorage());
  const created = await vault.create(pass);
  const genesis = await key();
  const a = await ownDescriptor(created.ownerPublicKey, await key(), genesis);
  const b = await ownDescriptor(created.ownerPublicKey, await key(), genesis);
  await vault.addDescriptor('devnet', a);
  await vault.addDescriptor('devnet', b);
  await vault.addDescriptor('devnet', a);
  assert.deepEqual((await vault.publicInfo()).descriptors.devnet.map((d) => d.wallet), [a.wallet, b.wallet]);
});

test('session secrets that do not belong to the stored vault lock the wallet', async () => {
  const storage = fakeStorage();
  const vault = createVaultStore(storage);
  await vault.create(pass);
  const other = createVaultStore(fakeStorage());
  await other.create(pass);
  const foreign = { owner: hex(await other.ownerSecret()), fee: hex((await other.feeKeypair()).secretKey) };
  await storage.session.set({ unlocked: foreign });
  await assert.rejects(vault.feeKeypair(), /unlock again/);
  assert.equal(await vault.isUnlocked(), false);
  await storage.session.set({ unlocked: foreign });
  await assert.rejects(vault.ownerSecret(), /unlock again/);
  assert.equal(await vault.isUnlocked(), false);
});

test('two concurrent creates leave one vault whose keys match the session', async () => {
  const storage = fakeStorage();
  const vault = createVaultStore(storage);
  const results = await Promise.allSettled([vault.create(pass), vault.create(pass)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.match(results.find((r) => r.status === 'rejected').reason.message, /already exists/);
  const created = results.find((r) => r.status === 'fulfilled').value;
  assert.equal((await vault.feeKeypair()).publicKey.toBase58(), created.feePayer);
});

test('changing the passphrase re-encrypts both keys; the old one stops working', async () => {
  const storage = fakeStorage();
  const vault = createVaultStore(storage);
  const created = await vault.create(pass);
  const backup = await vault.exportBackup();
  await assert.rejects(vault.changePassphrase('not the passphrase', 'a brand new passphrase'), /Unable to unlock/);
  await assert.rejects(vault.changePassphrase(pass, 'short'), /at least 12/);
  await vault.changePassphrase(pass, 'a brand new passphrase');
  await vault.lock();
  await assert.rejects(vault.unlock(pass), /Unable to unlock/);
  await vault.unlock('a brand new passphrase');
  assert.equal(hex((await vault.ownerSecret()).slice(32)), created.ownerPublicKey);
  assert.equal((await vault.feeKeypair()).publicKey.toBase58(), created.feePayer);
  // A backup saved before the change still opens with the passphrase it was saved with.
  await createVaultStore(fakeStorage()).importBackup(JSON.stringify(backup), pass);
});

test('remove deletes the encrypted and the unlocked keys', async () => {
  const storage = fakeStorage();
  const vault = createVaultStore(storage);
  await vault.create(pass);
  assert.equal(await vault.isUnlocked(), true);
  await vault.remove();
  assert.equal(await vault.exists(), false);
  assert.equal(await vault.isUnlocked(), false);
  assert.deepEqual(storage.local.dump(), {});
  await vault.create(pass);
});
