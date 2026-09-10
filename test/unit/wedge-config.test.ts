import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LOCAL_CONNECTIVITY_TARGET,
  loadWedgeConfigFromEnv,
  MANAGER_INTERNET_DEPENDENCY,
  type WedgeConfigEnv,
} from "../../src/wedge-config.ts";

describe("loadWedgeConfigFromEnv — unconfigured is the default, never a guess (WYZR-20 has not shipped yet)", () => {
  test("an entirely empty env: every fleet-specific field is unconfigured, only localConnectivity is populated", () => {
    const config = loadWedgeConfigFromEnv({});
    expect(config.jira).toBeUndefined();
    expect(config.github).toBeUndefined();
    expect(config.ssh).toBeUndefined();
    expect(config.tunnelPing).toBeUndefined();
    expect(config.controlPlane).toBeUndefined();
    expect(config.localConnectivity.target).toBe(DEFAULT_LOCAL_CONNECTIVITY_TARGET);
    expect(config.localConnectivity.confirms).toContain(MANAGER_INTERNET_DEPENDENCY);
  });

  test("jira requires BOTH base URL and auth header — one alone leaves it unconfigured, never a half-built probe", () => {
    const onlyUrl: WedgeConfigEnv = { WYZR_WEDGE_JIRA_BASE_URL: "https://example-not-real.atlassian.net" };
    expect(loadWedgeConfigFromEnv(onlyUrl).jira).toBeUndefined();

    const both: WedgeConfigEnv = {
      WYZR_WEDGE_JIRA_BASE_URL: "https://example-not-real.atlassian.net",
      WYZR_WEDGE_JIRA_AUTH_HEADER: "Basic fake",
    };
    expect(loadWedgeConfigFromEnv(both).jira).toBeDefined();
    expect(loadWedgeConfigFromEnv(both).jira?.dependsOn).toContain(MANAGER_INTERNET_DEPENDENCY);
  });

  test("github only requires an owner — repo and token stay optional", () => {
    const config = loadWedgeConfigFromEnv({ WYZR_WEDGE_GITHUB_OWNER: "brooswit-factory" });
    expect(config.github?.owner).toBe("brooswit-factory");
    expect(config.github?.repo).toBeUndefined();
    expect(config.github?.token).toBeUndefined();
  });

  test("ssh/tunnel-ping become configured only when a host is explicitly supplied", () => {
    const config = loadWedgeConfigFromEnv({ WYZR_WEDGE_SSH_HOST: "example-host" });
    expect(config.ssh?.host).toBe("example-host");
    expect(config.tunnelPing).toBeUndefined();
  });

  test("tunnel-ping is configured independently of ssh", () => {
    const config = loadWedgeConfigFromEnv({ WYZR_WEDGE_TUNNEL_PING_HOST: "example-tunnel-host" });
    expect(config.tunnelPing?.host).toBe("example-tunnel-host");
    expect(config.ssh).toBeUndefined();
  });

  test("the local-connectivity target is overridable, but still has a safe default when not overridden", () => {
    const overridden = loadWedgeConfigFromEnv({ WYZR_WEDGE_LOCAL_CONNECTIVITY_TARGET: "9.9.9.9" });
    expect(overridden.localConnectivity.target).toBe("9.9.9.9");

    const defaulted = loadWedgeConfigFromEnv({});
    expect(defaulted.localConnectivity.target).toBe(DEFAULT_LOCAL_CONNECTIVITY_TARGET);
  });

  test("an invalid/non-numeric threshold override falls back to the documented default rather than producing NaN", () => {
    const config = loadWedgeConfigFromEnv({
      WYZR_WEDGE_JIRA_BASE_URL: "https://example-not-real.atlassian.net",
      WYZR_WEDGE_JIRA_AUTH_HEADER: "Basic fake",
      WYZR_WEDGE_JIRA_QUIET_THRESHOLD_MS: "not-a-number",
    });
    expect(Number.isFinite(config.jira?.quietThresholdMs)).toBe(true);
    expect(config.jira?.quietThresholdMs).toBeGreaterThan(0);
  });

  test("control-plane is opted in only by its name env var being present", () => {
    expect(loadWedgeConfigFromEnv({}).controlPlane).toBeUndefined();
    expect(loadWedgeConfigFromEnv({ WYZR_WEDGE_CONTROL_PLANE_NAME: "tailscale" }).controlPlane?.name).toBe("tailscale");
  });
});
