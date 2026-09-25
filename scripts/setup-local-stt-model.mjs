import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { WHISPER_TINY_MODEL } from '../dist/voice/local/whisper-tiny-model.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputArg = process.argv[2];

function inside(child, parent) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

async function realpathOfNearestExistingAncestor(path) {
  let candidate = path;
  while (true) {
    try {
      return await realpath(candidate);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error)
        || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

if (!outputArg || !isAbsolute(outputArg)) {
  process.stderr.write('Usage: npm run setup:local-stt-model -- <absolute-directory-outside-repository>\n');
  process.exitCode = 2;
} else {
  const output = resolve(outputArg);
  if (inside(output, projectRoot)) {
    process.stderr.write('Model directory must be outside the repository.\n');
    process.exitCode = 2;
  } else {
    const [canonicalParent, canonicalRoot] = await Promise.all([
      realpathOfNearestExistingAncestor(output), realpath(projectRoot),
    ]);
    if (inside(canonicalParent, canonicalRoot)) {
      process.stderr.write('Model directory resolves inside the repository.\n');
      process.exitCode = 2;
    } else {
      await mkdir(output, { recursive: true });
      if (inside(await realpath(output), canonicalRoot)) {
        process.stderr.write('Model directory resolves inside the repository.\n');
        process.exitCode = 2;
      } else {
        await installModel(output);
      }
    }
  }
}

async function installModel(output) {
  for (const name of [...WHISPER_TINY_MODEL.files.map(({ name }) => name), 'manifest.json']) {
    try {
      await access(join(output, name));
      process.stderr.write(`Refusing to overwrite existing model file: ${name}\n`);
      process.exitCode = 2;
      return;
    } catch { /* Expected when the destination is a fresh model directory. */ }
  }
  const temporary = await mkdtemp(join(output, '.download-'));
  const manifestFiles = [];
  const installed = [];
  try {
    for (const file of WHISPER_TINY_MODEL.files) {
      const url = `https://huggingface.co/${WHISPER_TINY_MODEL.repository}/resolve/${WHISPER_TINY_MODEL.revision}/${file.name}`;
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.body || !response.url.startsWith('https://')) {
        throw new Error(`Download unavailable (${response.status}) for ${file.name}`);
      }
      let bytes = 0;
      const hash = createHash('sha256');
      const verify = new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > file.maxBytes) { callback(new Error(`Size limit exceeded for ${file.name}`)); return; }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      const temporaryFile = join(temporary, file.name);
      await pipeline(ReadableFromWeb(response.body), verify, createWriteStream(temporaryFile, { flags: 'wx' }));
      const sha256 = hash.digest('hex');
      if (sha256 !== file.sha256) throw new Error(`SHA-256 mismatch for ${file.name}`);
      manifestFiles.push({ name: file.name, bytes, sha256 });
    }
    for (const file of WHISPER_TINY_MODEL.files) {
      const target = join(output, file.name);
      await copyFile(join(temporary, file.name), target, constants.COPYFILE_EXCL);
      installed.push(target);
    }
    await writeFile(join(output, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      status: 'PROPOSED',
      source: { repository: WHISPER_TINY_MODEL.repository, revision: WHISPER_TINY_MODEL.revision },
      language: WHISPER_TINY_MODEL.language,
      files: manifestFiles,
    }, null, 2) + '\n', { flag: 'wx' });
    installed.push(join(output, 'manifest.json'));
    process.stdout.write(`Verified local Whisper Tiny model files at ${output}\n`);
  } catch (error) {
    for (const file of installed) await rm(file, { force: true });
    const message = error instanceof Error ? error.message : 'unknown error';
    process.stderr.write(`Model setup failed: ${message}\n`);
    process.exitCode = 1;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function ReadableFromWeb(stream) {
  return Readable.fromWeb(stream);
}
