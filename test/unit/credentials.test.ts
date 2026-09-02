// Zero credentials, zero network: every fixture below lives under a
// per-test temp directory and an explicit CredentialsEnv, never the real
// $HOME or $XDG_CONFIG_HOME. All secret-shaped fixture values are
// obviously fake (see the ticket's hard rule against anything
// credential-shaped).

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Credentials,
  type CredentialsEnv,
  credentialsDir,
  credentialsPath,
  loadCredentials,
} from "../../src/credentials.ts";
import { CliError, ExitCode } from "../../src/errors.ts";
import { REDACTED, redact, resetSecretsForTesting } from "../../src/redact.ts";

const FAKE = {
  email: "test-account@example.invalid",
  password: "fake-test-password-do-not-use-000",
  keyId: "fake-key-id-000",
  keySecret: "fake-key-secret-do-not-use-000",
  totpSecret: "FAKEBASE32TOTPSECRETNOTREAL000",
};

const tempDirs: string[] = [];

afterEach(async () => {
  resetSecretsForTesting();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeBase(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wyzr-credentials-test-"));
  tempDirs.push(dir);
  return dir;
}

/** Builds `<base>/wyzr/credentials.json` with the given content and modes,
 * and returns the CredentialsEnv that resolves to it via XDG_CONFIG_HOME —
 * never the real HOME. */
async function fixture(
  base: string,
  content: unknown,
  opts: { dirMode?: number; fileMode?: number; raw?: string } = {},
): Promise<{ env: CredentialsEnv; dir: string; path: string }> {
  const dir = join(base, "wyzr");
  await mkdir(dir, { recursive: true });
  await chmod(dir, opts.dirMode ?? 0o700);
  const path = join(dir, "credentials.json");
  await writeFile(path, opts.raw ?? JSON.stringify(content), "utf8");
  await chmod(path, opts.fileMode ?? 0o600);
  return { env: { XDG_CONFIG_HOME: base, HOME: undefined }, dir, path };
}

async function expectCliError(promise: Promise<Credentials>): Promise<CliError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    const cliErr = err as CliError;
    expect(cliErr.exitCode).toBe(ExitCode.CredentialsInvalid);
    return cliErr;
  }
  throw new Error("expected loadCredentials to throw");
}

describe("credentialsDir / credentialsPath", () => {
  test("uses $XDG_CONFIG_HOME/wyzr when XDG_CONFIG_HOME is set and non-empty", () => {
    const env: CredentialsEnv = { XDG_CONFIG_HOME: "/xdg-base", HOME: "/home/someone" };
    expect(credentialsDir(env)).toBe("/xdg-base/wyzr");
    expect(credentialsPath(env)).toBe("/xdg-base/wyzr/credentials.json");
  });

  test("falls back to $HOME/.config/wyzr when XDG_CONFIG_HOME is unset", () => {
    const env: CredentialsEnv = { HOME: "/home/someone" };
    expect(credentialsDir(env)).toBe("/home/someone/.config/wyzr");
  });

  test("falls back to $HOME/.config/wyzr when XDG_CONFIG_HOME is the empty string", () => {
    const env: CredentialsEnv = { XDG_CONFIG_HOME: "", HOME: "/home/someone" };
    expect(credentialsDir(env)).toBe("/home/someone/.config/wyzr");
  });

  test("throws a CredentialsInvalid CliError when neither is set", () => {
    expect(() => credentialsDir({})).toThrow(CliError);
    try {
      credentialsDir({});
    } catch (err) {
      expect((err as CliError).exitCode).toBe(ExitCode.CredentialsInvalid);
    }
  });
});

describe("loadCredentials — happy path", () => {
  test("loads all fields, including totpSecret, from a well-formed file", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, FAKE);

    const creds = await loadCredentials(env);
    expect(creds).toEqual(FAKE);
  });

  test("loads without totpSecret when the field is absent (no MFA on the account)", async () => {
    const base = await makeBase();
    const { totpSecret: _drop, ...withoutTotp } = FAKE;
    const { env } = await fixture(base, withoutTotp);

    const creds = await loadCredentials(env);
    expect(creds.totpSecret).toBeUndefined();
    expect(creds.email).toBe(FAKE.email);
  });

  test("treats an explicit null totpSecret the same as absent", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, { ...FAKE, totpSecret: null });

    const creds = await loadCredentials(env);
    expect(creds.totpSecret).toBeUndefined();
  });

  // A naive `totpSecret !== undefined` check downstream would read "" as
  // configured and misfire the MFA/TOTP path — see WYZR-11's ticket.
  test("treats an empty-string totpSecret the same as absent", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, { ...FAKE, totpSecret: "" });

    const creds = await loadCredentials(env);
    expect(creds.totpSecret).toBeUndefined();
  });

  test("registers password, keySecret and totpSecret for redaction before returning", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, FAKE);

    await loadCredentials(env);

    expect(redact(`leaked ${FAKE.password}`)).toBe(`leaked ${REDACTED}`);
    expect(redact(`leaked ${FAKE.keySecret}`)).toBe(`leaked ${REDACTED}`);
    expect(redact(`leaked ${FAKE.totpSecret}`)).toBe(`leaked ${REDACTED}`);
  });

  test("does NOT register email or keyId — they are identifiers, not secrets", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, FAKE);

    await loadCredentials(env);

    expect(redact(`account ${FAKE.email}`)).toBe(`account ${FAKE.email}`);
    expect(redact(`key ${FAKE.keyId}`)).toBe(`key ${FAKE.keyId}`);
  });
});

describe("loadCredentials — missing file", () => {
  test("refuses with an actionable, path-naming message and the credentials exit code", async () => {
    const base = await makeBase();
    const env: CredentialsEnv = { XDG_CONFIG_HOME: base, HOME: undefined };

    const err = await expectCliError(loadCredentials(env));
    expect(err.message).toContain(credentialsPath(env));
    expect(err.reason).toBe("credentials_missing");
  });
});

describe("loadCredentials — malformed JSON", () => {
  test("refuses invalid JSON", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, null, { raw: "{ not json" });

    const err = await expectCliError(loadCredentials(env));
    expect(err.reason).toBe("credentials_malformed");
  });

  test("refuses a JSON value that is not an object (array)", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, ["not", "an", "object"]);

    const err = await expectCliError(loadCredentials(env));
    expect(err.reason).toBe("credentials_shape");
  });

  test("refuses a JSON value that is not an object (string)", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, "just a string", { raw: JSON.stringify("just a string") });

    const err = await expectCliError(loadCredentials(env));
    expect(err.reason).toBe("credentials_shape");
  });
});

describe("loadCredentials — missing / mistyped fields", () => {
  for (const field of ["email", "password", "keyId", "keySecret"] as const) {
    test(`refuses when required field "${field}" is missing`, async () => {
      const base = await makeBase();
      const { [field]: _drop, ...rest } = FAKE;
      const { env } = await fixture(base, rest);

      const err = await expectCliError(loadCredentials(env));
      expect(err.reason).toBe("credentials_field_missing");
      expect(err.message).toContain(`"${field}"`);
    });

    test(`refuses when required field "${field}" has the wrong type`, async () => {
      const base = await makeBase();
      const { env } = await fixture(base, { ...FAKE, [field]: 12345 });

      const err = await expectCliError(loadCredentials(env));
      expect(err.reason).toBe("credentials_field_invalid");
      expect(err.message).toContain(`"${field}"`);
    });

    test(`refuses when required field "${field}" is an empty string`, async () => {
      const base = await makeBase();
      const { env } = await fixture(base, { ...FAKE, [field]: "" });

      const err = await expectCliError(loadCredentials(env));
      expect(err.reason).toBe("credentials_field_invalid");
    });
  }

  test("refuses when totpSecret is present but the wrong type", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, { ...FAKE, totpSecret: 42 });

    const err = await expectCliError(loadCredentials(env));
    expect(err.reason).toBe("credentials_field_invalid");
    expect(err.message).toContain(`"totpSecret"`);
  });

  test("refuses an unknown field — guards against e.g. the static app-identity key sneaking in here", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, { ...FAKE, apiKey: "should-not-be-here" });

    const err = await expectCliError(loadCredentials(env));
    expect(err.reason).toBe("credentials_unknown_field");
    expect(err.message).toContain("apiKey");
  });
});

describe("loadCredentials — over-permissive file mode", () => {
  test("refuses a group-readable file (0640) and names the exact chmod fix", async () => {
    const base = await makeBase();
    const { env, path } = await fixture(base, FAKE, { fileMode: 0o640 });

    const err = await expectCliError(loadCredentials(env));
    expect(err.reason).toBe("credentials_file_mode");
    expect(err.message).toContain(`chmod 600 ${path}`);
  });

  test("refuses a world-readable file (0644)", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, FAKE, { fileMode: 0o644 });

    const err = await expectCliError(loadCredentials(env));
    expect(err.reason).toBe("credentials_file_mode");
  });

  test("accepts an owner-only file (0600)", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, FAKE, { fileMode: 0o600 });

    await expect(loadCredentials(env)).resolves.toEqual(FAKE);
  });

  test("accepts an owner-only file with the execute bit set (0700) — only group/other bits gate refusal", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, FAKE, { fileMode: 0o700 });

    await expect(loadCredentials(env)).resolves.toEqual(FAKE);
  });

  test("the refusal never reads file content: none of the file's real secret values leak into the error", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, FAKE, { fileMode: 0o644 });

    const err = await expectCliError(loadCredentials(env));
    for (const secret of [FAKE.password, FAKE.keySecret, FAKE.totpSecret]) {
      expect(err.message).not.toContain(secret);
    }
  });
});

describe("loadCredentials — over-permissive directory mode", () => {
  test("refuses a group-writable directory (0750) and names the exact chmod fix", async () => {
    const base = await makeBase();
    const { env, dir } = await fixture(base, FAKE, { dirMode: 0o750 });

    const err = await expectCliError(loadCredentials(env));
    expect(err.reason).toBe("credentials_dir_mode");
    expect(err.message).toContain(`chmod 700 ${dir}`);
  });

  test("refuses a world-readable directory (0705)", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, FAKE, { dirMode: 0o705 });

    const err = await expectCliError(loadCredentials(env));
    expect(err.reason).toBe("credentials_dir_mode");
  });

  test("accepts an owner-only directory (0700)", async () => {
    const base = await makeBase();
    const { env } = await fixture(base, FAKE, { dirMode: 0o700 });

    await expect(loadCredentials(env)).resolves.toEqual(FAKE);
  });
});

describe("loadCredentials — no error message leaks any part of any secret", () => {
  test("across every failure path exercised above, no thrown message contains a real secret value", async () => {
    const base = await makeBase();
    const scenarios: Array<() => Promise<CredentialsEnv>> = [
      async () => (await fixture(base, FAKE, { fileMode: 0o644 })).env,
      async () => (await fixture(join(base, "dirmode"), FAKE, { dirMode: 0o755 })).env,
      async () => (await fixture(join(base, "badtype"), { ...FAKE, keySecret: 999 })).env,
      async () => (await fixture(join(base, "malformed"), null, { raw: "not json at all" })).env,
    ];

    const envs = await Promise.all(scenarios.map((build) => build()));
    const errors = await Promise.all(envs.map((env) => expectCliError(loadCredentials(env))));

    for (const err of errors) {
      for (const secret of [FAKE.password, FAKE.keySecret, FAKE.totpSecret]) {
        expect(err.message).not.toContain(secret);
      }
      // Also assert no length/prefix-shaped leak snuck in.
      expect(err.message).not.toMatch(/\d+\s*characters?/i);
    }
  });
});
