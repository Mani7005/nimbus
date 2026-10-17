import { describe, expect, it } from "vitest";
import { canceledError, httpError, networkError } from "../test-utils/axios-errors";
import { NETWORK_ERROR_MESSAGE, getApiErrorMessage, isTransientError } from "./api-errors";

describe("getApiErrorMessage", () => {
  it.each([
    [400, "code: Too big: expected string to have <=50000 characters"],
    [429, "You already have 3 unfinished executions. Wait for one to finish before submitting another."],
    [429, "Too many execution requests. Please wait before submitting again."],
    [503, "Execution service unavailable. Please try again."],
    [409, "An account with this email already exists"],
    [401, "Invalid email or password"],
  ])("shows the API message for a %i response", (status, message) => {
    expect(getApiErrorMessage(httpError(status, { success: false, message }), "fallback")).toBe(message);
  });

  it("uses the fallback for generic server errors", () => {
    expect(getApiErrorMessage(httpError(500, { success: false, message: "Internal server error" }), "fallback")).toBe("fallback");
    expect(getApiErrorMessage(httpError(502, "<html>Bad Gateway</html>"), "fallback")).toBe("fallback");
  });

  it("uses the fallback when the response has no usable message", () => {
    expect(getApiErrorMessage(httpError(400, {}), "fallback")).toBe("fallback");
    expect(getApiErrorMessage(httpError(400, { message: "  " }), "fallback")).toBe("fallback");
    expect(getApiErrorMessage(httpError(400, { message: 42 }), "fallback")).toBe("fallback");
    expect(getApiErrorMessage(httpError(400, "plain text"), "fallback")).toBe("fallback");
  });

  it("explains a network failure", () => {
    expect(getApiErrorMessage(networkError(), "fallback")).toBe(NETWORK_ERROR_MESSAGE);
  });

  it("uses the fallback for cancellations and non-Axios errors", () => {
    expect(getApiErrorMessage(canceledError(), "fallback")).toBe("fallback");
    expect(getApiErrorMessage(new Error("boom"), "fallback")).toBe("fallback");
  });
});

describe("isTransientError", () => {
  it.each([
    ["a network failure", networkError(), true],
    ["429", httpError(429), true],
    ["500", httpError(500), true],
    ["503", httpError(503), true],
    ["400", httpError(400), false],
    ["404", httpError(404), false],
    ["a cancellation", canceledError(), false],
    ["a non-Axios error", new Error("boom"), false],
  ])("treats %s as %s", (_name, error, expected) => {
    expect(isTransientError(error)).toBe(expected);
  });
});
