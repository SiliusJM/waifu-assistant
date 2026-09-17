import {
  CANONICAL_AUDIO_FORMAT,
  type AudioArtifact,
  type AudioChunk,
  type AudioInputProvider,
  type AudioOutputProvider,
  type STTProvider,
  type SynthesisRequest,
  type TranscriptionEvent,
  type TTSProvider,
  type VoiceProviderOptions,
} from './voice-types.js';

export interface MockAudioInputProviderOptions {
  readonly chunks?: readonly Uint8Array[];
  readonly delayMs?: number;
  readonly failure?: Error;
}

export interface MockSTTProviderOptions {
  readonly partials?: readonly string[];
  readonly finalText?: string;
  readonly delayMs?: number;
  readonly failure?: Error;
}

export interface MockTTSProviderOptions {
  readonly audio?: Uint8Array;
  readonly delayMs?: number;
  readonly failure?: Error;
}

export interface MockAudioOutputProviderOptions {
  readonly delayMs?: number;
  readonly failure?: Error;
}

function abortError(): Error {
  const error = new Error('The mock voice provider was cancelled.');
  error.name = 'AbortError';
  return error;
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function validateDelay(delayMs: number): void {
  if (!Number.isInteger(delayMs) || delayMs < 0) {
    throw new RangeError('Mock voice provider delay must be a non-negative integer.');
  }
}

export class MockAudioInputProvider implements AudioInputProvider {
  readonly name = 'mock-audio-input';
  private readonly chunks: readonly Uint8Array[];
  private readonly delayMs: number;
  private readonly failure?: Error;
  private stopCountValue = 0;

  constructor(options: MockAudioInputProviderOptions = {}) {
    this.chunks = options.chunks ?? [new Uint8Array([0, 1, 2, 3])];
    this.delayMs = options.delayMs ?? 0;
    this.failure = options.failure;
    validateDelay(this.delayMs);
  }

  get stopCount(): number { return this.stopCountValue; }

  async *capture(options: VoiceProviderOptions): AsyncIterable<AudioChunk> {
    if (this.failure) throw this.failure;
    for (const [sequence, data] of this.chunks.entries()) {
      if (this.delayMs > 0) await wait(this.delayMs, options.signal);
      if (options.signal.aborted) throw abortError();
      yield {
        data: new Uint8Array(data),
        format: CANONICAL_AUDIO_FORMAT,
        sequence,
        capturedAt: new Date().toISOString(),
      };
    }
  }

  async stop(): Promise<void> { this.stopCountValue += 1; }
}

export class MockSTTProvider implements STTProvider {
  readonly name = 'mock-stt';
  private readonly partials: readonly string[];
  private readonly finalText: string;
  private readonly delayMs: number;
  private readonly failure?: Error;

  constructor(options: MockSTTProviderOptions = {}) {
    this.partials = options.partials ?? ['hel'];
    this.finalText = options.finalText ?? 'hello';
    this.delayMs = options.delayMs ?? 0;
    this.failure = options.failure;
    validateDelay(this.delayMs);
  }

  async *transcribe(
    audio: AsyncIterable<AudioChunk>,
    options: VoiceProviderOptions,
  ): AsyncIterable<TranscriptionEvent> {
    for await (const _chunk of audio) {
      void _chunk;
      if (options.signal.aborted) throw abortError();
    }
    if (this.failure) throw this.failure;
    for (const text of this.partials) {
      if (this.delayMs > 0) await wait(this.delayMs, options.signal);
      yield { type: 'partial', text };
    }
    if (this.delayMs > 0) await wait(this.delayMs, options.signal);
    yield { type: 'final', text: this.finalText };
  }
}

export class MockTTSProvider implements TTSProvider {
  readonly name = 'mock-tts';
  private readonly audio: Uint8Array;
  private readonly delayMs: number;
  private readonly failure?: Error;

  constructor(options: MockTTSProviderOptions = {}) {
    this.audio = options.audio ?? new Uint8Array([1, 2, 3, 4]);
    this.delayMs = options.delayMs ?? 0;
    this.failure = options.failure;
    validateDelay(this.delayMs);
  }

  async synthesize(_request: SynthesisRequest, options: VoiceProviderOptions): Promise<AudioArtifact> {
    if (this.delayMs > 0) await wait(this.delayMs, options.signal);
    if (this.failure) throw this.failure;
    if (options.signal.aborted) throw abortError();
    return {
      data: new Uint8Array(this.audio),
      format: CANONICAL_AUDIO_FORMAT,
      durationMs: 100,
    };
  }
}

export class MockAudioOutputProvider implements AudioOutputProvider {
  readonly name = 'mock-audio-output';
  private readonly delayMs: number;
  private readonly failure?: Error;
  private readonly playedValue: AudioArtifact[] = [];
  private stopCountValue = 0;

  constructor(options: MockAudioOutputProviderOptions = {}) {
    this.delayMs = options.delayMs ?? 0;
    this.failure = options.failure;
    validateDelay(this.delayMs);
  }

  get played(): readonly AudioArtifact[] { return this.playedValue.slice(); }
  get stopCount(): number { return this.stopCountValue; }

  async play(audio: AudioArtifact, options: VoiceProviderOptions): Promise<void> {
    if (this.delayMs > 0) await wait(this.delayMs, options.signal);
    if (this.failure) throw this.failure;
    if (options.signal.aborted) throw abortError();
    this.playedValue.push(audio);
  }

  async stop(): Promise<void> { this.stopCountValue += 1; }
}
