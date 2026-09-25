import { VoiceError } from '../voice-errors.js';
import type { VoiceProviderOptions } from '../voice-types.js';
import type { AudioPlaybackHandle, AudioStreamChunk, StreamingAudioOutputProvider } from '../streaming-types.js';
import { createRequire } from 'node:module';

type CpalFormat = 'f32' | 'i16';
type DeviceSamples = Float32Array | Int16Array;

interface CpalOutputStream {
  readonly bufferedFrames: number;
  write(data: Float32Array): boolean;
  write(data: Int16Array): boolean;
  close(): Promise<void>;
}

interface QueuedDeviceBuffer {
  readonly data: DeviceSamples;
  remainingFrames: number;
}

export interface CpalOutputRuntime {
  readonly convenience: {
    getDefaultOutputDevice(): { readonly deviceId: string };
    getDefaultOutputConfig(deviceId: string): { readonly sampleRate: number; readonly channels: number };
    getSupportedOutputConfigs(deviceId: string): readonly {
      readonly minSampleRate: number;
      readonly maxSampleRate: number;
      readonly channels: number;
      readonly sampleFormat: string;
    }[];
    createOutputStream(options: {
      readonly deviceId: string;
      readonly config: { readonly sampleRate: number; readonly channels: number; readonly sampleFormat: CpalFormat; readonly bufferSize: { readonly type: 'default' } };
      readonly autoStart: boolean;
      readonly timeoutMs: null;
      readonly queueCapacityBuffers: number;
      readonly onDrain: () => void;
      readonly onOutput: (info: { readonly frames: number }) => void;
      readonly onError: (error: unknown) => void;
    }): Promise<CpalOutputStream>;
  };
}

function loadRuntime(): CpalOutputRuntime {
  try {
    return createRequire(import.meta.url)('node-cpal') as CpalOutputRuntime;
  } catch {
    throw new VoiceError('The local audio output is unavailable.', 'VOICE_OUTPUT_ERROR');
  }
}

function supportedConfig(runtime: CpalOutputRuntime, deviceId: string): {
  readonly sampleRate: number;
  readonly channels: number;
  readonly sampleFormat: CpalFormat;
} {
  const preferred = runtime.convenience.getDefaultOutputConfig(deviceId);
  const configs = runtime.convenience.getSupportedOutputConfigs(deviceId);
  for (const sampleFormat of ['f32', 'i16'] as const) {
    const match = configs.find((config) => config.sampleFormat === sampleFormat
      && config.minSampleRate <= preferred.sampleRate && config.maxSampleRate >= preferred.sampleRate
      && config.channels === preferred.channels);
    if (match) return { sampleRate: preferred.sampleRate, channels: preferred.channels, sampleFormat };
  }
  for (const sampleFormat of ['f32', 'i16'] as const) {
    const match = configs.find((config) => config.sampleFormat === sampleFormat);
    if (match) return {
      sampleRate: Math.max(match.minSampleRate, Math.min(preferred.sampleRate, match.maxSampleRate)),
      channels: match.channels,
      sampleFormat,
    };
  }
  throw new VoiceError('The default audio output has no supported PCM format.', 'VOICE_OUTPUT_ERROR');
}

function decodePcm16Mono(chunk: AudioStreamChunk, targetRate: number, targetChannels: number): Float32Array {
  if (chunk.format.encoding !== 'pcm_s16le' || chunk.format.channels !== 1
    || !Number.isInteger(chunk.format.sampleRateHz) || chunk.format.sampleRateHz <= 0
    || chunk.data.byteLength === 0 || chunk.data.byteLength % 2 !== 0) {
    throw new VoiceError('The local audio output requires mono PCM16 audio.', 'VOICE_AUDIO_FORMAT_ERROR');
  }
  const inputCount = chunk.data.byteLength / 2;
  const outputFrames = Math.max(1, Math.floor(inputCount * targetRate / chunk.format.sampleRateHz));
  const output = new Float32Array(outputFrames * targetChannels);
  const source = new DataView(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
  for (let frame = 0; frame < outputFrames; frame += 1) {
    const position = frame * chunk.format.sampleRateHz / targetRate;
    const before = Math.min(inputCount - 1, Math.floor(position));
    const after = Math.min(inputCount - 1, before + 1);
    const weight = position - before;
    const left = source.getInt16(before * 2, true);
    const right = source.getInt16(after * 2, true);
    const a = left < 0 ? left / 32768 : left / 32767;
    const b = right < 0 ? right / 32768 : right / 32767;
    const value = a + (b - a) * weight;
    for (let channel = 0; channel < targetChannels; channel += 1) output[frame * targetChannels + channel] = value;
  }
  return output;
}

function convertSamples(samples: Float32Array, format: CpalFormat): DeviceSamples {
  if (format === 'f32') return new Float32Array(samples);
  const output = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index] ?? 0));
    output[index] = value < 0 ? Math.round(value * 32768) : Math.round(value * 32767);
  }
  return output;
}

function abortError(): VoiceError {
  return new VoiceError('Audio playback was cancelled.', 'VOICE_CANCELLATION_ERROR');
}

class CpalPlaybackHandle implements AudioPlaybackHandle {
  private stream: CpalOutputStream | undefined;
  private failure: VoiceError | undefined;
  private stopped = false;
  private closed = false;
  private drainWaiter: (() => void) | undefined;
  private outputWaiter: (() => void) | undefined;
  private readonly queuedDeviceBuffers: QueuedDeviceBuffer[] = [];
  private completedResolve!: () => void;
  private completedReject!: (error: Error) => void;
  private readonly completion: Promise<void>;

  constructor(
    private readonly runtime: CpalOutputRuntime,
    private readonly config: ReturnType<typeof supportedConfig>,
    private readonly deviceId: string,
    private readonly options: VoiceProviderOptions,
  ) {
    this.completion = new Promise((resolve, reject) => { this.completedResolve = resolve; this.completedReject = reject; });
    void this.completion.catch(() => undefined);
    options.signal.addEventListener('abort', this.onAbort, { once: true });
  }

  async start(): Promise<void> {
    try {
      this.stream = await this.runtime.convenience.createOutputStream({
        deviceId: this.deviceId,
        config: { ...this.config, bufferSize: { type: 'default' } },
        autoStart: true,
        timeoutMs: null,
        queueCapacityBuffers: 8,
        onDrain: () => { this.drainWaiter?.(); this.drainWaiter = undefined; },
        onOutput: (info) => {
          this.releasePlayedFrames(info.frames);
          this.outputWaiter?.();
          this.outputWaiter = undefined;
        },
        onError: () => { this.fail(); },
      });
      this.throwIfStopped();
    } catch (error) {
      await this.closeStream();
      if (error instanceof VoiceError) throw error;
      throw new VoiceError('The default audio output could not be opened.', 'VOICE_OUTPUT_ERROR');
    }
  }

  async enqueue(chunk: AudioStreamChunk): Promise<void> {
    this.throwIfStopped();
    const converted = decodePcm16Mono(chunk, this.config.sampleRate, this.config.channels);
    const data = convertSamples(converted, this.config.sampleFormat);
    converted.fill(0);
    try {
      const stream = this.stream;
      if (!stream) throw new VoiceError('The default audio output is not open.', 'VOICE_OUTPUT_ERROR');
      const write = (): boolean => data instanceof Float32Array ? stream.write(data) : stream.write(data);
      while (!write()) {
        this.throwIfStopped();
        await this.waitForDrain();
      }
      this.queuedDeviceBuffers.push({ data, remainingFrames: data.length / this.config.channels });
      this.throwIfStopped();
    } catch (error) {
      if (error instanceof VoiceError) throw error;
      throw new VoiceError('The default audio output rejected audio.', 'VOICE_OUTPUT_ERROR');
    } finally {
      chunk.data.fill(0);
    }
  }

  async flush(): Promise<void> {
    this.throwIfStopped();
    const deadline = Date.now() + 20_000;
    while ((this.stream?.bufferedFrames ?? 0) > 0 || this.queuedDeviceBuffers.length > 0) {
      this.throwIfStopped();
      if (Date.now() >= deadline) throw new VoiceError('The audio output did not drain in time.', 'VOICE_TIMEOUT_ERROR');
      await this.waitForOutput();
    }
    await this.closeStream();
    this.options.signal.removeEventListener('abort', this.onAbort);
    this.completedResolve();
  }

  async stop(mode: 'immediate' | 'drain'): Promise<void> {
    if (this.closed) return;
    if (mode === 'drain' && !this.options.signal.aborted) {
      await this.flush();
      return;
    }
    this.stopped = true;
    this.drainWaiter?.();
    this.outputWaiter?.();
    await this.closeStream();
    this.options.signal.removeEventListener('abort', this.onAbort);
    this.completedResolve();
  }

  completed(): Promise<void> { return this.completion; }

  private readonly onAbort = (): void => { void this.stop('immediate'); };

  private async waitForDrain(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); resolve(); }, 100);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.options.signal.removeEventListener('abort', onAbort);
        if (this.drainWaiter === onDrain) this.drainWaiter = undefined;
      };
      const onDrain = (): void => { cleanup(); resolve(); };
      const onAbort = (): void => { cleanup(); reject(abortError()); };
      this.drainWaiter = onDrain;
      this.options.signal.addEventListener('abort', onAbort, { once: true });
      // onDrain can race the subscription; retrying periodically closes that gap while
      // the surrounding playback stage still owns the definitive timeout/cancellation.
      if (this.options.signal.aborted) onAbort();
    });
  }

  private async waitForOutput(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); resolve(); }, 20);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.options.signal.removeEventListener('abort', onAbort);
        if (this.outputWaiter === onOutput) this.outputWaiter = undefined;
      };
      const onOutput = (): void => { cleanup(); resolve(); };
      const onAbort = (): void => { cleanup(); reject(abortError()); };
      this.outputWaiter = onOutput;
      this.options.signal.addEventListener('abort', onAbort, { once: true });
      if (this.options.signal.aborted) onAbort();
    });
    this.throwIfStopped();
  }

  private throwIfStopped(): void {
    if (this.failure) throw this.failure;
    if (this.stopped || this.options.signal.aborted) throw abortError();
  }

  private fail(): void {
    if (this.failure || this.closed) return;
    this.failure = new VoiceError('The audio output device failed during playback.', 'VOICE_OUTPUT_ERROR');
    this.stopped = true;
    this.drainWaiter?.();
    this.outputWaiter?.();
    this.completedReject(this.failure);
    void this.closeStream();
  }

  private async closeStream(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.options.signal.removeEventListener('abort', this.onAbort);
    this.clearQueuedBuffers();
    const stream = this.stream;
    this.stream = undefined;
    try { await stream?.close(); } catch { /* Device release is best-effort after stream termination. */ }
  }

  private releasePlayedFrames(frames: number): void {
    let remaining = Math.max(0, Math.floor(frames));
    while (remaining > 0 && this.queuedDeviceBuffers.length > 0) {
      const buffer = this.queuedDeviceBuffers[0]!;
      const consumed = Math.min(remaining, buffer.remainingFrames);
      buffer.remainingFrames -= consumed;
      remaining -= consumed;
      if (buffer.remainingFrames === 0) {
        buffer.data.fill(0);
        this.queuedDeviceBuffers.shift();
      }
    }
  }

  private clearQueuedBuffers(): void {
    for (const buffer of this.queuedDeviceBuffers) buffer.data.fill(0);
    this.queuedDeviceBuffers.length = 0;
  }
}

export interface WindowsCpalAudioOutputOptions { readonly runtime?: CpalOutputRuntime }

export class WindowsCpalStreamingAudioOutputProvider implements StreamingAudioOutputProvider {
  readonly name = 'node-cpal-windows-default-output';
  private readonly runtime: CpalOutputRuntime;

  constructor(options: WindowsCpalAudioOutputOptions = {}) { this.runtime = options.runtime ?? loadRuntime(); }

  async startPlayback(options: VoiceProviderOptions & { readonly deviceId: string }): Promise<AudioPlaybackHandle> {
    if (options.signal.aborted) throw abortError();
    if (options.deviceId !== 'default') throw new VoiceError('Only the default Windows audio output is supported.', 'VOICE_CONFIGURATION_ERROR');
    try {
      const device = this.runtime.convenience.getDefaultOutputDevice();
      const config = supportedConfig(this.runtime, device.deviceId);
      const handle = new CpalPlaybackHandle(this.runtime, config, device.deviceId, options);
      await handle.start();
      return handle;
    } catch (error) {
      if (error instanceof VoiceError) throw error;
      throw new VoiceError('The default audio output is unavailable.', 'VOICE_OUTPUT_ERROR');
    }
  }
}

export const convertPcm16MonoForDevice = decodePcm16Mono;
