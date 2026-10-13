import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN, mergeSettings, deploymentFor, isAvailable, networkConfig } from '../src/networks.js';

const pins = {
  program: '6LBRd57jagVvhmpX1idsw9QXhoNHMHWstvpeGdSZAexT',
  programSha256: 'a'.repeat(64),
  programSize: 141744,
  upgradeAuthority: 'Ds6WwjdyfQzKGsCUKKrMw1NwB14ySk2qgawtrUtsfebV',
};

test('a network is unavailable until its deployment is pinned', () => {
  const s = mergeSettings(null);
  const unpinned = { ...deploymentFor(s, 'mainnet-beta'), program: null, programSha256: null, programSize: null };
  assert.equal(isAvailable(unpinned), false);
  assert.throws(() => networkConfig(unpinned), /not available/);
});

test('developer pins apply to devnet but can never change mainnet', () => {
  const s = mergeSettings({ deployments: { devnet: pins, 'mainnet-beta': pins } });
  const devnet = deploymentFor(s, 'devnet');
  assert.equal(isAvailable(devnet), true);
  assert.equal(networkConfig(devnet).program, pins.program);
  assert.equal(deploymentFor(s, 'mainnet-beta').program, BUILT_IN['mainnet-beta'].program);
  assert.equal(deploymentFor(s, 'mainnet-beta').programSha256, BUILT_IN['mainnet-beta'].programSha256);
  assert.equal(deploymentFor(s, 'mainnet-beta').programSize, BUILT_IN['mainnet-beta'].programSize);
  assert.equal(deploymentFor(s, 'mainnet-beta').upgradeAuthority, BUILT_IN['mainnet-beta'].upgradeAuthority);
});

test('public RPC overrides must use HTTPS', () => {
  const s = mergeSettings({ deployments: { devnet: pins }, rpc: { devnet: 'http://example.com' } });
  assert.throws(() => networkConfig(deploymentFor(s, 'devnet')), /HTTPS/);
});

test('the built-in devnet deployment is pinned and parses', () => {
  const devnet = deploymentFor(mergeSettings(null), 'devnet');
  assert.equal(isAvailable(devnet), true);
  const config = networkConfig(devnet);
  assert.equal(config.program, 'HPopUzhpfG7Zn7BBuQ9FkJKSRB9e3vfgwrySCG7b7wHy');
  assert.equal(config.programSize, 141888);
});

test('new installs default to mainnet only once mainnet is pinned', async () => {
  const { defaultCluster, BUILT_IN, isTestNetwork } = await import('../src/networks.js');
  assert.equal(defaultCluster(), BUILT_IN['mainnet-beta'].program ? 'mainnet-beta' : 'devnet');
  assert.equal(defaultCluster({ 'mainnet-beta': { ...BUILT_IN['mainnet-beta'], program: null, programSha256: null, programSize: null } }), 'devnet');
  assert.equal(defaultCluster({ 'mainnet-beta': { ...BUILT_IN['mainnet-beta'], ...pins, upgradeAuthority: null } }), 'mainnet-beta');
  assert.equal(mergeSettings(null).cluster, defaultCluster());
  assert.equal(mergeSettings({ cluster: 'localnet' }).cluster, 'localnet');
  assert.equal(isTestNetwork('devnet'), true);
  assert.equal(isTestNetwork('localnet'), true);
  assert.equal(isTestNetwork('mainnet-beta'), false);
});
