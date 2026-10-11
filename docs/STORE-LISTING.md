# Chrome Web Store listing (draft)

Not submitted. Submit only after the mainnet program is deployed and pinned in
`src/networks.js`, so store users can use mainnet.

## Basics

- **Name:** Quantum Seal
- **Summary (132 chars max):** A post-quantum Solana wallet. Every transfer is approved with SLH-DSA, NIST's hash-based signature standard.
- **Category:** Productivity → Tools (wallets are listed under Productivity)
- **Language:** English

## Description

Quantum Seal is a Solana wallet built for the quantum era. Your Solana address is
normally an Ed25519 public key, and a large enough quantum computer could turn that
public key into your private key. Quantum Seal approves every transfer with SLH-DSA
(NIST FIPS 205), a hash-based signature, and the wallet program checks it on-chain before
any funds move.

- Send and receive SOL and classic SPL tokens
- Review the exact transfer in the extension's own window before signing
- Your wallet address on each network is derived from your key, so a backup always recovers it
- Keys stay on your device, encrypted with your passphrase
- No account, no analytics, no tracking

Version 1 does not connect to dApps.

## Single purpose

Hold, send and receive Solana assets using post-quantum signatures.

## Permission justifications

- **storage:** encrypted keys, settings and a journal of sends so interrupted sends resume.
- **alarms:** auto-lock after the user's chosen idle period.
- **idle:** lock the wallet when the computer locks.
- **Host permissions (`api.mainnet-beta.solana.com`, `api.devnet.solana.com`):** read balances and submit user-approved transactions.
- **Host permission (`127.0.0.1`):** developers can point the wallet at a local Solana validator; nothing is sent there unless the user selects the local network.
- No optional permissions, no content scripts, no access to web pages. Minimum Chrome version 120.

## Data use disclosures

- Does not collect or transmit personal data to the developer.
- Website content, browsing history, location and personal communications: not accessed.
- Privacy policy: `PRIVACY.md` (host it at a public URL before submission, e.g. on the website).

## Assets to prepare

- 128×128 icon: `assets/icon-128.png`
- At least one 1280×800 screenshot (home, review, receive)
- 440×280 promotional tile
