import { describe, expect, it } from "vitest";
import {
  m10GatewayRequestId,
  observeM10GatewayStreamError,
  registerM10GatewayRequest,
} from "./m10-gateway-boundary.js";

describe("M10 Gateway request boundary", () => {
  it("keeps a valid M10 ID and forwards only safe structured error metadata", () => {
    const errors: unknown[] = [];
    const request = registerM10GatewayRequest("run-1", "canary_12345678", (error) => errors.push(error));
    expect(m10GatewayRequestId("run-1")).toBe("canary_12345678");
    expect(observeM10GatewayStreamError("run-1", '502 {"request_id":"canary_12345678","error":{"layer":"gateway","code":"INVALID_RESPONSE","category":"INVALID_RESPONSE","retryable":false,"provider":"fixture-provider","raw":"secret"}}')).toBe(true);
    expect(errors).toEqual([{
      request_id: "canary_12345678", category: "INVALID_RESPONSE", code: "INVALID_RESPONSE",
      retryable: false, http_status: 502, provider: "fixture-provider",
    }]);
    expect(observeM10GatewayStreamError("run-1", '502 {"error":{"layer":"gateway","category":"PROVIDER_5XX"}}')).toBe(false);
    request.release();
    expect(m10GatewayRequestId("run-1")).toBeUndefined();
  });

  it.each(["bad\r\nX-Injected: yes", "short", "a".repeat(81), "用户内容", undefined])(
    "generates a safe ID for invalid or absent input",
    (value) => {
      const request = registerM10GatewayRequest("run-2", value, () => {});
      expect(request.requestId).toMatch(/^oc_[a-f0-9]{32}$/);
      request.release();
    },
  );

  it.each([
    [429, "RATE_LIMITED", true],
    [502, "PROVIDER_5XX", true],
    [504, "TIMEOUT", true],
  ])("preserves HTTP %i and %s", (status, category, retryable) => {
    let observed: unknown;
    const request = registerM10GatewayRequest("run-3", "canary_87654321", (error) => { observed = error; });
    expect(observeM10GatewayStreamError("run-3", `${status} ${JSON.stringify({ error: { layer: "gateway", category, retryable } })}`)).toBe(true);
    expect(observed).toMatchObject({ http_status: status, category, retryable });
    request.release();
  });

  it("accepts the OpenAI SDK error.message shape from a Gateway response", () => {
    let observed: unknown;
    const request = registerM10GatewayRequest("run-sdk", "canary_87654321", (error) => { observed = error; });
    expect(observeM10GatewayStreamError("run-sdk", '502 {"code":"INVALID_RESPONSE","category":"INVALID_RESPONSE","layer":"gateway","retryable":false,"safe_message":"redacted"}')).toBe(true);
    expect(observed).toMatchObject({ request_id: "canary_87654321", category: "INVALID_RESPONSE", http_status: 502 });
    request.release();
  });

  it("leaves unrelated provider errors to OpenClaw timeout handling", () => {
    let called = false;
    const request = registerM10GatewayRequest("run-4", "canary_87654321", () => { called = true; });
    expect(observeM10GatewayStreamError("run-4", "request timed out")).toBe(false);
    expect(called).toBe(false);
    request.release();
  });

  it("accepts the SDK statusless terminal Gateway SSE error without exposing raw fields", () => {
    let observed: unknown;
    const request = registerM10GatewayRequest("run-partial", "canary_partial_123", (error) => { observed = error; });
    expect(observeM10GatewayStreamError("run-partial", JSON.stringify({
      layer: "gateway", category: "STREAM_INTERRUPTED", code: "STREAM_INTERRUPTED",
      retryable: false, provider: "fixture", model: "test", raw: "secret",
    }))).toBe(true);
    expect(observed).toEqual({
      request_id: "canary_partial_123", category: "STREAM_INTERRUPTED", code: "STREAM_INTERRUPTED",
      retryable: false, http_status: 502, provider: "fixture", model: "test",
    });
    request.release();
  });

  it.each([
    { layer: "gateway", category: "TIMEOUT" },
    { layer: "other", category: "STREAM_INTERRUPTED" },
  ])("does not terminate on unrelated statusless errors: %j", (payload) => {
    let called = false;
    const request = registerM10GatewayRequest("run-unrelated", "canary_partial_123", () => { called = true; });
    expect(observeM10GatewayStreamError("run-unrelated", JSON.stringify(payload))).toBe(false);
    expect(called).toBe(false);
    request.release();
  });
});
