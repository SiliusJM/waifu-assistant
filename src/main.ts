import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { AssistantCore } from './core/assistant-core.js';
import { ConversationRunner } from './core/conversation-runner.js';
import { createAIProvider } from './config/provider-factory.js';
import { loadConfig } from './config/config.js';
import { formatProviderStatus } from './config/provider-config.js';
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
  CONVERSATION_CANCEL_COMMAND,
  CONVERSATION_CALC_COMMAND,
  CONVERSATION_FORGET_COMMAND,
  CONVERSATION_HISTORY_COMMAND,
  CONVERSATION_HELP_COMMAND,
  CONVERSATION_MEMORY_COMMAND,
  CONVERSATION_REMEMBER_COMMAND,
  CONVERSATION_DELETE_SESSION_COMMAND,
  CONVERSATION_EXPORT_COMMAND,
  CONVERSATION_RENAME_COMMAND,
  CONVERSATION_SESSION_INFO_COMMAND,
  CONVERSATION_LOAD_SESSION_COMMAND,
  CONVERSATION_SAVE_SESSION_COMMAND,
  CONVERSATION_SESSIONS_COMMAND,
  CONVERSATION_STATUS_COMMAND,
  CONVERSATION_REMIND_COMMAND,
  CONVERSATION_REMINDERS_COMMAND,
  CONVERSATION_REMINDER_DELETE_COMMAND,
  LOCAL_COMMAND_HELP,
} from './core/conversation-runner.js';
import { PersistentMemoryStore, resolveMemoryPath } from './memory/memory-store.js';
import { resolveSavedSessionPath, SavedSessionStore } from './core/saved-session-store.js';
import { MarkdownConversationExporter } from './core/markdown-conversation-exporter.js';
import {
  formatDueReminderNotice,
  formatReminderDate,
  parseReminderCommand,
  ReminderStore,
  resolveReminderPath,
} from './reminders/reminder-store.js';

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
  const memoryStore = new PersistentMemoryStore(resolveMemoryPath(env));
  await memoryStore.load();
  const savedSessionStore = new SavedSessionStore(resolveSavedSessionPath(env));
  await savedSessionStore.load();
  const reminderStore = new ReminderStore(resolveReminderPath(env));
  await reminderStore.load();
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
    const response = await core.respond(core.createSession(), input, {
      personality,
      memory: await memoryStore.snapshot(),
    });
    process.stdout.write(response.text + '\n');
    return;
  }

  const controller = new AbortController();
  const onInterrupt = (): void => controller.abort();
  process.once('SIGINT', onInterrupt);
  const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    const runner = new ConversationRunner(core);
    const conversationExporter = new MarkdownConversationExporter();
    const dueReminderNotice = formatDueReminderNotice(await reminderStore.listDue());
    if (dueReminderNotice) process.stdout.write(dueReminderNotice + '\n');
    await runner.run(terminal, {
      signal: controller.signal,
      interruptible: true,
      personality,
      memory: () => memoryStore.snapshot(),
      onDelta: (delta): void => { process.stdout.write(delta); },
      onResponse: (): void => { process.stdout.write('\n'); },
      onInterruption: (): void => { process.stdout.write('\n[Respuesta interrumpida]\n'); },
      onCommand: async (command, context): Promise<void> => {
        if (command === CONVERSATION_CANCEL_COMMAND) {
          process.stdout.write(context.active
            ? 'Respuesta cancelada.\n'
            : 'No hay una respuesta activa para cancelar.\n');
          return;
        }
        if (command === CONVERSATION_HELP_COMMAND) {
          process.stdout.write(LOCAL_COMMAND_HELP + '\n');
          return;
        }
        if (command === CONVERSATION_REMIND_COMMAND || command.startsWith(`${CONVERSATION_REMIND_COMMAND} `)) {
          try {
            const parsed = parseReminderCommand(command);
            const reminder = await reminderStore.add(parsed.text, parsed.dueAt);
            process.stdout.write([
              `Recordatorio creado: ${reminder.id}`,
              `Fecha: ${formatReminderDate(reminder.dueAt)}`,
              reminder.text,
            ].join('\n') + '\n');
          } catch (error) {
            const reminderError = error instanceof AssistantError ? error : new AssistantError(
              'No se pudo crear el recordatorio.',
              { code: 'REMINDER_IO_ERROR', retryable: false, cause: error },
            );
            process.stdout.write(`No se pudo crear el recordatorio: ${reminderError.message}\n`);
          }
          return;
        }
        if (command === CONVERSATION_REMINDERS_COMMAND) {
          try {
            const reminders = await reminderStore.list();
            process.stdout.write((reminders.length === 0
              ? 'No hay recordatorios pendientes.'
              : [
                'Recordatorios pendientes:',
                ...reminders.map(({ id, dueAt, text }) => {
                  const status = dueAt <= new Date().toISOString() ? 'vencido' : 'pendiente';
                  return `[${id}] ${formatReminderDate(dueAt)} · ${status} · ${text}`;
                }),
              ].join('\n')) + '\n');
          } catch (error) {
            const reminderError = error instanceof AssistantError ? error : new AssistantError(
              'No se pudieron consultar los recordatorios.',
              { code: 'REMINDER_IO_ERROR', retryable: false, cause: error },
            );
            process.stdout.write(`No se pudieron consultar los recordatorios: ${reminderError.message}\n`);
          }
          return;
        }
        if (command === CONVERSATION_REMINDER_DELETE_COMMAND
          || command.startsWith(`${CONVERSATION_REMINDER_DELETE_COMMAND} `)) {
          const id = command.slice(CONVERSATION_REMINDER_DELETE_COMMAND.length).trim();
          try {
            if (!id || /\s/u.test(id)) {
              process.stdout.write('Uso: /reminder-delete <id>\n');
              return;
            }
            const removed = await reminderStore.delete(id);
            process.stdout.write((removed ? `Recordatorio eliminado: ${id}` : `No existe el recordatorio: ${id}`) + '\n');
          } catch (error) {
            const reminderError = error instanceof AssistantError ? error : new AssistantError(
              'No se pudo eliminar el recordatorio.',
              { code: 'REMINDER_IO_ERROR', retryable: false, cause: error },
            );
            process.stdout.write(`No se pudo eliminar el recordatorio: ${reminderError.message}\n`);
          }
          return;
        }
        if (command === CONVERSATION_STATUS_COMMAND) {
          process.stdout.write([
            'Estado de Yuki',
            `Sesión actual: ${runner.session.id}`,
            `Mensajes: ${runner.session.getMessages().length}`,
            `Memorias persistentes: ${await memoryStore.count()}`,
            `Sesiones guardadas: ${await savedSessionStore.count()}`,
            ...formatProviderStatus(config.ai),
            'Personalidad: Yuki',
            'Herramientas locales:',
            '- local.time',
            '- local.calculate',
          ].join('\n') + '\n');
          return;
        }
        if (command === CONVERSATION_HISTORY_COMMAND) {
          const history = runner.session.getMessages();
          process.stdout.write((history.length === 0
            ? 'No hay mensajes en la sesión actual.'
            : history.map(({ role, content }) => `${role === 'user' ? 'Tú' : 'Yuki'}: ${content}`).join('\n')) + '\n');
          return;
        }
        if (command === CONVERSATION_EXPORT_COMMAND || command.startsWith(`${CONVERSATION_EXPORT_COMMAND} `)) {
          const requestedName = command === CONVERSATION_EXPORT_COMMAND
            ? undefined
            : command.slice(CONVERSATION_EXPORT_COMMAND.length).trim();
          try {
            const result = await conversationExporter.exportConversation(
              runner.session.getMessages(), requestedName || undefined, runner.session.title,
            );
            process.stdout.write(result.status === 'empty'
              ? 'No hay mensajes para exportar.\n'
              : `Conversación exportada: ${result.filePath}\n`);
          } catch (error) {
            const exportFailure = error instanceof AssistantError
              && (error.code === 'EXPORT_CONFIGURATION_ERROR' || error.code === 'EXPORT_IO_ERROR')
              ? error
              : new AssistantError('No se pudo exportar la conversación.', {
                code: 'EXPORT_IO_ERROR', retryable: false, cause: error,
              });
            process.stdout.write(`No se pudo exportar la conversación: ${exportFailure.message}\n`);
          }
          return;
        }
        if (command === CONVERSATION_CLEAR_COMMAND) {
          runner.session.clear();
          process.stdout.write('Sesión actual limpiada.\n');
          return;
        }
        if (command === CONVERSATION_MEMORY_COMMAND) {
          const entries = await memoryStore.list();
          process.stdout.write((entries.length === 0
            ? 'No hay memorias guardadas.'
            : ['Memorias guardadas:', ...entries.map(({ key, value }) => `${key}: ${value}`)].join('\n')) + '\n');
          return;
        }
        if (command === CONVERSATION_REMEMBER_COMMAND || command.startsWith(`${CONVERSATION_REMEMBER_COMMAND} `)) {
          const body = command.slice(CONVERSATION_REMEMBER_COMMAND.length).trim();
          const separator = body.search(/\s/);
          if (separator < 1) {
            process.stdout.write('Uso: /remember <key> <value>\n');
            return;
          }
          const key = body.slice(0, separator);
          const value = body.slice(separator).trim();
          try {
            await memoryStore.set(key, value);
            process.stdout.write(`Memoria guardada: ${key}\n`);
          } catch (error) {
            const memoryError = error instanceof AssistantError ? error : new AssistantError(
              'No se pudo guardar la memoria.',
              { code: 'MEMORY_IO_ERROR', retryable: false, cause: error },
            );
            process.stdout.write(`No se pudo guardar la memoria: ${memoryError.message}\n`);
          }
          return;
        }
        if (command === CONVERSATION_FORGET_COMMAND || command.startsWith(`${CONVERSATION_FORGET_COMMAND} `)) {
          const key = command.slice(CONVERSATION_FORGET_COMMAND.length).trim();
          if (!key || /\s/.test(key)) {
            process.stdout.write('Uso: /forget <key>\n');
            return;
          }
          try {
            const removed = await memoryStore.delete(key);
            process.stdout.write((removed ? `Memoria eliminada: ${key}` : `No existe la memoria: ${key}`) + '\n');
          } catch (error) {
            const memoryError = error instanceof AssistantError ? error : new AssistantError(
              'No se pudo eliminar la memoria.',
              { code: 'MEMORY_IO_ERROR', retryable: false, cause: error },
            );
            process.stdout.write(`No se pudo eliminar la memoria: ${memoryError.message}\n`);
          }
          return;
        }
        if (command === CONVERSATION_SESSIONS_COMMAND) {
          try {
            const sessions = await savedSessionStore.listSummaries();
            process.stdout.write((sessions.length === 0
              ? 'No hay sesiones guardadas.'
              : [
                'Sesiones guardadas:',
                ...sessions.flatMap((saved, index) => [
                  `${index + 1}. ${saved.title}`,
                  `   ID: ${saved.name} · ${saved.messageCount} mensajes · actualizado: ${saved.savedAt}`,
                ]),
              ].join('\n')) + '\n');
          } catch (error) {
            const sessionError = error instanceof AssistantError ? error : new AssistantError(
              'No se pudieron consultar las sesiones guardadas.',
              { code: 'SESSION_IO_ERROR', retryable: false, cause: error },
            );
            process.stdout.write(`No se pudieron consultar las sesiones guardadas: ${sessionError.message}\n`);
          }
          return;
        }
        if (command === CONVERSATION_SESSION_INFO_COMMAND) {
          try {
            const saved = runner.session.savedName
              ? await savedSessionStore.get(runner.session.savedName)
              : undefined;
            if (runner.session.savedName && !saved) runner.session.markSaved(undefined);
            process.stdout.write([
              `Título: ${runner.session.title ?? 'Sin título'}`,
              `Mensajes: ${runner.session.getMessages().length}`,
              `Guardada: ${saved ? 'SÍ' : 'NO'}`,
              `Session ID: ${runner.session.id}`,
              ...(saved && runner.session.savedName ? [`ID guardado: ${runner.session.savedName}`, `Actualizada: ${saved.savedAt}`] : []),
            ].join('\n') + '\n');
          } catch (error) {
            const sessionError = error instanceof AssistantError ? error : new AssistantError(
              'No se pudo consultar la conversación actual.',
              { code: 'SESSION_IO_ERROR', retryable: false, cause: error },
            );
            process.stdout.write(`No se pudo consultar la conversación actual: ${sessionError.message}\n`);
          }
          return;
        }
        if (command === CONVERSATION_RENAME_COMMAND || command.startsWith(`${CONVERSATION_RENAME_COMMAND} `)) {
          const title = command.slice(CONVERSATION_RENAME_COMMAND.length).trim();
          if (!title) {
            process.stdout.write('Uso: /rename <nombre>\n');
            return;
          }
          try {
            if (runner.session.savedName) {
              const renamedSaved = await savedSessionStore.renameTitle(runner.session.savedName, title);
              if (!renamedSaved) runner.session.markSaved(undefined);
            }
            runner.session.setTitle(title);
            process.stdout.write(`Conversación renombrada: ${runner.session.title}\n`);
          } catch (error) {
            const titleError = error instanceof AssistantError ? error : new AssistantError(
              'No se pudo renombrar la conversación.',
              { code: 'SESSION_CONFIGURATION_ERROR', retryable: false, cause: error },
            );
            process.stdout.write(`No se pudo renombrar la conversación: ${titleError.message}\n`);
          }
          return;
        }
        if (command === CONVERSATION_SAVE_SESSION_COMMAND || command.startsWith(`${CONVERSATION_SAVE_SESSION_COMMAND} `)) {
          const name = command.slice(CONVERSATION_SAVE_SESSION_COMMAND.length).trim();
          if (!name || /\s/.test(name)) {
            process.stdout.write('Uso: /save-session <name>\n');
            return;
          }
          try {
            await savedSessionStore.save(name, runner.session.getMessages(), runner.session.title);
            runner.session.markSaved(name);
            const saved = await savedSessionStore.get(name);
            runner.session.setTitle(saved?.title);
            process.stdout.write(`Sesión guardada: ${name}\n`);
          } catch (error) {
            const sessionError = error instanceof AssistantError ? error : new AssistantError(
              'No se pudo guardar la sesión.',
              { code: 'SESSION_IO_ERROR', retryable: false, cause: error },
            );
            process.stdout.write(`No se pudo guardar la sesión: ${sessionError.message}\n`);
          }
          return;
        }
        if (command === CONVERSATION_LOAD_SESSION_COMMAND || command.startsWith(`${CONVERSATION_LOAD_SESSION_COMMAND} `)) {
          const name = command.slice(CONVERSATION_LOAD_SESSION_COMMAND.length).trim();
          if (!name || /\s/.test(name)) {
            process.stdout.write('Uso: /load-session <name>\n');
            return;
          }
          try {
            const snapshot = await savedSessionStore.get(name);
            if (!snapshot) {
              process.stdout.write(`No existe la sesión: ${name}\n`);
              return;
            }
            runner.session.restoreMessages(snapshot.messages);
            runner.session.setTitle(snapshot.title);
            runner.session.markSaved(name);
            process.stdout.write(`Sesión cargada: ${name}\n`);
          } catch (error) {
            const sessionError = error instanceof AssistantError ? error : new AssistantError(
              'No se pudo cargar la sesión.',
              { code: 'SESSION_IO_ERROR', retryable: false, cause: error },
            );
            process.stdout.write(`No se pudo cargar la sesión: ${sessionError.message}\n`);
          }
          return;
        }
        if (command === CONVERSATION_DELETE_SESSION_COMMAND || command.startsWith(`${CONVERSATION_DELETE_SESSION_COMMAND} `)) {
          const name = command.slice(CONVERSATION_DELETE_SESSION_COMMAND.length).trim();
          if (!name || /\s/.test(name)) {
            process.stdout.write('Uso: /delete-session <name>\n');
            return;
          }
          try {
            const removed = await savedSessionStore.delete(name);
            if (removed && runner.session.savedName === name) runner.session.markSaved(undefined);
            process.stdout.write((removed ? `Sesión eliminada: ${name}` : `No existe la sesión: ${name}`) + '\n');
          } catch (error) {
            const sessionError = error instanceof AssistantError ? error : new AssistantError(
              'No se pudo eliminar la sesión.',
              { code: 'SESSION_IO_ERROR', retryable: false, cause: error },
            );
            process.stdout.write(`No se pudo eliminar la sesión: ${sessionError.message}\n`);
          }
          return;
        }
        if (command === '/time') {
          const result = await executeLocalTime(localToolManager, context);
          if (result.status !== 'success') {
            process.stdout.write('No pude obtener la hora local.\n');
            return;
          }
          process.stdout.write(formatLocalTime(result.value) + '\n');
          return;
        }
        if (command.startsWith('/') && command !== CONVERSATION_CALC_COMMAND
          && !command.startsWith(`${CONVERSATION_CALC_COMMAND} `)) {
          process.stdout.write('Comando desconocido. Usa /help.\n');
          return;
        }
        const expression = command.slice('/calc'.length).trim();
        const result = await executeLocalCalculation(localToolManager, expression, context);
        if (result.status !== 'success') {
          process.stdout.write('No pude calcular esa expresión: la expresión no es válida.\n');
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
