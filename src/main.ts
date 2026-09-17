import { pathToFileURL } from 'node:url';
import { AssistantCore } from './core/assistant-core.js';
import { createAIProvider } from './config/provider-factory.js';
import { loadConfig } from './config/config.js';
import { AssistantError } from './shared/errors.js';
import { createLogger } from './shared/logger.js';

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const input = argv.join(' ').trim();
  if (!input) {
    throw new AssistantError('Provide text input as a command-line argument.', {
      code: 'VALIDATION_ERROR',
      retryable: false,
    });
  }

  const config = loadConfig(env);
  const logger = createLogger({ scope: 'waifu-assistant', sink: console });
  const core = new AssistantCore({
    provider: createAIProvider(config),
    logger,
  });
  const response = await core.respond(core.createSession(), input);
  process.stdout.write(response.text + '\n');
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
