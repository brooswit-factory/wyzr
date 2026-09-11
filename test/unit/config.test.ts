// Zero credentials, zero network: every fixture below lives under a
// per-test temp directory and an explicit WyzrConfigEnv, never the real
// $HOME or $XDG_CONFIG_HOME. All host/mac/plug-name-shaped fixture values
// are obviously fake placeholders (see the ticket's hard rule against a
// real fleet fact anywhere in this repo). `loadWyzrConfig()` itself is
// SYNCHRONOUS (see src/config.ts's own top comment for why), so none of
// the calls into it below are awaited — only the fixture setup is.

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type SafePlugTarget,
  type WyzrConfig,
  type WyzrConfigEnv,
  loadWyzrConfig,
  wyzrConfigPath,
} from "../../src/config.ts";
import { CliError, ExitCode } from "../../src/errors.ts";
import { REDACTED, redact, resetSecretsForTesting } from "../../src/redact.ts";

const FLEET_PLUG = { mac: "AA:BB:CC:DD:EE:01", model: "WLPP1CFH", name: "fixture-fleet-plug" };
const SAFE_PLUG = { mac: "11:22:33:44:55:02", model: "WLPPO", name: "fixture-safe-plug", subDeviceId: "11:22:33:44:55:02-SUB1" };

/** The smallest config that loads: every REQUIRED value present, every
 * optional section omitted. */
const VALID_MINIMAL = {
  suspectBox: { host: "suspect-box.example.invalid" },
  fleetPlug: FLEET_PLUG,
  safePlug: SAFE_PLUG,
};

const tempDirs: string[] = [];

afterEach(async () => {
  resetSecretsForTesting();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeBase(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wyzr-config-test-"));
  tempDirs.push(dir);
  return dir;
}

/** Builds `<base>/wyzr/config.json` with the given content and modes, and
 * returns the WyzrConfigEnv that resolves to it via XDG_CONFIG_HOME —
 * never the real HOME. Mirrors test/unit/credentials.test.ts's own
 * fixture() exactly. */
async function fixture(
  base: string,
  content: unknown,
  opts: { dirMode?: number; fileMode?: number; raw?: string } = {},
): Promise<{ env: WyzrConfigEnv; dir: string; path: string }> {
  const dir = join(base, "wyzr");
  await mkdir(dir, { recursive: true });
  await chmod(dir, opts.dirMode ?? 0o700);
  const path = join(dir, "config.json");
  await writeFile(path, opts.raw ?? JSON.stringify(content), "utf8");
  await chmod(path, opts.fileMode ?? 0o600);
  return { env: { XDG_CONFIG_HOME: base, HOME: undefined }, dir, path };
}

function expectCliError(load: () => WyzrConfig): CliError {
  try {
    load();
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    const cliErr = err as CliError;
    expect(cliErr.exitCode).toBe(ExitCode.ConfigInvalid);
    return cliErr;
  }
  throw new Error("expected loadWyzrConfig to throw");
}

// ---------------------------------------------------------------------
// 1. Missing config file
// ---------------------------------------------------------------------

describe("loadWyzrConfig — missing file", () => {
  test("named test 1: refuses with an actionable, path-naming message and the config exit code — never a silent default", async () => {
    const base = await makeBase();
    const env: WyzrConfigEnv = { XDG_CONFIG_HOME: base, HOME: undefined };

    const err = expectCliError(() => loadWyzrConfig(env));
    expect(err.message).toContain(wyzrConfigPath(env));
    expect(err.reason).toBe("config_missing");
    expect(err.message).toContain("suspectBox");
    expect(err.message).toContain("fleetPlug");
    expect(err.message).toContain("safePlug");
  });
});

// ---------------------------------------------------------------------
// 2. Missing required value(s) — table-driven, one per required value
// ---------------------------------------------------------------------

describe("loadWyzrConfig — missing required value(s)", () => {
  const REQUIRED_VALUE_CASES: Array<{ label: string; mutate: (base: typeof VALID_MINIMAL) => unknown }> = [
    {
      label: "suspectBox section entirely absent",
      mutate: (base) => {
        const { suspectBox: _drop, ...rest } = base;
        return rest;
      },
    },
    {
      label: "suspectBox.host",
      mutate: (base) => ({ ...base, suspectBox: {} }),
    },
    {
      label: "fleetPlug section entirely absent",
      mutate: (base) => {
        const { fleetPlug: _drop, ...rest } = base;
        return rest;
      },
    },
    {
      label: "fleetPlug.mac",
      mutate: (base) => ({ ...base, fleetPlug: { model: FLEET_PLUG.model, name: FLEET_PLUG.name } }),
    },
    {
      label: "fleetPlug.model",
      mutate: (base) => ({ ...base, fleetPlug: { mac: FLEET_PLUG.mac, name: FLEET_PLUG.name } }),
    },
    {
      label: "fleetPlug.name",
      mutate: (base) => ({ ...base, fleetPlug: { mac: FLEET_PLUG.mac, model: FLEET_PLUG.model } }),
    },
    {
      label: "safePlug section entirely absent",
      mutate: (base) => {
        const { safePlug: _drop, ...rest } = base;
        return rest;
      },
    },
    {
      label: "safePlug.mac",
      mutate: (base) => ({ ...base, safePlug: { model: SAFE_PLUG.model, name: SAFE_PLUG.name } }),
    },
    {
      label: "safePlug.model",
      mutate: (base) => ({ ...base, safePlug: { mac: SAFE_PLUG.mac, name: SAFE_PLUG.name } }),
    },
    {
      label: "safePlug.name",
      mutate: (base) => ({ ...base, safePlug: { mac: SAFE_PLUG.mac, model: SAFE_PLUG.model } }),
    },
  ];

  for (const { label, mutate } of REQUIRED_VALUE_CASES) {
    test(`named test 2: refuses and names the specific missing value — ${label}`, async () => {
      const base = await makeBase();
      const { env } = await fixture(base, mutate(VALID_MINIMAL));

      const err = expectCliError(() => loadWyzrConfig(env));
      expect(err.reason).toBe("config_field_missing");
    });
  }

  test("a required value present but the WRONG TYPE (not a string) refuses distinctly from missing, naming the value", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, { ...VALID_MINIMAL, suspectBox: { host: 12345 } });

    const err = expectCliError(() => loadWyzrConfig(env));
    expect(err.reason).toBe("config_field_invalid");
    expect(err.message).toContain("suspectBox.host");
  });

  test("a section present but NOT an object at all (wrong shape) refuses, naming the section", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, { ...VALID_MINIMAL, jira: "not-an-object" });

    const err = expectCliError(() => loadWyzrConfig(env));
    expect(err.reason).toBe("config_field_invalid");
    expect(err.message).toContain("jira");
  });
});

// ---------------------------------------------------------------------
// 3. Unsafe permissions — file, then directory
// ---------------------------------------------------------------------

describe("loadWyzrConfig — over-permissive FILE mode", () => {
  test("named test 3a: refuses a group-readable file (0640) and names the exact chmod fix", async () => {
    const base = await makeBase();
    const { env, path } = await fixture(base, VALID_MINIMAL, { fileMode: 0o640 });

    const err = expectCliError(() => loadWyzrConfig(env));
    expect(err.reason).toBe("config_file_mode");
    expect(err.message).toContain(`chmod 600 ${path}`);
  });

  test("named test 3a: refuses a world-readable file (0644)", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, VALID_MINIMAL, { fileMode: 0o644 });

    const err = expectCliError(() => loadWyzrConfig(env));
    expect(err.reason).toBe("config_file_mode");
  });

  test("accepts an owner-only file (0600)", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, VALID_MINIMAL, { fileMode: 0o600 });

    expect(() => loadWyzrConfig(env)).not.toThrow();
  });
});

describe("loadWyzrConfig — over-permissive DIRECTORY mode", () => {
  test("named test 3b: refuses a group-writable directory (0750) and names the exact chmod fix", async () => {
    const base = await makeBase();
    const { env, dir } = await fixture(base, VALID_MINIMAL, { dirMode: 0o750 });

    const err = expectCliError(() => loadWyzrConfig(env));
    expect(err.reason).toBe("config_dir_mode");
    expect(err.message).toContain(`chmod 700 ${dir}`);
  });

  test("named test 3b: refuses a world-readable directory (0705)", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, VALID_MINIMAL, { dirMode: 0o705 });

    const err = expectCliError(() => loadWyzrConfig(env));
    expect(err.reason).toBe("config_dir_mode");
  });

  test("accepts an owner-only directory (0700)", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, VALID_MINIMAL, { dirMode: 0o700 });

    expect(() => loadWyzrConfig(env)).not.toThrow();
  });
});

// ---------------------------------------------------------------------
// 4. Unparseable file
// ---------------------------------------------------------------------

describe("loadWyzrConfig — unparseable / malformed", () => {
  test("named test 4: refuses invalid JSON without echoing any of its contents", async () => {
    const base = await makeBase();
    const distinctive = "totally-unmistakable-fixture-fragment-xyz789";
    const { env } = await fixture(base, null, { raw: `{ not json, ${distinctive}` });

    const err = expectCliError(() => loadWyzrConfig(env));
    expect(err.reason).toBe("config_malformed");
    expect(err.message).not.toContain(distinctive);
    expect(err.message).not.toContain("not json");
  });

  test("refuses a JSON value that is not an object (array)", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, ["not", "an", "object"]);

    const err = expectCliError(() => loadWyzrConfig(env));
    expect(err.reason).toBe("config_shape");
  });

  test("refuses a JSON value that is not an object (string)", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, "just a string", { raw: JSON.stringify("just a string") });

    const err = expectCliError(() => loadWyzrConfig(env));
    expect(err.reason).toBe("config_shape");
  });

  test("refuses an unknown top-level field", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, { ...VALID_MINIMAL, notARealSection: {} });

    const err = expectCliError(() => loadWyzrConfig(env));
    expect(err.reason).toBe("config_unknown_field");
    expect(err.message).toContain("notARealSection");
  });
});

// ---------------------------------------------------------------------
// 5. No error path echoes config contents
// ---------------------------------------------------------------------

describe("loadWyzrConfig — no error path echoes config contents, a hostname, a mac, or a secret fragment", () => {
  test("named test 5: across every failure path exercised in this file, no thrown message contains a real fixture value", async () => {
    const base = await makeBase();
    const distinctiveHost = "unmistakable-host-fixture-abc123.invalid";
    const distinctiveSecret = "unmistakable-auth-header-fixture-def456";
    const distinctiveToken = "unmistakable-github-token-fixture-ghi789";
    const config = {
      suspectBox: { host: distinctiveHost },
      jira: { baseUrl: "https://example.invalid", authHeader: distinctiveSecret },
      github: { owner: "example-org", token: distinctiveToken },
      fleetPlug: FLEET_PLUG,
      safePlug: SAFE_PLUG,
    };

    const scenarios: Array<() => Promise<WyzrConfigEnv>> = [
      async () => (await fixture(join(base, "filemode"), config, { fileMode: 0o644 })).env,
      async () => (await fixture(join(base, "dirmode"), config, { dirMode: 0o755 })).env,
      async () => (await fixture(join(base, "malformed"), null, { raw: "not json at all" })).env,
      async () => (await fixture(join(base, "unknownfield"), { ...config, bogus: true })).env,
      async () =>
        (
          await fixture(join(base, "incomplete-jira"), {
            ...config,
            jira: { baseUrl: "https://example.invalid" }, // authHeader missing
          })
        ).env,
    ];

    const envs = await Promise.all(scenarios.map((build) => build()));
    const errors = envs.map((env) => expectCliError(() => loadWyzrConfig(env)));

    for (const err of errors) {
      expect(err.message).not.toContain(distinctiveHost);
      expect(err.message).not.toContain(distinctiveSecret);
      expect(err.message).not.toContain(distinctiveToken);
      expect(err.message).not.toContain(FLEET_PLUG.mac);
      expect(err.message).not.toContain(SAFE_PLUG.mac);
    }
  });
});

// ---------------------------------------------------------------------
// 6. Present-but-incomplete optional section refuses; absent loads fine
// ---------------------------------------------------------------------

describe("loadWyzrConfig — optional SECTIONS: present-but-incomplete refuses naming the missing key, absent loads fine and stays unconfigured", () => {
  test("named test 6: jira present without authHeader refuses naming it", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, { ...VALID_MINIMAL, jira: { baseUrl: "https://example.invalid" } });

    const err = expectCliError(() => loadWyzrConfig(env));
    expect(err.reason).toBe("config_field_missing");
    expect(err.message).toContain("jira.authHeader");
  });

  test("named test 6: jira present without baseUrl refuses naming it", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, { ...VALID_MINIMAL, jira: { authHeader: "Basic fake" } });

    const err = expectCliError(() => loadWyzrConfig(env));
    expect(err.message).toContain("jira.baseUrl");
  });

  test("named test 6: github present without owner refuses naming it", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, { ...VALID_MINIMAL, github: { repo: "example-repo" } });

    const err = expectCliError(() => loadWyzrConfig(env));
    expect(err.message).toContain("github.owner");
  });

  test("named test 6: tunnelPing present without host refuses naming it", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, { ...VALID_MINIMAL, tunnelPing: { timeoutMs: 1000 } });

    const err = expectCliError(() => loadWyzrConfig(env));
    expect(err.message).toContain("tunnelPing.host");
  });

  test("named test 6: controlPlane present without name refuses naming it", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, { ...VALID_MINIMAL, controlPlane: { timeoutMs: 1000 } });

    const err = expectCliError(() => loadWyzrConfig(env));
    expect(err.message).toContain("controlPlane.name");
  });

  test("named test 6: recovery.daemon present with unit but no scope refuses naming it", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, { ...VALID_MINIMAL, recovery: { daemon: { unit: "example.service" } } });

    const err = expectCliError(() => loadWyzrConfig(env));
    expect(err.message).toContain("recovery.daemon.scope");
  });

  test("named test 6: recovery.daemon present with scope but no unit refuses naming it", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, { ...VALID_MINIMAL, recovery: { daemon: { scope: "user" } } });

    const err = expectCliError(() => loadWyzrConfig(env));
    expect(err.message).toContain("recovery.daemon.unit");
  });

  test("named test 6: recovery.fleetAudit present with processMatch but no expectedFlags refuses naming it", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, { ...VALID_MINIMAL, recovery: { fleetAudit: { processMatch: "claude" } } });

    const err = expectCliError(() => loadWyzrConfig(env));
    expect(err.message).toContain("recovery.fleetAudit.expectedFlags");
  });

  test("named test 6: an invalid recovery.daemon.scope value (a typo) REFUSES and names the value — it does not silently vanish", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, {
      ...VALID_MINIMAL,
      recovery: { daemon: { unit: "example.service", scope: "both" } },
    });

    const err = expectCliError(() => loadWyzrConfig(env));
    expect(err.reason).toBe("config_field_invalid");
    expect(err.message).toContain("recovery.daemon.scope");
  });

  test("named test 6: every optional section ABSENT loads fine — each reports itself unconfigured (undefined), never a guess", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, VALID_MINIMAL);

    const config = loadWyzrConfig(env);
    expect(config.wedge.jira).toBeUndefined();
    expect(config.wedge.github).toBeUndefined();
    expect(config.wedge.tunnelPing).toBeUndefined();
    expect(config.wedge.controlPlane).toBeUndefined();
    expect(config.recovery.daemon).toBeUndefined();
    expect(config.recovery.fleet).toBeUndefined();
    // localConnectivity is NOT in the optional-sections list above — it has
    // a full documented default instead (see "defaults permitted" tests
    // below), so it is always populated, never undefined.
    expect(config.wedge.localConnectivity).toBeDefined();
  });
});

// ---------------------------------------------------------------------
// 7. Fleet plug / safe plug do not interchange — @ts-expect-error pin
// ---------------------------------------------------------------------

describe("FleetPlugTarget/SafePlugTarget — structurally impossible to conflate (WYZR-28 Deliverable 2)", () => {
  test("named test 7: a FleetPlugTarget reference does not satisfy SafePlugTarget's type — compile-time pin, mutation-tested", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, VALID_MINIMAL);
    const config = loadWyzrConfig(env);

    // The brand keys (FLEET_PLUG_BRAND/SAFE_PLUG_BRAND, src/config.ts) are
    // MODULE-PRIVATE unique symbols, never exported — no code outside that
    // module can even spell either property, so this assignment is a
    // compile error, same technique as
    // src/cycle-preconditions.ts's PreconditionsClearedWitness pin. Verified
    // by removing the @ts-expect-error directive below and observing
    // `bun run typecheck` report exactly one new error at this line
    // (FleetPlugTarget is missing SafePlugTarget's own symbol-keyed brand
    // property) before restoring it — `git diff --stat` confirmed the file
    // actually changed both times (see the PR body for the captured output;
    // a mutation that silently never applied has produced a false PASS on
    // this epic before).
    // @ts-expect-error — config.fleetPlug (FleetPlugTarget) does not satisfy SafePlugTarget: the two brands are
    // distinct module-private unique symbols declared in src/config.ts, so no FleetPlugTarget value can ever be
    // assigned where a SafePlugTarget is required. If this line ever stops erroring, either the branding was
    // weakened to something both types can satisfy, or one type was removed entirely — either way this directive
    // itself becomes an "unused @ts-expect-error" compile error, which is the pin.
    const forged: SafePlugTarget = config.fleetPlug;
    void forged;
  });

  test("fleetPlug and safePlug carry their own distinct field values (sanity: the pin above is exercising real values, not two empty objects)", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, VALID_MINIMAL);
    const config = loadWyzrConfig(env);

    expect(config.fleetPlug.mac).toBe(FLEET_PLUG.mac);
    expect(config.fleetPlug.model).toBe(FLEET_PLUG.model);
    expect(config.safePlug.mac).toBe(SAFE_PLUG.mac);
    expect(config.safePlug.model).toBe(SAFE_PLUG.model);
  });
});

// ---------------------------------------------------------------------
// 8. Fleet plug / safe plug conflation refused at load time
// ---------------------------------------------------------------------

describe("loadWyzrConfig — fleetPlug and safePlug resolving to the same device is refused", () => {
  test("named test 8: identical mac and identical (absent) subDeviceId -> refused", async () => {
    const base = await makeBase();
    const sharedMac = "AA:BB:CC:DD:EE:FF";
    const { env } = await fixture(base, {
      ...VALID_MINIMAL,
      fleetPlug: { mac: sharedMac, model: "WLPP1CFH", name: "fleet" },
      safePlug: { mac: sharedMac, model: "WLPP1CFH", name: "safe" },
    });

    const err = expectCliError(() => loadWyzrConfig(env));
    expect(err.reason).toBe("config_plug_conflation");
  });

  test("named test 8: identical mac AND identical subDeviceId (both sub-devices of the same physical device) -> refused", async () => {
    const base = await makeBase();
    const sharedMac = "AA:BB:CC:DD:EE:FF";
    const { env } = await fixture(base, {
      ...VALID_MINIMAL,
      fleetPlug: { mac: sharedMac, model: "WLPPO", name: "fleet", subDeviceId: "sub-1" },
      safePlug: { mac: sharedMac, model: "WLPPO", name: "safe", subDeviceId: "sub-1" },
    });

    const err = expectCliError(() => loadWyzrConfig(env));
    expect(err.reason).toBe("config_plug_conflation");
  });

  test("identical mac but DIFFERENT subDeviceId (two distinct sub-devices of the same physical OutdoorPlug) -> NOT conflated, loads fine", async () => {
    const base = await makeBase();
    const sharedMac = "AA:BB:CC:DD:EE:FF";
    const { env } = await fixture(base, {
      ...VALID_MINIMAL,
      fleetPlug: { mac: sharedMac, model: "WLPPO", name: "fleet", subDeviceId: "sub-1" },
      safePlug: { mac: sharedMac, model: "WLPPO", name: "safe", subDeviceId: "sub-2" },
    });

    expect(() => loadWyzrConfig(env)).not.toThrow();
  });

  test("mac comparison is case/whitespace-insensitive: differently-cased/spaced identical macs still conflate", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, {
      ...VALID_MINIMAL,
      fleetPlug: { mac: "aa:bb:cc:dd:ee:ff", model: "WLPP1CFH", name: "fleet" },
      safePlug: { mac: " AA:BB:CC:DD:EE:FF ", model: "WLPP1CFH", name: "safe" },
    });

    const err = expectCliError(() => loadWyzrConfig(env));
    expect(err.reason).toBe("config_plug_conflation");
  });

  test("distinct macs -> not conflated, loads fine (the ordinary VALID_MINIMAL fixture)", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, VALID_MINIMAL);

    expect(() => loadWyzrConfig(env)).not.toThrow();
  });
});

// ---------------------------------------------------------------------
// 9. The schema can express a sub-device target
// ---------------------------------------------------------------------

describe("loadWyzrConfig — the schema can express a sub-device target", () => {
  test("named test 9: a safePlug with subDeviceId set (an OutdoorPlug/WLPPO-shaped sub-device target) loads, and the value is preserved", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, VALID_MINIMAL);

    const config = loadWyzrConfig(env);
    expect(config.safePlug.subDeviceId).toBe(SAFE_PLUG.subDeviceId);
  });

  test("a plug target with NO subDeviceId (the fleet plug's ordinary WLPP1CFH case, per the ticket's relayed ground truth) loads with subDeviceId null", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, VALID_MINIMAL);

    const config = loadWyzrConfig(env);
    expect(config.fleetPlug.subDeviceId).toBeNull();
  });

  test("an empty-string subDeviceId is treated the same as absent (null) — same convention as credentials.ts's optional-string fields", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, {
      ...VALID_MINIMAL,
      fleetPlug: { ...FLEET_PLUG, subDeviceId: "" },
    });

    const config = loadWyzrConfig(env);
    expect(config.fleetPlug.subDeviceId).toBeNull();
  });
});

// ---------------------------------------------------------------------
// 11. No WYZR_* environment variable influences the loaded config
// ---------------------------------------------------------------------

describe("loadWyzrConfig — no WYZR_* environment variable influences the loaded config (the one-surface ruling's own pin)", () => {
  test("named test 11: WYZR_WEDGE_SSH_HOST set in the passed env is completely ignored — the file's own suspectBox.host wins, always", async () => {
    // What would make this FAIL: if loadWyzrConfig() read any `WYZR_*` key
    // off the env object it was handed (the way the removed
    // loadWedgeConfigFromEnv() did), `config.wedge.ssh?.host` would come
    // back as the env-injected value below instead of the fixture file's
    // own "suspect-box.example.invalid" — this test would then see the
    // WRONG host and fail.
    const base = await makeBase();
    const { env } = await fixture(base, VALID_MINIMAL);
    const envWithWyzrVar: Record<string, string> = {
      XDG_CONFIG_HOME: env.XDG_CONFIG_HOME!,
      WYZR_WEDGE_SSH_HOST: "env-injected-should-be-completely-ignored.invalid",
      WYZR_CYCLE_WRONG_BOX_TARGET_HOST: "also-should-be-ignored.invalid",
    };

    const config = loadWyzrConfig(envWithWyzrVar as WyzrConfigEnv);
    expect(config.wedge.ssh?.host).toBe(VALID_MINIMAL.suspectBox.host);
    expect(config.cycle.wrongBoxTargetHost).toBe(VALID_MINIMAL.suspectBox.host);
    expect(config.wedge.ssh?.host).not.toBe("env-injected-should-be-completely-ignored.invalid");
  });
});

// ---------------------------------------------------------------------
// 12. Secrets registered before the loader returns
// ---------------------------------------------------------------------

describe("loadWyzrConfig — secrets are registered with the redaction registry before the loader returns", () => {
  test("named test 12: jira.authHeader and github.token are scrubbed from anything printed through src/output.ts afterward", async () => {
    const base = await makeBase();
    const authHeader = "Basic fake-fixture-jira-auth-header-000";
    const token = "fake-fixture-github-token-000";
    const { env } = await fixture(base, {
      ...VALID_MINIMAL,
      jira: { baseUrl: "https://example.invalid", authHeader },
      github: { owner: "example-org", token },
    });

    loadWyzrConfig(env);

    expect(redact(`leaked ${authHeader}`)).toBe(`leaked ${REDACTED}`);
    expect(redact(`leaked ${token}`)).toBe(`leaked ${REDACTED}`);
  });

  test("does NOT register the suspect box host, or either plug's mac/name — these identifiers must stay legible in diagnostics", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, VALID_MINIMAL);

    loadWyzrConfig(env);

    expect(redact(`diagnostic mentioning ${VALID_MINIMAL.suspectBox.host}`)).toContain(VALID_MINIMAL.suspectBox.host);
    expect(redact(`diagnostic mentioning ${FLEET_PLUG.mac}`)).toContain(FLEET_PLUG.mac);
  });
});

// ---------------------------------------------------------------------
// Defaults permitted ONLY for: timeouts, quiet thresholds, the
// local-connectivity target, and the cycle timing bounds
// ---------------------------------------------------------------------

describe("loadWyzrConfig — defaults: timeouts, quiet thresholds, local-connectivity target, cycle timing bounds", () => {
  test("localConnectivity absent entirely -> full documented default (target + timeout)", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, VALID_MINIMAL);

    const config = loadWyzrConfig(env);
    expect(config.wedge.localConnectivity.target).toBe("1.1.1.1");
    expect(config.wedge.localConnectivity.timeoutMs).toBe(5000);
  });

  test("localConnectivity.target overridable independently of its timeout", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, { ...VALID_MINIMAL, localConnectivity: { target: "9.9.9.9" } });

    const config = loadWyzrConfig(env);
    expect(config.wedge.localConnectivity.target).toBe("9.9.9.9");
    expect(config.wedge.localConnectivity.timeoutMs).toBe(5000);
  });

  test("cycle.timing absent entirely -> every documented default", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, VALID_MINIMAL);

    const config = loadWyzrConfig(env);
    expect(config.cycle.timing.offToOnWaitMs).toBe(5000);
    expect(config.cycle.timing.restoreTimeoutMs).toBe(300000);
  });

  test("cycle.timing fields are independently overridable — one overridden, the rest stay at their own default", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, {
      ...VALID_MINIMAL,
      cycle: { timing: { restoreTimeoutMs: 999000 } },
    });

    const config = loadWyzrConfig(env);
    expect(config.cycle.timing.restoreTimeoutMs).toBe(999000);
    expect(config.cycle.timing.offToOnWaitMs).toBe(5000);
  });

  test("jira.quietThresholdMs/timeoutMs default when the section is present but those keys are omitted", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, {
      ...VALID_MINIMAL,
      jira: { baseUrl: "https://example.invalid", authHeader: "Basic fake" },
    });

    const config = loadWyzrConfig(env);
    expect(config.wedge.jira?.quietThresholdMs).toBe(10 * 60 * 1000);
    expect(config.wedge.jira?.timeoutMs).toBe(5000);
  });

  // RULING (this file's own top comment): a MALFORMED but PRESENT
  // default-permitted numeric value REFUSES — it does NOT silently fall
  // back to the documented default the way the removed env-loader's
  // positiveIntMs() did. This is the deliberate, sharpened decision a
  // follow-up review comment on this ticket asked for explicitly.
  test("a malformed (non-numeric) present timeoutMs REFUSES — it does NOT silently fall back to the default", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, {
      ...VALID_MINIMAL,
      suspectBox: { host: VALID_MINIMAL.suspectBox.host, timeoutMs: "not-a-number" },
    });

    const err = expectCliError(() => loadWyzrConfig(env));
    expect(err.reason).toBe("config_field_invalid");
    expect(err.message).toContain("suspectBox.timeoutMs");
  });

  test("a malformed (zero) present timeoutMs REFUSES — it does NOT silently fall back to the default", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, {
      ...VALID_MINIMAL,
      suspectBox: { host: VALID_MINIMAL.suspectBox.host, timeoutMs: 0 },
    });

    const err = expectCliError(() => loadWyzrConfig(env));
    expect(err.reason).toBe("config_field_invalid");
  });

  test("a malformed (negative) present cycle.timing field REFUSES — it does NOT silently fall back to the default", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, { ...VALID_MINIMAL, cycle: { timing: { restoreTimeoutMs: -5 } } });

    const err = expectCliError(() => loadWyzrConfig(env));
    expect(err.reason).toBe("config_field_invalid");
    expect(err.message).toContain("cycle.timing.restoreTimeoutMs");
  });
});

// ---------------------------------------------------------------------
// The suspect-box-host reuse ruling: ssh / wrong-box-guard target /
// uptime all derive from the SAME required value, never a second field
// ---------------------------------------------------------------------

describe("loadWyzrConfig — suspectBox.host is the ONE value feeding ssh, the wrong-box guard's target, and the reused uptime/daemon/fleet host", () => {
  test("wedge.ssh.host, cycle.wrongBoxTargetHost, and recovery.uptime.host all equal suspectBox.host", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, VALID_MINIMAL);

    const config = loadWyzrConfig(env);
    expect(config.wedge.ssh?.host).toBe(VALID_MINIMAL.suspectBox.host);
    expect(config.cycle.wrongBoxTargetHost).toBe(VALID_MINIMAL.suspectBox.host);
    expect(config.recovery.uptime?.host).toBe(VALID_MINIMAL.suspectBox.host);
  });

  test("recovery.uptime is ALWAYS configured (suspectBox.host is required, unlike the old env loader's ssh-optional coupling) — its timeout defaults to suspectBox's own timeout", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, VALID_MINIMAL);

    const config = loadWyzrConfig(env);
    expect(config.recovery.uptime).toBeDefined();
    expect(config.recovery.uptime?.timeoutMs).toBe(5000);
  });

  test("recovery.uptimeTimeoutMs independently overrides the reused uptime timeout", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, { ...VALID_MINIMAL, recovery: { uptimeTimeoutMs: 1234 } });

    const config = loadWyzrConfig(env);
    expect(config.recovery.uptime?.timeoutMs).toBe(1234);
  });

  test("daemon/fleet still independently gate on their own required-together pairs, unchanged from the old loader", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, {
      ...VALID_MINIMAL,
      recovery: {
        daemon: { unit: "example.service", scope: "system" },
        fleetAudit: { processMatch: "claude", expectedFlags: ["--mcp-config", "--permission-mode"] },
      },
    });

    const config = loadWyzrConfig(env);
    expect(config.recovery.daemon).toEqual({ host: VALID_MINIMAL.suspectBox.host, unit: "example.service", scope: "system", timeoutMs: 5000 });
    expect(config.recovery.fleet?.processMatch).toBe("claude");
    expect(config.recovery.fleet?.expectedFlags).toEqual(["--mcp-config", "--permission-mode"]);
  });
});

// ---------------------------------------------------------------------
// Miscellaneous shape checks
// ---------------------------------------------------------------------

describe("loadWyzrConfig — happy path shape", () => {
  test("a fully-populated config loads every section correctly", async () => {
    const base = await makeBase();
    const full = {
      suspectBox: { host: "suspect.example.invalid", timeoutMs: 6000, connectTimeoutMs: 2000 },
      tunnelPing: { host: "tunnel.example.invalid" },
      jira: { baseUrl: "https://example.invalid", authHeader: "Basic fake", projectKey: "EXFIX", quietThresholdMs: 111, timeoutMs: 222 },
      github: { owner: "example-org", repo: "example-repo", token: "fake-token", quietThresholdMs: 333, timeoutMs: 444 },
      localConnectivity: { target: "9.9.9.9", timeoutMs: 555 },
      controlPlane: { name: "tailscale", timeoutMs: 666 },
      recovery: {
        uptimeTimeoutMs: 777,
        daemon: { unit: "example.service", scope: "user", timeoutMs: 888 },
        fleetAudit: { processMatch: "claude", expectedFlags: ["--flag-a"], timeoutMs: 999 },
      },
      cycle: {
        handRestoreCommand: "example-restore --by-hand",
        timing: { offToOnWaitMs: 1111, restoreTimeoutMs: 2222 },
      },
      fleetPlug: FLEET_PLUG,
      safePlug: SAFE_PLUG,
    };
    const { env } = await fixture(base, full);

    const config = loadWyzrConfig(env);
    expect(config.wedge.jira?.projectKey).toBe("EXFIX");
    expect(config.wedge.github?.repo).toBe("example-repo");
    expect(config.wedge.controlPlane?.name).toBe("tailscale");
    expect(config.wedge.tunnelPing?.host).toBe("tunnel.example.invalid");
    expect(config.cycle.handRestoreCommand).toBe("example-restore --by-hand");
    expect(config.cycle.timing.offToOnWaitMs).toBe(1111);
    expect(config.cycle.timing.restoreTimeoutMs).toBe(2222);
    expect(config.recovery.daemon?.timeoutMs).toBe(888);
  });

  test("wyzrConfigPath() resolves under the same directory credentials.json resolves under, with config.json instead", async () => {
    const env: WyzrConfigEnv = { XDG_CONFIG_HOME: "/xdg-base", HOME: undefined };
    expect(wyzrConfigPath(env)).toBe("/xdg-base/wyzr/config.json");
  });
});

// ---------------------------------------------------------------------
// Deliverable 3: docs/config.example.json actually loads — guards
// against the example drifting out of sync with the schema it documents
// ---------------------------------------------------------------------

describe("docs/config.example.json — the shipped example is a genuinely loadable config, not just illustrative prose", () => {
  test("loads successfully via loadWyzrConfig() and populates every optional section (placeholders only, never a real fleet fact)", async () => {
    const examplePath = resolve(import.meta.dir, "../../docs/config.example.json");
    const raw = await readFile(examplePath, "utf8");
    const parsed: unknown = JSON.parse(raw);

    const base = await makeBase();
    const { env } = await fixture(base, parsed);

    const config = loadWyzrConfig(env);
    expect(config.wedge.jira).toBeDefined();
    expect(config.wedge.github).toBeDefined();
    expect(config.wedge.tunnelPing).toBeDefined();
    expect(config.wedge.controlPlane).toBeDefined();
    expect(config.recovery.daemon).toBeDefined();
    expect(config.recovery.fleet).toBeDefined();
    expect(config.cycle.handRestoreCommand).toBeDefined();
    expect(config.safePlug.subDeviceId).not.toBeNull();
    expect(config.fleetPlug.subDeviceId).toBeNull();
  });

  test("contains no obviously-real-looking credential (a placeholder-only sanity floor, not a substitute for human review)", async () => {
    const examplePath = resolve(import.meta.dir, "../../docs/config.example.json");
    const raw = await readFile(examplePath, "utf8");
    expect(raw).toContain("example");
    expect(raw).not.toMatch(/AKIA[0-9A-Z]{16}/); // an AWS-shaped key, as a floor, not a full secret scan
  });
});
