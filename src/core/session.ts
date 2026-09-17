import { randomUUID } from 'node:crypto';
import { createMessage, type Message, type MessageRole } from './message.js';

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

  clear(): void {
    this.messages.length = 0;
  }
}
