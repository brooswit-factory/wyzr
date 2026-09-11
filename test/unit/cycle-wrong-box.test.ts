import { describe, expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import {
  evaluateWrongBoxGuard,
  RealWrongBoxIdentityProbe,
  runWrongBoxGuard,
  type WrongBoxIdentityProbe,
} from "../../src/cycle-wrong-box.ts";

const TARGET_FIXTURE = "target-fixture.invalid";

describe("evaluateWrongBoxGuard (pure core) — is_target: overlapping addresses (D7: refuses whatever the gate said)", () => {
  test("target resolves to an address this machine also owns -> is_target", () => {
    const result = evaluateWrongBoxGuard(TARGET_FIXTURE, ["10.0.0.5"], ["10.0.0.5", "192.168.1.9"]);
    expect(result.outcome).toBe("is_target");
    expect(result.reasons.join(" ")).toContain("10.0.0.5");
  });

  test("case/whitespace in the resolved address strings is normalised before comparing", () => {
    const result = evaluateWrongBoxGuard(TARGET_FIXTURE, [" FE80::1 "], ["fe80::1"]);
    expect(result.outcome).toBe("is_target");
  });

  test("only ONE overlapping address among several is still enough to refuse", () => {
    const result = evaluateWrongBoxGuard(TARGET_FIXTURE, ["10.0.0.5", "10.0.0.6"], ["10.0.0.9", "10.0.0.6"]);
    expect(result.outcome).toBe("is_target");
  });
});

describe("evaluateWrongBoxGuard (pure core) — not_target: disjoint, both successfully resolved (real evidence, not a shape heuristic)", () => {
  test("genuinely different address sets -> not_target", () => {
    const result = evaluateWrongBoxGuard(TARGET_FIXTURE, ["10.0.0.5"], ["10.0.0.9"]);
    expect(result.outcome).toBe("not_target");
  });

  test("this is the epic's own worked example, now resolvable through address evidence rather than string shape: a container-shaped local identity and a plain target name, disjoint addresses -> not_target", () => {
    // Named for what it constructs (R7): unlike round 2's string-kind
    // rule, this does NOT depend on either identity's textual SHAPE at
    // all — only on the addresses the probe boundary reports. A
    // "physicalhost"-vs-"a3f9c21b4e77"-shaped pair is exactly as
    // resolvable as any other pair once real address evidence exists.
    const result = evaluateWrongBoxGuard("physicalhost", ["10.0.0.5"], ["10.0.0.9"]);
    expect(result.outcome).toBe("not_target");
  });
});

describe("evaluateWrongBoxGuard (pure core) — inconclusive: every case where evidence is missing (err tight, D7)", () => {
  test("named test 8a: target unconfigured (undefined) -> inconclusive, REFUSES", () => {
    const result = evaluateWrongBoxGuard(undefined, null, ["10.0.0.9"]);
    expect(result.outcome).toBe("inconclusive");
    expect(result.reasons.join(" ")).toContain("no configured target host");
  });

  test("named test 8a: target unconfigured (empty string) -> inconclusive, REFUSES", () => {
    const result = evaluateWrongBoxGuard("   ", null, ["10.0.0.9"]);
    expect(result.outcome).toBe("inconclusive");
  });

  test("named test 8b (generalised): the target could not be resolved to any address -> inconclusive, REFUSES, and the message states this does not mean the target is powered off", () => {
    const result = evaluateWrongBoxGuard(TARGET_FIXTURE, null, ["10.0.0.9"]);
    expect(result.outcome).toBe("inconclusive");
    expect(result.reasons.join(" ")).toContain("could not resolve");
    expect(result.reasons.join(" ")).toContain("not why this failed");
  });

  test("this machine's own addresses could not be enumerated -> inconclusive, REFUSES", () => {
    const result = evaluateWrongBoxGuard(TARGET_FIXTURE, ["10.0.0.5"], []);
    expect(result.outcome).toBe("inconclusive");
    expect(result.reasons.join(" ")).toContain("could not enumerate");
  });
});

describe(
  "evaluateWrongBoxGuard — ROUND 3 regression pin: no pure STRING rule can resolve identity, and this construction no longer tries to (WYZR-27, 2026-09-11)",
  () => {
    // History, briefly (full account in src/cycle-wrong-box.ts's own top
    // comment): round 1 special-cased FQDN-vs-short-name and let a DNS
    // alias/container divergence read "not_target". Round 2 replaced that
    // with a "same kind of identifier" string rule — ALSO wrong, because
    // it classified "physicalhost" and "a3f9c21b4e77" (the epic's own
    // worked example) as two ordinary short hostnames, so it STILL cleared
    // the exact row the correction was about. The epic's actual finding:
    // no pure function over two STRINGS can rule this out — the
    // information needed is not in the inputs. Round 3 (this file, current
    // code) replaces the string rule entirely with real address evidence
    // gathered through the injectable WrongBoxIdentityProbe boundary. This
    // block pins that a STRING-SHAPE-ONLY heuristic can never come back:
    // feeding the pure core real, overlapping address evidence for a
    // shape-mismatched pair still (correctly) refuses, and disjoint
    // evidence for the identical shape-mismatched pair still (correctly)
    // proceeds — the OUTCOME tracks the ADDRESSES, never the strings'
    // shape.

    test("shape-mismatched identities (fqdn-shaped target, short-shaped local) that DO share an address -> is_target, proving the decision tracks addresses, not string shape", () => {
      const result = evaluateWrongBoxGuard("fleetbox.internal.example", ["10.0.0.5"], ["10.0.0.5"]);
      expect(result.outcome).toBe("is_target");
    });

    test("shape-mismatched identities (hex-id-shaped local, short-shaped target) that do NOT share an address -> not_target, proving a container-id-shaped local identity is no longer treated as unresolvable by construction", () => {
      const result = evaluateWrongBoxGuard("physicalhost", ["10.0.0.5"], ["10.0.0.9"]);
      expect(result.outcome).toBe("not_target");
    });

    test("two ordinary, differently-named hosts with disjoint addresses -> not_target — the guard must NOT become stricter than the evidence warrants (round-2's own warning against over-correcting still applies)", () => {
      const result = evaluateWrongBoxGuard("manager-01", ["10.0.0.5"], ["10.0.0.9"]);
      expect(result.outcome).toBe("not_target");
    });
  },
);

describe("runWrongBoxGuard (I/O runner) — gathers probe evidence concurrently and hands it to the pure core", () => {
  function fakeProbe(overrides: Partial<WrongBoxIdentityProbe> = {}): WrongBoxIdentityProbe {
    return {
      resolveTargetAddresses: async () => ["10.0.0.5"],
      getLocalAddresses: async () => ["10.0.0.5"],
      ...overrides,
    };
  }

  test("unconfigured target -> inconclusive without ever calling the probe", async () => {
    let calls = 0;
    const probe = fakeProbe({
      resolveTargetAddresses: async () => {
        calls++;
        return ["10.0.0.5"];
      },
    });
    const result = await runWrongBoxGuard(undefined, probe);
    expect(result.outcome).toBe("inconclusive");
    expect(calls).toBe(0);
  });

  test("overlapping addresses from the real probe shape -> is_target", async () => {
    const result = await runWrongBoxGuard(TARGET_FIXTURE, fakeProbe());
    expect(result.outcome).toBe("is_target");
  });

  test("disjoint addresses -> not_target", async () => {
    const result = await runWrongBoxGuard(
      TARGET_FIXTURE,
      fakeProbe({ getLocalAddresses: async () => ["10.0.0.9"] }),
    );
    expect(result.outcome).toBe("not_target");
  });

  test("probe reports resolution failure (null) -> inconclusive", async () => {
    const result = await runWrongBoxGuard(TARGET_FIXTURE, fakeProbe({ resolveTargetAddresses: async () => null }));
    expect(result.outcome).toBe("inconclusive");
  });

  test("target is passed to the probe trimmed", async () => {
    let seen: string | undefined;
    const probe = fakeProbe({
      resolveTargetAddresses: async (target) => {
        seen = target;
        return ["10.0.0.5"];
      },
    });
    await runWrongBoxGuard(`  ${TARGET_FIXTURE}  `, probe);
    expect(seen).toBe(TARGET_FIXTURE);
  });
});

describe("RealWrongBoxIdentityProbe", () => {
  test("resolveTargetAddresses() returns the injected resolver's addresses verbatim", async () => {
    const probe = new RealWrongBoxIdentityProbe({ resolveAddressesFn: async () => ["10.0.0.5", "10.0.0.6"] });
    await expect(probe.resolveTargetAddresses(TARGET_FIXTURE)).resolves.toEqual(["10.0.0.5", "10.0.0.6"]);
  });

  test("resolveTargetAddresses() returns null when the injected resolver throws — never a rejection", async () => {
    const probe = new RealWrongBoxIdentityProbe({
      resolveAddressesFn: async () => {
        throw new Error("simulated-dns-failure-fixture");
      },
    });
    await expect(probe.resolveTargetAddresses(TARGET_FIXTURE)).resolves.toBeNull();
  });

  test("resolveTargetAddresses() returns null when the injected resolver resolves to zero addresses", async () => {
    const probe = new RealWrongBoxIdentityProbe({ resolveAddressesFn: async () => [] });
    await expect(probe.resolveTargetAddresses(TARGET_FIXTURE)).resolves.toBeNull();
  });

  test("getLocalAddresses() excludes internal/loopback entries and flattens every interface's addresses", async () => {
    const fakeInterfaces = {
      lo: [{ address: "127.0.0.1", internal: true }],
      eth0: [
        { address: "10.0.0.5", internal: false },
        { address: "fe80::1", internal: false },
      ],
    };
    const probe = new RealWrongBoxIdentityProbe({
      networkInterfacesFn: () => fakeInterfaces as unknown as ReturnType<typeof networkInterfaces>,
    });
    await expect(probe.getLocalAddresses()).resolves.toEqual(["10.0.0.5", "fe80::1"]);
  });

  test("getLocalAddresses() returns an empty array when the injected primitive throws — never a rejection", async () => {
    const probe = new RealWrongBoxIdentityProbe({
      networkInterfacesFn: () => {
        throw new Error("simulated-os-failure-fixture");
      },
    });
    await expect(probe.getLocalAddresses()).resolves.toEqual([]);
  });

  test("the real (uninjected) probe actually enumerates this process's own network addresses — a real, live call (no network I/O — os.networkInterfaces() is purely local)", async () => {
    const probe = new RealWrongBoxIdentityProbe();
    const addresses = await probe.getLocalAddresses();
    expect(Array.isArray(addresses)).toBe(true);
  });

  test("the real (uninjected) probe actually resolves 'localhost' via this machine's own hosts-file/resolver — a real, live call answered locally, never a query that could reach any fleet host", async () => {
    const probe = new RealWrongBoxIdentityProbe();
    const addresses = await probe.resolveTargetAddresses("localhost");
    expect(addresses).not.toBeNull();
    expect(addresses!.length).toBeGreaterThan(0);
  });
});
