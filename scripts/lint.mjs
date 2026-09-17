import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const roots = ['src', 'scripts', 'tests'].map((directory) => join(root, directory));
const forbiddenPatterns = [
  { pattern: /\beval\s*\(/, label: 'eval' },
  { pattern: /\bnew\s+Function\s*\(/, label: 'dynamic Function' },
];

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      files.push(entryPath);
    }
  }
  return files;
}

const files = [];
for (const directory of roots) {
  files.push(...await collectFiles(directory));
}

const issues = [];
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  } catch (error) {
    issues.push(file + ': syntax validation failed');
  }

  const contents = await readFile(file, 'utf8');
  for (const { pattern, label } of forbiddenPatterns) {
    if (pattern.test(contents)) {
      issues.push(file + ': forbidden pattern detected (' + label + ')');
    }
  }
}

if (issues.length > 0) {
  console.error(issues.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Lint OK: ' + files.length + ' JavaScript module files checked.');
}
