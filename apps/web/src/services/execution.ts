import api from "./api";

export interface Execution {
  id: string;
  language: string;
  code: string;
  output: string | null;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "TIMEOUT";
  createdAt: string;
  userId: string;
}

export async function executeCode(
  language: string,
  code: string,
  token: string
) {
  const response = await api.post(
    "/execute",
    {
      language,
      code,
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  return response.data;
}

export async function getExecution(
  id: string,
  token: string
) {
  const response = await api.get(`/execute/${id}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  return response.data;
}

export async function getExecutions(
  token: string
) {
  const response = await api.get("/execute", {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  return response.data;
}

export async function deleteExecution(
  id: string,
  token: string
) {
  const response = await api.delete(`/execute/${id}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  return response.data;
}