import { describe, expect, test } from "bun:test";
import { loadRecoveryConfigFromEnv, type RecoveryConfigEnv } from "../../src/recovery-config.ts";

describe("loadRecoveryConfigFromEnv — jira/github/ssh/tunnel-ping/local-connectivity are reused from wedge config", () => {
  test("an entirely empty env: everything is unconfigured except localConnectivity", () => {
    const config = loadRecoveryConfigFromEnv({});
    expect(config.jira).toBeUndefined();
    expect(config.github).toBeUndefined();
    expect(config.ssh).toBeUndefined();
    expect(config.tunnelPing).toBeUndefined();
    expect(config.uptime).toBeUndefined();
    expect(config.daemon).toBeUndefined();
    expect(config.fleet).toBeUndefined();
    expect(config.localConnectivity.target).toBeTruthy();
  });

  test("the SAME WYZR_WEDGE_* env vars configure jira/github/ssh/tunnel-ping here too", () => {
    const env: RecoveryConfigEnv = {
      WYZR_WEDGE_JIRA_BASE_URL: "https://example-not-real.atlassian.net",
      WYZR_WEDGE_JIRA_AUTH_HEADER: "Basic fake",
      WYZR_WEDGE_GITHUB_OWNER: "brooswit-factory",
      WYZR_WEDGE_SSH_HOST: "example-host",
      WYZR_WEDGE_TUNNEL_PING_HOST: "example-tunnel-host",
    };
    const config = loadRecoveryConfigFromEnv(env);
    expect(config.jira?.baseUrl).toBe("https://example-not-real.atlassian.net");
    expect(config.github?.owner).toBe("brooswit-factory");
    expect(config.ssh?.host).toBe("example-host");
    expect(config.tunnelPing?.host).toBe("example-tunnel-host");
  });
});

describe("loadRecoveryConfigFromEnv — the new probes reuse ssh.host as their target, no second host var", () => {
  test("uptime/daemon/fleet are all unconfigured when ssh is unconfigured, even if their own vars are set", () => {
    const env: RecoveryConfigEnv = {
      WYZR_RECOVERY_DAEMON_UNIT: "example.service",
      WYZR_RECOVERY_DAEMON_SCOPE: "user",
      WYZR_RECOVERY_FLEET_PROCESS_MATCH: "claude",
      WYZR_RECOVERY_FLEET_EXPECTED_FLAGS: "--mcp-config",
    };
    const config = loadRecoveryConfigFromEnv(env);
    expect(config.uptime).toBeUndefined();
    expect(config.daemon).toBeUndefined();
    expect(config.fleet).toBeUndefined();
  });

  test("once ssh is configured, uptime becomes configured automatically, at ssh's own host", () => {
    const config = loadRecoveryConfigFromEnv({ WYZR_WEDGE_SSH_HOST: "example-host" });
    expect(config.uptime?.host).toBe("example-host");
  });

  test("uptime's timeout defaults to ssh's own timeout when not overridden", () => {
    const config = loadRecoveryConfigFromEnv({
      WYZR_WEDGE_SSH_HOST: "example-host",
      WYZR_WEDGE_SSH_TIMEOUT_MS: "9999",
    });
    expect(config.uptime?.timeoutMs).toBe(9999);
  });

  test("uptime's timeout is independently overridable", () => {
    const config = loadRecoveryConfigFromEnv({
      WYZR_WEDGE_SSH_HOST: "example-host",
      WYZR_WEDGE_SSH_TIMEOUT_MS: "9999",
      WYZR_RECOVERY_UPTIME_TIMEOUT_MS: "1234",
    });
    expect(config.uptime?.timeoutMs).toBe(1234);
  });
});

describe("loadRecoveryConfigFromEnv — daemon requires BOTH unit and scope, no default for either", () => {
  test("unit alone (no scope) leaves the daemon check unconfigured", () => {
    const config = loadRecoveryConfigFromEnv({ WYZR_WEDGE_SSH_HOST: "example-host", WYZR_RECOVERY_DAEMON_UNIT: "example.service" });
    expect(config.daemon).toBeUndefined();
  });

  test("scope alone (no unit) leaves the daemon check unconfigured", () => {
    const config = loadRecoveryConfigFromEnv({ WYZR_WEDGE_SSH_HOST: "example-host", WYZR_RECOVERY_DAEMON_SCOPE: "user" });
    expect(config.daemon).toBeUndefined();
  });

  test("an invalid scope value (neither 'user' nor 'system') leaves the check unconfigured, never a guess", () => {
    const config = loadRecoveryConfigFromEnv({
      WYZR_WEDGE_SSH_HOST: "example-host",
      WYZR_RECOVERY_DAEMON_UNIT: "example.service",
      WYZR_RECOVERY_DAEMON_SCOPE: "both",
    });
    expect(config.daemon).toBeUndefined();
  });

  test("unit AND a valid scope together: configured", () => {
    const config = loadRecoveryConfigFromEnv({
      WYZR_WEDGE_SSH_HOST: "example-host",
      WYZR_RECOVERY_DAEMON_UNIT: "example.service",
      WYZR_RECOVERY_DAEMON_SCOPE: "system",
    });
    expect(config.daemon?.unit).toBe("example.service");
    expect(config.daemon?.scope).toBe("system");
  });
});

describe("loadRecoveryConfigFromEnv — fleet requires BOTH processMatch and expectedFlags, no default for either", () => {
  test("processMatch alone leaves the fleet check unconfigured", () => {
    const config = loadRecoveryConfigFromEnv({ WYZR_WEDGE_SSH_HOST: "example-host", WYZR_RECOVERY_FLEET_PROCESS_MATCH: "claude" });
    expect(config.fleet).toBeUndefined();
  });

  test("expectedFlags alone leaves the fleet check unconfigured", () => {
    const config = loadRecoveryConfigFromEnv({
      WYZR_WEDGE_SSH_HOST: "example-host",
      WYZR_RECOVERY_FLEET_EXPECTED_FLAGS: "--mcp-config",
    });
    expect(config.fleet).toBeUndefined();
  });

  test("expectedFlags parses a comma-separated list, trimming whitespace", () => {
    const config = loadRecoveryConfigFromEnv({
      WYZR_WEDGE_SSH_HOST: "example-host",
      WYZR_RECOVERY_FLEET_PROCESS_MATCH: "claude",
      WYZR_RECOVERY_FLEET_EXPECTED_FLAGS: " --mcp-config , --permission-mode ",
    });
    expect(config.fleet?.expectedFlags).toEqual(["--mcp-config", "--permission-mode"]);
  });

  test("an empty expectedFlags string leaves the fleet check unconfigured", () => {
    const config = loadRecoveryConfigFromEnv({
      WYZR_WEDGE_SSH_HOST: "example-host",
      WYZR_RECOVERY_FLEET_PROCESS_MATCH: "claude",
      WYZR_RECOVERY_FLEET_EXPECTED_FLAGS: "",
    });
    expect(config.fleet).toBeUndefined();
  });
});
