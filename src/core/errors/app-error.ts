export interface AppErrorOptions {
  code: string;
  httpStatus: number;
  message: string;
  details?: Record<string, unknown>;
  expose?: boolean;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;
  readonly expose: boolean;

  constructor(options: AppErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'AppError';
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.details = options.details;
    this.expose = options.expose ?? true;
  }
}
