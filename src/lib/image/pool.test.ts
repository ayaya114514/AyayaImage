import { describe, expect, it } from 'vitest';
import { createOrderedCommits, runInPool } from './pool';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('runInPool', () => {
  it('runs small jobs side by side, up to the lane count', async () => {
    const gates = [deferred(), deferred(), deferred()];
    const started: Array<[number, number]> = [];
    const done = runInPool([0, 1, 2], () => 1, { concurrency: 2, budget: 10 }, async (job, lane) => {
      started.push([job, lane]);
      await gates[job]?.promise;
    });

    await tick();
    expect(started).toEqual([[0, 0], [1, 1]]);
    gates[1]?.resolve();
    await tick();
    expect(started).toEqual([[0, 0], [1, 1], [2, 1]]);
    gates[0]?.resolve();
    gates[2]?.resolve();
    await done;
  });

  it('never runs jobs together past the pixel budget', async () => {
    const gates = [deferred(), deferred()];
    const started: number[] = [];
    const done = runInPool([0, 1], () => 6, { concurrency: 2, budget: 10 }, async (job) => {
      started.push(job);
      await gates[job]?.promise;
    });

    await tick();
    expect(started).toEqual([0]);
    gates[0]?.resolve();
    await tick();
    expect(started).toEqual([0, 1]);
    gates[1]?.resolve();
    await done;
  });

  it('still runs a job heavier than the budget, alone', async () => {
    const started: number[] = [];
    await runInPool([50, 1], (job) => job, { concurrency: 2, budget: 10 }, async (job) => {
      started.push(job);
    });
    expect(started).toEqual([50, 1]);
  });

  it('keeps going after a job fails', async () => {
    const finished: number[] = [];
    await runInPool([0, 1, 2], () => 1, { concurrency: 1, budget: 10 }, async (job) => {
      if (job === 1) throw new Error('boom');
      finished.push(job);
    });
    expect(finished).toEqual([0, 2]);
  });
});

describe('createOrderedCommits', () => {
  it('publishes in reservation order even when work finishes out of order', async () => {
    const reserve = createOrderedCommits();
    const published: string[] = [];
    const first = reserve();
    const second = reserve();

    const late = (async () => {
      await tick();
      await tick();
      await first.turn();
      published.push('first');
      first.done();
    })();
    const early = (async () => {
      await second.turn();
      published.push('second');
      second.done();
    })();

    await Promise.all([late, early]);
    expect(published).toEqual(['first', 'second']);
  });
});
