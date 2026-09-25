import { stat, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { BoundedAsyncQueue } from '../bounded-async-queue.js';
import { VoiceError } from '../voice-errors.js';
import type { AudioFormat, VoiceProviderOptions } from '../voice-types.js';
import type { AudioStreamChunk, AudioStreamResult, StreamingSynthesisRequest, StreamingTTSOperation, StreamingTTSProvider } from '../streaming-types.js';
import type { PiperSpanishTtsModelPaths } from './piper-spanish-tts-model.js';

const MAX_PHRASE_CHARACTERS = 320;
const TTS_CHUNK_MS = 100;
const MAX_PHRASE_AUDIO_SECONDS = 45;
const TTS_FORMAT: AudioFormat = { encoding: 'pcm_s16le', sampleRateHz: 22050, channels: 1 };

interface GeneratedAudio { readonly samples: Float32Array; readonly sampleRate: number }
export interface SherpaTtsEngine {
  readonly sampleRate: number;
  generateAsync(request: {
    readonly text: string;
    readonly sid: number;
    readonly speed: number;
    readonly onProgress: () => boolean;
  }): Promise<GeneratedAudio>;
}
export interface SherpaTtsRuntime {
  OfflineTts: {
    createAsync(config: {
      readonly model: {
        readonly vits: {
          readonly model: string;
          readonly tokens: string;
          readonly dataDir: string;
          readonly noiseScale: number;
          readonly noiseScaleW: number;
          readonly lengthScale: number;
        };
        readonly numThreads: number;
        readonly provider: 'cpu';
      };
      readonly maxNumSentences: number;
      readonly silenceScale: number;
    }): Promise<SherpaTtsEngine>;
  };
}

function loadRuntime(): SherpaTtsRuntime {
  try { return createRequire(import.meta.url)('sherpa-onnx-node') as SherpaTtsRuntime; }
  catch { throw new VoiceError('The local TTS engine is unavailable.', 'VOICE_TTS_ERROR'); }
}

function isInside(path: string, parent: string): boolean {
  const pathFromParent = relative(parent, path);
  return pathFromParent === '' || (pathFromParent !== '..' && !pathFromParent.startsWith(`..${sep}`) && !isAbsolute(pathFromParent));
}

async function validateModel(paths: PiperSpanishTtsModelPaths, repositoryRoot: string): Promise<void> {
  try {
    const root = await realpath(repositoryRoot);
    const [modelPath, tokensPath, dataPath] = await Promise.all([
      realpath(paths.model), realpath(paths.tokens), realpath(paths.dataDir),
    ]);
    if ([modelPath, tokensPath, dataPath].some((path) => isInside(path, root))) {
      throw new Error('model path inside repository');
    }
    const [model, tokens, data] = await Promise.all([stat(modelPath), stat(tokensPath), stat(dataPath)]);
    if (!model.isFile() || !tokens.isFile() || !data.isDirectory()) throw new Error('invalid model layout');
  } catch {
    throw new VoiceError('The local Spanish TTS model is missing or invalid.', 'VOICE_TTS_ERROR');
  }
}

function nextPhraseEnd(text: string, ending: boolean): number {
  for (let index = 0; index < text.length; index += 1) {
    if ('.!?\n。！？'.includes(text[index] ?? '')) return index + 1;
  }
  if (text.length >= MAX_PHRASE_CHARACTERS) {
    const boundary = text.lastIndexOf(' ', MAX_PHRASE_CHARACTERS);
    const end = boundary >= Math.floor(MAX_PHRASE_CHARACTERS * 0.65) ? boundary : MAX_PHRASE_CHARACTERS;
    const before = text.charCodeAt(end - 1);
    const after = text.charCodeAt(end);
    return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff ? end - 1 : end;
  }
  return ending ? text.length : 0;
}

function encodePcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;
    if (!Number.isFinite(sample)) throw new VoiceError('The local TTS engine returned invalid audio.', 'VOICE_TTS_ERROR');
    const bounded = Math.max(-1, Math.min(1, sample));
    view.setInt16(index * 2, bounded < 0 ? Math.round(bounded * 32768) : Math.round(bounded * 32767), true);
  }
  return bytes;
}

class SherpaVitsTtsOperation implements StreamingTTSOperation {
  private readonly output = new BoundedAsyncQueue<AudioStreamChunk>(8);
  private readonly completion: Promise<AudioStreamResult>;
  private resolveCompletion!: (result: AudioStreamResult) => void;
  private rejectCompletion!: (error: Error) => void;
  private pendingText = '';
  private sequence = 0;
  private byteLength = 0;
  private durationMs = 0;
  private settled = false;
  private ended = false;
  private acceptedText = false;

  constructor(private readonly engine: SherpaTtsEngine, private readonly signal: AbortSignal) {
    this.completion = new Promise((resolve, reject) => { this.resolveCompletion = resolve; this.rejectCompletion = reject; });
    void this.completion.catch(() => undefined);
    signal.addEventListener('abort', this.onAbort, { once: true });
    if (signal.aborted) this.onAbort();
  }

  private readonly onAbort = (): void => {
    this.pendingText = '';
    this.output.close();
    this.resolveOnce();
  };

  async pushText(text: string): Promise<void> {
    if (this.ended || this.signal.aborted) throw new VoiceError('Local speech synthesis was cancelled.', 'VOICE_CANCELLATION_ERROR');
    if (typeof text !== 'string') throw new VoiceError('TTS input must be text.', 'VOICE_TTS_ERROR');
    if (text.trim()) this.acceptedText = true;
    this.pendingText += text;
    try {
      let end = nextPhraseEnd(this.pendingText, false);
      while (end > 0) {
        const phrase = this.pendingText.slice(0, end).trim();
        this.pendingText = this.pendingText.slice(end);
        if (phrase) await this.synthesizePhrase(phrase);
        end = nextPhraseEnd(this.pendingText, false);
      }
    } catch (error) {
      this.fail(error);
      throw error instanceof VoiceError ? error : new VoiceError('Local speech synthesis failed.', 'VOICE_TTS_ERROR');
    }
  }

  async endInput(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    if (this.signal.aborted) { this.onAbort(); return; }
    try {
      if (!this.acceptedText) throw new VoiceError('TTS input must not be empty.', 'VOICE_TTS_ERROR');
      const remaining = this.pendingText.trim();
      this.pendingText = '';
      if (remaining) await this.synthesizePhrase(remaining);
      this.output.finish();
      this.resolveOnce();
    } catch (error) {
      this.fail(error);
      throw error instanceof VoiceError ? error : new VoiceError('Local speech synthesis failed.', 'VOICE_TTS_ERROR');
    }
  }

  chunks(): AsyncIterable<AudioStreamChunk> { return this.output; }
  completed(): Promise<AudioStreamResult> { return this.completion; }

  async cancel(): Promise<void> { this.onAbort(); }
  async close(): Promise<void> { this.signal.removeEventListener('abort', this.onAbort); this.pendingText = ''; this.output.close(); this.resolveOnce(); }

  private async synthesizePhrase(text: string): Promise<void> {
    if (this.signal.aborted) throw new VoiceError('Local speech synthesis was cancelled.', 'VOICE_CANCELLATION_ERROR');
    if (Array.from(text).length > MAX_PHRASE_CHARACTERS) throw new VoiceError('A TTS phrase exceeded its safe size limit.', 'VOICE_BACKPRESSURE_ERROR');
    let generated: GeneratedAudio;
    try {
      generated = await this.engine.generateAsync({ text, sid: 0, speed: 1, onProgress: () => !this.signal.aborted });
    } catch {
      if (this.signal.aborted) throw new VoiceError('Local speech synthesis was cancelled.', 'VOICE_CANCELLATION_ERROR');
      throw new VoiceError('Local speech synthesis failed.', 'VOICE_TTS_ERROR');
    }
    try {
      if (this.signal.aborted) throw new VoiceError('Local speech synthesis was cancelled.', 'VOICE_CANCELLATION_ERROR');
      if (!(generated.samples instanceof Float32Array) || !generated.samples.length
        || !Number.isFinite(generated.sampleRate) || generated.sampleRate <= 0
        || generated.samples.length > generated.sampleRate * MAX_PHRASE_AUDIO_SECONDS) {
        throw new VoiceError('The local TTS engine returned invalid or oversized audio.', 'VOICE_TTS_ERROR');
      }
      if (generated.sampleRate !== TTS_FORMAT.sampleRateHz) {
        throw new VoiceError('The local TTS model returned an unexpected sample rate.', 'VOICE_AUDIO_FORMAT_ERROR');
      }
      const samplesPerChunk = Math.max(1, Math.floor(generated.sampleRate * TTS_CHUNK_MS / 1000));
      for (let offset = 0; offset < generated.samples.length; offset += samplesPerChunk) {
        if (this.signal.aborted) throw new VoiceError('Local speech synthesis was cancelled.', 'VOICE_CANCELLATION_ERROR');
        const count = Math.min(samplesPerChunk, generated.samples.length - offset);
        const segment = generated.samples.subarray(offset, offset + count);
        const data = encodePcm16(segment);
        const durationMs = count * 1000 / generated.sampleRate;
        const chunk: AudioStreamChunk = {
          data,
          format: TTS_FORMAT,
          sequence: this.sequence++,
          timestampMs: this.durationMs,
          durationMs,
          source: 'tts',
        };
        if (!(await this.output.enqueue(chunk, this.signal))) {
          data.fill(0);
          throw new VoiceError('The local TTS output queue was closed.', 'VOICE_CANCELLATION_ERROR');
        }
        this.byteLength += data.byteLength;
        this.durationMs += durationMs;
      }
    } finally {
      generated.samples.fill(0);
    }
  }

  private fail(error: unknown): void {
    this.pendingText = '';
    this.output.close();
    if (this.settled) return;
    this.settled = true;
    this.signal.removeEventListener('abort', this.onAbort);
    this.rejectCompletion(error instanceof Error ? error : new VoiceError('Local speech synthesis failed.', 'VOICE_TTS_ERROR'));
  }

  private resolveOnce(): void {
    if (this.settled) return;
    this.settled = true;
    this.signal.removeEventListener('abort', this.onAbort);
    this.resolveCompletion({ format: TTS_FORMAT, chunkCount: this.sequence, byteLength: this.byteLength, durationMs: this.durationMs });
  }
}

export interface SherpaVitsTtsProviderOptions {
  readonly runtime?: SherpaTtsRuntime;
  readonly repositoryRoot?: string;
}

export class SherpaVitsTTSProvider implements StreamingTTSProvider {
  readonly name = 'sherpa-onnx-vits-local';
  private enginePromise: Promise<SherpaTtsEngine> | undefined;
  private readonly repositoryRoot: string;

  constructor(private readonly model: PiperSpanishTtsModelPaths, private readonly options: SherpaVitsTtsProviderOptions = {}) {
    this.repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
  }

  async prepare(): Promise<void> { await this.getEngine(); }

  async startSynthesis(_request: StreamingSynthesisRequest, options: VoiceProviderOptions): Promise<StreamingTTSOperation> {
    if (options.signal.aborted) throw new VoiceError('Local speech synthesis was cancelled.', 'VOICE_CANCELLATION_ERROR');
    const engine = await this.getEngine();
    if (options.signal.aborted) throw new VoiceError('Local speech synthesis was cancelled.', 'VOICE_CANCELLATION_ERROR');
    return new SherpaVitsTtsOperation(engine, options.signal);
  }

  private getEngine(): Promise<SherpaTtsEngine> {
    this.enginePromise ??= validateModel(this.model, this.repositoryRoot).then(async () => {
      const runtime = this.options.runtime ?? loadRuntime();
      return runtime.OfflineTts.createAsync({
        model: {
          vits: { model: this.model.model, tokens: this.model.tokens, dataDir: this.model.dataDir, noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1 },
          numThreads: 2,
          provider: 'cpu',
        },
        maxNumSentences: 1,
        silenceScale: 0.2,
      });
    }).catch((error: unknown) => {
      this.enginePromise = undefined;
      if (error instanceof VoiceError) throw error;
      throw new VoiceError('The local TTS model could not be initialized.', 'VOICE_TTS_ERROR');
    });
    return this.enginePromise;
  }
}

export const LOCAL_TTS_AUDIO_FORMAT = TTS_FORMAT;
export const LOCAL_TTS_MAX_PHRASE_CHARACTERS = MAX_PHRASE_CHARACTERS;
export { nextPhraseEnd as getNextTtsPhraseEnd };
