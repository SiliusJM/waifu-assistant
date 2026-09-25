import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIProvider } from '../../src/ai/ai-provider.js';
import type { AIRequest, AIResponse, AIStreamEvent, ProviderCallOptions } from '../../src/ai/ai-types.js';
import { AssistantCore } from '../../src/core/assistant-core.js';
import { ConversationRunner } from '../../src/core/conversation-runner.js';
import type { ConversationRunOptions } from '../../src/core/conversation-runner.js';
import type { MemorySnapshot } from '../../src/memory/memory-types.js';
import { AssistantError } from '../../src/shared/errors.js';
import type { Logger } from '../../src/shared/logger.js';
import { ToolManager } from '../../src/tools/tool-manager.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import {
  MockAudioInputProvider,
  MockAudioOutputProvider,
  MockSTTProvider,
  MockStreamingAudioInputProvider,
  MockStreamingAudioOutputProvider,
  MockStreamingSTTProvider,
  MockStreamingTTSProvider,
  MockTTSProvider,
  VoiceService,
  VoiceConversationOrchestrator,
  type VoiceConversationEvent,
} from '../../src/voice/index.js';
import type { StreamingTTSProvider } from '../../src/voice/streaming-types.js';

const silentLogger: Logger = { info() {}, warn() {}, error() {} };

function response(text: string): AIResponse {
  return { text, provider: 'scripted', model: 'offline', finishReason: 'stop' };
}

class ScriptedProvider implements AIProvider {
  readonly name = 'scripted';
  readonly requests: AIRequest[] = [];
  private readonly script: (request: AIRequest, signal?: AbortSignal) => AsyncIterable<AIStreamEvent>;

  constructor(script: (request: AIRequest, signal?: AbortSignal) => AsyncIterable<AIStreamEvent>) {
    this.script = script;
  }

  async complete(): Promise<AIResponse> {
    throw new Error('complete is not expected by the stream-only fixture');
  }

  stream(request: AIRequest, options?: ProviderCallOptions): AsyncIterable<AIStreamEvent> {
    this.requests.push(request);
    return this.script(request, options?.signal);
  }
}

function fixedProvider(text = 'respuesta final'): ScriptedProvider {
  return new ScriptedProvider(async function* () {
    yield { type: 'text_delta', delta: text };
    yield { type: 'completed', response: response(text) };
  });
}

function voiceService(overrides: Partial<NonNullable<ConstructorParameters<typeof VoiceService>[0]['streaming']>> = {}): VoiceService {
  return new VoiceService({
    input: new MockAudioInputProvider(),
    stt: new MockSTTProvider(),
    tts: new MockTTSProvider(),
    output: new MockAudioOutputProvider(),
    logger: silentLogger,
    streaming: {
      input: new MockStreamingAudioInputProvider(),
      stt: new MockStreamingSTTProvider(),
      tts: new MockStreamingTTSProvider(),
      output: new MockStreamingAudioOutputProvider(),
      logger: silentLogger,
      ...overrides,
    },
  });
}

function setup(provider = fixedProvider(), options: ConstructorParameters<typeof VoiceConversationOrchestrator>[0]['conversationOptions'] = {}) {
  const core = new AssistantCore({ provider, logger: silentLogger });
  const runner = new ConversationRunner(core);
  const output = new MockStreamingAudioOutputProvider();
  const service = voiceService({ output });
  const orchestrator = new VoiceConversationOrchestrator({ runner, voiceService: service, conversationOptions: options });
  const events: VoiceConversationEvent[] = [];
  orchestrator.subscribe((event) => events.push(event));
  return { provider, runner, output, service, orchestrator, events };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('partial transcript is observable but never reaches Core or Session; one valid final creates one turn', async () => {
  const provider = fixedProvider('Hola.');
  const { runner, output, orchestrator, events } = setup(provider);

  assert.equal(orchestrator.acceptTranscription({ type: 'partial', text: '  Hola, Yu' }), true);
  assert.equal(provider.requests.length, 0);
  assert.deepEqual(runner.session.getMessages(), []);
  assert.equal(orchestrator.acceptTranscription({ type: 'final', text: ' Hola, Yuki. ' }), true);
  await orchestrator.whenIdle();

  assert.equal(provider.requests.length, 1);
  assert.deepEqual(runner.session.getMessages().map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'Hola, Yuki.' },
    { role: 'assistant', content: 'Hola.' },
  ]);
  assert.equal(events.some((event) => event.type === 'partialTranscript' && event.text === 'Hola, Yu'), true);
  assert.equal(events.some((event) => event.type === 'finalTranscript' && event.text === 'Hola, Yuki.'), true);
  assert.equal(events.some((event) => event.type === 'assistantTextComplete' && event.text === 'Hola.'), true);
  assert.equal(output.played.length > 0, true);
  assert.equal(orchestrator.state, 'idle');
});

test('empty, whitespace-only, and over-limit final transcripts are rejected without a turn', async () => {
  const { provider, runner, orchestrator, events } = setup(fixedProvider(), {},);
  assert.equal(orchestrator.acceptTranscription({ type: 'final', text: '' }), false);
  assert.equal(orchestrator.acceptTranscription({ type: 'final', text: '   \n  ' }), false);
  assert.equal(orchestrator.acceptTranscription({ type: 'final', text: 'x'.repeat(2001) }), false);
  await orchestrator.whenIdle();
  assert.equal(provider.requests.length, 0);
  assert.deepEqual(runner.session.getMessages(), []);
  assert.equal(events.some((event) => event.type === 'error' && event.stage === 'stt'), true);
});

test('unified interaction state traverses listening, thinking, speaking, then idle', async () => {
  const { orchestrator, events } = setup();
  orchestrator.acceptTranscription({ type: 'partial', text: 'consulta' });
  orchestrator.acceptTranscription({ type: 'final', text: 'consulta final' });
  await orchestrator.whenIdle();
  assert.deepEqual(events.filter((event) => event.type === 'stateChanged').map((event) => event.state), [
    'listening', 'thinking', 'speaking', 'idle',
  ]);
});

test('final input interrupts old Core and TTS, ignores stale deltas, and lets the latest turn win', async () => {
  const firstStarted = deferred();
  const abortObserved = deferred();
  let call = 0;
  const provider = new ScriptedProvider(async function* (_request, signal) {
    call += 1;
    if (call === 1) {
      yield { type: 'text_delta', delta: 'OLDONLY' };
      firstStarted.resolve();
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      abortObserved.resolve();
      yield { type: 'text_delta', delta: 'STALE' };
      yield { type: 'completed', response: response('stale answer') };
      return;
    }
    yield { type: 'text_delta', delta: 'NEW' };
    yield { type: 'completed', response: response('new answer') };
  });
  const output = new MockStreamingAudioOutputProvider({ delayMs: 40 });
  const service = voiceService({ output, stt: new MockStreamingSTTProvider({ finalText: 'nueva pregunta' }) });
  const runner = new ConversationRunner(new AssistantCore({ provider, logger: silentLogger }));
  const orchestrator = new VoiceConversationOrchestrator({ runner, voiceService: service });
  const events: VoiceConversationEvent[] = [];
  orchestrator.subscribe((event) => events.push(event));

  orchestrator.acceptTranscription({ type: 'final', text: 'primera pregunta' });
  await firstStarted.promise;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Playback did not start in time.')), 1000);
    const unsubscribe = orchestrator.subscribe((event) => {
      if (event.type === 'stateChanged' && event.state === 'speaking') {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
    });
  });
  await orchestrator.startTranscriptionCapture();
  await abortObserved.promise;
  await orchestrator.whenIdle();

  assert.equal(provider.requests.length, 2);
  assert.equal(output.stopCount >= 1, true);
  assert.equal(output.played.some((chunk) => chunk.data[1] === 'OLDONLY'.length), false);
  assert.equal(events.some((event) => event.type === 'assistantTextDelta' && event.text === 'STALE'), false);
  assert.deepEqual(runner.session.getMessages().map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'primera pregunta' },
    { role: 'user', content: 'nueva pregunta' },
    { role: 'assistant', content: 'new answer' },
  ]);
  assert.equal(orchestrator.state, 'idle');
});

test('Core/provider failure returns to idle, surfaces only a safe error code, and persists no partial assistant', async () => {
  const provider = new ScriptedProvider(async function* () {
    yield { type: 'text_delta', delta: 'partial spoken text' };
    throw new Error('private provider detail');
  });
  const { runner, orchestrator, events } = setup(provider);
  orchestrator.acceptTranscription({ type: 'final', text: 'pregunta' });
  await orchestrator.whenIdle();

  assert.equal(orchestrator.state, 'idle');
  assert.equal(events.some((event) => event.type === 'error' && event.stage === 'core' && event.code === 'PROVIDER_ERROR'), true);
  assert.equal(JSON.stringify(events).includes('private provider detail'), false);
  assert.deepEqual(runner.session.getMessages().map(({ role }) => role), ['user']);
});

test('TTS startup failure is reported safely while the completed text turn returns to idle', async () => {
  const brokenTts: StreamingTTSProvider = {
    name: 'broken-tts',
    async startSynthesis() { throw new Error('private TTS provider detail'); },
  };
  const service = voiceService({ tts: brokenTts });
  const provider = fixedProvider('texto completado');
  const runner = new ConversationRunner(new AssistantCore({ provider, logger: silentLogger }));
  const orchestrator = new VoiceConversationOrchestrator({ runner, voiceService: service });
  const events: VoiceConversationEvent[] = [];
  orchestrator.subscribe((event) => events.push(event));

  orchestrator.acceptTranscription({ type: 'final', text: 'pregunta' });
  await orchestrator.whenIdle();
  assert.equal(provider.requests.length, 1);
  assert.equal(runner.session.getMessages().at(-1)?.content, 'texto completado');
  assert.equal(events.some((event) => event.type === 'error' && event.stage === 'tts' && event.code === 'VOICE_TTS_ERROR'), true);
  assert.equal(JSON.stringify(events).includes('private TTS provider detail'), false);
  assert.equal(orchestrator.state, 'idle');
});

test('playback failure is reported without leaking provider details or preventing idle recovery', async () => {
  const output = new MockStreamingAudioOutputProvider({ failure: new Error('private output detail') });
  const service = voiceService({ output });
  const provider = fixedProvider('respuesta');
  const runner = new ConversationRunner(new AssistantCore({ provider, logger: silentLogger }));
  const orchestrator = new VoiceConversationOrchestrator({ runner, voiceService: service });
  const events: VoiceConversationEvent[] = [];
  orchestrator.subscribe((event) => events.push(event));

  orchestrator.acceptTranscription({ type: 'final', text: 'pregunta' });
  await orchestrator.whenIdle();
  assert.equal(events.some((event) => event.type === 'error' && event.stage === 'playback' && event.code === 'VOICE_OUTPUT_ERROR'), true);
  assert.equal(JSON.stringify(events).includes('private output detail'), false);
  assert.equal(orchestrator.state, 'idle');
});

test('STT failure cancels current turn, returns to idle, and does not persist partial transcript', async () => {
  const entered = deferred();
  const provider = new ScriptedProvider(async function* (_request, signal) {
    entered.resolve();
    await new Promise<void>((resolve) => {
      if (signal?.aborted) resolve();
      else signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    if (!signal?.aborted) yield { type: 'completed', response: response('unexpected') };
  });
  const { runner, orchestrator, events } = setup(provider);
  orchestrator.acceptTranscription({ type: 'partial', text: 'secreto parcial' });
  orchestrator.acceptTranscription({ type: 'final', text: 'consulta final' });
  await entered.promise;
  orchestrator.reportTranscriptionFailure();
  await orchestrator.whenIdle();
  assert.equal(orchestrator.state, 'idle');
  assert.equal(events.some((event) => event.type === 'error' && event.stage === 'stt'), true);
  assert.equal(runner.session.getMessages().some(({ content }) => content === 'secreto parcial'), false);
  assert.deepEqual(runner.session.getMessages().map(({ role }) => role), ['user']);
});

test('ConversationRunner hooks and Core policies are retained for normal tool/memory/clarification behavior', async () => {
  let memoryReads = 0;
  let toneChecks = 0;
  let formatChecks = 0;
  let clarificationChecks = 0;
  let commandsHandled = 0;
  const memory: MemorySnapshot = { version: 1, entries: [] };
  const options: ConversationRunOptions = {
    memory: async () => { memoryReads += 1; return memory; },
    onTonePreference: async () => { toneChecks += 1; return false; },
    onResponseFormatPreference: async () => { formatChecks += 1; return false; },
    clarification: {
      handle: async () => { clarificationChecks += 1; return undefined; },
      clear() {},
    },
    onCommand: async (command) => { if (command === '/remember name Yuki') commandsHandled += 1; },
  };
  const { provider, orchestrator } = setup(fixedProvider(), options);
  orchestrator.acceptTranscription({ type: 'final', text: 'mensaje normal' });
  await orchestrator.whenIdle();
  orchestrator.acceptTranscription({ type: 'final', text: 'continuación' });
  await orchestrator.whenIdle();
  orchestrator.acceptTranscription({ type: 'final', text: '/remember name Yuki' });
  await orchestrator.whenIdle();
  assert.equal(provider.requests.length, 2);
  assert.equal(provider.requests[1]?.messages.some(({ role, content }) => role === 'user' && content === 'mensaje normal'), true);
  assert.equal(commandsHandled, 1);
  assert.equal(memoryReads, 2);
  assert.equal(toneChecks, 2);
  assert.equal(formatChecks, 2);
  assert.equal(clarificationChecks, 2);
});

test('voice turns keep ToolManager authorization in the existing Core path', async () => {
  let authorizationChecks = 0;
  let actionExecutions = 0;
  let providerRound = 0;
  const registry = new ToolRegistry();
  registry.register({
    id: 'local.protected_action', name: 'Protected action', description: 'test-only protected operation', risk: 'high',
    argumentSchema: { type: 'object', properties: {} },
    execute: async () => { actionExecutions += 1; return { status: 'success', value: true }; },
  });
  const toolManager = new ToolManager({
    registry,
    logger: silentLogger,
    authorizer: { authorize: () => { authorizationChecks += 1; return { allowed: false, reason: 'confirmation-required' }; } },
  });
  const provider = new ScriptedProvider(async function* () {
    providerRound += 1;
    if (providerRound === 1) {
      yield {
        type: 'completed',
        response: {
          ...response(''),
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'call-1', name: 'local_protected_action', argumentsJson: '{}' }],
        },
      };
      return;
    }
    yield { type: 'text_delta', delta: 'No ejecuté la acción protegida.' };
    yield { type: 'completed', response: response('No ejecuté la acción protegida.') };
  });
  const runner = new ConversationRunner(new AssistantCore({
    provider,
    logger: silentLogger,
    toolManager,
    toolAllowlist: ['local.protected_action'],
  }));
  const orchestrator = new VoiceConversationOrchestrator({ runner, voiceService: voiceService() });

  orchestrator.acceptTranscription({ type: 'final', text: 'Ejecuta la acción protegida.' });
  await orchestrator.whenIdle();

  assert.equal(authorizationChecks, 1);
  assert.equal(actionExecutions, 0);
  assert.equal(providerRound, 2);
  assert.equal(runner.session.getMessages().at(-1)?.content, 'No ejecuté la acción protegida.');
});

test('shutdown cancels the active Core turn and leaves unified state idle', async () => {
  const entered = deferred();
  const provider = new ScriptedProvider(async function* (_request, signal) {
    entered.resolve();
    await new Promise<void>((resolve) => {
      if (signal?.aborted) resolve();
      else signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    if (!signal?.aborted) yield { type: 'completed', response: response('unexpected') };
  });
  const { runner, orchestrator } = setup(provider);
  orchestrator.acceptTranscription({ type: 'final', text: 'consulta' });
  await entered.promise;
  await orchestrator.shutdown();
  assert.equal(orchestrator.state, 'idle');
  assert.equal(runner.session.getMessages().some(({ role }) => role === 'assistant'), false);
  assert.equal(orchestrator.acceptTranscription({ type: 'final', text: 'después del cierre' }), false);
});

test('listeners cannot break operation lifecycle and transcript length is Unicode-aware', async () => {
  const { orchestrator, provider } = setup(fixedProvider());
  orchestrator.subscribe(() => { throw new Error('observer failure'); });
  assert.equal(orchestrator.acceptTranscription({ type: 'final', text: '🌸'.repeat(2001) }), false);
  assert.equal(orchestrator.acceptTranscription({ type: 'final', text: '🌸'.repeat(2000) }), true);
  await orchestrator.whenIdle();
  assert.equal(provider.requests.length, 1);
});

test('the orchestrator accepts only transcript events and reports upstream failure without raw errors', async () => {
  const { orchestrator, events, runner } = setup();
  assert.equal(orchestrator.acceptTranscription({ type: 'partial', text: 'partial' }), true);
  orchestrator.reportTranscriptionFailure();
  await orchestrator.whenIdle();
  assert.equal(events.some((event) => event.type === 'error' && event.stage === 'stt' && event.code === 'VOICE_STT_ERROR'), true);
  assert.deepEqual(runner.session.getMessages(), []);
});

test('streaming VoiceService capture feeds partial/final events through the orchestrator without persisting partial text', async () => {
  const { runner, orchestrator, provider, events } = setup();
  await orchestrator.startTranscriptionCapture();
  await orchestrator.whenIdle();
  assert.equal(provider.requests.length, 1);
  assert.equal(events.some((event) => event.type === 'partialTranscript'), true);
  assert.deepEqual(runner.session.getMessages().map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'streamed final' },
    { role: 'assistant', content: 'respuesta final' },
  ]);
  assert.equal(runner.session.getMessages().some(({ content }) => content.startsWith('partial-')), false);
});

test('voice conversation uses exactly one TTS endInput for a completed assistant turn', async () => {
  let endInputCount = 0;
  const baseTts = new MockStreamingTTSProvider();
  const spyTts: StreamingTTSProvider = {
    name: 'end-input-spy',
    async startSynthesis(request, options) {
      const operation = await baseTts.startSynthesis(request, options);
      return {
        pushText: (text) => operation.pushText(text),
        endInput: async () => { endInputCount += 1; await operation.endInput(); },
        chunks: () => operation.chunks(),
        completed: () => operation.completed(),
        cancel: (reason) => operation.cancel(reason),
        close: () => operation.close(),
      };
    },
  };
  const service = voiceService({ tts: spyTts });
  const provider = fixedProvider('one response');
  const runner = new ConversationRunner(new AssistantCore({ provider, logger: silentLogger }));
  const orchestrator = new VoiceConversationOrchestrator({ runner, voiceService: service });
  orchestrator.acceptTranscription({ type: 'final', text: 'question' });
  await orchestrator.whenIdle();
  assert.equal(endInputCount, 1);
});

test('provider cancellation errors are normalized by the existing Core boundary', async () => {
  const provider = new ScriptedProvider(async function* () {
    yield {
      type: 'error',
      error: new AssistantError('The request was cancelled.', { code: 'CANCELLATION_ERROR', retryable: false }),
    };
  });
  const { orchestrator, events } = setup(provider);
  orchestrator.acceptTranscription({ type: 'final', text: 'question' });
  await orchestrator.whenIdle();
  assert.equal(events.some((event) => event.type === 'error' && event.stage === 'core' && event.code === 'CANCELLATION_ERROR'), true);
});
