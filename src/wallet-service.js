// Wallet operations for the extension, built on the core SDK. Every chain write goes
// through the SDK's pinned-deployment checks; sends are journaled so an interrupted
// send resumes from on-chain state instead of being signed or submitted again.
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { openNetwork, rateLimitedFetch } from 'quantum-seal-wallet/network';
import {
  createDescriptor,
  walletStatus,
  initializeWallet,
  prepareSolTransfer,
  prepareTokenTransfer,
  executeApprovals,
  executionCost,
  parseUnits,
} from 'quantum-seal-wallet/wallet';
import { signApproval, parseApproval } from 'quantum-seal-wallet/approval';
import { decodeIntent, hex, PROOF_BYTES } from 'quantum-seal-wallet/codec';
import { closeProofInstruction, TOKEN_PROGRAM } from 'quantum-seal-wallet/instructions';
import { submit } from 'quantum-seal-wallet/client';
import { deploymentFor, networkConfig, isAvailable } from './networks.js';

export const SENDS_KEY = 'sends';
export const SETTINGS_KEY = 'settings';
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZ9zbHQBhL1v8Tq9GZy3s3pVm');
// Each send reimburses the fee key from the wallet (12 transactions x 5,000 lamports
// plus a small margin), so its float stays topped up.
export const FEE_REFUND_LAMPORTS = 65000n;
// Float kept on the fee key: one proof account's rent (refunded after each send) plus fees.
export const FEE_FLOAT_LAMPORTS = 70000000n;

// Polls signature status instead of relying on a WebSocket subscription, which some
// RPC providers restrict. Fails closed with the signature if the blockhash expires.
export async function confirmByPolling(connection, signature, lastValidBlockHeight, commitment) {
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
    await new Promise((r) => setTimeout(r, commitment === 'confirmed' ? 400 : 1500));
  }
}

export function lamportsToSol(value) {
  const n = BigInt(value);
  const whole = n / 1000000000n,
    frac = (n % 1000000000n).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function createWalletService({ vault, storage, fetchImpl = globalThis.fetch.bind(globalThis) }) {
  let cached = null;

  async function settings() {
    const { mergeSettings } = await import('./networks.js');
    return mergeSettings((await storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]);
  }
  async function session() {
    const s = await settings();
    const deployment = deploymentFor(s);
    const config = networkConfig(deployment);
    const key = JSON.stringify(config);
    if (cached?.key === key) return cached.value;
    const connection = new Connection(config.rpc, {
      commitment: config.cluster === 'localnet' ? 'confirmed' : 'finalized',
      disableRetryOnRateLimit: true,
      fetch: rateLimitedFetch(fetchImpl),
    });
    const network = await openNetwork(config, connection);
    cached = { key, value: { network, connection, deployment, settings: s } };
    return cached.value;
  }
  async function descriptor() {
    const { network, deployment } = await session();
    const info = await vault.publicInfo();
    if (!info) throw new Error('No wallet in this browser profile.');
    const existing = info.descriptors[deployment.cluster];
    if (existing && existing.program === network.program && existing.genesis === network.genesis)
      return existing;
    const created = await createDescriptor({
      program: network.program,
      genesis: network.genesis,
      policy: { keys: [info.ownerPublicKey], threshold: 1 },
    });
    await vault.setDescriptor(deployment.cluster, created);
    return created;
  }
  async function sends() {
    return (await storage.local.get(SENDS_KEY))[SENDS_KEY] ?? {};
  }
  async function saveSend(record) {
    const all = await sends();
    all[record.id] = record;
    await storage.local.set({ [SENDS_KEY]: all });
    return record;
  }

  return {
    session,
    descriptor,
    async availability() {
      const s = await settings();
      return Object.fromEntries(
        ['mainnet-beta', 'devnet', 'localnet'].map((c) => [c, isAvailable(deploymentFor(s, c))]),
      );
    },

    async overview() {
      const { network, connection, deployment } = await session();
      const d = await descriptor();
      const info = await vault.publicInfo();
      const status = await walletStatus(network, d);
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
      const cost = await executionCost(network, 1);
      return {
        cluster: deployment.cluster,
        label: deployment.label,
        wallet: d.wallet,
        initialized: status.initialized,
        balanceLamports: status.balanceLamports,
        availableLamports: status.availableLamports,
        reserveLamports: status.reserveLamports,
        feePayer: info.feePayer,
        feeLamports,
        // Enough for one proof account plus fees; below this a send cannot start.
        feeNeededLamports: cost.requiredPayerLamports,
        tokens,
      };
    },

    // One-address onboarding: the user funds the fee key once; this creates the
    // wallet account and moves everything above the fee float into the wallet.
    async setupWallet({ keepLamports = FEE_FLOAT_LAMPORTS } = {}) {
      const { network, connection } = await session();
      const d = await descriptor();
      const payer = await vault.feeKeypair();
      const init = await initializeWallet(network, payer, d);
      const balance = BigInt(await connection.getBalance(payer.publicKey, network.commitment));
      const fee = 5000n;
      let swept = 0n,
        sweepSignature = null;
      if (balance > keepLamports + fee) {
        swept = balance - keepLamports - fee;
        const latest = await connection.getLatestBlockhash(network.commitment);
        const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: latest.blockhash });
        tx.add(
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: new PublicKey(d.wallet),
            lamports: swept,
          }),
        );
        await tx.sign(payer);
        sweepSignature = await connection.sendRawTransaction(await tx.serialize(), {
          preflightCommitment: network.commitment,
        });
        await confirmByPolling(connection, sweepSignature, latest.lastValidBlockHeight, network.commitment);
      }
      return {
        initialized: !init.alreadyInitialized,
        initializeSignature: init.receipt?.signature ?? null,
        sweptLamports: swept,
        sweepSignature,
      };
    },

    async prepareSend({ asset = 'SOL', to, amount, mint }) {
      const { network, connection } = await session();
      const d = await descriptor();
      const info = await vault.publicInfo();
      const feeRefund = { to: info.feePayer, lamports: FEE_REFUND_LAMPORTS };
      let prepared, display;
      if (asset === 'SOL') {
        prepared = await prepareSolTransfer(network, d, { to, amount, feeRefund });
        display = { asset: 'SOL', amount, to };
      } else {
        const owner = new PublicKey(d.wallet),
          recipient = new PublicKey(to),
          mintKey = new PublicKey(mint);
        const ata = async (who) =>
          (
            await PublicKey.findProgramAddress(
              [who.toBytes(), TOKEN_PROGRAM.toBytes(), mintKey.toBytes()],
              ASSOCIATED_TOKEN_PROGRAM,
            )
          )[0];
        const parsed = await connection.getParsedTokenAccountsByOwner(
          owner,
          { mint: mintKey },
          network.commitment,
        );
        const source = parsed.value[0]?.pubkey;
        if (!source) throw new Error('This wallet holds no account for that token.');
        const destination = await ata(recipient);
        if (!(await connection.getAccountInfo(destination, network.commitment)))
          throw new Error(
            'The recipient has no account for this token yet. Ask them to create one, then send again.',
          );
        prepared = await prepareTokenTransfer(network, d, {
          source: source.toBase58(),
          mint,
          destination: destination.toBase58(),
          amount,
          feeRefund,
        });
        display = { asset: mint, amount, to, decimals: prepared.decimals };
      }
      const intent = decodeIntent(prepared.bytes);
      const cost = await executionCost(network, 1);
      const id = hex(globalThis.crypto.getRandomValues(new Uint8Array(12)));
      return saveSend({
        id,
        cluster: network.cluster,
        wallet: d.wallet,
        createdAt: new Date().toISOString(),
        status: 'review',
        intentHex: hex(prepared.bytes),
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

    // Signing happens only from the review window after the user approves the decoded intent.
    async approve(id) {
      const all = await sends();
      const record = all[id];
      if (!record || record.status !== 'review') throw new Error('Nothing to approve.');
      const secret = await vault.ownerSecret();
      try {
        const bytes = Uint8Array.from(record.intentHex.match(/../g).map((h) => parseInt(h, 16)));
        record.approval = signApproval(bytes, secret, 0);
      } finally {
        secret.fill(0);
      }
      record.status = 'signed';
      return saveSend(record);
    },

    async execute(id, onProgress = () => {}) {
      const { network } = await session();
      const d = await descriptor();
      const all = await sends();
      const record = all[id];
      if (!record?.approval) throw new Error('Send is not signed.');
      if (record.status === 'done') return record;
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
        record.status = 'done';
        record.cleanupErrors = result.cleanupErrors;
      } catch (error) {
        record.error = error.message;
        record.uncertainSignature = error.signature ?? null;
        record.status = error.name === 'SubmissionUncertain' ? 'uncertain' : 'failed';
        // A send whose nonce has already advanced was executed (possibly by an
        // earlier attempt); report it as done instead of a failure.
        try {
          const status = await walletStatus(network, d);
          if (status.initialized && status.state.nonce > BigInt(record.nonce)) {
            record.status = 'done';
            record.error = null;
          }
        } catch {
          /* keep the original error */
        }
      }
      return saveSend(record);
    },

    // For "uncertain" sends: look up the recorded signature before anything is retried.
    async checkUncertain(id) {
      const { connection } = await session();
      const record = (await sends())[id];
      if (!record?.uncertainSignature) return null;
      const status = (
        await connection.getSignatureStatuses([record.uncertainSignature], {
          searchTransactionHistory: true,
        })
      ).value[0];
      return status
        ? { found: true, confirmation: status.confirmationStatus, err: status.err ?? null }
        : { found: false };
    },

    async listSends() {
      return Object.values(await sends()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async getSend(id) {
      return (await sends())[id] ?? null;
    },
    async discardSend(id) {
      const all = await sends();
      if (all[id] && ['review', 'failed', 'done'].includes(all[id].status)) delete all[id];
      await storage.local.set({ [SENDS_KEY]: all });
    },
    parseUnits,
    LAMPORTS_PER_SOL,
    PROOF_BYTES,
    closeProofInstruction,
    submit,
    parseApproval,
  };
}
