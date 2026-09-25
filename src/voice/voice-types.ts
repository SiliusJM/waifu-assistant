import type { Logger } from '../shared/logger.js';
import type { VoiceSession } from './voice-session.js';
import type { StreamingVoiceProviders } from './streaming-types.js';

export const AUDIO_ENCODINGS = ['pcm_s16le', 'wav', 'mp3', 'opus'] as const;
export type AudioEncoding = (typeof AUDIO_ENCODINGS)[number];

export interface AudioFormat {
  readonly encoding: AudioEncoding;
  readonly sampleRateHz: number;
  readonly channels: number;
}

export const CANONICAL_AUDIO_FORMAT: AudioFormat = {
  encoding: 'pcm_s16le',
  sampleRateHz: 16000,
  channels: 1,
};

export interface AudioChunk {
  readonly data: Uint8Array;
  readonly format: AudioFormat;
  readonly sequence: number;
  readonly capturedAt: string;
}

export type VoiceMode = 'batch' | 'streaming';

export type VoiceTerminationReason =
  | 'completed'
  | 'cancelled'
  | 'timeout'
  | 'interrupted'
  | 'superseded'
  | 'shutdown'
  | 'failed';

export interface AudioArtifact {
  readonly data: Uint8Array;
  readonly format: AudioFormat;
  readonly durationMs?: number;
}

export interface VoiceProviderOptions {
  readonly signal: AbortSignal;
  readonly correlationId: string;
}

export interface AudioInputProvider {
  readonly name: string;
  capture(options: VoiceProviderOptions): AsyncIterable<AudioChunk>;
  stop(options?: { readonly signal?: AbortSignal }): Promise<void>;
}

export interface AudioOutputProvider {
  readonly name: string;
  play(audio: AudioArtifact, options: VoiceProviderOptions): Promise<void>;
  stop(options?: { readonly signal?: AbortSignal }): Promise<void>;
}

export type TranscriptionEvent =
  | { readonly type: 'partial'; readonly text: string }
  | { readonly type: 'final'; readonly text: string };

export interface TranscriptionResult {
  readonly text: string;
}

export interface STTProvider {
  readonly name: string;
  transcribe(
    audio: AsyncIterable<AudioChunk>,
    options: VoiceProviderOptions,
  ): AsyncIterable<TranscriptionEvent>;
}

export interface SynthesisRequest {
  readonly sessionId: string;
  readonly text: string;
  readonly voice?: string;
  readonly language?: string;
  readonly rate?: number;
  readonly pitch?: number;
}

export interface TTSProvider {
  readonly name: string;
  synthesize(
    request: SynthesisRequest,
    options: VoiceProviderOptions,
  ): Promise<AudioArtifact>;
}

export type VoiceState =
  | 'created'
  | 'capturing'
  | 'transcribing'
  | 'synthesizing'
  | 'playing'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type CaptureState = 'idle' | 'capturing' | 'stopped' | 'cancelled' | 'failed';
export type TranscriptionState = 'idle' | 'running' | 'completed' | 'cancelled' | 'failed';
export type SynthesisState = 'idle' | 'running' | 'completed' | 'cancelled' | 'failed';
export type PlaybackState = 'idle' | 'playing' | 'completed' | 'stopped' | 'cancelled' | 'failed';

export interface VoiceEventPayloadMap {
  readonly voice_session_started: { readonly state: 'created' };
  readonly voice_state_changed: { readonly from: VoiceState; readonly to: VoiceState };
  readonly audio_input_started: { readonly format: AudioFormat };
  readonly audio_input_stopped: { readonly chunkCount: number; readonly byteLength: number };
  readonly transcription_started: { readonly provider: string };
  readonly transcription_partial: { readonly text: string };
  readonly speech_activity_started: { readonly source: 'confirmed-user-speech' | 'possible-noise'; readonly segmentId?: string };
  readonly speech_activity_ended: { readonly segmentId?: string };
  readonly transcription_completed: { readonly text: string };
  readonly synthesis_started: { readonly provider: string; readonly textLength: number };
  readonly synthesis_completed: {
    readonly provider: string;
    readonly format: AudioFormat;
    readonly byteLength: number;
    readonly durationMs?: number;
  };
  readonly audio_output_started: { readonly format: AudioFormat; readonly byteLength: number };
  readonly audio_output_stopped: { readonly reason: 'completed' | 'cancelled' | 'failed' };
  readonly audio_chunk_received: {
    readonly source: 'capture' | 'tts';
    readonly sequence: number;
    readonly byteLength: number;
    readonly format: AudioFormat;
    readonly timestampMs: number;
  };
  readonly transcription_final: { readonly text: string; readonly segmentId?: string };
  readonly tts_chunk_ready: {
    readonly sequence: number;
    readonly byteLength: number;
    readonly format: AudioFormat;
    readonly timestampMs: number;
  };
  readonly playback_started: { readonly deviceId: string; readonly format: AudioFormat };
  readonly playback_progress: {
    readonly deviceId: string;
    readonly sequence: number;
    readonly playedBytes: number;
    readonly bufferedBytes: number;
  };
  readonly interruption_requested: { readonly reason: Extract<VoiceTerminationReason, 'interrupted' | 'superseded'> };
  readonly interruption_completed: { readonly reason: Extract<VoiceTerminationReason, 'interrupted' | 'superseded'> };
  readonly operation_superseded: { readonly replacementOperationId: string };
  readonly voice_completed: { readonly state: 'completed' };
  readonly voice_cancelled: {
    readonly state: 'cancelled';
    readonly reason?: string;
    readonly reasonCode?: Exclude<VoiceTerminationReason, 'completed' | 'failed'>;
  };
  readonly voice_failed: { readonly state: 'failed'; readonly code: string; readonly message: string };
}

export type VoiceEventType = keyof VoiceEventPayloadMap;

export interface VoiceEventEnvelope<K extends VoiceEventType = VoiceEventType> {
  readonly eventId: string;
  readonly voiceSessionId: string;
  readonly correlationId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly monotonicMs: number;
  readonly type: K;
  readonly payload: VoiceEventPayloadMap[K];
}

export type VoiceEventMap = {
  [K in VoiceEventType]: VoiceEventEnvelope<K>;
};

export type VoiceEvent = {
  [K in VoiceEventType]: VoiceEventEnvelope<K>;
}[VoiceEventType];

export type VoiceOperationResult<T> =
  | { readonly status: 'completed'; readonly value: T }
  | {
      readonly status: 'cancelled';
      readonly reason?: string;
      readonly reasonCode?: Exclude<VoiceTerminationReason, 'completed' | 'failed'>;
    }
  | { readonly status: 'failed'; readonly code: string; readonly message: string };

export interface VoiceOperationHandle<T> {
  readonly id: string;
  readonly voiceSessionId: string;
  readonly correlationId: string;
  readonly signal: AbortSignal;
  readonly state: VoiceState;
  readonly voiceSession: VoiceSession;
  events(): AsyncIterable<VoiceEvent>;
  cancel(reason?: string): boolean;
  result(): Promise<VoiceOperationResult<T>>;
}

export interface VoiceSessionOptions {
  readonly sessionId: string;
  readonly voiceSessionId?: string;
  readonly correlationId: string;
  readonly mode?: VoiceMode;
}

export interface VoiceTranscriptionRequest {
  readonly sessionId: string;
}

export interface VoiceTimeoutOptions {
  readonly captureTimeoutMs?: number;
  readonly transcriptionTimeoutMs?: number;
  readonly synthesisTimeoutMs?: number;
  readonly playbackTimeoutMs?: number;
}

export interface VoiceOperationOptions extends VoiceTimeoutOptions {
  readonly signal?: AbortSignal;
  readonly correlationId?: string;
  readonly voiceSessionId?: string;
  readonly timeoutMs?: number;
}

export type VoiceStage = 'capture' | 'transcription' | 'synthesis' | 'playback';

export interface VoiceServiceOptions extends VoiceTimeoutOptions {
  readonly input: AudioInputProvider;
  readonly stt: STTProvider;
  readonly tts: TTSProvider;
  readonly output: AudioOutputProvider;
  readonly streamCapacity?: number;
  readonly defaultTimeoutMs?: number;
  readonly logger?: Logger;
  readonly streaming?: StreamingVoiceProviders;
}
