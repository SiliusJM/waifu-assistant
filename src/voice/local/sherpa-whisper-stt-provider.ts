import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { BoundedAsyncQueue } from '../bounded-async-queue.js';
import { VoiceError } from '../voice-errors.js';
import type { AudioChunk, VoiceProviderOptions } from '../voice-types.js';
import { CANONICAL_AUDIO_FORMAT } from '../voice-types.js';
import type { STTStartRequest, StreamingSTTProvider, StreamingSTTSession, StreamingTranscriptionEvent } from '../streaming-types.js';
import { SherpaSileroVad, type SherpaVadRuntime } from './sherpa-silero-vad.js';

const MAX_SECONDS = 30;
const MAX_SAMPLES = CANONICAL_AUDIO_FORMAT.sampleRateHz * MAX_SECONDS;

interface SherpaStream {
  acceptWaveform(value: { readonly samples: Float32Array; readonly sampleRate: number }): void;
}

interface SherpaRecognizer {
  createStream(): SherpaStream;
  decodeAsync(stream: SherpaStream): Promise<{ readonly text?: string }>;
}

export interface SherpaRuntime extends SherpaVadRuntime {
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

/** Metadata-only, opt-in trace for diagnosing a local STT operation. */
export type SherpaSttDiagnosticStage =
  | 'vad-feed-started'
  | 'vad-speech-start'
  | 'vad-speech-end'
  | 'segment-finalized'
  | 'stt-input-prepared'
  | 'stt-recognizer-created'
  | 'stt-accept-waveform-started'
  | 'stt-accept-waveform-completed'
  | 'stt-decode-started'
  | 'stt-decode-completed'
  | 'stt-result-read'
  | 'final-transcript-available'
  | 'error';

export interface SherpaSttDiagnosticEvent {
  readonly stage: SherpaSttDiagnosticStage;
  /** Segment metadata only; never waveform values or transcript text. */
  readonly sampleCount?: number;
  readonly durationMs?: number;
  /** A typed or native safe code where one is available. */
  readonly code?: string;
  readonly operation?: string;
  /** Sanitized library message, bounded and with filesystem paths redacted. */
  readonly message?: string;
}

export interface SherpaSttDiagnosticOptions {
  readonly onDiagnostic?: (event: SherpaSttDiagnosticEvent) => void;
}

function safeDiagnosticField(error: unknown, field: 'code' | 'operation'): string | undefined {
  if (error instanceof VoiceError && field === 'code') return error.code;
  try {
    if (typeof error !== 'object' || error === null || !(field in error)) return undefined;
    const value = (error as Record<string, unknown>)[field];
    if (typeof value !== 'string') return undefined;
    const allowed = field === 'code' ? /^[A-Z][A-Z0-9_]{0,63}$/u : /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
    return allowed.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function safeDiagnosticMessage(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.message) return undefined;
  const sanitized = error.message
    .replace(/(?:[A-Za-z]:)?[\\/][^\s"']+/gu, '<path>')
    .replace(/\b(?:authorization|api[_-]?key|token|password)\b\s*[:=]\s*\S+/giu, '<redacted>');
  return sanitized.length <= 160 ? sanitized : undefined;
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
  private readonly output = new BoundedAsyncQueue<StreamingTranscriptionEvent>(2);
  private chunks: Float32Array[] = [];
  private sampleCount = 0;
  private vadDecodeQueue: Promise<void> = Promise.resolve();
  private vadDecodeError: VoiceError | undefined;
  private vadFinalCount = 0;
  private finalizedSegmentCount = 0;
  private vadSegmentSequence = 0;
  private activeVadSegmentId: string | undefined;
  private vadFeedReported = false;
  private ended = false;
  private closed = false;

  constructor(
    private readonly recognizer: SherpaRecognizer,
    private readonly signal: AbortSignal,
    private readonly vad?: SherpaSileroVad,
    private readonly onDiagnostic?: (event: SherpaSttDiagnosticEvent) => void,
  ) {}

  private report(stage: SherpaSttDiagnosticStage, details: Omit<SherpaSttDiagnosticEvent, 'stage'> = {}): void {
    if (!this.onDiagnostic) return;
    try { this.onDiagnostic({ stage, ...details }); } catch { /* Observation must not affect STT. */ }
  }

  private reportError(operation: string, error: unknown): void {
    this.report('error', {
      operation,
      ...(safeDiagnosticField(error, 'code') ? { code: safeDiagnosticField(error, 'code') } : {}),
      ...(safeDiagnosticMessage(error) ? { message: safeDiagnosticMessage(error) } : {}),
    });
  }

  async pushAudio(chunk: AudioChunk): Promise<void> {
    if (this.closed || this.ended || this.signal.aborted) throw new VoiceError('Local transcription was cancelled.', 'VOICE_CANCELLATION_ERROR');
    if (chunk.format.encoding !== 'pcm_s16le' || chunk.format.sampleRateHz !== 16000 || chunk.format.channels !== 1
      || chunk.data.byteLength % 2 !== 0) throw new VoiceError('Local STT requires 16 kHz mono PCM audio.', 'VOICE_AUDIO_FORMAT_ERROR');
    const count = chunk.data.byteLength / 2;
    if (this.sampleCount + count > MAX_SAMPLES) throw new VoiceError('Local STT input exceeded its duration limit.', 'VOICE_BACKPRESSURE_ERROR');
    this.sampleCount += count;
    if (this.vad) {
      if (!this.vadFeedReported) {
        this.vadFeedReported = true;
        this.report('vad-feed-started');
      }
      let transitions;
      try {
        transitions = this.vad.pushPcm16(chunk.data);
      } catch (error) {
        this.reportError('vad-feed', error);
        throw error;
      }
      for (const transition of transitions) {
        if (transition.speechStarted) {
          this.report('vad-speech-start');
          this.activeVadSegmentId = `${randomUUID()}:${++this.vadSegmentSequence}`;
          await this.output.enqueue({ type: 'speech_start', segmentId: this.activeVadSegmentId }, this.signal);
        }
        if (transition.possibleNoise) await this.output.enqueue({ type: 'possible_noise' }, this.signal);
        if (transition.speechEnded) {
          this.report('vad-speech-end');
          const segmentId = this.activeVadSegmentId ?? `${randomUUID()}:${++this.vadSegmentSequence}`;
          this.activeVadSegmentId = undefined;
          await this.output.enqueue({ type: 'speech_end', segmentId }, this.signal);
          if (transition.segment) this.queueVadDecode(transition.segment, segmentId);
        } else if (transition.segment) this.queueVadDecode(transition.segment, `${randomUUID()}:${++this.vadSegmentSequence}`);
      }
      return;
    }
    const values = new Float32Array(count);
    const view = new DataView(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
    for (let index = 0; index < count; index += 1) {
      const value = view.getInt16(index * 2, true);
      values[index] = value < 0 ? value / 32768 : value / 32767;
    }
    if (count) this.chunks.push(values);
  }

  async endInput(): Promise<void> {
    if (this.ended || this.closed) return;
    this.ended = true;
    try {
      if (this.signal.aborted) throw new VoiceError('Local transcription was cancelled.', 'VOICE_CANCELLATION_ERROR');
      if (this.vad) {
        for (const transition of this.vad.flush()) {
          if (transition.speechStarted) {
            this.report('vad-speech-start');
            this.activeVadSegmentId = `${randomUUID()}:${++this.vadSegmentSequence}`;
            await this.output.enqueue({ type: 'speech_start', segmentId: this.activeVadSegmentId }, this.signal);
          }
          if (transition.possibleNoise) await this.output.enqueue({ type: 'possible_noise' }, this.signal);
          if (transition.speechEnded) {
            this.report('vad-speech-end');
            const segmentId = this.activeVadSegmentId ?? `${randomUUID()}:${++this.vadSegmentSequence}`;
            this.activeVadSegmentId = undefined;
            await this.output.enqueue({ type: 'speech_end', segmentId }, this.signal);
            if (transition.segment) this.queueVadDecode(transition.segment, segmentId);
          } else if (transition.segment) this.queueVadDecode(transition.segment, `${randomUUID()}:${++this.vadSegmentSequence}`);
        }
        await this.vadDecodeQueue;
        if (this.vadDecodeError) throw this.vadDecodeError;
        if (this.vadFinalCount === 0) await this.output.enqueue({ type: 'no_speech' }, this.signal);
        this.output.finish();
        return;
      }
      let text = '';
      if (this.sampleCount > 0) {
        const samples = new Float32Array(this.sampleCount);
        let offset = 0;
        for (const chunk of this.chunks) { samples.set(chunk, offset); offset += chunk.length; }
        this.report('stt-input-prepared', {
          sampleCount: samples.length,
          durationMs: Math.round((samples.length / CANONICAL_AUDIO_FORMAT.sampleRateHz) * 1000),
        });
        const stream = this.recognizer.createStream();
        this.report('stt-accept-waveform-started');
        stream.acceptWaveform({ samples, sampleRate: 16000 });
        this.report('stt-accept-waveform-completed');
        try {
          this.report('stt-decode-started');
          const result = await this.recognizer.decodeAsync(stream);
          this.report('stt-decode-completed');
          text = typeof result.text === 'string' ? result.text.trim() : '';
          this.report('stt-result-read');
        } finally {
          samples.fill(0);
        }
      }
      if (text) {
        this.report('final-transcript-available');
        await this.output.enqueue({ type: 'final', text }, this.signal);
      }
      this.output.finish();
    } catch (error) {
      // VAD segment decode already emitted its native boundary; avoid replacing it with this generic wrapper.
      if (error !== this.vadDecodeError) this.reportError('end-input', error);
      this.output.close();
      throw new VoiceError('Local speech recognition failed.', 'VOICE_STT_ERROR');
    } finally {
      this.clearAudio();
      this.vad?.close();
    }
  }

  events(): AsyncIterable<StreamingTranscriptionEvent> { return this.output; }

  async cancel(): Promise<void> { this.clearAudio(); this.vad?.close(); this.output.close(); }

  async close(): Promise<void> { this.closed = true; this.clearAudio(); this.vad?.close(); this.output.close(); }

  canCompleteAfterCaptureError(): boolean {
    return !this.closed && !this.signal.aborted && this.finalizedSegmentCount > 0;
  }

  private queueVadDecode(samples: Float32Array, segmentId: string): void {
    this.finalizedSegmentCount += 1;
    this.report('segment-finalized', {
      sampleCount: samples.length,
      durationMs: Math.round((samples.length / CANONICAL_AUDIO_FORMAT.sampleRateHz) * 1000),
    });
    this.vadDecodeQueue = this.vadDecodeQueue.then(async () => {
      if (this.signal.aborted || this.closed || this.vadDecodeError) { samples.fill(0); return; }
      try {
        this.report('stt-input-prepared', {
          sampleCount: samples.length,
          durationMs: Math.round((samples.length / CANONICAL_AUDIO_FORMAT.sampleRateHz) * 1000),
        });
        const stream = this.recognizer.createStream();
        this.report('stt-accept-waveform-started');
        stream.acceptWaveform({ samples, sampleRate: CANONICAL_AUDIO_FORMAT.sampleRateHz });
        this.report('stt-accept-waveform-completed');
        this.report('stt-decode-started');
        const result = await this.recognizer.decodeAsync(stream);
        this.report('stt-decode-completed');
        const text = typeof result.text === 'string' ? result.text.trim() : '';
        this.report('stt-result-read');
        if (text && !this.signal.aborted && !this.closed) {
          this.report('final-transcript-available');
          await this.output.enqueue({ type: 'final', text, segmentId }, this.signal);
          this.vadFinalCount += 1;
        }
      } catch (error) {
        this.reportError('vad-segment-decode', error);
        this.vadDecodeError = new VoiceError('Local speech recognition failed.', 'VOICE_STT_ERROR');
        this.output.close();
      } finally {
        samples.fill(0);
      }
    });
  }

  private clearAudio(): void {
    for (const chunk of this.chunks) chunk.fill(0);
    this.chunks = [];
    this.sampleCount = 0;
  }
}

export class SherpaWhisperSTTProvider implements StreamingSTTProvider {
  readonly name = 'sherpa-onnx-whisper-local';
  private readonly recognizerPromises = new Map<string, Promise<SherpaRecognizer>>();
  private preparedVad: SherpaSileroVad | undefined;

  constructor(
    private readonly model: SherpaWhisperModelPaths,
    private readonly runtime?: SherpaRuntime,
    private readonly vad?: { readonly modelPath: string; readonly minSilenceMs?: number },
    private readonly diagnostic: SherpaSttDiagnosticOptions = {},
  ) {}

  /** Explicitly invoked on /listen, before opening the microphone, never during app startup. */
  async prepare(language = 'auto'): Promise<void> {
    await this.getRecognizer(language);
    if (this.vad && !this.preparedVad) {
      this.preparedVad = await SherpaSileroVad.create({
        modelPath: this.vad.modelPath,
        minSilenceMs: this.vad.minSilenceMs,
        runtime: this.runtime,
      });
    }
  }

  async start(request: STTStartRequest, options: VoiceProviderOptions): Promise<StreamingSTTSession> {
    if (!request.sessionId.trim()) throw new VoiceError('A voice session is required.', 'VOICE_CONFIGURATION_ERROR');
    if (options.signal.aborted) throw new VoiceError('Local transcription was cancelled.', 'VOICE_CANCELLATION_ERROR');
    const recognizer = await this.getRecognizer(request.language ?? 'auto');
    if (options.signal.aborted) throw new VoiceError('Local transcription was cancelled.', 'VOICE_CANCELLATION_ERROR');
    const vad = this.preparedVad ?? (this.vad ? await SherpaSileroVad.create({
      modelPath: this.vad.modelPath,
      minSilenceMs: this.vad.minSilenceMs,
      runtime: this.runtime,
    }) : undefined);
    this.preparedVad = undefined;
    if (options.signal.aborted) {
      vad?.close();
      throw new VoiceError('Local transcription was cancelled.', 'VOICE_CANCELLATION_ERROR');
    }
    this.report({ stage: 'stt-recognizer-created' });
    return new SherpaWhisperSession(recognizer, options.signal, vad, this.diagnostic.onDiagnostic);
  }

  private report(event: SherpaSttDiagnosticEvent): void {
    try { this.diagnostic.onDiagnostic?.(event); } catch { /* Diagnostics are observational only. */ }
  }

  private getRecognizer(language: string): Promise<SherpaRecognizer> {
    if (language !== 'auto' && !/^[a-z]{2,3}$/iu.test(language)) {
      return Promise.reject(new VoiceError('The STT language is invalid.', 'VOICE_CONFIGURATION_ERROR'));
    }
    const existing = this.recognizerPromises.get(language);
    if (existing) return existing;
    const pending = Promise.all([
      requireModelFile(this.model.encoder), requireModelFile(this.model.decoder), requireModelFile(this.model.tokens),
    ]).then(async () => {
      const sherpa = this.runtime ?? loadRuntime();
      return sherpa.OfflineRecognizer.createAsync({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          // Sherpa-ONNX Whisper uses an empty language hint for multilingual autodetection.
          whisper: { encoder: this.model.encoder, decoder: this.model.decoder, language: language === 'auto' ? '' : language, task: 'transcribe' },
          tokens: this.model.tokens,
          numThreads: 2,
          provider: 'cpu',
        },
      });
    }).catch((error: unknown) => {
      if (this.recognizerPromises.get(language) === pending) this.recognizerPromises.delete(language);
      if (error instanceof VoiceError) throw error;
      throw new VoiceError('The local speech model could not be initialized.', 'VOICE_STT_ERROR');
    });
    this.recognizerPromises.set(language, pending);
    return pending;
  }
}
