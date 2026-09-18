/** 统一 API 错误：{ error: { code, message, details? } } */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  toBody(): { error: { code: string; message: string; details?: unknown } } {
    const error: { code: string; message: string; details?: unknown } = {
      code: this.code,
      message: this.message,
    };
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new ApiError(400, code, message, details);
export const notFound = (code: string, message: string, details?: unknown) =>
  new ApiError(404, code, message, details);
export const conflict = (code: string, message: string, details?: unknown) =>
  new ApiError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new ApiError(422, code, message, details);
