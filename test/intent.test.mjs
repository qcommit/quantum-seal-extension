import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { encodeIntent, decodeIntent } from 'quantum-seal-wallet/codec';
import { tokenTransferAction } from 'quantum-seal-wallet/instructions';
import { GENESIS } from 'quantum-seal-wallet/network';
import { describeIntent, formatUnits, tokenAccountFor } from '../src/intent.js';

const key = async () => (await Keypair.generate()).publicKey.toBase58();
async function intent(action, { genesis = GENESIS.devnet, fee = null, wallet } = {}) {
  return decodeIntent(
    encodeIntent({
      genesis,
      program: await key(),
      wallet: wallet ?? (await key()),
      epoch: 0n,
      nonce: 7n,
      expiry: 1234n,
      action,
      fee,
    }),
  );
}

test('formatUnits prints exact decimal amounts', () => {
  assert.equal(formatUnits(250000000n, 9), '0.25');
  assert.equal(formatUnits(1500000n, 6), '1.5');
  assert.equal(formatUnits(42n, 0), '42');
  assert.equal(formatUnits(1n, 9), '0.000000001');
});

test('a SOL transfer is described from the signed intent', async () => {
  const to = await key();
  const feeTo = await key();
  const d = describeIntent(
    await intent({ kind: 'transfer', to, lamports: 250000000n }, { fee: { to: feeTo, lamports: 65000n } }),
    { cluster: 'devnet' },
  );
  assert.equal(d.kind, 'sol');
  assert.equal(d.amount, '0.25');
  assert.equal(d.to, to);
  assert.deepEqual(d.fee, { to: feeTo, lamports: 65000n });
  assert.equal(d.nonce, '7');
  assert.deepEqual(d.problems, []);
});

test('a token transfer is decoded from TransferChecked data, not from stored fields', async () => {
  const wallet = await key();
  const owner = await key();
  const mint = await key();
  const destination = await tokenAccountFor(owner, mint);
  const action = tokenTransferAction({ source: await key(), mint, destination, wallet, amount: 1500000n, decimals: 6 });
  const d = describeIntent(await intent(action, { wallet }), { cluster: 'devnet' });
  assert.equal(d.kind, 'token');
  assert.equal(d.amount, '1.5');
  assert.equal(d.mint, mint);
  assert.equal(d.destination, destination);
  assert.deepEqual(d.problems, []);
});

test('unknown actions and a genesis from another network are flagged', async () => {
  const other = await intent({ kind: 'transfer', to: await key(), lamports: 1n }, { genesis: GENESIS['mainnet-beta'] });
  assert.equal(describeIntent(other, { cluster: 'devnet' }).problems.length, 1);
  const wallet = await key();
  const odd = await intent(
    { kind: 'invoke', program: await key(), metas: [{ key: wallet, writable: false, signer: true }], data: Uint8Array.of(1) },
    { wallet },
  );
  const d = describeIntent(odd, { cluster: 'devnet' });
  assert.equal(d.kind, 'unknown');
  assert.match(d.problems.join(' '), /not a SOL or token transfer/);
});
