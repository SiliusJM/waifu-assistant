import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SILERO_VAD_MODEL } from '../dist/voice/local/silero-vad-model.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

export async function installSileroVadModel(output, fetchModel = fetch) {
  if (!isAbsolute(output) || inside(resolve(output), projectRoot)) {
    throw new Error('Model directory must be an absolute path outside the repository.');
  }
  const [canonicalParent, canonicalRoot] = await Promise.all([
    realpathOfNearestExistingAncestor(resolve(output)), realpath(projectRoot),
  ]);
  if (inside(canonicalParent, canonicalRoot)) {
    throw new Error('Model directory resolves inside the repository.');
  }

  await mkdir(output, { recursive: true });
  const canonicalOutput = await realpath(output);
  if (inside(canonicalOutput, canonicalRoot)) {
    throw new Error('Model directory resolves inside the repository.');
  }

  const modelPath = join(canonicalOutput, SILERO_VAD_MODEL.name);
  const manifestPath = join(canonicalOutput, 'manifest.json');
  for (const target of [modelPath, manifestPath]) {
    try {
      await access(target);
      const name = target === modelPath ? SILERO_VAD_MODEL.name : 'manifest.json';
      throw new Error(`Refusing to overwrite existing model file: ${name}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Refusing to overwrite')) throw error;
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
  }

  const temporary = await mkdtemp(join(canonicalOutput, '.download-'));
  const temporaryModel = join(temporary, SILERO_VAD_MODEL.name);
  const installed = [];
  try {
    const response = await fetchModel(SILERO_VAD_MODEL.url, {
      redirect: 'follow', signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok || !response.body || !response.url.startsWith('https://')) {
      throw new Error(`Official model download unavailable (HTTP ${response.status}).`);
    }

    let bytes = 0;
    const hash = createHash('sha256');
    const verify = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > SILERO_VAD_MODEL.maxBytes) {
          callback(new Error('VAD model exceeds the pinned size limit.'));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(temporaryModel, { flags: 'wx' }));
    const sha256 = hash.digest('hex');
    if (bytes !== SILERO_VAD_MODEL.bytes || sha256 !== SILERO_VAD_MODEL.sha256) {
      throw new Error('VAD model size or SHA-256 does not match the official pinned asset.');
    }

    await copyFile(temporaryModel, modelPath, constants.COPYFILE_EXCL);
    installed.push(modelPath);
    await writeFile(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      status: 'VERIFIED',
      source: {
        repository: SILERO_VAD_MODEL.repository,
        release: SILERO_VAD_MODEL.release,
        assetId: SILERO_VAD_MODEL.assetId,
        url: SILERO_VAD_MODEL.url,
      },
      file: { name: SILERO_VAD_MODEL.name, bytes, sha256 },
      license: 'MIT (Silero VAD upstream attribution)',
    }, null, 2)}\n`, { flag: 'wx' });
    installed.push(manifestPath);
    return { modelPath, bytes, sha256 };
  } catch (error) {
    for (const file of installed) await rm(file, { force: true });
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const output = process.argv[2];
  if (!output || !isAbsolute(output)) {
    process.stderr.write('Usage: npm run setup:local-vad-model -- <absolute-directory-outside-repository>\n');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await installSileroVadModel(output);
    process.stdout.write(`Verified local Silero VAD model: ${result.modelPath}\nSHA-256: ${result.sha256}\n`);
  } catch (error) {
    process.stderr.write(`VAD model setup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
