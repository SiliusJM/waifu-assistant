import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MockAIProvider } from '../../src/ai/mock-ai-provider.js';
import { AssistantCore } from '../../src/core/assistant-core.js';
import { ConversationRunner } from '../../src/core/conversation-runner.js';
import { PushToTalkController } from '../../src/voice/local/push-to-talk-controller.js';
import { createLocalMicrophoneVoiceService } from '../../src/voice/local/local-voice-service.js';
import { convertFloatInputToPcm16Mono, type CpalRuntime } from '../../src/voice/local/windows-microphone-input-provider.js';
import { SherpaWhisperSTTProvider, type SherpaRuntime } from '../../src/voice/local/sherpa-whisper-stt-provider.js';
import { resolveWhisperTinyModelPaths, WHISPER_TINY_MODEL } from '../../src/voice/local/whisper-tiny-model.js';
import { VoiceConversationOrchestrator, type VoiceConversationEvent } from '../../src/voice/voice-conversation-orchestrator.js';
import { CANONICAL_AUDIO_FORMAT } from '../../src/voice/voice-types.js';
import { VoiceError } from '../../src/voice/voice-errors.js';

function fakeCpal(samples = new Float32Array(6400).fill(0.25)): CpalRuntime & { readonly counts: { closed: number; started: number } } {
  const counts = { closed: 0, started: 0 };
  const config = {
    channels: () => 2,
    sampleRate: () => 32000,
    sampleFormat: () => ({ value: 'f32' }),
    containsRate: (rate: number) => rate === 32000,
    tryWithSampleRate: (rate: number) => rate === 32000 ? config : null,
    tryWithStandardSampleRate: () => config,
    withMaxSampleRate: () => config,
  };
  const device = {
    defaultInputConfig: () => config,
    supportedInputConfigs: () => [config],
    buildInputStream: (_config: unknown, _format: string, onData: (data: Float32Array) => void) => ({
      play: () => { counts.started += 1; onData(samples); },
      close: () => { counts.closed += 1; },
    }),
    close: () => {},
  };
  const host = { defaultInputDevice: () => device, close: () => {} };
  return { defaultHost: () => host, SampleFormat: { F32: { value: 'f32' } }, counts } as unknown as CpalRuntime & { readonly counts: { closed: number; started: number } };
}

async function temporaryModelFiles(): Promise<{ readonly directory: string; readonly paths: { encoder: string; decoder: string; tokens: string } }> {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-local-stt-test-'));
  const paths = { encoder: join(directory, 'encoder.onnx'), decoder: join(directory, 'decoder.onnx'), tokens: join(directory, 'tokens.txt') };
  await Promise.all(Object.values(paths).map((path) => writeFile(path, 'test-model-placeholder')));
  return { directory, paths };
}

test('Whisper Tiny model is pinned to one multilingual offline revision with bounded external files', () => {
  assert.equal(WHISPER_TINY_MODEL.language, 'es');
  assert.match(WHISPER_TINY_MODEL.revision, /^[a-f0-9]{40}$/u);
  assert.deepEqual(WHISPER_TINY_MODEL.files.map(({ name }) => name), [
    'tiny-encoder.int8.onnx', 'tiny-decoder.int8.onnx', 'tiny-tokens.txt',
  ]);
  assert.ok(WHISPER_TINY_MODEL.files.every(({ sha256, maxBytes }) => /^[a-f0-9]{64}$/u.test(sha256) && maxBytes > 0));
});

test('model paths must be absolute and outside the repository', () => {
  const repository = join(tmpdir(), 'waifu-test-repository');
  assert.throws(() => resolveWhisperTinyModelPaths('relative-models', repository), /absolute external/u);
  assert.throws(() => resolveWhisperTinyModelPaths(join(repository, 'models'), repository), /outside the repository/u);
  assert.equal(resolveWhisperTinyModelPaths(join(tmpdir(), 'waifu-models'), repository).tokens.endsWith('tiny-tokens.txt'), true);
});

test('microphone conversion downmixes, resamples and emits canonical little-endian PCM16', () => {
  const converted = convertFloatInputToPcm16Mono(new Float32Array([0.5, 0.5, -1, -1]), 2, 16000);
  assert.deepEqual(CANONICAL_AUDIO_FORMAT, { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 });
  const view = new DataView(converted.data.buffer);
  assert.equal(view.getInt16(0, true), 16384);
  assert.equal(view.getInt16(2, true), -32768);
  const downsampled = convertFloatInputToPcm16Mono(new Float32Array(96000).fill(0.1), 1, 48000);
  assert.equal(downsampled.data.byteLength / 2, 32000);
});

test('Windows microphone provider exposes bounded capture and a graceful explicit stop', async () => {
  const runtime = fakeCpal();
  const { WindowsMicrophoneInputProvider } = await import('../../src/voice/local/windows-microphone-input-provider.js');
  const microphone = new WindowsMicrophoneInputProvider({ runtime, queueCapacity: 2 });
  const stream = await microphone.startCapture({ signal: new AbortController().signal, correlationId: 'test' });
  const iterator = stream.chunks()[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value?.format.encoding, 'pcm_s16le');
  assert.equal(first.value?.data.byteLength, 3200);
  await microphone.stopCapture();
  assert.equal((await iterator.next()).done, true);
  assert.equal(runtime.counts.closed, 1);
});

test('aborting microphone capture discards queued audio and releases the native stream', async () => {
  const runtime = fakeCpal();
  const { WindowsMicrophoneInputProvider } = await import('../../src/voice/local/windows-microphone-input-provider.js');
  const microphone = new WindowsMicrophoneInputProvider({ runtime, queueCapacity: 2 });
  const controller = new AbortController();
  const stream = await microphone.startCapture({ signal: controller.signal, correlationId: 'cancel-test' });
  controller.abort();
  const iterator = stream.chunks()[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).done, true);
  assert.equal(runtime.counts.closed, 1);
});

test('microphone provider returns a controlled typed error when no device exists', async () => {
  const runtime = {
    defaultHost: () => ({ defaultInputDevice: () => null, close() {} }),
    SampleFormat: { F32: { value: 'f32' } },
  } as unknown as CpalRuntime;
  const { WindowsMicrophoneInputProvider } = await import('../../src/voice/local/windows-microphone-input-provider.js');
  await assert.rejects(
    new WindowsMicrophoneInputProvider({ runtime }).startCapture({ signal: new AbortController().signal, correlationId: 'test' }),
    (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_CAPTURE_ERROR',
  );
});

test('Sherpa provider validates local files and decodes a final Spanish transcript offline', async () => {
  const temporary = await temporaryModelFiles();
  let receivedConfig: unknown;
  let receivedSamples = 0;
  const runtime: SherpaRuntime = {
    OfflineRecognizer: {
      async createAsync(config) {
        receivedConfig = config;
        return {
          createStream: () => ({ acceptWaveform: ({ samples }) => { receivedSamples = samples.length; } }),
          decodeAsync: async () => ({ text: 'Hola, Yuki.' }),
        };
      },
    },
  };
  try {
    const provider = new SherpaWhisperSTTProvider(temporary.paths, runtime);
    const session = await provider.start({ sessionId: 's1' }, { signal: new AbortController().signal, correlationId: 'c1' });
    const samples = new Uint8Array(320);
    const view = new DataView(samples.buffer);
    for (let i = 0; i < samples.byteLength; i += 2) view.setInt16(i, 1024, true);
    await session.pushAudio({ data: samples, format: CANONICAL_AUDIO_FORMAT, sequence: 0, capturedAt: new Date(0).toISOString() });
    await session.endInput();
    const events = [];
    for await (const event of session.events()) events.push(event);
    assert.deepEqual(events, [{ type: 'final', text: 'Hola, Yuki.' }]);
    assert.equal(receivedSamples, 160);
    assert.equal((receivedConfig as { modelConfig: { whisper: { language: string; task: string } } }).modelConfig.whisper.language, 'es');
    assert.equal(JSON.stringify(events).includes('1024'), false);
    await session.close();
  } finally {
    await rm(temporary.directory, { recursive: true, force: true });
  }
});

test('Sherpa provider reports a missing local model without downloading or initializing native runtime', async () => {
  const provider = new SherpaWhisperSTTProvider({ encoder: 'missing-encoder', decoder: 'missing-decoder', tokens: 'missing-tokens' }, {
    OfflineRecognizer: { async createAsync() { throw new Error('must not load'); } },
  });
  await assert.rejects(
    provider.start({ sessionId: 's1' }, { signal: new AbortController().signal, correlationId: 'c1' }),
    (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_STT_ERROR',
  );
});

test('local voice setup validates model before opening the microphone', async () => {
  const cpal = fakeCpal();
  const local = createLocalMicrophoneVoiceService({
    encoder: join(tmpdir(), 'missing-encoder.onnx'),
    decoder: join(tmpdir(), 'missing-decoder.onnx'),
    tokens: join(tmpdir(), 'missing-tokens.txt'),
  }, { cpalRuntime: cpal, sherpaRuntime: { OfflineRecognizer: { async createAsync() { throw new Error('must not initialize'); } } } });
  await assert.rejects(local.stt.prepare(), /speech model is missing/u);
  assert.equal(cpal.counts.started, 0);
});

test('Sherpa provider treats an empty utterance as no transcript rather than invented text', async () => {
  const temporary = await temporaryModelFiles();
  const runtime: SherpaRuntime = {
    OfflineRecognizer: { async createAsync() { return { createStream: () => ({ acceptWaveform() {} }), decodeAsync: async () => ({ text: 'must not decode empty audio' }) }; } },
  };
  try {
    const session = await new SherpaWhisperSTTProvider(temporary.paths, runtime).start(
      { sessionId: 'empty' }, { signal: new AbortController().signal, correlationId: 'empty' },
    );
    await session.endInput();
    const events = [];
    for await (const event of session.events()) events.push(event);
    assert.deepEqual(events, []);
    await session.close();
  } finally {
    await rm(temporary.directory, { recursive: true, force: true });
  }
});

test('push-to-talk sends the final local transcript through the existing conversation orchestrator', async () => {
  const temporary = await temporaryModelFiles();
  const cpal = fakeCpal();
  const sherpa: SherpaRuntime = {
    OfflineRecognizer: {
      async createAsync() {
        return {
          createStream: () => ({ acceptWaveform() {} }),
          decodeAsync: async () => ({ text: 'prueba de voz local' }),
        };
      },
    },
  };
  const provider = new MockAIProvider({ responseText: 'Te escuché.' });
  const core = new AssistantCore({ provider });
  const runner = new ConversationRunner(core);
  const local = createLocalMicrophoneVoiceService(temporary.paths, { cpalRuntime: cpal, sherpaRuntime: sherpa, defaultTimeoutMs: 2000 });
  const orchestrator = new VoiceConversationOrchestrator({ runner, voiceService: local.service });
  const controller = new PushToTalkController(local.microphone, orchestrator);
  const events: VoiceConversationEvent[] = [];
  orchestrator.subscribe((event) => events.push(event));
  try {
    await local.stt.prepare();
    assert.equal(cpal.counts.started, 0, 'model preparation must not open the microphone');
    await controller.start();
    await controller.stop();
    assert.deepEqual(events.filter(({ type }) => type === 'error'), [], JSON.stringify(events));
    assert.deepEqual(runner.session.getMessages().map(({ role, content }) => ({ role, content })), [
      { role: 'user', content: 'prueba de voz local' },
      { role: 'assistant', content: 'Te escuché.' },
    ]);
    assert.equal(provider.name, 'mock');
    assert.equal(cpal.counts.started, 1);
  } finally {
    await orchestrator.shutdown();
    await local.service.shutdownStreaming();
    await rm(temporary.directory, { recursive: true, force: true });
  }
});

test('push-to-talk controller requires explicit start before stop and rejects duplicate capture', async () => {
  let resolveCapture!: () => void;
  let starts = 0;
  let stops = 0;
  const capture = new Promise<void>((resolve) => { resolveCapture = resolve; });
  const fake = {
    startTranscriptionCapture: () => { starts += 1; return capture; },
    whenIdle: async () => {},
  } as unknown as VoiceConversationOrchestrator;
  const controller = new PushToTalkController({ stopCapture: async () => { stops += 1; resolveCapture(); } }, fake);
  await assert.rejects(controller.stop(), /not active/u);
  const started = controller.start();
  await assert.rejects(controller.start(), /already active/u);
  await started;
  await controller.stop();
  assert.equal(starts, 1);
  assert.equal(stops, 1);
  assert.equal(controller.isCapturing, false);
});

test('STT rejects non-canonical audio and bounds utterances to 30 seconds', async () => {
  const temporary = await temporaryModelFiles();
  const runtime: SherpaRuntime = {
    OfflineRecognizer: { async createAsync() { return { createStream: () => ({ acceptWaveform() {} }), decodeAsync: async () => ({ text: 'x' }) }; } },
  };
  try {
    const provider = new SherpaWhisperSTTProvider(temporary.paths, runtime);
    const session = await provider.start({ sessionId: 'bounded' }, { signal: new AbortController().signal, correlationId: 'c' });
    await assert.rejects(session.pushAudio({ data: new Uint8Array(4), format: { ...CANONICAL_AUDIO_FORMAT, sampleRateHz: 8000 }, sequence: 0, capturedAt: '' }), /16 kHz mono/u);
    await assert.rejects(session.pushAudio({ data: new Uint8Array(16000 * 2 * 31), format: CANONICAL_AUDIO_FORMAT, sequence: 0, capturedAt: '' }), /duration limit/u);
    await session.close();
  } finally {
    await rm(temporary.directory, { recursive: true, force: true });
  }
});
