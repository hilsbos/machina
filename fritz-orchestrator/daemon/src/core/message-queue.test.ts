/**
 * Vitest unit tests for MessageQueue:
 * - Single message processing
 * - Serialization (concurrent messages wait in line)
 * - FIFO ordering
 * - Error isolation (one failure doesn't block the queue)
 * - onQueued callback reporting
 * - length / isProcessing getters
 */

import { describe, it, expect, vi } from 'vitest';
import { MessageQueue } from './message-queue.js';

// ============================================================================
// Helpers
// ============================================================================

/** Create a deferred promise so the test can control when the processor resolves. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ============================================================================
// Single message
// ============================================================================

describe('MessageQueue', () => {
  it('processes a single message', async () => {
    const processor = vi.fn(async (input: string) => `result:${input}`);
    const queue = new MessageQueue(processor);

    const result = await queue.enqueue('hello');

    expect(result).toBe('result:hello');
    expect(processor).toHaveBeenCalledOnce();
    expect(processor).toHaveBeenCalledWith('hello');
  });

  // ==========================================================================
  // Serialization
  // ==========================================================================

  it('serializes concurrent messages (second waits for first)', async () => {
    const order: string[] = [];

    const d1 = deferred<string>();
    const d2 = deferred<string>();

    let callCount = 0;
    const processor = vi.fn((input: string): Promise<string> => {
      callCount++;
      order.push(`start:${input}`);
      return callCount === 1 ? d1.promise : d2.promise;
    });

    const queue = new MessageQueue(processor);

    const p1 = queue.enqueue('first');
    const p2 = queue.enqueue('second');

    // At this point, only the first message should be processing
    expect(processor).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['start:first']);

    // Resolve first message
    d1.resolve('result:first');
    const result1 = await p1;

    // After first resolves, second should start processing
    // Wait a tick for processNext to fire
    await new Promise((r) => setTimeout(r, 0));
    expect(processor).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['start:first', 'start:second']);

    // Resolve second
    d2.resolve('result:second');
    const result2 = await p2;

    expect(result1).toBe('result:first');
    expect(result2).toBe('result:second');
  });

  // ==========================================================================
  // FIFO order
  // ==========================================================================

  it('maintains FIFO order', async () => {
    const order: string[] = [];

    // Enqueue three messages — because processor is sync-ish (resolves immediately),
    // we need to ensure they're all queued before any processing completes.
    // Use a controlled processor to hold the first.
    const d = deferred<string>();
    let firstCall = true;
    const controlledProcessor = (input: string): Promise<string> => {
      order.push(input);
      if (firstCall) {
        firstCall = false;
        return d.promise;
      }
      return Promise.resolve(`done:${input}`);
    };

    const controlledQueue = new MessageQueue(controlledProcessor);

    const p1 = controlledQueue.enqueue('A');
    const p2 = controlledQueue.enqueue('B');
    const p3 = controlledQueue.enqueue('C');

    // Only 'A' should have started
    expect(order).toEqual(['A']);

    // Release A
    d.resolve('done:A');
    await p1;

    // Wait for B and C to process
    await p2;
    await p3;

    expect(order).toEqual(['A', 'B', 'C']);
  });

  // ==========================================================================
  // Error isolation
  // ==========================================================================

  it('error in one message does not block subsequent messages', async () => {
    // Hold the first message so we can queue both before resolution
    const d1 = deferred<string>();
    let controlCount = 0;
    const controlledProcessor = (input: string): Promise<string> => {
      controlCount++;
      if (controlCount === 1) {
        return d1.promise;
      }
      return Promise.resolve(`ok:${input}`);
    };

    const errorQueue = new MessageQueue(controlledProcessor);

    const p1 = errorQueue.enqueue('fail');
    const p2 = errorQueue.enqueue('succeed');

    // Reject the first
    d1.reject(new Error('boom'));

    await expect(p1).rejects.toThrow('boom');

    // Second should still process successfully
    const result2 = await p2;
    expect(result2).toBe('ok:succeed');
  });

  it('wraps non-Error throws into Error objects', async () => {
    const processor = async (_input: string): Promise<string> => {
      throw 'string error';
    };

    const queue = new MessageQueue(processor);

    await expect(queue.enqueue('test')).rejects.toThrow('string error');
  });

  // ==========================================================================
  // onQueued callback
  // ==========================================================================

  it('reports queue position via onQueued callback', async () => {
    const positions: number[] = [];
    const d = deferred<string>();

    const processor = (input: string): Promise<string> => {
      if (input === 'first') return d.promise;
      return Promise.resolve(`done:${input}`);
    };

    const queue = new MessageQueue(processor, (pos) => positions.push(pos));

    const p1 = queue.enqueue('first');
    // After first enqueue, queue has 1 item then it's immediately shifted for processing,
    // but onQueued fires with the length at push time
    expect(positions).toEqual([1]);

    queue.enqueue('second');
    // 'second' is queued while 'first' is processing — queue length is 1 (first was shifted)
    expect(positions).toEqual([1, 1]);

    queue.enqueue('third');
    expect(positions).toEqual([1, 1, 2]);

    // Release first so everything completes
    d.resolve('done:first');
    await p1;
  });

  // ==========================================================================
  // Getters
  // ==========================================================================

  it('length returns number of items waiting in queue', async () => {
    const d = deferred<string>();
    const processor = (_input: string): Promise<string> => d.promise;

    const queue = new MessageQueue(processor);

    // Empty queue
    expect(queue.length).toBe(0);

    const p1 = queue.enqueue('a');
    // 'a' was shifted out for processing, queue should be 0
    expect(queue.length).toBe(0);

    queue.enqueue('b');
    expect(queue.length).toBe(1);

    queue.enqueue('c');
    expect(queue.length).toBe(2);

    // Release to clean up
    d.resolve('done');
    await p1;
  });

  it('isProcessing reflects whether an item is being processed', async () => {
    const d = deferred<string>();
    const processor = (_input: string): Promise<string> => d.promise;

    const queue = new MessageQueue(processor);

    expect(queue.isProcessing).toBe(false);

    const p1 = queue.enqueue('a');
    expect(queue.isProcessing).toBe(true);

    d.resolve('done');
    await p1;

    // After processing completes and queue is empty, isProcessing should be false
    // Wait a tick for the finally block to execute
    await new Promise((r) => setTimeout(r, 0));
    expect(queue.isProcessing).toBe(false);
  });

  it('isProcessing stays true while queue has items', async () => {
    const deferreds = [deferred<string>(), deferred<string>()];
    let callIndex = 0;
    const processor = (_input: string): Promise<string> => {
      return deferreds[callIndex++].promise;
    };

    const queue = new MessageQueue(processor);

    const p1 = queue.enqueue('a');
    const p2 = queue.enqueue('b');

    expect(queue.isProcessing).toBe(true);

    // Resolve first — second should start immediately
    deferreds[0].resolve('done:a');
    await p1;
    await new Promise((r) => setTimeout(r, 0));

    // Still processing (second item)
    expect(queue.isProcessing).toBe(true);

    deferreds[1].resolve('done:b');
    await p2;
    await new Promise((r) => setTimeout(r, 0));

    expect(queue.isProcessing).toBe(false);
  });

  // ==========================================================================
  // Edge cases
  // ==========================================================================

  it('handles rapid sequential enqueues', async () => {
    const results: string[] = [];
    const processor = async (input: string): Promise<string> => {
      results.push(input);
      return input;
    };

    const queue = new MessageQueue(processor);

    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(queue.enqueue(`msg-${i}`));
    }

    const allResults = await Promise.all(promises);

    // All should resolve in order
    expect(results).toEqual(
      Array.from({ length: 10 }, (_, i) => `msg-${i}`)
    );
    expect(allResults).toEqual(
      Array.from({ length: 10 }, (_, i) => `msg-${i}`)
    );
  });

  it('works with different input/output types', async () => {
    const processor = async (input: number): Promise<{ doubled: number }> => {
      return { doubled: input * 2 };
    };

    const queue = new MessageQueue(processor);

    const result = await queue.enqueue(21);
    expect(result).toEqual({ doubled: 42 });
  });
});
