/**
 * Home Assistant MSP World：
 * - 工具：ha_areas, ha_states, ha_get, ha_service, ha_history, ha_camera
 * - 信号：hass.state_changed, hass.status
 */
import { ToolResult, imageContent, type MSPNode } from "../shared/msp.ts";
import { HaRestClient, describeError, type FetchImpl, type HaState } from "./client.ts";
import { HaSocket, type HaSocketStatus, type SocketLike, type StateChangedPayload } from "./socket.ts";
import {
  EMPTY_AREA_INDEX,
  buildAreaIndex,
  type AreaIndex,
  type HaAreaEntry,
  type HaDeviceEntry,
  type HaEntityEntry,
} from "./registry.ts";

export const HARD_DENIED_DOMAINS: ReadonlySet<string> = new Set([
  "shell_command",
  "python_script",
  "hassio",
  "homeassistant",
  "recorder",
  "logger",
  "system_log",
]);

export const DEFAULT_ALLOWED_DOMAINS = [
  "light",
  "switch",
  "scene",
  "script",
  "climate",
  "cover",
  "fan",
];

const ENTITY_ID = /^[a-z_]+\.[a-z0-9_]+$/;
const DOMAIN = /^[a-z_]+$/;
const SERVICE = /^[a-z0-9_]+$/;

const STATES_DEFAULT_LIMIT = 30;
const STATES_MAX_LIMIT = 100;
const GET_MAX_IDS = 20;
const SERVICE_MAX_IDS = 20;
const HISTORY_MAX_HOURS = 168;
const HISTORY_MAX_POINTS = 60;

const DOMAIN_PRIORITY = new Map<string, number>(
  [
    "light",
    "switch",
    "scene",
    "script",
    "climate",
    "cover",
    "fan",
    "media_player",
    "lock",
    "vacuum",
    "humidifier",
    "water_heater",
    "camera",
    "number",
    "select",
  ].map((d, i) => [d, i]),
);

export interface HassConfig {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  allowedDomains?: string[];
  watchEntities?: string[];
  eventCooldownSeconds?: number;
  enableSocket?: boolean;
}

export interface HassWorldOptions {
  config: HassConfig;
  fetchImpl?: FetchImpl;
  createSocket?: (url: string) => SocketLike;
  now?: () => number;
}

export class HassWorld {
  private readonly cfg: Required<HassConfig>;
  private readonly client: HaRestClient;
  private readonly socket: HaSocket | null;
  private readonly now: () => number;
  private areaIndex: AreaIndex = EMPTY_AREA_INDEX;
  private loadingAreas = false;
  private readonly lastPush = new Map<string, number>();
  private node: MSPNode | null = null;

  constructor(options: HassWorldOptions) {
    this.now = options.now ?? Date.now;
    this.cfg = {
      baseUrl: options.config.baseUrl,
      token: options.config.token,
      timeoutMs: options.config.timeoutMs ?? 10_000,
      allowedDomains: options.config.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS,
      watchEntities: options.config.watchEntities ?? [],
      eventCooldownSeconds: options.config.eventCooldownSeconds ?? 30,
      enableSocket: options.config.enableSocket ?? true,
    };
    this.client = new HaRestClient({
      baseUrl: this.cfg.baseUrl,
      token: this.cfg.token,
      timeoutMs: this.cfg.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
    this.socket =
      this.cfg.enableSocket && this.cfg.token
        ? new HaSocket({
            baseUrl: this.cfg.baseUrl,
            token: this.cfg.token,
            createSocket: options.createSocket,
            onStateChanged: (payload) => this.handleStateChanged(payload),
            onStatus: (status, detail) => this.handleSocketStatus(status, detail),
          })
        : null;
  }

  attach(node: MSPNode): void {
    this.node = node;
    node.declareSignal("hass.state_changed", "Home Assistant 监听实体状态变化");
    node.declareSignal("hass.status", "Home Assistant WebSocket 连接状态变化");

    node.tool(
      "ha_areas",
      "列出 Home Assistant 已知区域（房间）及每个区域的实体数量",
      async () => this.toolAreas(),
      { type: "object", additionalProperties: false, properties: {} },
    );

    node.tool(
      "ha_states",
      "列出 Home Assistant 实体与当前状态，可按区域、域和关键词筛选",
      async (args) => this.toolStates(args),
      {
        type: "object",
        additionalProperties: false,
        properties: {
          area: { type: "string", description: "区域名或 area_id" },
          domain: { type: "string", description: "实体域，例如 light, switch, sensor, climate, camera" },
          query: { type: "string", description: "匹配 entity_id 或 friendly_name 的子串" },
          limit: { type: "integer", minimum: 1, maximum: STATES_MAX_LIMIT, default: STATES_DEFAULT_LIMIT },
        },
      },
    );

    node.tool(
      "ha_get",
      "按 entity_id 读取指定实体的完整状态与属性",
      async (args) => this.toolGet(args),
      {
        type: "object",
        additionalProperties: false,
        properties: {
          entity_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: GET_MAX_IDS },
        },
        required: ["entity_ids"],
      },
    );

    node.tool(
      "ha_service",
      "调用白名单内的 Home Assistant 服务控制设备（如 light.turn_on），必须指定 entity_id",
      async (args) => this.toolService(args),
      {
        type: "object",
        additionalProperties: false,
        properties: {
          domain: { type: "string" },
          service: { type: "string" },
          entity_id: { type: ["string", "array"], items: { type: "string" } },
          data: { type: "object", additionalProperties: true },
        },
        required: ["domain", "service", "entity_id"],
      },
    );

    node.tool(
      "ha_history",
      "读取指定实体最近一段时间的历史状态变化",
      async (args) => this.toolHistory(args),
      {
        type: "object",
        additionalProperties: false,
        properties: {
          entity_id: { type: "string" },
          hours: { type: "integer", minimum: 1, maximum: HISTORY_MAX_HOURS, default: 24 },
        },
        required: ["entity_id"],
      },
    );

    node.tool(
      "ha_camera",
      "抓取摄像头实体的当前画面快照（返回 mime 与 base64）",
      async (args) => this.toolCamera(args),
      {
        type: "object",
        additionalProperties: false,
        properties: {
          entity_id: { type: "string" },
        },
        required: ["entity_id"],
      },
    );

    node.skill({
      name: "control_device_safely",
      summary: "先查区域与实体 ID，再调用白名单服务控制设备",
      whenToUse: "需要开关灯光、插座、空调或触发场景时使用，严禁凭空猜测 entity_id",
      toolsUsed: ["ha_areas", "ha_states", "ha_get", "ha_service"],
    });
  }

  start(): void {
    this.socket?.start();
  }

  stop(): void {
    this.socket?.stop();
  }

  private assertToken(): void {
    if (!this.client.hasToken()) {
      throw new Error("未配置 Home Assistant Token（请设置 HASS_TOKEN）");
    }
  }

  private async refreshAreasIfNeeded(): Promise<void> {
    if (!this.socket || this.socket.status !== "online" || this.loadingAreas) return;
    if (this.areaIndex.areaNameById.size > 0) return;
    this.loadingAreas = true;
    try {
      const [areas, devices, entities] = await Promise.all([
        this.socket.request<HaAreaEntry[]>("config/area_registry/list"),
        this.socket.request<HaDeviceEntry[]>("config/device_registry/list"),
        this.socket.request<HaEntityEntry[]>("config/entity_registry/list"),
      ]);
      this.areaIndex = buildAreaIndex(
        Array.isArray(areas) ? areas : [],
        Array.isArray(devices) ? devices : [],
        Array.isArray(entities) ? entities : [],
      );
    } catch {
      /* 区域索引可选，失败不影响核心工具 */
    } finally {
      this.loadingAreas = false;
    }
  }

  private areaNameOf(entityId: string): string | undefined {
    const areaId = this.areaIndex.areaIdByEntity.get(entityId);
    return areaId ? this.areaIndex.areaNameById.get(areaId) : undefined;
  }

  private async toolAreas(): Promise<Record<string, unknown>> {
    this.assertToken();
    await this.refreshAreasIfNeeded();
    const counts = new Map<string, number>();
    for (const areaId of this.areaIndex.areaIdByEntity.values()) {
      counts.set(areaId, (counts.get(areaId) ?? 0) + 1);
    }
    const areas = [...this.areaIndex.areaNameById.entries()].map(([area_id, name]) => ({
      area_id,
      name,
      entity_count: counts.get(area_id) ?? 0,
    }));
    return { areas, total: areas.length };
  }

  private async toolStates(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.assertToken();
    await this.refreshAreasIfNeeded();
    const states = await this.client.getStates();
    const areaFilter = typeof args.area === "string" ? args.area.trim().toLowerCase() : "";
    const domainFilter = typeof args.domain === "string" ? args.domain.trim().toLowerCase() : "";
    const queryFilter = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
    const limit =
      typeof args.limit === "number" && Number.isInteger(args.limit)
        ? Math.min(Math.max(args.limit, 1), STATES_MAX_LIMIT)
        : STATES_DEFAULT_LIMIT;

    const matched = states.filter((st) => {
      const domain = st.entity_id.split(".")[0] ?? "";
      if (domainFilter && domain !== domainFilter) return false;
      if (areaFilter) {
        const areaId = this.areaIndex.areaIdByEntity.get(st.entity_id)?.toLowerCase() ?? "";
        const areaName = this.areaNameOf(st.entity_id)?.toLowerCase() ?? "";
        if (!areaId.includes(areaFilter) && !areaName.includes(areaFilter)) return false;
      }
      if (queryFilter) {
        const friendly = typeof st.attributes?.friendly_name === "string" ? st.attributes.friendly_name.toLowerCase() : "";
        if (!st.entity_id.toLowerCase().includes(queryFilter) && !friendly.includes(queryFilter)) return false;
      }
      return true;
    });

    matched.sort((a, b) => {
      const da = DOMAIN_PRIORITY.get(a.entity_id.split(".")[0] ?? "") ?? 999;
      const db = DOMAIN_PRIORITY.get(b.entity_id.split(".")[0] ?? "") ?? 999;
      if (da !== db) return da - db;
      return a.entity_id.localeCompare(b.entity_id);
    });

    const items = matched.slice(0, limit).map((st) => ({
      entity_id: st.entity_id,
      state: st.state,
      friendly_name: st.attributes?.friendly_name ?? null,
      area: this.areaNameOf(st.entity_id) ?? null,
      last_changed: st.last_changed ?? null,
    }));

    return { total_matched: matched.length, returned: items.length, entities: items };
  }

  private async toolGet(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.assertToken();
    const rawIds = Array.isArray(args.entity_ids) ? args.entity_ids : [];
    const ids = rawIds
      .filter((x): x is string => typeof x === "string" && ENTITY_ID.test(x.trim()))
      .map((x) => x.trim())
      .slice(0, GET_MAX_IDS);
    if (ids.length === 0) throw new Error("请提供至少一个有效的 entity_id");

    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          const st = await this.client.getState(id);
          return { ...st, area: this.areaNameOf(id) ?? null };
        } catch (err) {
          return { entity_id: id, error: describeError(err) };
        }
      }),
    );
    return { entities: results };
  }

  private async toolService(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.assertToken();
    const domain = typeof args.domain === "string" ? args.domain.trim().toLowerCase() : "";
    const service = typeof args.service === "string" ? args.service.trim().toLowerCase() : "";
    if (!DOMAIN.test(domain) || !SERVICE.test(service)) {
      throw new Error("非法的 domain 或 service 名称");
    }
    if (HARD_DENIED_DOMAINS.has(domain)) {
      throw new Error(`安全策略拒绝调用高危域: ${domain}`);
    }
    const allowed = new Set(this.cfg.allowedDomains.map((d) => d.trim().toLowerCase()).filter(Boolean));
    if (!allowed.has(domain)) {
      throw new Error(`域 ${domain} 不在允许列表 (${[...allowed].join(", ")}) 中`);
    }

    const rawEntity = args.entity_id;
    const entityIds = (Array.isArray(rawEntity) ? rawEntity : [rawEntity])
      .filter((x): x is string => typeof x === "string" && ENTITY_ID.test(x.trim()))
      .map((x) => x.trim())
      .slice(0, SERVICE_MAX_IDS);
    if (entityIds.length === 0) {
      throw new Error("必须提供至少一个有效的 entity_id");
    }
    for (const eid of entityIds) {
      const eDomain = eid.split(".")[0] ?? "";
      if (domain !== "scene" && domain !== "script" && domain !== "homeassistant" && eDomain !== domain) {
        throw new Error(`entity_id ${eid} 与服务域 ${domain} 不匹配`);
      }
    }

    const extraData =
      args.data && typeof args.data === "object" && !Array.isArray(args.data)
        ? (args.data as Record<string, unknown>)
        : {};
    const body: Record<string, unknown> = {
      ...extraData,
      entity_id: entityIds.length === 1 ? entityIds[0] : entityIds,
    };

    const changed = await this.client.callService(domain, service, body);
    return {
      called: `${domain}.${service}`,
      entity_ids: entityIds,
      changed_states: changed.map((s) => ({ entity_id: s.entity_id, state: s.state, attributes: s.attributes })),
    };
  }

  private async toolHistory(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.assertToken();
    const entityId = typeof args.entity_id === "string" ? args.entity_id.trim() : "";
    if (!ENTITY_ID.test(entityId)) throw new Error("请提供有效的 entity_id");
    const hours =
      typeof args.hours === "number" && Number.isInteger(args.hours)
        ? Math.min(Math.max(args.hours, 1), HISTORY_MAX_HOURS)
        : 24;
    const startIso = new Date(this.now() - hours * 3600_000).toISOString();
    const groups = await this.client.getHistory([entityId], startIso);
    const points = (groups[0] ?? []).slice(-HISTORY_MAX_POINTS).map((p) => ({
      state: p.state,
      last_changed: p.last_changed ?? p.last_updated ?? null,
    }));
    return { entity_id: entityId, hours, count: points.length, history: points };
  }

  private async toolCamera(args: Record<string, unknown>): Promise<ToolResult> {
    this.assertToken();
    const entityId = typeof args.entity_id === "string" ? args.entity_id.trim() : "";
    if (!ENTITY_ID.test(entityId) || !entityId.startsWith("camera.")) {
      throw new Error("请提供 camera.* 域的 entity_id");
    }
    const { bytes, mime } = await this.client.getCameraImage(entityId);
    const b64 = Buffer.from(bytes).toString("base64");
    return new ToolResult([imageContent(b64, mime)], {
      entity_id: entityId,
      mime,
      byte_length: bytes.byteLength,
    });
  }

  private handleSocketStatus(status: HaSocketStatus, detail?: string): void {
    this.node?.publish("hass.status", { status, detail: detail ?? null });
    if (status === "online") {
      void this.refreshAreasIfNeeded();
    }
  }

  private handleStateChanged(payload: StateChangedPayload): void {
    if (!this.node) return;
    if (!this.matchesWatch(payload.entity_id)) return;
    const oldState = payload.old_state?.state ?? null;
    const newState = payload.new_state?.state ?? null;
    if (oldState === newState) return;

    const nowMs = this.now();
    const cooldownMs = Math.max(0, this.cfg.eventCooldownSeconds) * 1000;
    const prevPush = this.lastPush.get(payload.entity_id);
    if (prevPush !== undefined && nowMs - prevPush < cooldownMs) return;
    this.lastPush.set(payload.entity_id, nowMs);

    this.node.publish("hass.state_changed", {
      entity_id: payload.entity_id,
      friendly_name: payload.new_state?.attributes?.friendly_name ?? null,
      area: this.areaNameOf(payload.entity_id) ?? null,
      old_state: oldState,
      new_state: newState,
      last_changed: payload.new_state?.last_changed ?? null,
    });
  }

  private matchesWatch(entityId: string): boolean {
    if (this.cfg.watchEntities.length === 0) return false;
    return this.cfg.watchEntities.some((pattern) => {
      const p = pattern.trim();
      if (!p) return false;
      if (p === "*") return true;
      if (p.endsWith(".*")) {
        return entityId.startsWith(p.slice(0, -1));
      }
      return entityId === p;
    });
  }
}
