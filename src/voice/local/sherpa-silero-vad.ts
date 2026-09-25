import { stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { VoiceError } from '../voice-errors.js';

export const SILERO_VAD_SAMPLE_RATE = 16_000;
export const SILERO_VAD_WINDOW_SAMPLES = 512;
export const DEFAULT_VAD_MIN_SILENCE_MS = 650;
const MAX_VAD_BUFFER_SECONDS = 30;
const MAX_VAD_MODEL_BYTES = 5 * 1024 * 1024;
const POSSIBLE_NOISE_RMS_FLOOR = 0.015;

export interface SherpaSpeechSegment {
  readonly samples: Float32Array;
}

export interface SherpaVadDetector {
  acceptWaveform(samples: Float32Array): void;
  isDetected(): boolean;
  isEmpty(): boolean;
  front(): SherpaSpeechSegment;
  pop(): void;
  reset(): void;
  flush(): void;
}

export interface SherpaVadRuntime {
  readonly Vad?: new (config: {
    readonly sampleRate: number;
    readonly numThreads: number;
    readonly provider: 'cpu';
    readonly sileroVad: {
      readonly model: string;
      readonly threshold: number;
      readonly minSilenceDuration: number;
      readonly minSpeechDuration: number;
      readonly maxSpeechDuration: number;
      readonly windowSize: number;
    };
  }, bufferSizeInSeconds: number) => SherpaVadDetector;
}

export function resolveSileroVadModelPath(modelPath: string, repositoryRoot = process.cwd()): string {
  if (!modelPath.trim() || !isAbsolute(modelPath)) {
    throw new VoiceError('YUKI_VAD_MODEL_PATH must be an absolute external model path.', 'VOICE_CONFIGURATION_ERROR');
  }
  const target = resolve(modelPath);
  const fromRoot = relative(resolve(repositoryRoot), target);
  if (fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))) {
    throw new VoiceError('The local VAD model must be outside the repository.', 'VOICE_CONFIGURATION_ERROR');
  }
  return target;
}

async function requireModelFile(path: string): Promise<void> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_VAD_MODEL_BYTES || !path.toLowerCase().endsWith('.onnx')) {
      throw new Error('unsupported VAD model file');
    }
  } catch {
    throw new VoiceError('The local VAD model is missing or unreadable.', 'VOICE_CONFIGURATION_ERROR');
  }
}

function loadSherpaRuntime(): SherpaVadRuntime {
  try {
    return createRequire(import.meta.url)('sherpa-onnx-node') as SherpaVadRuntime;
  } catch {
    throw new VoiceError('The local VAD runtime is unavailable.', 'VOICE_STT_ERROR');
  }
}

export interface VadTransitions {
  readonly speechStarted: boolean;
  readonly speechEnded: boolean;
  readonly possibleNoise?: boolean;
  /** One completed speech segment; callers must consume it promptly. */
  readonly segment?: Float32Array;
}

/** Local Silero VAD adapter. Audio and segments remain bounded in memory and are zeroed on release. */
export class SherpaSileroVad {
  private readonly detector: SherpaVadDetector;
  private pending = new Float32Array(SILERO_VAD_WINDOW_SAMPLES);
  private pendingLength = 0;
  private speechActive = false;
  private possibleNoiseActive = false;
  private closed = false;

  private constructor(detector: SherpaVadDetector) { this.detector = detector; }

  static async create(options: {
    readonly modelPath: string;
    readonly minSilenceMs?: number;
    readonly runtime?: SherpaVadRuntime;
  }): Promise<SherpaSileroVad> {
    const minSilenceMs = options.minSilenceMs ?? DEFAULT_VAD_MIN_SILENCE_MS;
    if (!Number.isInteger(minSilenceMs) || minSilenceMs < 350 || minSilenceMs > 1500) {
      throw new VoiceError('VAD silence tolerance must be between 350 and 1500 ms.', 'VOICE_CONFIGURATION_ERROR');
    }
    await requireModelFile(options.modelPath);
    const runtime = options.runtime ?? loadSherpaRuntime();
    try {
      if (!runtime.Vad) throw new Error('Sherpa runtime has no VAD binding');
      return new SherpaSileroVad(new runtime.Vad({
        sampleRate: SILERO_VAD_SAMPLE_RATE,
        numThreads: 1,
        provider: 'cpu',
        sileroVad: {
          model: options.modelPath,
          threshold: 0.5,
          minSilenceDuration: minSilenceMs / 1000,
          minSpeechDuration: 0.2,
          maxSpeechDuration: 10,
          windowSize: SILERO_VAD_WINDOW_SAMPLES,
        },
      }, MAX_VAD_BUFFER_SECONDS));
    } catch {
      throw new VoiceError('The local VAD model could not be initialized.', 'VOICE_STT_ERROR');
    }
  }

  pushPcm16(data: Uint8Array): VadTransitions[] {
    if (this.closed) throw new VoiceError('The local VAD session is closed.', 'VOICE_STATE_ERROR');
    if (data.byteLength % 2 !== 0) throw new VoiceError('VAD requires PCM16 audio.', 'VOICE_AUDIO_FORMAT_ERROR');
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const transitions: VadTransitions[] = [];
    for (let offset = 0; offset < data.byteLength; offset += 2) {
      const value = view.getInt16(offset, true);
      this.pending[this.pendingLength++] = value < 0 ? value / 32768 : value / 32767;
      if (this.pendingLength !== SILERO_VAD_WINDOW_SAMPLES) continue;
      let energy = 0;
      for (const sample of this.pending) energy += sample * sample;
      const rms = Math.sqrt(energy / this.pending.length);
      this.detector.acceptWaveform(this.pending);
      this.pending.fill(0);
      this.pendingLength = 0;
      const detected = this.detector.isDetected();
      if (detected && !this.speechActive) {
        this.speechActive = true;
        this.possibleNoiseActive = false;
        transitions.push({ speechStarted: true, speechEnded: false });
      } else if (!detected && this.speechActive) {
        this.speechActive = false;
        this.possibleNoiseActive = false;
        const segment = this.popSegment();
        transitions.push({ speechStarted: false, speechEnded: true, ...(segment ? { segment } : {}) });
      } else if (!detected && rms >= POSSIBLE_NOISE_RMS_FLOOR && !this.possibleNoiseActive) {
        this.possibleNoiseActive = true;
        transitions.push({ speechStarted: false, speechEnded: false, possibleNoise: true });
      } else if (rms < POSSIBLE_NOISE_RMS_FLOOR) {
        this.possibleNoiseActive = false;
      }
    }
    return transitions;
  }

  flush(): VadTransitions[] {
    if (this.closed) return [];
    this.detector.flush();
    this.pending.fill(0);
    this.pendingLength = 0;
    const transitions: VadTransitions[] = [];
    if (this.speechActive) {
      this.speechActive = false;
      const segment = this.popSegment();
      transitions.push({ speechStarted: false, speechEnded: true, ...(segment ? { segment } : {}) });
    }
    this.drainSegments().forEach((segment) => transitions.push({ speechStarted: false, speechEnded: true, segment }));
    return transitions;
  }

  reset(): void {
    this.pending.fill(0);
    this.pendingLength = 0;
    this.speechActive = false;
    this.possibleNoiseActive = false;
    this.detector.reset();
  }

  close(): void {
    if (this.closed) return;
    this.reset();
    this.closed = true;
  }

  private popSegment(): Float32Array | undefined {
    if (this.detector.isEmpty()) return undefined;
    const result = this.detector.front().samples;
    const segment = new Float32Array(result);
    result.fill(0);
    this.detector.pop();
    return segment;
  }

  private drainSegments(): Float32Array[] {
    const segments: Float32Array[] = [];
    while (!this.detector.isEmpty()) {
      const result = this.detector.front().samples;
      segments.push(new Float32Array(result));
      result.fill(0);
      this.detector.pop();
    }
    return segments;
  }
}

export function speechSegmentToPcm16(samples: Float32Array): Uint8Array {
  const data = new Uint8Array(samples.length * 2);
  const view = new DataView(data.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, Number.isFinite(samples[index]) ? samples[index] ?? 0 : 0));
    view.setInt16(index * 2, Math.round(sample < 0 ? sample * 32768 : sample * 32767), true);
  }
  samples.fill(0);
  return data;
}
