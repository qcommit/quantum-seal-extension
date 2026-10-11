import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { createDescriptor } from 'quantum-seal-wallet/wallet';
import { generateKeypair } from 'quantum-seal-wallet/approval';
import { decodeIntent, encodeIntent, intentDigest, deriveProof, hex, fromHex } from 'quantum-seal-wallet/codec';
import { executeInstruction } from 'quantum-seal-wallet/instructions';
import { createVaultStore } from '../src/vault.js';
import { deterministicSalt } from '../src/descriptors.js';
import {
  createWalletService,
  pickTokenSource,
  executesIntent,
  SUPERSEDED_TEXT,
  EXPIRED_TEXT,
  FEE_FLOAT_LAMPORTS,
  MAX_FINISHED_SENDS,
  receiptsOf,
  formatUnits,
  mayStillExecute,
  corroborate,
} from '../src/wallet-service.js';
import { fakeStorage } from './support/fake-storage.mjs';
import { fakeChain } from './support/fake-chain.mjs';

const pass = 'a long test passphrase';
const key = async () => (await Keypair.generate()).publicKey.toBase58();
const SOL = 1000000000n;

async function setup({ wallet = true, feeLamports = FEE_FLOAT_LAMPORTS } = {}) {
  const chain = await fakeChain();
  const storage = fakeStorage();
  await storage.local.set({ settings: chain.settings() });
  const vault = createVaultStore(storage);
  const created = await vault.create(pass);
  const service = createWalletService({ vault, storage, connect: () => chain.connection });
  const d = await service.descriptor();
  if (wallet) await chain.setWallet(d);
  chain.fund(created.feePayer, feeLamports);
  return { chain, storage, vault, service, d, created };
}
const balance = (chain, address) => chain.connection.getBalance(new PublicKey(address));
async function stored(storage, id) {
  return (await storage.local.get(`send:${id}`))[`send:${id}`];
}
async function edit(storage, id, fn) {
  const record = await stored(storage, id);
  fn(record);
  await storage.local.set({ [`send:${id}`]: record });
  return record;
}
test('a send to this wallet, a program, a mint or a token account is refused before signing', async () => {
  const t = await setup();
  const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const put = async (fields) => {
    const address = await key();
    t.chain.accounts.set(address, { lamports: 2039280n, executable: false, data: new Uint8Array(0), ...fields });
    return address;
  };
  const refused = (to, pattern) => assert.rejects(t.service.prepareSend({ to, amount: '0.01' }), pattern);
  await refused(t.d.wallet, /own address/);
  await refused(t.chain.program, /is a program/);
  await refused(await put({ owner: new PublicKey(TOKEN), data: new Uint8Array(82) }), /token mint/);
  await refused(await put({ owner: new PublicKey(TOKEN), data: new Uint8Array(165) }), /token account/);
  const ext = new Uint8Array(200);
  ext[165] = 1;
  await refused(await put({ owner: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'), data: ext }), /token mint/);
  // An unused program-derived address: nobody could move funds sent there.
  const [pda] = await PublicKey.findProgramAddress([new TextEncoder().encode('nobody')], new PublicKey(t.chain.program));
  await refused(pda.toBase58(), /Nobody holds a key/);
  // An older wallet of yours from another deployment.
  const older = await t.chain.deployAgain();
  const vaultInfo = await t.vault.publicInfo();
  const { ownDescriptor } = await import('../src/descriptors.js');
  const old = await ownDescriptor(vaultInfo.ownerPublicKey, older.program, older.genesis);
  await t.vault.addDescriptor('localnet', old);
  await refused(old.wallet, /older wallet of yours/);
  // Plain system accounts, other program-owned accounts and unused addresses are fine.
  assert.ok(await t.service.prepareSend({ to: await put({ owner: new PublicKey('11111111111111111111111111111111') }), amount: '0.01' }));
  assert.ok(await t.service.prepareSend({ to: await key(), amount: '0.01' }));
  assert.equal(t.chain.connection.sent.length, 0, 'nothing is submitted while preparing');
});

// A signed send whose upload was interrupted after its proof account was opened.
async function interruptedSend(t) {
  const record = await t.service.prepareSend({ to: await key(), amount: '0.01' });
  await t.service.approve(record.id, record.digest);
  const { proof } = await deriveProof(t.chain.program, t.d.wallet, intentDigest(fromHex(record.intentHex)), 0, new PublicKey(t.created.feePayer));
  t.chain.openProof(proof);
  await edit(t.storage, record.id, (r) => {
    r.status = 'submitting';
    r.records.push({ phase: 'prepared', label: 'begin-proof+upload-chunk', signature: 'upload-1' });
  });
  return { record, proof };
}

// ---- Finding 1 and 5: descriptors ----

test('the wallet address is derived from the owner key, so a backup without descriptors recovers it', async () => {
  const t = await setup();
  assert.equal(t.d.salt, hex(deterministicSalt(t.created.ownerPublicKey, t.chain.genesis, t.chain.program)));
  const backup = { ...(await t.vault.exportBackup()), descriptors: {} };
  const storage = fakeStorage();
  await storage.local.set({ settings: t.chain.settings() });
  const vault = createVaultStore(storage);
  await vault.importBackup(JSON.stringify(backup), pass);
  const service = createWalletService({ vault, storage, connect: () => t.chain.connection });
  assert.equal((await service.descriptor()).wallet, t.d.wallet);
});

test('an existing (random-salt) descriptor keeps working; a re-pin adds a wallet and keeps the old one visible', async () => {
  const chain = await fakeChain();
  const storage = fakeStorage();
  await storage.local.set({ settings: chain.settings() });
  const vault = createVaultStore(storage);
  const created = await vault.create(pass);
  const old = await createDescriptor({ program: chain.program, genesis: chain.genesis, policy: { keys: [created.ownerPublicKey], threshold: 1 } });
  await vault.addDescriptor('localnet', old);
  const service = createWalletService({ vault, storage, connect: () => chain.connection });
  assert.equal((await service.descriptor()).wallet, old.wallet);
  await chain.setWallet(old, { lamports: 3n * SOL });
  // A release re-pins the network to another deployment.
  const pins = await chain.deployAgain();
  await storage.local.set({ settings: chain.settings({ deployments: { localnet: pins } }) });
  const fresh = await service.descriptor();
  assert.notEqual(fresh.wallet, old.wallet);
  assert.deepEqual((await vault.publicInfo()).descriptors.localnet.map((d) => d.wallet), [old.wallet, fresh.wallet]);
  const o = await service.overview();
  assert.equal(o.wallet, fresh.wallet);
  assert.deepEqual(o.otherWallets, [{ wallet: old.wallet, program: chain.program, lamports: 3n * SOL }]);
});

test('a stored descriptor tampered with after import is refused before use', async () => {
  const t = await setup();
  const attacker = hex(generateKeypair().publicKey);
  const foreign = await createDescriptor({ program: t.chain.program, genesis: t.chain.genesis, policy: { keys: [t.created.ownerPublicKey, attacker], threshold: 1 } });
  const v = await t.vault.vault();
  await t.storage.local.set({ vault: { ...v, descriptors: { localnet: [foreign] } } });
  await assert.rejects(t.service.descriptor(), /not controlled by your key alone/);
  await assert.rejects(t.service.overview(), /not controlled by your key alone/);
});

test('a wallet whose on-chain owners are not the vault key alone is refused', async () => {
  const t = await setup();
  const attacker = hex(generateKeypair().publicKey);
  await t.chain.setWallet(t.d, { policy: { keys: [t.created.ownerPublicKey, attacker], threshold: 1 } });
  await assert.rejects(t.service.overview(), /on-chain owners are no longer just your key/);
  await assert.rejects(t.service.prepareSend({ to: await key(), amount: '0.01' }), /on-chain owners/);
  await t.chain.setWallet(t.d, { policy: { keys: [t.created.ownerPublicKey], threshold: 1, guardian: attacker, recoveryDelay: 300n } });
  await assert.rejects(t.service.overview(), /on-chain owners/);
});

// ---- Finding 4, 9, 11: approve ----

test('approve signs only the bytes the review showed', async () => {
  const t = await setup();
  const record = await t.service.prepareSend({ to: await key(), amount: '0.25' });
  assert.equal(record.digest, hex(intentDigest(fromHex(record.intentHex))));
  await assert.rejects(t.service.approve(record.id, '00'.repeat(32)), /changed after this review window opened/);
  await assert.rejects(t.service.approve(record.id), /changed after/);
  assert.equal((await stored(t.storage, record.id)).status, 'review');
  const signed = await t.service.approve(record.id, record.digest);
  assert.equal(signed.status, 'signed');
  assert.equal(signed.approval.intent, record.intentHex);
});

test('approve refuses an intent whose fee refill, wallet or program differs, even when its digest is shown', async () => {
  const t = await setup();
  const record = await t.service.prepareSend({ to: await key(), amount: '0.25' });
  const intent = decodeIntent(fromHex(record.intentHex));
  const variants = [
    { ...intent, fee: { to: await key(), lamports: 65000n } },
    { ...intent, fee: { to: t.created.feePayer, lamports: 5000000n } },
    { ...intent, fee: null },
    { ...intent, wallet: new PublicKey(await key()) },
    { ...intent, program: new PublicKey(await key()) },
  ];
  for (const v of variants) {
    const bytes = encodeIntent(v);
    await edit(t.storage, record.id, (r) => (r.intentHex = hex(bytes)));
    await assert.rejects(t.service.approve(record.id, hex(intentDigest(bytes))), /does not match your wallet/);
  }
  assert.equal((await stored(t.storage, record.id)).approval, null);
});

test('approve refuses expired and out-of-date reviews, and non-canonical hex', async () => {
  const t = await setup();
  const a = await t.service.prepareSend({ to: await key(), amount: '0.25' });
  t.chain.slot = BigInt(a.expiry) - 100n;
  await assert.rejects(t.service.approve(a.id, a.digest), /expired before you approved it/);
  assert.equal((await stored(t.storage, a.id)).status, 'expired');
  t.chain.slot = 1000n;
  const b = await t.service.prepareSend({ to: await key(), amount: '0.25' });
  await t.chain.setWallet(t.d, { nonce: 1n });
  await assert.rejects(t.service.approve(b.id, b.digest), /out of date/);
  await t.chain.setWallet(t.d);
  const c = await t.service.prepareSend({ to: await key(), amount: '0.25' });
  await edit(t.storage, c.id, (r) => (r.intentHex = r.intentHex.toUpperCase()));
  await assert.rejects(t.service.approve(c.id, c.digest), /canonical lowercase hexadecimal/);
});

test('a send is approved at most once, even from two windows at the same time', async () => {
  const t = await setup();
  const record = await t.service.prepareSend({ to: await key(), amount: '0.25' });
  const results = await Promise.allSettled([t.service.approve(record.id, record.digest), t.service.approve(record.id, record.digest)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.match(results.find((r) => r.status === 'rejected').reason.message, /already approved/);
});

// ---- Finding 2 and 3: outcomes and proof deposits ----

test('a send whose nonce moved on without its execute is "superseded", not done, and its deposit returns', async () => {
  const t = await setup();
  const { record, proof } = await interruptedSend(t);
  const feeBefore = await balance(t.chain, t.created.feePayer);
  const rent = (await t.chain.connection.getAccountInfo(proof)).lamports;
  await t.chain.setWallet(t.d, { nonce: 1n }); // another send ran at this nonce
  const result = await t.service.execute(record.id);
  assert.equal(result.status, 'superseded');
  assert.equal(result.error, SUPERSEDED_TEXT);
  assert.equal(result.approval, null);
  assert.equal(await t.chain.connection.getAccountInfo(proof), null);
  assert.equal(await balance(t.chain, t.created.feePayer), feeBefore + rent - 5000n);
  assert.ok(result.records.some((r) => r.label === 'close-proof' && r.phase === 'confirmed'));
  // Nothing is retried for a superseded send.
  assert.equal((await t.service.execute(record.id)).status, 'superseded');
});

test('a send whose intent was executed by someone else is done, and its own proof deposit still returns', async () => {
  const t = await setup();
  const { record, proof } = await interruptedSend(t);
  const message = new Transaction({ feePayer: new PublicKey(await key()), recentBlockhash: await key() })
    .add(executeInstruction(fromHex(record.intentHex), [new PublicKey(await key())]))
    .compileMessage();
  assert.equal(executesIntent({ transaction: { message } }, t.chain.program, record.intentHex), true);
  assert.equal(executesIntent({ transaction: { message } }, await key(), record.intentHex), false);
  t.chain.addHistory(t.d.wallet, message, 'elsewhere-signature');
  await t.chain.setWallet(t.d, { nonce: 1n });
  const result = await t.service.execute(record.id);
  assert.equal(result.status, 'done');
  assert.equal(result.executeSignature, 'elsewhere-signature');
  assert.equal(result.executedElsewhere, true);
  assert.equal(await t.chain.connection.getAccountInfo(proof), null);
});

test('a send is done only on evidence of its own confirmed execute transaction', async () => {
  const t = await setup();
  const { record } = await interruptedSend(t);
  await edit(t.storage, record.id, (r) =>
    r.records.push({ phase: 'confirmed', label: 'execute-wallet-transfer+reclaim-proof-rent', signature: 'exec-1', error: null }),
  );
  await t.chain.setWallet(t.d, { nonce: 1n });
  const result = await t.service.execute(record.id);
  assert.equal(result.status, 'done');
  assert.equal(result.executeSignature, 'exec-1');
});

test('an approval that expired before it ran is "expired" and its deposit returns', async () => {
  const t = await setup();
  const { record, proof } = await interruptedSend(t);
  t.chain.slot = BigInt(record.expiry) + 1n;
  const result = await t.service.execute(record.id);
  assert.equal(result.status, 'expired');
  assert.equal(result.error, EXPIRED_TEXT);
  assert.equal(await t.chain.connection.getAccountInfo(proof), null);
});

test('execute and checkUncertain refuse a send from another network or wallet', async () => {
  const t = await setup();
  const { record } = await interruptedSend(t);
  await edit(t.storage, record.id, (r) => {
    r.cluster = 'devnet';
    r.uncertainSignature = 'sig';
  });
  await assert.rejects(t.service.execute(record.id), /prepared on Devnet\. Switch the network to Devnet/);
  await assert.rejects(t.service.checkUncertain(record.id), /prepared on Devnet/);
  const other = await key();
  await edit(t.storage, record.id, (r) => {
    r.cluster = 'localnet';
    r.wallet = other;
  });
  await assert.rejects(t.service.execute(record.id), /different Local validator wallet/);
  await t.chain.setWallet(t.d, { nonce: 5n });
  await assert.rejects(t.service.execute(record.id), /different/);
  assert.equal((await stored(t.storage, record.id)).status, 'submitting');
});

test('discarding a failed send closes its proof; once its approval was published it is watched until it expires', async () => {
  const t = await setup();
  const { record, proof } = await interruptedSend(t);
  await edit(t.storage, record.id, (r) => (r.status = 'failed'));
  const kept = await t.service.discardSend(record.id);
  assert.equal(await t.chain.connection.getAccountInfo(proof), null);
  // Its chunks went out in an upload transaction, so it is not provably unsent yet.
  assert.equal(kept.status, 'discarded');
  assert.equal(mayStillExecute(kept), true);
  await t.service.reclaimAbandoned();
  assert.ok(await stored(t.storage, record.id), 'kept while it could still run');
  t.chain.slot = BigInt(record.expiry) + 1n;
  await t.service.reclaimAbandoned();
  assert.equal(await stored(t.storage, record.id), undefined, 'removed once expired');
  // A send discarded before anything was uploaded is removed at once.
  const fresh = await t.service.prepareSend({ to: await key(), amount: '0.01' });
  await t.service.approve(fresh.id, fresh.digest);
  await edit(t.storage, fresh.id, (r) => (r.status = 'failed'));
  assert.equal(await t.service.discardSend(fresh.id), null);
  assert.equal(await stored(t.storage, fresh.id), undefined);
  // A send whose outcome is unknown cannot be discarded.
  const second = await interruptedSend(t);
  await edit(t.storage, second.record.id, (r) => (r.status = 'uncertain'));
  await assert.rejects(t.service.discardSend(second.record.id), /may still be on its way/);
});

test('opening the popup settles abandoned sends and reclaims their deposits', async () => {
  const t = await setup();
  t.chain.fund(t.created.feePayer, 2n * FEE_FLOAT_LAMPORTS);
  const a = await interruptedSend(t);
  const b = await interruptedSend(t);
  await edit(t.storage, a.record.id, (r) => (r.status = 'failed'));
  await edit(t.storage, b.record.id, (r) => {
    r.status = 'superseded';
    r.approval = null;
  });
  // Another network's send is left alone.
  const c = await interruptedSend(t);
  await edit(t.storage, c.record.id, (r) => (r.cluster = 'devnet'));
  await t.chain.setWallet(t.d, { nonce: 1n });
  const { reclaimed } = await t.service.reclaimAbandoned();
  assert.equal(reclaimed, 2);
  assert.equal(await t.chain.connection.getAccountInfo(a.proof), null);
  assert.equal(await t.chain.connection.getAccountInfo(b.proof), null);
  assert.ok(await t.chain.connection.getAccountInfo(c.proof));
  assert.equal((await stored(t.storage, a.record.id)).status, 'superseded');
  assert.equal((await t.service.reclaimAbandoned()).reclaimed, 0);
  // A review left open past its expiry is marked expired (nothing was signed).
  await t.chain.setWallet(t.d, { nonce: 1n });
  const review = await t.service.prepareSend({ to: await key(), amount: '0.01' });
  t.chain.slot = BigInt(review.expiry) + 1n;
  await t.service.reclaimAbandoned();
  assert.equal((await stored(t.storage, review.id)).status, 'expired');
});

// ---- Lows ----

test('a low fee key is reported before review, not after signing', async () => {
  const t = await setup({ feeLamports: 1000000n });
  await assert.rejects(
    t.service.prepareSend({ to: await key(), amount: '0.25' }),
    new RegExp(`fee address needs [0-9.]+ SOL more before you can send\\. Send SOL to ${t.created.feePayer}`),
  );
  await assert.rejects(t.service.prepareSend({ to: 'not-an-address', amount: '1' }), /not a valid Solana address/);
});

test('setup creates the wallet and sweeps; it resumes after an interruption', async () => {
  const t = await setup({ wallet: false, feeLamports: 0n });
  t.chain.fund(t.created.feePayer, SOL);
  t.chain.rejectTransfers = true; // the sweep fails after the wallet is created
  await assert.rejects(t.service.setupWallet(), /Wallet created; moving your SOL into it failed/);
  t.chain.rejectTransfers = false;
  const o = await t.service.overview();
  assert.equal(o.initialized, true);
  assert.ok(o.sweepableLamports > 0n);
  const resumed = await t.service.setupWallet();
  assert.equal(resumed.initialized, false);
  assert.equal(await balance(t.chain, t.created.feePayer), FEE_FLOAT_LAMPORTS);
  assert.equal((await t.service.overview()).sweepableLamports, 0n);
  // SOL sent to the fee address later can be moved in too.
  t.chain.fund(t.created.feePayer, SOL / 2n);
  assert.equal((await t.service.overview()).sweepableLamports, SOL / 2n);
  const swept = await t.service.sweepExcess();
  assert.equal(swept.sweptLamports, SOL / 2n - 5000n);
});

test('the send journal keeps one key per send, migrates the old map, and bounds finished history', async () => {
  const t = await setup();
  const legacy = { id: 'legacy1', status: 'done', createdAt: '2026-01-01T00:00:00.000Z', records: [] };
  await t.storage.local.set({ sends: { legacy1: legacy } });
  assert.deepEqual((await t.service.listSends()).map((s) => s.id), ['legacy1']);
  assert.equal((await t.storage.local.get('sends')).sends, undefined);
  assert.deepEqual(await stored(t.storage, 'legacy1'), legacy);
  const many = {};
  for (let i = 0; i < MAX_FINISHED_SENDS + 5; i++)
    many[`send:old${i}`] = { id: `old${i}`, status: 'done', createdAt: new Date(Date.UTC(2026, 0, 2, 0, 0, i)).toISOString(), records: [] };
  many['send:open'] = { id: 'open', status: 'failed', createdAt: '2025-01-01T00:00:00.000Z', records: [] };
  await t.storage.local.set(many);
  await t.service.reclaimAbandoned().catch(() => {});
  const left = await t.service.listSends();
  assert.equal(left.filter((s) => s.status === 'done').length, MAX_FINISHED_SENDS);
  assert.ok(left.some((s) => s.id === 'open'));
  assert.ok(!left.some((s) => s.id === 'legacy1'));
});

test('token sends use the funded associated account first, else the largest balance', () => {
  const accounts = [
    { address: 'A', amount: 5n },
    { address: 'ATA', amount: 10n },
    { address: 'B', amount: 50n },
  ];
  assert.equal(pickTokenSource(accounts, 'ATA', 8n).address, 'ATA');
  assert.equal(pickTokenSource(accounts, 'ATA', 20n).address, 'B');
  assert.equal(pickTokenSource(accounts, 'none', 1n).address, 'B');
  assert.equal(pickTokenSource(accounts, 'ATA', null).address, 'B');
});

test('a custom mainnet RPC must agree with the public endpoint on slot and wallet state', async () => {
  const { crossCheckRpc, RPC_SLOT_TOLERANCE } = await import('../src/wallet-service.js');
  const { Keypair } = await import('@solana/web3.js');
  const wallet = (await Keypair.generate()).publicKey.toBase58();
  // A wallet account whose decoded state has the given nonce/epoch (layout from the SDK codec).
  const walletData = (nonce, epoch) => {
    const b = new Uint8Array(334);
    b.set(new TextEncoder().encode('QSWAL001'), 0);
    b[8] = 255; // bump
    // policy: owners count 1, threshold 1, key[0] nonzero; guardian zero; delay 0
    b[73] = 1; b[74] = 1; b.fill(7, 75, 107);
    const view = new DataView(b.buffer);
    view.setBigUint64(73 + 98 + 32 + 8, epoch, true);
    view.setBigUint64(73 + 98 + 32 + 8 + 8, nonce, true);
    return b;
  };
  const reference = (slot, nonce, epoch = 0n) => ({
    getSlot: async () => slot,
    getAccountInfo: async () => ({ data: walletData(nonce, epoch) }),
  });
  const intent = { nonce: 4n, epoch: 0n };
  await crossCheckRpc({ reference: reference(1000n, 4n), wallet, intent, slot: 1100n });
  await assert.rejects(
    crossCheckRpc({ reference: reference(1000n, 4n), wallet, intent, slot: 1000n + RPC_SLOT_TOLERANCE + 1n }),
    /different network time/,
  );
  await assert.rejects(crossCheckRpc({ reference: reference(1000n, 3n), wallet, intent, slot: 1000n }), /different wallet state/);
  await assert.rejects(
    crossCheckRpc({ reference: { getSlot: async () => 1000n, getAccountInfo: async () => null }, wallet, intent, slot: 1000n }),
    /different wallet state/,
  );
});

test('the fee key is offered a top-up from the wallet only when that send can run', async () => {
  const { topUpAmount, FEE_FLOAT_LAMPORTS, FEE_REFUND_LAMPORTS, TOP_UP_MINIMUM_LAMPORTS } = await import(
    '../src/wallet-service.js'
  );
  const base = { initialized: true, requiredLamports: 60000000n, availableLamports: 1000000000n };
  // Below the float but able to fund a send: refill exactly the shortfall.
  assert.equal(topUpAmount({ ...base, feeLamports: 62000000n }), FEE_FLOAT_LAMPORTS - 62000000n);
  // Too little to fund the top-up send itself: it needs SOL from outside the wallet.
  assert.equal(topUpAmount({ ...base, feeLamports: 59000000n }), 0n);
  // Already at (or nearly at) the float: nothing to do.
  assert.equal(topUpAmount({ ...base, feeLamports: FEE_FLOAT_LAMPORTS - TOP_UP_MINIMUM_LAMPORTS + 1n }), 0n);
  // The wallet must cover the top-up plus that send's own fee refill.
  const shortfall = FEE_FLOAT_LAMPORTS - 62000000n;
  assert.equal(topUpAmount({ ...base, feeLamports: 62000000n, availableLamports: shortfall + FEE_REFUND_LAMPORTS - 1n }), 0n);
  assert.equal(topUpAmount({ ...base, feeLamports: 62000000n, availableLamports: shortfall + FEE_REFUND_LAMPORTS }), shortfall);
  assert.equal(topUpAmount({ ...base, initialized: false, feeLamports: 62000000n }), 0n);
});

test('receiptsOf reads SOL and token deliveries to this wallet only', async () => {
  const wallet = await key();
  const sender = await key();
  const ata = await key();
  const mint = await key();
  const keys = [sender, wallet, ata].map((k) => new PublicKey(k));
  const tx = (meta) => ({ transaction: { message: { staticAccountKeys: keys } }, meta: { err: null, ...meta } });
  assert.deepEqual(receiptsOf(tx({ preBalances: [9n, 0n, 0n], postBalances: [4n, 5000000000n, 0n] }), wallet), [
    { asset: 'SOL', amount: '5', from: sender },
  ]);
  assert.deepEqual(receiptsOf(tx({ preBalances: [9n, 7n, 0n], postBalances: [9n, 2n, 0n] }), wallet), []);
  assert.deepEqual(receiptsOf({ ...tx({ preBalances: [0n, 0n], postBalances: [0n, 9n] }), meta: { err: {}, preBalances: [0n, 0n], postBalances: [0n, 9n] } }, wallet), []);
  const balance = (amount, extra = {}) => ({ accountIndex: 2, mint, uiTokenAmount: { amount, decimals: 6 }, ...extra });
  const token = tx({
    preBalances: [1n, 1n, 1n],
    postBalances: [1n, 1n, 1n],
    preTokenBalances: [balance('1000000', { owner: wallet })],
    postTokenBalances: [balance('2250000', { owner: wallet })],
  });
  assert.deepEqual(receiptsOf(token, wallet), [{ asset: mint, amount: '1.25', from: sender }]);
  // A third party paying the fee is not the sender: whoever lost the SOL or tokens is.
  const relayer = await key();
  const relayed = { transaction: { message: { staticAccountKeys: [relayer, wallet, sender].map((k) => new PublicKey(k)) } }, meta: { err: null, preBalances: [10n, 0n, 9000000000n], postBalances: [5n, 1000000000n, 8000000000n] } };
  assert.deepEqual(receiptsOf(relayed, wallet), [{ asset: 'SOL', amount: '1', from: sender }]);
  const senderTokens = { accountIndex: 0, mint, owner: sender, uiTokenAmount: { amount: '3000000', decimals: 6 } };
  const relayedToken = tx({
    preTokenBalances: [senderTokens, balance('0', { owner: wallet })],
    postTokenBalances: [{ ...senderTokens, uiTokenAmount: { amount: '1000000', decimals: 6 } }, balance('2000000', { owner: wallet })],
  });
  assert.deepEqual(receiptsOf(relayedToken, wallet), [{ asset: mint, amount: '2', from: sender }]);
  // Older RPC responses omit the owner: an account the wallet holds still counts.
  const noOwner = tx({ preBalances: [], postBalances: [], postTokenBalances: [balance('5')] });
  assert.deepEqual(receiptsOf(noOwner, wallet, [ata]), [{ asset: mint, amount: '0.000005', from: sender }]);
  assert.deepEqual(receiptsOf(noOwner, wallet), []);
  assert.equal(formatUnits(10n, 0), '10');
  assert.equal(formatUnits(1200n, 3), '1.2');
  assert.equal(formatUnits(5n, 9), '0.000000005');
});

test('listReceipts lists incoming transfers and fetches each transaction once', async () => {
  const t = await setup();
  const sender = await key();
  const keys = [sender, t.d.wallet].map((k) => new PublicKey(k));
  t.chain.addHistory(t.d.wallet, { staticAccountKeys: keys }, 'in-1', { preBalances: [9n, 1n], postBalances: [4n, 1000000001n] });
  t.chain.addHistory(t.d.wallet, { staticAccountKeys: keys }, 'out-1', { preBalances: [9n, 9n], postBalances: [9n, 4n] });
  const feeKeys = [t.created.feePayer, t.d.wallet].map((k) => new PublicKey(k));
  t.chain.addHistory(t.d.wallet, { staticAccountKeys: feeKeys }, 'in-2', { preBalances: [9n, 0n], postBalances: [4n, 500000000n] });
  let fetched = 0;
  const getTransaction = t.chain.connection.getTransaction;
  t.chain.connection.getTransaction = async (...args) => {
    fetched++;
    return getTransaction(...args);
  };
  const list = await t.service.listReceipts();
  // Both land in the same second here, so compare without relying on their order.
  assert.deepEqual(list.map((r) => [r.signature, r.asset, r.amount, r.from, r.fromFeeAddress]).sort(), [
    ['in-1', 'SOL', '1', sender, false],
    ['in-2', 'SOL', '0.5', t.created.feePayer, true],
  ]);
  assert.equal(fetched, 3);
  await t.service.listReceipts();
  assert.equal(fetched, 3, 'cached transactions are not fetched again');
  // A send's own transactions are known from the journal and never fetched.
  const record = await t.service.prepareSend({ to: sender, amount: '0.01' });
  await edit(t.storage, record.id, (r) => r.records.push({ phase: 'prepared', label: 'begin-proof+upload-chunk', signature: 'mine-1' }));
  t.chain.addHistory(t.d.wallet, { staticAccountKeys: keys }, 'mine-1', { preBalances: [9n, 9n], postBalances: [9n, 9n] });
  assert.equal((await t.service.listReceipts()).length, 2);
  assert.equal(fetched, 3);
});

test('removeWallet refuses while a send holds a deposit, then clears keys, journal and history', async () => {
  const t = await setup();
  const { record } = await interruptedSend(t);
  await t.storage.local.set({ 'receipts:localnet:x': {} });
  const open = await t.service.unfinishedSends();
  assert.equal(open.count, 1);
  assert.ok(open.lamports > 0n);
  await assert.rejects(t.service.removeWallet(), /1 send is not finished/);
  assert.equal(await t.vault.exists(), true);
  await t.service.removeWallet({ evenWithUnfinished: true });
  assert.equal(await t.vault.exists(), false);
  assert.deepEqual(Object.keys(t.storage.local.dump()), ['settings']);
  assert.equal(await stored(t.storage, record.id), undefined);
});

test('a discarded send that someone else executes shows as sent', async () => {
  const t = await setup();
  const { record } = await interruptedSend(t);
  await edit(t.storage, record.id, (r) => (r.status = 'failed'));
  await t.service.discardSend(record.id);
  const message = new Transaction({ feePayer: new PublicKey(await key()), recentBlockhash: await key() })
    .add(executeInstruction(fromHex(record.intentHex), [new PublicKey(await key())]))
    .compileMessage();
  t.chain.addHistory(t.d.wallet, message, 'run-by-someone-else');
  await t.chain.setWallet(t.d, { nonce: 1n });
  await t.service.reclaimAbandoned();
  const after = await stored(t.storage, record.id);
  assert.equal(after.status, 'done');
  assert.equal(after.executeSignature, 'run-by-someone-else');
  assert.equal(after.executedElsewhere, true);
});

test('approve refuses an expiry set from a slot reported too far ahead', async () => {
  const t = await setup();
  t.chain.slot = 1000000n;
  const record = await t.service.prepareSend({ to: await key(), amount: '0.01' });
  t.chain.slot = 1000n;
  await assert.rejects(t.service.approve(record.id, record.digest), /expiry is further ahead/);
  assert.equal((await stored(t.storage, record.id)).approval ?? null, null);
});

test('createRecipientTokenAccount opens the recipient token account from the fee key, once', async () => {
  const t = await setup();
  const mint = await key();
  t.chain.accounts.set(mint, { lamports: 1461600n, executable: false, owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), data: new Uint8Array(82) });
  const to = await key();
  const made = await t.service.createRecipientTokenAccount({ to, mint });
  assert.equal(made.created, true);
  const { message } = t.chain.connection.sent.at(-1);
  const programs = message.compiledInstructions.map((ix) => message.staticAccountKeys[ix.programIdIndex].toBase58());
  assert.deepEqual(programs, ['ATokenGPvbdGVxr1b2hvZ9zbHQBhL1v8Tq9GZy3s3pVm']);
  assert.equal(message.staticAccountKeys[0].toBase58(), t.created.feePayer);
  // Already there: nothing is sent.
  t.chain.accounts.set(made.address, { lamports: 2039280n, executable: false, owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), data: new Uint8Array(165) });
  const sent = t.chain.connection.sent.length;
  assert.equal((await t.service.createRecipientTokenAccount({ to, mint })).created, false);
  assert.equal(t.chain.connection.sent.length, sent);
  // Never for a mint that is not a classic SPL token, or for a refused recipient.
  await assert.rejects(t.service.createRecipientTokenAccount({ to, mint: await key() }), /not a classic SPL token/);
  await assert.rejects(t.service.createRecipientTokenAccount({ to: t.d.wallet, mint }), /own address/);
});

test('recentRecipients lists delivered sends on this network, newest first, without the fee address', async () => {
  const t = await setup();
  const make = async (to, status, createdAt, cluster = 'localnet') => {
    const id = `r${Math.random().toString(16).slice(2)}`;
    await t.storage.local.set({ [`send:${id}`]: { id, cluster, status, createdAt, display: { to, asset: 'SOL', amount: '1' }, records: [] } });
  };
  const [a, b, c] = [await key(), await key(), await key()];
  await make(a, 'done', '2026-10-01T00:00:00Z');
  await make(b, 'done', '2026-10-03T00:00:00Z');
  await make(a, 'done', '2026-10-04T00:00:00Z');
  await make(c, 'failed', '2026-10-05T00:00:00Z');
  await make(c, 'done', '2026-10-06T00:00:00Z', 'devnet');
  await make(t.created.feePayer, 'done', '2026-10-07T00:00:00Z');
  assert.deepEqual((await t.service.recentRecipients()).map((r) => r.address), [a, b]);
});

test('corroborate: outcomes stand only when the reference endpoint agrees', async () => {
  assert.equal(await corroborate(null, { status: 'done', signature: 'x' }), true, 'no reference: nothing to check');
  const statuses = { good: { confirmationStatus: 'finalized', err: null }, failed: { confirmationStatus: 'finalized', err: {} }, pending: { confirmationStatus: 'processed', err: null } };
  const t = await setup();
  const reference = {
    getSignatureStatuses: async ([sig]) => ({ value: [statuses[sig] ?? null] }),
    getAccountInfo: (k) => t.chain.connection.getAccountInfo(k),
    getSlot: async () => 5000n,
  };
  assert.equal(await corroborate(reference, { status: 'done', signature: 'good' }), true);
  for (const sig of ['failed', 'pending', 'unknown']) assert.equal(await corroborate(reference, { status: 'done', signature: sig }), false, sig);
  // The live wallet is at nonce 0, epoch 0.
  assert.equal(await corroborate(reference, { status: 'superseded', wallet: t.d.wallet, nonce: 0n, epoch: 0n }), false);
  assert.equal(await corroborate(reference, { status: 'superseded', wallet: t.d.wallet, nonce: 3n, epoch: 0n }), true);
  assert.equal(await corroborate(reference, { status: 'expired', expiry: 6000n }), false);
  assert.equal(await corroborate(reference, { status: 'expired', expiry: 4000n }), true);
});

test('with a reference endpoint that cannot confirm it, a send is not marked sent until it does', async () => {
  const t = await setup();
  let confirms = false;
  const reference = {
    getSignatureStatuses: async (sigs) => ({ value: sigs.map(() => (confirms ? { confirmationStatus: 'finalized', err: null } : null)) }),
    getAccountInfo: (k) => t.chain.connection.getAccountInfo(k),
    getSlot: async () => t.chain.slot,
  };
  const service = createWalletService({ vault: t.vault, storage: t.storage, connect: () => t.chain.connection, referenceOverride: () => reference });
  const { record } = await interruptedSend(t);
  // The configured RPC reports this send's own execute transaction as confirmed.
  await edit(t.storage, record.id, (r) => r.records.push({ phase: 'confirmed', label: 'execute-wallet-transfer+reclaim-proof-rent', signature: 'exec-1' }));
  await service.reclaimAbandoned();
  let after = await stored(t.storage, record.id);
  assert.equal(after.status, 'submitting');
  assert.ok(after.approval, 'the signed approval is kept');
  assert.match(after.error, /do not agree/);
  confirms = true;
  await service.reclaimAbandoned();
  after = await stored(t.storage, record.id);
  assert.equal(after.status, 'done');
  assert.equal(after.executeSignature, 'exec-1');
});

test('with "ask for my passphrase" on, approve signs only with the right passphrase', async () => {
  const t = await setup();
  await t.storage.local.set({ settings: { ...(await t.storage.local.get('settings')).settings, confirmWithPassphrase: true } });
  const record = await t.service.prepareSend({ to: await key(), amount: '0.01' });
  await assert.rejects(t.service.approve(record.id, record.digest), /Enter your passphrase/);
  await assert.rejects(t.service.approve(record.id, record.digest, { passphrase: 'not the passphrase' }), /Wrong passphrase/);
  assert.equal((await stored(t.storage, record.id)).status, 'review', 'nothing signed');
  const signed = await t.service.approve(record.id, record.digest, { passphrase: pass });
  assert.equal(signed.status, 'signed');
});

test('overview lists Token-2022 balances marked as not sendable, and skips empty ones', async () => {
  const t = await setup();
  const parsed = (mint, amount) => ({
    pubkey: new PublicKey(mint),
    account: { data: { parsed: { info: { mint, tokenAmount: { amount, decimals: 0, uiAmountString: amount } } } } },
  });
  const [classic, extended, empty] = [await key(), await key(), await key()];
  t.chain.connection.getParsedTokenAccountsByOwner = async (_owner, { programId }) => ({
    value: programId.toBase58().startsWith('Tokenz') ? [parsed(extended, '7'), parsed(empty, '0')] : [parsed(classic, '5')],
  });
  const o = await t.service.overview();
  assert.deepEqual(o.tokens.map((x) => [x.mint, x.amount, Boolean(x.token2022)]), [
    [classic, '5', false],
    [extended, '7', true],
  ]);
});
