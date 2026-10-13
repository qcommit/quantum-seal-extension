// Bundles the extension into dist/. One copy of each shared library is forced so
// objects such as PublicKey are identical between the SDK and the extension code, and
// the SDK's crypto libraries come from this repository's own pinned versions.
//
//   node scripts/build.mjs [--minify] [--release]
//
// --release refuses to build unless the core SDK checkout is clean and at CORE_REF.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { thirdPartyNotices } from './third-party-notices.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const require = createRequire(join(root, 'package.json'));
const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`));
const release = process.argv.includes('--release');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The core SDK is a file: dependency. Record exactly which commit is bundled, and in a
// release build require it to be the reviewed commit pinned in CORE_REF.
const coreDir = realpathSync(join(root, 'node_modules', 'quantum-seal-wallet'));
const coreRef = readFileSync(join(root, 'CORE_REF'), 'utf8').trim();
if (!/^[0-9a-f]{40}$/.test(coreRef)) throw new Error('CORE_REF must hold a full 40-character commit hash.');
let coreCommit = null,
  coreClean = false;
try {
  coreCommit = execFileSync('git', ['-C', coreDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  coreClean = execFileSync('git', ['-C', coreDir, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim() === '';
} catch {
  /* not a git checkout */
}
if (coreCommit !== coreRef || !coreClean) {
  const why = `core SDK at ${coreDir} is ${coreCommit ?? 'not a git checkout'}${coreClean ? '' : ' with local changes'}; CORE_REF pins ${coreRef}`;
  if (release) throw new Error(`Release build refused: ${why}.`);
  console.warn(`Warning: ${why}.`);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'icons'), { recursive: true });

// Libraries whose objects cross the SDK/extension boundary need a single copy.
const shared = ['@solana/web3.js', 'buffer'];
// The SDK's crypto libraries are resolved from this repository (same versions as the
// core pins, checked below), so this lockfile governs scrypt, SHA-2 and SLH-DSA. Only
// imports from inside the core are redirected: web3.js keeps its own older @noble copy.
const coreCrypto = ['@noble/hashes', '@noble/post-quantum', '@noble/curves', '@noble/ciphers'];
for (const name of coreCrypto) {
  const ours = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
  const theirsPath = join(coreDir, 'node_modules', name, 'package.json');
  if (!existsSync(theirsPath)) continue;
  const theirs = JSON.parse(readFileSync(theirsPath, 'utf8')).version;
  if (ours !== theirs) throw new Error(`${name}: extension pins ${ours} but the core uses ${theirs}.`);
}
const escape = (name) => name.replace(/[/.]/g, (c) => `\\${c}`);
const inCore = (path) => path === coreDir || path.startsWith(coreDir + sep);
const dedupe = {
  name: 'dedupe-shared',
  setup(b) {
    const redirect = (args) =>
      args.pluginData?.deduped
        ? undefined
        : b.resolve(args.path, { resolveDir: root, kind: args.kind, pluginData: { deduped: true } });
    for (const name of shared) b.onResolve({ filter: new RegExp(`^${escape(name)}(/.*)?$`) }, redirect);
    for (const name of coreCrypto)
      b.onResolve({ filter: new RegExp(`^${escape(name)}(/.*)?$`) }, (args) =>
        inCore(realpathSync(args.resolveDir)) ? redirect(args) : undefined,
      );
  },
};

const result = await build({
  entryPoints: {
    popup: join(root, 'src/ui/popup.jsx'),
    review: join(root, 'src/ui/review.jsx'),
    background: join(root, 'src/background.js'),
    // Web Worker that signs approvals off the review window's main thread.
    signer: join(root, 'src/signer-worker.js'),
    // One stylesheet for both pages; Inter Variable is bundled from @fontsource-variable
    // as local font files, so the pages load nothing remote.
    styles: join(root, 'src/ui/styles.css'),
  },
  outdir: dist,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome120'],
  // Shared code (web3.js, the SDK, React) is one set of chunks for every page and the worker.
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  minify: process.argv.includes('--minify'),
  sourcemap: false,
  jsx: 'automatic',
  loader: { '.woff2': 'file' },
  assetNames: 'fonts/[name]-[hash]',
  legalComments: 'linked',
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis', __QS_RELEASE__: release ? 'true' : 'false' },
  inject: [join(root, 'scripts/buffer-shim.js')],
  plugins: [dedupe],
  metafile: true,
  logLevel: 'warning',
});

// Nothing may be bundled from the core's own node_modules: one copy of each library.
const fromCoreModules = Object.keys(result.metafile.inputs).filter((p) =>
  inCore(resolve(root, p)) && resolve(root, p).includes(`${sep}node_modules${sep}`),
);
if (fromCoreModules.length) throw new Error(`Bundled from the core's node_modules: ${fromCoreModules.slice(0, 5).join(', ')}`);

// Ship full license/NOTICE texts, not only esbuild's linked copyright snippets.
cpSync(join(root, 'LICENSE'), join(dist, 'LICENSE'));
writeFileSync(join(dist, 'THIRD_PARTY_NOTICES.txt'), thirdPartyNotices(root, Object.keys(result.metafile.inputs)));

for (const f of ['ui/popup.html', 'ui/review.html'])
  cpSync(join(root, 'src', f), join(dist, f.split('/').pop()));
cpSync(join(root, 'src/manifest.json'), join(dist, 'manifest.json'));
for (const f of ['mark.svg', 'icon-16.png', 'icon-32.png', 'icon-48.png', 'icon-128.png']) {
  const src = join(root, 'assets', f);
  if (existsSync(src)) cpSync(src, join(dist, 'icons', f));
}
// Inter is licensed under the SIL Open Font License; ship the license with the font files.
cpSync(join(pkgDir('@fontsource-variable/inter'), 'LICENSE'), join(dist, 'fonts', 'LICENSE-Inter.txt'));
// Extension pages run under script-src 'self': refuse to ship inline scripts or handlers.
for (const f of ['popup.html', 'review.html']) {
  const html = readFileSync(join(dist, f), 'utf8');
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html) || /\son[a-z]+\s*=/i.test(html))
    throw new Error(`${f} contains an inline script or event handler.`);
}
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
// Release builds talk only to HTTPS RPC endpoints: drop loopback access to a local validator.
if (release) {
  manifest.host_permissions = manifest.host_permissions.filter((h) => !h.startsWith('http://127.0.0.1'));
  manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages.replace(
    / http:\/\/127\.0\.0\.1:\*/g,
    '',
  );
  writeFileSync(join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
// The extension pages do not need WebAssembly or WebSockets; the CSP allows neither.
const scripts = [
  ...['popup.js', 'review.js', 'background.js', 'signer.js'],
  ...readdirSync(join(dist, 'chunks')).filter((f) => f.endsWith('.js')).map((f) => `chunks/${f}`),
];
for (const f of scripts)
  if (/\bWebAssembly\./.test(readFileSync(join(dist, f), 'utf8')))
    throw new Error(`${f} uses WebAssembly, which the extension CSP does not allow.`);
const files = {};
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else files[relative(dist, path).split(sep).join('/')] = sha256(readFileSync(path));
  }
};
walk(dist);
writeFileSync(
  join(dist, 'build-info.json'),
  JSON.stringify(
    {
      version: manifest.version,
      builtAt: new Date().toISOString(),
      release,
      core: { commit: coreCommit, clean: coreClean, pinned: coreRef, matchesPin: coreCommit === coreRef && coreClean },
      packageLockSha256: sha256(readFileSync(join(root, 'package-lock.json'))),
      files,
    },
    null,
    2,
  ) + '\n',
);
console.log('Built', dist);
