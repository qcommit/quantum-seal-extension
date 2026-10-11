// Builds the release extension and zips dist/ for the Chrome Web Store.
//
//   npm run package            # refuses unless mainnet is pinned in src/networks.js
//   npm run package -- --draft # allow an unpinned mainnet (store review rehearsal only)
//
// Writes release/quantum-seal-extension-<version>.zip and prints its SHA-256. The zip
// holds dist/ exactly as built (manifest.json at the root), with fixed timestamps and
// sorted entries, so the archive depends only on the bytes in dist/ (whose
// build-info.json records the build time, core commit and per-file hashes).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const draft = process.argv.includes('--draft');

execFileSync(process.execPath, [join(root, 'scripts/build.mjs'), '--release'], { stdio: 'inherit' });

const info = JSON.parse(readFileSync(join(dist, 'build-info.json'), 'utf8'));
if (!info.release || !info.core.matchesPin) throw new Error('dist/ is not a release build at CORE_REF.');
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
if (manifest.host_permissions.some((h) => !h.startsWith('https://')))
  throw new Error('Release manifest must only request HTTPS hosts.');

// Mainnet pins live in src/networks.js; a store build without them would only show devnet.
const networks = readFileSync(join(root, 'src/networks.js'), 'utf8');
const mainnet = networks.slice(networks.indexOf("'mainnet-beta'"), networks.indexOf('devnet:'));
const pinned = !/program:\s*null/.test(mainnet);
if (!pinned && !draft)
  throw new Error('Mainnet is not pinned yet (run scripts/pin-deployment.mjs first), or pass --draft.');

// Deterministic archive: sorted entries, fixed mtime, no extra attributes.
const entries = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, e.name);
    if (e.isDirectory()) walk(path);
    else entries.push(relative(dist, path).split(sep).join('/'));
  }
};
walk(dist);
const fixed = new Date('2026-01-01T00:00:00Z');
for (const f of entries) utimesSync(join(dist, f), fixed, fixed);

const out = join(root, 'release');
mkdirSync(out, { recursive: true });
const name = `quantum-seal-extension-${manifest.version}${pinned ? '' : '-draft'}.zip`;
const zip = join(out, name);
rmSync(zip, { force: true });
execFileSync('zip', ['-X', '-q', '-9', zip, ...entries], { cwd: dist, stdio: 'inherit' });

const digest = createHash('sha256').update(readFileSync(zip)).digest('hex');
writeFileSync(`${zip}.sha256`, `${digest}  ${name}\n`);
console.log(`\n${relative(root, zip)}  (${entries.length} files)`);
console.log(`sha256 ${digest}`);
console.log(`core   ${info.core.commit}`);
if (!pinned) console.log('DRAFT: mainnet is not pinned; do not submit this archive.');
