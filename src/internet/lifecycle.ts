import { InternetError } from './internet-errors.js';
import type { InternetLifecycleState } from './internet-types.js';

const TRANSITIONS: Readonly<Record<InternetLifecycleState, readonly InternetLifecycleState[]>> = {
  created: ['starting', 'stopped', 'failed'],
  starting: ['ready', 'stopped', 'failed'],
  ready: ['navigating', 'stopping', 'crashed', 'failed'],
  navigating: ['loading', 'ready', 'stopping', 'crashed', 'failed'],
  loading: ['ready', 'stopping', 'crashed', 'failed'],
  stopping: ['stopped', 'failed'],
  stopped: [],
  failed: ['stopping'],
  crashed: ['stopping'],
};

export function canTransitionInternetLifecycle(
  from: InternetLifecycleState,
  to: InternetLifecycleState,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transitionInternetLifecycle(
  from: InternetLifecycleState,
  to: InternetLifecycleState,
): InternetLifecycleState {
  if (!canTransitionInternetLifecycle(from, to)) {
    throw new InternetError(`Invalid internet lifecycle transition: ${from} -> ${to}.`, 'LIFECYCLE_FAILURE');
  }
  return to;
}
