import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { BoundedAsyncQueue } from '../bounded-async-queue.js';
import { VoiceError } from '../voice-errors.js';
import type { AudioChunk, TranscriptionEvent, VoiceProviderOptions } from '../voice-types.js';
import { CANONICAL_AUDIO_FORMAT } from '../voice-types.js';
import type { STTStartRequest, StreamingSTTProvider, StreamingSTTSession } from '../streaming-types.js';

const MAX_SECONDS = 30;
const MAX_SAMPLES = CANONICAL_AUDIO_FORMAT.sampleRateHz * MAX_SECONDS;

interface SherpaStream {
  acceptWaveform(value: { readonly samples: Float32Array; readonly sampleRate: number }): void;
}

interface SherpaRecognizer {
  createStream(): SherpaStream;
  decodeAsync(stream: SherpaStream): Promise<{ readonly text?: string }>;
}

export interface SherpaRuntime {
  OfflineRecognizer: {
    createAsync(config: {
      readonly featConfig: { readonly sampleRate: number; readonly featureDim: number };
      readonly modelConfig: {
        readonly whisper: { readonly encoder: string; readonly decoder: string; readonly language: string; readonly task: 'transcribe' };
        readonly tokens: string;
        readonly numThreads: number;
        readonly provider: 'cpu';
      };
    }): Promise<SherpaRecognizer>;
  };
}

export interface SherpaWhisperModelPaths {
  readonly encoder: string;
  readonly decoder: string;
  readonly tokens: string;
}

function loadRuntime(): SherpaRuntime {
  try {
    return createRequire(import.meta.url)('sherpa-onnx-node') as SherpaRuntime;
  } catch {
    throw new VoiceError('The local STT engine is unavailable.', 'VOICE_STT_ERROR');
  }
}

async function requireModelFile(file: string): Promise<void> {
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
  } catch {
    throw new VoiceError('The local speech model is missing or unreadable.', 'VOICE_STT_ERROR');
  }
}

class SherpaWhisperSession implements StreamingSTTSession {
  private readonly output = new BoundedAsyncQueue<TranscriptionEvent>(2);
  private chunks: Float32Array[] = [];
  private sampleCount = 0;
  private ended = false;
  private closed = false;

  constructor(private readonly recognizer: SherpaRecognizer, private readonly signal: AbortSignal) {}

  async pushAudio(chunk: AudioChunk): Promise<void> {
    if (this.closed || this.ended || this.signal.aborted) throw new VoiceError('Local transcription was cancelled.', 'VOICE_CANCELLATION_ERROR');
    if (chunk.format.encoding !== 'pcm_s16le' || chunk.format.sampleRateHz !== 16000 || chunk.format.channels !== 1
      || chunk.data.byteLength % 2 !== 0) throw new VoiceError('Local STT requires 16 kHz mono PCM audio.', 'VOICE_AUDIO_FORMAT_ERROR');
    const count = chunk.data.byteLength / 2;
    if (this.sampleCount + count > MAX_SAMPLES) throw new VoiceError('Local STT input exceeded its duration limit.', 'VOICE_BACKPRESSURE_ERROR');
    const values = new Float32Array(count);
    const view = new DataView(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
    for (let index = 0; index < count; index += 1) {
      const value = view.getInt16(index * 2, true);
      values[index] = value < 0 ? value / 32768 : value / 32767;
    }
    this.sampleCount += count;
    if (count) this.chunks.push(values);
  }

  async endInput(): Promise<void> {
    if (this.ended || this.closed) return;
    this.ended = true;
    try {
      if (this.signal.aborted) throw new VoiceError('Local transcription was cancelled.', 'VOICE_CANCELLATION_ERROR');
      let text = '';
      if (this.sampleCount > 0) {
        const samples = new Float32Array(this.sampleCount);
        let offset = 0;
        for (const chunk of this.chunks) { samples.set(chunk, offset); offset += chunk.length; }
        const stream = this.recognizer.createStream();
        stream.acceptWaveform({ samples, sampleRate: 16000 });
        try {
          const result = await this.recognizer.decodeAsync(stream);
          text = typeof result.text === 'string' ? result.text.trim() : '';
        } finally {
          samples.fill(0);
        }
      }
      if (text) await this.output.enqueue({ type: 'final', text }, this.signal);
      this.output.finish();
    } catch {
      this.output.close();
      throw new VoiceError('Local speech recognition failed.', 'VOICE_STT_ERROR');
    } finally {
      this.clearAudio();
    }
  }

  events(): AsyncIterable<TranscriptionEvent> { return this.output; }

  async cancel(): Promise<void> { this.clearAudio(); this.output.close(); }

  async close(): Promise<void> { this.closed = true; this.clearAudio(); this.output.close(); }

  private clearAudio(): void {
    for (const chunk of this.chunks) chunk.fill(0);
    this.chunks = [];
    this.sampleCount = 0;
  }
}

export class SherpaWhisperSTTProvider implements StreamingSTTProvider {
  readonly name = 'sherpa-onnx-whisper-local';
  private recognizerPromise: Promise<SherpaRecognizer> | undefined;

  constructor(private readonly model: SherpaWhisperModelPaths, private readonly runtime?: SherpaRuntime) {}

  /** Explicitly invoked on /listen, before opening the microphone, never during app startup. */
  async prepare(language = 'es'): Promise<void> {
    await this.getRecognizer(language);
  }

  async start(request: STTStartRequest, options: VoiceProviderOptions): Promise<StreamingSTTSession> {
    if (!request.sessionId.trim()) throw new VoiceError('A voice session is required.', 'VOICE_CONFIGURATION_ERROR');
    if (options.signal.aborted) throw new VoiceError('Local transcription was cancelled.', 'VOICE_CANCELLATION_ERROR');
    const recognizer = await this.getRecognizer(request.language ?? 'es');
    if (options.signal.aborted) throw new VoiceError('Local transcription was cancelled.', 'VOICE_CANCELLATION_ERROR');
    return new SherpaWhisperSession(recognizer, options.signal);
  }

  private getRecognizer(language: string): Promise<SherpaRecognizer> {
    if (!/^[a-z]{2,3}$/iu.test(language)) return Promise.reject(new VoiceError('The STT language is invalid.', 'VOICE_CONFIGURATION_ERROR'));
    this.recognizerPromise ??= Promise.all([
      requireModelFile(this.model.encoder), requireModelFile(this.model.decoder), requireModelFile(this.model.tokens),
    ]).then(async () => {
      const sherpa = this.runtime ?? loadRuntime();
      return sherpa.OfflineRecognizer.createAsync({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          whisper: { encoder: this.model.encoder, decoder: this.model.decoder, language, task: 'transcribe' },
          tokens: this.model.tokens,
          numThreads: 2,
          provider: 'cpu',
        },
      });
    }).catch((error: unknown) => {
      this.recognizerPromise = undefined;
      if (error instanceof VoiceError) throw error;
      throw new VoiceError('The local speech model could not be initialized.', 'VOICE_STT_ERROR');
    });
    return this.recognizerPromise;
  }
}
