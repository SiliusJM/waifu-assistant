import { randomUUID } from 'node:crypto';
import type { EventBus } from '../realtime/event-bus.js';
import { InteractionStream } from '../realtime/interaction-stream.js';
import { VoiceError } from './voice-errors.js';
import { BoundedAsyncQueue } from './bounded-async-queue.js';
import { VoiceLatencyTracker } from './voice-metrics.js';
import type {
  VoiceEvent,
  VoiceEventEnvelope,
  VoiceEventMap,
  VoiceEventPayloadMap,
  VoiceOperationResult,
  VoiceState,
  VoiceTerminationReason,
} from './voice-types.js';
import type { VoiceSession } from './voice-session.js';
import type {
  StreamingVoiceOperationHandle,
  VoiceLatencyMetrics,
} from './streaming-types.js';

const TERMINAL_STATES = new Set<VoiceState>(['completed', 'cancelled', 'failed']);
const ALLOWED_TRANSITIONS: Readonly<Record<VoiceState, readonly VoiceState[]>> = {
  created: ['capturing', 'transcribing', 'synthesizing', 'cancelling', 'failed'],
  capturing: ['transcribing', 'cancelling', 'failed'],
  transcribing: ['completed', 'cancelling', 'failed'],
  synthesizing: ['playing', 'cancelling', 'failed'],
  playing: ['completed', 'cancelling', 'failed'],
  cancelling: ['cancelled', 'failed'],
  completed: [],
  cancelled: [],
  failed: [],
};

export interface StageSignal {
  readonly signal: AbortSignal;
  close(): void;
}

export class StreamingVoiceOperation<T> implements StreamingVoiceOperationHandle<T> {
  readonly signal: AbortSignal;
  readonly textInput: BoundedAsyncQueue<string>;
  private readonly controller = new AbortController();
  private readonly stream: InteractionStream<VoiceEvent>;
  private readonly completion: Promise<VoiceOperationResult<T>>;
  private readonly tracker = new VoiceLatencyTracker();
  private resolveCompletion!: (result: VoiceOperationResult<T>) => void;
  private currentState: VoiceState = 'created';
  private sequence = 0;
  private terminalResult: VoiceOperationResult<T> | undefined;
  private terminalFinalized = false;
  private terminationReason: Exclude<VoiceTerminationReason, 'completed' | 'failed'> | undefined;
  private terminationMessage: string | undefined;
  private replacementOperationId: string | undefined;
  private timeoutStage: string | undefined;
  private terminationEventsEmitted = false;
  private readonly externalCleanup: (() => void)[] = [];

  constructor(
    readonly id: string = randomUUID(),
    readonly voiceSessionId: string,
    readonly correlationId: string,
    readonly voiceSession: VoiceSession,
    capacity: number,
    textCapacity: number,
    readonly bus: EventBus<VoiceEventMap>,
  ) {
    this.signal = this.controller.signal;
    this.stream = new InteractionStream<VoiceEvent>({ capacity });
    this.textInput = new BoundedAsyncQueue<string>(textCapacity);
    this.completion = new Promise<VoiceOperationResult<T>>((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  get state(): VoiceState { return this.currentState; }
  get reasonCode(): Exclude<VoiceTerminationReason, 'completed' | 'failed'> | undefined {
    return this.terminationReason;
  }
  get reason(): string | undefined { return this.terminationMessage; }
  get timedOut(): boolean { return this.terminationReason === 'timeout'; }
  get timedOutStage(): string | undefined { return this.timeoutStage; }
  get replacementId(): string | undefined { return this.replacementOperationId; }

  readonly abortCaller = (): void => {
    this.cancel('Caller cancelled the voice operation.');
  };

  events(): AsyncIterable<VoiceEvent> { return this.stream; }
  result(): Promise<VoiceOperationResult<T>> { return this.completion; }
  metrics(): VoiceLatencyMetrics { return this.tracker.snapshot(); }
  mark(metric: string): void { this.tracker.mark(metric); }

  transition(to: VoiceState): void {
    if (!ALLOWED_TRANSITIONS[this.currentState].includes(to)) {
      throw new VoiceError('The voice operation state transition is invalid.', 'VOICE_STATE_ERROR');
    }
    this.currentState = to;
  }

  isCancelling(): boolean { return this.currentState === 'cancelling'; }
  isTerminal(): boolean { return TERMINAL_STATES.has(this.currentState); }

  cancel(reason = 'Caller cancelled the voice operation.'): boolean {
    return this.requestTermination('cancelled', reason);
  }

  interrupt(reason = 'The voice operation was interrupted.'): boolean {
    return this.requestTermination('interrupted', reason);
  }

  supersede(replacementOperationId: string): boolean {
    this.replacementOperationId = replacementOperationId;
    return this.requestTermination('superseded', 'The voice operation was superseded.');
  }

  shutdown(reason = 'The voice service is shutting down.'): boolean {
    return this.requestTermination('shutdown', reason);
  }

  timeout(stage: string): boolean {
    this.timeoutStage = stage;
    return this.requestTermination('timeout', 'The voice operation timed out during ' + stage + '.');
  }

  async pushText(text: string, signal = this.signal): Promise<void> {
    if (!text) return;
    if (!(await this.textInput.enqueue(text, signal))) {
      throw new VoiceError('The streaming text input queue is closed.', 'VOICE_BACKPRESSURE_ERROR');
    }
  }

  async endInput(): Promise<void> { this.textInput.finish(); }

  addExternalCleanup(cleanup: () => void): void { this.externalCleanup.push(cleanup); }

  createStageSignal(): StageSignal {
    const controller = new AbortController();
    const onOperationAbort = (): void => controller.abort(this.reasonCode);
    if (this.signal.aborted) onOperationAbort();
    else this.signal.addEventListener('abort', onOperationAbort, { once: true });
    return {
      signal: controller.signal,
      close: () => this.signal.removeEventListener('abort', onOperationAbort),
    };
  }

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
    if (!accepted) throw new VoiceError('The voice event stream was cancelled.', 'VOICE_CANCELLATION_ERROR');
    this.bus.publish(type, event as unknown as VoiceEventMap[K]);
  }

  async emitTerminationEvents(): Promise<void> {
    if (this.terminationEventsEmitted || !this.terminationReason) return;
    this.terminationEventsEmitted = true;
    if (this.terminationReason === 'interrupted' || this.terminationReason === 'superseded') {
      await this.emit('interruption_requested', { reason: this.terminationReason }, true);
      if (this.terminationReason === 'superseded' && this.replacementOperationId) {
        await this.emit('operation_superseded', { replacementOperationId: this.replacementOperationId }, true);
      }
    }
  }

  async finishCompleted(value: T): Promise<void> {
    if (this.isCancelling()) {
      if (this.reasonCode === 'timeout') await this.finishFailed('VOICE_TIMEOUT_ERROR', this.reason ?? 'Voice operation timed out.');
      else await this.finishCancelled();
      return;
    }
    if (!this.reserveTerminal({ status: 'completed', value })) {
      if (this.reasonCode === 'timeout') await this.finishFailed('VOICE_TIMEOUT_ERROR', this.reason ?? 'Voice operation timed out.');
      else if (this.isCancelling()) await this.finishCancelled();
      return;
    }
    try {
      await this.emit('voice_completed', { state: 'completed' }, true);
    } finally {
      this.finalizeTerminal();
    }
  }

  async finishCancelled(): Promise<void> {
    if (this.isTerminal()) return;
    await this.emitTerminationEvents();
    if (!this.reserveTerminal({
      status: 'cancelled',
      reason: this.terminationMessage,
      reasonCode: this.terminationReason,
    })) return;
    try {
      if (this.terminationReason === 'interrupted' || this.terminationReason === 'superseded') {
        await this.emit('interruption_completed', { reason: this.terminationReason }, true);
      }
      await this.emit('voice_cancelled', {
        state: 'cancelled',
        reason: this.terminationMessage,
        reasonCode: this.terminationReason,
      }, true);
    } finally {
      this.finalizeTerminal();
    }
  }

  async finishFailed(code: string, message: string): Promise<void> {
    if (this.isTerminal()) return;
    if (this.isCancelling() && this.reasonCode !== 'timeout') {
      await this.finishCancelled();
      return;
    }
    if (!this.reserveTerminal({ status: 'failed', code, message })) return;
    try {
      await this.emit('voice_failed', { state: 'failed', code, message }, true);
    } finally {
      this.finalizeTerminal();
    }
  }

  close(): void {
    this.cleanupExternal();
    this.textInput.close();
    this.stream.close();
  }

  cleanupExternal(): void {
    for (const cleanup of this.externalCleanup.splice(0)) cleanup();
  }

  private reserveTerminal(result: VoiceOperationResult<T>): boolean {
    if (this.terminalResult !== undefined || this.isTerminal()) return false;
    this.transition(result.status);
    this.terminalResult = result;
    return true;
  }

  private finalizeTerminal(): void {
    if (this.terminalFinalized || this.terminalResult === undefined) return;
    this.terminalFinalized = true;
    this.voiceSession.markFinished();
    this.resolveCompletion(this.terminalResult);
    this.stream.close();
  }

  private requestTermination(
    reason: Exclude<VoiceTerminationReason, 'completed' | 'failed'>,
    message: string,
  ): boolean {
    if (this.isTerminal() || this.isCancelling()) return false;
    this.terminationReason = reason;
    this.terminationMessage = message;
    if (reason !== 'timeout') this.mark(reason === 'shutdown' ? 'shutdown' : reason === 'cancelled' ? 'cancellation' : 'interruption_requested');
    this.transition('cancelling');
    this.controller.abort(reason);
    return true;
  }
}
