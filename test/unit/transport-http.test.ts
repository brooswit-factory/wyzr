// Every test here injects `fetchImpl` — NO network, ever. This is what
// proves RealWyzeTransport's request construction and response handling
// separately from (and in addition to) whatever the fake transport proves.

import { afterEach, describe, expect, test } from "bun:test";
import { REDACTED, redact, resetSecretsForTesting } from "../../src/redact.ts";
import { RealWyzeTransport, type FetchLike } from "../../src/transport-http.ts";
import { WYZE_API_HOST, WYZE_AUTH_HOST } from "../../src/transport.ts";
import {
  DEVICE_PHONE_ID,
  DEVICE_STANDARD_BODY_APP_NAME,
  DEVICE_STANDARD_BODY_APP_VER,
  DEVICE_STANDARD_BODY_APP_VERSION,
  DEVICE_STANDARD_BODY_PHONE_SYSTEM_TYPE,
  DEVICE_STANDARD_BODY_SC,
  DEVICE_STANDARD_BODY_SV,
} from "../../src/wyze-device-identity.ts";

const STANDARD_BODY_FIELDS = {
  sc: DEVICE_STANDARD_BODY_SC,
  sv: DEVICE_STANDARD_BODY_SV,
  app_ver: DEVICE_STANDARD_BODY_APP_VER,
  app_name: DEVICE_STANDARD_BODY_APP_NAME,
  app_version: DEVICE_STANDARD_BODY_APP_VERSION,
  phone_id: DEVICE_PHONE_ID,
  phone_system_type: DEVICE_STANDARD_BODY_PHONE_SYSTEM_TYPE,
};

afterEach(() => {
  resetSecretsForTesting();
});

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

function makeFetch(responseBody: unknown, status = 200): { fetchImpl: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as FetchLike;
  return { fetchImpl, calls };
}

describe("RealWyzeTransport.login", () => {
  // WYZR-15's corrected shape: keyid/apikey are HEADERS, the body carries
  // ONLY email and the triple-MD5 password, and the pre-WYZR-15 `x-api-key`
  // app-identity header is gone — see src/transport-http.ts's login().
  test("POSTs to the auth host's login path with keyid/apikey as headers and a minimal body", async () => {
    const { fetchImpl, calls } = makeFetch({ access_token: "at", refresh_token: "rt" });
    const transport = new RealWyzeTransport({ fetchImpl });

    await transport.login({
      email: "test@example.invalid",
      passwordHash: "fake-hash-000",
      keyId: "key-id-000",
      keySecret: "key-secret-000",
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`https://${WYZE_AUTH_HOST}/api/user/login`);
    expect(call.init?.method).toBe("POST");

    const headers = call.init?.headers as Record<string, string>;
    expect(headers["keyid"]).toBe("key-id-000");
    expect(headers["apikey"]).toBe("key-secret-000");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-api-key"]).toBeUndefined();

    const body = JSON.parse(call.init?.body as string);
    expect(body).toEqual({ email: "test@example.invalid", password: "fake-hash-000" });
  });

  test("never sends a field literally named \"password\" containing the raw password — only the pre-hashed value", async () => {
    const { fetchImpl, calls } = makeFetch({ access_token: "at", refresh_token: "rt" });
    const transport = new RealWyzeTransport({ fetchImpl });

    await transport.login({
      email: "test@example.invalid",
      passwordHash: "already-hashed-value",
      keyId: "k",
      keySecret: "s",
    });

    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body.password).toBe("already-hashed-value");
  });

  test("returns the auth envelope's httpStatus and raw top-level body — no `data` unwrapping", async () => {
    const { fetchImpl } = makeFetch({ access_token: "at", refresh_token: "rt", foo: "bar" }, 200);
    const transport = new RealWyzeTransport({ fetchImpl });

    const envelope = await transport.login({ email: "e", passwordHash: "p", keyId: "k", keySecret: "s" });

    expect(envelope).toEqual({
      httpStatus: 200,
      raw: { access_token: "at", refresh_token: "rt", foo: "bar" },
    });
  });

  // Structural fact from the ticket: the auth host signals its error via
  // HTTP status (400), unlike the device host (always 200, error in the
  // body). This proves the status is carried through, not discarded —
  // see src/transport-http.ts's request()/postAuth().
  test("carries a non-200 HTTP status through to the auth envelope", async () => {
    const { fetchImpl } = makeFetch(
      { description: "Invalid credentials, please check username, password, keyid or apikey", requestId: "r", errorCode: 1000 },
      400,
    );
    const transport = new RealWyzeTransport({ fetchImpl });

    const envelope = await transport.login({ email: "e", passwordHash: "p", keyId: "k", keySecret: "s" });

    expect(envelope.httpStatus).toBe(400);
    expect(envelope.raw["errorCode"]).toBe(1000);
  });
});

describe("RealWyzeTransport.submitMfa", () => {
  // Tier (d) design call (src/transport-http.ts's submitMfa() comment):
  // mirrors login()'s now-measured header placement, since the MFA-answer
  // shape itself remains unobserved by anyone.
  test("POSTs to the login path with keyid/apikey as headers and the challenge answer layered onto the minimal body", async () => {
    const { fetchImpl, calls } = makeFetch({ access_token: "at", refresh_token: "rt" });
    const transport = new RealWyzeTransport({ fetchImpl });

    await transport.submitMfa({
      email: "e",
      passwordHash: "p",
      keyId: "k",
      keySecret: "s",
      verificationId: "vid-1",
      mfaType: "TOTP",
      verificationCode: "123456",
    });

    const call = calls[0]!;
    expect(call.url).toBe(`https://${WYZE_AUTH_HOST}/api/user/login`);
    const headers = call.init?.headers as Record<string, string>;
    expect(headers["keyid"]).toBe("k");
    expect(headers["apikey"]).toBe("s");

    const body = JSON.parse(call.init?.body as string);
    expect(body).toEqual({
      email: "e",
      password: "p",
      mfa_type: "TOTP",
      verification_id: "vid-1",
      verification_code: "123456",
    });
  });
});

describe("RealWyzeTransport.refreshToken", () => {
  test("POSTs to the API host's refresh path with the refresh token, key pair, and the device-host standard body", async () => {
    const { fetchImpl, calls } = makeFetch({ code: "1", msg: "", data: {} });
    const transport = new RealWyzeTransport({ fetchImpl });

    await transport.refreshToken({ refreshToken: "rt-000", keyId: "k", keySecret: "s" });

    expect(calls[0]!.url).toBe(`https://${WYZE_API_HOST}/app/user/refresh_token`);
    const body = JSON.parse(calls[0]!.init?.body as string);
    const { ts, ...rest } = body;
    expect(typeof ts).toBe("number");
    expect(rest).toEqual({ ...STANDARD_BODY_FIELDS, refresh_token: "rt-000", keyid: "k", apikey: "s" });
  });
});

describe("RealWyzeTransport.getObjectList", () => {
  test("POSTs to the get_object_list path with the access token and the device-host standard body", async () => {
    const { fetchImpl, calls } = makeFetch({ code: "1", msg: "", data: { device_list: [] } });
    const transport = new RealWyzeTransport({ fetchImpl });

    await transport.getObjectList({ accessToken: "at-000" });

    expect(calls[0]!.url).toBe(`https://${WYZE_API_HOST}/app/v2/home_page/get_object_list`);
    const body = JSON.parse(calls[0]!.init?.body as string);
    const { ts, ...rest } = body;
    expect(typeof ts).toBe("number");
    expect(rest).toEqual({ ...STANDARD_BODY_FIELDS, access_token: "at-000" });
  });

  // Reproduces this ticket's own confirmed failure mode: a bare
  // `{access_token}` body (this project's pre-WYZR-15 shape) is what the
  // real device host REJECTS — this test just proves the standard body is
  // always present, which is the fix for it.
  test("never sends a bare {access_token} body with nothing else", async () => {
    const { fetchImpl, calls } = makeFetch({ code: "1", msg: "", data: { device_list: [] } });
    const transport = new RealWyzeTransport({ fetchImpl });

    await transport.getObjectList({ accessToken: "at-000" });

    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(Object.keys(body).length).toBeGreaterThan(1);
    expect(body.sc).toBeDefined();
  });
});

describe("RealWyzeTransport.getPropertyList", () => {
  test("POSTs to the get_property_list path with device_mac/device_model/target_pid_list and the standard body", async () => {
    const { fetchImpl, calls } = makeFetch({ code: "1", msg: "", data: { property_list: [] } });
    const transport = new RealWyzeTransport({ fetchImpl });

    await transport.getPropertyList({ accessToken: "at-000", mac: "MAC0", model: "WLPP1", targetPids: ["P3", "P5"] });

    expect(calls[0]!.url).toBe(`https://${WYZE_API_HOST}/app/v2/device/get_property_list`);
    const body = JSON.parse(calls[0]!.init?.body as string);
    const { ts, ...rest } = body;
    expect(typeof ts).toBe("number");
    expect(rest).toEqual({
      ...STANDARD_BODY_FIELDS,
      access_token: "at-000",
      device_mac: "MAC0",
      device_model: "WLPP1",
      target_pid_list: ["P3", "P5"],
    });
    // The pre-WYZR-15 field names must be gone, not just renamed alongside.
    expect(body.mac).toBeUndefined();
    expect(body.model).toBeUndefined();
  });
});

describe("RealWyzeTransport.setProperty", () => {
  test("POSTs to the set_property path with device_mac/device_model/pid/pvalue and the standard body", async () => {
    const { fetchImpl, calls } = makeFetch({ code: "1", msg: "", data: {} });
    const transport = new RealWyzeTransport({ fetchImpl });

    await transport.setProperty({ accessToken: "at-000", mac: "MAC0", model: "WLPP1", pid: "P3", value: "1" });

    expect(calls[0]!.url).toBe(`https://${WYZE_API_HOST}/app/v2/device/set_property`);
    const body = JSON.parse(calls[0]!.init?.body as string);
    const { ts, ...rest } = body;
    expect(typeof ts).toBe("number");
    expect(rest).toEqual({
      ...STANDARD_BODY_FIELDS,
      access_token: "at-000",
      device_mac: "MAC0",
      device_model: "WLPP1",
      pid: "P3",
      pvalue: "1",
    });
    expect(body.value).toBeUndefined();
    expect(body.mac).toBeUndefined();
    expect(body.model).toBeUndefined();
  });

  // Decision (A), REVISED by WYZR-15: this project's own request type
  // (`SetPropertyRequest.value: "0" | "1"`) makes a boolean OR a bare
  // number a compile error, but this test proves the value that actually
  // leaves the process over the wire is a bare JSON STRING, matching the
  // live-measured wire type — never a number, never a boolean.
  test("sends pvalue as a bare JSON string, never a number or a boolean", async () => {
    const { fetchImpl, calls } = makeFetch({ code: "1", msg: "", data: {} });
    const transport = new RealWyzeTransport({ fetchImpl });

    await transport.setProperty({ accessToken: "at", mac: "m", model: "md", pid: "P3", value: "0" });

    const rawBody = calls[0]!.init?.body as string;
    expect(rawBody).toContain('"pvalue":"0"');
    expect(rawBody).not.toContain('"pvalue":0');
    expect(rawBody).not.toContain('"pvalue":false');
  });
});

// login()/submitMfa() (auth host) read tokens at the TOP LEVEL, never
// nested under `data` — see src/wyze-auth-envelope.ts's header comment.
// refreshToken()/getObjectList()/etc (device host) keep the pre-WYZR-15
// {code,msg,data} shape, tested separately below.
describe("RealWyzeTransport — auth-host (login) token redaction the moment a response is parsed", () => {
  test("registers access_token and refresh_token found at the top level before returning", async () => {
    const { fetchImpl } = makeFetch({ access_token: "leak-at-000", refresh_token: "leak-rt-000" });
    const transport = new RealWyzeTransport({ fetchImpl });

    await transport.login({ email: "e", passwordHash: "p", keyId: "k", keySecret: "s" });

    expect(redact(`token was leak-at-000`)).toBe(`token was ${REDACTED}`);
    expect(redact(`token was leak-rt-000`)).toBe(`token was ${REDACTED}`);
  });

  test("registers a token even on an error envelope (defensive, not gated on happy path)", async () => {
    const { fetchImpl } = makeFetch(
      {
        description: "error but somehow carries a token anyway",
        errorCode: 9999,
        requestId: "r",
        access_token: "unexpected-leak-000",
      },
      400,
    );
    const transport = new RealWyzeTransport({ fetchImpl });

    await transport.login({ email: "e", passwordHash: "p", keyId: "k", keySecret: "s" });

    expect(redact(`leaked unexpected-leak-000`)).toBe(`leaked ${REDACTED}`);
  });
});

describe("RealWyzeTransport — device-host token redaction the moment a response is parsed", () => {
  test("registers access_token and refresh_token found in `data` before returning", async () => {
    const { fetchImpl } = makeFetch({
      code: "1",
      msg: "",
      data: { access_token: "leak-at-000", refresh_token: "leak-rt-000" },
    });
    const transport = new RealWyzeTransport({ fetchImpl });

    await transport.refreshToken({ refreshToken: "old-rt", keyId: "k", keySecret: "s" });

    expect(redact(`token was leak-at-000`)).toBe(`token was ${REDACTED}`);
    expect(redact(`token was leak-rt-000`)).toBe(`token was ${REDACTED}`);
  });

  test("also registers tokens found at the top level, not only nested in data", async () => {
    const { fetchImpl } = makeFetch({ code: "1", msg: "", access_token: "top-level-at-000", data: {} });
    const transport = new RealWyzeTransport({ fetchImpl });

    await transport.refreshToken({ refreshToken: "old-rt", keyId: "k", keySecret: "s" });

    expect(redact(`leaked top-level-at-000`)).toBe(`leaked ${REDACTED}`);
  });

  test("registers tokens even on a non-success envelope (defensive, not gated on happy path)", async () => {
    const { fetchImpl } = makeFetch({
      code: 1000,
      msg: "error but somehow carries a token anyway",
      data: { access_token: "unexpected-leak-000" },
    });
    const transport = new RealWyzeTransport({ fetchImpl });

    await transport.refreshToken({ refreshToken: "old-rt", keyId: "k", keySecret: "s" });

    expect(redact(`leaked unexpected-leak-000`)).toBe(`leaked ${REDACTED}`);
  });
});

describe("RealWyzeTransport — non-JSON response", () => {
  test("throws a Network CliError instead of returning garbage", async () => {
    const fetchImpl = (async () =>
      new Response("<html>not json</html>", { status: 502 })) as unknown as FetchLike;
    const transport = new RealWyzeTransport({ fetchImpl });

    await expect(
      transport.login({ email: "e", passwordHash: "p", keyId: "k", keySecret: "s" }),
    ).rejects.toThrow(/non-JSON/);
  });
});
