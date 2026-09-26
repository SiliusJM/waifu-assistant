import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NaturalDuplexController,
  NaturalDuplexStateMachine,
  resolveNaturalDuplexConfig,
  type NaturalDuplexTimerScheduler,
} from '../../src/voice/index.js';
import type { VoiceConversationEvent, VoiceConversationOrchestrator } from '../../src/voice/voice-conversation-orchestrator.js';

class FakeScheduler implements NaturalDuplexTimerScheduler {
  private now = 0;
  private nextId = 0;
  private readonly timers = new Map<number, { readonly due: number; readonly callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = ++this.nextId;
    this.timers.set(id, { due: this.now + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }

  advance(milliseconds: number): void {
    this.now += milliseconds;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= this.now)
        .sort((left, right) => left[1].due - right[1].due)[0];
      if (!due) return;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }

  get pendingCount(): number { return this.timers.size; }
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class FakeOrchestrator {
  readonly accepted: string[] = [];
  readonly deferredModes: boolean[] = [];
  startCount = 0;
  private readonly listeners = new Set<(event: VoiceConversationEvent) => void>();
  private activeCapture: ReturnType<typeof deferred> | undefined;

  subscribe(listener: (event: VoiceConversationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setDeferredFinalTranscripts(value: boolean): void { this.deferredModes.push(value); }

  startTranscriptionCapture(): Promise<void> {
    this.startCount += 1;
    if (this.activeCapture) throw new Error('capture already active');
    this.activeCapture = deferred();
    return this.activeCapture.promise;
  }

  stopCapture(): void {
    const capture = this.activeCapture;
    this.activeCapture = undefined;
    capture?.resolve();
  }

  acceptTranscription(event: { readonly type: 'final'; readonly text: string }): boolean {
    this.accepted.push(event.text);
    return true;
  }

  emit(event: VoiceConversationEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

class FakeMicrophone {
  stopCount = 0;
  readinessError: Error | undefined;
  stopGate: ReturnType<typeof deferred> | undefined;
  constructor(private readonly orchestrator: FakeOrchestrator) {}

  async waitUntilReady(): Promise<void> {
    if (this.readinessError) throw this.readinessError;
  }

  async stopCapture(): Promise<void> {
    this.stopCount += 1;
    this.orchestrator.stopCapture();
    await this.stopGate?.promise;
  }
}

function setup(options: { pauseGraceMs?: number; captureRotationMs?: number } = {}) {
  const scheduler = new FakeScheduler();
  const orchestrator = new FakeOrchestrator();
  const microphone = new FakeMicrophone(orchestrator);
  const controller = new NaturalDuplexController({
    microphone,
    orchestrator: orchestrator as unknown as VoiceConversationOrchestrator,
    scheduler,
    pauseGraceMs: options.pauseGraceMs ?? 500,
    captureRotationMs: options.captureRotationMs ?? 5_000,
  });
  const events: string[] = [];
  controller.subscribe((event) => {
    if (event.type === 'stateChanged') events.push(event.state);
    else events.push(`error:${event.code}`);
  });
  return { controller, microphone, orchestrator, scheduler, events };
}

function emitSpeechStart(orchestrator: FakeOrchestrator, segmentId: string, source: 'confirmed-user-speech' | 'possible-noise' | 'self-voice' = 'confirmed-user-speech'): void {
  orchestrator.emit({ type: 'speechStart', source, generation: 1, segmentId });
}

function emitSpeechEnd(orchestrator: FakeOrchestrator, segmentId: string): void {
  orchestrator.emit({ type: 'speechEnd', generation: 1, segmentId });
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

test('duplex is opt-in, has bounded defaults, and rejects unbounded or malformed configuration', () => {
  assert.deepEqual(resolveNaturalDuplexConfig({}), { enabled: false, pauseGraceMs: 500 });
  assert.deepEqual(resolveNaturalDuplexConfig({ YUKI_DUPLEX_ENABLED: 'true', YUKI_DUPLEX_PAUSE_GRACE_MS: '1200' }), {
    enabled: true,
    pauseGraceMs: 1200,
  });
  assert.throws(() => resolveNaturalDuplexConfig({ YUKI_DUPLEX_ENABLED: 'yes' }), /must be true or false/u);
  assert.throws(() => resolveNaturalDuplexConfig({ YUKI_DUPLEX_PAUSE_GRACE_MS: '2001' }), /between 0 and 2000/u);
});

test('state machine accepts lifecycle transitions and rejects stale or impossible transitions', () => {
  const machine = new NaturalDuplexStateMachine();
  assert.equal(machine.transition('speaking'), false);
  assert.equal(machine.state, 'idle');
  assert.equal(machine.transition('listening'), true);
  assert.equal(machine.transition('user_speaking'), true);
  assert.equal(machine.transition('endpoint_pending'), true);
  assert.equal(machine.transition('speaking'), true);
  assert.equal(machine.transition('thinking'), true);
  assert.equal(machine.transition('speaking'), true);
  assert.equal(machine.transition('interrupted'), true);
  assert.equal(machine.transition('user_speaking'), true);
  assert.equal(machine.transition('idle'), true);
});

test('duplex mirrors orchestrator failures back to listening without overriding live user speech', async () => {
  const { controller, orchestrator } = setup();
  await controller.start();
  orchestrator.emit({ type: 'stateChanged', state: 'thinking', generation: 2 });
  assert.equal(controller.state, 'thinking');
  orchestrator.emit({ type: 'stateChanged', state: 'idle', generation: 2 });
  assert.equal(controller.state, 'listening');
  emitSpeechStart(orchestrator, 'active-user');
  orchestrator.emit({ type: 'stateChanged', state: 'listening', generation: 3 });
  assert.equal(controller.state, 'user_speaking');
  await controller.shutdown();
});

test('short pause resets endpoint grace and aggregated utterance dispatches one turn', async () => {
  const { controller, orchestrator, scheduler } = setup();
  await controller.start();
  emitSpeechStart(orchestrator, 'part-1');
  emitSpeechEnd(orchestrator, 'part-1');
  orchestrator.emit({ type: 'transcriptionSegment', text: 'Hola', generation: 1, segmentId: 'part-1' });
  scheduler.advance(400);
  assert.deepEqual(orchestrator.accepted, [], 'a sub-grace pause must not dispatch the first fragment');
  emitSpeechStart(orchestrator, 'part-2');
  assert.equal(controller.state, 'user_speaking');
  emitSpeechEnd(orchestrator, 'part-2');
  orchestrator.emit({ type: 'transcriptionSegment', text: 'Yuki', generation: 1, segmentId: 'part-2' });
  scheduler.advance(500);
  await flushMicrotasks();

  assert.deepEqual(orchestrator.accepted, ['Hola Yuki']);
  assert.equal(orchestrator.startCount, 2);
  assert.equal(controller.state, 'thinking');
  await controller.shutdown();
});

test('duplicate speech end/final events and noise-only events do not duplicate or create a turn', async () => {
  const { controller, orchestrator, scheduler } = setup();
  await controller.start();
  emitSpeechStart(orchestrator, 'noise', 'possible-noise');
  emitSpeechEnd(orchestrator, 'noise');
  emitSpeechStart(orchestrator, 'utterance');
  emitSpeechStart(orchestrator, 'utterance');
  emitSpeechEnd(orchestrator, 'utterance');
  emitSpeechEnd(orchestrator, 'utterance');
  const finalEvent: VoiceConversationEvent = { type: 'transcriptionSegment', text: 'una vez', generation: 1, segmentId: 'utterance' };
  orchestrator.emit(finalEvent);
  orchestrator.emit(finalEvent);
  scheduler.advance(500);
  await flushMicrotasks();

  assert.deepEqual(orchestrator.accepted, ['una vez']);
  assert.equal(controller.state, 'thinking');
  await controller.shutdown();
});

test('endpoint waits for the finalized STT segment before closing its capture window', async () => {
  const { controller, microphone, orchestrator, scheduler } = setup();
  await controller.start();
  emitSpeechStart(orchestrator, 'delayed-decode');
  emitSpeechEnd(orchestrator, 'delayed-decode');
  scheduler.advance(500);
  await flushMicrotasks();
  assert.equal(microphone.stopCount, 0);
  assert.deepEqual(orchestrator.accepted, []);

  orchestrator.emit({ type: 'transcriptionSegment', text: 'decode final', generation: 1, segmentId: 'delayed-decode' });
  await flushMicrotasks();
  assert.equal(microphone.stopCount, 1);
  assert.deepEqual(orchestrator.accepted, ['decode final']);
  await controller.shutdown();
});

test('missing final STT segment fails closed after a bounded completion deadline', async () => {
  const { controller, microphone, orchestrator, scheduler, events } = setup();
  await controller.start();
  emitSpeechStart(orchestrator, 'stalled-decode');
  emitSpeechEnd(orchestrator, 'stalled-decode');
  scheduler.advance(500);
  await flushMicrotasks();
  assert.equal(controller.isActive, true);
  scheduler.advance(4_999);
  await flushMicrotasks();
  assert.equal(controller.isActive, true);
  scheduler.advance(1);
  await flushMicrotasks();
  assert.equal(controller.isActive, false);
  assert.equal(microphone.stopCount, 1);
  assert.equal(events.includes('error:VOICE_STT_ERROR'), true);
  assert.equal(events.some((event) => event.includes('native detail')), false);
});

test('confirmed speech during assistant playback enters barge-in path; possible noise is ignored', async () => {
  const { controller, orchestrator, scheduler } = setup();
  await controller.start();
  emitSpeechStart(orchestrator, 'request');
  emitSpeechEnd(orchestrator, 'request');
  orchestrator.emit({ type: 'transcriptionSegment', text: 'pregunta', generation: 1, segmentId: 'request' });
  scheduler.advance(500);
  await flushMicrotasks();
  orchestrator.emit({ type: 'assistantSpeechStart', text: 'respuesta', generation: 1 });
  assert.equal(controller.state, 'speaking');
  emitSpeechStart(orchestrator, 'noise', 'possible-noise');
  assert.equal(controller.state, 'speaking');
  emitSpeechStart(orchestrator, 'barge-in');
  assert.equal(controller.state, 'user_speaking');
  assert.deepEqual(orchestrator.accepted, ['pregunta']);
  await controller.shutdown();
});

test('bounded capture rotation reopens the mic without manufacturing an empty user turn', async () => {
  const { controller, microphone, orchestrator, scheduler } = setup({ captureRotationMs: 5_000 });
  await controller.start();
  scheduler.advance(5_000);
  await flushMicrotasks();
  assert.equal(microphone.stopCount, 1);
  assert.equal(orchestrator.startCount, 2);
  assert.deepEqual(orchestrator.accepted, []);
  assert.equal(controller.isActive, true);
  await controller.shutdown();
});

test('capture rotation during continuous speech keeps the utterance pending for its VAD endpoint', async () => {
  const { controller, microphone, orchestrator, scheduler } = setup({ captureRotationMs: 5_000 });
  await controller.start();
  emitSpeechStart(orchestrator, 'long-utterance');
  scheduler.advance(5_000);
  await flushMicrotasks();
  assert.equal(microphone.stopCount, 1);
  assert.equal(orchestrator.startCount, 2);
  assert.equal(controller.state, 'user_speaking');
  assert.deepEqual(orchestrator.accepted, []);

  emitSpeechEnd(orchestrator, 'long-utterance');
  orchestrator.emit({ type: 'transcriptionSegment', text: 'utterance segmented by capture rotation', generation: 1, segmentId: 'long-utterance' });
  scheduler.advance(500);
  await flushMicrotasks();
  assert.deepEqual(orchestrator.accepted, ['utterance segmented by capture rotation']);
  await controller.shutdown();
});

test('shutdown while listening stops capture once, clears timers, and restores normal transcript mode', async () => {
  const { controller, microphone, orchestrator, scheduler } = setup();
  await controller.start();
  assert.equal(scheduler.pendingCount, 1);
  await controller.shutdown();
  await controller.shutdown();
  assert.equal(microphone.stopCount, 1);
  assert.equal(scheduler.pendingCount, 0);
  assert.deepEqual(orchestrator.deferredModes, [true, false]);
  assert.equal(controller.state, 'idle');
  assert.equal(controller.isActive, false);
});

test('shutdown while speaking and endpoint cancellation do not double-stop or reopen capture', async () => {
  const { controller, microphone, orchestrator, scheduler } = setup();
  microphone.stopGate = deferred();
  await controller.start();
  orchestrator.emit({ type: 'assistantSpeechStart', text: 'respuesta', generation: 1 });
  assert.equal(controller.state, 'speaking');
  emitSpeechStart(orchestrator, 'cancelled-endpoint');
  emitSpeechEnd(orchestrator, 'cancelled-endpoint');
  scheduler.advance(500);
  await flushMicrotasks();
  const shutdown = controller.shutdown();
  await flushMicrotasks();
  assert.equal(microphone.stopCount, 1);
  await assert.rejects(controller.start(), /already active or shutting down/u);
  microphone.stopGate.resolve();
  await shutdown;
  await flushMicrotasks();
  assert.equal(orchestrator.startCount, 1);
  assert.equal(controller.state, 'idle');
  assert.equal(scheduler.pendingCount, 0);
  await controller.start();
  assert.equal(controller.isActive, true);
  assert.equal(orchestrator.startCount, 2);
  await controller.shutdown();
});

test('a new utterance invalidates an endpoint already waiting for capture cleanup', async () => {
  const { controller, microphone, orchestrator, scheduler } = setup();
  microphone.stopGate = deferred();
  await controller.start();
  emitSpeechStart(orchestrator, 'first');
  emitSpeechEnd(orchestrator, 'first');
  orchestrator.emit({ type: 'transcriptionSegment', text: 'primera', generation: 1, segmentId: 'first' });
  scheduler.advance(500);
  await flushMicrotasks();
  assert.equal(microphone.stopCount, 1);

  emitSpeechStart(orchestrator, 'second');
  microphone.stopGate.resolve();
  await flushMicrotasks();
  assert.deepEqual(orchestrator.accepted, []);
  assert.equal(orchestrator.startCount, 2);
  assert.equal(controller.state, 'user_speaking');
  await controller.shutdown();
});

test('microphone readiness failure fails closed and restores orchestrator mode', async () => {
  const { controller, microphone, orchestrator, events } = setup();
  microphone.readinessError = new Error('native detail must not be exposed');
  await assert.rejects(controller.start());
  assert.equal(controller.isActive, false);
  assert.deepEqual(orchestrator.deferredModes, [true, false]);
  assert.equal(controller.state, 'idle');
  assert.equal(events.some((event) => event.startsWith('error:')), false);
});
