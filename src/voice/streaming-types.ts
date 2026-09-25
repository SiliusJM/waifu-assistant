import type { EventBus } from '../realtime/event-bus.js';
import type { Logger } from '../shared/logger.js';
import type {
  AudioArtifact,
  AudioChunk,
  AudioFormat,
  SynthesisRequest,
  TranscriptionEvent,
  VoiceEventMap,
  VoiceOperationHandle,
  VoiceOperationOptions,
  VoiceProviderOptions,
  VoiceTerminationReason,
} from './voice-types.js';
import type { VoiceConcurrencyCoordinator } from './voice-concurrency-coordinator.js';

export interface AudioStreamChunk {
  readonly data: Uint8Array;
  readonly format: AudioFormat;
  readonly sequence: number;
  readonly timestampMs: number;
  readonly durationMs: number;
  readonly source: 'capture' | 'tts';
}

export interface AudioInputStream {
  readonly format: AudioFormat;
  chunks(): AsyncIterable<AudioChunk>;
  stop(reason?: VoiceTerminationReason): Promise<void>;
}

export interface StreamingAudioInputProvider {
  readonly name: string;
  startCapture(options: VoiceProviderOptions): Promise<AudioInputStream>;
}

export interface STTStartRequest {
  readonly sessionId: string;
  readonly language?: string;
}

export interface StreamingSTTSession {
  pushAudio(chunk: AudioChunk): Promise<void>;
  endInput(): Promise<void>;
  events(): AsyncIterable<StreamingTranscriptionEvent>;
  cancel(reason?: VoiceTerminationReason): Promise<void>;
  close(): Promise<void>;
}

export type StreamingTranscriptionEvent = Exclude<TranscriptionEvent, { readonly type: 'final' }>
  | { readonly type: 'final'; readonly text: string; readonly segmentId?: string }
  | { readonly type: 'speech_start'; readonly segmentId: string }
  | { readonly type: 'possible_noise' }
  | { readonly type: 'speech_end'; readonly segmentId: string }
  | { readonly type: 'no_speech' };

export interface StreamingSTTProvider {
  readonly name: string;
  start(request: STTStartRequest, options: VoiceProviderOptions): Promise<StreamingSTTSession>;
}

export interface StreamingSynthesisRequest extends Omit<SynthesisRequest, 'text'> {
  readonly text?: string;
}

export interface AudioStreamResult {
  readonly format: AudioFormat;
  readonly chunkCount: number;
  readonly byteLength: number;
  readonly durationMs?: number;
}

export interface StreamingTTSOperation {
  pushText(text: string): Promise<void>;
  endInput(): Promise<void>;
  chunks(): AsyncIterable<AudioStreamChunk>;
  completed(): Promise<AudioStreamResult>;
  cancel(reason?: VoiceTerminationReason): Promise<void>;
  close(): Promise<void>;
}

export interface StreamingTTSProvider {
  readonly name: string;
  startSynthesis(
    request: StreamingSynthesisRequest,
    options: VoiceProviderOptions,
  ): Promise<StreamingTTSOperation>;
}

export interface AudioPlaybackHandle {
  enqueue(chunk: AudioStreamChunk): Promise<void>;
  flush(): Promise<void>;
  stop(mode: 'immediate' | 'drain', reason?: VoiceTerminationReason): Promise<void>;
  completed(): Promise<void>;
}

export interface StreamingAudioOutputProvider {
  readonly name: string;
  startPlayback(options: VoiceProviderOptions & { readonly deviceId: string }): Promise<AudioPlaybackHandle>;
}

export interface VoiceStreamingQueueOptions {
  /** Initial capture chunk duration policy in milliseconds; not an operational timeout. */
  readonly captureChunkDurationMs?: number;
  /** Initial playback buffering policy in milliseconds; not an operational timeout. */
  readonly playbackBufferMs?: number;
  /** Maximum pending buffering policy in milliseconds; not an operational timeout. */
  readonly maxPendingMs?: number;
  readonly queueCapacity?: number;
  readonly streamCapacity?: number;
}

export interface StreamingVoiceOperationOptions extends VoiceOperationOptions, VoiceStreamingQueueOptions {
  readonly deviceId?: string;
  readonly supersede?: boolean;
  readonly autoEndInput?: boolean;
  readonly shutdownSignal?: AbortSignal;
}

export interface StreamingVoiceOperationHandle<T> extends VoiceOperationHandle<T> {
  readonly reasonCode?: Exclude<VoiceTerminationReason, 'completed' | 'failed'>;
  interrupt(reason?: string): boolean;
  supersede(replacementOperationId: string): boolean;
  shutdown(reason?: string): boolean;
  metrics(): VoiceLatencyMetrics;
}

export interface StreamingVoiceSynthesisHandle extends StreamingVoiceOperationHandle<AudioStreamResult> {
  pushText(text: string): Promise<void>;
  endInput(): Promise<void>;
}

export interface VoiceLatencyMetrics {
  readonly marks: Readonly<Record<string, number>>;
  readonly durationsMs: Readonly<Record<string, number>>;
}

export interface StreamingVoiceProviders extends VoiceStreamingQueueOptions {
  readonly input: StreamingAudioInputProvider;
  readonly stt: StreamingSTTProvider;
  readonly tts: StreamingTTSProvider;
  readonly output: StreamingAudioOutputProvider;
  readonly coordinator?: VoiceConcurrencyCoordinator;
  readonly logger?: Logger;
  readonly defaultTimeoutMs?: number;
}

export interface StreamingVoiceServiceOptions extends StreamingVoiceProviders {
  readonly events?: EventBus<VoiceEventMap>;
}

export type StreamingTranscriptionRequest = STTStartRequest;

export type StreamingVoiceResult =
  | { readonly status: 'completed'; readonly value: AudioStreamResult | { readonly text: string } }
  | { readonly status: 'cancelled'; readonly reason?: string; readonly reasonCode?: Exclude<VoiceTerminationReason, 'completed' | 'failed'> }
  | { readonly status: 'failed'; readonly code: string; readonly message: string };

export type { AudioArtifact };
