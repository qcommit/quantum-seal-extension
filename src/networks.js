// Pinned deployments. A network is usable only when its program address, binary hash
// and size are pinned here (or, for local development, entered in Settings); the SDK
// re-verifies the deployed bytes against these values before every transaction.
import { parseNetwork, GENESIS } from 'quantum-seal-wallet/network';

export const BUILT_IN = Object.freeze({
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
    // Test deployment of quantum-seal-wallet v0.1.0 (upgradeable on devnet only).
    program: '6LBRd57jagVvhmpX1idsw9QXhoNHMHWstvpeGdSZAexT',
    programSha256: '4fbf18f66470322941b907adf03ebcd995385d35ac8c7ae4e3aa5ef63dd7a049',
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
});

export const DEFAULT_SETTINGS = Object.freeze({
  cluster: 'devnet',
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
