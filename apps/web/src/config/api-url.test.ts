import { describe, expect, it } from "vitest";
import { DEVELOPMENT_API_URL, isLocalHostname, resolveApiBaseUrl } from "./api-url";

describe("resolveApiBaseUrl", () => {
  it("falls back to the local API in development and tests only", () => {
    expect(resolveApiBaseUrl({ production: false })).toBe(DEVELOPMENT_API_URL);
    expect(resolveApiBaseUrl({ VITE_API_URL: "   ", production: false })).toBe("http://localhost:3000");
  });

  it("refuses to build for production without VITE_API_URL instead of targeting localhost", () => {
    expect(() => resolveApiBaseUrl({ production: true })).toThrow("VITE_API_URL must be set for production builds");
    expect(() => resolveApiBaseUrl({ VITE_API_URL: "", production: true })).toThrow("VITE_API_URL must be set for production builds");
  });

  it("uses a valid https URL in production, without a trailing slash", () => {
    expect(resolveApiBaseUrl({ VITE_API_URL: "https://api.example.com", production: true })).toBe("https://api.example.com");
    expect(resolveApiBaseUrl({ VITE_API_URL: " https://api.example.com/ ", production: true })).toBe("https://api.example.com");
    expect(resolveApiBaseUrl({ VITE_API_URL: "https://example.com/nimbus-api/", production: true })).toBe("https://example.com/nimbus-api");
  });

  it("allows an http URL, including a local one, outside production", () => {
    expect(resolveApiBaseUrl({ VITE_API_URL: "http://127.0.0.1:4000", production: false })).toBe("http://127.0.0.1:4000");
  });

  it.each([
    ["http://api.example.com", "must use https:// in production builds"],
    ["https://localhost:3000", "must not point to a local address"],
    ["https://LOCALHOST", "must not point to a local address"],
    ["https://localhost.", "must not point to a local address"],
    ["https://api.localhost", "must not point to a local address"],
    ["https://127.0.0.1", "must not point to a local address"],
    ["https://127.0.0.2:8443", "must not point to a local address"],
    ["https://127.1", "must not point to a local address"],
    ["https://2130706433", "must not point to a local address"],
    ["https://0x7f000001", "must not point to a local address"],
    ["https://0.0.0.0", "must not point to a local address"],
    ["https://[::1]:3000", "must not point to a local address"],
    ["https://[0:0:0:0:0:0:0:1]", "must not point to a local address"],
    ["https://[::]", "must not point to a local address"],
    ["https://[::ffff:127.0.0.1]", "must not point to a local address"],
  ])("rejects %s in production", (value, message) => {
    expect(() => resolveApiBaseUrl({ VITE_API_URL: value, production: true })).toThrow(message);
  });

  it.each(["https://api.example.com:8443", "https://localhost.example.com", "https://127.example.com", "https://[2606:4700::1111]"])(
    "does not mistake %s for a local address",
    (value) => {
      expect(isLocalHostname(new URL(value).hostname)).toBe(false);
      expect(resolveApiBaseUrl({ VITE_API_URL: value, production: true })).toBe(value);
    },
  );

  it.each([
    ["api.example.com", "must be an absolute http(s) URL"],
    ["ftp://api.example.com", "must use http:// or https://"],
    ["https://user:pw@api.example.com", "must not contain credentials, a query or a fragment"],
    ["https://api.example.com/?debug=1", "must not contain credentials, a query or a fragment"],
    ["https://api.example.com/#x", "must not contain credentials, a query or a fragment"],
  ])("rejects malformed value %s in every mode", (value, message) => {
    expect(() => resolveApiBaseUrl({ VITE_API_URL: value, production: false })).toThrow(message);
    expect(() => resolveApiBaseUrl({ VITE_API_URL: value, production: true })).toThrow(message);
  });
});
