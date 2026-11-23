/**
 * Home Assistant 区域索引。
 * 区域只出现在 WebSocket 的 config 注册表命令里；REST /api/states 不带。
 * 实体优先用自己登记的区域，没有时回落到所属设备的区域。
 */

export interface HaAreaEntry {
  area_id: string;
  name?: string;
}

export interface HaDeviceEntry {
  id: string;
  area_id?: string | null;
}

export interface HaEntityEntry {
  entity_id: string;
  area_id?: string | null;
  device_id?: string | null;
}

export interface AreaIndex {
  areaNameById: Map<string, string>;
  areaIdByEntity: Map<string, string>;
}

export const EMPTY_AREA_INDEX: AreaIndex = {
  areaNameById: new Map(),
  areaIdByEntity: new Map(),
};

export function buildAreaIndex(
  areas: readonly HaAreaEntry[],
  devices: readonly HaDeviceEntry[],
  entities: readonly HaEntityEntry[],
): AreaIndex {
  const areaNameById = new Map<string, string>();
  for (const area of areas) {
    if (typeof area?.area_id !== "string" || !area.area_id) continue;
    const name = typeof area.name === "string" && area.name.trim() ? area.name.trim() : area.area_id;
    areaNameById.set(area.area_id, name);
  }

  const deviceArea = new Map<string, string>();
  for (const device of devices) {
    if (typeof device?.id !== "string" || !device.id) continue;
    if (typeof device.area_id === "string" && device.area_id) deviceArea.set(device.id, device.area_id);
  }

  const areaIdByEntity = new Map<string, string>();
  for (const entity of entities) {
    if (typeof entity?.entity_id !== "string" || !entity.entity_id) continue;
    const direct = typeof entity.area_id === "string" && entity.area_id ? entity.area_id : null;
    const viaDevice =
      typeof entity.device_id === "string" && entity.device_id ? deviceArea.get(entity.device_id) ?? null : null;
    const areaId = direct ?? viaDevice;
    if (areaId && areaNameById.has(areaId)) areaIdByEntity.set(entity.entity_id, areaId);
  }

  return { areaNameById, areaIdByEntity };
}
