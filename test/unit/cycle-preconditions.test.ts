import { describe, expect, test } from "bun:test";
import { evaluatePreconditions, type PreconditionsClearedWitness } from "../../src/cycle-preconditions.ts";
import { FakeCyclePlugTransport, fakePlugReading } from "../../src/cycle-plug-fake.ts";

describe("evaluatePreconditions — cleared", () => {
  test("both P3 and P5 decodable -> cleared, and returns a non-null witness", async () => {
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "on", reachable: true }) });
    const result = await evaluatePreconditions(plug);
    expect(result.outcome).toBe("cleared");
    expect(result.witness).not.toBeNull();
    expect(plug.readCount).toBe(1);
  });
});

describe("evaluatePreconditions — named test 3: gate PROVEN but cloud unreachable -> refuses (this module's own half)", () => {
  test("readState() throws (the cloud could not be reached) -> cloud_unreachable, no witness", async () => {
    const plug = new FakeCyclePlugTransport({
      readHandler: () => {
        throw new Error("simulated network failure reaching Wyze's cloud API");
      },
    });
    const result = await evaluatePreconditions(plug);
    expect(result.outcome).toBe("cloud_unreachable");
    expect(result.witness).toBeNull();
    expect(result.reading).toBeNull();
    expect(result.reasons.join(" ")).toContain("could not reach the cloud");
    // Proves the run actually REACHED this decision point (R6, widened):
    // the fake's own read counter shows the call was really made, not
    // skipped.
    expect(plug.readCount).toBe(1);
  });
});

describe("evaluatePreconditions — named test 4: gate PROVEN but plug state unreadable -> refuses", () => {
  test("P3 undecodable (power: unknown) -> plug_state_unreadable, no witness", async () => {
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "unknown", reachable: true }) });
    const result = await evaluatePreconditions(plug);
    expect(result.outcome).toBe("plug_state_unreadable");
    expect(result.witness).toBeNull();
    expect(plug.readCount).toBe(1);
  });

  test("P5 undecodable (reachable: null) -> plug_state_unreadable, no witness", async () => {
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "on", reachable: null }) });
    const result = await evaluatePreconditions(plug);
    expect(result.outcome).toBe("plug_state_unreadable");
    expect(result.witness).toBeNull();
  });

  test("both undecodable -> plug_state_unreadable, not somehow cloud_unreachable (nothing threw)", async () => {
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "unknown", reachable: null }) });
    const result = await evaluatePreconditions(plug);
    expect(result.outcome).toBe("plug_state_unreadable");
  });

  test("reachable: false (confirmed unreachable, decodable) is STILL a known state, not plug_state_unreadable — decision (E)'s own rule, reused here", async () => {
    const plug = new FakeCyclePlugTransport({ readHandler: () => fakePlugReading({ power: "off", reachable: false }) });
    const result = await evaluatePreconditions(plug);
    expect(result.outcome).toBe("cleared");
  });
});

describe("PreconditionsClearedWitness — D4's structural pin (R8)", () => {
  test("a bare object literal does not satisfy the type — only evaluatePreconditions()'s own 'cleared' branch can produce one", () => {
    // The brand key is a MODULE-PRIVATE unique symbol (src/cycle-preconditions.ts),
    // never exported, so no code outside that module can even spell the
    // property this type requires. `{}` is missing it, so this assignment
    // is a compile error — that error IS the proof this type cannot be
    // casually constructed. Verified by removing the @ts-expect-error
    // directive below and observing `bun run typecheck` report exactly one
    // new error at this line (missing property from a symbol-keyed
    // interface) before restoring it.
    // @ts-expect-error — {} does not satisfy PreconditionsClearedWitness (missing the module-private symbol
    // property). If this line ever stops erroring, either the witness type gained a way to be satisfied by a
    // plain literal (defeating D4's structural guarantee) or it was removed entirely — either way, this
    // directive itself becomes an "unused @ts-expect-error" compile error, which is the pin.
    const forged: PreconditionsClearedWitness = {};
    void forged;
  });
});
