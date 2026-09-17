import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = join(root, 'src');
const outputRoot = join(root, 'dist');

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

const sourceFiles = await collectFiles(sourceRoot);
await mkdir(outputRoot, { recursive: true });

for (const sourceFile of sourceFiles) {
  const targetFile = join(outputRoot, relative(sourceRoot, sourceFile));
  await mkdir(dirname(targetFile), { recursive: true });
  await copyFile(sourceFile, targetFile);
  execFileSync(process.execPath, ['--check', sourceFile], { stdio: 'inherit' });
}

console.log('Build OK: ' + sourceFiles.length + ' source files copied to dist.');
