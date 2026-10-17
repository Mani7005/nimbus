import axios from "axios";

export const NETWORK_ERROR_MESSAGE = "Could not reach the server. Check your connection and try again.";

/**
 * The API's own message for 4xx and 503 responses, which are written for users (validation, rate limits, the
 * execution cap, a busy queue). Other server errors are generic, so the caller's fallback is shown instead.
 */
export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (!axios.isAxiosError(error)) return fallback;
  if (!error.response) return error.code === axios.AxiosError.ERR_CANCELED ? fallback : NETWORK_ERROR_MESSAGE;

  const { status, data } = error.response;
  const message = typeof data === "object" && data !== null ? (data as { message?: unknown }).message : undefined;
  if (typeof message === "string" && message.trim() && (status < 500 || status === 503)) return message;
  return fallback;
}

/** Worth retrying: no response at all, a rate limit, or a server-side failure. */
export function isTransientError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  if (!error.response) return error.code !== axios.AxiosError.ERR_CANCELED;
  return error.response.status === 429 || error.response.status >= 500;
}
