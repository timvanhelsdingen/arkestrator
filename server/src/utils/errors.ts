import type { Context } from "hono";

/**
 * Structured error codes for REST API responses.
 * SDKs and bridges can use these to programmatically handle errors
 * without parsing error message strings.
 */
export type ErrorCode =
  | "AUTH_FAILED"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "INVALID_JSON"
  | "VALIDATION"
  | "VALIDATION_ERROR"
  | "BAD_REQUEST"
  | "CONFIG_NOT_FOUND"
  | "POLICY_BLOCKED"
  | "RATE_LIMITED"
  | "CONFLICT"
  | "WRITE_ERROR"
  | "INTERNAL"
  | "INTERNAL_ERROR"
  | "UPSTREAM_ERROR"
  | "UNAVAILABLE";

/**
 * Return a structured error response with { error, code }.
 * All REST error responses should use this helper so SDKs
 * can reliably distinguish error types without string parsing.
 */
export function errorResponse(
  c: Context,
  status: number,
  error: string,
  code: ErrorCode,
  extra?: Record<string, unknown>,
) {
  return c.json({ error, code, ...extra }, status as any);
}
