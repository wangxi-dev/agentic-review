import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TPS = 'https://pkgs.dev.azure.com/skype/_packaging/tps/npm/registry/';
const PUBLIC = 'https://registry.npmjs.org/';

// The checked-in lockfile supports the developer's TPS feed. Hosted CI has no
// TPS credentials. Change only download locations, never versions or integrity.
export function publicRegistryLockfile(original) {
  if (original?.lockfileVersion !== 3 || !original.packages || typeof original.packages !== 'object' || Array.isArray(original.packages)) {
    throw new Error('Expected an npm v3 lockfile with a packages map.');
  }
  const lockfile = structuredClone(original);
  let rewritten = 0;
  for (const [name, dependency] of Object.entries(lockfile.packages)) {
    if (dependency.resolved === undefined) continue; // Root package / workspace metadata.
    if (typeof dependency.resolved !== 'string' || typeof dependency.integrity !== 'string' || !dependency.integrity) {
      throw new Error(`Missing download URL or integrity for ${name}.`);
    }
    if (dependency.resolved.startsWith(TPS)) {
      dependency.resolved = PUBLIC + dependency.resolved.slice(TPS.length);
      rewritten++;
    }
    // Fail rather than silently fetching a private, Git, file, or unknown source.
    if (!dependency.resolved.startsWith(PUBLIC)) {
      throw new Error(`Unsupported package source for ${name}; explicitly review its CI access requirements.`);
    }
    const url = new URL(dependency.resolved);
    if (url.origin !== 'https://registry.npmjs.org' || url.username || url.password || url.search || url.hash) {
      throw new Error(`Unexpected registry URL for ${name}.`);
    }
  }
  return { lockfile, rewritten };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const path = resolve(process.argv[2] ?? 'package-lock.json');
  const original = JSON.parse(await readFile(path, 'utf8'));
  const { lockfile, rewritten } = publicRegistryLockfile(original);
  await writeFile(path, JSON.stringify(lockfile, null, 2) + '\n');
  console.log(`Prepared ${rewritten} npm download URLs for public CI; versions and integrity hashes are unchanged.`);
}
