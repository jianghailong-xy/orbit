/**
 * A small in-process FIFO queue for best-effort background work. `run` resolves or rejects
 * with the submitted job, while no more than `concurrency` jobs execute at once.
 */
export class AsyncWorkQueue {
  private active = 0;
  private readonly pending: Array<() => void> = [];

  constructor(readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError('concurrency must be a positive integer');
    }
  }

  run<T>(work: () => T | Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push(() => {
        this.active += 1;
        void Promise.resolve()
          .then(work)
          .then(resolve, reject)
          .finally(() => {
            this.active -= 1;
            this.drain();
          });
      });
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.concurrency) {
      const start = this.pending.shift();
      if (!start) return;
      start();
    }
  }
}
