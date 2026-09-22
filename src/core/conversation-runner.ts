import type { AssistantCore } from './assistant-core.js';
import type { Response } from './response.js';
import type { Session } from './session.js';
import type { PersonalitySnapshot } from '../personality/personality-types.js';
import { AssistantError } from '../shared/errors.js';

export const CONVERSATION_EXIT_COMMAND = '/exit';
export const CONVERSATION_HELP_COMMAND = '/help';
export const CONVERSATION_TIME_COMMAND = '/time';
export const CONVERSATION_CALC_COMMAND = '/calc';
export const LOCAL_COMMAND_HELP = [
  'Comandos disponibles:',
  '  /help              Muestra esta ayuda',
  '  /time              Muestra la hora local',
  '  /calc <expresión>  Calcula una expresión aritmética',
  '  /exit              Cierra la conversación',
].join('\n');

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
  readonly onCommand?: (command: string, context: {
    readonly signal?: AbortSignal;
    readonly sessionId: string;
  }) => void | Promise<void>;
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

    try {
      while (true) {
        const next = await nextWithSignal(iterator, options.signal);
        if (next === undefined) {
          return { status: 'cancelled', session: this.session, responses: [...responses] };
        }
        if (next.done) {
          sourceFinished = true;
          return { status: 'completed', session: this.session, responses: [...responses] };
        }

        const input = next.value.trim();
        if (!input) continue;
        if (input === exitCommand) {
          sourceFinished = true;
          return { status: 'completed', session: this.session, responses: [...responses] };
        }
        if (input === CONVERSATION_HELP_COMMAND || input === CONVERSATION_TIME_COMMAND
          || input === CONVERSATION_CALC_COMMAND
          || input.startsWith(`${CONVERSATION_CALC_COMMAND} `)) {
          if (!options.onCommand) {
            throw new AssistantError('The local command is unavailable.', {
              code: 'TOOL_UNAVAILABLE_ERROR',
              retryable: false,
            });
          }
          await options.onCommand(input, {
            signal: options.signal,
            sessionId: this.session.id,
          });
          continue;
        }

        try {
          const response = await this.core.respond(this.session, input, {
            signal: options.signal,
            personality: options.personality,
          });
          responses.push(response);
          await options.onResponse?.(response);
        } catch (error) {
          if (options.signal?.aborted) {
            return { status: 'cancelled', session: this.session, responses: [...responses] };
          }
          throw error;
        }
      }
    } finally {
      if (!sourceFinished) await iterator.return?.();
    }
  }
}
