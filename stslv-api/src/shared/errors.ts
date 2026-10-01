import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";

export interface ErrorDetail {
  field: string;
  message: string;
}

/**
 * An error that is safe to show to the API caller.
 * Every error response has the shape:
 *   { success: false, error: { code, message, details? } }
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ErrorDetail[] | undefined;

  constructor(status: number, code: string, message: string, details?: ErrorDetail[]) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const validationError = (message: string, details?: ErrorDetail[]) =>
  new AppError(400, "VALIDATION_ERROR", message, details);
export const unauthorized = (message = "Authentication is required.") => new AppError(401, "UNAUTHORIZED", message);
export const forbidden = (message = "You do not have permission to perform this action.") =>
  new AppError(403, "FORBIDDEN", message);
export const notFound = (message = "The requested record was not found.") => new AppError(404, "NOT_FOUND", message);
export const conflict = (message: string, details?: ErrorDetail[]) => new AppError(409, "CONFLICT", message, details);

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, "NOT_FOUND", "The requested API route does not exist."));
};

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof AppError) {
    res.status(error.status).json({
      success: false,
      error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
    });
    return;
  }

  if (error instanceof ZodError) {
    res.status(400).json({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Some fields are invalid.",
        details: error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
      },
    });
    return;
  }

  // Malformed or oversized JSON body, raised by express.json().
  const bodyErrorType = (error as { type?: unknown } | null)?.type;

  if (bodyErrorType === "entity.parse.failed") {
    res.status(400).json({ success: false, error: { code: "INVALID_JSON", message: "The request body is not valid JSON." } });
    return;
  }
  if (bodyErrorType === "entity.too.large") {
    res.status(413).json({ success: false, error: { code: "PAYLOAD_TOO_LARGE", message: "The request body is too large." } });
    return;
  }

  // Unexpected: log the reason server-side only; never send a stack trace or SQL to the caller.
  console.error(`Unhandled error: ${error instanceof Error ? (error.stack ?? error.message) : "Unknown error"}`);
  res.status(500).json({
    success: false,
    error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." },
  });
};

/** True when a PostgreSQL error is a unique-constraint violation, optionally on a named constraint. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pgError = error as { code?: unknown; constraint?: unknown } | null;

  return pgError?.code === "23505" && (constraint === undefined || pgError.constraint === constraint);
}
