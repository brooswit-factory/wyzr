import { describe, expect, test } from "bun:test";
import {
  classifyDirectPath,
  defaultRunCapturing,
  defaultRunTimed,
  RealWedgeProbes,
  type CaptureResult,
  type FetchLike,
  type SpawnResult,
} from "../../src/wedge-probes-real.ts";
import type {
  DirectPathConfig,
  GitHubInstrumentConfig,
  JiraInstrumentConfig,
  LocalConnectivityConfig,
  ControlPlaneConfig,
} from "../../src/wedge-probes.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Same cast-through-unknown pattern test/unit/transport-http.test.ts uses
 * for its own `fetchImpl` fakes — Bun's real `typeof fetch` carries extra
 * static properties (e.g. `preconnect`) a plain async function has no
 * reason to implement just to satisfy the injected type. */
function asFetch(fn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): FetchLike {
  return fn as unknown as FetchLike;
}

describe("classifyDirectPath — the pure classifier (no process spawning)", () => {
  test("this module's own timeout elapsing with no response: dead", () => {
    const result: SpawnResult = { exitCode: null, elapsedMs: 3000, timedOut: true };
    expect(classifyDirectPath(result, 3000).outcome).toBe("dead");
  });

  test("exit 0 within budget: alive", () => {
    const result: SpawnResult = { exitCode: 0, elapsedMs: 25, timedOut: false };
    expect(classifyDirectPath(result, 3000).outcome).toBe("alive");
  });

  test("the underlying tool's own connect-timeout essentially exhausted (>=90%) with a non-zero exit: dead", () => {
    const result: SpawnResult = { exitCode: 255, elapsedMs: 2950, timedOut: false };
    expect(classifyDirectPath(result, 3000).outcome).toBe("dead");
  });

  test("a fast non-zero exit (well under the connect-timeout budget): unconfirmed, never dead", () => {
    // Mirrors this project's own live 2026-09-10 observation: an unresolvable hostname fails via ssh
    // in ~30ms against a multi-second connect-timeout budget — nowhere near exhausting it.
    const result: SpawnResult = { exitCode: 255, elapsedMs: 30, timedOut: false };
    expect(classifyDirectPath(result, 3000).outcome).toBe("unconfirmed");
  });

  test("a fast SUCCESSFUL exit is never misread as unconfirmed or dead", () => {
    const result: SpawnResult = { exitCode: 0, elapsedMs: 20, timedOut: false };
    const classified = classifyDirectPath(result, 3000);
    expect(classified.outcome).toBe("alive");
    expect(classified.outcome).not.toBe("dead");
  });
});

const JIRA_CONFIG: JiraInstrumentConfig = {
  name: "jira-activity",
  baseUrl: "https://example-not-real.atlassian.net",
  authHeader: "Basic fake-secret-should-never-leak-abc123",
  dependsOn: ["manager-internet"],
  quietThresholdMs: 60_000,
  timeoutMs: 5000,
};

describe("RealWedgeProbes.checkJiraActivity", () => {
  test("a well-formed search response: observed, with the parsed timestamp", () => {
    const probes = new RealWedgeProbes({
      fetchImpl: asFetch(async () => jsonResponse({ issues: [{ fields: { updated: "2026-09-10T12:00:00.000Z" } }] })),
    });
    return probes.checkJiraActivity(JIRA_CONFIG).then((reading) => {
      expect(reading.outcome).toBe("observed");
      expect(reading.lastSeenAt).toBe(Date.parse("2026-09-10T12:00:00.000Z"));
    });
  });

  test("the auth header (a credential) is sent, but never appears in the request URL", async () => {
    let capturedUrl = "";
    const probes = new RealWedgeProbes({
      fetchImpl: asFetch(async (input) => {
        capturedUrl = String(input);
        return jsonResponse({ issues: [{ fields: { updated: "2026-09-10T12:00:00.000Z" } }] });
      }),
    });
    await probes.checkJiraActivity(JIRA_CONFIG);
    expect(capturedUrl).not.toContain("fake-secret-should-never-leak");
  });

  test("HTTP non-200: error, with a status-only note (never a fragment of the response body)", async () => {
    const probes = new RealWedgeProbes({
      fetchImpl: asFetch(async () => jsonResponse({ errorMessages: ["nope"] }, 401)),
    });
    const reading = await probes.checkJiraActivity(JIRA_CONFIG);
    expect(reading.outcome).toBe("error");
    expect(reading.note).toContain("401");
  });

  test("a response shaped unlike this project's expectation (no issues[0].fields.updated): error, never a crash", async () => {
    const probes = new RealWedgeProbes({ fetchImpl: asFetch(async () => jsonResponse({ issues: [] })) });
    const reading = await probes.checkJiraActivity(JIRA_CONFIG);
    expect(reading.outcome).toBe("error");
    expect(reading.lastSeenAt).toBeNull();
  });

  test("non-JSON response body: error, never a thrown exception", async () => {
    const probes = new RealWedgeProbes({ fetchImpl: asFetch(async () => new Response("not json", { status: 200 })) });
    const reading = await probes.checkJiraActivity(JIRA_CONFIG);
    expect(reading.outcome).toBe("error");
  });

  test("fetchImpl itself rejecting (network error): caught, never left to propagate", async () => {
    const probes = new RealWedgeProbes({
      fetchImpl: asFetch(async () => {
        throw new TypeError("fetch failed");
      }),
    });
    const reading = await probes.checkJiraActivity(JIRA_CONFIG);
    expect(reading.outcome).toBe("error");
  });

  test("projectKey, when supplied, narrows the JQL sent", async () => {
    let capturedUrl = "";
    const probes = new RealWedgeProbes({
      fetchImpl: asFetch(async (input) => {
        capturedUrl = String(input);
        return jsonResponse({ issues: [{ fields: { updated: "2026-09-10T12:00:00.000Z" } }] });
      }),
    });
    await probes.checkJiraActivity({ ...JIRA_CONFIG, projectKey: "WYZR" });
    expect(decodeURIComponent(capturedUrl)).toContain('project = "WYZR"');
  });
});

const GITHUB_CONFIG: GitHubInstrumentConfig = {
  name: "github-activity",
  owner: "brooswit-factory",
  repo: "wyzr",
  dependsOn: ["manager-internet"],
  quietThresholdMs: 60_000,
  timeoutMs: 5000,
};

describe("RealWedgeProbes.checkGitHubActivity", () => {
  // CAPTURED shape (see src/wedge-probes-real.ts's top comment): this is
  // trimmed from a live, unauthenticated
  // `GET /repos/brooswit-factory/wyzr/events?per_page=1` response observed
  // from this project's own dev sandbox on 2026-09-10 — only the fields
  // this project actually reads are kept, everything else is exactly the
  // shape GitHub returned.
  const CAPTURED_EVENT = { id: "20057906964", type: "PushEvent", created_at: "2026-09-03T04:46:22Z" };

  test("a well-formed events array: observed, with the parsed created_at", async () => {
    const probes = new RealWedgeProbes({ fetchImpl: asFetch(async () => jsonResponse([CAPTURED_EVENT])) });
    const reading = await probes.checkGitHubActivity(GITHUB_CONFIG);
    expect(reading.outcome).toBe("observed");
    expect(reading.lastSeenAt).toBe(Date.parse("2026-09-03T04:46:22Z"));
  });

  test("repo-scoped vs org-wide URL selection", async () => {
    let capturedUrl = "";
    const probes = new RealWedgeProbes({
      fetchImpl: asFetch(async (input) => {
        capturedUrl = String(input);
        return jsonResponse([CAPTURED_EVENT]);
      }),
    });
    await probes.checkGitHubActivity(GITHUB_CONFIG);
    expect(capturedUrl).toContain("/repos/brooswit-factory/wyzr/events");

    await probes.checkGitHubActivity({ ...GITHUB_CONFIG, repo: undefined });
    expect(capturedUrl).toContain("/orgs/brooswit-factory/events");
  });

  test("an empty events array: error (no activity observed), never a crash", async () => {
    const probes = new RealWedgeProbes({ fetchImpl: asFetch(async () => jsonResponse([])) });
    const reading = await probes.checkGitHubActivity(GITHUB_CONFIG);
    expect(reading.outcome).toBe("error");
    expect(reading.lastSeenAt).toBeNull();
  });

  test("HTTP non-200: error, status-only note", async () => {
    const probes = new RealWedgeProbes({
      fetchImpl: asFetch(async () => jsonResponse({ message: "rate limited" }, 403)),
    });
    const reading = await probes.checkGitHubActivity(GITHUB_CONFIG);
    expect(reading.outcome).toBe("error");
    expect(reading.note).toContain("403");
  });

  test("an optional token, when configured, is sent as a Bearer header, never in the URL", async () => {
    const captured: { url: string; auth: string | null }[] = [];
    const probes = new RealWedgeProbes({
      fetchImpl: asFetch(async (input, init) => {
        captured.push({
          url: String(input),
          auth: (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? null,
        });
        return jsonResponse([CAPTURED_EVENT]);
      }),
    });
    await probes.checkGitHubActivity({ ...GITHUB_CONFIG, token: "fake-gh-token-should-never-leak-xyz" });
    expect(captured[0]!.url).not.toContain("fake-gh-token-should-never-leak-xyz");
    expect(captured[0]!.auth).toBe("Bearer fake-gh-token-should-never-leak-xyz");
  });
});

const SSH_CONFIG: DirectPathConfig = { name: "ssh", host: "unused-in-these-tests", timeoutMs: 5000, connectTimeoutMs: 3000 };

describe("RealWedgeProbes.checkSsh / checkTunnelPing — wired to the injected runTimed, classified by classifyDirectPath", () => {
  test("checkSsh delegates to classifyDirectPath with the configured connectTimeoutMs", async () => {
    const probes = new RealWedgeProbes({
      runTimed: async () => ({ exitCode: 0, elapsedMs: 10, timedOut: false }),
    });
    const reading = await probes.checkSsh(SSH_CONFIG);
    expect(reading.outcome).toBe("alive");
  });

  test("checkSsh: this probe's own timeout elapsing is reported as dead", async () => {
    const probes = new RealWedgeProbes({
      runTimed: async () => ({ exitCode: null, elapsedMs: 5000, timedOut: true }),
    });
    const reading = await probes.checkSsh(SSH_CONFIG);
    expect(reading.outcome).toBe("dead");
  });

  test("checkSsh: the runTimed function itself throwing (e.g. ssh not on PATH) is caught as unconfirmed", async () => {
    const probes = new RealWedgeProbes({
      runTimed: async () => {
        throw new Error("spawn ssh ENOENT");
      },
    });
    const reading = await probes.checkSsh(SSH_CONFIG);
    expect(reading.outcome).toBe("unconfirmed");
  });

  test("checkTunnelPing uses the same classifier", async () => {
    const probes = new RealWedgeProbes({
      runTimed: async () => ({ exitCode: 1, elapsedMs: 20, timedOut: false }),
    });
    const reading = await probes.checkTunnelPing(SSH_CONFIG);
    expect(reading.outcome).toBe("unconfirmed");
  });
});

const LOCAL_CONTROL_CONFIG: LocalConnectivityConfig = {
  name: "local-connectivity",
  target: "unused-in-these-tests",
  timeoutMs: 5000,
  confirms: ["manager-internet"],
};

describe("RealWedgeProbes.checkLocalConnectivity", () => {
  test("a successful reply: healthy", async () => {
    const probes = new RealWedgeProbes({ runTimed: async () => ({ exitCode: 0, elapsedMs: 20, timedOut: false }) });
    const reading = await probes.checkLocalConnectivity(LOCAL_CONTROL_CONFIG);
    expect(reading.outcome).toBe("healthy");
  });

  test("this probe's own timeout elapsing: unhealthy, never silently 'healthy'", async () => {
    const probes = new RealWedgeProbes({ runTimed: async () => ({ exitCode: null, elapsedMs: 5000, timedOut: true }) });
    const reading = await probes.checkLocalConnectivity(LOCAL_CONTROL_CONFIG);
    expect(reading.outcome).toBe("unhealthy");
  });

  test("a non-zero, non-timeout exit: unhealthy", async () => {
    const probes = new RealWedgeProbes({ runTimed: async () => ({ exitCode: 2, elapsedMs: 30, timedOut: false }) });
    const reading = await probes.checkLocalConnectivity(LOCAL_CONTROL_CONFIG);
    expect(reading.outcome).toBe("unhealthy");
  });

  test("the probe tool itself failing to run: error, distinct from unhealthy", async () => {
    const probes = new RealWedgeProbes({
      runTimed: async () => {
        throw new Error("spawn ping ENOENT");
      },
    });
    const reading = await probes.checkLocalConnectivity(LOCAL_CONTROL_CONFIG);
    expect(reading.outcome).toBe("error");
  });
});

const CONTROL_PLANE_CONFIG: ControlPlaneConfig = { name: "tailscale", timeoutMs: 5000 };

describe("RealWedgeProbes.checkControlPlane", () => {
  test("Self.Online true: recorded as online true", async () => {
    const capture: CaptureResult = {
      exitCode: 0,
      stdout: JSON.stringify({ Self: { Online: true } }),
      timedOut: false,
    };
    const probes = new RealWedgeProbes({ runCapturing: async () => capture });
    const reading = await probes.checkControlPlane(CONTROL_PLANE_CONFIG);
    expect(reading.online).toBe(true);
  });

  test("Self.Online false: recorded as online false — still just recorded, this module makes no verdict decision", async () => {
    const capture: CaptureResult = { exitCode: 0, stdout: JSON.stringify({ Self: { Online: false } }), timedOut: false };
    const probes = new RealWedgeProbes({ runCapturing: async () => capture });
    const reading = await probes.checkControlPlane(CONTROL_PLANE_CONFIG);
    expect(reading.online).toBe(false);
  });

  test("malformed JSON: online unknown, never a thrown exception", async () => {
    const capture: CaptureResult = { exitCode: 0, stdout: "not json", timedOut: false };
    const probes = new RealWedgeProbes({ runCapturing: async () => capture });
    const reading = await probes.checkControlPlane(CONTROL_PLANE_CONFIG);
    expect(reading.online).toBe("unknown");
  });

  test("a JSON shape missing Self.Online: online unknown", async () => {
    const capture: CaptureResult = { exitCode: 0, stdout: JSON.stringify({ Self: {} }), timedOut: false };
    const probes = new RealWedgeProbes({ runCapturing: async () => capture });
    const reading = await probes.checkControlPlane(CONTROL_PLANE_CONFIG);
    expect(reading.online).toBe("unknown");
  });

  test("the tailscale binary missing entirely: online unknown, never a thrown exception", async () => {
    const probes = new RealWedgeProbes({
      runCapturing: async () => {
        throw new Error("spawn tailscale ENOENT");
      },
    });
    const reading = await probes.checkControlPlane(CONTROL_PLANE_CONFIG);
    expect(reading.online).toBe("unknown");
  });

  test("timeout: online unknown", async () => {
    const capture: CaptureResult = { exitCode: null, stdout: "", timedOut: true };
    const probes = new RealWedgeProbes({ runCapturing: async () => capture });
    const reading = await probes.checkControlPlane(CONTROL_PLANE_CONFIG);
    expect(reading.online).toBe("unknown");
  });
});

describe("RealWedgeProbes — constructed with no options at all uses the real defaults (no method is called, so this touches no network/subprocess)", () => {
  test("plain construction succeeds", () => {
    expect(() => new RealWedgeProbes()).not.toThrow();
  });
});

describe("defaultRunTimed / defaultRunCapturing — the real local-subprocess machinery, exercised against harmless commands (zero network, zero credentials)", () => {
  test("defaultRunTimed: a command that exits 0 quickly is reported alive-shaped (exitCode 0, not timed out)", async () => {
    const result = await defaultRunTimed(["true"], 5000);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  test("defaultRunTimed: a command that exits non-zero quickly is reported as such, not timed out", async () => {
    const result = await defaultRunTimed(["false"], 5000);
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
  });

  test("defaultRunTimed: a command that outlives its budget is killed and reported as timed out", async () => {
    const result = await defaultRunTimed(["sleep", "5"], 100);
    expect(result.timedOut).toBe(true);
  });

  test("defaultRunCapturing: stdout is captured and returned as text", async () => {
    const result = await defaultRunCapturing(["echo", "wedge-probe-capture-test"], 5000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("wedge-probe-capture-test");
    expect(result.timedOut).toBe(false);
  });

  test("defaultRunCapturing: a command that outlives its budget is killed and reported as timed out", async () => {
    const result = await defaultRunCapturing(["sleep", "5"], 100);
    expect(result.timedOut).toBe(true);
  });
});
