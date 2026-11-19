import { nowIso } from "./state";

/**
 * 设备/库房运行状态和两类警报的共享登记处。
 *
 * 背景 PLC 监测线程、用户链路 scheduler/master/xiaoke 都会读写这里，
 * 因此它独立于某个 LangGraph thread 的 State。
 * 警报只能通过显式的库内人员操作解除，不会自动清除。
 */

export const DEFAULT_ROOM_ID = "A区1号冷库";
export const DEFAULT_UNIT_ID = "1号机组";
export const DEFAULT_ROOM_CODE = "A1";

export interface DeviceAlarmInfo {
  alarmId: string;
  type: "device";
  roomId: string;
  unitId: string;
  detectedAt: string;
  reason: string;
  windowStart: string;
  windowEnd: string;
  sampleCount: number;
  pushed: boolean;
}

export interface CopAlarmInfo {
  alarmId: string;
  type: "cop";
  roomId: string;
  createdAt: string;
  reason: string;
  mode: "estimate" | "formal";
  retryCount: number;
}

export interface EquipmentSnapshot {
  roomId: string;
  unitId: string;
  status: "normal" | "abnormal";
  deviceAlarm: DeviceAlarmInfo | null;
  copAlarm: CopAlarmInfo | null;
  lastDeviceClearedAt: string | null;
}

export type RoomOccupancy = "available" | "occupied";

export interface ColdRoomInfo {
  roomCode: string;
  roomName: string;
  areaCode: string;
  roomNumber: number;
  roomId: string;
  unitId: string;
  tempMin: number;
  tempMax: number;
  tempText: string;
  humidity: string;
  capacityTons: number;
  suitableFruits: string[];
  occupancy: RoomOccupancy;
  unitStatus: "normal" | "abnormal";
  deviceAlarmReason: string;
  bookable: boolean;
}

interface RoomSeed {
  roomCode: string;
  areaCode: string;
  roomNumber: number;
  unitId: string;
  tempMin: number;
  tempMax: number;
  tempText: string;
  humidity: string;
  capacityTons: number;
  suitableFruits: string[];
  initialOccupancy?: RoomOccupancy;
}

const ROOM_SEEDS: RoomSeed[] = [
  {
    roomCode: "A1",
    areaCode: "A",
    roomNumber: 1,
    unitId: "1号机组",
    tempMin: 0.5,
    tempMax: 2,
    tempText: "0.5~2°C",
    humidity: "90%",
    capacityTons: 400,
    suitableFruits: ["杨梅"],
  },
  {
    roomCode: "A2",
    areaCode: "A",
    roomNumber: 2,
    unitId: "1号机组",
    tempMin: 0.5,
    tempMax: 2,
    tempText: "0.5~2°C",
    humidity: "90%",
    capacityTons: 400,
    suitableFruits: ["杨梅"],
  },
  {
    roomCode: "B1",
    areaCode: "B",
    roomNumber: 1,
    unitId: "2号机组",
    tempMin: 5,
    tempMax: 10,
    tempText: "5~10°C",
    humidity: "85%",
    capacityTons: 300,
    suitableFruits: ["柚子"],
  },
  {
    roomCode: "B2",
    areaCode: "B",
    roomNumber: 2,
    unitId: "2号机组",
    tempMin: 5,
    tempMax: 10,
    tempText: "5~10°C",
    humidity: "85%",
    capacityTons: 300,
    suitableFruits: ["柚子"],
    initialOccupancy: "occupied",
  },
  {
    roomCode: "C1",
    areaCode: "C",
    roomNumber: 1,
    unitId: "3号机组",
    tempMin: -1,
    tempMax: 0,
    tempText: "-1~0°C",
    humidity: "90%",
    capacityTons: 300,
    suitableFruits: ["苹果"],
  },
  {
    roomCode: "C2",
    areaCode: "C",
    roomNumber: 2,
    unitId: "3号机组",
    tempMin: -1,
    tempMax: 0,
    tempText: "-1~0°C",
    humidity: "90%",
    capacityTons: 300,
    suitableFruits: ["苹果"],
  },
];

interface RuntimeState {
  status: "normal" | "abnormal";
  deviceAlarm: DeviceAlarmInfo | null;
  copAlarm: CopAlarmInfo | null;
  lastDeviceClearedAt: string | null;
  lastDeviceClearedEpochMs: number;
  occupancies: Map<string, RoomOccupancy>;
}

function createInitialOccupancies(): Map<string, RoomOccupancy> {
  return new Map(
    ROOM_SEEDS.map((room) => [
      room.roomCode,
      room.initialOccupancy ?? "available",
    ]),
  );
}

const runtime: RuntimeState = {
  status: "normal",
  deviceAlarm: null,
  copAlarm: null,
  lastDeviceClearedAt: null,
  lastDeviceClearedEpochMs: 0,
  occupancies: createInitialOccupancies(),
};

export function formatRoomName(roomCode: string): string {
  const code = String(roomCode ?? "").trim().toUpperCase();
  const matched = /^([A-Z])(\d{1,3})$/.exec(code);
  if (!matched) return code || "-";
  return `${matched[1]}区${Number(matched[2])}号冷库`;
}

function normalizeRoomCode(roomCode: string): string {
  return String(roomCode ?? "").trim().toUpperCase();
}

function unitStatusFor(unitId: string): "normal" | "abnormal" {
  if (
    runtime.status === "abnormal" &&
    runtime.deviceAlarm &&
    runtime.deviceAlarm.unitId === unitId
  ) {
    return "abnormal";
  }
  return "normal";
}

export function queryRoomInventoryFromXiaoke(): ColdRoomInfo[] {
  return ROOM_SEEDS.map((room) => {
    const occupancy = runtime.occupancies.get(room.roomCode) ?? "available";
    const unitStatus = unitStatusFor(room.unitId);
    const deviceAlarmReason =
      unitStatus === "abnormal" ? runtime.deviceAlarm?.reason ?? "" : "";
    return {
      roomCode: room.roomCode,
      roomName: formatRoomName(room.roomCode),
      areaCode: room.areaCode,
      roomNumber: room.roomNumber,
      roomId: formatRoomName(room.roomCode),
      unitId: room.unitId,
      tempMin: room.tempMin,
      tempMax: room.tempMax,
      tempText: room.tempText,
      humidity: room.humidity,
      capacityTons: room.capacityTons,
      suitableFruits: [...room.suitableFruits],
      occupancy,
      unitStatus,
      deviceAlarmReason,
      bookable: occupancy === "available" && unitStatus === "normal",
    };
  });
}

export function getRoomInfo(roomCode: string): ColdRoomInfo | null {
  const code = normalizeRoomCode(roomCode);
  return (
    queryRoomInventoryFromXiaoke().find((room) => room.roomCode === code) ??
    null
  );
}

export function markRoomOccupied(roomCode: string): boolean {
  const code = normalizeRoomCode(roomCode);
  const room = ROOM_SEEDS.find((item) => item.roomCode === code);
  if (!room) return false;
  runtime.occupancies.set(code, "occupied");
  return true;
}

export function releaseRoomOccupancy(roomCode: string): boolean {
  const code = normalizeRoomCode(roomCode);
  const room = ROOM_SEEDS.find((item) => item.roomCode === code);
  if (!room) return false;
  runtime.occupancies.set(code, "available");
  return true;
}

export function getEquipmentSnapshot(): EquipmentSnapshot {
  return {
    roomId: DEFAULT_ROOM_ID,
    unitId: DEFAULT_UNIT_ID,
    status: runtime.status,
    deviceAlarm: runtime.deviceAlarm
      ? { ...runtime.deviceAlarm }
      : null,
    copAlarm: runtime.copAlarm ? { ...runtime.copAlarm } : null,
    lastDeviceClearedAt: runtime.lastDeviceClearedAt,
  };
}

/** scheduler 处理新预约前向小柯查询候选库房状态。 */
export function queryRoomStatusFromXiaoke(roomCode = DEFAULT_ROOM_CODE): {
  roomId: string;
  unitId: string;
  allowed: boolean;
  status: "normal" | "abnormal" | "occupied";
  reason: string;
} {
  const room = getRoomInfo(roomCode);
  if (!room) {
    return {
      roomId: formatRoomName(roomCode),
      unitId: DEFAULT_UNIT_ID,
      allowed: false,
      status: "abnormal",
      reason: "库房不存在",
    };
  }
  return {
    roomId: room.roomId,
    unitId: room.unitId,
    allowed: room.bookable,
    status:
      room.unitStatus === "abnormal"
        ? "abnormal"
        : room.occupancy === "occupied"
          ? "occupied"
          : "normal",
    reason:
      room.unitStatus === "abnormal"
        ? room.deviceAlarmReason || "机组异常"
        : room.occupancy === "occupied"
          ? "库房已被占用"
          : "",
  };
}

export function getLastDeviceClearEpochMs(): number {
  return runtime.lastDeviceClearedEpochMs;
}

export function markDeviceAbnormal(input: {
  reason: string;
  windowStart: string;
  windowEnd: string;
  sampleCount: number;
  roomCode?: string;
  unitId?: string;
}): DeviceAlarmInfo {
  if (runtime.status === "abnormal" && runtime.deviceAlarm) {
    return { ...runtime.deviceAlarm };
  }
  const roomCode = input.roomCode || DEFAULT_ROOM_CODE;
  const room = getRoomInfo(roomCode);
  const unitId = input.unitId || room?.unitId || DEFAULT_UNIT_ID;
  const alarm: DeviceAlarmInfo = {
    alarmId: `DEV-${Date.now()}`,
    type: "device",
    roomId: room?.roomId ?? formatRoomName(roomCode),
    unitId,
    detectedAt: nowIso(),
    reason: input.reason,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    sampleCount: input.sampleCount,
    pushed: false,
  };
  runtime.status = "abnormal";
  runtime.deviceAlarm = alarm;
  return { ...alarm };
}

export function markDeviceAlarmPushed(): void {
  if (runtime.deviceAlarm) {
    runtime.deviceAlarm.pushed = true;
  }
}

export function getDeviceAlarm(): DeviceAlarmInfo | null {
  return runtime.deviceAlarm ? { ...runtime.deviceAlarm } : null;
}

export function hasDeviceAbnormal(): boolean {
  return runtime.status === "abnormal";
}

export function clearDeviceAbnormal(): boolean {
  if (runtime.status !== "abnormal" && !runtime.deviceAlarm) {
    return false;
  }
  runtime.status = "normal";
  runtime.deviceAlarm = null;
  runtime.lastDeviceClearedAt = nowIso();
  runtime.lastDeviceClearedEpochMs = Date.now();
  return true;
}

export function createCopAlarm(input: {
  reason: string;
  mode: "estimate" | "formal";
  retryCount: number;
}): CopAlarmInfo {
  if (runtime.copAlarm) {
    return { ...runtime.copAlarm };
  }
  const alarm: CopAlarmInfo = {
    alarmId: `COP-ALARM-${Date.now()}`,
    type: "cop",
    roomId: DEFAULT_ROOM_ID,
    createdAt: nowIso(),
    reason: input.reason,
    mode: input.mode,
    retryCount: input.retryCount,
  };
  runtime.copAlarm = alarm;
  return { ...alarm };
}

export function getCopAlarm(): CopAlarmInfo | null {
  return runtime.copAlarm ? { ...runtime.copAlarm } : null;
}

export function hasCopAlarm(): boolean {
  return Boolean(runtime.copAlarm);
}

export function clearCopAlarm(): boolean {
  if (!runtime.copAlarm) return false;
  runtime.copAlarm = null;
  return true;
}

/** 测试或新进程初始化使用；正常业务不调用。 */
export function resetEquipmentRuntimeForTests(): void {
  runtime.status = "normal";
  runtime.deviceAlarm = null;
  runtime.copAlarm = null;
  runtime.lastDeviceClearedAt = null;
  runtime.lastDeviceClearedEpochMs = 0;
  runtime.occupancies = createInitialOccupancies();
}
