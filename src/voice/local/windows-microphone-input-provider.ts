import { createRequire } from 'node:module';
import { VoiceError } from '../voice-errors.js';
import type { VoiceProviderOptions, VoiceTerminationReason } from '../voice-types.js';
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
    onError: (error: { code?: string }) => void,
  ): { play(): void; close(): void };
  close(): void;
}

interface CpalHost {
  defaultInputDevice(): CpalDevice | null;
  close(): void;
}

export interface CpalRuntime {
  defaultHost(): CpalHost;
  SampleFormat: { readonly F32: { readonly value: string } };
}

function loadCpal(): CpalRuntime {
  try {
    return createRequire(import.meta.url)('node-cpal') as CpalRuntime;
  } catch {
    throw new VoiceError('The local microphone backend is unavailable.', 'VOICE_CAPTURE_ERROR');
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
  readonly runtime?: CpalRuntime;
}

export class WindowsMicrophoneInputProvider implements StreamingAudioInputProvider {
  readonly name = 'windows-wasapi-microphone';
  private readonly maxDurationSamples: number;
  private readonly queueCapacity: number;
  private readonly runtime?: CpalRuntime;
  private activeStop: ((reason: VoiceTerminationReason) => Promise<void>) | undefined;
  private readiness: Promise<void> | undefined;
  private resolveReadiness: (() => void) | undefined;
  private rejectReadiness: ((error: Error) => void) | undefined;
  private nextCaptureStart = deferred<{ readonly readiness: Promise<void> }>();

  constructor(options: WindowsMicrophoneInputOptions = {}) {
    const duration = options.maxDurationSeconds ?? DEFAULT_MAX_DURATION_SECONDS;
    const capacity = options.queueCapacity ?? DEFAULT_QUEUE_CAPACITY;
    if (!Number.isInteger(duration) || duration < 1 || duration > 60
      || !Number.isInteger(capacity) || capacity < 1 || capacity > 128) {
      throw new VoiceError('Microphone capture limits are invalid.', 'VOICE_CONFIGURATION_ERROR');
    }
    this.maxDurationSamples = duration * TARGET_RATE;
    this.queueCapacity = capacity;
    this.runtime = options.runtime;
  }

  async startCapture(options: VoiceProviderOptions): Promise<AudioInputStream> {
    if (this.activeStop) throw new VoiceError('A microphone capture is already active.', 'VOICE_CONCURRENCY_ERROR');
    this.clearReadiness();
    this.readiness = new Promise<void>((resolve, reject) => {
      this.resolveReadiness = resolve;
      this.rejectReadiness = reject;
    });
    void this.readiness.catch(() => undefined);
    const startSignal = this.nextCaptureStart;
    this.nextCaptureStart = deferred<{ readonly readiness: Promise<void> }>();
    startSignal.resolve({ readiness: this.readiness });
    const cpal = this.runtime ?? loadCpal();
    let host: CpalHost;
    let device: CpalDevice;
    try {
      host = cpal.defaultHost();
      const selected = host.defaultInputDevice();
      if (!selected) {
        host.close();
        throw new VoiceError('No default microphone is available.', 'VOICE_CAPTURE_ERROR');
      }
      device = selected;
    } catch (error) {
      this.rejectReadiness?.(error instanceof Error ? error : new VoiceError('The microphone could not start capture.', 'VOICE_CAPTURE_ERROR'));
      if (error instanceof VoiceError) throw error;
      throw new VoiceError('The default microphone could not be opened.', 'VOICE_CAPTURE_ERROR');
    }

    const queue = new CaptureQueue(this.queueCapacity);
    let stream: ReturnType<CpalDevice['buildInputStream']> | undefined;
    let sequence = 0;
    let outputSamples = 0;
    let resamplePhase = 0;
    const pending = new Int16Array(CHUNK_SAMPLES);
    let pendingLength = 0;
    let stopped = false;
    let stopping = false;
    const release = async (reason: VoiceTerminationReason): Promise<void> => {
      if (stopped || stopping) return;
      stopping = true;
      options.signal.removeEventListener('abort', onAbort);
      if (reason === 'completed') {
        if (pendingLength > 0) emitPending();
        queue.finish();
      } else queue.discard();
      try { stream?.close(); } catch { /* Native stream close is best-effort; queue is already terminal. */ }
      try { device.close(); } catch { /* Native device release is best-effort. */ }
      try { host.close(); } catch { /* Native host release is best-effort. */ }
      stopped = true;
      stopping = false;
      if (this.activeStop === stop) this.activeStop = undefined;
      if (reason !== 'completed') this.rejectReadiness?.(new VoiceError('Microphone capture ended before it became ready.', 'VOICE_CAPTURE_ERROR'));
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

    try {
      let config = device.defaultInputConfig();
      if (config.sampleFormat().value !== cpal.SampleFormat.F32.value) {
        const floatConfig = [...device.supportedInputConfigs()].find((candidate) => (
          candidate.sampleFormat().value === cpal.SampleFormat.F32.value
          && candidate.channels() === config.channels()
          && candidate.containsRate(config.sampleRate())
        )) ?? [...device.supportedInputConfigs()].find((candidate) => (
          candidate.sampleFormat().value === cpal.SampleFormat.F32.value
        ));
        if (!floatConfig) throw new VoiceError('The microphone has no supported float input format.', 'VOICE_AUDIO_FORMAT_ERROR');
        config = floatConfig.tryWithSampleRate(config.sampleRate())
          ?? floatConfig.tryWithStandardSampleRate()
          ?? floatConfig.withMaxSampleRate();
      }
      stream = device.buildInputStream(config, 'f32', (input) => {
        if (stopped) return;
        const converted = convertFloatInputToPcm16Mono(input, config.channels(), config.sampleRate(), resamplePhase);
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
          if (stopped) return;
        }
      }, () => fail(new VoiceError('The microphone capture stream failed.', 'VOICE_CAPTURE_ERROR')));
      this.activeStop = stop;
      options.signal.addEventListener('abort', onAbort, { once: true });
      if (options.signal.aborted) onAbort();
      else {
        stream.play();
        this.resolveReadiness?.();
      }
    } catch (error) {
      await release('failed');
      this.rejectReadiness?.(error instanceof Error ? error : new VoiceError('The microphone could not start capture.', 'VOICE_CAPTURE_ERROR'));
      if (error instanceof VoiceError) throw error;
      throw new VoiceError('The microphone could not start capture.', 'VOICE_CAPTURE_ERROR');
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
    let timer: NodeJS.Timeout | undefined;
    try {
      const start = await Promise.race([
        this.nextCaptureStart.promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new VoiceError('Microphone capture did not start in time.', 'VOICE_TIMEOUT_ERROR')), 5000);
        }),
      ]);
      await start.readiness;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private clearReadiness(): void {
    this.readiness = undefined;
    this.resolveReadiness = undefined;
    this.rejectReadiness = undefined;
  }
}
