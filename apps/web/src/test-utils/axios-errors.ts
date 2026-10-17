import { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from "axios";

/** A real AxiosError for an HTTP response, as Axios rejects with it. */
export function httpError(status: number, data: unknown = {}, url = "/execute"): AxiosError {
  const config = { url, headers: new AxiosHeaders() } as InternalAxiosRequestConfig;
  return new AxiosError(`Request failed with status code ${status}`, undefined, config, {}, {
    status,
    statusText: "",
    data,
    headers: {},
    config,
  });
}

/** A request that never got a response (server down, DNS, CORS, connection reset). */
export function networkError(url = "/execute"): AxiosError {
  const config = { url, headers: new AxiosHeaders() } as InternalAxiosRequestConfig;
  return new AxiosError("Network Error", AxiosError.ERR_NETWORK, config, {});
}

export function canceledError(): AxiosError {
  return new AxiosError("canceled", AxiosError.ERR_CANCELED);
}
