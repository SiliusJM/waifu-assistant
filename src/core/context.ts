import type { Message } from './message.js';
import type { Session } from './session.js';

export interface Context {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly messages: readonly Message[];
}

export function createContext(session: Session): Context {
  return {
    sessionId: session.id,
    createdAt: new Date().toISOString(),
    messages: session.getMessages(),
  };
}
