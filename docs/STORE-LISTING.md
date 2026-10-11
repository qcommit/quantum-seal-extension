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

- Send and receive SOL and classic SPL tokens, with a history of transfers in and out
- Review the exact transfer, including the total leaving your wallet, in the extension's own window before signing
- Interrupted sends resume from on-chain state; unclear outcomes are checked, never re-sent blindly
- Wrong-address protection: sends to your own wallet, programs, token mints or token accounts are stopped
- Sending tokens to someone new? Quantum Seal can open their token account for you
- Keys stay on your device, encrypted with your passphrase; auto-lock, and an optional passphrase check before every approval
- One encrypted backup file restores your wallet and its address in any browser
- No account, no analytics, no tracking

This version does not connect to dApps, and lists Token-2022 balances without sending them.

## Single purpose

Hold, send and receive Solana assets using post-quantum signatures.

## Permission justifications

- **storage:** encrypted keys, settings, a journal of sends so interrupted sends resume, and a cache of incoming transfers.
- **alarms:** auto-lock after the user's chosen idle period.
- **idle:** lock the wallet when the computer locks.
- **Host permissions (`api.mainnet-beta.solana.com`, `api.devnet.solana.com`):** read balances and submit user-approved transactions.
- No loopback access: the release build (`npm run package`) removes the `127.0.0.1`
  host permission and the local-validator network that development builds include.
- No optional permissions, no content scripts, no access to web pages. Minimum Chrome version 120.

## Data use disclosures

- Does not collect or transmit personal data to the developer.
- Website content, browsing history, location and personal communications: not accessed.
- Privacy policy URL: https://quantum-seal.vercel.app/privacy.html#extension (mirrors `PRIVACY.md`).

## Package

```sh
npm run package            # release build at CORE_REF, zipped; refuses until mainnet is pinned
npm run package -- --draft # same, for an unpinned mainnet (rehearsal only, never submit)
```

Writes `release/quantum-seal-extension-<version>.zip` and a `.sha256` next to it. The zip
holds `dist/` with `manifest.json` at the root and `build-info.json`, which records the
core commit and every file's hash. Upload that zip unchanged.

## Images

Regenerate with `node scripts/store-assets.mjs` (renders the real UI with fixture data,
mainnet variants, at 2x). Output in `store/`:

| File | Size | Use |
| --- | --- | --- |
| `assets/icon-128.png` | 128×128 | Store icon |
| `store/screenshot-1-approve.png` | 1280×800 | Review window: post-quantum approval |
| `store/screenshot-2-home.png` | 1280×800 | Home: balance, fee address, tokens |
| `store/screenshot-3-receive.png` | 1280×800 | Receive + sent transfer |
| `store/screenshot-4-private.png` | 1280×800 | Create wallet: keys stay on device |
| `store/promo-small-440x280.png` | 440×280 | Small promo tile |
| `store/promo-marquee-1400x560.png` | 1400×560 | Marquee (optional) |

Balances and addresses in the images are fixtures, not real wallets.

## Before submitting

1. Mainnet deployed, immutable, and pinned (`docs/LAUNCH.md` in the core repository, step 6).
2. `npm test`, `npm run build && npm run e2e` and `node e2e/release-smoke.mjs` pass, then
   `npm run package` (no `--draft`).
3. Privacy policy URL above still matches `PRIVACY.md`.
4. Version in `src/manifest.json` and `package.json` bumped for each upload, with an entry in
   `CHANGELOG.md`.
