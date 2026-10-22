export interface PoolOptions {
  /** Jobs running at the same time, at least 1. */
  concurrency: number;
  /**
   * Total weight (decoded pixels) allowed in flight. A job heavier than the
   * budget still runs, but only on its own.
   */
  budget: number;
}

/**
 * Runs `run` for every job, starting them strictly in order. A job starts when
 * a lane is free and its weight fits the remaining budget, so a batch of small
 * photos runs in parallel while large ones never decode side by side.
 * `lane` (0 … concurrency - 1) identifies the free lane, e.g. its worker.
 */
export async function runInPool<T>(
  jobs: readonly T[],
  weightOf: (job: T) => number,
  options: PoolOptions,
  run: (job: T, lane: number) => Promise<void>,
): Promise<void> {
  const concurrency = Math.max(1, Math.floor(options.concurrency));
  const freeLanes = Array.from({ length: concurrency }, (_, lane) => lane);
  const running = new Set<Promise<void>>();
  let inFlightWeight = 0;

  for (const job of jobs) {
    const weight = Math.max(0, weightOf(job));
    while (
      running.size > 0
      && (freeLanes.length === 0 || inFlightWeight + weight > options.budget)
    ) {
      await Promise.race(running);
    }

    const lane = freeLanes.shift() as number;
    inFlightWeight += weight;
    const task: Promise<void> = run(job, lane)
      .catch(() => undefined)
      .finally(() => {
        inFlightWeight -= weight;
        freeLanes.push(lane);
        running.delete(task);
      });
    running.add(task);
  }

  await Promise.all(running);
}

/**
 * Reserves result slots in start order: each job awaits `turn()` before
 * publishing, so results land in queue order even when jobs finish out of
 * order (output-name deduplication depends on that order).
 */
export function createOrderedCommits() {
  let previous: Promise<void> = Promise.resolve();
  return () => {
    const wait = previous;
    let release!: () => void;
    previous = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { turn: () => wait, done: () => release() };
  };
}
