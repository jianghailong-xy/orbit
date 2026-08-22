"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AsyncWorkQueue = void 0;
/**
 * A small in-process FIFO queue for best-effort background work. `run` resolves or rejects
 * with the submitted job, while no more than `concurrency` jobs execute at once.
 */
class AsyncWorkQueue {
    concurrency;
    active = 0;
    pending = [];
    constructor(concurrency) {
        this.concurrency = concurrency;
        if (!Number.isInteger(concurrency) || concurrency < 1) {
            throw new RangeError('concurrency must be a positive integer');
        }
    }
    run(work) {
        return new Promise((resolve, reject) => {
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
    drain() {
        while (this.active < this.concurrency) {
            const start = this.pending.shift();
            if (!start)
                return;
            start();
        }
    }
}
exports.AsyncWorkQueue = AsyncWorkQueue;
//# sourceMappingURL=async-work-queue.js.map