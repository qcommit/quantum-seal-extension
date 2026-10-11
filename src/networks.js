// Pinned deployments. A network is usable only when its program address, binary hash
// and size are pinned here (or, for local development, entered in Settings); the SDK
// re-verifies the deployed bytes against these values before every transaction.
import { parseNetwork, GENESIS } from 'quantum-seal-wallet/network';

// Release builds (scripts/build.mjs --release) define __QS_RELEASE__ = true and ship
// without the local-validator network or its loopback permissions.
const RELEASE = typeof __QS_RELEASE__ !== 'undefined' && __QS_RELEASE__ === true;

const NETWORKS = {
  'mainnet-beta': {
    label: 'Mainnet',
    rpc: 'https://api.mainnet-beta.solana.com',
    // Filled in at release time from the reviewed, immutable mainnet deployment.
    program: null,
    programSha256: null,
    programSize: null,
    upgradeAuthority: null,
  },
  devnet: {
    label: 'Devnet',
    rpc: 'https://api.devnet.solana.com',
    // Verified on-chain by scripts/pin-deployment.mjs on 2026-10-11.
    program: '6LBRd57jagVvhmpX1idsw9QXhoNHMHWstvpeGdSZAexT',
    programSha256: 'c53d5da22ae1b2d2d7be9d568a646db79b8ee6a0e1e1bb4cd33735602ed96bc0',
    programSize: 141744,
    upgradeAuthority: 'Ds6WwjdyfQzKGsCUKKrMw1NwB14ySk2qgawtrUtsfebV',
  },
  localnet: {
    label: 'Local validator',
    rpc: 'http://127.0.0.1:8899',
    program: null,
    programSha256: null,
    programSize: null,
    upgradeAuthority: null,
  },
};
if (RELEASE) delete NETWORKS.localnet;
export const BUILT_IN = Object.freeze(NETWORKS);

// New installs open on mainnet once the release pins it, and on devnet until then.
export function defaultCluster(builtIn = BUILT_IN) {
  const m = builtIn['mainnet-beta'];
  return m?.program && m.programSha256 && m.programSize ? 'mainnet-beta' : 'devnet';
}
export const isTestNetwork = (cluster) => cluster !== 'mainnet-beta';

export const DEFAULT_SETTINGS = Object.freeze({
  cluster: defaultCluster(),
  autoLockMinutes: 15,
  rpc: {},
  // Per-cluster overrides for development builds: { program, programSha256, programSize, upgradeAuthority, genesis }.
  deployments: {},
});

export function mergeSettings(saved) {
  return {
    ...DEFAULT_SETTINGS,
    ...(saved ?? {}),
    rpc: { ...(saved?.rpc ?? {}) },
    deployments: { ...(saved?.deployments ?? {}) },
  };
}

export function deploymentFor(settings, cluster = settings.cluster) {
  const base = BUILT_IN[cluster];
  if (!base) throw new Error('Unknown network.');
  const override = settings.deployments?.[cluster] ?? {};
  // Mainnet pins are fixed by the release; Settings may only change its RPC endpoint.
  const pins = cluster === 'mainnet-beta' ? base : { ...base, ...override };
  return {
    cluster,
    label: base.label,
    rpc: settings.rpc?.[cluster] || base.rpc,
    genesis: pins.genesis ?? GENESIS[cluster] ?? null,
    program: pins.program,
    programSha256: pins.programSha256,
    programSize: pins.programSize,
    upgradeAuthority: pins.upgradeAuthority ?? null,
  };
}

export function isAvailable(deployment) {
  return Boolean(
    deployment.program && deployment.programSha256 && deployment.programSize && deployment.genesis,
  );
}

export function networkConfig(deployment) {
  if (!isAvailable(deployment))
    throw new Error(`${deployment.label} is not available in this build yet.`);
  return parseNetwork({
    format: 'quantum-seal/network/1',
    cluster: deployment.cluster,
    rpc: deployment.rpc,
    genesis: deployment.genesis,
    program: deployment.program,
    programSha256: deployment.programSha256,
    programSize: deployment.programSize,
    upgradeAuthority: deployment.upgradeAuthority,
  });
}

export function explorerUrl(cluster, kind, value) {
  const suffix =
    cluster === 'mainnet-beta'
      ? ''
      : cluster === 'devnet'
        ? '?cluster=devnet'
        : `?cluster=custom&customUrl=${encodeURIComponent('http://127.0.0.1:8899')}`;
  return `https://explorer.solana.com/${kind}/${value}${suffix}`;
}
