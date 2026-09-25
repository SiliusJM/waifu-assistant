import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { VoiceError } from '../voice-errors.js';
import type { AudioChunk, VoiceProviderOptions, VoiceTerminationReason } from '../voice-types.js';
import { CANONICAL_AUDIO_FORMAT } from '../voice-types.js';
import type { AudioInputStream, StreamingAudioInputProvider } from '../streaming-types.js';
import { CaptureQueue } from './capture-queue.js';

const TARGET_RATE = CANONICAL_AUDIO_FORMAT.sampleRateHz;
const CHUNK_SAMPLES = 1600;
const DEFAULT_MAX_DURATION_SECONDS = 30;
const DEFAULT_QUEUE_CAPACITY = 32;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

interface CpalConfig {
  channels(): number;
  sampleRate(): number;
  sampleFormat(): { value: string };
  tryWithSampleRate(rate: number): CpalConfig | null;
  tryWithStandardSampleRate(): CpalConfig | null;
  withMaxSampleRate(): CpalConfig;
}

interface CpalDevice {
  defaultInputConfig(): CpalConfig;
  supportedInputConfigs(): Iterable<CpalConfig & { containsRate(rate: number): boolean }>;
  buildInputStream(
    config: CpalConfig,
    sampleFormat: 'f32',
    onData: (samples: Float32Array) => void,
    onError: (error: { code?: string; operation?: string }) => void,
  ): { play(): void; close(): void | Promise<void> };
  close(): void | Promise<void>;
}

interface CpalHost {
  defaultInputDevice(): CpalDevice | null;
  close(): void | Promise<void>;
}

export interface CpalRuntime {
  defaultHost(): CpalHost;
  SampleFormat: { readonly F32: { readonly value: string } };
}

function loadCpal(): CpalRuntime {
  return createRequire(import.meta.url)('node-cpal') as CpalRuntime;
}

export type MicrophoneDiagnosticStage =
  | 'backend-load'
  | 'host-open'
  | 'device-select'
  | 'config-select'
  | 'config-negotiate'
  | 'stream-build'
  | 'stream-start'
  | 'stream-callback'
  | 'stream-close'
  | 'device-close'
  | 'host-close';

export interface MicrophoneDiagnosticEvent {
  readonly stage: MicrophoneDiagnosticStage;
  /** Native CPAL code only; raw messages, paths and device identifiers are intentionally omitted. */
  readonly code?: string;
  readonly operation?: string;
}

export type MicrophoneLifecycleStage =
  | 'host-created'
  | 'device-selected'
  | 'stream-created'
  | 'play-called'
  | 'first-callback'
  | 'readiness-resolved';

export interface MicrophoneLifecycleEvent {
  readonly stage: MicrophoneLifecycleStage;
  /** Monotonic milliseconds since startCapture began; contains no device identity or audio. */
  readonly elapsedMs: number;
}

function safeNativeField(error: unknown, field: 'code' | 'operation'): string | undefined {
  try {
    if (typeof error !== 'object' || error === null || !(field in error)) return undefined;
    const value: unknown = (error as Record<string, unknown>)[field];
    if (typeof value !== 'string') return undefined;
    const pattern = field === 'code' ? /^[A-Z][A-Z0-9_]{0,63}$/u : /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
    return pattern.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function convertFloatInputToPcm16Mono(
  input: Float32Array,
  channels: number,
  sampleRate: number,
  phase = 0,
): { readonly data: Uint8Array; readonly phase: number } {
  if (!Number.isInteger(channels) || channels < 1 || input.length % channels !== 0
    || !Number.isInteger(sampleRate) || sampleRate < 1) {
    throw new VoiceError('The microphone returned an unsupported audio format.', 'VOICE_AUDIO_FORMAT_ERROR');
  }
  const frames = input.length / channels;
  const samples: number[] = [];
  let nextPhase = phase;
  for (let frame = 0; frame < frames; frame += 1) {
    let mono = 0;
    for (let channel = 0; channel < channels; channel += 1) mono += input[frame * channels + channel] ?? 0;
    mono = Number.isFinite(mono) ? Math.max(-1, Math.min(1, mono / channels)) : 0;
    nextPhase += TARGET_RATE;
    if (nextPhase >= sampleRate) {
      nextPhase -= sampleRate;
      samples.push(Math.round(mono < 0 ? mono * 32768 : mono * 32767));
    }
  }
  const data = new Uint8Array(samples.length * 2);
  const view = new DataView(data.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return { data, phase: nextPhase };
}

export interface WindowsMicrophoneInputOptions {
  readonly maxDurationSeconds?: number;
  readonly queueCapacity?: number;
  readonly readinessTimeoutMs?: number;
  readonly runtime?: CpalRuntime;
  /** Opt-in, metadata-only diagnostics. The callback never receives native messages or audio. */
  readonly onDiagnostic?: (event: MicrophoneDiagnosticEvent) => void;
  /** Opt-in, metadata-only lifecycle timing. */
  readonly onLifecycle?: (event: MicrophoneLifecycleEvent) => void;
}

export class WindowsMicrophoneInputProvider implements StreamingAudioInputProvider {
  readonly name = 'windows-wasapi-microphone';
  private readonly maxDurationSamples: number;
  private readonly queueCapacity: number;
  private readonly readinessTimeoutMs: number;
  private readonly runtime?: CpalRuntime;
  private readonly onDiagnostic?: (event: MicrophoneDiagnosticEvent) => void;
  private readonly onLifecycle?: (event: MicrophoneLifecycleEvent) => void;
  private activeStop: ((reason: VoiceTerminationReason) => Promise<void>) | undefined;
  private readiness: Promise<void> | undefined;
  private resolveReadiness: (() => void) | undefined;
  private rejectReadiness: ((error: Error) => void) | undefined;
  private nextCaptureStart = deferred<{ readonly readiness: Promise<void> }>();

  constructor(options: WindowsMicrophoneInputOptions = {}) {
    const duration = options.maxDurationSeconds ?? DEFAULT_MAX_DURATION_SECONDS;
    const capacity = options.queueCapacity ?? DEFAULT_QUEUE_CAPACITY;
    const readinessTimeoutMs = options.readinessTimeoutMs ?? 5000;
    if (!Number.isInteger(duration) || duration < 1 || duration > 60
      || !Number.isInteger(capacity) || capacity < 1 || capacity > 128
      || !Number.isInteger(readinessTimeoutMs) || readinessTimeoutMs < 5000 || readinessTimeoutMs > 15000) {
      throw new VoiceError('Microphone capture limits are invalid.', 'VOICE_CONFIGURATION_ERROR');
    }
    this.maxDurationSamples = duration * TARGET_RATE;
    this.queueCapacity = capacity;
    this.readinessTimeoutMs = readinessTimeoutMs;
    this.runtime = options.runtime;
    this.onDiagnostic = options.onDiagnostic;
    this.onLifecycle = options.onLifecycle;
  }

  private reportDiagnostic(stage: MicrophoneDiagnosticStage, error?: unknown): void {
    if (!this.onDiagnostic) return;
    const code = safeNativeField(error, 'code');
    const operation = safeNativeField(error, 'operation');
    try {
      this.onDiagnostic({ stage, ...(code ? { code } : {}), ...(operation ? { operation } : {}) });
    } catch {
      // Diagnostics are observational only and must never alter capture behavior.
    }
  }

  private reportLifecycle(startedAt: number, stage: MicrophoneLifecycleStage): void {
    if (!this.onLifecycle) return;
    try {
      this.onLifecycle({ stage, elapsedMs: Math.max(0, performance.now() - startedAt) });
    } catch {
      // Lifecycle reporting is observational only and must never alter capture behavior.
    }
  }

  async startCapture(options: VoiceProviderOptions): Promise<AudioInputStream> {
    if (this.activeStop) throw new VoiceError('A microphone capture is already active.', 'VOICE_CONCURRENCY_ERROR');
    const captureStartedAt = performance.now();
    this.clearReadiness();
    this.readiness = new Promise<void>((resolve, reject) => {
      this.resolveReadiness = resolve;
      this.rejectReadiness = reject;
    });
    void this.readiness.catch(() => undefined);
    const startSignal = this.nextCaptureStart;
    this.nextCaptureStart = deferred<{ readonly readiness: Promise<void> }>();
    startSignal.resolve({ readiness: this.readiness });
    let cpal: CpalRuntime;
    try {
      cpal = this.runtime ?? loadCpal();
    } catch (error) {
      this.reportDiagnostic('backend-load', error);
      const publicError = new VoiceError('The local microphone backend is unavailable.', 'VOICE_CAPTURE_ERROR');
      this.rejectReadiness?.(publicError);
      throw publicError;
    }
    let host: CpalHost | undefined;
    let device: CpalDevice | undefined;
    let setupStage: 'host-open' | 'device-select' = 'host-open';
    try {
      host = cpal.defaultHost();
      this.reportLifecycle(captureStartedAt, 'host-created');
      setupStage = 'device-select';
      const selected = host.defaultInputDevice();
      if (!selected) {
        throw new VoiceError('No default microphone is available.', 'VOICE_CAPTURE_ERROR');
      }
      device = selected;
      this.reportLifecycle(captureStartedAt, 'device-selected');
    } catch (error) {
      this.reportDiagnostic(setupStage, error);
      try { host?.close(); } catch (closeError) { this.reportDiagnostic('host-close', closeError); }
      const publicError = error instanceof VoiceError
        ? error
        : new VoiceError('The default microphone could not be opened.', 'VOICE_CAPTURE_ERROR');
      this.rejectReadiness?.(publicError);
      throw publicError;
    }

    // The setup block above either assigns both native handles or throws.
    const captureHost = host as CpalHost;
    const captureDevice = device as CpalDevice;
    const rawQueue = new CaptureQueue<Float32Array>(this.queueCapacity);
    const queue = new CaptureQueue<AudioChunk>(this.queueCapacity);
    let stream: ReturnType<CpalDevice['buildInputStream']> | undefined;
    let sequence = 0;
    let outputSamples = 0;
    let resamplePhase = 0;
    const pending = new Int16Array(CHUNK_SAMPLES);
    let pendingLength = 0;
    let stopped = false;
    let stopping = false;
    let discarding = false;
    let rawPump: Promise<void> | undefined;
    let selectedConfig: CpalConfig | undefined;
    let releasePromise: Promise<void> | undefined;
    let readinessTimer: NodeJS.Timeout | undefined;
    let firstCallbackSeen = false;
    let readinessResolved = false;
    const clearReadinessTimer = (): void => {
      if (readinessTimer) clearTimeout(readinessTimer);
      readinessTimer = undefined;
    };
    const release = async (reason: VoiceTerminationReason): Promise<void> => {
      if (releasePromise) return releasePromise;
      if (stopped) return;
      stopping = true;
      clearReadinessTimer();
      options.signal.removeEventListener('abort', onAbort);
      let resolveRelease!: () => void;
      releasePromise = new Promise<void>((resolve) => { resolveRelease = resolve; });
      if (reason === 'completed') rawQueue.finish();
      else {
        discarding = true;
        rawQueue.discard();
        queue.discard();
      }
      queueMicrotask(() => {
        void (async () => {
          if (reason === 'completed') {
            try { await rawPump; } catch { /* The pump reports failures through the output queue. */ }
            queue.finish();
          }
          try { await stream?.close(); } catch (error) { this.reportDiagnostic('stream-close', error); }
          try { await captureDevice.close(); } catch (error) { this.reportDiagnostic('device-close', error); }
          try { await captureHost.close(); } catch (error) { this.reportDiagnostic('host-close', error); }
          stopped = true;
          stopping = false;
          if (this.activeStop === stop) this.activeStop = undefined;
          if (!readinessResolved) this.rejectReadiness?.(new VoiceError('Microphone capture ended before it became ready.', 'VOICE_CAPTURE_ERROR'));
          resolveRelease();
        })();
      });
      return releasePromise;
    };
    const stop = release;
    const onAbort = (): void => { void release('cancelled'); };
    const fail = (error: Error): void => {
      queue.fail(error);
      void release('failed');
    };
    const emitPending = (): void => {
      if (!pendingLength || stopped) return;
      const data = new Uint8Array(pendingLength * 2);
      const view = new DataView(data.buffer);
      for (let index = 0; index < pendingLength; index += 1) view.setInt16(index * 2, pending[index] ?? 0, true);
      if (!queue.push({
        data,
        format: CANONICAL_AUDIO_FORMAT,
        sequence: sequence++,
        capturedAt: new Date().toISOString(),
      })) fail(new VoiceError('Microphone capture exceeded its in-memory buffer limit.', 'VOICE_BACKPRESSURE_ERROR'));
      pendingLength = 0;
    };

    const pumpRaw = async (): Promise<void> => {
      try {
        for await (const input of rawQueue) {
          if (!selectedConfig) throw new VoiceError('The microphone configuration is unavailable.', 'VOICE_CAPTURE_ERROR');
          const converted = convertFloatInputToPcm16Mono(input, selectedConfig.channels(), selectedConfig.sampleRate(), resamplePhase);
          resamplePhase = converted.phase;
          const source = new DataView(converted.data.buffer, converted.data.byteOffset, converted.data.byteLength);
          for (let offset = 0; offset < converted.data.byteLength; offset += 2) {
            if (outputSamples >= this.maxDurationSamples) {
              fail(new VoiceError('Microphone capture reached its configured duration limit.', 'VOICE_TIMEOUT_ERROR'));
              return;
            }
            pending[pendingLength++] = source.getInt16(offset, true);
            outputSamples += 1;
            if (pendingLength === CHUNK_SAMPLES) emitPending();
            if (discarding || stopped) return;
          }
        }
        if (!discarding && !stopped && pendingLength > 0) emitPending();
      } catch (error) {
        fail(error instanceof Error ? error : new VoiceError('The microphone returned invalid audio.', 'VOICE_AUDIO_FORMAT_ERROR'));
        throw error;
      }
    };

    let stage: MicrophoneDiagnosticStage = 'config-select';
    try {
      selectedConfig = captureDevice.defaultInputConfig();
      const defaultConfig = selectedConfig;
      if (defaultConfig.sampleFormat().value !== cpal.SampleFormat.F32.value) {
        stage = 'config-negotiate';
        const floatConfig = [...captureDevice.supportedInputConfigs()].find((candidate) => (
          candidate.sampleFormat().value === cpal.SampleFormat.F32.value
          && candidate.channels() === defaultConfig.channels()
          && candidate.containsRate(defaultConfig.sampleRate())
        )) ?? [...captureDevice.supportedInputConfigs()].find((candidate) => (
          candidate.sampleFormat().value === cpal.SampleFormat.F32.value
        ));
        if (!floatConfig) throw new VoiceError('The microphone has no supported float input format.', 'VOICE_AUDIO_FORMAT_ERROR');
        selectedConfig = floatConfig.tryWithSampleRate(defaultConfig.sampleRate())
          ?? floatConfig.tryWithStandardSampleRate()
          ?? floatConfig.withMaxSampleRate();
      }
      const config = selectedConfig;
      stage = 'stream-build';
      stream = captureDevice.buildInputStream(config, 'f32', (input) => {
        if (stopping || stopped) return;
        if (!firstCallbackSeen) {
          firstCallbackSeen = true;
          this.reportLifecycle(captureStartedAt, 'first-callback');
        }
        if (input.length > 0 && !readinessResolved) {
          readinessResolved = true;
          clearReadinessTimer();
          this.reportLifecycle(captureStartedAt, 'readiness-resolved');
          this.resolveReadiness?.();
        }
        if (!rawQueue.push(new Float32Array(input))) {
          fail(new VoiceError('Microphone capture exceeded its in-memory buffer limit.', 'VOICE_BACKPRESSURE_ERROR'));
        }
      }, (error) => {
        if (stopping || stopped) return;
        this.reportDiagnostic('stream-callback', error);
        fail(new VoiceError('The microphone capture stream failed.', 'VOICE_CAPTURE_ERROR'));
      });
      this.reportLifecycle(captureStartedAt, 'stream-created');
      this.activeStop = stop;
      rawPump = pumpRaw();
      void rawPump.catch(() => undefined);
      options.signal.addEventListener('abort', onAbort, { once: true });
      if (options.signal.aborted) onAbort();
      else {
        stage = 'stream-start';
        this.reportLifecycle(captureStartedAt, 'play-called');
        stream.play();
        // Start the readiness deadline only after native stream.play() has returned.
        if (!readinessResolved && !stopping && !stopped) {
          readinessTimer = setTimeout(() => {
            const timeout = new VoiceError('The microphone did not deliver input before the readiness timeout.', 'VOICE_TIMEOUT_ERROR');
            this.rejectReadiness?.(timeout);
            fail(timeout);
          }, this.readinessTimeoutMs);
        }
      }
    } catch (error) {
      this.reportDiagnostic(stage, error);
      await release('failed');
      const publicError = error instanceof VoiceError
        ? error
        : new VoiceError('The microphone could not start capture.', 'VOICE_CAPTURE_ERROR');
      this.rejectReadiness?.(publicError);
      throw publicError;
    }

    return {
      format: CANONICAL_AUDIO_FORMAT,
      chunks: () => queue,
      stop: async (reason = 'completed') => { await release(reason); },
    };
  }

  async stopCapture(): Promise<void> {
    await this.activeStop?.('completed');
  }

  async waitUntilReady(): Promise<void> {
    const currentReadiness = this.readiness;
    if (currentReadiness) return currentReadiness;
    const start = await this.nextCaptureStart.promise;
    return start.readiness;
  }

  private clearReadiness(): void {
    this.readiness = undefined;
    this.resolveReadiness = undefined;
    this.rejectReadiness = undefined;
  }
}
