# Changelog

Store uploads need a higher `version` in `src/manifest.json` (and `package.json`) each
time; add an entry here for every upload.

## 0.1.0 (first store release, not yet submitted)

The first version of Quantum Seal for Chrome: a post-quantum Solana wallet that holds,
sends and receives SOL and classic SPL tokens.

- **Wallet.** A post-quantum owner key (SLH-DSA, FIPS 205) and a small Ed25519 fee key,
  created and encrypted on the device (scrypt + AES-256-GCM). One funding transfer sets
  the wallet up on-chain.
- **Send.** A separate review window decodes the signed transfer (recipient, amount,
  network, total from wallet, fee refill) before signing. Progress through upload,
  on-chain verification and execution; interrupted sends resume from on-chain state, and
  unclear outcomes are checked, never re-sent blindly. Recent recipients; obvious wrong
  recipients are refused; token sends to a new holder can open their token account.
- **Home and Activity.** Balances, fee-address status with top-up and sweep, mainnet
  names for USDC, USDT and wrapped SOL, sends with their status, and incoming transfers
  read from chain history.
- **Safety.** Auto-lock, backup reminder until a backup is saved, change passphrase,
  remove the wallet from the browser (also "Forgot passphrase?" on the lock screen, which
  leads to restoring a backup).
- **Networks.** Mainnet (once pinned by the release) and devnet; custom RPC endpoints,
  cross-checked against the public endpoint before signing on mainnet.
- Alt+Shift+Q opens the wallet. Not in this version: connecting to dApps.
