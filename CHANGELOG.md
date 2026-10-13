# Changelog

Store uploads need a higher `version` in `src/manifest.json` (and `package.json`) each
time; add an entry here for every upload.

## 0.1.0-devnet.1 — public Chrome developer preview

- QuantumPocket is the public product name. Existing Quantum Seal backup formats,
  signature domains and protocol identifiers are unchanged.
- Published MIT-licensed core and extension source, an installable devnet ZIP,
  installation instructions and SHA-256 checksum. Chrome Web Store publication
  and mainnet activation remain pending.
- Release packages include complete notices for their bundled dependencies.
- Verified with 78 unit tests, 26 actual local-validator browser steps and an
  installation smoke test of the published ZIP. Interrupted-transfer recovery
  checks all 11 successful uploads and every uploaded signature byte on-chain.

- A requested backup download keeps the reminder until the user confirms the file
  was saved. Confirmation is tied to the exported encrypted keys, so a changed wallet
  or passphrase cannot acknowledge an older backup as current.
- Wallet and settings loading failures offer retry instead of leaving a spinner.
  Removal stays disabled until backup and unfinished-send checks succeed, and refreshes
  its confirmation if their state changes.
- Published approvals remain watched after discard and rent reclamation. Custom-RPC
  expiry and nonce changes need reference confirmation before the watch ends.
- Review creation and wallet removal coordinate across windows; stale preparations
  cannot recreate a send journal after its wallet was removed or replaced.

## 0.1.0 (first store release, not yet submitted)

The first version of QuantumPocket for Chrome: a post-quantum Solana wallet that holds,
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
- **Safety.** Auto-lock, an optional passphrase check before every approval, backup reminder until a backup is saved, change passphrase,
  remove the wallet from the browser (also "Forgot passphrase?" on the lock screen, which
  leads to restoring a backup).
- **Networks.** Mainnet (once pinned by the release) and devnet; custom RPC endpoints,
  cross-checked against the public endpoint before signing on mainnet.
- Alt+Shift+Q opens the wallet. Not in this version: connecting to dApps.
