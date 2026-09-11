// A first-class fake implementation of PlugWriter (src/cycle-plug.ts), for
// exercising every code path in `wyzr cycle` with NO network and NO
// credentials. Same shape as src/wedge-probes-fake.ts/
// src/recovery-probes-fake.ts: a handler override per method, plus COUNTS
// (`writeCount`/`writes`/`readCount`) a test can assert against directly —
// this is the instrument R1's and R6's own tests are built on: "assert no
// write was attempted" and "the OFF write is attempted at most once" both
// need a spy that counts real calls, not just an exit code, and R6 also
// needs proof the run actually REACHED the point a write would occur
// (`readCount`/`writeCount` are what that proof is built from too).

import type { PlugReading } from "./plug.ts";
import type { PlugWriter } from "./cycle-plug.ts";

export type ReadHandler = (attempt: number) => PlugReading | Promise<PlugReading>;
export type WriteHandler = (value: "0" | "1", attempt: number) => void | Promise<void>;

export interface FakeCyclePlugOptions {
  readHandler?: ReadHandler;
  writeHandler?: WriteHandler;
}

export function fakePlugReading(overrides: Partial<PlugReading> = {}): PlugReading {
  return { power: "off", reachable: true, note: null, ...overrides };
}

/**
 * Every `readState()`/`writePower()` call is COUNTED and, for writes, its
 * requested value RECORDED in call order — `writes` is what
 * test/unit/cycle-runner.test.ts's R1 pin asserts against
 * (`writes.filter(v => v === "0").length === 1`), and `readCount`/
 * `writeCount` are what R6's "the run actually reached the write point"
 * assertions are built on.
 */
export class FakeCyclePlugTransport implements PlugWriter {
  readCount = 0;
  writeCount = 0;
  readonly writes: Array<"0" | "1"> = [];

  constructor(private readonly opts: FakeCyclePlugOptions = {}) {}

  async readState(): Promise<PlugReading> {
    this.readCount++;
    return this.opts.readHandler ? await this.opts.readHandler(this.readCount) : fakePlugReading();
  }

  async writePower(value: "0" | "1"): Promise<void> {
    this.writeCount++;
    this.writes.push(value);
    if (this.opts.writeHandler) await this.opts.writeHandler(value, this.writeCount);
  }
}
