import { describe, expect, spyOn, test } from "bun:test";
import { printError, printHuman, printJson, printJsonError } from "../../src/output.ts";

describe("output", () => {
  test("printJson writes a JSON-serialized line to stdout", () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    printJson({ ok: true });
    expect(spy).toHaveBeenCalledWith('{"ok":true}');
    spy.mockRestore();
  });

  test("printHuman writes the message as-is to stdout", () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    printHuman("hello");
    expect(spy).toHaveBeenCalledWith("hello");
    spy.mockRestore();
  });

  test("printError writes to stderr, not stdout", () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    printError("boom");
    expect(errSpy).toHaveBeenCalledWith("boom");
    expect(logSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  test("printJsonError writes a JSON-serialized line to stderr, not stdout", () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    printJsonError({ error: { code: "generic" } });
    expect(errSpy).toHaveBeenCalledWith('{"error":{"code":"generic"}}');
    expect(logSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });
});
