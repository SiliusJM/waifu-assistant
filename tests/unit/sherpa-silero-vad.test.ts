import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SherpaWhisperSTTProvider, type SherpaRuntime, type SherpaSttDiagnosticEvent } from '../../src/voice/local/sherpa-whisper-stt-provider.js';
import {
  DEFAULT_VAD_MIN_SILENCE_MS,
  SILERO_VAD_SAMPLE_RATE,
  SILERO_VAD_WINDOW_SAMPLES,
  resolveSileroVadModelPath,
  SherpaSileroVad,
  speechSegmentToPcm16,
  type SherpaVadDetector,
  type SherpaVadRuntime,
} from '../../src/voice/local/sherpa-silero-vad.js';
import { VoiceError } from '../../src/voice/voice-errors.js';

class FakeDetector implements SherpaVadDetector {
  private active = false;
  private audio: number[] = [];
  private segment: Float32Array | undefined;
  acceptWaveform(samples: Float32Array): void {
    const speech = samples.some((sample) => Math.abs(sample) >= 0.1);
    if (speech) {
      this.active = true;
      this.audio.push(...samples);
    } else if (this.active) {
      this.active = false;
      this.segment = Float32Array.from(this.audio);
      this.audio = [];
    }
  }
  isDetected(): boolean { return this.active; }
  isEmpty(): boolean { return this.segment === undefined; }
  front(): { readonly samples: Float32Array } { return { samples: this.segment ?? new Float32Array() }; }
  pop(): void { this.segment = undefined; }
  reset(): void { this.active = false; this.audio = []; this.segment?.fill(0); this.segment = undefined; }
  flush(): void {
    if (this.active) this.segment = Float32Array.from(this.audio);
    this.active = false;
    this.audio = [];
  }
}

function pcmFrame(sample: number): Uint8Array {
  const bytes = new Uint8Array(512 * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < 512; index += 1) view.setInt16(index * 2, sample, true);
  return bytes;
}

test('Silero VAD model paths are absolute, external, and missing assets fail closed', async () => {
  const repo = join(tmpdir(), 'waifu-vad-repository');
  assert.throws(() => resolveSileroVadModelPath('vad.onnx', repo), /absolute external/u);
  assert.throws(() => resolveSileroVadModelPath(join(repo, 'vad.onnx'), repo), /outside the repository/u);
  assert.equal(resolveSileroVadModelPath(join(tmpdir(), 'silero_vad.onnx'), repo), join(tmpdir(), 'silero_vad.onnx'));
  await assert.rejects(
    SherpaSileroVad.create({ modelPath: join(tmpdir(), 'missing-silero-vad.onnx'), runtime: { Vad: FakeDetector } }),
    (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_CONFIGURATION_ERROR',
  );
});

test('Silero VAD uses bounded pause tolerance and CPU-only 16 kHz model config', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-silero-vad-'));
  const modelPath = join(directory, 'silero_vad.onnx');
  let config: unknown;
  const runtime: SherpaVadRuntime = {
    Vad: class extends FakeDetector {
      constructor(value: unknown) { super(); config = value; }
    },
  };
  try {
    await writeFile(modelPath, 'offline model fixture');
    const vad = await SherpaSileroVad.create({ modelPath, runtime });
    vad.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  assert.deepEqual(config, {
    sampleRate: 16000,
    numThreads: 1,
    provider: 'cpu',
    sileroVad: {
      model: modelPath,
      threshold: 0.5,
      minSilenceDuration: DEFAULT_VAD_MIN_SILENCE_MS / 1000,
      minSpeechDuration: 0.2,
      maxSpeechDuration: 10,
      windowSize: 512,
    },
  });
  await assert.rejects(
    SherpaSileroVad.create({ modelPath, minSilenceMs: 100 }),
    (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_CONFIGURATION_ERROR',
  );
});

test('VAD ignores silence and low-amplitude noise, and emits confirmed speech start/end after configured pause', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-silero-vad-'));
  const modelPath = join(directory, 'silero_vad.onnx');
  await writeFile(modelPath, 'offline model fixture');
  try {
    const vad = await SherpaSileroVad.create({ modelPath, runtime: { Vad: FakeDetector } });
    assert.deepEqual(vad.pushPcm16(pcmFrame(0)), []);
    assert.deepEqual(vad.pushPcm16(pcmFrame(100)), []);
    assert.deepEqual(vad.pushPcm16(pcmFrame(2000)), [{ speechStarted: false, speechEnded: false, possibleNoise: true }]);
    const start = vad.pushPcm16(pcmFrame(8000));
    assert.deepEqual(start, [{ speechStarted: true, speechEnded: false }]);
    const end = vad.pushPcm16(pcmFrame(0));
    assert.equal(end.length, 1);
    assert.equal(end[0]?.speechEnded, true);
    assert.equal(end[0]?.speechStarted, false);
    assert.ok((end[0]?.segment?.length ?? 0) > 0);
    vad.close();
    assert.throws(() => vad.pushPcm16(pcmFrame(0)), /closed/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('VAD keeps one utterance across a short pause and ends it only after the configured silence interval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-silero-pause-test-'));
  const modelPath = join(directory, 'silero_vad.onnx');
  await writeFile(modelPath, 'offline model fixture');
  class PauseTolerantDetector implements SherpaVadDetector {
    private active = false;
    private silenceFrames = 0;
    private segment: Float32Array | undefined;
    constructor(private readonly requiredSilenceFrames: number) {}
    acceptWaveform(samples: Float32Array): void {
      if (samples.some((sample) => Math.abs(sample) >= 0.1)) {
        this.active = true;
        this.silenceFrames = 0;
        return;
      }
      if (!this.active || ++this.silenceFrames < this.requiredSilenceFrames) return;
      this.active = false;
      this.segment = new Float32Array(SILERO_VAD_WINDOW_SAMPLES * (this.silenceFrames + 1));
    }
    isDetected(): boolean { return this.active; }
    isEmpty(): boolean { return this.segment === undefined; }
    front(): { readonly samples: Float32Array } { return { samples: this.segment ?? new Float32Array() }; }
    pop(): void { this.segment?.fill(0); this.segment = undefined; }
    reset(): void { this.active = false; this.silenceFrames = 0; this.pop(); }
    flush(): void { if (this.active) this.segment = new Float32Array(SILERO_VAD_WINDOW_SAMPLES); this.active = false; }
  }
  const runtime: SherpaVadRuntime = {
    Vad: class extends PauseTolerantDetector {
      constructor(config: { sileroVad: { minSilenceDuration: number } }) {
        const requiredFrames = Math.ceil(config.sileroVad.minSilenceDuration * SILERO_VAD_SAMPLE_RATE / SILERO_VAD_WINDOW_SAMPLES);
        super(requiredFrames);
      }
    },
  };
  try {
    const vad = await SherpaSileroVad.create({ modelPath, minSilenceMs: 350, runtime });
    assert.deepEqual(vad.pushPcm16(pcmFrame(8000)).map(({ speechStarted, speechEnded }) => ({ speechStarted, speechEnded })), [
      { speechStarted: true, speechEnded: false },
    ]);
    const shortPauseFrames = Math.floor(Math.ceil(0.35 * SILERO_VAD_SAMPLE_RATE / SILERO_VAD_WINDOW_SAMPLES) / 2);
    for (let index = 0; index < shortPauseFrames; index += 1) {
      assert.deepEqual(vad.pushPcm16(pcmFrame(0)), []);
    }
    assert.deepEqual(vad.pushPcm16(pcmFrame(8000)), []);
    const silenceFrames = Math.ceil(0.35 * SILERO_VAD_SAMPLE_RATE / SILERO_VAD_WINDOW_SAMPLES);
    const ending = Array.from({ length: silenceFrames }, () => vad.pushPcm16(pcmFrame(0))).flat();
    assert.equal(ending.filter((transition) => transition.speechEnded).length, 1);
    assert.equal(ending.filter((transition) => transition.speechStarted).length, 0);
    vad.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('speech segments convert to bounded canonical PCM16 and zero the transient VAD samples', () => {
  const samples = new Float32Array([-1, -0.5, 0, 0.5, 1, Number.NaN]);
  const pcm = speechSegmentToPcm16(samples);
  assert.deepEqual([...samples], [0, 0, 0, 0, 0, 0]);
  const view = new DataView(pcm.buffer);
  assert.deepEqual(Array.from({ length: 6 }, (_unused, index) => view.getInt16(index * 2, true)), [-32768, -16384, 0, 16384, 32767, 0]);
});

test('Sherpa Whisper decodes sequential VAD segments only and keeps activity separate from transcript data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-vad-whisper-test-'));
  const modelPath = join(directory, 'silero_vad.onnx');
  const vadModelPath = join(directory, 'whisper-model.onnx');
  await Promise.all([writeFile(modelPath, 'external vad fixture'), writeFile(vadModelPath, 'external whisper fixture')]);
  let decodedSamples = 0;
  const runtime: SherpaRuntime = {
    Vad: FakeDetector,
    OfflineRecognizer: {
      async createAsync() {
        return {
          createStream: () => ({ acceptWaveform: ({ samples }) => { decodedSamples += samples.length; } }),
          decodeAsync: async () => ({ text: 'frase reconocida' }),
        };
      },
    },
  };
  try {
    const provider = new SherpaWhisperSTTProvider(
      { encoder: vadModelPath, decoder: vadModelPath, tokens: vadModelPath },
      runtime,
      { modelPath },
    );
    const session = await provider.start({ sessionId: 'vad-test' }, { signal: new AbortController().signal, correlationId: 'vad-test' });
    const collecting = (async () => {
      const events = [];
      for await (const event of session.events()) events.push(event);
      return events;
    })();
    const chunk = (sequence: number, sample: number) => ({
      data: pcmFrame(sample),
      format: { encoding: 'pcm_s16le' as const, sampleRateHz: 16000, channels: 1 },
      sequence,
      capturedAt: new Date(0).toISOString(),
    });
    await session.pushAudio(chunk(0, 100)); // low-level non-speech
    await session.pushAudio(chunk(1, 2000)); // possible noise, only RMS auxiliary
    await session.pushAudio(chunk(2, 8000)); // detected speech
    await session.pushAudio(chunk(3, 0)); // end after silence window
    await session.pushAudio(chunk(4, 9000)); // sequential utterance
    await session.pushAudio(chunk(5, 0));
    await session.endInput();
    const events = await collecting;
    assert.equal(events[0]?.type, 'possible_noise');
    const starts = events.filter((event) => event.type === 'speech_start');
    const ends = events.filter((event) => event.type === 'speech_end');
    const finals = events.filter((event) => event.type === 'final');
    assert.equal(starts.length, 2);
    assert.equal(ends.length, 2);
    assert.equal(finals.length, 2);
    assert.deepEqual(new Set(starts.map((event) => event.segmentId)), new Set(ends.map((event) => event.segmentId)));
    assert.deepEqual(new Set(starts.map((event) => event.segmentId)), new Set(finals.map((event) => event.segmentId)));
    assert.deepEqual(finals.map((event) => event.text), ['frase reconocida', 'frase reconocida']);
    assert.equal(decodedSamples, 1024);
    await session.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('opt-in VAD aggregation decodes multiple bounded fragments once at endInput', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-vad-aggregate-test-'));
  const vadPath = join(directory, 'silero_vad.onnx');
  const whisperPath = join(directory, 'whisper-model.onnx');
  await Promise.all([writeFile(vadPath, 'vad fixture'), writeFile(whisperPath, 'whisper fixture')]);
  let decodeCalls = 0;
  let accepted: Float32Array | undefined;
  const runtime: SherpaRuntime = {
    Vad: FakeDetector,
    OfflineRecognizer: {
      async createAsync() {
        return {
          createStream: () => ({ acceptWaveform: ({ samples }) => { accepted = samples.slice(); } }),
          async decodeAsync() { decodeCalls += 1; return { text: 'una frase completa' }; },
        };
      },
    },
  };
  try {
    const provider = new SherpaWhisperSTTProvider(
      { encoder: whisperPath, decoder: whisperPath, tokens: whisperPath }, runtime, { modelPath: vadPath },
    );
    const session = await provider.start({ sessionId: 'aggregate', aggregateVadSegments: true }, {
      signal: new AbortController().signal, correlationId: 'aggregate',
    });
    const collecting = (async () => {
      const events = [];
      for await (const event of session.events()) events.push(event);
      return events;
    })();
    const chunk = (sequence: number, sample: number) => ({
      data: pcmFrame(sample), format: { encoding: 'pcm_s16le' as const, sampleRateHz: 16000, channels: 1 }, sequence, capturedAt: '',
    });
    await session.pushAudio(chunk(0, 8000));
    await session.pushAudio(chunk(1, 0));
    await session.pushAudio(chunk(2, 16000));
    await session.pushAudio(chunk(3, 0));
    await session.pushAudio(chunk(4, 24000));
    await session.pushAudio(chunk(5, 0));
    assert.equal(decodeCalls, 0, 'finalized pauses must remain buffered until capture end');
    await session.endInput();
    const events = await collecting;
    assert.equal(decodeCalls, 1);
    assert.equal(accepted?.length, 1536);
    assert.ok(accepted?.slice(0, 512).every((sample) => Math.abs(sample - (8000 / 32767)) < 1e-6));
    assert.ok(accepted?.slice(512, 1024).every((sample) => Math.abs(sample - (16000 / 32767)) < 1e-6));
    assert.ok(accepted?.slice(1024).every((sample) => Math.abs(sample - (24000 / 32767)) < 1e-6));
    const finals = events.filter((event) => event.type === 'final');
    assert.equal(finals.length, 1);
    assert.deepEqual(finals[0], { type: 'final', text: 'una frase completa' });
    assert.equal(events.filter((event) => event.type === 'speech_start').length, 3);
    assert.equal(events.filter((event) => event.type === 'speech_end').length, 3);
    await session.close();
    accepted?.fill(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('opt-in VAD aggregation preserves a short valid utterance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-vad-aggregate-short-'));
  const vadPath = join(directory, 'silero_vad.onnx');
  const whisperPath = join(directory, 'whisper-model.onnx');
  await Promise.all([writeFile(vadPath, 'vad fixture'), writeFile(whisperPath, 'whisper fixture')]);
  let decodedSamples = 0;
  const runtime: SherpaRuntime = {
    Vad: FakeDetector,
    OfflineRecognizer: {
      async createAsync() {
        return {
          createStream: () => ({ acceptWaveform: ({ samples }) => { decodedSamples = samples.length; } }),
          async decodeAsync() { return { text: 'sí' }; },
        };
      },
    },
  };
  try {
    const provider = new SherpaWhisperSTTProvider(
      { encoder: whisperPath, decoder: whisperPath, tokens: whisperPath }, runtime, { modelPath: vadPath },
    );
    const session = await provider.start({ sessionId: 'short', aggregateVadSegments: true }, {
      signal: new AbortController().signal, correlationId: 'short',
    });
    const collecting = (async () => {
      const events = [];
      for await (const event of session.events()) events.push(event);
      return events;
    })();
    await session.pushAudio({ data: pcmFrame(8000), format: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 }, sequence: 0, capturedAt: '' });
    await session.pushAudio({ data: pcmFrame(0), format: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 }, sequence: 1, capturedAt: '' });
    await session.endInput();
    const events = await collecting;
    assert.equal(decodedSamples, 512);
    assert.deepEqual(events.filter((event) => event.type === 'final'), [{ type: 'final', text: 'sí' }]);
    await session.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('cancelling pending aggregate audio prevents a later decode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-vad-aggregate-cancel-'));
  const vadPath = join(directory, 'silero_vad.onnx');
  const whisperPath = join(directory, 'whisper-model.onnx');
  await Promise.all([writeFile(vadPath, 'vad fixture'), writeFile(whisperPath, 'whisper fixture')]);
  let decodeCalls = 0;
  const runtime: SherpaRuntime = {
    Vad: FakeDetector,
    OfflineRecognizer: {
      async createAsync() {
        return {
          createStream: () => ({ acceptWaveform() {} }),
          async decodeAsync() { decodeCalls += 1; return { text: 'stale' }; },
        };
      },
    },
  };
  try {
    const provider = new SherpaWhisperSTTProvider(
      { encoder: whisperPath, decoder: whisperPath, tokens: whisperPath }, runtime, { modelPath: vadPath },
    );
    const session = await provider.start({ sessionId: 'cancel', aggregateVadSegments: true }, {
      signal: new AbortController().signal, correlationId: 'cancel',
    });
    await session.pushAudio({ data: pcmFrame(8000), format: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 }, sequence: 0, capturedAt: '' });
    await session.pushAudio({ data: pcmFrame(0), format: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 }, sequence: 1, capturedAt: '' });
    await session.cancel();
    await session.endInput();
    assert.equal(decodeCalls, 0);
    await session.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('aggregate decode failure releases buffered audio and does not schedule a stale retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-vad-aggregate-error-'));
  const vadPath = join(directory, 'silero_vad.onnx');
  const whisperPath = join(directory, 'whisper-model.onnx');
  await Promise.all([writeFile(vadPath, 'vad fixture'), writeFile(whisperPath, 'whisper fixture')]);
  let decodeCalls = 0;
  const runtime: SherpaRuntime = {
    Vad: FakeDetector,
    OfflineRecognizer: {
      async createAsync() {
        return {
          createStream: () => ({ acceptWaveform() {} }),
          async decodeAsync() { decodeCalls += 1; throw new Error('synthetic decoder failure'); },
        };
      },
    },
  };
  try {
    const provider = new SherpaWhisperSTTProvider(
      { encoder: whisperPath, decoder: whisperPath, tokens: whisperPath }, runtime, { modelPath: vadPath },
    );
    const session = await provider.start({ sessionId: 'aggregate-error', aggregateVadSegments: true }, {
      signal: new AbortController().signal, correlationId: 'aggregate-error',
    });
    const collecting = (async () => {
      const events = [];
      for await (const event of session.events()) events.push(event);
      return events;
    })();
    await session.pushAudio({ data: pcmFrame(8000), format: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 }, sequence: 0, capturedAt: '' });
    await session.pushAudio({ data: pcmFrame(0), format: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 }, sequence: 1, capturedAt: '' });
    await assert.rejects(session.endInput(), (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_STT_ERROR');
    const events = await collecting;
    assert.equal(decodeCalls, 1);
    assert.equal(events.some((event) => event.type === 'final'), false);
    await session.cancel();
    await session.close();
    assert.equal(decodeCalls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('opt-in STT diagnostics trace a VAD segment through Whisper without exposing audio or transcript text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-vad-stt-diagnostics-'));
  const vadPath = join(directory, 'silero_vad.onnx');
  const whisperPath = join(directory, 'whisper-model.onnx');
  await Promise.all([writeFile(vadPath, 'vad fixture'), writeFile(whisperPath, 'whisper fixture')]);
  const diagnostics: SherpaSttDiagnosticEvent[] = [];
  const runtime: SherpaRuntime = {
    Vad: FakeDetector,
    OfflineRecognizer: {
      async createAsync() {
        return {
          createStream: () => ({ acceptWaveform() {} }),
          async decodeAsync() { return { text: 'private transcript must not be diagnostic data' }; },
        };
      },
    },
  };
  try {
    const provider = new SherpaWhisperSTTProvider(
      { encoder: whisperPath, decoder: whisperPath, tokens: whisperPath },
      runtime,
      { modelPath: vadPath },
      { onDiagnostic: (event) => diagnostics.push(event) },
    );
    const session = await provider.start({ sessionId: 'diagnostics' }, {
      signal: new AbortController().signal,
      correlationId: 'diagnostics',
    });
    const collecting = (async () => {
      const events = [];
      for await (const event of session.events()) events.push(event);
      return events;
    })();
    await session.pushAudio({ data: pcmFrame(8000), format: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 }, sequence: 0, capturedAt: '' });
    await session.pushAudio({ data: pcmFrame(0), format: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 }, sequence: 1, capturedAt: '' });
    await session.endInput();
    await collecting;
    assert.deepEqual(diagnostics.map(({ stage }) => stage), [
      'stt-recognizer-created', 'vad-feed-started', 'vad-speech-start', 'vad-speech-end', 'segment-finalized',
      'stt-input-prepared', 'stt-accept-waveform-started', 'stt-accept-waveform-completed', 'stt-decode-started',
      'stt-decode-completed', 'stt-result-read', 'final-transcript-available',
    ]);
    const segment = diagnostics.find(({ stage }) => stage === 'segment-finalized');
    assert.equal(segment?.sampleCount, 512);
    assert.equal(segment?.durationMs, 32);
    assert.equal(JSON.stringify(diagnostics).includes('private transcript'), false);
    await session.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('opt-in STT diagnostics preserve the decode boundary and safe native error metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-vad-stt-error-diagnostics-'));
  const vadPath = join(directory, 'silero_vad.onnx');
  const whisperPath = join(directory, 'whisper-model.onnx');
  await Promise.all([writeFile(vadPath, 'vad fixture'), writeFile(whisperPath, 'whisper fixture')]);
  const diagnostics: SherpaSttDiagnosticEvent[] = [];
  const runtime: SherpaRuntime = {
    Vad: FakeDetector,
    OfflineRecognizer: {
      async createAsync() {
        return {
          createStream: () => ({ acceptWaveform() {} }),
          async decodeAsync() { throw Object.assign(new Error('native decode rejected input'), { code: 'DECODE_FAILED' }); },
        };
      },
    },
  };
  try {
    const provider = new SherpaWhisperSTTProvider(
      { encoder: whisperPath, decoder: whisperPath, tokens: whisperPath }, runtime, { modelPath: vadPath },
      { onDiagnostic: (event) => diagnostics.push(event) },
    );
    const session = await provider.start({ sessionId: 'diagnostics-error' }, {
      signal: new AbortController().signal,
      correlationId: 'diagnostics-error',
    });
    const collecting = (async () => {
      const events = [];
      for await (const event of session.events()) events.push(event);
      return events;
    })();
    await session.pushAudio({ data: pcmFrame(8000), format: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 }, sequence: 0, capturedAt: '' });
    await session.pushAudio({ data: pcmFrame(0), format: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 }, sequence: 1, capturedAt: '' });
    await assert.rejects(session.endInput(), (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_STT_ERROR');
    await collecting;
    assert.deepEqual(diagnostics.at(-1), {
      stage: 'error', operation: 'vad-segment-decode', code: 'DECODE_FAILED', message: 'native decode rejected input',
    });
    assert.ok(diagnostics.some(({ stage }) => stage === 'stt-decode-started'));
    assert.equal(diagnostics.some(({ stage }) => stage === 'stt-decode-completed'), false);
    await session.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('VAD model prepared before capture is reused for the PTT session instead of initialized twice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-vad-prepare-test-'));
  const vadPath = join(directory, 'silero_vad.onnx');
  const whisperPath = join(directory, 'whisper-model.onnx');
  await Promise.all([writeFile(vadPath, 'vad fixture'), writeFile(whisperPath, 'stt fixture')]);
  let vadCreations = 0;
  const runtime: SherpaRuntime = {
    Vad: class extends FakeDetector { constructor() { super(); vadCreations += 1; } },
    OfflineRecognizer: {
      async createAsync() {
        return { createStream: () => ({ acceptWaveform() {} }), async decodeAsync() { return { text: '' }; } };
      },
    },
  };
  try {
    const provider = new SherpaWhisperSTTProvider(
      { encoder: whisperPath, decoder: whisperPath, tokens: whisperPath },
      runtime,
      { modelPath: vadPath },
    );
    await provider.prepare();
    assert.equal(vadCreations, 1);
    const session = await provider.start({ sessionId: 'prepared-vad' }, { signal: new AbortController().signal, correlationId: 'prepared-vad' });
    assert.equal(vadCreations, 1);
    await session.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('silence and possible noise complete as no-speech without invoking Whisper or emitting a transcript', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-vad-no-speech-test-'));
  const vadPath = join(directory, 'silero_vad.onnx');
  const whisperPath = join(directory, 'whisper-model.onnx');
  await Promise.all([writeFile(vadPath, 'vad fixture'), writeFile(whisperPath, 'stt fixture')]);
  let decodedSamples = 0;
  const runtime: SherpaRuntime = {
    Vad: FakeDetector,
    OfflineRecognizer: {
      async createAsync() {
        return {
          createStream: () => ({ acceptWaveform: ({ samples }) => { decodedSamples += samples.length; } }),
          async decodeAsync() { return { text: '' }; },
        };
      },
    },
  };
  try {
    const provider = new SherpaWhisperSTTProvider(
      { encoder: whisperPath, decoder: whisperPath, tokens: whisperPath },
      runtime,
      { modelPath: vadPath },
    );
    const session = await provider.start({ sessionId: 'noise-only' }, { signal: new AbortController().signal, correlationId: 'noise-only' });
    const collecting = (async () => {
      const events = [];
      for await (const event of session.events()) events.push(event);
      return events;
    })();
    await session.pushAudio({
      data: pcmFrame(2000),
      format: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 },
      sequence: 0,
      capturedAt: new Date(0).toISOString(),
    });
    await session.pushAudio({
      data: pcmFrame(0),
      format: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 },
      sequence: 1,
      capturedAt: new Date(0).toISOString(),
    });
    await session.endInput();
    assert.deepEqual(await collecting, [{ type: 'possible_noise' }, { type: 'no_speech' }]);
    assert.equal(decodedSamples, 0);
    await session.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
