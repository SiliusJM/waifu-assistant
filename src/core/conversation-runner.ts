import type { AssistantCore, AssistantStreamEvent } from './assistant-core.js';
import type { Response } from './response.js';
import type { Session } from './session.js';
import type { PersonalitySnapshot } from '../personality/personality-types.js';
import { AssistantError } from '../shared/errors.js';
import type { MemorySnapshot } from '../memory/memory-types.js';
import { formatCapabilityHelp, resolveNaturalCapabilityHelp } from './capability-catalog.js';

export const CONVERSATION_EXIT_COMMAND = '/exit';
export const CONVERSATION_CANCEL_COMMAND = '/cancel';
export const CONVERSATION_HELP_COMMAND = '/help';
export const CONVERSATION_SUMMARY_COMMAND = '/summary';
export const CONVERSATION_TIME_COMMAND = '/time';
export const CONVERSATION_CALC_COMMAND = '/calc';
export const CONVERSATION_STATUS_COMMAND = '/status';
export const CONVERSATION_TONE_COMMAND = '/tone';
export const CONVERSATION_FORMAT_COMMAND = '/format';
export const CONVERSATION_HISTORY_COMMAND = '/history';
export const CONVERSATION_CLEAR_COMMAND = '/clear';
export const CONVERSATION_REMEMBER_COMMAND = '/remember';
export const CONVERSATION_MEMORY_COMMAND = '/memory';
export const CONVERSATION_FORGET_COMMAND = '/forget';
export const CONVERSATION_SAVE_SESSION_COMMAND = '/save-session';
export const CONVERSATION_SESSIONS_COMMAND = '/sessions';
export const CONVERSATION_SESSION_SEARCH_COMMAND = '/session-search';
export const CONVERSATION_LOAD_SESSION_COMMAND = '/load-session';
export const CONVERSATION_DELETE_SESSION_COMMAND = '/delete-session';
export const CONVERSATION_EXPORT_COMMAND = '/export';
export const CONVERSATION_RENAME_COMMAND = '/rename';
export const CONVERSATION_SESSION_INFO_COMMAND = '/session-info';
export const CONVERSATION_REMIND_COMMAND = '/remind';
export const CONVERSATION_REMINDERS_COMMAND = '/reminders';
export const CONVERSATION_REMINDER_DELETE_COMMAND = '/reminder-delete';
export const CONVERSATION_REMINDER_COMPLETE_COMMAND = '/reminder-complete';
export const CONVERSATION_NOTE_ADD_COMMAND = '/note-add';
export const CONVERSATION_NOTES_COMMAND = '/notes';
export const CONVERSATION_NOTE_SHOW_COMMAND = '/note-show';
export const CONVERSATION_NOTE_DELETE_COMMAND = '/note-delete';
export const LOCAL_COMMAND_HELP = formatCapabilityHelp();

export type ConversationRunStatus = 'completed' | 'cancelled';

export interface ConversationRunResult {
  readonly status: ConversationRunStatus;
  readonly session: Session;
  readonly responses: readonly Response[];
}

export interface ConversationRunOptions {
  readonly signal?: AbortSignal;
  readonly exitCommand?: string;
  readonly personality?: PersonalitySnapshot;
  readonly onResponse?: (response: Response) => void | Promise<void>;
  readonly onDelta?: (delta: string) => void | Promise<void>;
  readonly onInterruption?: () => void | Promise<void>;
  /** Enables live input replacement while a response is streaming. */
  readonly interruptible?: boolean;
  readonly memory?: () => MemorySnapshot | Promise<MemorySnapshot>;
  /** One in-memory local clarification handler; it is never serialized by the runner. */
  readonly clarification?: {
    handle: (input: string, context: { readonly signal?: AbortSignal; readonly sessionId: string }) => Promise<string | undefined>;
    clear: () => void;
    observeCapabilityHelp?: () => void;
  };
  readonly onCommand?: (command: string, context: {
    readonly signal?: AbortSignal;
    readonly sessionId: string;
    readonly active: boolean;
  }) => void | Promise<void>;
  /** Handles an explicitly mapped local tone preference without adding it to Session. */
  readonly onTonePreference?: (input: string) => Promise<boolean>;
  /** Handles an explicitly mapped local response format without adding it to Session. */
  readonly onResponseFormatPreference?: (input: string) => Promise<boolean>;
}

async function nextWithSignal(
  iterator: AsyncIterator<string>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<string> | undefined> {
  if (!signal) return iterator.next();
  if (signal.aborted) return undefined;

  return new Promise<IteratorResult<string> | undefined>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const finish = (result: IteratorResult<string> | undefined): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onAbort = (): void => finish(undefined);

    signal.addEventListener('abort', onAbort, { once: true });
    iterator.next().then(finish, (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

type TurnResult = { readonly status: 'completed'; readonly response: Response }
  | { readonly status: 'cancelled' };

interface ActiveTurn {
  readonly generation: number;
  readonly controller: AbortController;
  promise: Promise<TurnResult>;
  cancelRequested: boolean;
}

export class ConversationRunner {
  readonly session: Session;

  constructor(
    private readonly core: AssistantCore,
    session?: Session,
  ) {
    this.session = session ?? core.createSession();
  }

  async run(
    inputs: AsyncIterable<string>,
    options: ConversationRunOptions = {},
  ): Promise<ConversationRunResult> {
    const responses: Response[] = [];
    const exitCommand = options.exitCommand ?? CONVERSATION_EXIT_COMMAND;
    const iterator = inputs[Symbol.asyncIterator]();
    let sourceFinished = false;
    let inputPromise: Promise<IteratorResult<string> | undefined> | undefined = nextWithSignal(iterator, options.signal);
    let pendingNormalInput: string | undefined;
    let generation = 0;
    let active: ActiveTurn | undefined;
    let cancelled = false;

    const requestCancel = (turn: ActiveTurn): void => {
      turn.cancelRequested = true;
      turn.controller.abort();
    };
    const onRunAbort = (): void => {
      cancelled = true;
      if (active) requestCancel(active);
    };
    if (options.signal?.aborted) onRunAbort();
    else options.signal?.addEventListener('abort', onRunAbort, { once: true });

    const startTurn = (input: string): void => {
      const turnGeneration = ++generation;
      const controller = new AbortController();
      const turn: ActiveTurn = {
        generation: turnGeneration,
        controller,
        cancelRequested: false,
        promise: Promise.resolve({ status: 'cancelled' }),
      };
      const onExternalAbort = (): void => requestCancel(turn);
      if (options.signal?.aborted) onExternalAbort();
      else options.signal?.addEventListener('abort', onExternalAbort, { once: true });
      const promise = (async (): Promise<TurnResult> => {
        try {
          let response: Response | undefined;
          let emittedDelta = false;
          for await (const event of this.core.respondStream(this.session, input, {
            signal: controller.signal,
            personality: options.personality,
            memory: await options.memory?.(),
            isCurrent: () => active?.generation === turnGeneration && !turn.cancelRequested,
          })) {
            const streamEvent = event as AssistantStreamEvent;
            if (streamEvent.type === 'text_delta') {
              if (active?.generation !== turnGeneration || turn.cancelRequested) continue;
              emittedDelta = true;
              await options.onDelta?.(streamEvent.delta);
            } else {
              response = streamEvent.response;
            }
          }
          if (!response || turn.cancelRequested || active?.generation !== turnGeneration) {
            return { status: 'cancelled' };
          }
          if (!emittedDelta && response.text) await options.onDelta?.(response.text);
          return { status: 'completed', response };
        } catch (error) {
          if (controller.signal.aborted || turn.cancelRequested) return { status: 'cancelled' };
          throw error;
        } finally {
          options.signal?.removeEventListener('abort', onExternalAbort);
        }
      })();
      turn.promise = promise;
      active = turn;
    };

    const commandContext = (activeAtArrival: boolean) => ({
      signal: options.signal,
      sessionId: this.session.id,
      active: activeAtArrival,
    });

    const isLocalCommand = (input: string): boolean => input === CONVERSATION_HELP_COMMAND
      || input === CONVERSATION_SUMMARY_COMMAND
      || input === CONVERSATION_CANCEL_COMMAND
      || input === CONVERSATION_TIME_COMMAND
      || input === CONVERSATION_CALC_COMMAND
      || input.startsWith(`${CONVERSATION_CALC_COMMAND} `)
      || input === CONVERSATION_STATUS_COMMAND
      || input === CONVERSATION_TONE_COMMAND
      || input.startsWith(`${CONVERSATION_TONE_COMMAND} `)
      || input === CONVERSATION_FORMAT_COMMAND
      || input.startsWith(`${CONVERSATION_FORMAT_COMMAND} `)
      || input === CONVERSATION_HISTORY_COMMAND
      || input === CONVERSATION_CLEAR_COMMAND
      || input === CONVERSATION_MEMORY_COMMAND
      || input === CONVERSATION_REMEMBER_COMMAND
      || input.startsWith(`${CONVERSATION_REMEMBER_COMMAND} `)
      || input === CONVERSATION_FORGET_COMMAND
      || input.startsWith(`${CONVERSATION_FORGET_COMMAND} `)
      || input === CONVERSATION_SAVE_SESSION_COMMAND
      || input.startsWith(`${CONVERSATION_SAVE_SESSION_COMMAND} `)
      || input === CONVERSATION_SESSIONS_COMMAND
      || input === CONVERSATION_SESSION_SEARCH_COMMAND
      || input.startsWith(`${CONVERSATION_SESSION_SEARCH_COMMAND} `)
      || input === CONVERSATION_LOAD_SESSION_COMMAND
      || input.startsWith(`${CONVERSATION_LOAD_SESSION_COMMAND} `)
      || input === CONVERSATION_DELETE_SESSION_COMMAND
      || input.startsWith(`${CONVERSATION_DELETE_SESSION_COMMAND} `)
      || input === CONVERSATION_EXPORT_COMMAND
      || input.startsWith(`${CONVERSATION_EXPORT_COMMAND} `)
      || input === CONVERSATION_RENAME_COMMAND
      || input.startsWith(`${CONVERSATION_RENAME_COMMAND} `)
      || input === CONVERSATION_SESSION_INFO_COMMAND
      || input === CONVERSATION_REMIND_COMMAND
      || input.startsWith(`${CONVERSATION_REMIND_COMMAND} `)
      || input === CONVERSATION_REMINDERS_COMMAND
      || input.startsWith(`${CONVERSATION_REMINDERS_COMMAND} `)
      || input === CONVERSATION_REMINDER_DELETE_COMMAND
      || input.startsWith(`${CONVERSATION_REMINDER_DELETE_COMMAND} `)
      || input === CONVERSATION_REMINDER_COMPLETE_COMMAND
      || input.startsWith(`${CONVERSATION_REMINDER_COMPLETE_COMMAND} `)
      || input === CONVERSATION_NOTE_ADD_COMMAND
      || input.startsWith(`${CONVERSATION_NOTE_ADD_COMMAND} `)
      || input === CONVERSATION_NOTES_COMMAND
      || input.startsWith(`${CONVERSATION_NOTES_COMMAND} `)
      || input === CONVERSATION_NOTE_SHOW_COMMAND
      || input.startsWith(`${CONVERSATION_NOTE_SHOW_COMMAND} `)
      || input === CONVERSATION_NOTE_DELETE_COMMAND
      || input.startsWith(`${CONVERSATION_NOTE_DELETE_COMMAND} `);

    const executeLocalCommand = async (input: string, activeAtArrival: boolean): Promise<void> => {
      options.clarification?.clear();
      if (!options.onCommand) {
        throw new AssistantError('The local command is unavailable.', {
          code: 'TOOL_UNAVAILABLE_ERROR', retryable: false,
        });
      }
      await options.onCommand(input, commandContext(activeAtArrival));
    };

    const processNaturalInput = async (input: string): Promise<void> => {
      if (options.onTonePreference !== undefined) {
        if (await options.onTonePreference(input)) {
          options.clarification?.clear();
          return;
        }
      }
      if (options.onResponseFormatPreference !== undefined) {
        if (await options.onResponseFormatPreference(input)) {
          options.clarification?.clear();
          return;
        }
      }
      const capabilityHelp = resolveNaturalCapabilityHelp(input);
      if (capabilityHelp !== undefined) {
        options.clarification?.clear();
        options.clarification?.observeCapabilityHelp?.();
        this.session.addMessage('user', input);
        const assistantMessage = this.session.addMessage('assistant', capabilityHelp);
        const response: Response = {
          sessionId: this.session.id,
          messageId: assistantMessage.id,
          text: capabilityHelp,
          provider: 'local-capability-help',
          model: 'local',
          finishReason: 'stop',
        };
        responses.push(response);
        await options.onDelta?.(capabilityHelp);
        await options.onResponse?.(response);
        return;
      }
      const localText = await options.clarification?.handle(input, {
        signal: options.signal,
        sessionId: this.session.id,
      });
      if (localText !== undefined) {
        this.session.addMessage('user', input);
        const assistantMessage = this.session.addMessage('assistant', localText);
        const response: Response = {
          sessionId: this.session.id,
          messageId: assistantMessage.id,
          text: localText,
          provider: 'local-clarification',
          model: 'local',
          finishReason: 'stop',
        };
        responses.push(response);
        await options.onDelta?.(localText);
        await options.onResponse?.(response);
        return;
      }
      startTurn(input);
    };

    const completeActive = async (): Promise<void> => {
      if (!active) return;
      const finished = active;
      const result = await finished.promise;
      active = undefined;
      if (result.status === 'completed') {
        responses.push(result.response);
        await options.onResponse?.(result.response);
      }
    };

    try {
      while (true) {
        if (active) {
          if (options.interruptible !== true) {
            const result = await active.promise;
            active = undefined;
            if (result.status === 'completed') {
              responses.push(result.response);
              await options.onResponse?.(result.response);
            }
            if (cancelled) {
              return { status: 'cancelled', session: this.session, responses: [...responses] };
            }
            if (pendingNormalInput) {
              const nextInput = pendingNormalInput;
              pendingNormalInput = undefined;
              await processNaturalInput(nextInput);
            } else if (sourceFinished) {
              return { status: 'completed', session: this.session, responses: [...responses] };
            }
            continue;
          }
          const turnPromise = active.promise.then((result) => ({ kind: 'turn' as const, result }));
          const nextInputPromise = inputPromise?.then((next) => ({ kind: 'input' as const, next }));
          const event = nextInputPromise
            ? await Promise.race([turnPromise, nextInputPromise])
            : await turnPromise;

          if (event.kind === 'turn') {
            const result = event.result;
            active = undefined;
            if (result.status === 'completed') {
              responses.push(result.response);
              await options.onResponse?.(result.response);
            }
            if (pendingNormalInput) {
              const nextInput = pendingNormalInput;
              pendingNormalInput = undefined;
              await processNaturalInput(nextInput);
            } else if (sourceFinished) {
              return { status: 'completed', session: this.session, responses: [...responses] };
            }
            continue;
          }

          const next = event.next;
          inputPromise = nextWithSignal(iterator, options.signal);
          if (next === undefined) {
            cancelled = true;
            requestCancel(active);
            await completeActive();
            return { status: 'cancelled', session: this.session, responses: [...responses] };
          }
          if (next.done) {
            sourceFinished = true;
            cancelled = options.signal?.aborted === true;
            inputPromise = undefined;
            continue;
          }
          const input = next.value.trim();
          if (!input) continue;
          if (input === exitCommand) {
            requestCancel(active);
            await completeActive();
            await options.onInterruption?.();
            options.clarification?.clear();
            return { status: 'completed', session: this.session, responses: [...responses] };
          }
          if (input === CONVERSATION_CANCEL_COMMAND) {
            requestCancel(active);
            await completeActive();
            await options.onInterruption?.();
            await executeLocalCommand(input, true);
            continue;
          }
          if (input.startsWith('/')) {
            requestCancel(active);
            await completeActive();
            await options.onInterruption?.();
            await executeLocalCommand(input, true);
            continue;
          }
          const wasPending = pendingNormalInput !== undefined;
          requestCancel(active);
          pendingNormalInput = input;
          if (!wasPending) await options.onInterruption?.();
          continue;
        }

        if (pendingNormalInput) {
          const nextInput = pendingNormalInput;
          pendingNormalInput = undefined;
          await processNaturalInput(nextInput);
          continue;
        }
        if (sourceFinished) return { status: 'completed', session: this.session, responses: [...responses] };
        const next = inputPromise ? await inputPromise : undefined;
        inputPromise = nextWithSignal(iterator, options.signal);
        if (next === undefined) {
          return { status: 'cancelled', session: this.session, responses: [...responses] };
        }
        if (next.done) {
          sourceFinished = true;
          inputPromise = undefined;
          continue;
        }

        const input = next.value.trim();
        if (!input) continue;
        if (input === exitCommand) {
          sourceFinished = true;
          options.clarification?.clear();
          return { status: 'completed', session: this.session, responses: [...responses] };
        }
        if (isLocalCommand(input)) {
          await executeLocalCommand(input, false);
          continue;
        }
        if (input.startsWith('/')) {
          await executeLocalCommand(input, false);
          continue;
        }
        await processNaturalInput(input);
      }
    } finally {
      if (active) {
        requestCancel(active);
        await active.promise.catch(() => undefined);
      }
      options.signal?.removeEventListener('abort', onRunAbort);
      options.clarification?.clear();
      if (!sourceFinished) await iterator.return?.();
    }
  }
}
