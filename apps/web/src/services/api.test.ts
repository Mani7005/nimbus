import { describe, expect, it } from "vitest";
import { httpError, networkError } from "../test-utils/axios-errors";
import { isSessionExpiredError } from "./api";

describe("isSessionExpiredError (decides whether the 401 interceptor reloads the page)", () => {
  it.each(["/execute", "/execute/cmrm5whp00000ieqonyoqlbge", "/auth/me"])("reloads for a 401 from %s", (url) => {
    expect(isSessionExpiredError(httpError(401, {}, url))).toBe(true);
  });

  it.each(["/auth/login", "/auth/register", "/auth/login?next=/"])("does not reload for a failed %s", (url) => {
    expect(isSessionExpiredError(httpError(401, { success: false, message: "Invalid email or password" }, url))).toBe(false);
  });

  it("ignores other statuses and errors without a response", () => {
    expect(isSessionExpiredError(httpError(403, {}, "/execute"))).toBe(false);
    expect(isSessionExpiredError(httpError(429, {}, "/execute"))).toBe(false);
    expect(isSessionExpiredError(networkError())).toBe(false);
    expect(isSessionExpiredError(new Error("boom"))).toBe(false);
  });
});
