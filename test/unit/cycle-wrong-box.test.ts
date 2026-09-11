import { describe, expect, test } from "bun:test";
import { evaluateWrongBoxGuard, RealLocalIdentityProbe } from "../../src/cycle-wrong-box.ts";

describe("evaluateWrongBoxGuard — is_target (D7: refuses whatever the gate said)", () => {
  test("exact hostname match (same case) -> is_target", () => {
    const result = evaluateWrongBoxGuard("host-a", "host-a");
    expect(result.outcome).toBe("is_target");
  });

  test("case-only difference -> is_target (normalisation covers case)", () => {
    const result = evaluateWrongBoxGuard("Host-A", "host-a");
    expect(result.outcome).toBe("is_target");
  });

  test("leading/trailing whitespace -> is_target (normalisation covers trim)", () => {
    const result = evaluateWrongBoxGuard("  host-a  ", "host-a");
    expect(result.outcome).toBe("is_target");
  });

  test("FQDN target vs short local name -> is_target (the naive-guard trap: a bare !== would call this different)", () => {
    const result = evaluateWrongBoxGuard("host-a.example.internal", "host-a");
    expect(result.outcome).toBe("is_target");
  });

  test("short target vs FQDN local name -> is_target (same trap, other direction)", () => {
    const result = evaluateWrongBoxGuard("host-a", "host-a.example.internal");
    expect(result.outcome).toBe("is_target");
  });
});

describe("evaluateWrongBoxGuard — inconclusive (D7: err tight — refuses when it cannot affirmatively establish NOT the target)", () => {
  test("named test 8a: target unconfigured (undefined) -> inconclusive, REFUSES", () => {
    const result = evaluateWrongBoxGuard(undefined, "some-host");
    expect(result.outcome).toBe("inconclusive");
    expect(result.reasons.join(" ")).toContain("no configured target host");
  });

  test("named test 8a: target unconfigured (empty string) -> inconclusive, REFUSES", () => {
    const result = evaluateWrongBoxGuard("   ", "some-host");
    expect(result.outcome).toBe("inconclusive");
  });

  test("named test 8b: local identity unreadable (null) -> inconclusive, REFUSES", () => {
    const result = evaluateWrongBoxGuard("host-a", null);
    expect(result.outcome).toBe("inconclusive");
    expect(result.reasons.join(" ")).toContain("this machine's own hostname could not be read");
  });

  test("named test 8c: IP-literal target vs hostname local -> inconclusive (no DNS resolution is performed)", () => {
    const result = evaluateWrongBoxGuard("10.0.0.5", "host-a");
    expect(result.outcome).toBe("inconclusive");
    expect(result.reasons.join(" ")).toContain("different formats");
  });

  test("named test 8c, other direction: hostname target vs IP-literal local -> inconclusive", () => {
    const result = evaluateWrongBoxGuard("host-a", "10.0.0.5");
    expect(result.outcome).toBe("inconclusive");
  });
});

describe("evaluateWrongBoxGuard — not_target (affirmatively established difference)", () => {
  test("two genuinely different hostnames, same format -> not_target", () => {
    const result = evaluateWrongBoxGuard("host-a", "host-b");
    expect(result.outcome).toBe("not_target");
  });

  test("two different IP literals -> not_target (same format, affirmatively different)", () => {
    const result = evaluateWrongBoxGuard("10.0.0.5", "10.0.0.6");
    expect(result.outcome).toBe("not_target");
  });

  test("two different FQDNs with different short names -> not_target", () => {
    const result = evaluateWrongBoxGuard("host-a.example.internal", "host-b.example.internal");
    expect(result.outcome).toBe("not_target");
  });
});

describe("RealLocalIdentityProbe", () => {
  test("getLocalHostname() returns this process's own hostname as a non-empty string in this environment", async () => {
    // This is the ONLY place this probe reads from — os.hostname() — no
    // ssh, no subprocess. A real, live call (no network) — appropriate
    // here since it touches nothing but this process's own OS binding, the
    // same "real" a plain Date.now() call would be.
    const probe = new RealLocalIdentityProbe();
    const hostname = await probe.getLocalHostname();
    expect(typeof hostname).toBe("string");
    expect((hostname ?? "").length).toBeGreaterThan(0);
  });

  test("getLocalHostname() returns null (unreadable) when the injected hostname primitive throws — the catch branch, never propagated as a rejection", async () => {
    const probe = new RealLocalIdentityProbe({
      hostnameFn: () => {
        throw new Error("simulated-os-hostname-failure-fixture");
      },
    });
    await expect(probe.getLocalHostname()).resolves.toBeNull();
  });

  test("getLocalHostname() returns null when the injected primitive returns an empty/whitespace-only string", async () => {
    const probe = new RealLocalIdentityProbe({ hostnameFn: () => "   " });
    await expect(probe.getLocalHostname()).resolves.toBeNull();
  });

  test("getLocalHostname() returns the injected primitive's value verbatim when it is non-empty", async () => {
    const probe = new RealLocalIdentityProbe({ hostnameFn: () => "injected-hostname-fixture" });
    await expect(probe.getLocalHostname()).resolves.toBe("injected-hostname-fixture");
  });
});
