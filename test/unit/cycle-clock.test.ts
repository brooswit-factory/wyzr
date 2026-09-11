import { describe, expect, test } from "bun:test";
import { createFakeCycleClock, RealCycleClock } from "../../src/cycle-clock.ts";

describe("createFakeCycleClock — named test 17: no real-timer sleep, even for a multi-minute virtual wait", () => {
  test("sleep(5 minutes) resolves in real wall-clock milliseconds, not real minutes", async () => {
    const clock = createFakeCycleClock(0);
    const wallClockStart = Date.now();
    await clock.sleep(5 * 60_000);
    const wallClockElapsed = Date.now() - wallClockStart;
    // A real 5-minute sleep would never complete inside a unit test's
    // default timeout at all; completing in well under one real second is
    // the proof this never touched a real timer.
    expect(wallClockElapsed).toBeLessThan(1_000);
  });

  test("now() only ever advances by exactly the ms values passed to sleep(), in order — never by wall-clock elapsed time", async () => {
    const clock = createFakeCycleClock(1_000);
    expect(clock.now()).toBe(1_000);
    await clock.sleep(2_000);
    expect(clock.now()).toBe(3_000);
    await clock.sleep(500);
    expect(clock.now()).toBe(3_500);
    expect(clock.sleeps).toEqual([2_000, 500]);
  });
});

describe("RealCycleClock", () => {
  test("now() returns a real epoch-ms number close to Date.now()", () => {
    const before = Date.now();
    const value = RealCycleClock.now();
    const after = Date.now();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });

  test("sleep() actually waits a real, if short, duration — this is the ONE implementation allowed to touch a real timer, never used directly by the test suite's own logic", async () => {
    const start = Date.now();
    await RealCycleClock.sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});
