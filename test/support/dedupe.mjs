// Node resolve hook for the unit tests: the core SDK's imports of shared libraries
// resolve to this repository's copies, exactly as scripts/build.mjs bundles them. Without
// it, PublicKey and Keypair objects would come from two different web3.js copies.
import { realpathSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, resolve as resolvePath, sep } from 'node:path';

const root = resolvePath(fileURLToPath(new URL('../..', import.meta.url)));
const core = realpathSync(join(root, 'node_modules', 'quantum-seal-wallet'));
const shared = /^(@solana\/web3\.js|buffer|@noble\/(hashes|post-quantum|curves|ciphers))(\/.*)?$/;
const here = pathToFileURL(join(root, 'package.json')).href;

export async function resolve(specifier, context, next) {
  if (shared.test(specifier) && context.parentURL?.startsWith('file:')) {
    const parent = realpathSync(fileURLToPath(context.parentURL));
    if (parent.startsWith(core + sep)) return next(specifier, { ...context, parentURL: here });
  }
  return next(specifier, context);
}
