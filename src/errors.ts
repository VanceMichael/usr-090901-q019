export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message: string, details?: unknown): ApiError =>
  new ApiError(400, 'VALIDATION_ERROR', message, details);

export const notFound = (code: string, message: string): ApiError =>
  new ApiError(404, code, message);

export const conflict = (code: string, message: string, details?: unknown): ApiError =>
  new ApiError(409, code, message, details);

export const unprocessable = (code: string, message: string, details?: unknown): ApiError =>
  new ApiError(422, code, message, details);
