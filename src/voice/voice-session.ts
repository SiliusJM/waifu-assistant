import { randomUUID } from 'node:crypto';
import type {
  CaptureState,
  PlaybackState,
  SynthesisState,
  TranscriptionState,
  VoiceSessionOptions,
} from './voice-types.js';

export class VoiceSession {
  readonly voiceSessionId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly createdAt: string;
  private currentCaptureState: CaptureState = 'idle';
  private currentTranscriptionState: TranscriptionState = 'idle';
  private currentSynthesisState: SynthesisState = 'idle';
  private currentPlaybackState: PlaybackState = 'idle';
  private completedAt: string | undefined;

  constructor(options: VoiceSessionOptions) {
    this.voiceSessionId = options.voiceSessionId ?? randomUUID();
    this.sessionId = options.sessionId;
    this.correlationId = options.correlationId;
    this.createdAt = new Date().toISOString();
  }

  get captureState(): CaptureState { return this.currentCaptureState; }
  get transcriptionState(): TranscriptionState { return this.currentTranscriptionState; }
  get synthesisState(): SynthesisState { return this.currentSynthesisState; }
  get playbackState(): PlaybackState { return this.currentPlaybackState; }
  get finishedAt(): string | undefined { return this.completedAt; }

  setCaptureState(state: CaptureState): void { this.currentCaptureState = state; }
  setTranscriptionState(state: TranscriptionState): void { this.currentTranscriptionState = state; }
  setSynthesisState(state: SynthesisState): void { this.currentSynthesisState = state; }
  setPlaybackState(state: PlaybackState): void { this.currentPlaybackState = state; }

  markFinished(): void {
    this.completedAt = new Date().toISOString();
  }
}
