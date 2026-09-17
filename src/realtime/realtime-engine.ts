import { randomUUID } from 'node:crypto';
import { createLogger, type Logger } from '../shared/logger.js';
import { EventBus } from './event-bus.js';
import { InteractionScheduler } from './interaction-scheduler.js';
import { InteractionStream } from './interaction-stream.js';
import { RealtimeError } from './realtime-errors.js';
import { assertInteractionTransition } from './state-machine.js';
import type {
  InteractionHandle,
  InteractionResult,
  InteractionSourceOutput,
  InteractionState,
  RealtimeEngineOptions,
  RealtimeEvent,
  RealtimeEventEnvelope,
  RealtimeEventMap,
  RealtimeEventPayloadMap,
  RealtimeInteractionRequest,
  StartInteractionOptions,
} from './realtime-types.js';

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isSourceOutput(value: unknown): value is InteractionSourceOutput {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  if (value.type === 'text_delta') return 'delta' in value && typeof value.delta === 'string';
  return value.type === 'completed'
    && (!('response' in value) || value.response === undefined || typeof value.response === 'object');
}

function asRealtimeError(error: unknown): RealtimeError {
  if (error instanceof RealtimeError) return error;
  return new RealtimeError(
    'The realtime interaction failed during execution.',
    'REALTIME_EXECUTION_ERROR',
    false,
    error,
  );
}

const TERMINAL_STATES = new Set<InteractionState>(['completed', 'cancelled', 'failed']);

class RuntimeInteraction implements InteractionHandle {
  readonly signal: AbortSignal;
  private currentState: InteractionState = 'created';
  private readonly controller = new AbortController();
  private readonly stream: InteractionStream<RealtimeEvent>;
  private readonly bus: EventBus<RealtimeEventMap>;
  private readonly completion: Promise<InteractionResult>;
  private resolveCompletion!: (result: InteractionResult) => void;
  private sequence = 0;
  private cancelReason: string | undefined;
  private cancellationFrom: InteractionState | undefined;
  private cancellationEventEmitted = false;
  private timeoutTriggered = false;
  constructor(
    readonly id: string,
    readonly correlationId: string,
    capacity: number,
    bus: EventBus<RealtimeEventMap>,
  ) {
    this.signal = this.controller.signal;
    this.stream = new InteractionStream<RealtimeEvent>({ capacity });
    this.bus = bus;
    this.completion = new Promise<InteractionResult>((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  get state(): InteractionState {
    return this.currentState;
  }

  events(): AsyncIterable<RealtimeEvent> {
    return this.stream;
  }

  result(): Promise<InteractionResult> {
    return this.completion;
  }

  cancel(reason?: string): boolean {
    if (TERMINAL_STATES.has(this.currentState) || this.currentState === 'cancelling') {
      return false;
    }
    this.cancellationFrom = this.currentState;
    this.cancelReason = reason;
    this.transition('cancelling');
    this.controller.abort(reason);
    return true;
  }

  timeout(): boolean {
    if (TERMINAL_STATES.has(this.currentState) || this.currentState === 'cancelling') return false;
    this.cancellationFrom = this.currentState;
    this.timeoutTriggered = true;
    this.transition('cancelling');
    this.controller.abort();
    return true;
  }

  transition(to: InteractionState): void {
    assertInteractionTransition(this.currentState, to);
    this.currentState = to;
  }

  isTerminal(): boolean {
    return TERMINAL_STATES.has(this.currentState);
  }

  isCancelling(): boolean {
    return this.currentState === 'cancelling';
  }

  nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  async emit<K extends keyof RealtimeEventMap>(
    type: K,
    payload: RealtimeEventPayloadMap[K],
    ignoreCancellation = false,
  ): Promise<void> {
    const event = {
      eventId: randomUUID(),
      interactionId: this.id,
      correlationId: this.correlationId,
      sequence: this.nextSequence(),
      occurredAt: new Date().toISOString(),
      type,
      payload,
    } as RealtimeEventEnvelope<K>;
    const accepted = await this.stream.enqueue(
      event as RealtimeEvent,
      ignoreCancellation ? undefined : this.signal,
    );
    if (!accepted) {
      throw new RealtimeError(
        'The realtime event stream was cancelled.',
        'REALTIME_CANCELLATION_ERROR',
      );
    }
    this.bus.publish(type, event as unknown as RealtimeEventMap[K]);
  }

  async emitCancelling(): Promise<void> {
    if (this.currentState !== 'cancelling' || this.cancellationEventEmitted) return;
    const from = this.cancellationFrom;
    if (!from) return;
    this.cancellationEventEmitted = true;
    await this.emit('state_changed', { from, to: 'cancelling' }, true);
  }

  complete(result: InteractionResult): void {
    if (this.isTerminal()) return;
    this.transition(result.status);
    this.resolveCompletion(result);
    this.stream.close();
  }

  close(): void {
    this.stream.close();
  }

  get reason(): string | undefined {
    return this.cancelReason;
  }

  get timedOut(): boolean {
    return this.timeoutTriggered;
  }
}

export class RealtimeEngine {
  readonly events: EventBus<RealtimeEventMap>;
  readonly scheduler: InteractionScheduler;
  private readonly source: RealtimeEngineOptions['source'];
  private readonly streamCapacity: number;
  private readonly defaultTimeoutMs?: number;
  private readonly logger: Logger;
  private readonly interactions = new Map<string, RuntimeInteraction>();

  constructor(options: RealtimeEngineOptions) {
    this.source = options.source;
    this.events = new EventBus<RealtimeEventMap>();
    this.scheduler = new InteractionScheduler(options);
    this.streamCapacity = options.streamCapacity ?? 64;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.logger = options.logger ?? createLogger();
    if (!Number.isInteger(this.streamCapacity) || this.streamCapacity < 1
      || (this.defaultTimeoutMs !== undefined
        && (!Number.isInteger(this.defaultTimeoutMs) || this.defaultTimeoutMs <= 0))) {
      throw new RealtimeError(
        'Realtime engine options are invalid.',
        'REALTIME_CONFIGURATION_ERROR',
      );
    }
  }

  start(
    request: RealtimeInteractionRequest,
    options: StartInteractionOptions = {},
  ): InteractionHandle {
    const interaction = new RuntimeInteraction(
      randomUUID(),
      options.correlationId ?? randomUUID(),
      this.streamCapacity,
      this.events,
    );
    this.scheduler.admit(interaction.id, request.session.id);
    this.interactions.set(interaction.id, interaction);
    void this.run(interaction, request, options);
    return interaction;
  }

  cancel(interactionId: string, reason?: string): boolean {
    const interaction = this.interactions.get(interactionId);
    return interaction?.cancel(reason) ?? false;
  }

  get(interactionId: string): InteractionHandle | undefined {
    return this.interactions.get(interactionId);
  }

  private async run(
    interaction: RuntimeInteraction,
    request: RealtimeInteractionRequest,
    options: StartInteractionOptions,
  ): Promise<void> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const onCallerAbort = (): void => { interaction.cancel('Caller cancelled the interaction.'); };
    if (options.signal?.aborted) onCallerAbort();
    else options.signal?.addEventListener('abort', onCallerAbort, { once: true });
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    if (timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => { interaction.timeout(); }, timeoutMs);
    }

    try {
      await interaction.emit('interaction_admitted', { state: 'created' }, true);
      if (interaction.isCancelling()) {
        await this.finishCancellationOutcome(interaction);
        return;
      }
      interaction.transition('running');
      await interaction.emit('state_changed', { from: 'created', to: 'running' });
      await interaction.emit('interaction_started', { state: 'running' });
      if (interaction.isCancelling()) {
        await this.finishCancellationOutcome(interaction);
        return;
      }

      const context = {
        signal: interaction.signal,
        interactionId: interaction.id,
        correlationId: interaction.correlationId,
        sessionId: request.session.id,
        logger: this.logger,
      };
      for await (const output of this.source.run(request, context)) {
        if (interaction.isTerminal() || interaction.isCancelling()) break;
        if (!isSourceOutput(output)) {
          throw new RealtimeError(
            'The interaction source returned an invalid stream event.',
            'REALTIME_STREAM_ERROR',
          );
        }
        if (output.type === 'text_delta') {
          if (interaction.state === 'running') {
            interaction.transition('streaming');
            await interaction.emit('state_changed', { from: 'running', to: 'streaming' });
          }
          if (interaction.state === 'streaming') await interaction.emit('text_delta', { delta: output.delta });
        } else if (output.type === 'completed') {
          await interaction.emit('interaction_completed', { state: 'completed', response: output.response });
          interaction.complete({ status: 'completed', response: output.response });
          return;
        }
      }
      if (interaction.isCancelling()) await this.finishCancellationOutcome(interaction);
      else {
        await interaction.emit('interaction_completed', { state: 'completed' });
        interaction.complete({ status: 'completed' });
      }
    } catch (error) {
      if (interaction.isCancelling() || interaction.signal.aborted || isAbortError(error)) {
        if (interaction.timedOut) await this.finishFailed(interaction, new RealtimeError(
          'The realtime interaction timed out.',
          'REALTIME_TIMEOUT_ERROR',
        ));
        else await this.finishCancelled(interaction);
      } else {
        await this.finishFailed(interaction, asRealtimeError(error));
      }
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      options.signal?.removeEventListener('abort', onCallerAbort);
      this.scheduler.release(interaction.id);
      this.interactions.delete(interaction.id);
      interaction.close();
    }
  }

  private async finishCancelled(interaction: RuntimeInteraction): Promise<void> {
    if (interaction.isTerminal()) return;
    await interaction.emitCancelling();
    await interaction.emit('interaction_cancelled', {
      state: 'cancelled',
      reason: interaction.reason,
    }, true);
    interaction.complete({ status: 'cancelled', reason: interaction.reason });
  }

  private async finishCancellationOutcome(interaction: RuntimeInteraction): Promise<void> {
    if (interaction.timedOut) {
      await this.finishFailed(interaction, new RealtimeError(
        'The realtime interaction timed out.',
        'REALTIME_TIMEOUT_ERROR',
      ));
    } else {
      await this.finishCancelled(interaction);
    }
  }

  private async finishFailed(interaction: RuntimeInteraction, error: RealtimeError): Promise<void> {
    if (interaction.isTerminal()) return;
    if (interaction.isCancelling()) await interaction.emitCancelling();
    await interaction.emit('interaction_failed', {
      state: 'failed',
      code: error.code,
      message: error.message,
    }, true);
    interaction.complete({ status: 'failed', code: error.code, message: error.message });
  }
}
