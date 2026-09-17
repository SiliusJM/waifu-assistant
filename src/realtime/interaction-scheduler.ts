import { RealtimeError } from './realtime-errors.js';

export interface InteractionSchedulerOptions {
  readonly maxGlobalInteractions?: number;
  readonly maxInteractionsPerSession?: number;
}

export class InteractionScheduler {
  readonly maxGlobalInteractions: number;
  readonly maxInteractionsPerSession: number;
  private readonly active = new Map<string, string>();

  constructor(options: InteractionSchedulerOptions = {}) {
    this.maxGlobalInteractions = options.maxGlobalInteractions ?? 4;
    this.maxInteractionsPerSession = options.maxInteractionsPerSession ?? 1;
    if (!Number.isInteger(this.maxGlobalInteractions) || this.maxGlobalInteractions < 1
      || !Number.isInteger(this.maxInteractionsPerSession) || this.maxInteractionsPerSession < 1) {
      throw new RealtimeError(
        'Realtime interaction limits must be positive integers.',
        'REALTIME_CONFIGURATION_ERROR',
      );
    }
  }

  admit(interactionId: string, sessionId: string): void {
    if (this.active.size >= this.maxGlobalInteractions) {
      throw new RealtimeError(
        'The global realtime interaction limit was reached.',
        'REALTIME_CONCURRENCY_ERROR',
      );
    }
    if (this.countForSession(sessionId) >= this.maxInteractionsPerSession) {
      throw new RealtimeError(
        'The realtime interaction limit for this session was reached.',
        'REALTIME_CONCURRENCY_ERROR',
      );
    }
    this.active.set(interactionId, sessionId);
  }

  release(interactionId: string): boolean {
    return this.active.delete(interactionId);
  }

  get activeCount(): number {
    return this.active.size;
  }

  countForSession(sessionId: string): number {
    let count = 0;
    for (const activeSessionId of this.active.values()) {
      if (activeSessionId === sessionId) count += 1;
    }
    return count;
  }
}
