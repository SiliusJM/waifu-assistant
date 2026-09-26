export const NATURAL_DUPLEX_STATES = [
  'idle',
  'listening',
  'user_speaking',
  'endpoint_pending',
  'thinking',
  'speaking',
  'interrupted',
] as const;

export type NaturalDuplexState = (typeof NATURAL_DUPLEX_STATES)[number];

const transitions: Readonly<Record<NaturalDuplexState, readonly NaturalDuplexState[]>> = {
  idle: ['listening'],
  listening: ['user_speaking', 'thinking', 'speaking', 'idle'],
  user_speaking: ['endpoint_pending', 'interrupted', 'listening', 'idle'],
  endpoint_pending: ['user_speaking', 'thinking', 'speaking', 'interrupted', 'listening', 'idle'],
  thinking: ['speaking', 'interrupted', 'listening', 'idle'],
  speaking: ['thinking', 'interrupted', 'listening', 'idle'],
  interrupted: ['user_speaking', 'endpoint_pending', 'thinking', 'speaking', 'listening', 'idle'],
};

/** A tiny explicit transition guard; invalid/stale transitions leave state unchanged. */
export class NaturalDuplexStateMachine {
  private current: NaturalDuplexState = 'idle';

  get state(): NaturalDuplexState { return this.current; }

  transition(next: NaturalDuplexState): boolean {
    if (next === this.current) return true;
    if (!transitions[this.current].includes(next)) return false;
    this.current = next;
    return true;
  }
}
