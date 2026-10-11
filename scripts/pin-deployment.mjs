// Pins a deployed wallet program into src/networks.js after verifying it on-chain.
//
//   node scripts/pin-deployment.mjs --cluster mainnet-beta --program <ADDRESS> \
//     --binary ../quantum-seal-wallet/target/deploy/seal_wallet.so [--rpc URL]
//
// The script computes the binary's SHA-256 and size, then uses the core SDK's
// deployment check against the live cluster: the deployed bytes must match, and on
// mainnet the program must be immutable. Only then is the network entry rewritten.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha2.js';
import { openNetwork, GENESIS } from 'quantum-seal-wallet/network';
import { hex } from 'quantum-seal-wallet/codec';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: {
    cluster: { type: 'string' },
    program: { type: 'string' },
    binary: { type: 'string' },
    rpc: { type: 'string' },
    'upgrade-authority': { type: 'string' },
  },
});
const { cluster, program, binary } = values;
if (!['mainnet-beta', 'devnet'].includes(cluster) || !program || !binary)
  throw new Error('Usage: --cluster mainnet-beta|devnet --program ADDRESS --binary PATH [--rpc URL]');
const bytes = readFileSync(binary);
const pins = {
  program,
  programSha256: hex(sha256(bytes)),
  programSize: bytes.length,
  upgradeAuthority: cluster === 'mainnet-beta' ? null : (values['upgrade-authority'] ?? null),
};
const rpc =
  values.rpc ?? (cluster === 'mainnet-beta' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');
const session = await openNetwork({
  format: 'quantum-seal/network/1',
  cluster,
  rpc,
  genesis: GENESIS[cluster],
  ...pins,
});
console.log(`Verified ${cluster} deployment ${session.program} (immutable: ${session.immutable}).`);

const file = join(root, 'src/networks.js');
const source = readFileSync(file, 'utf8');
const label = cluster === 'mainnet-beta' ? "'mainnet-beta'" : 'devnet';
const block = new RegExp(`(  ${label.replace(/[-']/g, (c) => `\\${c}`)}: \\{\\n    label: [^\\n]+\\n    rpc: [^\\n]+\\n)[\\s\\S]*?(\\n  \\},)`);
if (!block.test(source)) throw new Error(`Could not find the ${cluster} entry in src/networks.js.`);
const q = (v) => (v === null ? 'null' : typeof v === 'number' ? String(v) : `'${v}'`);
const body = [
  `    // Verified on-chain by scripts/pin-deployment.mjs on ${new Date().toISOString().slice(0, 10)}.`,
  `    program: ${q(pins.program)},`,
  `    programSha256: ${q(pins.programSha256)},`,
  `    programSize: ${q(pins.programSize)},`,
  `    upgradeAuthority: ${q(pins.upgradeAuthority)},`,
].join('\n');
writeFileSync(file, source.replace(block, `$1${body}$2`));
console.log(`Pinned ${cluster} in src/networks.js. Rebuild with npm run build.`);
