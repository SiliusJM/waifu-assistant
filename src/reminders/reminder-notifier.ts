import { formatReminderDate, type Reminder } from './reminder-store.js';

export interface ReminderNotifier {
  notify(reminder: Reminder): void | Promise<void>;
}

export type ReminderConsoleWriter = (message: string) => void | Promise<void>;

export class ConsoleReminderNotifier implements ReminderNotifier {
  constructor(private readonly write: ReminderConsoleWriter = (message) => { process.stdout.write(message); }) {}

  async notify(reminder: Reminder): Promise<void> {
    await this.write(`\nRecordatorio vencido [${reminder.id}]: ${reminder.text} · ${formatReminderDate(reminder.dueAt)}\n`);
  }
}
