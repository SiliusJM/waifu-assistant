import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  SherpaVitsTTSProvider,
  getNextTtsPhraseEnd,
  type SherpaTtsRuntime,
} from '../../src/voice/local/sherpa-vits-tts-provider.js';
import {
  WindowsCpalStreamingAudioOutputProvider,
  type CpalOutputRuntime,
} from '../../src/voice/local/windows-cpal-audio-output-provider.js';
import type { AudioStreamChunk } from '../../src/voice/streaming-types.js';
import { VoiceError } from '../../src/voice/voice-errors.js';

async function temporaryModel(): Promise<{ readonly root: string; readonly repositoryRoot: string; readonly paths: { readonly model: string; readonly tokens: string; readonly dataDir: string } }> {
  const root = await mkdtemp(join(tmpdir(), 'waifu-local-tts-test-'));
  const repositoryRoot = join(root, 'repo');
  await mkdir(repositoryRoot);
  const paths = { model: join(root, 'model.onnx'), tokens: join(root, 'tokens.txt'), dataDir: join(root, 'espeak-ng-data') };
  await writeFile(paths.model, 'test model placeholder');
  await writeFile(paths.tokens, 'test tokens');
  await mkdir(paths.dataDir);
  return { root, repositoryRoot, paths };
}

function fakeTtsRuntime(samples = new Float32Array([0, 0.25, -0.5, 1])): SherpaTtsRuntime & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    OfflineTts: {
      createAsync: async () => ({
        sampleRate: 22050,
        generateAsync: async ({ text }) => {
          calls.push(text);
          return { samples: new Float32Array(samples), sampleRate: 22050 };
        },
      }),
    },
  };
}

test('local Piper VITS provider validates external model layout and streams bounded PCM16 chunks', async () => {
  const temporary = await temporaryModel();
  const runtime = fakeTtsRuntime(new Float32Array(5000).fill(0.25));
  try {
    const provider = new SherpaVitsTTSProvider(temporary.paths, { runtime, repositoryRoot: temporary.repositoryRoot });
    await provider.prepare();
    const operation = await provider.startSynthesis({ sessionId: 'voice-test', text: 'Hola.' }, {
      signal: new AbortController().signal, correlationId: 'tts-test',
    });
    await operation.pushText('Hola.');
    await operation.endInput();
    const chunks = [];
    for await (const chunk of operation.chunks()) chunks.push(chunk);
    const result = await operation.completed();
    assert.deepEqual(runtime.calls, ['Hola.']);
    assert.deepEqual(chunks.map(({ sequence }) => sequence), [0, 1, 2]);
    assert.ok(chunks.every(({ format }) => format.encoding === 'pcm_s16le' && format.sampleRateHz === 22050 && format.channels === 1));
    assert.equal(chunks.reduce((bytes, chunk) => bytes + chunk.data.byteLength, 0), 10_000);
    assert.deepEqual(result, {
      format: { encoding: 'pcm_s16le', sampleRateHz: 22050, channels: 1 },
      chunkCount: 3,
      byteLength: 10_000,
      durationMs: 5000 / 22050 * 1000,
    });
    assert.ok(chunks.every(({ data }) => data.length > 0));
    await operation.close();
  } finally {
    await rm(temporary.root, { recursive: true, force: true });
  }
});

test('local Piper VITS validates files outside the repository and rejects empty speech input', async () => {
  const temporary = await temporaryModel();
  const runtime = fakeTtsRuntime();
  try {
    const invalid = new SherpaVitsTTSProvider(temporary.paths, { runtime, repositoryRoot: temporary.root });
    await assert.rejects(invalid.prepare(), (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_TTS_ERROR');

    const provider = new SherpaVitsTTSProvider(temporary.paths, { runtime, repositoryRoot: temporary.repositoryRoot });
    const operation = await provider.startSynthesis({ sessionId: 'voice-test' }, {
      signal: new AbortController().signal, correlationId: 'empty-tts-test',
    });
    await assert.rejects(operation.endInput(), (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_TTS_ERROR');
    await operation.close();
  } finally {
    await rm(temporary.root, { recursive: true, force: true });
  }
});

test('local Piper VITS stops producing chunks when synthesis is cancelled', async () => {
  const temporary = await temporaryModel();
  let continueGeneration!: () => void;
  const generated = new Promise<void>((resolve) => { continueGeneration = resolve; });
  const runtime: SherpaTtsRuntime = {
    OfflineTts: {
      createAsync: async () => ({
        sampleRate: 22050,
        generateAsync: async ({ onProgress }) => {
          await generated;
          assert.equal(onProgress(), false);
          return { samples: new Float32Array([0.1]), sampleRate: 22050 };
        },
      }),
    },
  };
  try {
    const provider = new SherpaVitsTTSProvider(temporary.paths, { runtime, repositoryRoot: temporary.repositoryRoot });
    const controller = new AbortController();
    const operation = await provider.startSynthesis({ sessionId: 'voice-test' }, {
      signal: controller.signal, correlationId: 'cancel-tts-test',
    });
    const pushing = operation.pushText('Cancela.');
    controller.abort();
    continueGeneration();
    await assert.rejects(pushing, (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_CANCELLATION_ERROR');
    assert.equal((await operation.chunks()[Symbol.asyncIterator]().next()).done, true);
    await operation.close();
  } finally {
    await rm(temporary.root, { recursive: true, force: true });
  }
});

test('TTS phrases are split on punctuation and bounded by the configured character cap', () => {
  assert.equal(getNextTtsPhraseEnd('Hola. Mundo', false), 5);
  assert.equal(getNextTtsPhraseEnd('a'.repeat(321), false), 320);
  assert.equal(getNextTtsPhraseEnd('c'.repeat(200) + ' ' + 'd'.repeat(130), false), 320);
  assert.equal(getNextTtsPhraseEnd('a'.repeat(319) + '😀' + 'b', false), 319);
  assert.equal(getNextTtsPhraseEnd('Hola', true), 4);
  assert.equal(getNextTtsPhraseEnd('Hola', false), 0);
});

interface FakeCpalState {
  written: (Float32Array | Int16Array)[];
  outputCallbacks: (() => void)[];
  config: { sampleRate: number; channels: number; sampleFormat: string } | undefined;
  closeCount: number;
  writeAttempts: number;
}

function fakeOutputRuntime(options: { readonly format?: 'f32' | 'i16'; readonly rejectFirstWrite?: boolean; readonly deferOutput?: boolean } = {}): CpalOutputRuntime & { readonly state: FakeCpalState } {
  const state: FakeCpalState = { written: [], outputCallbacks: [], config: undefined, closeCount: 0, writeAttempts: 0 };
  const format = options.format ?? 'f32';
  const runtime: CpalOutputRuntime = {
    convenience: {
      getDefaultOutputDevice: () => ({ deviceId: 'fake-default' }),
      getDefaultOutputConfig: () => ({ sampleRate: 48000, channels: 2 }),
      getSupportedOutputConfigs: () => [{ minSampleRate: 48000, maxSampleRate: 48000, channels: 2, sampleFormat: format }],
      createOutputStream: async ({ config, onDrain, onOutput }) => {
        state.config = config;
        return {
          get bufferedFrames(): number { return 0; },
          write: (samples: Float32Array | Int16Array): boolean => {
            state.writeAttempts += 1;
            if (options.rejectFirstWrite && state.writeAttempts === 1) {
              setTimeout(onDrain, 0);
              return false;
            }
            state.written.push(samples);
            const reportOutput = (): void => onOutput({ frames: samples.length / config.channels });
            state.outputCallbacks.push(reportOutput);
            if (!options.deferOutput) setTimeout(reportOutput, 0);
            return true;
          },
          close: async () => { state.closeCount += 1; },
        };
      },
    },
  };
  return Object.assign(runtime, { state });
}

function pcmChunk(bytes = [0, 64, 0, 192]): AudioStreamChunk {
  return {
    data: new Uint8Array(bytes),
    format: { encoding: 'pcm_s16le', sampleRateHz: 22050, channels: 1 },
    sequence: 0,
    timestampMs: 0,
    durationMs: 100,
    source: 'tts',
  };
}

test('Windows CPAL output retains non-silent device samples until CPAL reports playback, then clears them on drain', async () => {
  const runtime = fakeOutputRuntime({ rejectFirstWrite: true, deferOutput: true });
  const provider = new WindowsCpalStreamingAudioOutputProvider({ runtime });
  const controller = new AbortController();
  const playback = await provider.startPlayback({ deviceId: 'default', signal: controller.signal, correlationId: 'output-test' });
  const chunk = pcmChunk();
  await playback.enqueue(chunk);
  assert.equal(chunk.data.every((byte) => byte === 0), true);
  assert.equal(runtime.state.writeAttempts, 2);
  assert.deepEqual(runtime.state.config, { sampleRate: 48000, channels: 2, sampleFormat: 'f32', bufferSize: { type: 'default' } });
  const written = runtime.state.written[0];
  assert.ok(written instanceof Float32Array);
  assert.equal(written?.length, 8);
  assert.equal(written?.[0], written?.[1]);
  assert.ok(written?.some((sample) => sample !== 0));
  for (const reportOutput of runtime.state.outputCallbacks) reportOutput();
  await playback.flush();
  await playback.completed();
  assert.ok(written?.every((sample) => sample === 0));
  assert.equal(runtime.state.closeCount, 1);
});

test('Windows CPAL output supports integer devices and rejects invalid PCM without leaking device buffers', async () => {
  const runtime = fakeOutputRuntime({ format: 'i16' });
  const provider = new WindowsCpalStreamingAudioOutputProvider({ runtime });
  const controller = new AbortController();
  const playback = await provider.startPlayback({ deviceId: 'default', signal: controller.signal, correlationId: 'i16-output-test' });
  await playback.enqueue(pcmChunk());
  const written = runtime.state.written[0];
  assert.ok(written instanceof Int16Array);
  assert.equal(written?.[0], written?.[1]);
  const invalid = pcmChunk([1]);
  await assert.rejects(playback.enqueue(invalid), (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_AUDIO_FORMAT_ERROR');
  await playback.stop('immediate');
  assert.equal(runtime.state.closeCount, 1);
});

test('Windows CPAL output cancellation releases the default device immediately', async () => {
  const runtime = fakeOutputRuntime();
  const provider = new WindowsCpalStreamingAudioOutputProvider({ runtime });
  const controller = new AbortController();
  const playback = await provider.startPlayback({ deviceId: 'default', signal: controller.signal, correlationId: 'abort-output-test' });
  controller.abort();
  await playback.stop('immediate');
  assert.equal(runtime.state.closeCount, 1);
  await assert.rejects(playback.enqueue(pcmChunk()), (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_CANCELLATION_ERROR');
});
