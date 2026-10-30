import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicRegistryLockfile } from './use-public-npm.mjs';

const TPS = 'https://pkgs.dev.azure.com/skype/_packaging/tps/npm/registry/';
const PUBLIC = 'https://registry.npmjs.org/';
const dependency = (resolved = `${TPS}@scope/example/-/example-1.2.3.tgz`) => ({ version: '1.2.3', integrity: 'sha512-fixture', resolved, optional: true, os: ['win32'] });
const fixture = () => ({ lockfileVersion: 3, packages: { '': { name: 'fixture' }, 'node_modules/@scope/example': dependency() } });

test('rewrites scoped downloads without changing versions, integrity, or the input object', () => {
  const input = fixture();
  const original = structuredClone(input);
  const result = publicRegistryLockfile(input);
  assert.equal(result.rewritten, 1);
  assert.deepEqual(input, original);
  assert.deepEqual(result.lockfile.packages['node_modules/@scope/example'], dependency(`${PUBLIC}@scope/example/-/example-1.2.3.tgz`));
});

test('public registry preparation is idempotent', () => {
  const prepared = publicRegistryLockfile(fixture()).lockfile;
  assert.deepEqual(publicRegistryLockfile(prepared), { lockfile: prepared, rewritten: 0 });
});

test('rejects unknown or private sources and missing checksums', () => {
  for (const url of ['https://private.invalid/file.tgz', 'file:../local', 'git+https://github.com/example/package.git', `${PUBLIC}example/-/example.tgz?token=not-a-secret`]) {
    const input = fixture();
    input.packages['node_modules/@scope/example'].resolved = url;
    assert.throws(() => publicRegistryLockfile(input));
  }
  const input = fixture();
  delete input.packages['node_modules/@scope/example'].integrity;
  assert.throws(() => publicRegistryLockfile(input), /integrity/);
  assert.throws(() => publicRegistryLockfile({ lockfileVersion: 1 }), /v3/);
});

test('the actual repository lockfile can use public npm with identical locked packages', async () => {
  const original = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const prepared = publicRegistryLockfile(original).lockfile;
  assert.deepEqual(Object.keys(prepared.packages), Object.keys(original.packages));
  for (const [name, entry] of Object.entries(prepared.packages)) {
    const { resolved, ...metadata } = entry;
    const { resolved: originalUrl, ...originalMetadata } = original.packages[name];
    assert.deepEqual(metadata, originalMetadata);
    if (originalUrl) assert.equal(resolved, originalUrl.replace(TPS, PUBLIC));
  }
});

test('CLI prepares only the specified file, and invalid input is not overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ar-ci-lock-'));
  try {
    const path = join(directory, 'package-lock.json');
    const script = fileURLToPath(new URL('./use-public-npm.mjs', import.meta.url));
    await writeFile(path, JSON.stringify(fixture()));
    execFileSync(process.execPath, [script, path]);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).packages['node_modules/@scope/example'].resolved, `${PUBLIC}@scope/example/-/example-1.2.3.tgz`);
    const invalid = JSON.stringify({ lockfileVersion: 1 });
    await writeFile(path, invalid);
    assert.throws(() => execFileSync(process.execPath, [script, path], { stdio: 'pipe' }));
    assert.equal(await readFile(path, 'utf8'), invalid);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
