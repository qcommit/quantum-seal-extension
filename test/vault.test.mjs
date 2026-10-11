import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptKey as cliDecrypt } from 'quantum-seal-wallet/crypto';
import { hex } from 'quantum-seal-wallet/codec';
import { createVaultStore, BACKUP_FORMAT } from '../src/vault.js';
import { fakeStorage } from './fake-storage.mjs';

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
  await first.setDescriptor('devnet', { wallet: 'W', program: 'P', genesis: 'G' });
  const backup = await first.exportBackup();
  assert.equal(backup.format, BACKUP_FORMAT);
  assert.equal(backup.descriptors.devnet.wallet, 'W');
  const cliSecret = await cliDecrypt(backup.owner, pass);
  assert.equal(hex(cliSecret.slice(32)), created.ownerPublicKey);
  const second = createVaultStore(fakeStorage());
  await assert.rejects(second.importBackup(JSON.stringify(backup), 'wrong passphrase!!'), /Unable to unlock/);
  assert.equal(await second.exists(), false);
  const restored = await second.importBackup(JSON.stringify(backup), pass);
  assert.equal(restored.feePayer, created.feePayer);
  assert.equal(hex((await second.ownerSecret()).slice(32)), created.ownerPublicKey);
  assert.equal((await second.publicInfo()).descriptors.devnet.wallet, 'W');
});
