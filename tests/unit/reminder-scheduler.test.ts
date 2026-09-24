import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConsoleReminderNotifier, type ReminderNotifier } from '../../src/reminders/reminder-notifier.js';
import { ReminderScheduler, type ReminderTimerScheduler } from '../../src/reminders/reminder-scheduler.js';
import { ReminderStore, type Reminder } from '../../src/reminders/reminder-store.js';

class FakeTimers {
  private nextId = 0;
  readonly jobs = new Map<number, { readonly callback: () => Promise<void>; readonly delayMs: number }>();

  readonly schedule: ReminderTimerScheduler = (callback, delayMs) => {
    const id = ++this.nextId;
    this.jobs.set(id, { callback, delayMs });
    return () => { this.jobs.delete(id); };
  };

  async fireNext(): Promise<void> {
    const entry = [...this.jobs.entries()].sort((left, right) => left[1].delayMs - right[1].delayMs)[0];
    assert.ok(entry, 'expected a scheduled reminder timer');
    const [id, job] = entry;
    this.jobs.delete(id);
    await job.callback();
  }

  get delays(): number[] {
    return [...this.jobs.values()].map(({ delayMs }) => delayMs).sort((left, right) => left - right);
  }
}

async function withStore(run: (store: ReminderStore, path: string, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-reminder-scheduler-'));
  const path = join(directory, 'reminders.json');
  try {
    const store = new ReminderStore(path);
    await store.load();
    await run(store, path, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function overdueReminder(id: string, text: string, dueAt: string): Reminder {
  return {
    id,
    text,
    dueAt,
    createdAt: '2026-09-20T10:00:00.000Z',
    status: 'pending',
  };
}

test('overdue pending reminders notify once at startup and stay pending', async () => {
  await withStore(async (_store, path) => {
    const current = new Date(2026, 8, 23, 12, 0, 0);
    await writeFile(path, JSON.stringify({
      version: 2,
      reminders: [overdueReminder('r-1234abcd', 'Due once', new Date(current.getTime() - 1000).toISOString())],
    }), 'utf8');
    const store = new ReminderStore(path, { now: () => new Date(current) });
    await store.load();
    const received: Reminder[] = [];
    const timers = new FakeTimers();
    const scheduler = new ReminderScheduler(store, { notify: (reminder) => { received.push(reminder); } }, {
      now: () => new Date(current),
      scheduleTimer: timers.schedule,
    });

    await scheduler.start();
    await scheduler.start();
    await scheduler.refresh();
    assert.deepEqual(received.map(({ id }) => id), ['r-1234abcd']);
    assert.equal((await store.list())[0]?.status, 'pending');
    assert.deepEqual(timers.delays, []);
    scheduler.stop();
  });
});

test('scheduler maintains one timer and reschedules after create, delete and complete', async () => {
  await withStore(async (_store, path) => {
    let clock = new Date(2026, 8, 23, 12, 0, 0);
    const store = new ReminderStore(path, {
      now: () => new Date(clock),
      idFactory: (() => { let id = 0; return () => `a${(++id).toString(16).padStart(7, '0')}`; })(),
    });
    await store.load();
    const timers = new FakeTimers();
    const scheduler = new ReminderScheduler(store, { notify: () => undefined }, {
      now: () => new Date(clock), scheduleTimer: timers.schedule,
    });
    await scheduler.start();
    assert.equal(timers.jobs.size, 0);

    const later = await store.add('Later', new Date(clock.getTime() + 10 * 60_000));
    await scheduler.refresh();
    assert.deepEqual(timers.delays, [10 * 60_000]);
    const earlier = await store.add('Earlier', new Date(clock.getTime() + 5 * 60_000));
    await scheduler.refresh();
    assert.deepEqual(timers.delays, [5 * 60_000]);

    await store.delete(earlier.id);
    await scheduler.refresh();
    assert.deepEqual(timers.delays, [10 * 60_000]);
    await store.complete(later.id);
    await scheduler.refresh();
    assert.deepEqual(timers.delays, []);

    const soon = await store.add('Soon', new Date(clock.getTime() + 1000));
    await scheduler.refresh();
    assert.deepEqual(timers.delays, [1000]);
    clock = new Date(clock.getTime() + 1000);
    await timers.fireNext();
    assert.deepEqual((await store.listDue(clock)).map(({ id }) => id), [soon.id]);
    await scheduler.refresh();
    assert.deepEqual(timers.delays, []);
    scheduler.stop();
  });
});

test('notifier failure uses console fallback and reminder text remains inert Unicode data', async () => {
  await withStore(async (_store, path) => {
    const dueAt = new Date(2026, 8, 23, 11, 59, 0);
    const text = `quotes " ' backtick \` dollar $ semicolon ; ampersand & Unicode 🌸`;
    await writeFile(path, JSON.stringify({ version: 2, reminders: [overdueReminder('r-deadbeef', text, dueAt.toISOString())] }), 'utf8');
    const store = new ReminderStore(path, { now: () => new Date(2026, 8, 23, 12, 0, 0) });
    await store.load();
    let primaryCalls = 0;
    const primary: ReminderNotifier = { notify: () => { primaryCalls += 1; throw new Error('native notifier unavailable'); } };
    const messages: string[] = [];
    const fallback = new ConsoleReminderNotifier((message) => { messages.push(message); });
    const scheduler = new ReminderScheduler(store, primary, {
      now: () => new Date(2026, 8, 23, 12, 0, 0),
      fallbackNotifier: fallback,
    });

    await scheduler.start();
    assert.equal(primaryCalls, 1);
    assert.equal(messages.length, 1);
    assert.ok(messages[0]?.includes(text));
    assert.equal((await store.list())[0]?.status, 'pending');
    scheduler.stop();
  });
});

test('console notifier emits reminder text as plain output without transforming shell-like characters', async () => {
  const messages: string[] = [];
  const notifier = new ConsoleReminderNotifier((message) => { messages.push(message); });
  const text = `"quoted" 'apostrophe' \`backtick\` $value; & emoji 🐈`;
  await notifier.notify(overdueReminder('r-abcd1234', text, '2026-09-24T12:00:00.000Z'));
  assert.equal(messages.length, 1);
  assert.ok(messages[0]?.includes(text));
});

test('stop cancels the outstanding timer', async () => {
  await withStore(async (_store, path) => {
    const now = new Date(2026, 8, 23, 12, 0, 0);
    const controlledStore = new ReminderStore(path, { now: () => new Date(now) });
    await controlledStore.load();
    await controlledStore.add('Later', new Date(now.getTime() + 60_000));
    const timers = new FakeTimers();
    const scheduler = new ReminderScheduler(controlledStore, { notify: () => undefined }, {
      now: () => new Date(now), scheduleTimer: timers.schedule,
    });
    await scheduler.start();
    assert.equal(timers.jobs.size, 1);
    scheduler.stop();
    assert.equal(timers.jobs.size, 0);
  });
});
