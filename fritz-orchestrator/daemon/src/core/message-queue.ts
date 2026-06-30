/**
 * Simple FIFO message queue that serializes async operations.
 * Used by orchestrator to prevent concurrent Claude sessions.
 */
export class MessageQueue<TInput, TOutput> {
  private queue: Array<{
    input: TInput;
    resolve: (output: TOutput) => void;
    reject: (error: Error) => void;
  }> = [];
  private processing = false;

  constructor(
    private processor: (input: TInput) => Promise<TOutput>,
    private onQueued?: (position: number) => void,
  ) {}

  async enqueue(input: TInput): Promise<TOutput> {
    return new Promise((resolve, reject) => {
      this.queue.push({ input, resolve, reject });
      if (this.onQueued) this.onQueued(this.queue.length);
      this.processNext();
    });
  }

  get length(): number {
    return this.queue.length;
  }

  get isProcessing(): boolean {
    return this.processing;
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    const item = this.queue.shift()!;
    try {
      const result = await this.processor(item.input);
      item.resolve(result);
    } catch (error) {
      item.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.processing = false;
      this.processNext();
    }
  }
}
