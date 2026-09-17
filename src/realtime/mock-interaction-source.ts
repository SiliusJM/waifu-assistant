import type {
  InteractionSource,
  InteractionSourceContext,
  RealtimeInteractionRequest,
} from './realtime-types.js';

export interface MockInteractionSourceOptions {
  readonly chunks?: readonly string[];
  readonly delayMs?: number;
  readonly failure?: Error;
}

function abortError(): Error {
  const error = new Error('The mock interaction was cancelled.');
  error.name = 'AbortError';
  return error;
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class MockInteractionSource implements InteractionSource {
  private readonly chunks: readonly string[];
  private readonly delayMs: number;
  private readonly failure?: Error;

  constructor(options: MockInteractionSourceOptions = {}) {
    this.chunks = options.chunks ?? ['mock realtime response'];
    this.delayMs = options.delayMs ?? 0;
    this.failure = options.failure;
    if (!Number.isInteger(this.delayMs) || this.delayMs < 0) {
      throw new RangeError('Mock interaction delay must be a non-negative integer.');
    }
  }

  async *run(
    request: RealtimeInteractionRequest,
    context: InteractionSourceContext,
  ) {
    void request;
    if (this.failure) throw this.failure;
    for (const chunk of this.chunks) {
      if (this.delayMs > 0) await wait(this.delayMs, context.signal);
      if (context.signal.aborted) throw abortError();
      yield { type: 'text_delta' as const, delta: chunk };
    }
    yield { type: 'completed' as const };
  }
}
