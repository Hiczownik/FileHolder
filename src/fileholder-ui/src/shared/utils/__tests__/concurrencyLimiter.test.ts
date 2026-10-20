import { describe, it, expect } from 'vitest';
import { createConcurrencyLimiter } from '../concurrencyLimiter';

const LIMIT = 2;
const TASKS = 6;
const ALL_IN_ORDER = Array.from({ length: TASKS }, (_, i) => i);
const FRACTIONAL_LIMIT = 1.5;

/** A task that waits until the test lets it finish, recording how many tasks run at once. */
const controllableTasks = (count: number) => {
    let running = 0;
    let maxRunning = 0;
    const started: number[] = [];
    const finishers: (() => void)[] = [];
    const tasks = Array.from({ length: count }, (_, i) => async (): Promise<number> => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        started.push(i);
        await new Promise<void>((resolve) => { finishers[i] = resolve; });
        running--;
        return i;
    });
    return { tasks, started, finishers, maxRunning: (): number => maxRunning };
};

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('createConcurrencyLimiter', () => {
    it('never runs more tasks at once than the limit, and starts the rest in order', async () => {
        const limiter = createConcurrencyLimiter(LIMIT);
        const { tasks, started, finishers, maxRunning } = controllableTasks(TASKS);

        const results = Promise.all(tasks.map((task) => limiter.run(task)));
        await tick();
        expect(started).toEqual([0, 1]);

        // Finish tasks one at a time; each finish lets exactly the next waiting task start.
        await tasks.reduce(async (previous, _, i) => {
            await previous;
            finishers[i]();
            await tick();
        }, Promise.resolve());

        expect(await results).toEqual(ALL_IN_ORDER);
        expect(started).toEqual(ALL_IN_ORDER);
        expect(maxRunning()).toBe(LIMIT);
    });

    it('frees the slot of a task that fails', async () => {
        const limiter = createConcurrencyLimiter(1);

        await expect(limiter.run(async () => { throw new Error('upload failed'); })).rejects.toThrow('upload failed');

        expect(await limiter.run(async () => 'next one runs')).toBe('next one runs');
    });

    it.each([0, -1, FRACTIONAL_LIMIT])('refuses a limit of %s', (limit) => {
        expect(() => createConcurrencyLimiter(limit)).toThrow('at least 1');
    });
});
