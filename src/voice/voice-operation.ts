import { randomUUID } from 'node:crypto';
import type { EventBus } from '../realtime/event-bus.js';
import { InteractionStream } from '../realtime/interaction-stream.js';
import { VoiceError } from './voice-errors.js';
import type {
  VoiceEvent,
  VoiceEventEnvelope,
  VoiceEventMap,
  VoiceEventPayloadMap,
  VoiceOperationHandle,
  VoiceOperationResult,
  VoiceStage,
  VoiceState,
} from './voice-types.js';
import type { VoiceSession } from './voice-session.js';

const TERMINAL_STATES = new Set<VoiceState>(['completed', 'cancelled', 'failed']);

const ALLOWED_TRANSITIONS: Readonly<Record<VoiceState, readonly VoiceState[]>> = {
  created: ['capturing', 'transcribing', 'synthesizing', 'cancelling'],
  capturing: ['transcribing', 'cancelling', 'failed'],
  transcribing: ['completed', 'cancelling', 'failed'],
  synthesizing: ['playing', 'completed', 'cancelling', 'failed'],
  playing: ['completed', 'cancelling', 'failed'],
  cancelling: ['cancelled', 'failed'],
  completed: [],
  cancelled: [],
  failed: [],
};

export class RuntimeVoiceOperation<T> implements VoiceOperationHandle<T> {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly stream: InteractionStream<VoiceEvent>;
  private readonly completion: Promise<VoiceOperationResult<T>>;
  private resolveCompletion!: (result: VoiceOperationResult<T>) => void;
  private currentState: VoiceState = 'created';
  private sequence = 0;
  private terminalResult: VoiceOperationResult<T> | undefined;
  private terminalFinalized = false;
  private cancelReason: string | undefined;
  private timeoutStage: VoiceStage | undefined;

  constructor(
    readonly id: string = randomUUID(),
    readonly voiceSessionId: string,
    readonly correlationId: string,
    readonly voiceSession: VoiceSession,
    capacity: number,
    readonly bus: EventBus<VoiceEventMap>,
  ) {
    this.signal = this.controller.signal;
    this.stream = new InteractionStream<VoiceEvent>({ capacity });
    this.completion = new Promise<VoiceOperationResult<T>>((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  readonly abortCaller = (): void => {
    this.cancel('Caller cancelled the voice operation.');
  };

  get state(): VoiceState { return this.currentState; }
  get reason(): string | undefined { return this.cancelReason; }
  get timedOut(): boolean { return this.timeoutStage !== undefined; }
  get timedOutStage(): VoiceStage | undefined { return this.timeoutStage; }
  events(): AsyncIterable<VoiceEvent> { return this.stream; }
  result(): Promise<VoiceOperationResult<T>> { return this.completion; }

  cancel(reason?: string): boolean {
    if (TERMINAL_STATES.has(this.currentState) || this.currentState === 'cancelling') return false;
    this.cancelReason = reason;
    this.transition('cancelling');
    this.controller.abort(reason);
    return true;
  }

  timeout(stage: VoiceStage): boolean {
    if (TERMINAL_STATES.has(this.currentState) || this.currentState === 'cancelling') return false;
    this.timeoutStage = stage;
    this.transition('cancelling');
    this.controller.abort();
    return true;
  }

  transition(to: VoiceState): void {
    if (!ALLOWED_TRANSITIONS[this.currentState].includes(to)) {
      throw new VoiceError('The voice operation state transition is invalid.', 'VOICE_STATE_ERROR');
    }
    this.currentState = to;
  }

  isCancelling(): boolean { return this.currentState === 'cancelling'; }
  isTerminal(): boolean { return TERMINAL_STATES.has(this.currentState); }

  async emit<K extends keyof VoiceEventMap>(
    type: K,
    payload: VoiceEventPayloadMap[K],
    ignoreCancellation = false,
  ): Promise<void> {
    const event = {
      eventId: randomUUID(),
      voiceSessionId: this.voiceSessionId,
      correlationId: this.correlationId,
      sequence: ++this.sequence,
      occurredAt: new Date().toISOString(),
      monotonicMs: performance.now(),
      type,
      payload,
    } as VoiceEventEnvelope<K>;
    const accepted = await this.stream.enqueue(
      event as VoiceEvent,
      ignoreCancellation ? undefined : this.signal,
    );
    if (!accepted) {
      throw new VoiceError('The voice event stream was cancelled.', 'VOICE_CANCELLATION_ERROR');
    }
    this.bus.publish(type, event as unknown as VoiceEventMap[K]);
  }

  reserveTerminal(result: VoiceOperationResult<T>): boolean {
    if (this.terminalResult !== undefined || this.isTerminal()) return false;
    this.transition(result.status);
    this.terminalResult = result;
    return true;
  }

  finalizeTerminal(): void {
    if (this.terminalFinalized || this.terminalResult === undefined) return;
    this.terminalFinalized = true;
    this.voiceSession.markFinished();
    this.resolveCompletion(this.terminalResult);
    this.stream.close();
  }

  close(): void { this.stream.close(); }
}
