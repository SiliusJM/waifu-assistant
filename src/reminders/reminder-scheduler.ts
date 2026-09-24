import type { ReminderNotifier } from './reminder-notifier.js';
import type { ReminderStore } from './reminder-store.js';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type ReminderTimerScheduler = (callback: () => Promise<void>, delayMs: number) => () => void;

export interface ReminderSchedulerOptions {
  readonly now?: () => Date;
  readonly scheduleTimer?: ReminderTimerScheduler;
  readonly fallbackNotifier?: ReminderNotifier;
  readonly onError?: (error: unknown) => void;
}

const scheduleNodeTimer: ReminderTimerScheduler = (callback, delayMs) => {
  const handle = setTimeout(() => { void callback(); }, delayMs);
  return () => clearTimeout(handle);
};

export class ReminderScheduler {
  private readonly now: () => Date;
  private readonly scheduleTimer: ReminderTimerScheduler;
  private readonly onError: (error: unknown) => void;
  private readonly notified = new Set<string>();
  private started = false;
  private generation = 0;
  private cancelTimer: (() => void) | undefined;

  constructor(
    private readonly store: ReminderStore,
    private readonly notifier: ReminderNotifier,
    options: ReminderSchedulerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.scheduleTimer = options.scheduleTimer ?? scheduleNodeTimer;
    this.fallbackNotifier = options.fallbackNotifier;
    this.onError = options.onError ?? (() => undefined);
  }

  private readonly fallbackNotifier: ReminderNotifier | undefined;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.started) return;
    const generation = ++this.generation;
    this.clearTimer();
    const reminders = await this.store.list();
    if (!this.started || generation !== this.generation) return;
    const now = this.now();
    const nowMs = now.getTime();
    if (Number.isNaN(nowMs)) throw new Error('The reminder scheduler clock is invalid.');

    const pending = reminders.filter(({ status }) => status === 'pending');
    for (const reminder of pending) {
      if (!this.started || generation !== this.generation) return;
      if (Date.parse(reminder.dueAt) > nowMs || this.notified.has(reminder.id)) continue;
      this.notified.add(reminder.id);
      try {
        await this.notifier.notify(reminder);
      } catch (error) {
        if (!this.fallbackNotifier) {
          this.onError(error);
          continue;
        }
        try {
          await this.fallbackNotifier.notify(reminder);
        } catch (fallbackError) {
          this.onError(new AggregateError([error, fallbackError], 'Reminder notification and console fallback failed.'));
        }
      }
    }

    if (!this.started || generation !== this.generation) return;
    const next = pending
      .filter(({ id, dueAt }) => !this.notified.has(id) && Date.parse(dueAt) > nowMs)
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt) || left.id.localeCompare(right.id))[0];
    if (!next) return;
    const delay = Math.max(0, Math.min(Date.parse(next.dueAt) - nowMs, MAX_TIMER_DELAY_MS));
    this.cancelTimer = this.scheduleTimer(async () => {
      this.cancelTimer = undefined;
      try {
        await this.refresh();
      } catch (error) {
        this.onError(error);
      }
    }, delay);
  }

  stop(): void {
    this.started = false;
    this.generation += 1;
    this.clearTimer();
  }

  private clearTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }
}
