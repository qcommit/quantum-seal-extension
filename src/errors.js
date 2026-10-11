// Plain-language versions of the errors users meet most often. Messages the extension
// already writes for people pass through unchanged.
const RULES = [
  [
    /^Expected base58-encoded address|^Invalid public key input|Non-base58 character/,
    () => 'That is not a valid Solana address.',
  ],
  [
    /^Use a positive decimal amount without signs or exponent notation\.$/,
    () => 'Enter the amount with digits and a dot, like 0.5.',
  ],
  [/^Amount must be greater than zero\.$/, () => 'Enter an amount greater than zero.'],
  [
    /^Fee payer cannot cover the conservative proof-rent and fee budget\.$/,
    () =>
      'Your fee address does not hold enough SOL to start this send. Top it up (see Home), then resume.',
  ],
  [
    /^Insufficient wallet balance after retaining the rent reserve\.$/,
    () =>
      'Not enough SOL. Each send also refills your fee address with 0.000065 SOL, and the wallet keeps a small rent reserve.',
  ],
  [
    /^Insufficient SOL in the wallet for the fee refund\.$|^Insufficient spendable SOL for the fee refund\.$/,
    () => 'Token sends need at least 0.000065 SOL in the wallet to refill your fee address.',
  ],
  [
    /^Transfer would leave the recipient below its rent-exempt minimum\.$/,
    () => 'A new Solana address must receive at least 0.00089088 SOL.',
  ],
  [/^Insufficient token balance\.$/, () => 'Not enough of this token in the wallet.'],
  [/^Self-transfers are not supported\.$/, () => 'That is this wallet’s own address.'],
  [
    /^Wallet execution lock is set\.$/,
    () =>
      'The wallet account is marked busy by an unfinished on-chain operation. Try again in a minute.',
  ],
  [
    /^Approval is expired, replayed, or for another cluster\/policy epoch\.$|^Approval is stale or expired\.$/,
    () => 'This approval can no longer run: it expired, or the wallet has sent something else since.',
  ],
  [
    /exceeded CUs meter|computational budget exceeded/i,
    () =>
      'One step needed more compute than the network allows, so it was not sent. Resume to try again, or Discard to get the deposit back.',
  ],
  [
    /^Simulation rejected ([^:]+): (.*)$/s,
    (m) =>
      `The network rejected a transaction (${m[1]}) in simulation, so it was not sent. Details: ${m[2]}`,
  ],
  [
    /^Failed to fetch$|^NetworkError|^fetch failed|ECONNREFUSED|aborted due to timeout/,
    () => 'Could not reach the Solana RPC endpoint. Check your connection or the RPC endpoint in Settings.',
  ],
  [/^Invalid URL$|Failed to construct 'URL'/, () => 'The RPC endpoint in Settings is not a valid URL.'],
];

export function friendlyMessage(message) {
  const text = String(message ?? '');
  for (const [pattern, render] of RULES) {
    const m = text.match(pattern);
    if (m) return render(m);
  }
  return text;
}

export function errorText(error) {
  return friendlyMessage(error?.message ?? error);
}
