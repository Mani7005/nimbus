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
}

export async function executeCode(language: string, code: string, input: string): Promise<ExecutionResponse> {
  const response = await api.post("/execute", { language, code, input });
  return response.data;
}

export async function getExecution(id: string): Promise<ExecutionResponse> {
  const response = await api.get(`/execute/${id}`);
  return response.data;
}

export async function getExecutions(): Promise<ExecutionsResponse> {
  const response = await api.get("/execute");
  return response.data;
}

export async function deleteExecution(id: string): Promise<ApiSuccessResponse> {
  const response = await api.delete(`/execute/${id}`);
  return response.data;
}
