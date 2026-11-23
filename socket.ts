/**
 * Home Assistant WebSocket 订阅：认证、订阅 state_changed、断线重连。
 */
import type { HaState } from "./client.ts";
import { websocketUrl } from "./client.ts";

export type HaSocketStatus = "connecting" | "online" | "reconnecting" | "auth-failed" | "stopped";

export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: string,
    listener: (event: { data?: unknown; code?: number; reason?: string; message?: string }) => void,
  ): void;
}

export interface StateChangedPayload {
  entity_id: string;
  old_state: HaState | null;
  new_state: HaState | null;
}

export interface HaSocketOptions {
  baseUrl: string;
  token: string;
  onStateChanged(payload: StateChangedPayload): void;
  onStatus(status: HaSocketStatus, detail?: string): void;
  createSocket?: (url: string) => SocketLike;
  initialDelayMs?: number;
  maxDelayMs?: number;
  authTimeoutMs?: number;
}

const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 60_000;
const DEFAULT_AUTH_TIMEOUT_MS = 15_000;

export class HaSocket {
  private readonly options: HaSocketOptions;
  private socket: SocketLike | null = null;
  private started = false;
  private authFailed = false;
  private attempt = 0;
  private nextId = 1;
  private subscribeId: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private current: HaSocketStatus = "stopped";
  private haVersion: string | undefined;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(options: HaSocketOptions) {
    this.options = options;
  }

  get status(): HaSocketStatus {
    return this.current;
  }

  get version(): string | undefined {
    return this.haVersion;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.authFailed = false;
    this.attempt = 0;
    this.connect();
  }

  request<T = unknown>(type: string, payload: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
    if (!this.socket || this.current !== "online") {
      return Promise.reject(new Error("Home Assistant WebSocket is not connected"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`WebSocket request ${type} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.send({ id, type, ...payload });
    });
  }

  stop(): void {
    this.started = false;
    this.clearReconnect();
    this.clearAuthTimer();
    this.rejectPending("Home Assistant WebSocket stopped");
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close(1000, "stopped");
      } catch {
        /* ignore */
      }
    }
    this.setStatus("stopped");
  }

  private connect(): void {
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    let socket: SocketLike;
    try {
      socket = (this.options.createSocket ?? defaultCreateSocket)(websocketUrl(this.options.baseUrl));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => this.armAuthTimer());
    socket.addEventListener("message", (event) => this.onMessage(event.data));
    socket.addEventListener("close", () => {
      this.socket = null;
      this.clearAuthTimer();
      this.rejectPending("Home Assistant WebSocket closed");
      if (!this.started || this.authFailed) return;
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      /* close event handles reconnect */
    });
  }

  private onMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (message.type) {
      case "auth_required":
        this.send({ type: "auth", access_token: this.options.token });
        break;
      case "auth_ok":
        this.clearAuthTimer();
        this.attempt = 0;
        if (typeof message.ha_version === "string") this.haVersion = message.ha_version;
        this.setStatus("online", this.haVersion ? `HA ${this.haVersion}` : undefined);
        this.subscribe();
        break;
      case "auth_invalid":
        this.clearAuthTimer();
        this.authFailed = true;
        this.rejectPending("Home Assistant rejected the token");
        this.setStatus("auth-failed", typeof message.message === "string" ? message.message : undefined);
        this.socket?.close(1000, "auth_invalid");
        break;
      case "result": {
        const id = typeof message.id === "number" ? message.id : null;
        if (id === null) break;
        const entry = this.pending.get(id);
        if (!entry) break;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        if (message.success) {
          entry.resolve(message.result);
        } else {
          const err = message.error as { message?: string } | undefined;
          entry.reject(new Error(err?.message ?? "WebSocket command failed"));
        }
        break;
      }
      case "event": {
        if (this.subscribeId !== null && message.id !== this.subscribeId) break;
        const ev = message.event as { event_type?: string; data?: unknown } | undefined;
        if (ev?.event_type === "state_changed" && ev.data && typeof ev.data === "object") {
          const data = ev.data as { entity_id?: unknown; old_state?: unknown; new_state?: unknown };
          if (typeof data.entity_id === "string") {
            this.options.onStateChanged({
              entity_id: data.entity_id,
              old_state: (data.old_state as HaState | null) ?? null,
              new_state: (data.new_state as HaState | null) ?? null,
            });
          }
        }
        break;
      }
    }
  }

  private subscribe(): void {
    const id = this.nextId++;
    this.subscribeId = id;
    this.send({ id, type: "subscribe_events", event_type: "state_changed" });
  }

  private send(payload: Record<string, unknown>): void {
    try {
      this.socket?.send(JSON.stringify(payload));
    } catch {
      /* ignore */
    }
  }

  private armAuthTimer(): void {
    this.clearAuthTimer();
    const timeoutMs = this.options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
    this.authTimer = setTimeout(() => {
      this.socket?.close(4000, "auth timeout");
    }, timeoutMs);
    this.authTimer.unref?.();
  }

  private clearAuthTimer(): void {
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) return;
    const base = this.options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    const max = this.options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    const delay = Math.min(max, base * Math.pow(2, this.attempt));
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.started) this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private rejectPending(reason: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  private setStatus(status: HaSocketStatus, detail?: string): void {
    this.current = status;
    this.options.onStatus(status, detail);
  }
}

function defaultCreateSocket(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}
