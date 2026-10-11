# Extension security review (2026-10-11)

An automated reviewer with read access to the source reviewed the extension's own logic
(key vault, send journal, review window, network pinning, background worker, build). It
is not an independent third-party audit. The on-chain program has its own reviews in the
core repository (`docs/SECURITY-REVIEW.md` there).

Threat model: a malicious or compromised RPC endpoint, a malicious web page or other
extension, a person with brief access to the browser, races between the popup, review
windows and the background worker, and user mistakes.

No Critical or High findings. Confirmed by the review: everything the review window shows
comes from the stored intent bytes; `approve` re-checks the shown digest under the
per-send lock and signs only from `review`; the on-chain nonce prevents double execution;
the fee refund's recipient and size are checked before signing; backup descriptors are
rebuilt from the owner key before anything is stored; release builds carry no loopback
access.

| # | Severity | Finding | Resolution |
|---|---|---|---|
| M1 | Medium | A discarded send whose signed approval had already gone out in an upload transaction was shown as "Nothing was sent" and deleted, although anyone holding the chunks could still execute it until expiry. | Fixed. Such sends are kept and watched (`mayStillExecute`) until they expire or the nonce moves; if they were executed elsewhere they become "Sent". The review window says until about what time it could still run. Unit tests for both outcomes. |
| M2 | Medium | An approval's expiry had no upper bound at signing, so a custom RPC reporting a future slot at prepare time could produce an approval that becomes usable much later. | Fixed. `approve` refuses expiries beyond the 3,000-slot horizon (plus tolerance) of the current slot and, on mainnet with a custom RPC, of the reference endpoint's slot. Unit test. |
| L1 | Low | "Sent" / "Not sent" decisions rely on the configured RPC; the cross-check runs only before signing. | Fixed: with a custom mainnet RPC, every outcome (sent, superseded, expired, executed elsewhere) is recorded only once the public endpoint agrees (`corroborate`); until then the send keeps its signed approval and says the two endpoints disagree, and status checks of unclear sends ask the public endpoint. Unit tests for the check and for a send held back until the reference confirms it. |
| L2 | Low | `approve` read network settings twice, so the cross-check decision could use a different endpoint than the one that supplied slot and nonce. | Fixed: one settings snapshot. |
| L3 | Low | The wallet could be removed from the lock screen with one checkbox, even if never backed up. | Fixed: without a recorded backup, removal also needs "REMOVE" typed in. |
| L4 | Low | Removing the wallet ignored per-send locks. | Fixed: removal holds every send's lock and refuses while one is running. |
| L5 | Low | Received transfers named the fee payer as sender, scanned every token account (empty ones cost lookups), and cached results across RPC endpoints. | Fixed: the sender is whoever lost the SOL or tokens; only token accounts with a balance are scanned; the cache is per endpoint. Unit tests. |
| L6 | Low | Sends to unused program-derived addresses and to your own older-deployment wallets were allowed. | Fixed: both refused before signing. Unit tests. |
| I1 | Info (blocking) | Release builds could not load the wallet: availability looked up the local-validator network, which release builds remove. | Fixed, plus a stale local-validator setting now falls back. `e2e/release-smoke.mjs` builds the release and checks it opens, creates a wallet and reaches setup. |
| I2 | Info | The background message handler did not check the sender. | Fixed: only this extension's pages. |
| I3 | Info | While unlocked, secrets sit in session storage and JS memory; anyone at an unlocked browser can approve sends or export the encrypted backup. | Accepted, as in other browser wallets; auto-lock limits the window. Re-asking for the passphrase on mainnet approvals is a possible later option. |
| I4 | Info | RPC error details were shown verbatim. | Fixed: truncated and labelled as details. |
