// What the review window shows comes from the signed intent bytes, not from the unsigned
// fields the popup stored next to them. Anything the intent cannot vouch for (the token
// recipient's wallet address) is checked against the intent before it is shown.
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM } from 'quantum-seal-wallet/instructions';
import { GENESIS } from 'quantum-seal-wallet/network';

export const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZ9zbHQBhL1v8Tq9GZy3s3pVm');

export function formatUnits(amount, decimals) {
  const n = BigInt(amount);
  const base = 10n ** BigInt(decimals);
  const whole = n / base;
  const frac = decimals ? (n % base).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return frac ? `${whole}.${frac}` : `${whole}`;
}

// Summarises a decoded intent (quantum-seal-wallet/codec decodeIntent) for display.
// kind: 'sol' | 'token' | 'unknown'. problems lists reasons not to approve.
export function describeIntent(intent, { cluster } = {}) {
  const a = intent.action;
  const problems = [];
  const base = {
    wallet: intent.wallet.toBase58(),
    genesis: intent.genesis.toBase58(),
    program: intent.program.toBase58(),
    expiry: intent.expiry.toString(),
    nonce: intent.nonce.toString(),
    fee: intent.fee ? { to: intent.fee.to.toBase58(), lamports: intent.fee.lamports } : null,
    problems,
  };
  if (cluster && GENESIS[cluster] && GENESIS[cluster] !== base.genesis)
    problems.push('This approval is for a different network than the one it was prepared on.');

  if (a.kind === 'transfer')
    return { ...base, kind: 'sol', amount: formatUnits(a.lamports, 9), unit: 'SOL', to: a.to.toBase58() };

  // A classic SPL Token TransferChecked: [12, amount u64 LE, decimals] with accounts
  // source, mint, destination, wallet (signer).
  const data = a.kind === 'invoke' ? a.data : null;
  if (
    data &&
    a.program.equals(TOKEN_PROGRAM) &&
    data.length === 10 &&
    data[0] === 12 &&
    a.metas.length === 4 &&
    a.metas[3].key.equals(intent.wallet)
  ) {
    const amount = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(1, true);
    const decimals = data[9];
    return {
      ...base,
      kind: 'token',
      amount: formatUnits(amount, decimals),
      decimals,
      source: a.metas[0].key.toBase58(),
      mint: a.metas[1].key.toBase58(),
      destination: a.metas[2].key.toBase58(),
    };
  }
  problems.push('This approval is not a SOL or token transfer this wallet recognises.');
  return { ...base, kind: 'unknown' };
}

// The associated token account the intent must pay into for `owner` to receive `mint`.
export async function tokenAccountFor(owner, mint) {
  const [ata] = await PublicKey.findProgramAddress(
    [new PublicKey(owner).toBytes(), TOKEN_PROGRAM.toBytes(), new PublicKey(mint).toBytes()],
    ASSOCIATED_TOKEN_PROGRAM,
  );
  return ata.toBase58();
}
