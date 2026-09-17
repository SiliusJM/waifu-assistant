import { RealtimeError } from './realtime-errors.js';
import type { InteractionState } from './realtime-types.js';

const ALLOWED_TRANSITIONS: Readonly<Record<InteractionState, readonly InteractionState[]>> = {
  created: ['running', 'cancelling'],
  running: ['streaming', 'completed', 'cancelling', 'failed'],
  streaming: ['completed', 'cancelling', 'failed'],
  cancelling: ['cancelled', 'failed'],
  completed: [],
  cancelled: [],
  failed: [],
};

export function assertInteractionTransition(
  from: InteractionState,
  to: InteractionState,
): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new RealtimeError(
      'The realtime interaction state transition is invalid.',
      'REALTIME_STATE_ERROR',
    );
  }
}
