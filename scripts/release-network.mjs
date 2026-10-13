import { GENESIS, parseNetwork } from 'quantum-seal-wallet/network';

// An unconfigured mainnet can be packaged only as a draft. A partial or malformed
// configuration is an error even for drafts: it must never be labelled deployable.
export function hasValidMainnetPins(network) {
  if (!network || typeof network !== 'object') throw new Error('Mainnet configuration is missing.');
  if (network.program === null && network.programSha256 === null && network.programSize === null) {
    if (network.upgradeAuthority !== null) throw new Error('Unpinned mainnet must have no upgrade authority.');
    return false;
  }
  parseNetwork({
    format: 'quantum-seal/network/1',
    cluster: 'mainnet-beta',
    rpc: network.rpc,
    genesis: GENESIS['mainnet-beta'],
    program: network.program,
    programSha256: network.programSha256,
    programSize: network.programSize,
    upgradeAuthority: network.upgradeAuthority,
  });
  return true;
}
