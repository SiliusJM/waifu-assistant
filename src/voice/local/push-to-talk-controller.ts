import { VoiceError } from '../voice-errors.js';
import type { VoiceConversationOrchestrator } from '../voice-conversation-orchestrator.js';

export interface StoppableMicrophone {
  stopCapture(): Promise<void>;
  waitUntilReady?(): Promise<void>;
}

/** Explicit single-utterance PTT boundary; transcript still flows through the existing orchestrator. */
export class PushToTalkController {
  private captureTask: Promise<void> | undefined;

  constructor(
    private readonly microphone: StoppableMicrophone,
    private readonly orchestrator: VoiceConversationOrchestrator,
  ) {}

  get isCapturing(): boolean { return this.captureTask !== undefined; }

  async start(): Promise<void> {
    if (this.captureTask) throw new VoiceError('Push-to-talk capture is already active.', 'VOICE_CONCURRENCY_ERROR');
    const ready = this.microphone.waitUntilReady?.();
    const task = this.orchestrator.startTranscriptionCapture();
    this.captureTask = task;
    const clearCapture = (): void => { if (this.captureTask === task) this.captureTask = undefined; };
    void task.then(clearCapture, clearCapture);
    await ready;
  }

  async stop(): Promise<void> {
    const task = this.captureTask;
    if (!task) throw new VoiceError('Push-to-talk capture is not active.', 'VOICE_STATE_ERROR');
    await this.microphone.stopCapture();
    await task;
    await this.orchestrator.whenIdle();
  }
}
