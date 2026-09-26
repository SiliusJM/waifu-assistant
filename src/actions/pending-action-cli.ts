import {
  CONVERSATION_CONFIRM_ACTION_COMMAND,
  CONVERSATION_DEFER_ACTION_COMMAND,
  CONVERSATION_DISCARD_ACTION_COMMAND,
  CONVERSATION_PENDING_COMMAND,
} from '../core/conversation-runner.js';
import { formatPendingAction, type PendingActionJournal } from './pending-action-journal.js';

function parseId(command: string, name: string): string | undefined {
  const body = command.slice(name.length).trim();
  if (!body || /\s/u.test(body)) return undefined;
  return body;
}

/** Handles explicit journal commands only; confirmation never executes the action. */
export async function handlePendingActionCommand(
  journal: PendingActionJournal | undefined,
  command: string,
): Promise<string | undefined> {
  if (![CONVERSATION_PENDING_COMMAND, CONVERSATION_CONFIRM_ACTION_COMMAND,
    CONVERSATION_DEFER_ACTION_COMMAND, CONVERSATION_DISCARD_ACTION_COMMAND]
    .some((name) => command === name || command.startsWith(`${name} `))) return undefined;
  if (!journal) return 'El registro de acciones no está disponible en esta sesión.';

  try {
    if (command === CONVERSATION_PENDING_COMMAND) {
      const actions = await journal.listRecoverable();
      return actions.length === 0
        ? 'No hay acciones pendientes.'
        : ['Acciones pendientes (no se ejecutan automáticamente):', ...actions.map(({ id, state, type, payload }) =>
          `${id} · ${state} · ${type} · ${payload.text.length > 80 ? `${payload.text.slice(0, 79)}…` : payload.text}`)].join('\n');
    }
    if (command === CONVERSATION_CONFIRM_ACTION_COMMAND) return 'Uso: /confirm-action <id>';
    if (command === CONVERSATION_DEFER_ACTION_COMMAND) return 'Uso: /defer-action <id>';
    if (command === CONVERSATION_DISCARD_ACTION_COMMAND) return 'Uso: /discard-action <id>';

    if (command.startsWith(`${CONVERSATION_PENDING_COMMAND} `)) {
      const id = parseId(command, CONVERSATION_PENDING_COMMAND);
      if (!id) return 'Uso: /pending [id]';
      const action = await journal.get(id);
      return action ? formatPendingAction(action) : 'No existe esa acción pendiente.';
    }

    if (command.startsWith(`${CONVERSATION_CONFIRM_ACTION_COMMAND} `)) {
      const id = parseId(command, CONVERSATION_CONFIRM_ACTION_COMMAND);
      if (!id) return 'Uso: /confirm-action <id>';
      await journal.confirm(id);
      return 'Acción confirmada. No se ejecutó; la ejecución externa no está habilitada.';
    }
    if (command.startsWith(`${CONVERSATION_DEFER_ACTION_COMMAND} `)) {
      const id = parseId(command, CONVERSATION_DEFER_ACTION_COMMAND);
      if (!id) return 'Uso: /defer-action <id>';
      await journal.defer(id);
      return 'Acción pospuesta; sigue sin autorización para ejecutarse.';
    }
    if (command.startsWith(`${CONVERSATION_DISCARD_ACTION_COMMAND} `)) {
      const id = parseId(command, CONVERSATION_DISCARD_ACTION_COMMAND);
      if (!id) return 'Uso: /discard-action <id>';
      await journal.discard(id);
      return 'Acción descartada. No se ejecutó.';
    }
    return 'Uso: /pending [id]';
  } catch {
    return 'No se pudo procesar la acción pendiente. Revisa su estado con /pending.';
  }
}
