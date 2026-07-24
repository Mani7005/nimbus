export interface ApiSuccessResponse {
  success: true;
}

export interface User {
  id: string;
  email: string;
  createdAt?: string;
}
