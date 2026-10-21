/**
 * Runs at most `maxConcurrent` tasks at a time; the rest wait, in the order they asked, for a slot to free up.
 * A task's slot is released when it settles, whether it succeeded or failed.
 */
export interface ConcurrencyLimiter {
    readonly run: <T>(task: () => Promise<T>) => Promise<T>;
}

export function createConcurrencyLimiter(maxConcurrent: number): ConcurrencyLimiter {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
        throw new Error(`A concurrency limit must be a whole number of at least 1, not ${maxConcurrent}.`);
    }

    let running = 0;
    const waiting: (() => void)[] = [];

    const acquire = (): Promise<void> => {
        if (running < maxConcurrent) {
            running++;
            return Promise.resolve();
        }
        // The slot is handed over directly by release(), so `running` stays the same.
        return new Promise((resolve) => waiting.push(resolve));
    };

    const release = (): void => {
        const next = waiting.shift();
        if (next) {
            next();
        } else {
            running--;
        }
    };

    return {
        run: async <T,>(task: () => Promise<T>): Promise<T> => {
            await acquire();
            try {
                return await task();
            } finally {
                release();
            }
        },
    };
}
