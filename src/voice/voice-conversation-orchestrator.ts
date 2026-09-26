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
  | { readonly type: 'speechStart'; readonly source: VoiceActivitySource; readonly generation: number; readonly segmentId?: string }
  | { readonly type: 'speechEnd'; readonly generation: number; readonly segmentId?: string }
  | { readonly type: 'transcriptionSegment'; readonly text: string; readonly generation: number; readonly segmentId?: string }
  | { readonly type: 'assistantSpeechStart'; readonly text: string; readonly generation: number }
  | { readonly type: 'assistantSpeechEnd'; readonly generation: number }
  | { readonly type: 'assistantCue'; readonly text: string; readonly generation: number }
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
  /** Small ambiguity pause before one local cue; no long wait or repeated cue loop. */
  readonly ambiguousPauseMs?: number;
}

export type VoiceActivitySource = 'confirmed-user-speech' | 'possible-noise' | 'self-voice';

interface FinalTranscript {
  readonly generation: number;
  readonly text: string;
  readonly ephemeralContext?: string;
  readonly localResponse?: string;
}

interface InterruptedResponseContext {
  readonly sessionId: string;
  readonly userText: string;
  readonly assistantText: string;
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
  speechStarted: boolean;
  speechEnded: boolean;
}

const MAX_TRANSCRIPT_CHARACTERS = 2000;
const MAX_INTERRUPTED_ASSISTANT_CHARACTERS = 1200;
const MAX_INTERRUPTED_USER_CHARACTERS = 600;
const RESUME_PHRASES = new Set([
  'continua', 'sigue', 'puedes continuar', 'puedes seguir', 'que decias',
  'en que estabas', 'termina lo que estabas diciendo',
]);
const TOPIC_CHANGE_PHRASES = [
  'cambiando de tema', 'otra cosa', 'hablemos de otra cosa', 'olvida eso', 'dejemos eso',
];
const MAX_NON_SPEECH_ANNOTATION_CHARACTERS = 80;

/**
 * Whisper can represent detected music or other non-verbal audio as a short
 * caption-like annotation. This recognizes notation, not particular words, so
 * ordinary short utterances such as "sí", "no" or "Yuki" remain valid.
 */
function isNonSpeechAnnotation(text: string): boolean {
  const value = text.normalize('NFKC').trim();
  const length = Array.from(value).length;
  if (length < 2 || length > MAX_NON_SPEECH_ANNOTATION_CHARACTERS) return false;
  return /^\[[^\]\r\n]{1,78}\]?$/u.test(value)
    || /^\([^\r\n)]{1,78}\)$/u.test(value)
    || /^\*[^*\r\n]{1,78}\*$/u.test(value);
}

function normalizeIntent(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').toLocaleLowerCase().replace(/[¿?¡!.,;:]/gu, '').trim();
}

export function isVoiceResumeIntent(text: string): boolean {
  return RESUME_PHRASES.has(normalizeIntent(text));
}

function isExplicitTopicChange(text: string): boolean {
  const normalized = normalizeIntent(text);
  return TOPIC_CHANGE_PHRASES.some((phrase) => normalized.includes(phrase));
}

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
  private readonly ambiguousPauseMs: number;
  private readonly listeners = new Set<(event: VoiceConversationEvent) => void>();
  private currentState: VoiceInteractionState = 'idle';
  private generation = 0;
  private pendingFinal: FinalTranscript | undefined;
  private activeTurn: ActiveTurn | undefined;
  private activeSynthesis: ActiveSynthesis | undefined;
  private activeCapture: StreamingVoiceOperationHandle<TranscriptionResult> | undefined;
  private captureTask: Promise<void> | undefined;
  private drainPromise: Promise<void> | undefined;
  private interruptedContext: InterruptedResponseContext | undefined;
  private interruptedContextSessionId: string;
  private currentAssistantText = '';
  private assistantResponseCompleted = false;
  private bargeInAwaitingTranscript = false;
  private readonly ambiguousVadSegmentIds = new Set<string>();
  private ambiguousCueEmitted = false;
  private ambiguousCueTimer: ReturnType<typeof setTimeout> | undefined;
  private activeCue: StreamingVoiceSynthesisHandle | undefined;
  private deferFinalTranscripts = false;
  private closed = false;

  constructor(options: VoiceConversationOrchestratorOptions) {
    this.runner = options.runner;
    this.voiceService = options.voiceService;
    this.conversationOptions = options.conversationOptions;
    this.maxTranscriptCharacters = options.maxTranscriptCharacters ?? MAX_TRANSCRIPT_CHARACTERS;
    this.ambiguousPauseMs = options.ambiguousPauseMs ?? 700;
    this.interruptedContextSessionId = this.runner.session.id;
    if (!Number.isInteger(this.maxTranscriptCharacters)
      || this.maxTranscriptCharacters < 1
      || this.maxTranscriptCharacters > MAX_TRANSCRIPT_CHARACTERS) {
      throw new RangeError(`maxTranscriptCharacters must be between 1 and ${MAX_TRANSCRIPT_CHARACTERS}.`);
    }
    if (!Number.isInteger(this.ambiguousPauseMs) || this.ambiguousPauseMs < 0 || this.ambiguousPauseMs > 3000) {
      throw new RangeError('ambiguousPauseMs must be between 0 and 3000.');
    }
  }

  get state(): VoiceInteractionState { return this.currentState; }

  subscribe(listener: (event: VoiceConversationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** VAD-facing contract. Only confirmed user speech interrupts active assistant work. */
  speechStart(source: VoiceActivitySource = 'confirmed-user-speech', segmentId?: string): boolean {
    if (this.closed) return false;
    this.refreshInterruptedContextScope();
    this.clearAmbiguousCueTimer();
    this.emit({ type: 'speechStart', source, generation: this.generation, ...(segmentId ? { segmentId } : {}) });
    if (source !== 'confirmed-user-speech') return true;
    if (this.activeCue) this.stopLocalCue();
    const hasActiveResponse = this.activeTurn !== undefined || this.activeSynthesis !== undefined;
    if (hasActiveResponse) {
      this.captureInterruptedContext();
      const generation = ++this.generation;
      this.pendingFinal = undefined;
      this.activeTurn?.controller.abort('Confirmed user speech interrupted the assistant turn.');
      const synthesis = this.activeSynthesis;
      if (synthesis) {
        synthesis.handle.interrupt('Confirmed user speech interrupted playback.');
        void this.stopSynthesis(synthesis, 'interrupted').catch(() => undefined);
      }
      this.bargeInAwaitingTranscript = true;
      this.ambiguousCueEmitted = false;
      this.setState('listening', generation);
    } else if (this.bargeInAwaitingTranscript) {
      // The user resumed speaking after the one-shot cue; remain in listening state.
      this.setState('listening', this.generation);
    } else {
      this.setState('listening', this.generation);
    }
    return true;
  }

  /** Arms a single short local cue after a confirmed barge-in pause. */
  speechEnd(segmentId?: string): boolean {
    if (this.closed) return false;
    this.emit({ type: 'speechEnd', generation: this.generation, ...(segmentId ? { segmentId } : {}) });
    if (!this.bargeInAwaitingTranscript || this.ambiguousCueEmitted || this.ambiguousCueTimer) return true;
    this.ambiguousCueTimer = setTimeout(() => {
      this.ambiguousCueTimer = undefined;
      if (this.closed || !this.bargeInAwaitingTranscript || this.ambiguousCueEmitted) return;
      this.ambiguousCueEmitted = true;
      this.emit({ type: 'assistantCue', text: 'Te escucho.', generation: this.generation });
      void this.speakLocalText('Te escucho.', this.generation, false).catch(() => undefined);
    }, this.ambiguousPauseMs);
    return true;
  }

  /** Clears ephemeral interruption state when an owner executes /clear or changes sessions. */
  clearInterruptedContext(): void {
    this.interruptedContext = undefined;
    this.currentAssistantText = '';
    this.bargeInAwaitingTranscript = false;
    this.ambiguousVadSegmentIds.clear();
    this.ambiguousCueEmitted = false;
    this.clearAmbiguousCueTimer();
    this.stopLocalCue();
  }

  /** Feeds a provider's transcript event. Partial text is observable but never enters ConversationRunner. */
  acceptTranscription(event: TranscriptionEvent): boolean {
    if (this.closed || (event.type !== 'partial' && event.type !== 'final') || typeof event.text !== 'string') return false;
    this.refreshInterruptedContextScope();
    const trimmed = event.text.trim();
    if (Array.from(trimmed).length > this.maxTranscriptCharacters) {
      if (event.type === 'final') this.emitError('stt', 'VOICE_STT_ERROR', this.generation);
      return false;
    }
    if (event.type === 'partial') {
      if (!trimmed) return false;
      this.clearAmbiguousCueTimer();
      if (this.activeCue) this.stopLocalCue();
      this.setState('listening', this.generation);
      this.emit({ type: 'partialTranscript', text: trimmed, generation: this.generation });
      return true;
    }
    if (!trimmed) return false;

    this.clearAmbiguousCueTimer();
    if (this.activeCue) this.stopLocalCue();
    if (!this.interruptedContext && !this.assistantResponseCompleted
      && (this.activeTurn !== undefined || this.activeSynthesis !== undefined)) {
      this.captureInterruptedContext();
    }
    let ephemeralContext: string | undefined;
    let localResponse: string | undefined;
    if (trimmed === '/clear' || trimmed === '/cancel') {
      this.clearInterruptedContext();
    } else if (this.interruptedContext) {
      if (isVoiceResumeIntent(trimmed)) {
        ephemeralContext = this.formatInterruptedContext(this.interruptedContext);
      } else if (isExplicitTopicChange(trimmed)) {
        this.clearInterruptedContext();
      } else {
        // Treat the user turn as a correction/continuation unless a topic switch is explicit.
        ephemeralContext = this.formatInterruptedContext(this.interruptedContext);
      }
    } else if (isVoiceResumeIntent(trimmed)) {
      localResponse = 'No tengo una respuesta interrumpida que pueda retomar.';
    }

    const generation = ++this.generation;
    this.pendingFinal = {
      generation,
      text: trimmed,
      ...(ephemeralContext === undefined ? {} : { ephemeralContext }),
      ...(localResponse === undefined ? {} : { localResponse }),
    };
    this.bargeInAwaitingTranscript = false;
    this.ambiguousCueEmitted = false;
    this.currentAssistantText = '';
    this.assistantResponseCompleted = false;
    this.activeTurn?.controller.abort('A newer final transcript superseded this turn.');
    if (this.activeSynthesis) this.activeSynthesis.handle.interrupt('A newer final transcript superseded playback.');
    this.setState('thinking', generation);
    this.emit({ type: 'finalTranscript', text: trimmed, generation });
    this.scheduleDrain();
    return true;
  }

  /** Starts one streaming capture/STT operation; providers remain caller-configured and may still be mocks. */
  startTranscriptionCapture(options: { readonly aggregateVadSegments?: boolean } = {}): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.activeCapture) {
      throw new VoiceError('A voice capture is already active for this conversation.', 'VOICE_CONCURRENCY_ERROR');
    }
    const captureId = randomUUID();
    const handle = this.voiceService.startStreamingTranscription({
      // Capture leases are operation-scoped so a new utterance can be recognized while TTS is speaking.
      sessionId: `${this.runner.session.id}:capture:${captureId}`,
      ...(options.aggregateVadSegments ? { aggregateVadSegments: true } : {}),
    }, { correlationId: `${this.runner.session.id}:${captureId}` });
    this.activeCapture = handle;
    const task = this.consumeTranscription(handle).finally(() => {
      if (this.activeCapture === handle) this.activeCapture = undefined;
      if (this.captureTask === task) this.captureTask = undefined;
    });
    this.captureTask = task;
    return task;
  }

  /** Cancels only the active capture; Natural Duplex uses this to discard pending audio on stop. */
  cancelTranscriptionCapture(reason = 'The active transcription capture was discarded.'): void {
    this.activeCapture?.shutdown(reason);
  }

  async consumeTranscription(handle: StreamingVoiceOperationHandle<TranscriptionResult>): Promise<void> {
    try {
      for await (const event of handle.events()) {
        if (event.type === 'speech_activity_started') {
          const source = event.payload.source;
          if (event.payload.segmentId) {
            if (source === 'possible-noise') this.ambiguousVadSegmentIds.add(event.payload.segmentId);
            else this.ambiguousVadSegmentIds.delete(event.payload.segmentId);
          }
          this.speechStart(source, event.payload.segmentId);
        } else if (event.type === 'speech_activity_ended') {
          this.speechEnd(event.payload.segmentId);
        } else if (event.type === 'transcription_partial' || event.type === 'transcription_final') {
          if (event.type === 'transcription_final' && event.payload.segmentId
            && this.ambiguousVadSegmentIds.delete(event.payload.segmentId)) {
            continue;
          }
          if (event.type === 'transcription_final' && isNonSpeechAnnotation(event.payload.text)) {
            if (this.deferFinalTranscripts) {
              this.emit({
                type: 'transcriptionSegment',
                text: '',
                generation: this.generation,
                ...('segmentId' in event.payload && event.payload.segmentId ? { segmentId: event.payload.segmentId } : {}),
              });
            }
            continue;
          }
          if (event.type === 'transcription_final' && this.deferFinalTranscripts) {
            this.emit({
              type: 'transcriptionSegment',
              text: event.payload.text,
              generation: this.generation,
              ...('segmentId' in event.payload && event.payload.segmentId ? { segmentId: event.payload.segmentId } : {}),
            });
          } else {
            this.acceptTranscription({
              type: event.type === 'transcription_partial' ? 'partial' : 'final',
              text: event.payload.text,
            });
          }
        }
      }
      const result = await handle.result();
      if (result.status === 'failed') this.reportTranscriptionFailure();
    } catch {
      this.reportTranscriptionFailure();
    } finally {
      this.ambiguousVadSegmentIds.clear();
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

  /** Natural duplex owns VAD endpointing and batches finalized VAD segments before dispatch. */
  setDeferredFinalTranscripts(deferred: boolean): void {
    if (this.activeCapture) throw new VoiceError('Transcription deferral cannot change during capture.', 'VOICE_STATE_ERROR');
    this.deferFinalTranscripts = deferred;
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearInterruptedContext();
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

      if (job.localResponse) {
        await this.speakLocalText(job.localResponse, job.generation, true);
        continue;
      }

      const turn: ActiveTurn = { generation: job.generation, controller: new AbortController() };
      this.activeTurn = turn;
      try {
        await this.runner.run(oneInput(job.text), {
          ...this.conversationOptions,
          ephemeralContext: job.ephemeralContext,
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
    this.currentAssistantText = Array.from(this.currentAssistantText + delta).slice(-MAX_INTERRUPTED_ASSISTANT_CHARACTERS).join('');
    this.emit({ type: 'assistantTextDelta', text: delta, generation: job.generation });
    let synthesis = this.activeSynthesis;
    if (!synthesis || synthesis.generation !== job.generation) {
      try {
        const handle = this.voiceService.startStreamingSynthesis({ sessionId: this.runner.session.id }, {
          correlationId: `voice-conversation-${job.generation}`,
          signal: turn.controller.signal,
        });
        synthesis = { generation: job.generation, handle, observer: Promise.resolve(), ended: false, errorEmitted: false, speechStarted: false, speechEnded: false };
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
    this.interruptedContext = undefined;
    this.bargeInAwaitingTranscript = false;
    this.ambiguousCueEmitted = false;
    this.assistantResponseCompleted = true;
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
      this.emitAssistantSpeechEnd(synthesis);
    }
  }

  private async observeSynthesis(synthesis: ActiveSynthesis): Promise<void> {
    for await (const event of synthesis.handle.events()) {
      if (synthesis.generation !== this.generation || this.closed) continue;
      if (event.type === 'playback_started') {
        synthesis.speechStarted = true;
        this.setState('speaking', synthesis.generation);
        this.emit({ type: 'assistantSpeechStart', text: this.currentAssistantText, generation: synthesis.generation });
      }
      else if (event.type === 'voice_failed') {
        const stage = event.payload.code === 'VOICE_OUTPUT_ERROR' ? 'playback' : 'tts';
        this.emitSynthesisError(synthesis, stage, event.payload.code);
      }
    }
  }

  private captureInterruptedContext(): void {
    if (this.assistantResponseCompleted) return;
    const session = this.runner.session;
    const userText = session.getMessages().filter((message) => message.role === 'user').at(-1)?.content ?? '';
    const assistantText = Array.from(this.currentAssistantText).slice(-MAX_INTERRUPTED_ASSISTANT_CHARACTERS).join('');
    if (!userText && !assistantText) return;
    this.interruptedContext = {
      sessionId: session.id,
      userText: Array.from(userText).slice(-MAX_INTERRUPTED_USER_CHARACTERS).join(''),
      assistantText,
    };
    this.interruptedContextSessionId = session.id;
  }

  private formatInterruptedContext(context: InterruptedResponseContext): string {
    return [
      `Original user topic (untrusted conversation data): ${context.userText}`,
      `Assistant text already delivered before interruption (do not repeat unless needed): ${context.assistantText}`,
    ].join('\n');
  }

  private refreshInterruptedContextScope(): void {
    const session = this.runner.session;
    if (session.id !== this.interruptedContextSessionId || session.getMessages().length === 0) {
      this.clearInterruptedContext();
      this.interruptedContextSessionId = session.id;
    }
  }

  private clearAmbiguousCueTimer(): void {
    if (this.ambiguousCueTimer === undefined) return;
    clearTimeout(this.ambiguousCueTimer);
    this.ambiguousCueTimer = undefined;
  }

  private stopLocalCue(): void {
    const cue = this.activeCue;
    if (!cue) return;
    this.activeCue = undefined;
    cue.interrupt('User speech superseded the local listening cue.');
  }

  private async speakLocalText(text: string, generation: number, finishToIdle: boolean): Promise<void> {
    if (this.closed || generation !== this.generation) return;
    if (finishToIdle) this.emit({ type: 'assistantTextDelta', text, generation });
    let handle: StreamingVoiceSynthesisHandle;
    try {
      handle = this.voiceService.startStreamingSynthesis({ sessionId: this.runner.session.id }, {
        correlationId: `voice-local-cue-${generation}`,
      });
    } catch (error) {
      this.emitError('tts', safeErrorCode(error), generation);
      if (finishToIdle) this.emit({ type: 'assistantTextComplete', text, generation });
      return;
    }
    this.activeCue = handle;
    let speechStarted = false;
    const observer = (async (): Promise<void> => {
      for await (const event of handle.events()) {
        if (generation !== this.generation || this.closed) continue;
        if (event.type === 'playback_started') {
          speechStarted = true;
          this.setState('speaking', generation);
          this.emit({ type: 'assistantSpeechStart', text, generation });
        }
      }
    })();
    try {
      await handle.pushText(text);
      await handle.endInput();
      const result = await handle.result();
      await observer;
      if (result.status === 'failed' && generation === this.generation) this.emitError('playback', result.code, generation);
    } catch (error) {
      if (generation === this.generation) this.emitError('playback', safeErrorCode(error), generation);
    } finally {
      if (this.activeCue === handle) this.activeCue = undefined;
      if (generation === this.generation && !this.closed) {
        if (speechStarted) this.emit({ type: 'assistantSpeechEnd', generation });
        if (finishToIdle) this.setState('idle', generation);
        else this.setState('listening', generation);
      }
      if (finishToIdle) this.emit({ type: 'assistantTextComplete', text, generation });
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
    this.emitAssistantSpeechEnd(synthesis);
    if (this.activeSynthesis === synthesis) this.activeSynthesis = undefined;
  }

  private emitAssistantSpeechEnd(synthesis: ActiveSynthesis): void {
    if (!synthesis.speechStarted || synthesis.speechEnded) return;
    synthesis.speechEnded = true;
    this.emit({ type: 'assistantSpeechEnd', generation: synthesis.generation });
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
