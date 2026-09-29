import { randomUUID } from "node:crypto";

const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;
const CODE = /^[A-Z0-9_]{1,80}$/;
const CATEGORIES = new Set([
  "NETWORK_ERROR", "TIMEOUT", "RATE_LIMITED", "PROVIDER_5XX", "MODEL_OFFLINE",
  "ROUTE_UNAVAILABLE", "CONTEXT_TOO_LONG", "STREAM_INTERRUPTED", "INVALID_RESPONSE",
  "INVALID_REQUEST", "AUTH_ERROR", "SESSION_ERROR", "INTERNAL_ERROR",
  "UPSTREAM_HTTP_ERROR",
]);

export type M10GatewayError = {
  request_id: string;
  gateway_request_id?: string;
  category: string;
  code: string;
  retryable: boolean;
  http_status: number;
  upstream_status?: number;
  terminal?: boolean;
  partial?: boolean;
  timeout_source?: string;
  provider?: string;
  model?: string;
};

type RequestBoundary = { requestId: string; onError: (error: M10GatewayError) => void; delivered: boolean };
const active = new Map<string, RequestBoundary>();

/** Only a bounded, header-safe identifier may cross the provider boundary. */
export function registerM10GatewayRequest(
  runId: string,
  raw: string | string[] | undefined,
  onError: (error: M10GatewayError) => void,
): { requestId: string; release: () => void } {
  const candidate = typeof raw === "string" ? raw : "";
  const requestId = REQUEST_ID.test(candidate) ? candidate : `oc_${randomUUID().replaceAll("-", "")}`;
  const boundary: RequestBoundary = { requestId, onError, delivered: false };
  active.set(runId, boundary);
  return { requestId, release: () => { if (active.get(runId) === boundary) { active.delete(runId); } } };
}

export function m10GatewayRequestId(runId: string): string | undefined {
  return active.get(runId)?.requestId;
}

/** The SDK serializes Gateway HTTP errors and statusless terminal SSE errors differently. */
export function observeM10GatewayStreamError(runId: string, errorMessage: unknown): boolean {
  const boundary = active.get(runId);
  if (!boundary || boundary.delivered || typeof errorMessage !== "string" || errorMessage.length > 4096) {
    return false;
  }
  const match = /^(\d{3})\s+(\{.*\})$/s.exec(errorMessage.trim());
  let payload: unknown;
  try { payload = JSON.parse(match ? match[2] : errorMessage.trim()); } catch { return false; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) { return false; }
  const source = payload as Record<string, unknown>;
  const error = source.error;
  const details = error && typeof error === "object" && !Array.isArray(error)
    ? error as Record<string, unknown> : source;
  if (details.layer !== "gateway") { return false; }
  const category = details.category;
  if (typeof category !== "string" || !CATEGORIES.has(category)) { return false; }
  const upstreamStatus = details.upstream_status;
  const validUpstreamStatus = Number.isInteger(upstreamStatus) && Number(upstreamStatus) >= 400
    && Number(upstreamStatus) <= 599 ? Number(upstreamStatus) : undefined;
  const timeoutSource = details.timeout_source;
  const validTimeoutSource = typeof timeoutSource === "string" &&
    ["ReadTimeout", "ConnectTimeout", "WriteTimeout", "PoolTimeout"].includes(timeoutSource)
    ? timeoutSource : undefined;
  const timeoutStatus = category === "TIMEOUT" && details.terminal === true && validTimeoutSource
    && details.http_status === 504 ? 504 : undefined;
  // A statusless SDK error must carry an explicit terminal marker and upstream
  // status. Retain the older partial-stream shape for compatibility.
  if (!match && category !== "STREAM_INTERRUPTED" &&
      !(details.terminal === true && (validUpstreamStatus !== undefined || timeoutStatus !== undefined))) { return false; }
  const status = match ? Number(match[1]) : validUpstreamStatus ?? timeoutStatus ?? 502;
  if (status < 400 || status > 599) { return false; }
  // HTTP 402 is an upstream HTTP error even if an older envelope mislabeled it.
  const effectiveCategory = status === 402 && category === "TIMEOUT" ? "UPSTREAM_HTTP_ERROR" : category;
  const code = effectiveCategory !== category ? "UPSTREAM_HTTP_402"
    : typeof details.code === "string" && CODE.test(details.code) ? details.code : category;
  const metadata: M10GatewayError = {
    request_id: boundary.requestId,
    category: effectiveCategory,
    code,
    retryable: details.retryable === true,
    http_status: status,
    ...(validUpstreamStatus !== undefined ? { upstream_status: validUpstreamStatus } : {}),
    ...(details.terminal === true ? { terminal: true } : {}),
    ...(details.partial === true ? { partial: true } : {}),
    ...(validTimeoutSource ? { timeout_source: validTimeoutSource } : {}),
  };
  const gatewayRequestId = typeof source.request_id === "string" ? source.request_id
    : typeof details.request_id === "string" ? details.request_id : undefined;
  if (gatewayRequestId && REQUEST_ID.test(gatewayRequestId)) {
    metadata.gateway_request_id = gatewayRequestId;
  }
  for (const key of ["provider", "model"] as const) {
    const value = details[key];
    if (typeof value === "string" && /^[A-Za-z0-9._:/-]{1,120}$/.test(value)) {
      metadata[key] = value;
    }
  }
  boundary.delivered = true;
  boundary.onError(metadata);
  return true;
}
