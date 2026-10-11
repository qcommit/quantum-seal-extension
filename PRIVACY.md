# Quantum Seal extension: privacy policy

Last updated: October 11, 2026 (permissions narrowed)

**The short version:** the extension keeps your keys on your device, encrypted with your
passphrase. There is no Quantum Seal account, server, analytics or tracking. The only
network requests go to the Solana RPC endpoint you use.

## What the extension stores, and where

- **Your keys**, encrypted with your passphrase (scrypt + AES-256-GCM), in the
  extension's local storage on this browser profile.
- **While unlocked**, the decrypted keys in the browser's session storage, which is held
  in memory, limited to the extension's own pages, and cleared when the wallet locks
  (after the idle period you choose, when your computer locks, or when you press Lock)
  or when the browser quits. On macOS, closing every Chrome window does not quit Chrome.
- **Public wallet details** (wallet addresses, the network you chose, your settings) and a
  **journal of your sends** (the signed transfer, transaction signatures and progress), so
  interrupted sends can resume. These are public blockchain data.

Nothing is synced to any cloud service by the extension. Uninstalling the extension or
clearing its data deletes all of it, so keep a backup file.

## What leaves your device

- **Requests to the Solana RPC endpoint** you selected (by default the public Solana
  endpoints for mainnet or devnet): balance and account reads, and the transactions you
  approve. The RPC operator can see your IP address and the public addresses involved.
- **Transactions you approve** are published on the Solana blockchain, which is public.

The extension does not contact any Quantum Seal server, does not use analytics or
advertising, does not read web pages, and does not request access to your browsing
history. It does not inject anything into websites.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Keep the encrypted keys, settings and send journal. |
| `alarms` | Auto-lock after the idle period you choose. |
| `idle` | Lock when your computer locks. |
| Host access to `api.mainnet-beta.solana.com` and `api.devnet.solana.com` | Read balances and submit the transactions you approve. |
| Host access to `127.0.0.1` | Only for developers running a local Solana validator on their own computer. Nothing is sent there unless you choose the local network. |

The extension requests no other permissions, including no optional ones. A custom RPC
endpoint you enter in Settings is reached over HTTPS like any web request; the RPC
provider must allow it (CORS).
## Backups

The backup file you download contains your keys encrypted with your passphrase, plus
your public wallet addresses. Anyone with both the file and the passphrase controls the
wallet.

## Contact

Open an issue on the project's GitHub repository.
