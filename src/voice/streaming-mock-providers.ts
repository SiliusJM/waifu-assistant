import { BoundedAsyncQueue } from './bounded-async-queue.js';
import { VoiceError } from './voice-errors.js';
import { CANONICAL_AUDIO_FORMAT } from './voice-types.js';
import type { AudioChunk, TranscriptionEvent, VoiceProviderOptions } from './voice-types.js';
import type {
  AudioInputStream,
  AudioPlaybackHandle,
  AudioStreamChunk,
  AudioStreamResult,
  StreamingAudioInputProvider,
  StreamingAudioOutputProvider,
  StreamingSTTProvider,
  StreamingSTTSession,
  StreamingSynthesisRequest,
  StreamingTTSOperation,
  StreamingTTSProvider,
  STTStartRequest,
} from './streaming-types.js';

function abortError(): Error {
  const error = new Error('The mock streaming provider was cancelled.');
  error.name = 'AbortError';
  return error;
}

function validateDelay(delayMs: number): void {
  if (!Number.isInteger(delayMs) || delayMs < 0) throw new RangeError('Mock delay must be non-negative.');
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

export interface MockStreamingInputOptions {
  readonly chunks?: readonly Uint8Array[];
  readonly delayMs?: number;
}

export class MockStreamingAudioInputProvider implements StreamingAudioInputProvider {
  readonly name = 'mock-streaming-audio-input';
  private readonly chunks: readonly Uint8Array[];
  private readonly delayMs: number;
  private stopCountValue = 0;

  constructor(options: MockStreamingInputOptions = {}) {
    this.chunks = options.chunks ?? [new Uint8Array([0, 1]), new Uint8Array([2, 3])];
    this.delayMs = options.delayMs ?? 0;
    validateDelay(this.delayMs);
  }

  get stopCount(): number { return this.stopCountValue; }

  async startCapture(options: VoiceProviderOptions): Promise<AudioInputStream> {
    let stopped = false;
    const stream: AudioInputStream = {
      format: CANONICAL_AUDIO_FORMAT,
      chunks: async function* (this: MockStreamingAudioInputProvider): AsyncIterable<AudioChunk> {
        for (const [sequence, data] of this.chunks.entries()) {
          if (stopped || options.signal.aborted) throw abortError();
          if (this.delayMs > 0) await wait(this.delayMs, options.signal);
          yield {
            data: new Uint8Array(data),
            format: CANONICAL_AUDIO_FORMAT,
            sequence,
            capturedAt: new Date().toISOString(),
          };
        }
      }.bind(this),
      stop: async (): Promise<void> => {
        stopped = true;
        this.stopCountValue += 1;
      },
    };
    return stream;
  }
}

export interface MockStreamingSTTOptions {
  readonly finalText?: string;
  readonly delayMs?: number;
  readonly queueCapacity?: number;
}

class MockStreamingSTTSession implements StreamingSTTSession {
  private readonly input: BoundedAsyncQueue<AudioChunk>;
  private readonly output: BoundedAsyncQueue<TranscriptionEvent>;
  private readonly finalText: string;
  private readonly delayMs: number;
  private readonly signal: AbortSignal;
  private readonly completedPromise: Promise<void>;
  private resolveCompleted!: () => void;
  private settled = false;

  constructor(options: MockStreamingSTTOptions, signal: AbortSignal) {
    this.input = new BoundedAsyncQueue(options.queueCapacity ?? 8);
    this.output = new BoundedAsyncQueue(options.queueCapacity ?? 8);
    this.finalText = options.finalText ?? 'streamed final';
    this.delayMs = options.delayMs ?? 0;
    this.signal = signal;
    validateDelay(this.delayMs);
    this.completedPromise = new Promise<void>((resolve) => { this.resolveCompleted = resolve; });
    void this.consume();
  }

  async pushAudio(chunk: AudioChunk): Promise<void> {
    if (!(await this.input.enqueue(chunk, this.signal))) {
      throw new VoiceError('The mock STT input queue is closed.', 'VOICE_BACKPRESSURE_ERROR');
    }
  }

  async endInput(): Promise<void> { this.input.finish(); }
  events(): AsyncIterable<TranscriptionEvent> { return this.output; }

  async cancel(): Promise<void> {
    this.input.close();
    this.output.close();
    this.resolveOnce();
  }

  async close(): Promise<void> {
    this.input.close();
    this.output.close();
    this.resolveOnce();
    await this.completedPromise;
  }

  private async consume(): Promise<void> {
    try {
      let count = 0;
      for await (const _chunk of this.input) {
        void _chunk;
        if (this.signal.aborted) throw abortError();
        if (this.delayMs > 0) await wait(this.delayMs, this.signal);
        if (!(await this.output.enqueue({ type: 'partial', text: 'partial-' + count }, this.signal))) return;
        count += 1;
      }
      if (!this.signal.aborted) await this.output.enqueue({ type: 'final', text: this.finalText }, this.signal);
    } catch {
      // Cancellation and provider failures are surfaced through the operation signal.
    } finally {
      this.output.finish();
      this.resolveOnce();
    }
  }

  private resolveOnce(): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveCompleted();
  }
}

export class MockStreamingSTTProvider implements StreamingSTTProvider {
  readonly name = 'mock-streaming-stt';
  private readonly options: MockStreamingSTTOptions;

  constructor(options: MockStreamingSTTOptions = {}) { this.options = options; }

  async start(_request: STTStartRequest, options: VoiceProviderOptions): Promise<StreamingSTTSession> {
    return new MockStreamingSTTSession(this.options, options.signal);
  }
}

export interface MockStreamingTTSOptions {
  readonly delayMs?: number;
  readonly queueCapacity?: number;
}

class MockStreamingTTSOperation implements StreamingTTSOperation {
  private readonly input: BoundedAsyncQueue<string>;
  private readonly output: BoundedAsyncQueue<AudioStreamChunk>;
  private readonly signal: AbortSignal;
  private readonly delayMs: number;
  private readonly completedPromise: Promise<AudioStreamResult>;
  private resolveCompleted!: (result: AudioStreamResult) => void;
  private settled = false;
  private result: AudioStreamResult = {
    format: CANONICAL_AUDIO_FORMAT,
    chunkCount: 0,
    byteLength: 0,
    durationMs: 0,
  };

  constructor(options: MockStreamingTTSOptions, signal: AbortSignal) {
    const capacity = options.queueCapacity ?? 8;
    this.input = new BoundedAsyncQueue<string>(capacity);
    this.output = new BoundedAsyncQueue<AudioStreamChunk>(capacity);
    this.signal = signal;
    this.delayMs = options.delayMs ?? 0;
    validateDelay(this.delayMs);
    this.completedPromise = new Promise<AudioStreamResult>((resolve) => { this.resolveCompleted = resolve; });
    void this.consume();
  }

  async pushText(text: string): Promise<void> {
    if (!text) return;
    if (!(await this.input.enqueue(text, this.signal))) {
      throw new VoiceError('The mock TTS input queue is closed.', 'VOICE_BACKPRESSURE_ERROR');
    }
  }

  async endInput(): Promise<void> { this.input.finish(); }
  chunks(): AsyncIterable<AudioStreamChunk> { return this.output; }
  completed(): Promise<AudioStreamResult> { return this.completedPromise; }

  async cancel(): Promise<void> {
    this.input.close();
    this.output.close();
    this.resolveOnce();
  }

  async close(): Promise<void> {
    this.input.close();
    this.output.close();
    this.resolveOnce();
  }

  private async consume(): Promise<void> {
    try {
      let sequence = 0;
      for await (const text of this.input) {
        if (this.signal.aborted) throw abortError();
        if (this.delayMs > 0) await wait(this.delayMs, this.signal);
        const data = new Uint8Array([sequence & 0xff, text.length & 0xff]);
        const chunk: AudioStreamChunk = {
          data,
          format: CANONICAL_AUDIO_FORMAT,
          sequence,
          timestampMs: sequence * 20,
          durationMs: 20,
          source: 'tts',
        };
        if (!(await this.output.enqueue(chunk, this.signal))) return;
        this.result = {
          format: CANONICAL_AUDIO_FORMAT,
          chunkCount: this.result.chunkCount + 1,
          byteLength: this.result.byteLength + data.byteLength,
          durationMs: (this.result.durationMs ?? 0) + 20,
        };
        sequence += 1;
      }
    } catch {
      // The operation owns error normalization and cancellation semantics.
    } finally {
      this.output.finish();
      this.resolveOnce();
    }
  }

  private resolveOnce(): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveCompleted(this.result);
  }
}

export class MockStreamingTTSProvider implements StreamingTTSProvider {
  readonly name = 'mock-streaming-tts';
  private readonly options: MockStreamingTTSOptions;

  constructor(options: MockStreamingTTSOptions = {}) { this.options = options; }

  async startSynthesis(
    _request: StreamingSynthesisRequest,
    options: VoiceProviderOptions,
  ): Promise<StreamingTTSOperation> {
    return new MockStreamingTTSOperation(this.options, options.signal);
  }
}

export interface MockStreamingOutputOptions {
  readonly delayMs?: number;
  readonly failure?: Error;
}

export class MockStreamingAudioOutputProvider implements StreamingAudioOutputProvider {
  readonly name = 'mock-streaming-audio-output';
  private readonly delayMs: number;
  private readonly failure?: Error;
  private readonly chunksValue: AudioStreamChunk[] = [];
  private stopCountValue = 0;

  constructor(options: MockStreamingOutputOptions = {}) {
    this.delayMs = options.delayMs ?? 0;
    this.failure = options.failure;
    validateDelay(this.delayMs);
  }

  get played(): readonly AudioStreamChunk[] { return this.chunksValue.slice(); }
  get stopCount(): number { return this.stopCountValue; }

  async startPlayback(options: VoiceProviderOptions & { readonly deviceId: string }): Promise<AudioPlaybackHandle> {
    let stopped = false;
    let resolveCompleted!: () => void;
    let completed = false;
    const completedPromise = new Promise<void>((resolve) => { resolveCompleted = resolve; });
    const finish = (): void => {
      if (completed) return;
      completed = true;
      resolveCompleted();
    };
    return {
      enqueue: async (chunk): Promise<void> => {
        if (stopped || options.signal.aborted) throw abortError();
        if (this.failure) throw this.failure;
        if (this.delayMs > 0) await wait(this.delayMs, options.signal);
        this.chunksValue.push({ ...chunk, data: new Uint8Array(chunk.data) });
      },
      flush: async (): Promise<void> => { finish(); },
      stop: async (): Promise<void> => {
        stopped = true;
        this.stopCountValue += 1;
        finish();
      },
      completed: () => completedPromise,
    };
  }
}
