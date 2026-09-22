import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { AssistantCore } from './core/assistant-core.js';
import { ConversationRunner } from './core/conversation-runner.js';
import { createAIProvider } from './config/provider-factory.js';
import { loadConfig } from './config/config.js';
import { PersonalityCompiler } from './personality/personality-compiler.js';
import { PersonalityRegistry } from './personality/personality-registry.js';
import { AssistantError } from './shared/errors.js';
import { createLogger } from './shared/logger.js';
import {
  createLocalToolManager,
  executeLocalCalculation,
  executeLocalTime,
  formatCalculation,
  formatLocalTime,
  LOCAL_TOOL_ALLOWLIST,
} from './tools/local-tool-manager.js';
import {
  CONVERSATION_CLEAR_COMMAND,
  CONVERSATION_HISTORY_COMMAND,
  CONVERSATION_HELP_COMMAND,
  CONVERSATION_STATUS_COMMAND,
  LOCAL_COMMAND_HELP,
} from './core/conversation-runner.js';

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const interactive = argv[0] === '--interactive';
  const input = interactive ? '' : argv.join(' ').trim();
  if (!interactive && !input) {
    throw new AssistantError('Provide text input as a command-line argument.', {
      code: 'VALIDATION_ERROR',
      retryable: false,
    });
  }

  const config = loadConfig(env);
  const logger = createLogger({ scope: 'waifu-assistant', sink: console });
  const localToolManager = createLocalToolManager();
  const core = new AssistantCore({
    provider: createAIProvider(config),
    logger,
    toolManager: localToolManager,
    toolAllowlist: LOCAL_TOOL_ALLOWLIST,
  });
  const personality = new PersonalityCompiler().compile({
    profile: new PersonalityRegistry().defaultProfile,
  });
  if (!interactive) {
    const response = await core.respond(core.createSession(), input, { personality });
    process.stdout.write(response.text + '\n');
    return;
  }

  const controller = new AbortController();
  const onInterrupt = (): void => controller.abort();
  process.once('SIGINT', onInterrupt);
  const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    const runner = new ConversationRunner(core);
    await runner.run(terminal, {
      signal: controller.signal,
      personality,
      onResponse: (response): void => { process.stdout.write(response.text + '\n'); },
      onCommand: async (command, context): Promise<void> => {
        if (command === CONVERSATION_HELP_COMMAND) {
          process.stdout.write(LOCAL_COMMAND_HELP + '\n');
          return;
        }
        if (command === CONVERSATION_STATUS_COMMAND) {
          process.stdout.write([
            'Yuki status',
            `Session: ${runner.session.id}`,
            `Messages: ${runner.session.getMessages().length}`,
            `Provider: ${config.ai.provider}`,
            'Personality: Yuki',
            'Local tools:',
            '- local.time',
            '- local.calculate',
          ].join('\n') + '\n');
          return;
        }
        if (command === CONVERSATION_HISTORY_COMMAND) {
          const history = runner.session.getMessages();
          process.stdout.write((history.length === 0
            ? '(empty)'
            : history.map(({ role, content }) => `${role}: ${content}`).join('\n')) + '\n');
          return;
        }
        if (command === CONVERSATION_CLEAR_COMMAND) {
          runner.session.clear();
          process.stdout.write('Session cleared.\n');
          return;
        }
        if (command === '/time') {
          const result = await executeLocalTime(localToolManager, context);
          if (result.status !== 'success') {
            process.stdout.write(`No pude obtener la hora local: ${result.error.message}\n`);
            return;
          }
          process.stdout.write(formatLocalTime(result.value) + '\n');
          return;
        }
        const expression = command.slice('/calc'.length).trim();
        const result = await executeLocalCalculation(localToolManager, expression, context);
        if (result.status !== 'success') {
          process.stdout.write(`No pude calcular esa expresión: ${result.error.message}\n`);
          return;
        }
        process.stdout.write(formatCalculation(result.value) + '\n');
      },
    });
  } finally {
    terminal.close();
    process.removeListener('SIGINT', onInterrupt);
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entrypoint) {
  main().catch((error: unknown) => {
    const assistantError = error instanceof AssistantError ? error : new AssistantError(
      'Application failed to start.',
      { code: 'PROVIDER_ERROR', retryable: false, cause: error },
    );
    process.stderr.write(JSON.stringify({
      errorCode: assistantError.code,
      message: assistantError.message,
    }) + '\n');
    process.exitCode = 1;
  });
}
