import { VoiceError } from './voice-errors.js';

interface OperationReference {
  readonly id: string;
  supersede(replacementOperationId: string): boolean;
}

interface Owner {
  readonly operation: OperationReference;
  readonly releasePromise: Promise<void>;
  resolveRelease: () => void;
}

export interface VoiceResourceLease {
  readonly resource: 'session' | 'playback';
  readonly key: string;
  release(): void;
}

export interface VoiceAdmissionOptions {
  readonly operation: OperationReference;
  readonly sessionId: string;
  readonly deviceId?: string;
  readonly supersede?: boolean;
  readonly signal?: AbortSignal;
}

export class VoiceConcurrencyCoordinator {
  private readonly sessions = new Map<string, Owner>();
  private readonly playbacks = new Map<string, Owner>();

  async acquireSession(options: VoiceAdmissionOptions): Promise<VoiceResourceLease> {
    return this.acquire(this.sessions, 'session', options.sessionId, options);
  }

  async acquirePlayback(options: VoiceAdmissionOptions): Promise<VoiceResourceLease> {
    return this.acquire(this.playbacks, 'playback', options.deviceId ?? 'default', options);
  }

  get activeSessionCount(): number { return this.sessions.size; }
  get activePlaybackCount(): number { return this.playbacks.size; }

  private async acquire(
    owners: Map<string, Owner>,
    resource: 'session' | 'playback',
    key: string,
    options: VoiceAdmissionOptions,
  ): Promise<VoiceResourceLease> {
    while (true) {
      const existing = owners.get(key);
      if (!existing || existing.operation.id === options.operation.id) {
        const owner = this.createOwner(options.operation);
        owners.set(key, owner);
        let released = false;
        return {
          resource,
          key,
          release: () => {
            if (released) return;
            released = true;
            if (owners.get(key) === owner) owners.delete(key);
            owner.resolveRelease();
          },
        };
      }

      if (!options.supersede) {
        throw new VoiceError(
          'The voice resource is already in use.',
          'VOICE_CONCURRENCY_ERROR',
        );
      }

      if (!existing.operation.supersede(options.operation.id)) {
        throw new VoiceError(
          'The active voice operation could not be superseded.',
          'VOICE_INTERRUPTION_ERROR',
        );
      }
      await this.waitForRelease(existing.releasePromise, options.signal);
    }
  }

  private async waitForRelease(release: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new VoiceError('The voice operation was cancelled.', 'VOICE_CANCELLATION_ERROR');
    if (!signal) {
      await release;
      return;
    }
    await Promise.race([
      release,
      new Promise<never>((_, reject) => {
        const onAbort = (): void => {
          signal.removeEventListener('abort', onAbort);
          reject(new VoiceError('The voice operation was cancelled.', 'VOICE_CANCELLATION_ERROR'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        void release.finally(() => signal.removeEventListener('abort', onAbort));
      }),
    ]);
  }

  private createOwner(operation: OperationReference): Owner {
    let resolveRelease!: () => void;
    const releasePromise = new Promise<void>((resolve) => { resolveRelease = resolve; });
    return { operation, releasePromise, resolveRelease };
  }
}
