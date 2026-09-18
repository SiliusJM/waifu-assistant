interface PendingProducer<T> {
  readonly value: T;
  readonly resolve: (accepted: boolean) => void;
  readonly cleanup: () => void;
}

interface PendingConsumer<T> {
  readonly resolve: (result: IteratorResult<T>) => void;
}

export class BoundedAsyncQueue<T> implements AsyncIterable<T> {
  readonly capacity: number;
  private readonly queue: T[] = [];
  private readonly producers: PendingProducer<T>[] = [];
  private readonly consumers: PendingConsumer<T>[] = [];
  private closed = false;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('Queue capacity must be a positive integer.');
    }
    this.capacity = capacity;
  }

  enqueue(value: T, signal?: AbortSignal): Promise<boolean> {
    if (this.closed || signal?.aborted) return Promise.resolve(false);
    const consumer = this.consumers.shift();
    if (consumer) {
      consumer.resolve({ done: false, value });
      return Promise.resolve(true);
    }
    if (this.queue.length < this.capacity) {
      this.queue.push(value);
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const onAbort = (): void => {
        const index = this.producers.indexOf(producer);
        if (index !== -1) this.producers.splice(index, 1);
        producer.resolve(false);
      };
      const producer: PendingProducer<T> = {
        value,
        resolve: (accepted) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(accepted);
        },
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      };
      this.producers.push(producer);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.queue.length > 0) {
      const value = this.queue.shift() as T;
      this.acceptOneProducer();
      return { done: false, value };
    }
    if (this.closed) return { done: true, value: undefined };
    return new Promise<IteratorResult<T>>((resolve) => {
      this.consumers.push({ resolve });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const producer of this.producers.splice(0)) {
      producer.cleanup();
      producer.resolve(false);
    }
    for (const consumer of this.consumers.splice(0)) {
      consumer.resolve({ done: true, value: undefined });
    }
    this.queue.length = 0;
  }

  finish(): void {
    if (this.closed) return;
    this.closed = true;
    for (const producer of this.producers.splice(0)) {
      producer.cleanup();
      producer.resolve(false);
    }
    this.flushConsumers();
  }

  get isClosed(): boolean { return this.closed; }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
      return: async () => {
        this.close();
        return { done: true, value: undefined };
      },
    };
  }

  private acceptOneProducer(): void {
    const producer = this.producers.shift();
    if (!producer || this.closed) return;
    this.queue.push(producer.value);
    producer.resolve(true);
  }

  private flushConsumers(): void {
    while (this.consumers.length > 0 && this.queue.length > 0) {
      const consumer = this.consumers.shift() as PendingConsumer<T>;
      consumer.resolve({ done: false, value: this.queue.shift() as T });
    }
    if (this.queue.length === 0) {
      for (const consumer of this.consumers.splice(0)) {
        consumer.resolve({ done: true, value: undefined });
      }
    }
  }
}
