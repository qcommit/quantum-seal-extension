import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { thirdPartyNotices } from '../scripts/third-party-notices.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'wallet-licenses-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, 'node_modules/example');
  mkdirSync(join(pkg, 'esm'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'example', version: '1.0.0', license: 'MIT' }));
  writeFileSync(join(pkg, 'esm/package.json'), '{"type":"module"}');
  return { root, pkg, inputs: ['node_modules/example/esm/index.js'] };
}

test('notices preserve full licenses and NOTICE, deduplicate inputs, and resolve nested package metadata', (t) => {
  const { root, pkg, inputs } = fixture(t);
  writeFileSync(join(pkg, 'LICENSE'), 'Full license text');
  writeFileSync(join(pkg, 'NOTICE'), 'Additional copyright notice');
  const result = thirdPartyNotices(root, [...inputs, ...inputs]);
  assert.equal(result.match(/example@1.0.0/g).length, 1);
  assert.match(result, /Full license text/);
  assert.match(result, /Additional copyright notice/);
});

test('notices fail closed on absent licenses and require an exact-version, hash-verified upstream copy', (t) => {
  const { root, pkg, inputs } = fixture(t);
  assert.throws(() => thirdPartyNotices(root, inputs), /Missing full license/);
  mkdirSync(join(root, 'licenses'));
  const text = 'Reviewed upstream license';
  const manifest = { 'example@1.0.0': {
    file: 'example.txt', license: 'MIT', url: 'https://example.test/commit/LICENSE',
    sha256: createHash('sha256').update(text).digest('hex'),
  } };
  writeFileSync(join(root, 'licenses/upstream.json'), JSON.stringify(manifest));
  writeFileSync(join(root, 'licenses/example.txt'), text);
  assert.match(thirdPartyNotices(root, inputs), /Reviewed upstream license/);
  writeFileSync(join(root, 'licenses/example.txt'), 'changed');
  assert.throws(() => thirdPartyNotices(root, inputs), /License checksum mismatch/);
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'example', version: '1.0.1', license: 'MIT' }));
  assert.throws(() => thirdPartyNotices(root, inputs), /Missing full license/);
});
