# Quantum Seal extension

A browser extension for Quantum Seal, the post-quantum wallet for Solana. Transfers
are approved with **SLH-DSA-SHA2-128s** (NIST FIPS 205) and checked on-chain by the
[wallet program](https://github.com/qcommit/quantum-seal-wallet) before any funds move.

**v1 is a send / receive / hold wallet.** It does not connect to dApps: dApps ask
wallets to sign ordinary Ed25519 transactions, and a Quantum Seal wallet can only act
through its own approved-transfer format. dApp support needs its own design.

## What it does

| Area | Behaviour |
| --- | --- |
| Keys | Creates a post-quantum owner key (SLH-DSA) and a small fee key (Ed25519). Both are encrypted with your passphrase (scrypt N=2^17 + AES-256-GCM) and stored in the extension. |
| Lock | Unlocked keys live only in `chrome.storage.session` (memory). Auto-lock after an idle period (default 15 minutes), when the computer locks, and on browser restart. |
| Setup | You fund one setup address once. The extension creates the wallet account on-chain, keeps 0.07 SOL on the fee key and moves the rest into the wallet. |
| Home | SOL balance, classic SPL token balances, recent sends, and the fee-key balance with a top-up prompt when it runs low. |
| Receive | The permanent wallet address with a QR code. |
| Send | SOL or classic SPL tokens. The decoded transfer is shown in the extension's own window before signing. Signing takes about a second; progress is shown through the ~16 transactions. |
| Fees | You pay network fees from the fee key. Each send carries a signed fee refund (85,000 lamports) that the wallet pays back to the fee key, so it stays topped up. |
| Interruptions | Each send is journaled. Closing the window or losing the network resumes from on-chain state with the same signed approval; an unclear outcome is checked by signature before anything continues. Nothing is re-signed. |
| Backup | Downloads the encrypted keys plus the public wallet descriptors. The owner key in the backup also opens with the core command line. |
| Settings | Network (mainnet once released, devnet, local validator), RPC endpoint, auto-lock time. Mainnet deployment pins are fixed by the release. |

Every chain write goes through the core SDK, which re-verifies the deployed program's
bytes against the pinned SHA-256 before each transaction and refuses mutable programs
on mainnet.

## Build and test

Requires Node 24 and a checkout of `quantum-seal-wallet` next to this repository.

```sh
npm ci
npm run build          # writes dist/, load it as an unpacked extension
npm test               # vault, backup and network-pin unit tests
npm run e2e            # full flow against a local validator in Chromium
```

`npm run e2e` starts `solana-test-validator` (Agave 3.1.10) with the wallet program and
drives the built extension through: create, fund, on-chain setup, receive, a SOL send
that is interrupted mid-upload and resumed, an SPL token send, lock and unlock with a
wrong passphrase, backup download, and auto-lock set through Settings (14 steps). `e2e/devnet-smoke.mjs` runs create, setup and a
send against the public devnet deployment, with a funded devnet key supplied via
`QS_DEVNET_FUNDER` (kept outside the repository).

## Status

- Devnet: built in (`6LBRd57jagVvhmpX1idsw9QXhoNHMHWstvpeGdSZAexT`).
- Mainnet: available once the reviewed, immutable program is deployed and its address,
  hash and size are pinned in `src/networks.js`.
- Not yet listed on the Chrome Web Store. See [docs/STORE-LISTING.md](docs/STORE-LISTING.md)
  and [PRIVACY.md](PRIVACY.md).
- Not independently audited.

MIT licensed.
