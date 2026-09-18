import type { AvatarPresentationSnapshot, AvatarProvider, AvatarProviderCapabilities } from './avatar-types.js';

export interface MockAvatarProviderOptions {
  readonly capabilities?: AvatarProviderCapabilities;
  readonly autoComplete?: boolean;
  readonly ignoreAbort?: boolean;
  readonly initializeError?: Error;
  readonly presentError?: Error;
  readonly shutdownError?: Error;
}

interface PendingPresentation {
  readonly snapshot: AvatarPresentationSnapshot;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

const DEFAULT_CAPABILITIES: AvatarProviderCapabilities = Object.freeze({
  expressions: Object.freeze([]),
  animations: Object.freeze([]),
  interruptiblePresentation: true,
  assetKinds: Object.freeze([]),
});

export class MockAvatarProvider implements AvatarProvider {
  readonly name = 'mock-avatar-provider';
  readonly presentCalls: AvatarPresentationSnapshot[] = [];
  readonly abortCount = { value: 0 };
  activePresentations = 0;
  maxConcurrentPresentations = 0;
  initializeCount = 0;
  shutdownCount = 0;
  private readonly options: MockAvatarProviderOptions;
  private readonly pending: PendingPresentation[] = [];

  constructor(options: MockAvatarProviderOptions = {}) {
    this.options = options;
  }

  async initialize(signal?: AbortSignal): Promise<AvatarProviderCapabilities> {
    this.initializeCount += 1;
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (this.options.initializeError) throw this.options.initializeError;
    return this.options.capabilities ?? DEFAULT_CAPABILITIES;
  }

  async present(snapshot: AvatarPresentationSnapshot, signal: AbortSignal): Promise<void> {
    this.presentCalls.push(snapshot);
    this.activePresentations += 1;
    this.maxConcurrentPresentations = Math.max(this.maxConcurrentPresentations, this.activePresentations);
    try {
      if (this.options.presentError) throw this.options.presentError;
      if (this.options.autoComplete ?? true) {
        if (signal.aborted && !this.options.ignoreAbort) throw new DOMException('Aborted', 'AbortError');
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const pending: PendingPresentation = { snapshot, resolve, reject };
        this.pending.push(pending);
        if (!this.options.ignoreAbort) {
          signal.addEventListener('abort', () => {
            this.abortCount.value += 1;
            const index = this.pending.indexOf(pending);
            if (index >= 0) this.pending.splice(index, 1);
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        }
      });
    } finally {
      this.activePresentations -= 1;
    }
  }

  async shutdown(signal?: AbortSignal): Promise<void> {
    this.shutdownCount += 1;
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (this.options.shutdownError) throw this.options.shutdownError;
  }

  completeNext(): void {
    const pending = this.pending.shift();
    if (pending) pending.resolve();
  }
}
