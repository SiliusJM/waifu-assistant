interface Consumer<T> {
  readonly resolve: (value: IteratorResult<T>) => void;
  readonly reject: (error: Error) => void;
}

/** Small synchronous producer queue for native audio callbacks; it never waits in the callback. */
export class CaptureQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly consumers: Consumer<T>[] = [];
  private ended = false;
  private failure: Error | undefined;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('Capture queue capacity must be positive.');
  }

  push(item: T): boolean {
    if (this.ended) return false;
    const consumer = this.consumers.shift();
    if (consumer) consumer.resolve({ done: false, value: item });
    else if (this.items.length < this.capacity) this.items.push(item);
    else return false;
    return true;
  }

  finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.flush();
  }

  fail(error: Error): void {
    if (this.ended) return;
    this.failure = error;
    this.items.length = 0;
    this.ended = true;
    this.flush();
  }

  discard(): void {
    if (this.ended) return;
    this.items.length = 0;
    this.ended = true;
    this.flush();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        if (this.items.length > 0) return { done: false, value: this.items.shift() as T };
        if (this.failure) throw this.failure;
        if (this.ended) return { done: true, value: undefined };
        return new Promise<IteratorResult<T>>((resolve, reject) => this.consumers.push({ resolve, reject }));
      },
      return: async () => {
        this.items.length = 0;
        this.finish();
        return { done: true, value: undefined };
      },
    };
  }

  private flush(): void {
    while (this.consumers.length > 0 && this.items.length > 0) {
      (this.consumers.shift() as Consumer<T>).resolve({ done: false, value: this.items.shift() as T });
    }
    if (!this.ended || this.items.length > 0) return;
    for (const consumer of this.consumers.splice(0)) {
      if (this.failure) consumer.reject(this.failure);
      else consumer.resolve({ done: true, value: undefined });
    }
  }
}
