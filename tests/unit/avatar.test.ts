import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AvatarError,
  AvatarRuntime,
  AvatarSignalNormalizer,
  MockAvatarProvider,
  type AvatarCharacterProfile,
  type AvatarProvider,
  type AvatarProviderCapabilities,
  type AvatarSignalInput,
} from '../../src/avatar/index.js';

const capabilities = (interruptiblePresentation: boolean): AvatarProviderCapabilities => ({
  expressions: ['neutral', 'happy'],
  animations: ['idle-loop', 'react-wave'],
  interruptiblePresentation,
  assetKinds: ['animation', 'expression'],
});

const profile: AvatarCharacterProfile = {
  characterId: 'waifu-default',
  displayName: 'Test Avatar',
  stateMappings: {
    IDLE: { expressionId: 'neutral', animationId: 'idle-loop' },
    LISTENING: { expressionId: 'neutral' },
    SPEAKING: { expressionId: 'neutral' },
  },
  reactions: { wave: { expressionId: 'happy', animationId: 'react-wave', intensity: 0.8 } },
};

function signal(type: AvatarSignalInput['type'], sourceSequence: number, sourceId = 'voice', extra: Record<string, unknown> = {}): AvatarSignalInput {
  return {
    type,
    correlationId: `correlation-${sourceId}-${sourceSequence}`,
    sourceId,
    sourceSequence,
    ...extra,
  } as AvatarSignalInput;
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function runtime(provider: AvatarProvider, options: Partial<ConstructorParameters<typeof AvatarRuntime>[0]> = {}): AvatarRuntime {
  return new AvatarRuntime({ runtimeId: 'runtime-1', characterProfile: profile, provider, ...options });
}

test('normalizer assigns one global sequence and deduplicates per source', () => {
  const normalizer = new AvatarSignalNormalizer();
  const first = normalizer.normalize(signal('listen_started', 1, 'voice'));
  const second = normalizer.normalize(signal('speech_started', 1, 'realtime'));
  const duplicate = normalizer.normalize(signal('listen_started', 1, 'voice'));

  assert.equal(first?.sequence, 1);
  assert.equal(second?.sequence, 2);
  assert.equal(duplicate, undefined);
  assert.throws(() => normalizer.normalize(signal('listen_stopped', 0, 'voice')), AvatarError);
});

test('runtime lifecycle is deterministic and stopped blocks new activity', async () => {
  const provider = new MockAvatarProvider({ capabilities: capabilities(true) });
  const avatar = runtime(provider);
  assert.equal(avatar.lifecycleState, 'CREATED');
  await avatar.initialize();
  assert.equal(avatar.lifecycleState, 'READY');
  await avatar.shutdown();
  await avatar.shutdown();
  assert.equal(avatar.lifecycleState, 'STOPPED');
  assert.equal(provider.shutdownCount, 1);
  assert.equal(avatar.submit(signal('listen_started', 1)), false);
  await assert.rejects(() => avatar.initialize(), /lifecycle/i);
});

test('visual states and reaction restore the single baseState source of truth', async () => {
  const provider = new MockAvatarProvider({ capabilities: capabilities(true) });
  const avatar = runtime(provider);
  await avatar.initialize();

  assert.equal(avatar.submit(signal('listen_started', 1)), true);
  assert.equal(avatar.currentSnapshot.state, 'LISTENING');
  assert.equal(avatar.submit(signal('speech_started', 2)), true);
  assert.equal(avatar.currentSnapshot.state, 'SPEAKING');
  assert.equal(avatar.submit(signal('reaction_requested', 3, 'user', { reactionId: 'wave' })), true);
  assert.equal(avatar.currentSnapshot.state, 'REACTION');
  assert.equal(avatar.currentSnapshot.baseState, 'SPEAKING');
  assert.equal(avatar.submit(signal('reaction_finished', 4, 'user')), true);
  assert.equal(avatar.currentSnapshot.state, 'SPEAKING');
  assert.equal(avatar.currentSnapshot.baseState, 'SPEAKING');
  assert.equal(Object.isFrozen(avatar.currentSnapshot), true);
  await avatar.shutdown();
});

test('old global sequences and duplicate global sequences are ignored by the controller', async () => {
  const provider = new MockAvatarProvider({ capabilities: capabilities(true) });
  const avatar = runtime(provider);
  await avatar.initialize();
  const first = avatar.normalizer.normalize(signal('listen_started', 1));
  assert.ok(first);
  assert.equal(avatar.accept(first), true);
  assert.equal(avatar.accept(first), false);
  assert.equal(avatar.currentSnapshot.state, 'LISTENING');
  assert.equal(avatar.accept({ ...first, sequence: first.sequence - 1 }), false);
  await avatar.shutdown();
});

test('interruptible provider aborts active presentation and never overlaps present calls', async () => {
  const provider = new MockAvatarProvider({ capabilities: capabilities(true), autoComplete: false });
  const avatar = runtime(provider);
  await avatar.initialize();
  avatar.submit(signal('listen_started', 1));
  await tick();
  avatar.submit(signal('speech_started', 2));
  await tick();
  assert.equal(provider.abortCount.value, 1);
  assert.equal(provider.presentCalls.length, 2);
  assert.equal(provider.maxConcurrentPresentations, 1);
  provider.completeNext();
  await avatar.shutdown();
});

test('initialize and shutdown race cannot publish readiness after shutdown begins', async () => {
  let resolveInitialize: ((value: AvatarProviderCapabilities) => void) | undefined;
  let shutdownCount = 0;
  const provider: AvatarProvider = {
    name: 'pending-initialize-provider',
    initialize: () => new Promise<AvatarProviderCapabilities>((resolve) => {
      resolveInitialize = resolve;
    }),
    present: async () => undefined,
    shutdown: async () => {
      shutdownCount += 1;
    },
  };
  const avatar = runtime(provider);
  const lifecycleEvents: string[] = [];
  avatar.events.subscribe('avatar_initialized', () => lifecycleEvents.push('initialized'));
  avatar.events.subscribe('avatar_ready', () => lifecycleEvents.push('ready'));
  const initializePromise = avatar.initialize();
  await tick();
  const shutdownPromise = avatar.shutdown();
  resolveInitialize?.(capabilities(true));
  await assert.rejects(() => initializePromise, AvatarError);
  await shutdownPromise;
  assert.equal(avatar.lifecycleState, 'STOPPED');
  assert.deepEqual(lifecycleEvents, []);
  assert.equal(shutdownCount, 1);
});

test('non-interruptible provider keeps one active operation and latest-wins pending snapshot', async () => {
  const provider = new MockAvatarProvider({ capabilities: capabilities(false), autoComplete: false, ignoreAbort: true });
  const avatar = runtime(provider);
  await avatar.initialize();
  avatar.submit(signal('listen_started', 1));
  await tick();
  avatar.submit(signal('speech_started', 2));
  avatar.submit(signal('visual_reset', 3));
  assert.equal(provider.presentCalls.length, 1);
  assert.equal(avatar.pendingSnapshot?.state, 'IDLE');
  assert.equal(provider.maxConcurrentPresentations, 1);
  provider.completeNext();
  await tick();
  assert.equal(provider.presentCalls.length, 2);
  assert.equal(provider.presentCalls[1]?.state, 'IDLE');
  assert.equal(provider.maxConcurrentPresentations, 1);
  provider.completeNext();
  await avatar.shutdown();
});

test('shutdown from an error is possible and provider errors stay inside avatar runtime', async () => {
  const provider = new MockAvatarProvider({ capabilities: capabilities(true), initializeError: new Error('offline') });
  const avatar = runtime(provider);
  await assert.rejects(() => avatar.initialize(), (error: unknown) => error instanceof AvatarError && error.code === 'AVATAR_PROVIDER_UNAVAILABLE_ERROR');
  assert.equal(avatar.lifecycleState, 'ERROR');
  await avatar.shutdown();
  assert.equal(avatar.lifecycleState, 'STOPPED');
});

test('capabilities can reject or strip unsupported controlled IDs', async () => {
  const rejecting = runtime(new MockAvatarProvider({ capabilities: { ...capabilities(true), animations: [] } }));
  await rejecting.initialize();
  assert.equal(rejecting.submit(signal('visual_reset', 1)), false);
  await rejecting.shutdown();

  const fallback = runtime(new MockAvatarProvider({ capabilities: { ...capabilities(true), animations: [] } }), { presentationFallback: 'strip-unsupported' });
  await fallback.initialize();
  assert.equal(fallback.submit(signal('visual_reset', 1)), true);
  assert.equal(fallback.currentSnapshot.animationId, undefined);
  await tick();
  assert.equal(fallback.activePresentation?.animationId, undefined);
  await fallback.shutdown();
});

test('capability rejection is transactional for unsupported animation and expression IDs', async () => {
  const animationProvider = new MockAvatarProvider({ capabilities: { ...capabilities(true), animations: [] } });
  const animationRuntime = runtime(animationProvider);
  await animationRuntime.initialize();
  const animationEvents: unknown[] = [];
  animationRuntime.events.subscribe('avatar_state_changed', (event) => animationEvents.push(event));
  const initialAnimationSnapshot = animationRuntime.currentSnapshot;
  assert.equal(animationRuntime.submit(signal('visual_reset', 1)), false);
  assert.equal(animationRuntime.currentSnapshot, initialAnimationSnapshot);
  assert.equal(animationRuntime.controller.visualState, 'IDLE');
  assert.equal(animationRuntime.controller.lastGlobalSequence, 0);
  assert.equal(animationEvents.length, 0);
  assert.equal(animationProvider.presentCalls.length, 0);
  assert.equal(animationRuntime.pendingSnapshot, undefined);
  assert.equal(animationRuntime.submit(signal('listen_started', 2)), true);
  assert.equal(animationRuntime.controller.lastGlobalSequence, 2);
  await animationRuntime.shutdown();

  const expressionProvider = new MockAvatarProvider({ capabilities: { ...capabilities(true), expressions: [] } });
  const expressionRuntime = runtime(expressionProvider, {
    characterProfile: { ...profile, stateMappings: { ...profile.stateMappings, IDLE: {} } },
  });
  await expressionRuntime.initialize();
  const expressionEvents: unknown[] = [];
  expressionRuntime.events.subscribe('avatar_state_changed', (event) => expressionEvents.push(event));
  const initialExpressionSnapshot = expressionRuntime.currentSnapshot;
  assert.equal(expressionRuntime.submit(signal('listen_started', 1)), false);
  assert.equal(expressionRuntime.currentSnapshot, initialExpressionSnapshot);
  assert.equal(expressionRuntime.controller.visualState, 'IDLE');
  assert.equal(expressionRuntime.controller.lastGlobalSequence, 0);
  assert.equal(expressionEvents.length, 0);
  assert.equal(expressionProvider.presentCalls.length, 0);
  assert.equal(expressionRuntime.pendingSnapshot, undefined);
  assert.equal(expressionRuntime.submit(signal('visual_reset', 2)), true);
  await expressionRuntime.shutdown();
});

test('malformed provider capabilities fail initialization before READY', async () => {
  const malformedValues: unknown[] = [
    { expressions: 'neutral', animations: [], interruptiblePresentation: true, assetKinds: [] },
    { expressions: ['neutral', 'neutral'], animations: [], interruptiblePresentation: true, assetKinds: [] },
    { expressions: [], animations: [], interruptiblePresentation: true, assetKinds: ['unsupported'] },
    { expressions: [], animations: [], interruptiblePresentation: 'yes', assetKinds: [] },
  ];

  for (const malformed of malformedValues) {
    const provider: AvatarProvider = {
      name: 'malformed-provider',
      initialize: async () => malformed as AvatarProviderCapabilities,
      present: async () => undefined,
      shutdown: async () => undefined,
    };
    const avatar = runtime(provider);
    await assert.rejects(() => avatar.initialize(), (error: unknown) => error instanceof AvatarError && (error.code === 'AVATAR_CONFIGURATION_ERROR' || error.code === 'AVATAR_CAPABILITY_ERROR'));
    assert.equal(avatar.lifecycleState, 'ERROR');
    assert.equal(avatar.providerCapabilities, undefined);
    await avatar.shutdown();
  }
});

test('avatar production source contains no process, shell, or arbitrary filesystem API', async () => {
  const files = ['avatar-controller.ts', 'avatar-errors.ts', 'avatar-policy.ts', 'avatar-runtime.ts', 'avatar-types.ts', 'mock-avatar-provider.ts'];
  const source = (await Promise.all(files.map((file) => readFile(new URL(`../../../src/avatar/${file}`, import.meta.url), 'utf8')))).join('\n');
  assert.doesNotMatch(source, /node:(child_process|fs|fs\/promises)/);
  assert.doesNotMatch(source, /\b(exec|spawn|powershell|cmd\.exe|shell)\b/i);
});
