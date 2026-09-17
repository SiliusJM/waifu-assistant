import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const testsRoot = join(root, 'tests');

async function collectTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTestFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
      files.push(entryPath);
    }
  }
  return files;
}

const testFiles = await collectTestFiles(testsRoot);
execFileSync(
  process.execPath,
  ['--test', '--experimental-test-isolation=none', ...testFiles],
  { stdio: 'inherit' },
);
