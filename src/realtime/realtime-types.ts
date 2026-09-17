import type { Response } from '../core/response.js';
import type { Session } from '../core/session.js';
import type { ToolResult } from '../tools/tool-types.js';
import type { Logger } from '../shared/logger.js';

export const INTERACTION_STATES = [
  'created',
  'running',
  'streaming',
  'cancelling',
  'completed',
  'cancelled',
  'failed',
] as const;
export type InteractionState = (typeof INTERACTION_STATES)[number];

export interface RealtimeInteractionRequest {
  readonly session: Session;
  readonly input: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface InteractionSourceContext {
  readonly signal: AbortSignal;
  readonly interactionId: string;
  readonly correlationId: string;
  readonly sessionId: string;
  readonly logger: Logger;
}

export type InteractionSourceOutput =
  | { readonly type: 'text_delta'; readonly delta: string }
  | { readonly type: 'completed'; readonly response?: Response };

export interface InteractionSource {
  run(
    request: RealtimeInteractionRequest,
    context: InteractionSourceContext,
  ): AsyncIterable<InteractionSourceOutput>;
}

export interface RealtimeEventPayloadMap {
  readonly interaction_admitted: {
    readonly state: 'created';
  };
  readonly interaction_started: {
    readonly state: 'running';
  };
  readonly state_changed: {
    readonly from: InteractionState;
    readonly to: InteractionState;
  };
  readonly text_delta: {
    readonly delta: string;
  };
  readonly tool_started: {
    readonly toolId: string;
  };
  readonly tool_completed: {
    readonly toolId: string;
    readonly result: ToolResult<unknown>;
  };
  readonly interaction_completed: {
    readonly state: 'completed';
    readonly response?: Response;
  };
  readonly interaction_cancelled: {
    readonly state: 'cancelled';
    readonly reason?: string;
  };
  readonly interaction_failed: {
    readonly state: 'failed';
    readonly code: string;
    readonly message: string;
  };
}

export type RealtimeEventType = keyof RealtimeEventPayloadMap;

export interface RealtimeEventEnvelope<K extends RealtimeEventType = RealtimeEventType> {
  readonly eventId: string;
  readonly interactionId: string;
  readonly correlationId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly type: K;
  readonly payload: RealtimeEventPayloadMap[K];
}

export type RealtimeEventMap = {
  [K in keyof RealtimeEventPayloadMap]: RealtimeEventEnvelope<K>;
};

export type RealtimeEvent = {
  [K in RealtimeEventType]: RealtimeEventEnvelope<K>;
}[RealtimeEventType];

export type InteractionResult =
  | { readonly status: 'completed'; readonly response?: Response }
  | { readonly status: 'cancelled'; readonly reason?: string }
  | { readonly status: 'failed'; readonly code: string; readonly message: string };

export interface InteractionHandle {
  readonly id: string;
  readonly correlationId: string;
  readonly signal: AbortSignal;
  readonly state: InteractionState;
  events(): AsyncIterable<RealtimeEvent>;
  cancel(reason?: string): boolean;
  result(): Promise<InteractionResult>;
}

export interface RealtimeEngineOptions {
  readonly source: InteractionSource;
  readonly maxGlobalInteractions?: number;
  readonly maxInteractionsPerSession?: number;
  readonly streamCapacity?: number;
  readonly defaultTimeoutMs?: number;
  readonly logger?: Logger;
}

export interface StartInteractionOptions {
  readonly signal?: AbortSignal;
  readonly correlationId?: string;
  readonly timeoutMs?: number;
}
