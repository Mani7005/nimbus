import axios from "axios";
import { getToken, removeToken } from "../utils/storage";

const api = axios.create({
  baseURL: "http://localhost:3000",
});

// Their 401 means "wrong credentials", not "session expired", so the page must not reload under the user.
const CREDENTIAL_ENDPOINTS = ["/auth/login", "/auth/register"];

/** A 401 from an authenticated request: the stored token is missing, invalid or expired. */
export function isSessionExpiredError(error: unknown): boolean {
  if (!axios.isAxiosError(error) || error.response?.status !== 401) return false;
  const path = (error.config?.url ?? "").split("?")[0];
  return !CREDENTIAL_ENDPOINTS.includes(path);
}

api.interceptors.request.use((config) => {
  const token = getToken();

  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (isSessionExpiredError(error)) {
      removeToken();
      window.location.reload();
    }

    return Promise.reject(error);
  }
);

export default api;
