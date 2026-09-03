// Every test here injects `fetchImpl` — NO network, ever. This is what
// proves RealWyzeTransport's request construction and response handling
// separately from (and in addition to) whatever the fake transport proves.

import { afterEach, describe, expect, test } from "bun:test";
import { APP_IDENTITY_KEY } from "../../src/app-identity.ts";
import { REDACTED, redact, resetSecretsForTesting } from "../../src/redact.ts";
import { RealWyzeTransport, type FetchLike } from "../../src/transport-http.ts";
import { WYZE_API_HOST, WYZE_AUTH_HOST } from "../../src/transport.ts";

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
  test("POSTs to the auth host's login path with the expected body and headers", async () => {
    const { fetchImpl, calls } = makeFetch({ code: "1", msg: "", data: {} });
    const transport = new RealWyzeTransport({ fetchImpl });

    await transport.login({
      email: "test@example.invalid",
      passwordHash: "fake-hash-000",
      nonce: "nonce-000",
      keyId: "key-id-000",
      keySecret: "key-secret-000",
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`https://${WYZE_AUTH_HOST}/api/user/login`);
    expect(call.init?.method).toBe("POST");

    const headers = call.init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(APP_IDENTITY_KEY);
    expect(headers["content-type"]).toBe("application/json");

    const body = JSON.parse(call.init?.body as string);
    expect(body).toEqual({
      email: "test@example.invalid",
      password: "fake-hash-000",
      nonce: "nonce-000",
      keyid: "key-id-000",
      apikey: "key-secret-000",
    });
  });

  test("never sends a field literally named \"password\" containing the raw password — only the pre-hashed value", async () => {
    const { fetchImpl, calls } = makeFetch({ code: "1", msg: "", data: {} });
    const transport = new RealWyzeTransport({ fetchImpl });

    await transport.login({
      email: "test@example.invalid",
      passwordHash: "already-hashed-value",
      nonce: "n",
      keyId: "k",
      keySecret: "s",
    });

    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body.password).toBe("already-hashed-value");
  });

  test("returns the envelope's code/msg/data", async () => {
    const { fetchImpl } = makeFetch({ code: "1", msg: "ok", data: { foo: "bar" } });
    const transport = new RealWyzeTransport({ fetchImpl });

    const envelope = await transport.login({
      email: "e",
      passwordHash: "p",
      nonce: "n",
      keyId: "k",
      keySecret: "s",
    });

    expect(envelope).toEqual({ code: "1", msg: "ok", data: { foo: "bar" } });
  });
});

describe("RealWyzeTransport.submitMfa", () => {
  test("POSTs to the login path with the challenge answer layered on top", async () => {
    const { fetchImpl, calls } = makeFetch({ code: "1", msg: "", data: {} });
    const transport = new RealWyzeTransport({ fetchImpl });

    await transport.submitMfa({
      email: "e",
      passwordHash: "p",
      nonce: "n",
      keyId: "k",
      keySecret: "s",
      verificationId: "vid-1",
      mfaType: "TOTP",
      verificationCode: "123456",
    });

    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body.mfa_type).toBe("TOTP");
    expect(body.verification_id).toBe("vid-1");
    expect(body.verification_code).toBe("123456");
    expect(calls[0]!.url).toBe(`https://${WYZE_AUTH_HOST}/api/user/login`);
  });
});

describe("RealWyzeTransport.refreshToken", () => {
  test("POSTs to the API host's refresh path with the refresh token and key pair", async () => {
    const { fetchImpl, calls } = makeFetch({ code: "1", msg: "", data: {} });
    const transport = new RealWyzeTransport({ fetchImpl });

    await transport.refreshToken({ refreshToken: "rt-000", keyId: "k", keySecret: "s" });

    expect(calls[0]!.url).toBe(`https://${WYZE_API_HOST}/app/user/refresh_token`);
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body).toEqual({ refresh_token: "rt-000", keyid: "k", apikey: "s" });
  });
});

describe("RealWyzeTransport.getObjectList", () => {
  test("POSTs to the get_object_list path with the access token", async () => {
    const { fetchImpl, calls } = makeFetch({ code: "1", msg: "", data: { device_list: [] } });
    const transport = new RealWyzeTransport({ fetchImpl });

    await transport.getObjectList({ accessToken: "at-000" });

    expect(calls[0]!.url).toBe(`https://${WYZE_API_HOST}/app/v2/home_page/get_object_list`);
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body).toEqual({ access_token: "at-000" });
  });
});

describe("RealWyzeTransport — token redaction the moment a response is parsed", () => {
  test("registers access_token and refresh_token found in `data` before returning", async () => {
    const { fetchImpl } = makeFetch({
      code: "1",
      msg: "",
      data: { access_token: "leak-at-000", refresh_token: "leak-rt-000" },
    });
    const transport = new RealWyzeTransport({ fetchImpl });

    await transport.login({ email: "e", passwordHash: "p", nonce: "n", keyId: "k", keySecret: "s" });

    expect(redact(`token was leak-at-000`)).toBe(`token was ${REDACTED}`);
    expect(redact(`token was leak-rt-000`)).toBe(`token was ${REDACTED}`);
  });

  test("also registers tokens found at the top level, not only nested in data", async () => {
    const { fetchImpl } = makeFetch({ code: "1", msg: "", access_token: "top-level-at-000", data: {} });
    const transport = new RealWyzeTransport({ fetchImpl });

    await transport.login({ email: "e", passwordHash: "p", nonce: "n", keyId: "k", keySecret: "s" });

    expect(redact(`leaked top-level-at-000`)).toBe(`leaked ${REDACTED}`);
  });

  test("registers tokens even on a non-success envelope (defensive, not gated on happy path)", async () => {
    const { fetchImpl } = makeFetch({
      code: 1000,
      msg: "error but somehow carries a token anyway",
      data: { access_token: "unexpected-leak-000" },
    });
    const transport = new RealWyzeTransport({ fetchImpl });

    await transport.login({ email: "e", passwordHash: "p", nonce: "n", keyId: "k", keySecret: "s" });

    expect(redact(`leaked unexpected-leak-000`)).toBe(`leaked ${REDACTED}`);
  });
});

describe("RealWyzeTransport — non-JSON response", () => {
  test("throws a Network CliError instead of returning garbage", async () => {
    const fetchImpl = (async () =>
      new Response("<html>not json</html>", { status: 502 })) as unknown as FetchLike;
    const transport = new RealWyzeTransport({ fetchImpl });

    await expect(
      transport.login({ email: "e", passwordHash: "p", nonce: "n", keyId: "k", keySecret: "s" }),
    ).rejects.toThrow(/non-JSON/);
  });
});
