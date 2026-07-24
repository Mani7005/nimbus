import type { ApiSuccessResponse, User } from "../types/api";
import api from "./api";

export interface AuthResponse extends ApiSuccessResponse {
  token: string;
  user: User;
}

export interface CurrentUserResponse extends ApiSuccessResponse {
  user: User | null;
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  const response = await api.post("/auth/login", { email, password });
  return response.data;
}

export async function register(email: string, password: string): Promise<AuthResponse> {
  const response = await api.post("/auth/register", { email, password });
  return response.data;
}

export async function me(): Promise<CurrentUserResponse> {
  const response = await api.get("/auth/me");
  return response.data;
}
