import test from 'node:test';
import assert from 'node:assert/strict';
import { hasValidMainnetPins } from '../scripts/release-network.mjs';

const pinned = {
  rpc: 'https://api.mainnet-beta.solana.com',
  program: '6LBRd57jagVvhmpX1idsw9QXhoNHMHWstvpeGdSZAexT',
  programSha256: 'a'.repeat(64),
  programSize: 141888,
  upgradeAuthority: null,
};

test('packaging distinguishes an unconfigured draft from complete immutable mainnet pins', () => {
  assert.equal(hasValidMainnetPins({ ...pinned, program: null, programSha256: null, programSize: null }), false);
  assert.equal(hasValidMainnetPins(pinned), true);
});

test('packaging rejects partial or malformed pins instead of creating a store-labelled ZIP', () => {
  for (const change of [
    { programSha256: null }, { programSize: null }, { program: null },
    { programSha256: 'not-a-hash' }, { programSize: 0 }, { programSize: 1.5 },
    { program: 'invalid' }, { rpc: 'http://api.mainnet-beta.solana.com' },
    { upgradeAuthority: pinned.program },
  ]) assert.throws(() => hasValidMainnetPins({ ...pinned, ...change }), JSON.stringify(change));
});
