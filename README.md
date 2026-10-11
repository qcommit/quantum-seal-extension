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
| Lock | Unlocked keys live only in `chrome.storage.session` (memory). The service worker arms the auto-lock alarm whenever the wallet unlocks (default 15 idle minutes); it also locks when the computer locks and on browser restart. |
| Setup | You fund one setup address once. The extension creates the wallet account on-chain, keeps 0.07 SOL on the fee key and moves the rest into the wallet. Setup resumes if interrupted, and SOL that later lands on the fee address can be moved into the wallet from Home. |
| Home | SOL balance, Receive and Send, classic SPL token balances, and the fee-key status with a top-up prompt when it runs low. An Activity tab lists every send with its status. |
| Receive | The wallet address with a QR code, in a bottom sheet. Each network's address is derived from the owner key and the pinned deployment, so a backup always recovers it. Test networks show a persistent "Test network" banner. |
| Send | SOL or classic SPL tokens. The fee key's balance is checked before review. The review window decodes the intent bytes; approving signs only if the stored bytes still have the digest the window showed and the wallet, program, network, fee refill and expiry check out. Signing takes about a second; progress is shown through the 12 transactions. |
| Fees | You pay network fees from the fee key. Each send carries a signed fee refill (65,000 lamports) that the wallet pays back to the fee key, so it stays topped up. If it falls below its 0.07 SOL float but can still fund a send, Home offers **Top up from wallet**: a sealed transfer from the wallet to your own fee key, reviewed like any send. Only if it cannot fund even one send does it need SOL from outside. |
| Interruptions | Each send is journaled under its own storage key and runs under a Web Lock, so it is approved once and run by one window at a time. Closing the window or losing the network resumes from on-chain state with the same signed approval; an unclear outcome is checked by signature before anything continues. Nothing is re-signed. A send is marked sent only on evidence of its execute transaction; if the wallet moved on without it, it is shown as "Not sent". |
| Deposits | A send whose approval can no longer run (superseded, expired or discarded) has its proof account closed, so the rent deposit returns to the fee key. The popup does this for leftover sends each time it opens. |
| Backup | Downloads the encrypted keys plus the public wallet descriptors. On restore, every descriptor must be a wallet owned by the backup's key alone (threshold 1, no guardian); anything else is refused. The owner key in the backup also opens with the core command line. |
| Settings | Network is picked from the header (mainnet once released, devnet, local validator). Settings holds the RPC endpoint, auto-lock time, developer pins for test networks, backup and lock. Mainnet deployment pins are fixed by the release. |

Every chain write goes through the core SDK, which re-verifies the deployed program's
bytes against the pinned SHA-256 before each transaction and refuses mutable programs
on mainnet.

## Build and test

The UI is React 19 (JSX compiled by esbuild in `scripts/build.mjs`) with Inter Variable
bundled from `@fontsource-variable/inter` as local font files. The popup is 400x600; the
review window is its own page. Pages run under the manifest's strict CSP: no inline
scripts or styles, no remote code; the build refuses HTML with inline scripts.

Requires Node 24 and a checkout of `quantum-seal-wallet` next to this repository at the
commit pinned in `CORE_REF` (CI checks out exactly that commit).

```sh
npm ci --ignore-scripts
npm run build          # writes dist/, load it as an unpacked extension
npm run build -- --release   # refuses unless the core checkout is clean and at CORE_REF
npm test               # unit tests: vault, backups, descriptors, sends against a fake chain, auto-lock
npm run e2e            # full flow against a local validator in Chromium
```

`dist/build-info.json` records the core commit, the package-lock hash and a SHA-256 of
every shipped file. The SDK's crypto libraries (`@noble/*`) are bundled from this
repository's pinned versions.

`npm run e2e` starts `solana-test-validator` (Agave 3.1.10) with the wallet program and
drives the built extension through: create, fund, on-chain setup, receive, a SOL send
that is interrupted mid-upload and resumed, an SPL token send, lock and unlock with a
wrong passphrase, backup download, an injected RPC failure that leaves a send
"uncertain" until it is checked and resumed, two sends at the same nonce where the
superseded one is reported "Not sent" and its proof deposit reclaimed, and auto-lock set
through Settings (17 steps). `e2e/devnet-smoke.mjs` runs create, setup and a
send against the public devnet deployment, with a funded devnet key supplied via
`QS_DEVNET_FUNDER` (kept outside the repository). `QS_E2E_SHOTS=1 npm run e2e` also
saves a screenshot of each screen it reaches to `.runtime/shots/`.

`node e2e/visual.mjs` is a visual check, not a wallet test: it bundles the real popup and
review components against fixture data (`e2e/visual/fake-common.js` replaces
`src/ui/common.js`; no chain, vault or extension storage) and screenshots about fifty
states the chain e2e cannot easily reach, such as a low fee address, every Activity
status, a failed send and the restore form, to `.runtime/shots/visual/`. With
`QS_AXE=/path/to/axe.min.js` it also runs axe-core (WCAG 2.1 A/AA) on every state. Pass
a pattern to render only some states: `node e2e/visual.mjs '^review'`.

## Status

- Devnet: built in (`6LBRd57jagVvhmpX1idsw9QXhoNHMHWstvpeGdSZAexT`).
- Mainnet: available once the reviewed, immutable program is deployed. Pin it with
  `node scripts/pin-deployment.mjs --cluster mainnet-beta --program <ADDRESS> --binary
  ../quantum-seal-wallet/target/deploy/seal_wallet.so`, which verifies the deployment
  on-chain (exact bytes, immutable) before writing `src/networks.js`.
- Not yet listed on the Chrome Web Store. See [docs/STORE-LISTING.md](docs/STORE-LISTING.md)
  and [PRIVACY.md](PRIVACY.md).
- Not independently audited.

MIT licensed.
