// Wallet operations for the extension, built on the core SDK. Every chain write goes
// through the SDK's pinned-deployment checks; sends are journaled so an interrupted
// send resumes from on-chain state instead of being signed or submitted again.
//
// Journal: each send is stored under its own key (`send:<id>`), so pages never overwrite
// each other's records, and every state change of one send happens under a Web Lock
// named after it, so it is approved at most once and executed by one page at a time.
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { openNetwork, rateLimitedFetch } from 'quantum-seal-wallet/network';
import {
  walletStatus,
  initializeWallet,
  prepareSolTransfer,
  prepareTokenTransfer,
  executeApprovals,
  executionCost,
  parseUnits,
} from 'quantum-seal-wallet/wallet';
import { signApproval, parseApproval } from 'quantum-seal-wallet/approval';
import { decodeIntent, decodeWallet, intentDigest, deriveProof, hex, fromHex, PROOF_BYTES } from 'quantum-seal-wallet/codec';
import { closeProofInstruction, TOKEN_PROGRAM } from 'quantum-seal-wallet/instructions';
import { submit } from 'quantum-seal-wallet/client';
import { BUILT_IN, deploymentFor, networkConfig, isAvailable, mergeSettings } from './networks.js';
import { ownDescriptor, verifyOwnDescriptor, verifyOwnState } from './descriptors.js';
import { describeIntent, tokenAccountFor, ASSOCIATED_TOKEN_PROGRAM } from './intent.js';
import { withLock, LockBusy } from './locks.js';
import { errorText } from './errors.js';

export const SEND_PREFIX = 'send:';
// Journals written by earlier versions: one map of every send under this key.
export const LEGACY_SENDS_KEY = 'sends';
export const SETTINGS_KEY = 'settings';
// Cached incoming-transfer results, one key per network and wallet.
const RECEIPTS_PREFIX = 'receipts:';
// How many recent transactions per account Activity looks through for incoming transfers.
// A sealed send adds about a dozen to the wallet's history; those are skipped unfetched.
const RECEIPT_LOOKBACK = 50;
// The SDK labels the executing transaction "execute-wallet-transfer+reclaim-proof-rent".
export const EXECUTE_LABEL = 'execute-wallet-transfer';
// Each send reimburses the fee key from the wallet (12 transactions x 5,000 lamports
// plus a small margin), so its float stays topped up.
export const FEE_REFUND_LAMPORTS = 65000n;
// Float kept on the fee key: one proof account's rent (refunded after each send) plus fees.
export const FEE_FLOAT_LAMPORTS = 70000000n;
// Fee-key SOL above the float is offered for moving into the wallet from this amount on.
export const SWEEP_MINIMUM_LAMPORTS = 10000000n;
// An approval must stay valid at least this many slots (about a minute) after signing.
export const APPROVE_MARGIN_SLOTS = 150n;
// How far a custom mainnet RPC's slot may drift from the default endpoint's before signing.
export const RPC_SLOT_TOLERANCE = 300n;
// Approvals are prepared to expire this many slots (about 20 minutes) ahead (the SDK default).
export const EXPIRY_HORIZON_SLOTS = 3000n;

// A custom mainnet RPC could report a fake slot or wallet nonce to collect an approval that
// becomes usable later (a future nonce, or an expiry far beyond the real slot). Before
// signing on mainnet with a custom endpoint, both are confirmed against an independent one.
export async function crossCheckRpc({ reference, wallet, intent, slot }) {
  const [refSlot, account] = await Promise.all([
    reference.getSlot('confirmed'),
    reference.getAccountInfo(new PublicKey(wallet), 'confirmed'),
  ]);
  const drift = BigInt(refSlot) > slot ? BigInt(refSlot) - slot : slot - BigInt(refSlot);
  if (drift > RPC_SLOT_TOLERANCE)
    throw new Error(
      'Your custom RPC reports a different network time than the public Solana endpoint. Nothing was signed. Check the RPC in Settings.',
    );
  const state = account ? decodeWallet(Uint8Array.from(account.data)) : null;
  if (!state || state.nonce !== intent.nonce || state.epoch !== intent.epoch)
    throw new Error(
      'Your custom RPC reports different wallet state than the public Solana endpoint. Nothing was signed. Check the RPC in Settings.',
    );
  return BigInt(refSlot);
}
// Finished sends kept in the journal; unfinished ones are never dropped.
export const MAX_FINISHED_SENDS = 200;
export const SUPERSEDED_TEXT = 'Not sent: the wallet moved on, so this approval can no longer execute.';
export const EXPIRED_TEXT = 'Not sent: this approval expired before it could run.';

const FINISHED = ['done', 'superseded', 'expired'];
const UNFINISHED_SIGNED = ['signed', 'submitting', 'failed', 'uncertain'];
const sendKey = (id) => `${SEND_PREFIX}${id}`;
export const isSendKey = (key) => key.startsWith(SEND_PREFIX);

// Polls signature status instead of relying on a WebSocket subscription, which some
// RPC providers restrict. Fails closed with the signature if the blockhash expires or the
// deadline passes.
export async function confirmByPolling(connection, signature, lastValidBlockHeight, commitment, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = (
      await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
    ).value[0];
    if (status?.err) throw new Error(`Transaction failed: ${signature}`);
    if (
      status &&
      (status.confirmationStatus === 'finalized' ||
        (commitment === 'confirmed' && status.confirmationStatus === 'confirmed'))
    )
      return status;
    if (!status && (await connection.getBlockHeight(commitment)) > lastValidBlockHeight)
      throw new Error(`Transaction expired without confirmation: ${signature}`);
    if (Date.now() > deadline) throw new Error(`Confirmation deadline exceeded: ${signature}`);
    await new Promise((r) => setTimeout(r, commitment === 'confirmed' ? 400 : 1500));
  }
}

export function lamportsToSol(value) {
  const n = BigInt(value);
  const whole = n / 1000000000n,
    frac = (n % 1000000000n).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

// The signature of this send's own confirmed, successful execute transaction, if any.
export function executeSignature(record) {
  const own = record.records?.find(
    (r) => r.phase === 'confirmed' && r.label.includes(EXECUTE_LABEL) && !r.error,
  );
  return own?.signature ?? record.executeSignature ?? null;
}
// True once any transaction that opens this send's proof account may have been sent.
function mayHaveProof(record) {
  return (record.records ?? []).some((r) => r.label.includes('begin-proof'));
}
// A discarded send whose signed approval already went out in an upload transaction: anyone
// holding those chunks could still execute it until it expires or the wallet's nonce moves,
// so it is watched (and shown as possibly executing) until one of those happens.
export function mayStillExecute(record) {
  return (
    record.status === 'discarded' &&
    record.watchSettled !== true &&
    (record.records ?? []).some((r) => r.phase === 'prepared')
  );
}
// Sends that will never execute through their own proof, but whose proof deposit may
// still sit in a proof account.
export function needsReclaim(record) {
  const abandoned =
    ['superseded', 'expired', 'discarded'].includes(record.status) ||
    (record.status === 'done' && record.executedElsewhere);
  return abandoned && record.reclaimed !== true && mayHaveProof(record);
}
// Does this confirmed transaction execute exactly this intent with the wallet program?
export function executesIntent(tx, program, intentHex) {
  const message = tx?.transaction?.message;
  if (!message) return false;
  const keys = message.staticAccountKeys ?? message.accountKeys ?? [];
  return (message.compiledInstructions ?? []).some((ix) => {
    const id = keys[ix.programIdIndex];
    const data = Uint8Array.from(ix.data ?? []);
    return id?.toBase58?.() === program && data[0] === 5 && hex(data.subarray(2)) === intentHex;
  });
}
function parseAddress(value, what = 'address') {
  try {
    return new PublicKey(String(value ?? '').trim());
  } catch {
    throw new Error(what === 'address' ? 'That is not a valid Solana address.' : `That is not a valid ${what}.`);
  }
}
// Raw token units as a decimal string (no rounding): 1250000 with 6 decimals -> "1.25".
export function formatUnits(raw, decimals) {
  const digits = BigInt(raw).toString().padStart(decimals + 1, '0');
  if (!decimals) return digits;
  const frac = digits.slice(-decimals).replace(/0+$/, '');
  return frac ? `${digits.slice(0, -decimals)}.${frac}` : digits.slice(0, -decimals);
}
// What a transaction delivered to this wallet: SOL into the wallet account and tokens into
// accounts it owns, each as one entry. Outgoing or unchanged balances give nothing.
export function receiptsOf(tx, wallet, ownedTokenAccounts = []) {
  const meta = tx?.meta;
  if (!meta || meta.err) return [];
  const message = tx.transaction?.message ?? {};
  const keys = [
    ...(message.staticAccountKeys ?? message.accountKeys ?? []),
    ...(meta.loadedAddresses?.writable ?? []),
    ...(meta.loadedAddresses?.readonly ?? []),
  ].map((k) => (typeof k === 'string' ? k : (k.pubkey ?? k).toBase58()));
  // The sender is whoever lost the most of what arrived (not just the fee payer, which
  // anyone can be); a mint or other source with no loser falls back to the fee payer.
  const payer = keys[0] ?? null;
  const out = [];
  const i = keys.indexOf(wallet);
  if (i >= 0 && meta.preBalances?.[i] !== undefined && meta.postBalances?.[i] !== undefined) {
    const delta = BigInt(meta.postBalances[i]) - BigInt(meta.preBalances[i]);
    if (delta > 0n) {
      let from = payer,
        most = 0n;
      keys.forEach((k, j) => {
        if (j === i || meta.preBalances[j] === undefined || meta.postBalances[j] === undefined) return;
        const lost = BigInt(meta.preBalances[j]) - BigInt(meta.postBalances[j]);
        if (lost > most) [from, most] = [k, lost];
      });
      out.push({ asset: 'SOL', amount: lamportsToSol(delta), from });
    }
  }
  const owned = new Set(ownedTokenAccounts);
  const mine = (b) => b.owner === wallet || owned.has(keys[b.accountIndex]);
  for (const post of meta.postTokenBalances ?? []) {
    if (!mine(post)) continue;
    const pre = (meta.preTokenBalances ?? []).find((b) => b.accountIndex === post.accountIndex);
    const delta = BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount.amount ?? '0');
    if (delta <= 0n) continue;
    let from = payer,
      most = 0n;
    for (const before of meta.preTokenBalances ?? []) {
      if (before.mint !== post.mint || mine(before)) continue;
      const after = (meta.postTokenBalances ?? []).find((b) => b.accountIndex === before.accountIndex);
      const lost = BigInt(before.uiTokenAmount.amount) - BigInt(after?.uiTokenAmount.amount ?? '0');
      if (lost > most) [from, most] = [before.owner ?? keys[before.accountIndex] ?? payer, lost];
    }
    out.push({ asset: post.mint, amount: formatUnits(delta, post.uiTokenAmount.decimals), from });
  }
  return out;
}

export const NEEDS_TOKEN_ACCOUNT = 'needs-token-account';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const MINT_BYTES = 82;
const TOKEN_ACCOUNT_BYTES = 165;
// Catches the usual wrong-address mistakes before anything is signed: this wallet's own
// address (or an older one of yours), a program, an unused address nobody can sign for,
// or a token mint or token account pasted where a wallet belongs.
async function checkRecipient(connection, network, recipient, wallet, ownWallets = []) {
  const address = recipient.toBase58();
  if (address === wallet)
    throw new Error('That is this wallet’s own address. Enter the address you want to send to.');
  if (ownWallets.includes(address))
    throw new Error(
      'That is an older wallet of yours from an earlier version of the Quantum Seal program, which this version cannot move funds out of. Enter another address.',
    );
  const info = await connection.getAccountInfo(recipient, network.commitment);
  if (!info) {
    // Unused addresses are fine when a key controls them; an unused off-curve address
    // (a program-derived one) has nobody who could ever sign to move what lands there.
    if (!PublicKey.isOnCurve(recipient.toBytes()))
      throw new Error(
        'Nobody holds a key for that address and it has no account yet, so funds sent there could be lost. Check the recipient address.',
      );
    return;
  }
  if (info.executable) throw new Error('That address is a program, not a wallet. Check the recipient address.');
  const owner = info.owner?.toBase58?.() ?? String(info.owner);
  if (owner !== TOKEN_PROGRAM.toBase58() && owner !== TOKEN_2022) return;
  const data = info.data ?? new Uint8Array(0);
  // Token-2022 mints with extensions are longer; their account-type byte follows the base layout.
  const mint = data.length === MINT_BYTES || (data.length > TOKEN_ACCOUNT_BYTES && data[TOKEN_ACCOUNT_BYTES] === 1);
  throw new Error(
    mint
      ? 'That address is a token mint, not a wallet. Check the recipient address.'
      : 'That address is a token account, not a wallet. Send to the owner’s wallet address instead.',
  );
}
// The token account to send from: the wallet's associated token account when it holds
// enough, otherwise the account with the largest balance.
export function pickTokenSource(accounts, associated, needed) {
  const largest = accounts.reduce((a, b) => (b.amount > a.amount ? b : a));
  const preferred = accounts.find((a) => a.address === associated);
  return preferred && needed !== null && preferred.amount >= needed ? preferred : largest;
}
const label = (cluster) => BUILT_IN[cluster]?.label ?? cluster;

// Refilling the fee key from the wallet is itself a sealed send, so it is offered only when
// the fee key can still fund one send (proof deposit + fees) and is meaningfully below its
// float, and the wallet can pay the top-up plus that send's own fee refill.
export const TOP_UP_MINIMUM_LAMPORTS = 5000000n;
export function topUpAmount({ initialized, feeLamports, requiredLamports, availableLamports }) {
  if (!initialized || feeLamports < requiredLamports) return 0n;
  const shortfall = FEE_FLOAT_LAMPORTS - feeLamports;
  if (shortfall < TOP_UP_MINIMUM_LAMPORTS) return 0n;
  return availableLamports >= shortfall + FEE_REFUND_LAMPORTS ? shortfall : 0n;
}

export function createWalletService({
  vault,
  storage,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  // For tests: (config) => connection. Defaults to a web3.js Connection.
  connect,
}) {
  let cached = null;

  async function settings() {
    return mergeSettings((await storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]);
  }
  async function session() {
    const s = await settings();
    const deployment = deploymentFor(s);
    const config = networkConfig(deployment);
    const key = JSON.stringify(config);
    if (cached?.key === key) return cached.value;
    const connection = connect
      ? connect(config)
      : new Connection(config.rpc, {
          commitment: config.cluster === 'localnet' ? 'confirmed' : 'finalized',
          disableRetryOnRateLimit: true,
          fetch: rateLimitedFetch(fetchImpl),
        });
    const network = await openNetwork(config, connection);
    cached = { key, value: { network, connection, deployment, settings: s } };
    return cached.value;
  }
  async function ownerInfo() {
    const info = await vault.publicInfo();
    if (!info) throw new Error('No wallet in this browser profile.');
    return info;
  }
  // The wallet for the current deployment. A stored descriptor is used only after it is
  // rebuilt from its salt and the vault's own key; otherwise a new one is derived from the
  // key (deterministic salt) and added next to any earlier deployment's descriptor.
  async function descriptor() {
    const { network, deployment } = await session();
    const info = await ownerInfo();
    const list = info.descriptors[deployment.cluster] ?? [];
    const stored = list.find((d) => d.program === network.program && d.genesis === network.genesis);
    if (stored) return verifyOwnDescriptor(stored, info.ownerPublicKey, `stored ${deployment.label}`);
    const created = await ownDescriptor(info.ownerPublicKey, network.program, network.genesis);
    await vault.addDescriptor(deployment.cluster, created);
    return created;
  }
  // walletStatus, plus: an initialized wallet's live policy must be the vault key alone.
  async function ownStatus(network, d) {
    const info = await ownerInfo();
    const status = await walletStatus(network, d);
    if (status.initialized) verifyOwnState(status.state, info.ownerPublicKey);
    return status;
  }

  // ---- Journal ----
  async function migrate() {
    if (!(await storage.local.get(LEGACY_SENDS_KEY))[LEGACY_SENDS_KEY]) return;
    await withLock('journal-migrate', async () => {
      const legacy = (await storage.local.get(LEGACY_SENDS_KEY))[LEGACY_SENDS_KEY];
      if (!legacy) return;
      const entries = Object.fromEntries(Object.values(legacy).map((r) => [sendKey(r.id), r]));
      if (Object.keys(entries).length) await storage.local.set(entries);
      await storage.local.remove(LEGACY_SENDS_KEY);
    });
  }
  async function allSends() {
    await migrate();
    const all = await storage.local.get(null);
    return Object.entries(all)
      .filter(([k]) => isSendKey(k))
      .map(([, v]) => v);
  }
  async function openSends() {
    return (await allSends()).filter((r) => UNFINISHED_SIGNED.includes(r.status) || needsReclaim(r));
  }
  async function getSend(id) {
    await migrate();
    return (await storage.local.get(sendKey(id)))[sendKey(id)] ?? null;
  }
  async function saveSend(record) {
    await storage.local.set({ [sendKey(record.id)]: record });
    return record;
  }
  async function removeSend(id) {
    await storage.local.remove(sendKey(id));
  }
  // Keeps the newest MAX_FINISHED_SENDS finished sends. Unfinished sends, and finished
  // ones whose proof deposit is still open, are never dropped.
  async function prune() {
    const finished = (await allSends())
      .filter((r) => FINISHED.includes(r.status) && !needsReclaim(r))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const drop = finished.slice(MAX_FINISHED_SENDS).map((r) => sendKey(r.id));
    if (drop.length) await storage.local.remove(drop);
  }
  function finish(record, status, extra = {}) {
    Object.assign(record, { status, error: null, ...extra });
    // A finished send can never be resumed; its approval (about 10 KB) is no longer needed.
    if (FINISHED.includes(status) || status === 'discarded') record.approval = null;
    return record;
  }

  // A send runs only on the network and wallet it was prepared for.
  async function sendContext(record) {
    const s = await session();
    const d = await descriptor();
    if (record.cluster !== s.deployment.cluster)
      throw new Error(
        `This send was prepared on ${label(record.cluster)}. Switch the network to ${label(record.cluster)} to continue it.`,
      );
    if (record.wallet !== d.wallet || (record.program && record.program !== s.network.program))
      throw new Error(
        `This send belongs to a different ${label(record.cluster)} wallet (another deployment). It cannot be continued with the current settings.`,
      );
    return { ...s, d };
  }

  // Search the wallet's recent history for a transaction that executed this exact intent
  // (execute is permissionless once a proof is verified, so anyone holding the uploaded
  // signature could have run it).
  async function findExecution(network, record) {
    // The signature is public only once one of this send's upload transactions was sent.
    if (!record.records.some((r) => r.phase === 'prepared')) return null;
    const { connection, commitment } = network;
    const since = Date.parse(record.createdAt) / 1000 - 300;
    const own = new Set(record.records.filter((r) => !r.label.includes(EXECUTE_LABEL)).map((r) => r.signature));
    const list = await connection.getSignaturesForAddress(new PublicKey(record.wallet), { limit: 200 }, commitment);
    for (const s of list) {
      if (s.blockTime && Number(s.blockTime) < since) break;
      if (s.err || own.has(s.signature)) continue;
      const tx = await connection.getTransaction(s.signature, { commitment, maxSupportedTransactionVersion: 0 });
      if (tx && !tx.meta?.err && executesIntent(tx, network.program, record.intentHex)) return s.signature;
    }
    return null;
  }

  // Decides what happened to a signed send that did not (or may not) finish, from
  // evidence only: its own execute transaction, or the wallet's nonce and history.
  async function settle(record, network, d) {
    const own = executeSignature(record);
    if (own) return finish(record, 'done', { executeSignature: own, reclaimed: true });
    const { connection, commitment } = network;
    const prepared = record.records.filter((r) => r.phase === 'prepared' && r.label.includes(EXECUTE_LABEL));
    if (prepared.length) {
      const statuses = (
        await connection.getSignatureStatuses(
          prepared.map((r) => r.signature),
          { searchTransactionHistory: true },
        )
      ).value;
      const i = statuses.findIndex(
        (s) =>
          s &&
          !s.err &&
          (s.confirmationStatus === 'finalized' || (commitment === 'confirmed' && s.confirmationStatus === 'confirmed')),
      );
      // The execute transaction also closed this send's proof account.
      if (i >= 0) return finish(record, 'done', { executeSignature: prepared[i].signature, reclaimed: true });
    }
    const status = await walletStatus(network, d);
    if (!status.initialized) return record;
    const intent = decodeIntent(fromHex(record.intentHex));
    if (status.state.nonce !== intent.nonce || status.state.epoch !== intent.epoch) {
      const found = await findExecution(network, record);
      if (found) return finish(record, 'done', { executeSignature: found, executedElsewhere: true });
      return finish(record, 'superseded', { error: SUPERSEDED_TEXT });
    }
    const slot = BigInt(await connection.getSlot(commitment));
    if (intent.expiry < slot) return finish(record, 'expired', { error: EXPIRED_TEXT });
    return record;
  }

  // Closes this send's proof account (created by the fee key) and returns its rent to
  // the fee key. Safe at any stage: the program lets the uploader close its own proof.
  // For a watched discarded send: did someone execute it after all, or can it no longer run?
  async function settleDiscarded(record, network, d) {
    const intent = decodeIntent(fromHex(record.intentHex));
    const status = await walletStatus(network, d);
    if (status.initialized && (status.state.nonce !== intent.nonce || status.state.epoch !== intent.epoch)) {
      const found = await findExecution(network, record);
      if (found) return finish(record, 'done', { executeSignature: found, executedElsewhere: true });
      record.watchSettled = true;
      return record;
    }
    const slot = BigInt(await network.connection.getSlot(network.commitment));
    if (intent.expiry < slot) record.watchSettled = true;
    return record;
  }
  async function reclaim(record, network) {
    if (!mayHaveProof(record)) {
      record.reclaimed = true;
      return record;
    }
    const payer = await vault.feeKeypair();
    const digest = intentDigest(fromHex(record.intentHex));
    const { proof } = await deriveProof(network.program, record.wallet, digest, 0, payer.publicKey);
    const account = await network.connection.getAccountInfo(proof, network.commitment);
    if (account && account.owner.toBase58() === network.program) {
      const receipt = await submit(
        network.connection,
        payer,
        [closeProofInstruction({ program: network.program, proof, uploader: payer.publicKey })],
        {
          network,
          label: 'close-proof',
          onRecord: async (event) => {
            record.records.push(event);
            await saveSend(record);
          },
        },
      );
      record.reclaimSignature = receipt.signature;
      record.reclaimedLamports = String(account.lamports);
    }
    record.reclaimed = true;
    record.reclaimError = null;
    return record;
  }
  async function tryReclaim(record, network) {
    try {
      await reclaim(record, network);
    } catch (error) {
      record.reclaimError = errorText(error);
    }
  }

  // Moves fee-key SOL above the float into the (initialized) wallet.
  async function sweepFeeKey(keepLamports) {
    const { network, connection } = await session();
    const d = await descriptor();
    const status = await ownStatus(network, d);
    if (!status.initialized) throw new Error('Create the wallet first.');
    const payer = await vault.feeKeypair();
    const balance = BigInt(await connection.getBalance(payer.publicKey, network.commitment));
    const latest = await connection.getLatestBlockhash(network.commitment);
    const transfer = (lamports) =>
      new Transaction({ feePayer: payer.publicKey, recentBlockhash: latest.blockhash }).add(
        SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey(d.wallet), lamports }),
      );
    const quoted = (await connection.getFeeForMessage(transfer(1n).compileMessage(), network.commitment))?.value;
    const fee = quoted === null || quoted === undefined ? 5000n : BigInt(quoted);
    if (balance <= keepLamports + fee) return { sweptLamports: 0n, sweepSignature: null };
    const swept = balance - keepLamports - fee;
    const tx = transfer(swept);
    await tx.sign(payer);
    const sweepSignature = await connection.sendRawTransaction(await tx.serialize(), {
      preflightCommitment: network.commitment,
    });
    await confirmByPolling(connection, sweepSignature, latest.lastValidBlockHeight, network.commitment);
    return { sweptLamports: swept, sweepSignature };
  }

  return {
    session,
    descriptor,
    async availability() {
      const s = await settings();
      return Object.fromEntries(
        Object.keys(BUILT_IN).map((c) => [c, isAvailable(deploymentFor(s, c))]),
      );
    },

    async overview() {
      const { network, connection, deployment } = await session();
      const d = await descriptor();
      const info = await ownerInfo();
      const status = await ownStatus(network, d);
      const feePayer = new PublicKey(info.feePayer);
      const feeLamports = BigInt(await connection.getBalance(feePayer, network.commitment));
      const tokens = [];
      if (status.initialized) {
        const parsed = await connection.getParsedTokenAccountsByOwner(
          new PublicKey(d.wallet),
          { programId: TOKEN_PROGRAM },
          network.commitment,
        );
        for (const { pubkey, account } of parsed.value) {
          const t = account.data.parsed?.info;
          if (!t) continue;
          tokens.push({
            account: pubkey.toBase58(),
            mint: t.mint,
            amount: t.tokenAmount.amount,
            decimals: t.tokenAmount.decimals,
            uiAmount: t.tokenAmount.uiAmountString,
          });
        }
      }
      // Wallets of earlier deployments on this network (e.g. before a re-pin) that still
      // hold SOL: they stay listed so their funds are not forgotten.
      const otherWallets = [];
      for (const other of info.descriptors[deployment.cluster] ?? []) {
        if (other.wallet === d.wallet || other.genesis !== network.genesis) continue;
        try {
          await verifyOwnDescriptor(other, info.ownerPublicKey);
        } catch {
          continue;
        }
        const lamports = BigInt(await connection.getBalance(new PublicKey(other.wallet), network.commitment));
        if (lamports > 0n) otherWallets.push({ wallet: other.wallet, program: other.program, lamports });
      }
      const cost = await executionCost(network, 1);
      const sweepable =
        status.initialized && feeLamports >= FEE_FLOAT_LAMPORTS + SWEEP_MINIMUM_LAMPORTS
          ? feeLamports - FEE_FLOAT_LAMPORTS
          : 0n;
      return {
        cluster: deployment.cluster,
        label: deployment.label,
        isTestNetwork: deployment.cluster !== 'mainnet-beta',
        wallet: d.wallet,
        initialized: status.initialized,
        balanceLamports: status.balanceLamports,
        availableLamports: status.availableLamports,
        reserveLamports: status.reserveLamports,
        // A SOL send also moves the fee refill out of the wallet.
        maxSendableLamports:
          status.availableLamports > FEE_REFUND_LAMPORTS ? status.availableLamports - FEE_REFUND_LAMPORTS : 0n,
        feePayer: info.feePayer,
        feeLamports,
        // Enough for one proof account plus fees; below this a send cannot start.
        feeNeededLamports: cost.requiredPayerLamports,
        // Fee-key SOL above the float, e.g. left over from an interrupted setup.
        sweepableLamports: sweepable,
        // Fee-key SOL missing from the float that the wallet can refill with a sealed send.
        topUpLamports: topUpAmount({
          initialized: status.initialized,
          feeLamports,
          requiredLamports: cost.requiredPayerLamports,
          availableLamports: status.availableLamports,
        }),
        otherWallets,
        tokens,
      };
    },

    // Prepares a sealed transfer from the wallet to the user's own fee key that brings it
    // back to its float. It goes through the same review window as any send.
    async topUpFeeKey() {
      const o = await this.overview();
      if (!o.topUpLamports)
        throw new Error(
          o.feeLamports < o.feeNeededLamports
            ? `Your fee address needs SOL from outside the wallet first: send at least ${lamportsToSol(o.feeNeededLamports - o.feeLamports)} SOL to ${o.feePayer}.`
            : 'Your fee address is already topped up.',
        );
      return this.prepareSend({ asset: 'SOL', to: o.feePayer, amount: lamportsToSol(o.topUpLamports) });
    },

    // One-address onboarding: the user funds the fee key once; this creates the wallet
    // account and moves everything above the fee float into the wallet. Resumable: an
    // already-created wallet is not created again, and only the sweep runs.
    async setupWallet({ keepLamports = FEE_FLOAT_LAMPORTS } = {}) {
      const { network } = await session();
      const d = await descriptor();
      const payer = await vault.feeKeypair();
      const init = await initializeWallet(network, payer, d);
      await ownStatus(network, d);
      let sweep;
      try {
        sweep = await sweepFeeKey(keepLamports);
      } catch (error) {
        if (init.alreadyInitialized) throw error;
        throw new Error(
          `Wallet created; moving your SOL into it failed (${errorText(error)}). Use “Move to wallet” on Home to try again.`,
        );
      }
      return {
        initialized: !init.alreadyInitialized,
        initializeSignature: init.receipt?.signature ?? null,
        ...sweep,
      };
    },
    // Moves fee-key SOL above the float into the wallet (after an interrupted setup, or
    // SOL sent to the fee address later).
    async sweepExcess({ keepLamports = FEE_FLOAT_LAMPORTS } = {}) {
      return sweepFeeKey(keepLamports);
    },

    async prepareSend({ asset = 'SOL', to, amount, mint }) {
      const { network, connection } = await session();
      const d = await descriptor();
      const info = await ownerInfo();
      const recipient = parseAddress(to);
      const status = await ownStatus(network, d);
      if (!status.initialized) throw new Error('Create the wallet first.');
      const ownWallets = (info.descriptors[network.cluster] ?? []).map((x) => x.wallet);
      await checkRecipient(connection, network, recipient, d.wallet, ownWallets);
      // A send needs one proof deposit plus fees on the fee key; say so before signing.
      const cost = await executionCost(network, 1);
      const feeLamports = BigInt(await connection.getBalance(new PublicKey(info.feePayer), network.commitment));
      if (feeLamports < cost.requiredPayerLamports)
        throw new Error(
          `Your fee address needs ${lamportsToSol(cost.requiredPayerLamports - feeLamports)} SOL more before you can send. Send SOL to ${info.feePayer}, then try again.`,
        );
      const feeRefund = { to: info.feePayer, lamports: FEE_REFUND_LAMPORTS };
      let prepared, display;
      if (asset === 'SOL') {
        prepared = await prepareSolTransfer(network, d, { to: recipient.toBase58(), amount, feeRefund });
        display = { asset: 'SOL', amount, to: recipient.toBase58() };
      } else {
        if (!mint) throw new Error('Choose a token to send.');
        const mintKey = parseAddress(mint, 'token mint address');
        const parsed = await connection.getParsedTokenAccountsByOwner(
          new PublicKey(d.wallet),
          { mint: mintKey },
          network.commitment,
        );
        const accounts = parsed.value.map(({ pubkey, account }) => ({
          address: pubkey.toBase58(),
          amount: BigInt(account.data.parsed?.info?.tokenAmount?.amount ?? '0'),
          decimals: account.data.parsed?.info?.tokenAmount?.decimals,
        }));
        if (!accounts.length) throw new Error('This wallet holds no account for that token.');
        let needed = null;
        try {
          needed = parseUnits(String(amount), accounts[0].decimals ?? 0);
        } catch {
          /* the SDK reports the amount problem below */
        }
        const source = pickTokenSource(accounts, await tokenAccountFor(d.wallet, mintKey.toBase58()), needed);
        const destination = await tokenAccountFor(recipient.toBase58(), mintKey.toBase58());
        if (!(await connection.getAccountInfo(new PublicKey(destination), network.commitment))) {
          // The Send page offers to create it (createRecipientTokenAccount), then prepares again.
          const error = new Error('The recipient has no account for this token yet.');
          error.code = NEEDS_TOKEN_ACCOUNT;
          error.rentLamports = BigInt(await connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_BYTES));
          throw error;
        }
        prepared = await prepareTokenTransfer(network, d, {
          source: source.address,
          mint: mintKey.toBase58(),
          destination,
          amount,
          feeRefund,
        });
        display = { asset: mintKey.toBase58(), amount, to: recipient.toBase58(), decimals: prepared.decimals };
      }
      const intent = decodeIntent(prepared.bytes);
      const id = hex(globalThis.crypto.getRandomValues(new Uint8Array(12)));
      return saveSend({
        id,
        cluster: network.cluster,
        program: network.program,
        genesis: network.genesis,
        wallet: d.wallet,
        feePayer: info.feePayer,
        createdAt: new Date().toISOString(),
        status: 'review',
        intentHex: hex(prepared.bytes),
        digest: hex(intentDigest(prepared.bytes)),
        display,
        nonce: intent.nonce.toString(),
        expiry: intent.expiry.toString(),
        feeRefundLamports: FEE_REFUND_LAMPORTS.toString(),
        refundableRentLamports: cost.refundableProofRentLamports.toString(),
        approval: null,
        records: [],
        error: null,
      });
    },

    // Signing happens only from the review window, after the user approved what it showed.
    // shownDigest is the digest of the intent bytes the window decoded and displayed; the
    // stored bytes are decoded again here and every field the wallet controls is checked.
    async approve(id, shownDigest) {
      return withLock(`send:${id}`, async () => {
        const record = await getSend(id);
        if (!record) throw new Error('This send no longer exists.');
        if (record.status !== 'review') throw new Error('This send was already approved or closed.');
        const bytes = fromHex(record.intentHex);
        if (!shownDigest || shownDigest !== hex(intentDigest(bytes)))
          throw new Error(
            'The transfer changed after this review window opened. Nothing was signed. Close it and review the send again.',
          );
        // One settings snapshot for the whole decision: the connection that supplies the
        // slot and nonce is the one whose endpoint decides whether to cross-check.
        const { network, deployment, d } = await sendContext(record);
        const info = await ownerInfo();
        const intent = decodeIntent(bytes);
        const view = describeIntent(intent, { cluster: record.cluster });
        const problems = [...view.problems];
        if (view.wallet !== d.wallet) problems.push('It spends from a wallet that is not yours.');
        if (view.program !== network.program || view.genesis !== network.genesis)
          problems.push('It is for another program or network.');
        if (!view.fee || view.fee.to !== info.feePayer || view.fee.lamports > FEE_REFUND_LAMPORTS)
          problems.push('Its fee refill does not go to your own fee address, or is larger than expected.');
        if (problems.length)
          throw new Error(`This approval does not match your wallet. ${problems.join(' ')} Nothing was signed.`);
        const status = await ownStatus(network, d);
        if (!status.initialized || status.state.nonce !== intent.nonce || status.state.epoch !== intent.epoch) {
          await saveSend(finish(record, 'expired', { error: 'Not signed: the wallet has sent something else since this review was prepared.' }));
          throw new Error('This review is out of date: the wallet has sent something else since. Nothing was signed. Prepare the send again.');
        }
        const slot = BigInt(await network.connection.getSlot(network.commitment));
        const slots = [slot];
        if (network.cluster === 'mainnet-beta' && deployment.rpc !== BUILT_IN['mainnet-beta'].rpc) {
          const refConfig = { ...networkConfig({ ...deployment, rpc: BUILT_IN['mainnet-beta'].rpc }) };
          const reference = connect
            ? connect(refConfig)
            : new Connection(refConfig.rpc, { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: rateLimitedFetch(fetchImpl) });
          slots.push(await crossCheckRpc({ reference, wallet: d.wallet, intent, slot }));
        }
        // An expiry set from a slot reported too far ahead would make this approval usable
        // later than the user expects: refuse anything beyond the normal horizon.
        if (slots.some((s) => intent.expiry > s + EXPIRY_HORIZON_SLOTS + RPC_SLOT_TOLERANCE)) {
          await saveSend(finish(record, 'expired', { error: 'Not signed: its expiry was set too far ahead.' }));
          throw new Error(
            'This review’s expiry is further ahead than expected, so the RPC may have reported a wrong time. Nothing was signed. Check the RPC in Settings and prepare the send again.',
          );
        }
        if (intent.expiry <= slot + APPROVE_MARGIN_SLOTS) {
          await saveSend(finish(record, 'expired', { error: 'Not signed: this review expired before it was approved.' }));
          throw new Error('This review expired before you approved it. Nothing was signed. Prepare the send again.');
        }
        const secret = await vault.ownerSecret();
        try {
          record.approval = signApproval(bytes, secret, 0);
        } finally {
          secret.fill(0);
        }
        record.status = 'signed';
        record.signedAt = new Date().toISOString();
        return saveSend(record);
      });
    },

    // Runs (or resumes) a signed send. Waits if another page is running it; that run's
    // outcome is then returned.
    async execute(id, onProgress = () => {}) {
      return withLock(`send:${id}`, async () => {
        const record = await getSend(id);
        if (!record) throw new Error('This send no longer exists.');
        if (FINISHED.includes(record.status) || record.status === 'discarded') return record;
        if (!record.approval) throw new Error('Send is not signed.');
        const { network, d } = await sendContext(record);
        const payer = await vault.feeKeypair();
        record.status = 'submitting';
        record.error = null;
        await saveSend(record);
        const onRecord = async (event) => {
          record.records.push(event);
          await saveSend(record);
          onProgress(event, record);
        };
        try {
          const result = await executeApprovals(network, payer, d, [record.approval], { onRecord });
          // The execute transaction closed the proof account and refunded its rent.
          finish(record, 'done', { executeSignature: result.receipt.signature, reclaimed: true });
          record.cleanupErrors = result.cleanupErrors;
        } catch (error) {
          record.error = error.message;
          record.uncertainSignature = error.signature ?? null;
          record.status = error.name === 'SubmissionUncertain' ? 'uncertain' : 'failed';
          try {
            await settle(record, network, d);
          } catch {
            /* keep the original error */
          }
        }
        if (needsReclaim(record)) await tryReclaim(record, network);
        await saveSend(record);
        await prune();
        return record;
      });
    },

    // For "uncertain" sends: look up the recorded signature before anything is retried.
    async checkUncertain(id) {
      const record = await getSend(id);
      if (!record?.uncertainSignature) return null;
      const { connection } = await sendContext(record);
      const status = (
        await connection.getSignatureStatuses([record.uncertainSignature], {
          searchTransactionHistory: true,
        })
      ).value[0];
      return status
        ? { found: true, confirmation: status.confirmationStatus, err: status.err ?? null }
        : { found: false };
    },

    // Popup open: settle signed sends nobody is running (another page holding a send's
    // lock is running it) and close the proof accounts of sends that will never execute,
    // so their deposits return to the fee key. Only sends of the current network and
    // wallet are touched. Returns how many deposits were reclaimed.
    async reclaimAbandoned() {
      const { network, deployment } = await session();
      const d = await descriptor();
      let reclaimed = 0,
        slot = null;
      for (const candidate of await allSends()) {
        if (candidate.cluster !== deployment.cluster || candidate.wallet !== d.wallet) continue;
        // A review window closed without a decision: once its intent expires, say so.
        if (candidate.status === 'review') {
          slot ??= BigInt(await network.connection.getSlot(network.commitment));
          if (BigInt(candidate.expiry) < slot)
            await withLock(`send:${candidate.id}`, async () => {
              const record = await getSend(candidate.id);
              if (record?.status === 'review')
                await saveSend(finish(record, 'expired', { error: 'Not signed: this review expired before it was approved.' }));
            }, { ifAvailable: true }).catch(() => {});
          continue;
        }
        if (!UNFINISHED_SIGNED.includes(candidate.status) && !needsReclaim(candidate) && !mayStillExecute(candidate))
          continue;
        try {
          await withLock(
            `send:${candidate.id}`,
            async () => {
              const record = await getSend(candidate.id);
              if (!record) return;
              if (UNFINISHED_SIGNED.includes(record.status) && record.approval) await settle(record, network, d);
              if (mayStillExecute(record)) await settleDiscarded(record, network, d);
              if (needsReclaim(record)) {
                await tryReclaim(record, network);
                if (record.reclaimSignature && record.reclaimed) reclaimed++;
              }
              if (record.status === 'discarded' && !needsReclaim(record) && !mayStillExecute(record))
                return removeSend(record.id);
              await saveSend(record);
            },
            { ifAvailable: true },
          );
        } catch (error) {
          if (!(error instanceof LockBusy)) throw error;
        }
      }
      await prune();
      return { reclaimed };
    },

    // Incoming transfers from chain history: SOL into the wallet and tokens into its token
    // accounts, newest first. Each transaction is fetched once and its result cached per
    // wallet, so reopening Activity costs only the history lookups.
    async listReceipts() {
      const { network, connection, deployment } = await session();
      const d = await descriptor();
      const status = await ownStatus(network, d);
      if (!status.initialized) return [];
      const { commitment } = network;
      const wallet = new PublicKey(d.wallet);
      // Only accounts holding a balance: anyone can open empty token accounts for this
      // wallet, and each would cost history lookups.
      const tokenAccounts = (
        await connection.getParsedTokenAccountsByOwner(wallet, { programId: TOKEN_PROGRAM }, commitment)
      ).value
        .filter((a) => (a.account.data.parsed?.info?.tokenAmount?.amount ?? '0') !== '0')
        .map((a) => a.pubkey.toBase58());
      const signatures = new Map();
      for (const address of [d.wallet, ...tokenAccounts]) {
        const list = await connection.getSignaturesForAddress(new PublicKey(address), { limit: RECEIPT_LOOKBACK }, commitment);
        for (const sig of list) if (!sig.err && !signatures.has(sig.signature)) signatures.set(sig.signature, sig);
      }
      // This extension's own transactions (uploads, executes, reclaims) deliver nothing in.
      const own = new Set(
        (await allSends()).flatMap((r) => [...(r.records ?? []).map((x) => x.signature), r.executeSignature, r.reclaimSignature]),
      );
      for (const sig of own) signatures.delete(sig);
      // Per endpoint, so what one RPC reported is never shown after switching to another.
      const key = `${RECEIPTS_PREFIX}${deployment.cluster}:${deployment.rpc}:${d.wallet}`;
      const cache = (await storage.local.get(key))[key] ?? {};
      const missing = [...signatures.keys()].filter((sig) => !(sig in cache));
      // Two at a time: public RPC endpoints rate-limit bursts.
      for (let i = 0; i < missing.length; i += 2)
        await Promise.all(
          missing.slice(i, i + 2).map(async (sig) => {
            const tx = await connection.getTransaction(sig, { commitment, maxSupportedTransactionVersion: 0 });
            if (!tx) return;
            const blockTime = tx.blockTime ?? signatures.get(sig).blockTime ?? null;
            cache[sig] = { blockTime: blockTime === null ? null : Number(blockTime), items: receiptsOf(tx, d.wallet, tokenAccounts) };
          }),
        );
      const kept = Object.fromEntries([...signatures.keys()].filter((sig) => sig in cache).map((sig) => [sig, cache[sig]]));
      await storage.local.set({ [key]: kept });
      const info = await ownerInfo();
      return Object.entries(kept)
        .flatMap(([signature, r]) =>
          r.items.map((item, n) => ({
            id: `${signature}:${n}`,
            signature,
            cluster: deployment.cluster,
            at: r.blockTime ? new Date(r.blockTime * 1000).toISOString() : null,
            ...item,
            fromFeeAddress: item.from === info.feePayer,
          })),
        )
        .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
    },
    // Sends that still hold something on-chain or may still run: removing the wallet's
    // journal would leave their proof deposits to be found by hand.
    async unfinishedSends() {
      const open = await openSends();
      const lamports = open.reduce((sum, r) => sum + BigInt(r.refundableRentLamports ?? '0'), 0n);
      return { count: open.length, lamports };
    },
    // Removes the wallet from this browser profile: keys, send journal and cached history.
    // Settings (network, RPC endpoint, auto-lock) stay. Refuses while sends are unfinished
    // unless the caller has shown that to the user and they chose to go ahead.
    async removeWallet({ evenWithUnfinished = false } = {}) {
      const count = (await openSends()).length;
      if (count && !evenWithUnfinished)
        throw new Error(
          `${count} send${count === 1 ? ' is' : 's are'} not finished. Open Activity to finish or discard ${count === 1 ? 'it' : 'them'} first.`,
        );
      // Hold every send's lock, so no review window is mid-send while its journal goes.
      const ids = (await allSends()).map((r) => r.id);
      const holdingAll = (rest, fn) =>
        rest.length
          ? withLock(`send:${rest[0]}`, () => holdingAll(rest.slice(1), fn), {
              ifAvailable: true,
              busyMessage: 'A send is running in another window. Let it finish or close that window, then try again.',
            })
          : fn();
      await holdingAll(ids, async () => {
        await vault.remove();
        const all = await storage.local.get(null);
        const keys = Object.keys(all).filter(
          (k) => isSendKey(k) || k.startsWith(RECEIPTS_PREFIX) || k === LEGACY_SENDS_KEY,
        );
        if (keys.length) await storage.local.remove(keys);
      });
      cached = null;
    },
    // Opens the recipient's associated token account for `mint`, paid by the fee key, after
    // the user agreed on the Send page. It is not part of any signed approval: it only spends
    // fee-key SOL (the account's rent, which stays with the account the recipient owns).
    // Idempotent, so retrying after an unclear outcome is safe.
    async createRecipientTokenAccount({ to, mint }) {
      const { network, connection } = await session();
      const d = await descriptor();
      const info = await ownerInfo();
      const recipient = parseAddress(to);
      const mintKey = parseAddress(mint, 'token mint address');
      const ownWallets = (info.descriptors[network.cluster] ?? []).map((x) => x.wallet);
      await checkRecipient(connection, network, recipient, d.wallet, ownWallets);
      const mintAccount = await connection.getAccountInfo(mintKey, network.commitment);
      if (!mintAccount || mintAccount.owner.toBase58() !== TOKEN_PROGRAM.toBase58())
        throw new Error('That token is not a classic SPL token.');
      const destination = new PublicKey(await tokenAccountFor(recipient.toBase58(), mintKey.toBase58()));
      if (await connection.getAccountInfo(destination, network.commitment)) return { address: destination.toBase58(), created: false };
      const payer = await vault.feeKeypair();
      const rent = BigInt(await connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_BYTES));
      const balance = BigInt(await connection.getBalance(payer.publicKey, network.commitment));
      if (balance < rent + 10000n)
        throw new Error(`Your fee address needs ${lamportsToSol(rent + 10000n - balance)} SOL more to create the account.`);
      const instruction = new TransactionInstruction({
        programId: ASSOCIATED_TOKEN_PROGRAM,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: destination, isSigner: false, isWritable: true },
          { pubkey: recipient, isSigner: false, isWritable: false },
          { pubkey: mintKey, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: new PublicKey(TOKEN_PROGRAM.toBase58()), isSigner: false, isWritable: false },
        ],
        data: Buffer.from([1]), // CreateIdempotent
      });
      // Sent directly by the fee key (the SDK's submitter only carries wallet-program
      // instructions), like the fee sweep.
      const latest = await connection.getLatestBlockhash(network.commitment);
      const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: latest.blockhash }).add(instruction);
      await tx.sign(payer);
      const signature = await connection.sendRawTransaction(await tx.serialize(), { preflightCommitment: network.commitment });
      await confirmByPolling(connection, signature, latest.lastValidBlockHeight, network.commitment);
      return { address: destination.toBase58(), created: true, signature, rentLamports: rent };
    },
    // Addresses this wallet sent to on the current network, newest first: delivered sends
    // only (never a typo that failed), without your own fee address (top-ups).
    async recentRecipients(limit = 4) {
      const { deployment } = await session();
      const info = await ownerInfo();
      const seen = new Set([info.feePayer]);
      const out = [];
      for (const r of (await allSends()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
        if (r.cluster !== deployment.cluster || r.status !== 'done' || !r.display?.to || seen.has(r.display.to)) continue;
        seen.add(r.display.to);
        out.push({ address: r.display.to, at: r.createdAt });
        if (out.length >= limit) break;
      }
      return out;
    },
    async listSends() {
      return (await allSends()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    getSend,
    // Review: delete. Finished: remove from the list. Signed but not finished: closes its
    // proof account first (returning the deposit), then removes it. While a page is
    // running the send, or its outcome is unknown, it cannot be discarded.
    async discardSend(id) {
      return withLock(
        `send:${id}`,
        async () => {
          const record = await getSend(id);
          if (!record) return null;
          if (record.status === 'review' || (FINISHED.includes(record.status) && !needsReclaim(record))) {
            await removeSend(id);
            return null;
          }
          if (['submitting', 'uncertain'].includes(record.status))
            throw new Error('This send may still be on its way. Check its status or resume it before discarding it.');
          record.discardedFrom ??= record.status;
          finish(record, 'discarded', { error: record.error });
          await saveSend(record);
          try {
            const { network } = await sendContext(record);
            await reclaim(record, network);
          } catch (error) {
            record.reclaimError = errorText(error);
          }
          if (!needsReclaim(record) && !mayStillExecute(record)) {
            await removeSend(id);
            return null;
          }
          // Kept until its deposit is reclaimed and, if its approval was published, until it
          // can no longer execute (both checked again when the popup opens).
          return saveSend(record);
        },
        { ifAvailable: true, busyMessage: 'This send is running in another window.' },
      );
    },
    parseUnits,
    LAMPORTS_PER_SOL,
    PROOF_BYTES,
    parseApproval,
  };
}
