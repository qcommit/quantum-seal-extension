// Well-known mainnet tokens, matched by exact mint address only. Names from on-chain
// metadata are never shown: anyone can create a token that calls itself "USDC".
const KNOWN = {
  'mainnet-beta': {
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', name: 'USD Coin' },
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', name: 'Tether USD' },
    So11111111111111111111111111111111111111112: { symbol: 'wSOL', name: 'Wrapped SOL' },
  },
};

export function knownToken(cluster, mint) {
  return KNOWN[cluster]?.[mint] ?? null;
}
// A short label for a token: its symbol when known, otherwise the shortened mint.
export function tokenLabel(cluster, mint, n = 4) {
  return knownToken(cluster, mint)?.symbol ?? `${mint.slice(0, n)}…${mint.slice(-n)}`;
}
