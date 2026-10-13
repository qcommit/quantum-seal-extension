// Preserve complete license and NOTICE texts for packages actually included by
// esbuild. License comments alone often refer to files absent from a browser ZIP.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export function thirdPartyNotices(root, inputs) {
  const provenance = join(root, 'licenses/upstream.json');
  const upstream = existsSync(provenance) ? JSON.parse(readFileSync(provenance, 'utf8')) : {};
  const packages = new Map();
  for (const input of inputs) {
    let dir = dirname(resolve(root, input));
    while (true) {
      const manifest = join(dir, 'package.json');
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
        // Some packages have nested package.json files containing only "type".
        if (pkg.name && pkg.version) {
          if (dir !== resolve(root)) packages.set(dir, pkg);
          break;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) throw new Error(`No package provenance for bundled input: ${input}`);
      dir = parent;
    }
  }
  const sections = [];
  const ordered = [...packages.entries()].sort((a, b) =>
    `${a[1].name}@${a[1].version}`.localeCompare(`${b[1].name}@${b[1].version}`),
  );
  for (const [dir, pkg] of ordered) {
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /^(licen[cs]e|copying|notice)(\..*)?$/i.test(e.name))
      .map((e) => e.name).sort();
    const texts = files.map((f) => `\n--- ${f} ---\n${readFileSync(join(dir, f), 'utf8').trim()}`);
    if (!files.some((f) => /^(licen[cs]e|copying)(\..*)?$/i.test(f))) {
      // Some published npm packages omit their LICENSE file. Only a reviewed,
      // exact-version upstream copy with a verified hash may fill that gap.
      const entry = upstream[`${pkg.name}@${pkg.version}`];
      if (!entry || entry.license !== pkg.license || !/^[\w.-]+$/.test(entry.file))
        throw new Error(`Missing full license text for bundled package ${pkg.name}@${pkg.version}`);
      const bytes = readFileSync(join(root, 'licenses', entry.file));
      if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
        throw new Error(`License checksum mismatch for ${pkg.name}@${pkg.version}`);
      texts.push(`\n--- Upstream repository LICENSE ---\nSource: ${entry.url}\n${bytes.toString('utf8').trim()}`);
    }
    sections.push([
      `${pkg.name}@${pkg.version}`,
      `Package metadata license: ${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? 'see below')}`,
      ...texts,
    ].join('\n'));
  }
  return `Third-party software notices\n\nGenerated from the packages included in this build.\n\n${sections.join('\n\n' + '='.repeat(72) + '\n\n')}\n`;
}
