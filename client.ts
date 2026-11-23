/**
 * Home Assistant REST 客户端（零第三方依赖，纯原生 fetch）。
 */

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export type HaErrorKind = "config" | "auth" | "http" | "network" | "timeout" | "cancelled";

export class HaRestError extends Error {
  readonly kind: HaErrorKind;
  readonly status?: number;

  constructor(message: string, kind: HaErrorKind, status?: number) {
    super(message);
    this.name = "HaRestError";
    this.kind = kind;
    this.status = status;
  }
}

export interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}

export interface HaApiInfo {
  message: string;
  version?: string;
  location_name?: string;
}

export interface HaClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  fetchImpl?: FetchImpl;
}

export const MAX_CAMERA_BYTES = 6 * 1024 * 1024;
const ERROR_BODY_LIMIT = 400;

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) throw new HaRestError("Home Assistant baseUrl is empty", "config");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new HaRestError(`Home Assistant baseUrl is not a valid URL: ${raw}`, "config");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HaRestError(`Home Assistant baseUrl must use http:// or https://, got ${url.protocol}`, "config");
  }
  return trimmed;
}

export function websocketUrl(baseUrl: string): string {
  const url = new URL(normalizeBaseUrl(baseUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/websocket`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class HaRestClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchImpl;

  constructor(options: HaClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.token = options.token;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  hasToken(): boolean {
    return this.token.length > 0;
  }

  async ping(signal?: AbortSignal): Promise<HaApiInfo> {
    const res = await this.request("/api/", { method: "GET" }, signal);
    return readJson<HaApiInfo>(res);
  }

  async getStates(signal?: AbortSignal): Promise<HaState[]> {
    const res = await this.request("/api/states", { method: "GET" }, signal);
    const body = await readJson<unknown>(res);
    if (!Array.isArray(body)) {
      throw new HaRestError("Home Assistant returned a non-array state list", "http", res.status);
    }
    return body.filter(isState);
  }

  async getState(entityId: string, signal?: AbortSignal): Promise<HaState> {
    const res = await this.request(`/api/states/${encodeURIComponent(entityId)}`, { method: "GET" }, signal);
    const body = await readJson<unknown>(res);
    if (!isState(body)) {
      throw new HaRestError(`Home Assistant returned an unexpected state for ${entityId}`, "http", res.status);
    }
    return body;
  }

  async callService(
    domain: string,
    service: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<HaState[]> {
    const res = await this.request(
      `/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      signal,
    );
    const raw = await readJson<unknown>(res);
    return Array.isArray(raw) ? raw.filter(isState) : [];
  }

  async getHistory(entityIds: readonly string[], startIso: string, signal?: AbortSignal): Promise<HaState[][]> {
    const filter = entityIds.join(",");
    const path = `/api/history/period/${encodeURIComponent(startIso)}?filter_entity_id=${filter}&minimal_response`;
    const res = await this.request(path, { method: "GET" }, signal);
    const raw = await readJson<unknown>(res);
    if (!Array.isArray(raw)) {
      throw new HaRestError("Home Assistant returned a non-array history", "http", res.status);
    }
    return raw.filter((group): group is unknown[] => Array.isArray(group)).map((group) => group.filter(isState));
  }

  async getCameraImage(entityId: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mime: string }> {
    const path = `/api/camera_proxy/${encodeURIComponent(entityId)}?time=${Date.now()}`;
    const res = await this.request(path, { method: "GET" }, signal);
    const mime = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (!mime.startsWith("image/")) {
      throw new HaRestError(
        `Home Assistant did not return an image for ${entityId} (content-type: ${mime || "none"})`,
        "http",
        res.status,
      );
    }
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_CAMERA_BYTES) {
      throw new HaRestError(
        `Camera snapshot is ${Math.round(buffer.byteLength / 1024)} KB, above the ${Math.round(MAX_CAMERA_BYTES / 1024)} KB limit`,
        "http",
        res.status,
      );
    }
    return { bytes: new Uint8Array(buffer), mime };
  }

  private headers(extra?: RequestInit["headers"]): Headers {
    const headers = new Headers(extra);
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    headers.set("Accept", "application/json");
    return headers;
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: this.headers(init.headers),
        signal: combined,
      });
    } catch (error) {
      if (signal?.aborted) throw new HaRestError("Home Assistant request was cancelled", "cancelled");
      if (isTimeout(error)) {
        throw new HaRestError(
          `Home Assistant at ${this.baseUrl} did not answer within ${this.timeoutMs} ms`,
          "timeout",
        );
      }
      throw new HaRestError(`Cannot reach Home Assistant at ${this.baseUrl}: ${describeError(error)}`, "network");
    }
    if (!res.ok) throw await this.httpError(res);
    return res;
  }

  private async httpError(res: Response): Promise<HaRestError> {
    const detail = await res.text().catch(() => "");
    const trimmed = detail.trim().slice(0, ERROR_BODY_LIMIT);
    if (res.status === 401 || res.status === 403) {
      return new HaRestError(
        `Home Assistant rejected the token (HTTP ${res.status})${trimmed ? `: ${trimmed}` : ""}`,
        "auth",
        res.status,
      );
    }
    if (res.status === 404) {
      return new HaRestError(
        `Home Assistant does not know that entity or endpoint (HTTP 404)${trimmed ? `: ${trimmed}` : ""}`,
        "http",
        res.status,
      );
    }
    return new HaRestError(
      `Home Assistant returned HTTP ${res.status}${trimmed ? `: ${trimmed}` : ""}`,
      "http",
      res.status,
    );
  }
}

function isState(value: unknown): value is HaState {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.entity_id === "string" && typeof record.state === "string";
}

async function readJson<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new HaRestError("Home Assistant returned a body that is not JSON", "http", res.status);
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}
