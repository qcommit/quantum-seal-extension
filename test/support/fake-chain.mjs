// A small in-memory Solana for the wallet service's unit tests. It answers the RPC calls
// the SDK and the extension make, verifies nothing about signatures, and applies only the
// instructions the tests need: wallet initialize (tag 0), proof close (tag 7) and a
// SystemProgram transfer. Everything else lands as a no-op "confirmed" transaction.
import { Keypair, PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { IMMUTABLE_LOADER } from 'quantum-seal-wallet/network';
import { base58 } from 'quantum-seal-wallet/transport';
import { hex, concat, u64, encodePolicy, deriveWallet, fromHex, PROOF_BYTES } from 'quantum-seal-wallet/codec';

const utf8 = new TextEncoder();
const rent = (bytes) => 890880n + 6960n * BigInt(bytes);
// Keys may come from the SDK's own copy of web3.js, so compare them as base58 strings.
const b58 = (k) => (typeof k === 'string' ? k : k.toBase58());
const key = async () => (await Keypair.generate()).publicKey.toBase58();

export async function fakeChain() {
  const code = Uint8Array.of(0x7f, 0x45, 0x4c, 0x46, 9, 9, 9);
  const program = await key();
  const genesis = await key();
  const blockhash = await key();
  const accounts = new Map([[program, { executable: true, owner: IMMUTABLE_LOADER, data: code, lamports: 1n }]]);
  const statuses = new Map();
  const transactions = new Map();
  const history = new Map(); // address -> [signature info], oldest first
  const sent = [];
  // rejectTransfers: fail SystemProgram transfers at submission (models a failed sweep).
  const chain = { slot: 1000n, rejectTransfers: false };

  const note = (address, info) => history.set(address, [...(history.get(address) ?? []), info]);
  function credit(address, lamports) {
    const a = accounts.get(address) ?? { executable: false, owner: SystemProgram.programId, data: new Uint8Array(0), lamports: 0n };
    accounts.set(address, { ...a, lamports: BigInt(a.lamports) + BigInt(lamports) });
  }
  async function apply(message) {
    const keys = message.staticAccountKeys;
    for (const ix of message.compiledInstructions) {
      const programId = keys[ix.programIdIndex].toBase58();
      const at = (i) => keys[ix.accountKeyIndexes[i]].toBase58();
      const data = Uint8Array.from(ix.data);
      if (programId === program && data[0] === 0) {
        // initialize: [0, genesis(32), salt(32), policy(138)]
        const g = data.slice(1, 33),
          salt = data.slice(33, 65),
          policy = data.slice(65);
        const id = sha256(concat(utf8.encode('QuantumSeal/Wallet/v1'), g, salt, policy));
        const [, bump] = await PublicKey.findProgramAddress([utf8.encode('wallet'), id], new PublicKey(program));
        const wallet = at(1);
        const lamports = rent(334);
        credit(at(0), -lamports);
        accounts.set(wallet, {
          executable: false,
          owner: new PublicKey(program),
          data: walletData({ bump, id, genesis: g, policy, nonce: 0n, epoch: 0n }),
          lamports: (accounts.get(wallet)?.lamports ?? 0n) + lamports,
        });
      } else if (programId === program && data[0] === 7) {
        const proof = at(0),
          uploader = at(1);
        const account = accounts.get(proof);
        if (!account) throw new Error('close: proof account missing');
        accounts.delete(proof);
        credit(uploader, account.lamports);
      } else if (programId === SystemProgram.programId.toBase58() && data[0] === 2) {
        const lamports = new DataView(data.buffer, data.byteOffset).getBigUint64(4, true);
        credit(at(0), -lamports);
        credit(at(1), lamports);
      }
    }
  }

  const connection = {
    rpcEndpoint: 'http://127.0.0.1:8899/',
    sent,
    getGenesisHash: async () => genesis,
    getAccountInfo: async (k) => accounts.get(b58(k)) ?? null,
    getBalance: async (k) => accounts.get(b58(k))?.lamports ?? 0n,
    getMinimumBalanceForRentExemption: async (bytes) => rent(bytes),
    getSlot: async () => chain.slot,
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 1000n }),
    getBlockHeight: async () => 10n,
    getFeeForMessage: async () => ({ value: 5000n }),
    simulateTransaction: async () => ({ value: { err: null } }),
    getParsedTokenAccountsByOwner: async () => ({ value: [] }),
    async sendRawTransaction(wire) {
      const tx = VersionedTransaction.deserialize(wire);
      const system = SystemProgram.programId.toBase58();
      if (chain.rejectTransfers && tx.message.compiledInstructions.some((ix) => tx.message.staticAccountKeys[ix.programIdIndex].toBase58() === system))
        throw new Error('fetch failed');
      const signature = base58(tx.signatures[0]);
      await apply(tx.message);
      sent.push({ signature, message: tx.message });
      const keys = tx.message.staticAccountKeys;
      credit(keys[0].toBase58(), -5000n);
      statuses.set(signature, { confirmationStatus: 'confirmed', err: null, slot: chain.slot });
      transactions.set(signature, {
        slot: chain.slot,
        meta: { err: null, fee: 5000n, computeUnitsConsumed: 1000n },
        transaction: { message: tx.message, signatures: [signature] },
      });
      for (const k of keys) note(k.toBase58(), { signature, err: null, blockTime: Math.floor(Date.now() / 1000), slot: chain.slot });
      return signature;
    },
    getSignatureStatuses: async (signatures) => ({ value: signatures.map((s) => statuses.get(s) ?? null) }),
    getTransaction: async (signature) => transactions.get(signature) ?? null,
    getSignaturesForAddress: async (k) => [...(history.get(b58(k)) ?? [])].reverse(),
  };

  return {
    connection,
    accounts,
    get slot() {
      return chain.slot;
    },
    set slot(value) {
      chain.slot = value;
    },
    get rejectTransfers() {
      return chain.rejectTransfers;
    },
    set rejectTransfers(value) {
      chain.rejectTransfers = value;
    },
    program,
    genesis,
    // Settings that pin the extension's localnet to this fake deployment.
    settings: (extra = {}) => ({
      cluster: 'localnet',
      autoLockMinutes: 15,
      rpc: {},
      deployments: {
        localnet: { program, programSha256: hex(sha256(code)), programSize: code.length, upgradeAuthority: null, genesis },
      },
      ...extra,
    }),
    fund(address, lamports) {
      credit(b58(address), lamports);
    },
    // A second deployment of the same program bytes on this chain (a re-pin).
    async deployAgain() {
      const other = await key();
      accounts.set(other, { executable: true, owner: IMMUTABLE_LOADER, data: code, lamports: 1n });
      return { program: other, programSha256: hex(sha256(code)), programSize: code.length, upgradeAuthority: null, genesis };
    },
    // Creates (or rewrites) the wallet account for a descriptor; `policy` overrides the
    // live on-chain policy (to model a rotated or foreign policy).
    async setWallet(descriptor, { lamports = 2000000000n, nonce = 0n, epoch = 0n, policy } = {}) {
      const { id, bump } = await deriveWallet(program, genesis, fromHex(descriptor.salt, 32), descriptor.initialPolicy);
      accounts.set(descriptor.wallet, {
        executable: false,
        owner: new PublicKey(program),
        data: walletData({
          bump,
          id,
          genesis: new PublicKey(genesis).toBytes(),
          policy: encodePolicy(policy ?? descriptor.initialPolicy),
          nonce,
          epoch,
        }),
        lamports,
      });
    },
    // An open proof account (as left by an interrupted upload).
    openProof(address) {
      accounts.set(b58(address), {
        executable: false,
        owner: new PublicKey(program),
        data: new Uint8Array(PROOF_BYTES),
        lamports: rent(PROOF_BYTES),
      });
    },
    // A confirmed transaction in `address`'s history built from `message`.
    addHistory(address, message, signature, meta = {}) {
      transactions.set(signature, {
        slot: chain.slot,
        meta: { err: null, fee: 5000n, ...meta },
        transaction: { message, signatures: [signature] },
      });
      note(b58(address), { signature, err: null, blockTime: Math.floor(Date.now() / 1000), slot: chain.slot });
    },
    hex,
  };
}

function walletData({ bump, id, genesis, policy, nonce, epoch }) {
  return concat(
    utf8.encode('QSWAL001'),
    Uint8Array.of(bump),
    id,
    genesis,
    policy,
    u64(epoch),
    u64(nonce),
    u64(0n),
    new Uint8Array(98),
    Uint8Array.of(0),
  );
}
