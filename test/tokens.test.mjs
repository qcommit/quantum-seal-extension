import test from 'node:test';
import assert from 'node:assert/strict';
import { knownToken, tokenLabel } from '../src/tokens.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

test('known tokens are named on mainnet only, by exact mint', () => {
  assert.equal(knownToken('mainnet-beta', USDC).symbol, 'USDC');
  assert.equal(tokenLabel('mainnet-beta', USDC), 'USDC');
  // The same address on a test network is not mainnet USDC.
  assert.equal(knownToken('devnet', USDC), null);
  assert.equal(tokenLabel('devnet', USDC), 'EPjF…Dt1v');
  assert.equal(tokenLabel('mainnet-beta', USDC.slice(0, -1) + 'w', 5), 'EPjFW…TDt1w');
});
