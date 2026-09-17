import { randomUUID } from 'node:crypto';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  readonly id: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly createdAt: string;
}

export function createMessage(role: MessageRole, content: string): Message {
  return {
    id: randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
  };
}
