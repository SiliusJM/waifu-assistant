import { VoiceError } from './voice-errors.js';
import type { VoiceConversationEvent, VoiceConversationOrchestrator } from './voice-conversation-orchestrator.js';
import { NaturalDuplexStateMachine, type NaturalDuplexState } from './natural-duplex-state-machine.js';

export interface NaturalDuplexMicrophone {
  stopCapture(): Promise<void>;
  waitUntilReady(): Promise<void>;
}

export interface NaturalDuplexTimerScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface NaturalDuplexControllerOptions {
  readonly microphone: NaturalDuplexMicrophone;
  readonly orchestrator: VoiceConversationOrchestrator;
  readonly pauseGraceMs?: number;
  readonly captureRotationMs?: number;
  readonly scheduler?: NaturalDuplexTimerScheduler;
}

export type NaturalDuplexEvent =
  | { readonly type: 'stateChanged'; readonly state: NaturalDuplexState }
  | { readonly type: 'error'; readonly code: string };

export interface NaturalDuplexConfig {
  readonly enabled: boolean;
  readonly pauseGraceMs: number;
}

export const DEFAULT_DUPLEX_PAUSE_GRACE_MS = 500;
export const DEFAULT_DUPLEX_CAPTURE_ROTATION_MS = 20_000;
const MAX_PAUSE_GRACE_MS = 2_000;
const MAX_CAPTURE_ROTATION_MS = 25_000;
const MIN_CAPTURE_ROTATION_MS = 5_000;
const MAX_PENDING_TRANSCRIPT_CHARACTERS = 2_000;

const nativeScheduler: NaturalDuplexTimerScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function resolveNaturalDuplexConfig(env: NodeJS.ProcessEnv = process.env): NaturalDuplexConfig {
  const enabledValue = env.YUKI_DUPLEX_ENABLED?.trim().toLowerCase() ?? '';
  if (!['', '0', '1', 'false', 'true'].includes(enabledValue)) {
    throw new VoiceError('YUKI_DUPLEX_ENABLED must be true or false.', 'VOICE_CONFIGURATION_ERROR');
  }
  const graceValue = env.YUKI_DUPLEX_PAUSE_GRACE_MS?.trim();
  const pauseGraceMs = graceValue === undefined || graceValue === ''
    ? DEFAULT_DUPLEX_PAUSE_GRACE_MS
    : Number(graceValue);
  if (!Number.isInteger(pauseGraceMs) || pauseGraceMs < 0 || pauseGraceMs > MAX_PAUSE_GRACE_MS) {
    throw new VoiceError(`YUKI_DUPLEX_PAUSE_GRACE_MS must be between 0 and ${MAX_PAUSE_GRACE_MS}.`, 'VOICE_CONFIGURATION_ERROR');
  }
  return { enabled: enabledValue === '1' || enabledValue === 'true', pauseGraceMs };
}

/**
 * Owns automatic speech endpointing and microphone capture rotation. The microphone is
 * stopped only after VAD end plus a bounded continuation grace; each completed window
 * is closed before a fresh capture begins, keeping STT buffers and device ownership bounded.
 */
export class NaturalDuplexController {
  private readonly microphone: NaturalDuplexMicrophone;
  private readonly orchestrator: VoiceConversationOrchestrator;
  private readonly pauseGraceMs: number;
  private readonly captureRotationMs: number;
  private readonly scheduler: NaturalDuplexTimerScheduler;
  private readonly machine = new NaturalDuplexStateMachine();
  private readonly listeners = new Set<(event: NaturalDuplexEvent) => void>();
  private unsubscribeOrchestrator: (() => void) | undefined;
  private captureTask: Promise<void> | undefined;
  private stoppingCapture: Promise<void> | undefined;
  private endpointTimer: unknown;
  private rotationTimer: unknown;
  private cycle: Promise<void> | undefined;
  private endpointGeneration = 0;
  private captureExpectedToStop = false;
  private active = false;
  private speechActive = false;
  private endpointGraceElapsed = false;
  private pendingTranscript = '';
  private readonly seenSegmentIds = new Set<string>();

  constructor(options: NaturalDuplexControllerOptions) {
    this.microphone = options.microphone;
    this.orchestrator = options.orchestrator;
    this.pauseGraceMs = options.pauseGraceMs ?? DEFAULT_DUPLEX_PAUSE_GRACE_MS;
    this.captureRotationMs = options.captureRotationMs ?? DEFAULT_DUPLEX_CAPTURE_ROTATION_MS;
    this.scheduler = options.scheduler ?? nativeScheduler;
    if (!Number.isInteger(this.pauseGraceMs) || this.pauseGraceMs < 0 || this.pauseGraceMs > MAX_PAUSE_GRACE_MS) {
      throw new RangeError(`pauseGraceMs must be between 0 and ${MAX_PAUSE_GRACE_MS}.`);
    }
    if (!Number.isInteger(this.captureRotationMs)
      || this.captureRotationMs < MIN_CAPTURE_ROTATION_MS || this.captureRotationMs > MAX_CAPTURE_ROTATION_MS) {
      throw new RangeError(`captureRotationMs must be between ${MIN_CAPTURE_ROTATION_MS} and ${MAX_CAPTURE_ROTATION_MS}.`);
    }
  }

  get state(): NaturalDuplexState { return this.machine.state; }
  get isActive(): boolean { return this.active; }

  subscribe(listener: (event: NaturalDuplexEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.active || this.stoppingCapture || this.cycle) {
      throw new VoiceError('Natural duplex is already active or shutting down.', 'VOICE_CONCURRENCY_ERROR');
    }
    this.active = true;
    try {
      this.orchestrator.setDeferredFinalTranscripts(true);
      this.unsubscribeOrchestrator = this.orchestrator.subscribe((event) => this.onVoiceEvent(event));
      await this.openCapture();
      if (this.active && this.state === 'idle') this.move('listening');
    } catch (error) {
      try { await this.shutdown(); } catch { /* Preserve the startup failure as the public cause. */ }
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    if (!this.active && !this.captureTask && !this.stoppingCapture) return;
    this.active = false;
    this.endpointGeneration += 1;
    this.clearTimer('endpoint');
    this.clearTimer('rotation');
    this.unsubscribeOrchestrator?.();
    this.unsubscribeOrchestrator = undefined;
    this.pendingTranscript = '';
    this.seenSegmentIds.clear();
    this.speechActive = false;
    this.endpointGraceElapsed = false;
    try {
      this.orchestrator.cancelTranscriptionCapture('Natural duplex stopped; discard pending audio.');
      await this.stopCaptureWindow();
    } finally {
      await this.cycle?.catch(() => undefined);
      try { this.orchestrator.setDeferredFinalTranscripts(false); } finally { this.move('idle'); }
    }
  }

  private onVoiceEvent(event: VoiceConversationEvent): void {
    if (!this.active) return;
    if (event.type === 'speechStart') {
      if (event.source !== 'confirmed-user-speech') return;
      if (event.segmentId && this.seenSegmentIds.has(event.segmentId)) return;
      if (event.segmentId) this.seenSegmentIds.add(event.segmentId);
      const supersedesPendingEndpoint = this.endpointGraceElapsed;
      this.endpointGeneration += 1;
      if (supersedesPendingEndpoint) {
        this.pendingTranscript = '';
        this.orchestrator.cancelTranscriptionCapture('A newer utterance superseded pending duplex audio.');
      }
      this.clearTimer('endpoint');
      this.endpointGraceElapsed = false;
      this.speechActive = true;
      if (this.state === 'speaking' || this.state === 'thinking') this.move('interrupted');
      this.move('user_speaking');
    } else if (event.type === 'speechEnd') {
      if (!this.speechActive) return;
      this.speechActive = false;
      this.move('endpoint_pending');
      this.armEndpointTimer();
    } else if (event.type === 'transcriptionSegment') {
      if (event.segmentId && this.seenSegmentIds.has(`final:${event.segmentId}`)) return;
      if (event.segmentId) this.seenSegmentIds.add(`final:${event.segmentId}`);
      const text = event.text.trim();
      if (text) {
        const combined = this.pendingTranscript ? `${this.pendingTranscript} ${text}` : text;
        this.pendingTranscript = Array.from(combined).slice(0, MAX_PENDING_TRANSCRIPT_CHARACTERS).join('');
      }
    } else if (event.type === 'assistantSpeechStart') {
      this.move('speaking');
    } else if (event.type === 'assistantSpeechEnd' || event.type === 'assistantTextComplete') {
      if (!this.speechActive && this.state !== 'endpoint_pending') this.move('listening');
    } else if (event.type === 'stateChanged') {
      if (event.state === 'idle' || event.state === 'listening') {
        if (!this.speechActive && this.state !== 'endpoint_pending') this.move('listening');
      } else if (event.state === 'thinking' || event.state === 'speaking') {
        this.move(event.state);
      }
    } else if (event.type === 'error' && event.stage === 'stt') {
      void this.failClosed(event.code);
    }
  }

  private async openCapture(): Promise<void> {
    if (!this.active || this.captureTask) return;
    let task: Promise<void>;
    try {
      task = this.orchestrator.startTranscriptionCapture({ aggregateVadSegments: true });
    } catch (error) {
      throw error instanceof VoiceError ? error : new VoiceError('Natural duplex capture could not start.', 'VOICE_CAPTURE_ERROR');
    }
    this.captureTask = task;
    void task.then(() => {
      if (this.captureTask !== task) return;
      this.captureTask = undefined;
      if (this.active && !this.captureExpectedToStop) void this.failClosed('VOICE_CAPTURE_ERROR');
    }, () => {
      if (this.captureTask === task) this.captureTask = undefined;
      if (this.active && !this.captureExpectedToStop) void this.failClosed('VOICE_CAPTURE_ERROR');
    });
    try {
      await this.microphone.waitUntilReady();
      if (this.active) this.armRotationTimer();
    } catch (error) {
      await this.stopCaptureWindow();
      throw error instanceof VoiceError ? error : new VoiceError('Natural duplex microphone did not become ready.', 'VOICE_CAPTURE_ERROR');
    }
  }

  private stopCaptureWindow(): Promise<void> {
    if (this.stoppingCapture) return this.stoppingCapture;
    const task = this.captureTask;
    if (!task) return Promise.resolve();
    const stopping = this.stopCaptureWindowOnce(task).finally(() => {
      if (this.stoppingCapture === stopping) this.stoppingCapture = undefined;
    });
    this.stoppingCapture = stopping;
    return stopping;
  }

  private async stopCaptureWindowOnce(task: Promise<void>): Promise<void> {
    this.captureExpectedToStop = true;
    this.clearTimer('rotation');
    try {
      await this.microphone.stopCapture();
      await task;
    } finally {
      if (this.captureTask === task) this.captureTask = undefined;
      this.captureExpectedToStop = false;
    }
  }

  private armEndpointTimer(): void {
    this.clearTimer('endpoint');
    const generation = ++this.endpointGeneration;
    this.endpointTimer = this.scheduler.setTimeout(() => {
      this.endpointTimer = undefined;
      if (!this.active || this.speechActive || generation !== this.endpointGeneration) return;
      this.endpointGraceElapsed = true;
      void this.runCycle('endpoint', generation).catch(() => this.failClosed('VOICE_CAPTURE_ERROR'));
    }, this.pauseGraceMs);
  }

  private armRotationTimer(): void {
    this.clearTimer('rotation');
    this.rotationTimer = this.scheduler.setTimeout(() => {
      this.rotationTimer = undefined;
      if (!this.active) return;
      if (this.state === 'endpoint_pending') {
        this.armRotationTimer();
        return;
      }
      void this.runCycle('rotation', this.endpointGeneration).catch(() => this.failClosed('VOICE_CAPTURE_ERROR'));
    }, this.captureRotationMs);
  }

  private runCycle(kind: 'endpoint' | 'rotation', generation: number): Promise<void> {
    if (this.cycle) return this.cycle;
    const cycle = this.rotateCapture(kind, generation).finally(() => {
      if (this.cycle === cycle) this.cycle = undefined;
    });
    this.cycle = cycle;
    return cycle;
  }

  private async rotateCapture(kind: 'endpoint' | 'rotation', generation: number): Promise<void> {
    await this.stopCaptureWindow();
    if (!this.active) return;
    if (kind === 'endpoint' && generation !== this.endpointGeneration) {
      await this.openCapture();
      if (this.active && this.state === 'endpoint_pending' && !this.speechActive) this.armEndpointTimer();
      return;
    }

    const text = kind === 'endpoint' ? this.pendingTranscript.trim() : '';
    if (kind === 'endpoint') {
      this.pendingTranscript = '';
      this.seenSegmentIds.clear();
      this.speechActive = false;
      this.endpointGraceElapsed = false;
      if (text) this.move('thinking');
      else this.move('listening');
    }
    const reopen = this.openCapture();
    if (text) this.orchestrator.acceptTranscription({ type: 'final', text });
    await reopen;
  }

  private async failClosed(code: string): Promise<void> {
    if (!this.active) return;
    this.emit({ type: 'error', code: /^[A-Z0-9_]{1,64}$/u.test(code) ? code : 'VOICE_CAPTURE_ERROR' });
    try { await this.shutdown(); } catch { /* Do not leak native cleanup messages to observers. */ }
  }

  private move(state: NaturalDuplexState): void {
    if (this.machine.state === state) return;
    if (!this.machine.transition(state)) return;
    this.emit({ type: 'stateChanged', state });
  }

  private clearTimer(which: 'endpoint' | 'rotation'): void {
    const timer = which === 'endpoint'
      ? this.endpointTimer
      : this.rotationTimer;
    if (timer === undefined) return;
    this.scheduler.clearTimeout(timer);
    if (which === 'endpoint') this.endpointTimer = undefined;
    else this.rotationTimer = undefined;
  }

  private emit(event: NaturalDuplexEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* Observers do not own the microphone lifecycle. */ }
    }
  }
}
