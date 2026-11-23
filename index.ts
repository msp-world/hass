/**
 * Home Assistant MSP 节点启动入口。
 *
 * 环境变量：
 *   HASS_URL             HA 地址（默认 http://homeassistant.local:8123）
 *   HASS_TOKEN           HA 长期访问令牌（Long-Lived Access Token）
 *   HASS_ALLOWED_DOMAINS 允许控制的域，逗号分隔（默认 light,switch,scene,script,climate,cover,fan）
 *   HASS_WATCH_ENTITIES  需要实时推送 hass.state_changed 的实体/通配，逗号分隔（如 light.*,binary_sensor.door）
 *   HASS_COOLDOWN_SEC    同一实体状态推送冷却秒数（默认 30）
 */
import { MSPNode, installShutdownHooks, mspOptionsFromEnv } from "../shared/msp.ts";
import { DEFAULT_ALLOWED_DOMAINS, HassWorld } from "./world.ts";

function splitCsv(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function startHassNode(): Promise<{ node: MSPNode; world: HassWorld }> {
  const node = new MSPNode(process.env.HASS_NODE_ID || "hass", mspOptionsFromEnv("HASS"));
  const allowed = splitCsv(process.env.HASS_ALLOWED_DOMAINS);
  const world = new HassWorld({
    config: {
      baseUrl: process.env.HASS_URL || "http://homeassistant.local:8123",
      token: process.env.HASS_TOKEN || "",
      allowedDomains: allowed.length > 0 ? allowed : DEFAULT_ALLOWED_DOMAINS,
      watchEntities: splitCsv(process.env.HASS_WATCH_ENTITIES),
      eventCooldownSeconds: process.env.HASS_COOLDOWN_SEC ? Number(process.env.HASS_COOLDOWN_SEC) : 30,
    },
  });

  world.attach(node);
  const ep = await node.start();
  world.start();
  console.log(`[hass] MSP node "${node.nodeId}" listening on ${ep.host}:${ep.port}`);
  return { node, world };
}

if (import.meta.main) {
  const { node, world } = await startHassNode();
  installShutdownHooks(() => {
    world.stop();
    node.stop();
  });
}
