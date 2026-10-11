import test from 'node:test';
import assert from 'node:assert/strict';
import { friendlyMessage, errorText } from '../src/errors.js';

test('common SDK and RPC errors read as plain language', () => {
  const cases = [
    ['Expected base58-encoded address string of length in the range [32, 44]. Actual length: 3.', /not a valid Solana address/],
    ['Invalid public key input', /not a valid Solana address/],
    ['Use a positive decimal amount without signs or exponent notation.', /digits and a dot, like 0\.5/],
    ['Fee payer cannot cover the conservative proof-rent and fee budget.', /fee address does not hold enough SOL/],
    ['Insufficient wallet balance after retaining the rent reserve.', /0\.000065 SOL/],
    ['Transfer would leave the recipient below its rent-exempt minimum.', /at least 0\.00089088 SOL/],
    ['Insufficient SOL in the wallet for the fee refund.', /Token sends need at least 0\.000065 SOL/],
    ['Wallet execution lock is set.', /busy/],
    ['Approval is expired, replayed, or for another cluster/policy epoch.', /can no longer run/],
    ['Simulation rejected upload-chunk: {"InstructionError":[1,{"Custom":6}]}', /rejected a transaction \(upload-chunk\) in simulation, so it was not sent\. Details: \{"InstructionError"/],
    ['Failed to fetch', /Could not reach the Solana RPC/],
    ['Invalid URL', /not a valid URL/],
  ];
  for (const [raw, expected] of cases) assert.match(friendlyMessage(raw), expected, raw);
});

test('messages already written for people pass through unchanged', () => {
  for (const text of ['Unable to unlock keystore.', 'Passphrases do not match.', 'Confirmation timed out: 5abc'])
    assert.equal(friendlyMessage(text), text);
  assert.equal(errorText(new Error('Passphrases do not match.')), 'Passphrases do not match.');
  assert.equal(errorText('plain'), 'plain');
});
