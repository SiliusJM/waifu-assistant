export type EventListener<T> = (event: T) => void;

export class EventBus<EventMap> {
  private readonly listeners = new Map<keyof EventMap, Set<EventListener<unknown>>>();

  subscribe<K extends keyof EventMap>(
    type: K,
    listener: EventListener<EventMap[K]>,
  ): () => void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener<unknown>>();
    listeners.add(listener as EventListener<unknown>);
    this.listeners.set(type, listeners);
    return () => {
      listeners.delete(listener as EventListener<unknown>);
      if (listeners.size === 0) this.listeners.delete(type);
    };
  }

  publish<K extends keyof EventMap>(type: K, event: EventMap[K]): void {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A subscriber cannot break the runtime or other subscribers.
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
