import { randomUUID } from 'node:crypto';
import { createMessage, type Message, type MessageRole } from './message.js';
import { AssistantError } from '../shared/errors.js';

export class Session {
  private readonly messages: Message[] = [];

  constructor(public readonly id: string = randomUUID()) {}

  addMessage(role: MessageRole, content: string): Message {
    const message = createMessage(role, content);
    this.messages.push(message);
    return message;
  }

  getMessages(): readonly Message[] {
    return this.messages.slice();
  }

  restoreMessages(messages: readonly Readonly<{
    readonly role: 'user' | 'assistant';
    readonly content: string;
  }>[]): void {
    const restored = messages.map(({ role, content }) => {
      if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string' || content.length === 0) {
        throw new AssistantError('Session restore contains an invalid message.', {
          code: 'SESSION_CORRUPT_ERROR',
          retryable: false,
        });
      }
      return createMessage(role, content);
    });
    this.messages.length = 0;
    this.messages.push(...restored);
  }

  clear(): void {
    this.messages.length = 0;
  }
}
