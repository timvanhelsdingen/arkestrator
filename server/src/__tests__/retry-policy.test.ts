import { describe, expect, it } from "bun:test";
import { isTransientError, computeRetryDelay, DEFAULT_MAX_RETRIES, DEFAULT_TARGET_WORKER_TTL_MS } from "../queue/retry-policy.js";

describe("retry-policy", () => {
  describe("isTransientError", () => {
    it("detects HTTP 429 rate limit", () => {
      expect(isTransientError("API returned 429 Too Many Requests")).toBe(true);
    });

    it("detects HTTP 503 service unavailable", () => {
      expect(isTransientError("Server returned 503")).toBe(true);
    });

    it("detects ECONNREFUSED", () => {
      expect(isTransientError("connect ECONNREFUSED 127.0.0.1:11434")).toBe(true);
    });

    it("detects ETIMEDOUT", () => {
      expect(isTransientError("connect ETIMEDOUT")).toBe(true);
    });

    it("detects rate limit text", () => {
      expect(isTransientError("rate_limit_exceeded: too many requests")).toBe(true);
      expect(isTransientError("Rate limit reached")).toBe(true);
    });

    it("detects overloaded", () => {
      expect(isTransientError("API is overloaded")).toBe(true);
    });

    it("detects socket hang up", () => {
      expect(isTransientError("socket hang up")).toBe(true);
    });

    it("returns false for permanent errors", () => {
      expect(isTransientError("401 Unauthorized")).toBe(false);
      expect(isTransientError("403 Forbidden")).toBe(false);
      expect(isTransientError("Invalid API key")).toBe(false);
      expect(isTransientError("invalid api_key provided")).toBe(false);
    });

    it("returns false for empty/null", () => {
      expect(isTransientError("")).toBe(false);
      expect(isTransientError(null as any)).toBe(false);
    });

    it("returns false for logic errors", () => {
      expect(isTransientError("No agent config available")).toBe(false);
      expect(isTransientError("Failed to parse JSON")).toBe(false);
      expect(isTransientError("Process exited with code 1")).toBe(false);
    });

    it("permanent patterns override transient patterns", () => {
      // Contains both "401" (permanent) and could match transient patterns
      expect(isTransientError("401 Unauthorized - rate limit not relevant")).toBe(false);
    });
  });

  describe("computeRetryDelay", () => {
    it("returns base delay for first retry", () => {
      const delay = computeRetryDelay(0, 30000, 300000);
      // Should be between 30000 and 45000 (base + up to 50% jitter)
      expect(delay).toBeGreaterThanOrEqual(30000);
      expect(delay).toBeLessThanOrEqual(45000);
    });

    it("doubles for second retry", () => {
      const delay = computeRetryDelay(1, 30000, 300000);
      // Should be between 60000 and 75000
      expect(delay).toBeGreaterThanOrEqual(60000);
      expect(delay).toBeLessThanOrEqual(75000);
    });

    it("caps at maxMs", () => {
      const delay = computeRetryDelay(10, 30000, 300000);
      // Should be capped at 300000 + jitter
      expect(delay).toBeLessThanOrEqual(315000);
    });

    it("returns integer", () => {
      const delay = computeRetryDelay(0);
      expect(Number.isInteger(delay)).toBe(true);
    });
  });

  describe("constants", () => {
    it("has reasonable defaults", () => {
      expect(DEFAULT_MAX_RETRIES).toBe(2);
      expect(DEFAULT_TARGET_WORKER_TTL_MS).toBe(30 * 60 * 1000); // 30 minutes
    });
  });
});
