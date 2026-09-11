// The injected clock `wyzr cycle` uses for its wait-after-OFF and its
// bounded, never-give-up ON-restore retry loop (D1: "this is the ONE place
// in this product where a retry loop and a timer are justified... behind an
// INJECTED CLOCK"). Same reasoning as src/wedge.ts's `WedgeInput.now` and
// src/recovery-runner.ts's `now` — a module that reads the wall clock
// itself cannot be tested exactly at a bound, only near one with a
// tolerance, and this repo's suite is deliberately real-timer-free.
//
// NO DEFAULT (R9): src/cycle-runner.ts takes a CycleClock as a REQUIRED
// parameter on every exported entry point, never `?? RealCycleClock` —
// see that module's own comment and test/unit/cycle-clock.test.ts's
// type-level pin.

export interface CycleClock {
  now(): number;
  /** Resolves after (at least) `ms` — the ONLY place `wyzr cycle` waits.
   * The real implementation uses a real timer; the fake below advances a
   * virtual clock instantly, which is what keeps this repo's suite free of
   * real-timer sleeps. */
  sleep(ms: number): Promise<void>;
}

export const RealCycleClock: CycleClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface FakeCycleClock extends CycleClock {
  /** Every `ms` value passed to sleep(), in call order — lets a test
   * assert how many times, and for how long, the orchestration actually
   * waited, without a real timer ever running. */
  readonly sleeps: readonly number[];
}

/**
 * A virtual clock: `now()` returns a counter that only ever moves when
 * `sleep()` is called (by however much was requested), and `sleep()` itself
 * never touches a real timer — it advances the counter and resolves on the
 * next microtask. This is what makes it possible to unit-test a bounded
 * multi-minute retry loop in milliseconds of real wall-clock test time,
 * with the loop's own bound-checking logic exercised for real (never
 * skipped) — see test/unit/cycle-runner.test.ts, and named test 17's own
 * assertion that no real timer is ever started by this repo's suite.
 */
export function createFakeCycleClock(startAt = 0): FakeCycleClock {
  let current = startAt;
  const sleeps: number[] = [];
  return {
    now: () => current,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      current += ms;
    },
    sleeps,
  };
}
