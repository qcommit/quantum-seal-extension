// Bundles the extension into dist/. One copy of each shared library is forced so
// objects such as PublicKey are identical between the SDK and the extension code.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const require = createRequire(join(root, 'package.json'));
const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`));

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'icons'), { recursive: true });

// Only libraries whose objects cross the SDK/extension boundary need a single copy.
const shared = ['@solana/web3.js', 'buffer'];
const dedupe = {
  name: 'dedupe-shared',
  setup(b) {
    for (const name of shared) {
      const escaped = name.replace(/[/.]/g, (c) => `\\${c}`);
      b.onResolve({ filter: new RegExp(`^${escaped}(/.*)?$`) }, (args) => {
        if (args.pluginData?.deduped) return undefined;
        return b
          .resolve(args.path, { resolveDir: root, kind: args.kind, pluginData: { deduped: true } })
          .then((r) => r);
      });
    }
  },
};

await build({
  entryPoints: {
    popup: join(root, 'src/ui/popup.jsx'),
    review: join(root, 'src/ui/review.jsx'),
    background: join(root, 'src/background.js'),
    // One stylesheet for both pages; Inter Variable is bundled from @fontsource-variable
    // as local font files, so the pages load nothing remote.
    styles: join(root, 'src/ui/styles.css'),
  },
  outdir: dist,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome120'],
  splitting: false,
  minify: process.argv.includes('--minify'),
  sourcemap: false,
  jsx: 'automatic',
  loader: { '.woff2': 'file' },
  assetNames: 'fonts/[name]-[hash]',
  legalComments: 'linked',
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
  inject: [join(root, 'scripts/buffer-shim.js')],
  plugins: [dedupe],
  logLevel: 'warning',
});

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
writeFileSync(join(dist, 'build-info.json'), JSON.stringify({ version: manifest.version, builtAt: new Date().toISOString() }, null, 2));
console.log('Built', dist);
