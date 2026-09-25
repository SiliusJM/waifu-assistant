import { randomUUID } from 'node:crypto';
import type { ConversationRunOptions, ConversationRunner } from '../core/conversation-runner.js';
import type { Response } from '../core/response.js';
import type { VoiceService } from './voice-service.js';
import { VoiceError } from './voice-errors.js';
import type { StreamingVoiceOperationHandle, StreamingVoiceSynthesisHandle } from './streaming-types.js';
import type { TranscriptionEvent, TranscriptionResult } from './voice-types.js';

export type VoiceInteractionState = 'idle' | 'listening' | 'thinking' | 'speaking';
export type VoiceConversationErrorStage = 'stt' | 'core' | 'tts' | 'playback' | 'shutdown';

export type VoiceConversationEvent =
  | { readonly type: 'stateChanged'; readonly state: VoiceInteractionState; readonly generation: number }
  | { readonly type: 'partialTranscript'; readonly text: string; readonly generation: number }
  | { readonly type: 'finalTranscript'; readonly text: string; readonly generation: number }
  | { readonly type: 'assistantTextDelta'; readonly text: string; readonly generation: number }
  | { readonly type: 'assistantTextComplete'; readonly text: string; readonly generation: number }
  | { readonly type: 'error'; readonly stage: VoiceConversationErrorStage; readonly code: string; readonly generation: number };

export interface VoiceConversationOrchestratorOptions {
  readonly runner: ConversationRunner;
  readonly voiceService: VoiceService;
  /** Supplies the same safety/personalization hooks used by the text ConversationRunner. */
  readonly conversationOptions?: Omit<
    ConversationRunOptions,
    'signal' | 'interruptible' | 'onDelta' | 'onResponse' | 'onInterruption'
  >;
  readonly maxTranscriptCharacters?: number;
}

interface FinalTranscript {
  readonly generation: number;
  readonly text: string;
}

interface ActiveTurn {
  readonly generation: number;
  readonly controller: AbortController;
}

interface ActiveSynthesis {
  readonly generation: number;
  readonly handle: StreamingVoiceSynthesisHandle;
  observer: Promise<void>;
  ended: boolean;
  errorEmitted: boolean;
}

const MAX_TRANSCRIPT_CHARACTERS = 2000;

async function* oneInput(text: string): AsyncIterable<string> {
  yield text;
}

function safeErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(error.code)) {
    return error.code;
  }
  return 'VOICE_INTERNAL_ERROR';
}

export class VoiceConversationOrchestrator {
  private readonly runner: ConversationRunner;
  private readonly voiceService: VoiceService;
  private readonly conversationOptions: VoiceConversationOrchestratorOptions['conversationOptions'];
  private readonly maxTranscriptCharacters: number;
  private readonly listeners = new Set<(event: VoiceConversationEvent) => void>();
  private currentState: VoiceInteractionState = 'idle';
  private generation = 0;
  private pendingFinal: FinalTranscript | undefined;
  private activeTurn: ActiveTurn | undefined;
  private activeSynthesis: ActiveSynthesis | undefined;
  private activeCapture: StreamingVoiceOperationHandle<TranscriptionResult> | undefined;
  private captureTask: Promise<void> | undefined;
  private drainPromise: Promise<void> | undefined;
  private closed = false;

  constructor(options: VoiceConversationOrchestratorOptions) {
    this.runner = options.runner;
    this.voiceService = options.voiceService;
    this.conversationOptions = options.conversationOptions;
    this.maxTranscriptCharacters = options.maxTranscriptCharacters ?? MAX_TRANSCRIPT_CHARACTERS;
    if (!Number.isInteger(this.maxTranscriptCharacters)
      || this.maxTranscriptCharacters < 1
      || this.maxTranscriptCharacters > MAX_TRANSCRIPT_CHARACTERS) {
      throw new RangeError(`maxTranscriptCharacters must be between 1 and ${MAX_TRANSCRIPT_CHARACTERS}.`);
    }
  }

  get state(): VoiceInteractionState { return this.currentState; }

  subscribe(listener: (event: VoiceConversationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Feeds a provider's transcript event. Partial text is observable but never enters ConversationRunner. */
  acceptTranscription(event: TranscriptionEvent): boolean {
    if (this.closed || (event.type !== 'partial' && event.type !== 'final') || typeof event.text !== 'string') return false;
    const trimmed = event.text.trim();
    if (Array.from(trimmed).length > this.maxTranscriptCharacters) {
      if (event.type === 'final') this.emitError('stt', 'VOICE_STT_ERROR', this.generation);
      return false;
    }
    if (event.type === 'partial') {
      if (!trimmed) return false;
      this.setState('listening', this.generation);
      this.emit({ type: 'partialTranscript', text: trimmed, generation: this.generation });
      return true;
    }
    if (!trimmed) return false;

    const generation = ++this.generation;
    this.pendingFinal = { generation, text: trimmed };
    this.activeTurn?.controller.abort('A newer final transcript superseded this turn.');
    if (this.activeSynthesis) this.activeSynthesis.handle.interrupt('A newer final transcript superseded playback.');
    this.setState('thinking', generation);
    this.emit({ type: 'finalTranscript', text: trimmed, generation });
    this.scheduleDrain();
    return true;
  }

  /** Starts one streaming capture/STT operation; providers remain caller-configured and may still be mocks. */
  startTranscriptionCapture(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.activeCapture) {
      throw new VoiceError('A voice capture is already active for this conversation.', 'VOICE_CONCURRENCY_ERROR');
    }
    const captureId = randomUUID();
    const handle = this.voiceService.startStreamingTranscription({
      // Capture leases are operation-scoped so a new utterance can be recognized while TTS is speaking.
      sessionId: `${this.runner.session.id}:capture:${captureId}`,
    }, { correlationId: `${this.runner.session.id}:${captureId}` });
    this.activeCapture = handle;
    const task = this.consumeTranscription(handle).finally(() => {
      if (this.activeCapture === handle) this.activeCapture = undefined;
      if (this.captureTask === task) this.captureTask = undefined;
    });
    this.captureTask = task;
    return task;
  }

  async consumeTranscription(handle: StreamingVoiceOperationHandle<TranscriptionResult>): Promise<void> {
    try {
      for await (const event of handle.events()) {
        if (event.type === 'transcription_partial' || event.type === 'transcription_final') {
          this.acceptTranscription({
            type: event.type === 'transcription_partial' ? 'partial' : 'final',
            text: event.payload.text,
          });
        }
      }
      const result = await handle.result();
      if (result.status === 'failed') this.reportTranscriptionFailure();
    } catch {
      this.reportTranscriptionFailure();
    }
  }

  /** Reports an upstream STT failure without exposing provider messages or payloads. */
  reportTranscriptionFailure(): void {
    if (this.closed) return;
    const generation = ++this.generation;
    this.pendingFinal = undefined;
    this.activeTurn?.controller.abort('Transcription failed.');
    if (this.activeSynthesis) this.activeSynthesis.handle.cancel('Transcription failed.');
    this.emitError('stt', 'VOICE_STT_ERROR', generation);
    this.setState('idle', generation);
    this.scheduleDrain();
  }

  async whenIdle(): Promise<void> {
    await this.drainPromise;
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const generation = ++this.generation;
    this.pendingFinal = undefined;
    this.activeTurn?.controller.abort('Voice conversation is shutting down.');
    this.activeCapture?.shutdown('Voice conversation is shutting down.');
    if (this.activeSynthesis) this.activeSynthesis.handle.shutdown('Voice conversation is shutting down.');
    await this.captureTask;
    await this.drainPromise;
    await this.stopSynthesis(this.activeSynthesis, 'shutdown');
    this.setState('idle', generation);
  }

  private scheduleDrain(): void {
    if (this.drainPromise || this.closed) return;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = undefined;
      if (this.pendingFinal && !this.closed) this.scheduleDrain();
    });
  }

  private async drain(): Promise<void> {
    while (this.pendingFinal && !this.closed) {
      const job = this.pendingFinal;
      this.pendingFinal = undefined;
      if (job.generation !== this.generation) continue;

      const turn: ActiveTurn = { generation: job.generation, controller: new AbortController() };
      this.activeTurn = turn;
      try {
        await this.runner.run(oneInput(job.text), {
          ...this.conversationOptions,
          signal: turn.controller.signal,
          onDelta: async (delta) => {
            await this.forwardDelta(job, turn, delta);
          },
          onResponse: async (response) => {
            await this.completeAssistantText(job, response);
          },
          onInterruption: async () => {
            await this.stopSynthesis(this.activeSynthesis, 'interrupted');
          },
        });
      } catch (error) {
        if (!turn.controller.signal.aborted && job.generation === this.generation && !this.closed) {
          this.emitError('core', safeErrorCode(error), job.generation);
        }
      } finally {
        if (this.activeTurn === turn) this.activeTurn = undefined;
        if (this.activeSynthesis?.generation === job.generation) {
          await this.stopSynthesis(this.activeSynthesis, 'cancelled');
        }
        if (job.generation === this.generation && !this.closed && this.currentState !== 'listening') {
          this.setState('idle', job.generation);
        }
      }
    }
  }

  private async forwardDelta(job: FinalTranscript, turn: ActiveTurn, delta: string): Promise<void> {
    if (!this.isCurrent(job, turn) || !delta) return;
    this.emit({ type: 'assistantTextDelta', text: delta, generation: job.generation });
    let synthesis = this.activeSynthesis;
    if (!synthesis || synthesis.generation !== job.generation) {
      try {
        const handle = this.voiceService.startStreamingSynthesis({ sessionId: this.runner.session.id }, {
          correlationId: `voice-conversation-${job.generation}`,
          signal: turn.controller.signal,
        });
        synthesis = { generation: job.generation, handle, observer: Promise.resolve(), ended: false, errorEmitted: false };
        this.activeSynthesis = synthesis;
        synthesis.observer = this.observeSynthesis(synthesis);
      } catch (error) {
        this.emitError('tts', safeErrorCode(error), job.generation);
        return;
      }
    }
    try {
      if (this.isCurrent(job, turn) && !synthesis.ended) await synthesis.handle.pushText(delta);
    } catch (error) {
      if (this.isCurrent(job, turn)) this.emitSynthesisError(synthesis, 'tts', safeErrorCode(error));
    }
  }

  private async completeAssistantText(job: FinalTranscript, response: Response): Promise<void> {
    if (job.generation !== this.generation || this.closed) return;
    this.emit({ type: 'assistantTextComplete', text: response.text, generation: job.generation });
    const synthesis = this.activeSynthesis;
    if (!synthesis || synthesis.generation !== job.generation) return;
    try {
      if (!synthesis.ended) {
        synthesis.ended = true;
        await synthesis.handle.endInput();
      }
      const result = await synthesis.handle.result();
      if (result.status === 'failed') this.emitSynthesisError(synthesis, 'playback', result.code);
      else if (result.status === 'cancelled' && job.generation === this.generation && !this.closed) {
        this.emitSynthesisError(synthesis, 'playback', result.reasonCode ?? 'VOICE_CANCELLATION_ERROR');
      }
      await synthesis.observer;
    } catch (error) {
      this.emitSynthesisError(synthesis, 'playback', safeErrorCode(error));
    } finally {
      if (this.activeSynthesis === synthesis) this.activeSynthesis = undefined;
    }
  }

  private async observeSynthesis(synthesis: ActiveSynthesis): Promise<void> {
    for await (const event of synthesis.handle.events()) {
      if (synthesis.generation !== this.generation || this.closed) continue;
      if (event.type === 'playback_started') this.setState('speaking', synthesis.generation);
      else if (event.type === 'voice_failed') {
        const stage = event.payload.code === 'VOICE_OUTPUT_ERROR' ? 'playback' : 'tts';
        this.emitSynthesisError(synthesis, stage, event.payload.code);
      }
    }
  }

  private async stopSynthesis(synthesis: ActiveSynthesis | undefined, reason: 'interrupted' | 'cancelled' | 'shutdown'): Promise<void> {
    if (!synthesis) return;
    if (this.activeSynthesis === synthesis && !synthesis.ended) {
      synthesis.ended = true;
      if (reason === 'interrupted') synthesis.handle.interrupt('Voice turn interrupted.');
      else if (reason === 'shutdown') synthesis.handle.shutdown('Voice conversation is shutting down.');
      else synthesis.handle.cancel('Voice turn cancelled.');
    }
    await synthesis.handle.result();
    await synthesis.observer;
    if (this.activeSynthesis === synthesis) this.activeSynthesis = undefined;
  }

  private isCurrent(job: FinalTranscript, turn: ActiveTurn): boolean {
    return !this.closed && job.generation === this.generation && !turn.controller.signal.aborted;
  }

  private setState(state: VoiceInteractionState, generation: number): void {
    if (generation !== this.generation || state === this.currentState) return;
    this.currentState = state;
    this.emit({ type: 'stateChanged', state, generation });
  }

  private emitSynthesisError(synthesis: ActiveSynthesis, stage: 'tts' | 'playback', code: string): void {
    if (synthesis.errorEmitted || synthesis.generation !== this.generation || this.closed) return;
    synthesis.errorEmitted = true;
    this.emitError(stage, code, synthesis.generation);
  }

  private emitError(stage: VoiceConversationErrorStage, code: string, generation: number): void {
    this.emit({ type: 'error', stage, code, generation });
  }

  private emit(event: VoiceConversationEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* Observers cannot break the voice conversation lifecycle. */ }
    }
  }
}
