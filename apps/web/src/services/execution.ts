import type { ApiSuccessResponse } from "../types/api";
import api from "./api";

export type ExecutionStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "TIMEOUT";

export interface Execution {
  id: string;
  language: string;
  code: string;
  input: string | null;
  output: string | null;
  status: ExecutionStatus;
  createdAt: string;
  userId: string;
}

export interface ExecutionResponse extends ApiSuccessResponse {
  execution: Execution;
}

export interface ExecutionsResponse extends ApiSuccessResponse {
  executions: Execution[];
  /** Pass as `cursor` to load the next page; null on the last page. */
  nextCursor: string | null;
}

export async function executeCode(language: string, code: string, input: string): Promise<ExecutionResponse> {
  const response = await api.post<ExecutionResponse>("/execute", { language, code, input });
  return response.data;
}

export async function getExecution(id: string, signal?: AbortSignal): Promise<ExecutionResponse> {
  const response = await api.get<ExecutionResponse>(`/execute/${id}`, { signal });
  return response.data;
}

/** One page of history, newest first. Without a cursor, the first page. */
export async function getExecutions(params: { cursor?: string; limit?: number } = {}): Promise<ExecutionsResponse> {
  const response = await api.get<ExecutionsResponse>("/execute", { params });
  return response.data;
}

export async function deleteExecution(id: string): Promise<ApiSuccessResponse> {
  const response = await api.delete<ApiSuccessResponse>(`/execute/${id}`);
  return response.data;
}
