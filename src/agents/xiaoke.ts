import {
  COP_MAX,
  COP_MIN,
  ColdStorageState,
  FRUIT_SPECS,
  GRID_EMISSION_FACTOR_KG_PER_KWH,
  logAgent,
  nowIso,
  recommendedStorageTempC,
  toNumber,
} from "../state";
import { resourceScheduler } from "../resource-scheduler";
import {
  DEFAULT_ROOM_ID,
  DEFAULT_UNIT_ID,
  getRoomInfo,
  getLastDeviceClearEpochMs,
  hasDeviceAbnormal,
  markDeviceAbnormal,
} from "../equipment-registry";
import { detectLongTermAnomaly } from "../plc-monitor";
import {
  THERMAL_DATA_SOURCE,
  ThermalLookup,
  ThermalLookupError,
  describeThermalLookup,
  lookupThermal,
} from "../thermal-properties";

const MAX_COP_SAMPLES = 2000;

interface PlcSnapshot {
  timestamp: string;
  source: string;
  unit: string;
  roomId: string;
  roomTempC: number;
  supplyTempC: number;
  returnTempC: number;
  suctionPressureMPa: number;
  dischargePressureMPa: number;
  powerW: number;
  cop: number;
  coolingCapacityW: number;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clampCop(value: number): number {
  return Math.min(COP_MAX, Math.max(COP_MIN, value));
}

/** 模拟PLC温度/压力采样；真实项目替换为Modbus/OPC UA/PLC网关读取。 */
async function requestPlcSample(signal: AbortSignal): Promise<PlcSnapshot> {
  signal.throwIfAborted();
  // 模拟PLC通信延迟，真实实现应在此读取PLC并响应AbortSignal
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 80);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("PLC request aborted"));
      },
      { once: true },
    );
  });
  signal.throwIfAborted();
  return pollPlc();
}

function pollPlc(): PlcSnapshot {
  const rand = Math.random();
  const supplyTempC = round(-3.1 + rand * 1.8, 1);
  const returnTempC = round(supplyTempC + 3.2 + Math.random() * 1.6, 1);
  const suctionPressureMPa = round(0.22 + Math.random() * 0.06, 3);
  const dischargePressureMPa = round(1.42 + Math.random() * 0.26, 2);
  const pressureRatio = dischargePressureMPa / suctionPressureMPa;
  const evaporatingTempC = -6 + (suctionPressureMPa - 0.24) * 18;
  const condensingTempC = 35 + (dischargePressureMPa - 1.5) * 22;
  const lift = Math.max(condensingTempC - evaporatingTempC, 1);
  const carnotCop = (evaporatingTempC + 273.15) / lift;
  const cop = clampCop(carnotCop * 0.45);
  const deltaT = returnTempC - supplyTempC;
  const powerW = 1200 + pressureRatio * 250 + deltaT * 180 + Math.random() * 90;
  const coolingCapacityW = powerW * cop;

  return {
    timestamp: nowIso(),
    source: "PLC模拟传感器",
    unit: DEFAULT_UNIT_ID,
    roomId: DEFAULT_ROOM_ID,
    roomTempC: round(-2.2 + Math.random() * 1.5, 1),
    supplyTempC,
    returnTempC,
    suctionPressureMPa,
    dischargePressureMPa,
    powerW: round(powerW, 1),
    cop: round(cop, 2),
    coolingCapacityW: round(coolingCapacityW, 1),
  };
}

async function handlePlcPoll(
  state: ColdStorageState,
): Promise<Partial<ColdStorageState>> {
  const outcome = await resourceScheduler.run(
    {
      resource: "plc",
      priority: "background",
      label: "xiaoke-plc-sample",
    },
    async (signal) => {
      // 只有拿到PLC资源、真正开始执行后才输出日志
      logAgent(
        "xiaoke",
        "开始向PLC设备请求温度、压力数据（当前为模拟PLC数据源）",
      );
      return requestPlcSample(signal);
    },
  );

  if (!outcome.ok) {
    logAgent("xiaoke", `PLC采样任务失败：${outcome.failureMessage}`);
    return {
      phase: "",
      routeTo: "",
      nextAgent: "",
      reportPayload: null,
      finalAnswer: "",
      结果: "",
      error: outcome.failureMessage,
      executedAgent: "xiaoke",
    };
  }

  const snapshot = outcome.value;
  const copRecords = [...(state.copRecords ?? []), snapshot].slice(
    -MAX_COP_SAMPLES,
  );
  logAgent(
    "xiaoke",
    `PLC采样：供温 ${snapshot.supplyTempC}℃，回温 ${snapshot.returnTempC}℃，` +
      `吸气压力 ${snapshot.suctionPressureMPa}MPa，排气压力 ${snapshot.dischargePressureMPa}MPa，` +
      `计算功率 W=${snapshot.powerW}W，COP=${snapshot.cop}`,
  );
  logAgent(
    "xiaoke",
    "本次仅存储COP/W采样信息，不生成报告；管理员请求结果时再触发COP核算报告流程",
  );

  if (!hasDeviceAbnormal()) {
    const detection = detectLongTermAnomaly(
      copRecords as unknown as Parameters<typeof detectLongTermAnomaly>[0],
      new Date(),
      getLastDeviceClearEpochMs(),
    );
    if (detection.abnormal) {
      const alarm = markDeviceAbnormal({
        reason: detection.reason,
        windowStart: detection.windowStart,
        windowEnd: detection.windowEnd,
        sampleCount: detection.sampleCount,
      });
      logAgent(
        "xiaoke",
        `检测到机组/传感器长期异常，已标记${alarm.roomId}/${alarm.unitId}为设备异常，正在上报master`,
      );
      return {
        copRecords,
        phase: "device_abnormal_alert",
        routeTo: "master",
        nextAgent: "",
        reportPayload: null,
        finalAnswer: "",
        结果: "",
        executedAgent: "xiaoke",
      };
    }
  }

  return {
    copRecords,
    phase: "",
    routeTo: "",
    nextAgent: "",
    reportPayload: null,
    finalAnswer: "",
    结果: "",
    executedAgent: "xiaoke",
  };
}

async function fetchFreshPlcForCop(
  label: string,
): Promise<
  | { ok: true; snapshot: PlcSnapshot }
  | { ok: false; failureMessage: string }
> {
  const outcome = await resourceScheduler.run(
    {
      resource: "plc",
      priority: "user",
      label,
    },
    async (signal) => {
      logAgent("xiaoke", "已取得PLC资源，正在调取本次COP核算所需的实时参数");
      return requestPlcSample(signal);
    },
  );
  if (!outcome.ok) {
    return { ok: false, failureMessage: outcome.failureMessage };
  }
  return { ok: true, snapshot: outcome.value };
}

function evaluateArrivalDeviation(
  state: ColdStorageState,
): Partial<ColdStorageState> {
  const pending = state.pendingDocument;
  if (!pending || pending.docType !== "arrival") {
    return {
      phase: "arrival_deviation_ok",
      routeTo: "scheduler",
      nextAgent: "",
      executedAgent: "xiaoke",
    };
  }
  const appointmentId = String(pending?.appointmentId ?? "").trim();
  const appointment = (state.记录 ?? []).find(
    (record) =>
      record?.docType === "appointment" &&
      String(record?.docId ?? "").trim() === appointmentId,
  );
  if (!appointment) {
    logAgent(
      "xiaoke",
      `到货偏差检查：未找到关联预约单 ${appointmentId || "-"}，交由原有审核流程处理`,
    );
    return {
      phase: "arrival_deviation_ok",
      routeTo: "scheduler",
      nextAgent: "",
      executedAgent: "xiaoke",
    };
  }
  const appointmentTonnage = toNumber(appointment?.tonnage);
  const actualTonnage = toNumber(pending?.actualTonnage);
  const cargoTempC = toNumber(pending?.cargoTempC);
  const roomCode = String(
    appointment?.roomCode ?? pending?.roomCode ?? "",
  )
    .trim()
    .toUpperCase();
  const room = roomCode ? getRoomInfo(roomCode) : null;
  const fruit = String(appointment?.fruit ?? pending?.fruit ?? "");
  const qRespConditionTempC =
    toNumber(appointment?.qRespConditionTempC) ??
    recommendedStorageTempC(fruit);
  const qRespConditionSource =
    String(appointment?.qRespConditionSource ?? "").trim() ||
    "果品推荐贮藏温区中间温度（Q1查表默认）";
  if (
    appointmentTonnage === null ||
    appointmentTonnage <= 0 ||
    actualTonnage === null ||
    actualTonnage <= 0 ||
    cargoTempC === null ||
    qRespConditionTempC === null
  ) {
    logAgent(
      "xiaoke",
      "到货偏差检查缺少预约吨位/实际吨位/实际货温/q_resp条件温度，转原有审核流程",
    );
    return {
      phase: "arrival_deviation_ok",
      routeTo: "scheduler",
      nextAgent: "",
      executedAgent: "xiaoke",
    };
  }
  const tonnageDeviationPct = round(
    (Math.abs(actualTonnage - appointmentTonnage) / appointmentTonnage) *
      100,
    2,
  );
  // 温度仅记录用于追溯，不再参与偏差触发判断。
  const overThreshold = tonnageDeviationPct > 5;
  const latestPlc =
    (state.copRecords ?? []).slice(-1)[0] ??
    state.copPlcSnapshot ??
    null;
  const thermalEntry = {
    recordedAt: nowIso(),
    source: "arrival_deviation_check",
    appointmentId,
    fruit,
    qRespConditionTempC: round(qRespConditionTempC, 2),
    qRespConditionSource,
    actualCargoTempC: round(cargoTempC, 1),
    appointmentTonnage: round(appointmentTonnage, 2),
    actualTonnage: round(actualTonnage, 2),
    tonnageDeviationPct,
    temperatureTriggered: false,
    plcSnapshot: latestPlc,
  };
  const thermalPlcHistory = [
    ...(state.thermalPlcHistory ?? []),
    thermalEntry,
  ];
  const detail = {
    detectedAt: nowIso(),
    thresholdPct: 5,
    original: {
      appointmentId,
      fruit,
      tonnage: round(appointmentTonnage, 2),
      roomCode,
      roomName: appointment?.roomName ?? room?.roomName ?? "",
      qRespConditionTempC: round(qRespConditionTempC, 2),
      qRespConditionSource,
      temperatureBaselineC: round(qRespConditionTempC, 2),
      roomTargetTempC: room
        ? round((room.tempMin + room.tempMax) / 2, 2)
        : null,
    },
    actual: {
      tonnage: round(actualTonnage, 2),
      cargoTempC: round(cargoTempC, 1),
    },
    deviations: {
      tonnagePct: tonnageDeviationPct,
    },
    options: ["add", "change"],
    pendingDocId: String(pending?.docId ?? ""),
    overThreshold,
  };
  logAgent(
    "xiaoke",
    `到货参数记录：原始预约吨位${detail.original.tonnage}t、库房${roomCode}；q_resp条件温度${detail.original.qRespConditionTempC}℃（${qRespConditionSource}）；` +
      `实际到货吨位${detail.actual.tonnage}t、到货货温${detail.actual.cargoTempC}℃；吨位偏差${tonnageDeviationPct}%，阈值5%；` +
      `温度仅记录不参与偏差判定`,
  );
  logAgent(
    "xiaoke",
    `q_resp条件温度与PLC参数已写入热物性历史：采样时间${
      latestPlc?.timestamp ?? "-"
    }，W=${latestPlc?.powerW ?? "-"}，COP=${latestPlc?.cop ?? "-"}`,
  );
  if (!overThreshold) {
    return {
      phase: "arrival_deviation_ok",
      routeTo: "scheduler",
      nextAgent: "",
      thermalPlcHistory,
      结果: "到货吨位偏差未超过5%，继续原审核流程。",
      executedAgent: "xiaoke",
    };
  }
  logAgent(
    "xiaoke",
    "到货吨位偏差超过5%，属于贮藏方案需要重新规划，暂停普通审核重试，转master由库内人员选择增加库房或更换库房",
  );
  return {
    phase: "arrival_deviation_alert",
    routeTo: "master",
    nextAgent: "",
    arrivalDeviation: detail,
    thermalPlcHistory,
    reviewPass: false,
    结果:
      "到货吨位偏差超过5%，需库内人员选择增加库房或更换库房后重新规划。",
    executedAgent: "xiaoke",
  };
}

function handleArrivalReplanReady(
  state: ColdStorageState,
): Partial<ColdStorageState> {
  const pending = state.pendingDocument;
  logAgent(
    "xiaoke",
    `拿到scheduler新生成的入库单 ${String(
      pending?.docId ?? "-",
    )}（${state.arrivalReplanChoice === "add" ? "增加库房" : "更换库房"}），继续后续审核流程`,
  );
  return {
    phase: "arrival_deviation_ok",
    routeTo: "scheduler",
    nextAgent: "",
    arrivalDeviation: null,
    结果: "已接收调度员重新规划的入库单，继续原审核流程。",
    executedAgent: "xiaoke",
  };
}

function handleCopInboundRequest(
  state: ColdStorageState,
): Partial<ColdStorageState> {
  logAgent(
    "xiaoke",
    "【来源：master】小柯→master：请求获取入库单，用于判断正式核算还是预约预估",
  );
  return {
    phase: "cop_inbound_request",
    routeTo: "master",
    nextAgent: "",
    finalAnswer: "",
    结果: "",
    executedAgent: "xiaoke",
  };
}

async function handleFormalAfterCenter(
  state: ColdStorageState,
): Promise<Partial<ColdStorageState>> {
  logAgent(
    "xiaoke",
    "【来源：master】已取得入库单和果品中心温度，开始正式COP核算",
  );
  const centerTempC = toNumber(state.taskData?.centerTempC);
  if (
    centerTempC === null ||
    centerTempC < -5 ||
    centerTempC > 45
  ) {
    return {
      phase: "cop_report_result",
      routeTo: "master",
      nextAgent: "",
      reportPayload: {
        skipped: true,
        alarmRequired: true,
        mode: "formal",
        retryCount: 0,
        message:
          "缺少有效的果品中心温度，正式COP核算终止，未生成报告。",
      },
      error: "缺少果品中心温度",
      executedAgent: "xiaoke",
    };
  }
  const plcOutcome = await fetchFreshPlcForCop("xiaoke-cop-formal-plc");
  if (!plcOutcome.ok) {
    return {
      phase: "cop_report_result",
      routeTo: "master",
      nextAgent: "",
      reportPayload: {
        skipped: true,
        message: `正式COP核算未能取得PLC参数：${plcOutcome.failureMessage}`,
      },
      error: plcOutcome.failureMessage,
      executedAgent: "xiaoke",
    };
  }
  const snapshot = plcOutcome.snapshot;
  const copRecords = [...(state.copRecords ?? []), snapshot].slice(
    -MAX_COP_SAMPLES,
  );
  let calculation: CopCalculation;
  try {
    calculation = calculateFormalCopCalculation(state, snapshot);
  } catch (error) {
    const message =
      error instanceof CopCalculationInputError
        ? error.message
        : error instanceof ThermalLookupError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
    logAgent("xiaoke", `正式COP核算终止：${message}`);
    return {
      phase: "cop_report_result",
      routeTo: "master",
      nextAgent: "",
      reportPayload: {
        skipped: true,
        alarmRequired: true,
        mode: "formal",
        retryCount: 0,
        message,
      },
      error: message,
      executedAgent: "xiaoke",
    };
  }
  logAgent(
    "xiaoke",
    `正式核算完成：${calculation.scopeLabel}，Q2=${calculation.q2W}W，W=${calculation.wPowerW}W，COP=${calculation.cop}，` +
      `库房温度=${calculation.roomTempC}℃，中心温度=${calculation.centerTempC}℃，正在提交质检`,
  );
  return {
    copRecords,
    copPlcSnapshot: snapshot,
    copCalculation: calculation,
    copReportMode: "formal",
    copRetryCount: 0,
    phase: "cop_calc_review",
    routeTo: "reviewer",
    nextAgent: "",
    reviewPass: false,
    reviewReason: "",
    reportPayload: null,
    结果: "",
    error: "",
    executedAgent: "xiaoke",
  };
}

async function handleCopReportStart(
  state: ColdStorageState,
): Promise<Partial<ColdStorageState>> {
  logAgent("xiaoke", "【来源：master】收到master的COP结果请求，触发COP计算功能");
  logAgent(
    "xiaoke",
    "小柯正在向PLC设备调取实时温度、压力参数，请稍候……",
  );

  const outcome = await resourceScheduler.run(
    {
      resource: "plc",
      priority: "user",
      label: "xiaoke-cop-report-plc",
    },
    async (signal) => {
      logAgent("xiaoke", "已取得PLC资源，正在调取本次核算所需的实时参数");
      return requestPlcSample(signal);
    },
  );

  if (!outcome.ok) {
    logAgent("xiaoke", `本次COP核算PLC取数失败：${outcome.failureMessage}`);
    return {
      phase: "cop_report_result",
      routeTo: "master",
      nextAgent: "",
      reportPayload: {
        skipped: true,
        message: `COP核算未能取得PLC实时参数：${outcome.failureMessage}`,
      },
      error: outcome.failureMessage,
      executedAgent: "xiaoke",
    };
  }

  const snapshot = outcome.value;
  const copRecords = [...(state.copRecords ?? []), snapshot].slice(
    -MAX_COP_SAMPLES,
  );
  logAgent(
    "xiaoke",
    `实时PLC参数：供温 ${snapshot.supplyTempC}℃，回温 ${snapshot.returnTempC}℃，` +
      `吸气压力 ${snapshot.suctionPressureMPa}MPa，排气压力 ${snapshot.dischargePressureMPa}MPa，` +
      `功率 W=${snapshot.powerW}W，COP=${snapshot.cop}`,
  );
  logAgent(
    "xiaoke",
    "实时参数已保存，小柯→master：请求入库单数据，请稍候……",
  );

  return {
    copRecords,
    copPlcSnapshot: snapshot,
    copReportMode: "formal",
    copRetryCount: 0,
    phase: "cop_ledger_request",
    routeTo: "master",
    nextAgent: "",
    reportPayload: null,
    copCalculation: null,
    结果: "",
    error: "",
    executedAgent: "xiaoke",
  };
}

class CopCalculationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopCalculationInputError";
  }
}

interface RoomCopAllocation {
  roomCode: string;
  qW: number;
  loadSharePct: number;
  allocatedPowerW: number;
  cop: number;
}

interface ReportLot {
  sourceDocId: string;
  appointmentId: string;
  roomCode: string;
  fruit: string;
  tonnage: number;
  cargoTempC: number;
  centerTempC: number;
  roomTempC: number;
  storageDays: number;
  specificHeatKjPerKgK: number;
  specificHeatPhase: "above_freezing" | "below_freezing";
  freezingPointC: number;
  qRespWPerTon: number;
  qRespWPerKg: number;
  respirationW: number;
  thermalSource: string;
  thermalMethod: string;
  deltaTK: number;
  q2SensibleW: number;
  q2RespirationW: number;
  q2Kj: number;
  q2W: number;
  cop: number;
  coldLoadW: number;
  precoolParameters: {
    targetTempC: number;
    targetTempZone: string;
    durationHours: number;
    staticPressurePa: string;
    supplyAirDeltaTC: string;
    airVelocityMs: string;
  };
  carbonEmissionKgCO2e: number;
}

interface CopCalculation {
  mode: "formal" | "estimate";
  label: "【正式核算值】" | "【预约预估值】";
  copScope: "single" | "allocated";
  scopeLabel: "【单库房COP】" | "【机组分摊等效COP】";
  roomCode: string;
  computedAt: string;
  generatedAt: string;
  sourceDocIds: string[];
  plcSnapshot: PlcSnapshot;
  lots: ReportLot[];
  appointment: Record<string, any> | null;
  centerTempC: number | null;
  roomTempC: number | null;
  q1W: number | null;
  q2W: number | null;
  wPowerW: number;
  thermalSource: string;
  thermalDetails: string[];
  thermalLookups: ThermalLookup[];
  qRespConditions: Array<{
    docId: string;
    fruit: string;
    conditionTempC: number;
    qRespWPerTon: number;
    qRespWPerKg: number;
    source: string;
  }>;
  qValue: number;
  qUnit: string;
  cop: number;
  rooms: RoomCopAllocation[];
  totals: Record<string, number>;
}

function q1ReferenceForFormal(
  state: ColdStorageState,
  docs: Array<Record<string, any>>,
): { q1W: number | null; lookups: ThermalLookup[] } {
  const lookups: ThermalLookup[] = [];
  let totalQ1W = 0;
  for (const doc of docs) {
    const appointmentId = String(doc?.appointmentId ?? "").trim();
    const appointment = (state.记录 ?? []).find(
      (record) =>
        record?.docType === "appointment" &&
        String(record?.docId ?? "").trim() === appointmentId,
    );
    const fruit = String(doc?.fruit ?? appointment?.fruit ?? "");
    const tempC = recommendedStorageTempC(fruit);
    const tonnage = toNumber(doc?.actualTonnage);
    if (tempC === null || tonnage === null || tonnage <= 0) {
      return { q1W: null, lookups };
    }
    try {
      const lookup = lookupThermal(fruit, tempC);
      lookups.push(lookup);
      totalQ1W += tonnage * 1000 * lookup.qRespWPerKg;
    } catch {
      return { q1W: null, lookups };
    }
  }
  return { q1W: docs.length > 0 ? round(totalQ1W, 2) : null, lookups };
}

function calculateFormalCopCalculation(
  state: ColdStorageState,
  plc: PlcSnapshot,
): CopCalculation {
  const centerTempC = toNumber(state.taskData?.centerTempC);
  if (
    centerTempC === null ||
    centerTempC < -5 ||
    centerTempC > 45
  ) {
    throw new CopCalculationInputError(
      "正式核算缺少有效果品中心温度（-5~45℃），终止核算。",
    );
  }
  if (!Number.isFinite(plc.powerW) || plc.powerW <= 0) {
    throw new CopCalculationInputError(
      "正式核算缺少有效PLC电功率W，终止核算。",
    );
  }
  const copScope: "single" | "allocated" =
    state.copScope === "allocated" ? "allocated" : "single";
  const requestedRoomCode = String(state.copRoomCode ?? "")
    .trim()
    .toUpperCase();
  if (copScope === "single" && !requestedRoomCode) {
    throw new CopCalculationInputError(
      "单库房COP缺少库房编号，终止核算。",
    );
  }
  const roomTempC = toNumber(plc.roomTempC) ?? plc.returnTempC;
  const allDocs = (state.ledgerDocuments ?? []).filter(
    (doc) => doc?.docType === "arrival",
  );
  if (allDocs.length === 0) {
    throw new CopCalculationInputError(
      "没有入库单，无法进行正式COP核算。",
    );
  }
  const docs =
    copScope === "single"
      ? allDocs.filter(
          (doc) =>
            String(doc?.roomCode ?? "").trim().toUpperCase() ===
            requestedRoomCode,
        )
      : allDocs;
  if (docs.length === 0) {
    throw new CopCalculationInputError(
      `没有库房 ${requestedRoomCode} 的入库单，无法进行单库房COP核算。`,
    );
  }

  const lots: ReportLot[] = [];
  const thermalLookups: ThermalLookup[] = [];
  for (const doc of docs) {
    const fruit = String(doc?.fruit ?? "");
    const spec = FRUIT_SPECS[fruit];
    const tonnage = toNumber(doc?.actualTonnage);
    const cargoTempC = toNumber(doc?.cargoTempC);
    if (
      !spec ||
      tonnage === null ||
      tonnage <= 0 ||
      cargoTempC === null
    ) {
      throw new CopCalculationInputError(
        `到货单 ${String(doc?.docId ?? "-")} 缺少果品、正吨位或货温，无法查表计算。`,
      );
    }
    let thermal: ThermalLookup;
    try {
      thermal = lookupThermal(fruit, centerTempC);
    } catch (error) {
      if (error instanceof ThermalLookupError) {
        throw new CopCalculationInputError(error.message);
      }
      throw error;
    }
    thermalLookups.push(thermal);
    const massKg = tonnage * 1000;
    const storageDays = Math.max(toNumber(doc?.storageDays) ?? 1, 1);
    const targetTempC = (spec.tempMin + spec.tempMax) / 2;
    const deltaTK = Math.max(centerTempC - roomTempC, 0);
    const specificHeatKjPerKgK = thermal.specificHeatKjPerKgK;
    const sensibleKj = massKg * specificHeatKjPerKgK * deltaTK;
    const durationHours = round(
      Math.min(24, Math.max(4, 4 + deltaTK * 0.7 + tonnage * 0.08)),
      1,
    );
    const q2SensibleW =
      durationHours > 0 ? (sensibleKj * 1000) / (durationHours * 3600) : 0;
    const q2RespirationW = massKg * thermal.qRespWPerKg;
    const q2W = q2SensibleW + q2RespirationW;
    const cop = q2W / plc.powerW;
    const precoolEnergyKwh =
      sensibleKj > 0.01
        ? (sensibleKj / 3600 / Math.max(plc.cop, 0.1)) * 1.12
        : 0;
    const storageEnergyKwh = tonnage * spec.dailyKwhPerTon * storageDays;
    const totalEnergyKwh = precoolEnergyKwh + storageEnergyKwh;

    lots.push({
      sourceDocId: String(doc?.docId ?? ""),
      appointmentId: String(doc?.appointmentId ?? ""),
      roomCode: String(doc?.roomCode ?? "A1").trim().toUpperCase(),
      fruit,
      tonnage: round(tonnage, 2),
      cargoTempC: round(cargoTempC, 1),
      centerTempC: round(centerTempC, 1),
      roomTempC: round(roomTempC, 1),
      storageDays: round(storageDays, 1),
      specificHeatKjPerKgK,
      specificHeatPhase: thermal.phase,
      freezingPointC: thermal.freezingPointC,
      qRespWPerTon: round(thermal.qRespWPerTon, 4),
      qRespWPerKg: round(thermal.qRespWPerKg, 6),
      respirationW: round(q2RespirationW, 2),
      thermalSource: thermal.source,
      thermalMethod: thermal.method,
      deltaTK: round(deltaTK, 2),
      q2SensibleW: round(q2SensibleW, 2),
      q2RespirationW: round(q2RespirationW, 2),
      q2Kj: round(sensibleKj, 2),
      q2W: round(q2W, 2),
      cop: round(cop, 4),
      coldLoadW: round(q2W, 2),
      precoolParameters: {
        targetTempC: round(targetTempC, 1),
        targetTempZone: spec.tempText,
        durationHours,
        staticPressurePa: "250~400",
        supplyAirDeltaTC: "3~5",
        airVelocityMs: "1.5~2.5",
      },
      carbonEmissionKgCO2e: round(
        totalEnergyKwh * GRID_EMISSION_FACTOR_KG_PER_KWH,
        2,
      ),
    });
  }

  const totalQ2W = lots.reduce((sum, lot) => sum + lot.q2W, 0);
  const groupedRooms = new Map<string, number>();
  for (const lot of lots) {
    groupedRooms.set(
      lot.roomCode,
      (groupedRooms.get(lot.roomCode) ?? 0) + lot.q2W,
    );
  }
  const selectedRoomQ2W = groupedRooms.get(requestedRoomCode) ?? 0;
  if (copScope === "single" && selectedRoomQ2W <= 0) {
    throw new CopCalculationInputError(
      `库房 ${requestedRoomCode} 没有有效Q2热负荷，无法进行单库房COP核算。`,
    );
  }
  const allocatedRooms: RoomCopAllocation[] = Array.from(
    groupedRooms.entries(),
  ).map(([roomCode, qW]) => {
    const sharePct = totalQ2W > 0 ? (qW / totalQ2W) * 100 : 0;
    const allocatedPowerW = plc.powerW * (sharePct / 100);
    const cop = allocatedPowerW > 0 ? qW / allocatedPowerW : 0;
    return {
      roomCode,
      qW: round(qW, 2),
      loadSharePct: round(sharePct, 2),
      allocatedPowerW: round(allocatedPowerW, 2),
      cop: round(cop, 4),
    };
  });
  const selectedQ2W =
    copScope === "single" ? selectedRoomQ2W : totalQ2W;
  const cop = selectedQ2W / plc.powerW;
  const rooms = copScope === "allocated" ? allocatedRooms : [];
  for (const lot of lots) {
    lot.cop = round(cop, 4);
  }
  const q1Reference = q1ReferenceForFormal(state, docs);
  const thermalDetails = [
    ...thermalLookups.map((lookup) => describeThermalLookup(lookup)),
    ...q1Reference.lookups.map(
      (lookup) => `Q1参考：${describeThermalLookup(lookup)}`,
    ),
  ];
  const sources = Array.from(
    new Set(thermalLookups.map((lookup) => lookup.source)),
  );
  const totals = {
    q1W: q1Reference.q1W ?? 0,
    q2W: round(totalQ2W, 2),
    selectedRoomQ2W: round(selectedRoomQ2W, 2),
    powerW: plc.powerW,
    cop: round(cop, 4),
    plcCop: plc.cop,
    coldLoadW: round(totalQ2W, 2),
    carbonEmissionKgCO2e: round(
      lots.reduce((sum, lot) => sum + lot.carbonEmissionKgCO2e, 0),
      2,
    ),
    roomCount: groupedRooms.size,
  };
  const now = nowIso();
  return {
    mode: "formal",
    label: "【正式核算值】",
    copScope,
    scopeLabel:
      copScope === "allocated"
        ? "【机组分摊等效COP】"
        : "【单库房COP】",
    roomCode: copScope === "single" ? requestedRoomCode : "ALL",
    computedAt: now,
    generatedAt: now,
    sourceDocIds: lots.map((lot) => lot.sourceDocId),
    plcSnapshot: plc,
    lots,
    appointment: null,
    centerTempC: round(centerTempC, 1),
    roomTempC: round(roomTempC, 1),
    q1W: q1Reference.q1W,
    q2W: round(selectedQ2W, 2),
    wPowerW: plc.powerW,
    thermalSource:
      sources.join("；") || THERMAL_DATA_SOURCE,
    thermalDetails,
    thermalLookups,
    qRespConditions: [],
    qValue: round(selectedQ2W, 2),
    qUnit: "W（Q2实际热负荷）",
    cop: round(cop, 4),
    rooms,
    totals,
  };
}

function calculateEstimateCopCalculation(
  state: ColdStorageState,
  plc: PlcSnapshot,
): CopCalculation {
  if (!Number.isFinite(plc.powerW) || plc.powerW <= 0) {
    throw new CopCalculationInputError(
      "预约预估缺少有效PLC电功率W，终止核算。",
    );
  }
  const copScope: "single" | "allocated" =
    state.copScope === "allocated" ? "allocated" : "single";
  const requestedRoomCode = String(state.copRoomCode ?? "")
    .trim()
    .toUpperCase();
  if (copScope === "single" && !requestedRoomCode) {
    throw new CopCalculationInputError(
      "单库房COP缺少库房编号，终止核算。",
    );
  }
  const allAppointments = (state.ledgerDocuments ?? []).filter(
    (doc) => doc?.docType === "appointment",
  );
  if (allAppointments.length === 0) {
    throw new CopCalculationInputError(
      "没有预约单，无法进行预约阶段COP预估。",
    );
  }
  const appointments =
    copScope === "single"
      ? allAppointments.filter(
          (doc) =>
            String(doc?.roomCode ?? "").trim().toUpperCase() ===
            requestedRoomCode,
        )
      : allAppointments;
  if (appointments.length === 0) {
    throw new CopCalculationInputError(
      `没有库房 ${requestedRoomCode} 的预约单，无法进行单库房COP预估。`,
    );
  }

  const roomLoads = new Map<string, number>();
  const sourceIds: string[] = [];
  const thermalLookups: ThermalLookup[] = [];
  const qRespConditions: CopCalculation["qRespConditions"] = [];
  let totalQ1W = 0;
  for (const appointment of appointments) {
    const fruit = String(appointment?.fruit ?? "");
    const spec = FRUIT_SPECS[fruit];
    const tonnage = toNumber(appointment?.tonnage);
    const recommendedTempC = recommendedStorageTempC(fruit);
    if (
      !spec ||
      tonnage === null ||
      tonnage <= 0 ||
      recommendedTempC === null
    ) {
      throw new CopCalculationInputError(
        `预约单 ${String(
          appointment?.docId ?? "-",
        )} 缺少果品或正吨位（或果品无推荐贮藏温区），无法查表计算Q1。`,
      );
    }
    let thermal: ThermalLookup;
    try {
      // 预约阶段不录入果品温度；Q1使用该果品推荐贮藏温区中间温度的呼吸强度。
      thermal = lookupThermal(fruit, recommendedTempC);
    } catch (error) {
      if (error instanceof ThermalLookupError) {
        throw new CopCalculationInputError(error.message);
      }
      throw error;
    }
    thermalLookups.push(thermal);
    qRespConditions.push({
      docId: String(appointment?.docId ?? ""),
      fruit,
      conditionTempC: round(recommendedTempC, 2),
      qRespWPerTon: round(thermal.qRespWPerTon, 4),
      qRespWPerKg: round(thermal.qRespWPerKg, 6),
      source: `${thermal.source}；Q1按${round(
        recommendedTempC,
        2,
      )}℃（果品推荐贮藏温区中间温度）线性插值`,
    });
    const massKg = tonnage * 1000;
    const q1W = massKg * thermal.qRespWPerKg;
    totalQ1W += q1W;
    const roomCode = String(appointment?.roomCode ?? "A1")
      .trim()
      .toUpperCase();
    roomLoads.set(roomCode, (roomLoads.get(roomCode) ?? 0) + q1W);
    sourceIds.push(String(appointment?.docId ?? ""));
  }
  if (!Number.isFinite(totalQ1W) || totalQ1W <= 0) {
    throw new CopCalculationInputError(
      "预约单Q1热负荷无效，终止核算。",
    );
  }
  const selectedRoomQ1W = roomLoads.get(requestedRoomCode) ?? 0;
  if (copScope === "single" && selectedRoomQ1W <= 0) {
    throw new CopCalculationInputError(
      `库房 ${requestedRoomCode} 没有有效Q1热负荷，无法进行单库房COP预估。`,
    );
  }
  const allocations: RoomCopAllocation[] = Array.from(
    roomLoads.entries(),
  ).map(([roomCode, qW]) => {
    const sharePct = totalQ1W > 0 ? (qW / totalQ1W) * 100 : 0;
    const allocatedPowerW = plc.powerW * (sharePct / 100);
    return {
      roomCode,
      qW: round(qW, 4),
      loadSharePct: round(sharePct, 2),
      allocatedPowerW: round(allocatedPowerW, 2),
      cop: allocatedPowerW > 0 ? round(qW / allocatedPowerW, 4) : 0,
    };
  });
  const selectedQ1W =
    copScope === "single" ? selectedRoomQ1W : totalQ1W;
  const cop = selectedQ1W / plc.powerW;
  const rooms = copScope === "allocated" ? allocations : [];
  const firstAppointment = appointments[0];
  const sources = Array.from(
    new Set(thermalLookups.map((lookup) => lookup.source)),
  );
  const thermalDetails = thermalLookups.map((lookup) =>
    describeThermalLookup(lookup),
  );
  const now = nowIso();
  return {
    mode: "estimate",
    label: "【预约预估值】",
    copScope,
    scopeLabel:
      copScope === "allocated"
        ? "【机组分摊等效COP】"
        : "【单库房COP】",
    roomCode: copScope === "single" ? requestedRoomCode : "ALL",
    computedAt: now,
    generatedAt: now,
    sourceDocIds: sourceIds,
    plcSnapshot: plc,
    lots: [],
    appointment: firstAppointment
      ? {
          docId: String(firstAppointment?.docId ?? ""),
          roomCode: String(firstAppointment?.roomCode ?? "A1")
            .trim()
            .toUpperCase(),
          fruit: String(firstAppointment?.fruit ?? ""),
          tonnage: round(toNumber(firstAppointment?.tonnage) ?? 0, 2),
          scheduledAt: String(firstAppointment?.scheduledAt ?? ""),
          storageDays: toNumber(firstAppointment?.storageDays),
        }
      : null,
    centerTempC: null,
    roomTempC: toNumber(plc.roomTempC),
    q1W: round(selectedQ1W, 2),
    q2W: null,
    wPowerW: plc.powerW,
    thermalSource:
      sources.join("；") || THERMAL_DATA_SOURCE,
    thermalDetails,
    thermalLookups,
    qRespConditions,
    qValue: round(selectedQ1W, 2),
    qUnit: "W（Q1呼吸热）",
    cop: round(cop, 4),
    rooms,
    totals: {
      q1W: round(selectedQ1W, 2),
      q1TotalW: round(totalQ1W, 2),
      q2W: 0,
      selectedRoomQ1W: round(selectedRoomQ1W, 2),
      powerW: plc.powerW,
      cop: round(cop, 4),
      plcCop: plc.cop,
      coldLoadW: round(selectedQ1W, 2),
      carbonEmissionKgCO2e: 0,
      roomCount: rooms.length,
    },
  };
}

function formatCopReport(calculation: CopCalculation): string {
  const plc = calculation.plcSnapshot;
  const lines = [
    "──────── 小柯COP核算报告 ────────",
    `输出标记：${calculation.label} / ${calculation.scopeLabel}`,
    `COP类型：${calculation.scopeLabel}${
      calculation.copScope === "single"
        ? `（目标库房 ${calculation.roomCode}）`
        : "（机组分摊）"
    }`,
    `目标库房：${
      calculation.copScope === "single"
        ? calculation.roomCode
        : "不适用（机组分摊）"
    }`,
    `核算类型：${
      calculation.mode === "estimate"
        ? "预约阶段预估计算"
        : "入库后正式核算"
    }`,
    `Q1（预约预估热负荷）：${
      calculation.q1W === null ? "不适用" : `${calculation.q1W} W`
    }`,
    `Q2（实际热负荷）：${
      calculation.q2W === null ? "不适用" : `${calculation.q2W} W`
    }`,
    `W（PLC电功率）：${calculation.wPowerW} W`,
    `最终COP：${calculation.cop}`,
    `热物性数据来源：${calculation.thermalSource}`,
    ...calculation.thermalDetails.map((detail) => `热物性参数：${detail}`),
    "消息来源：小柯（经master转发）",
    `报告生成时间：${nowIso()}`,
    `核算时间：${calculation.generatedAt}`,
    "质检状态：已通过质检员审核",
    `本次实时PLC采样：${plc.timestamp}（${plc.source}）`,
    `库房/机组：${plc.roomId} / ${plc.unit}`,
    `库房当前温度：${plc.roomTempC}℃`,
    `机组总功率 W总：${plc.powerW} W`,
    `PLC COP：${plc.cop}`,
    "",
  ];

  if (calculation.mode === "estimate") {
    lines.push(
      "──────── 预约预估计算 ────────",
      `来源预约单：${calculation.sourceDocIds.length} 条`,
      `Q1 合计（预约呼吸热）：${calculation.q1W ?? calculation.qValue} W`,
      calculation.copScope === "single"
        ? `目标库房 ${calculation.roomCode} 的 Q1：${calculation.q1W} W`
        : `机组分摊 Q1 合计：${calculation.q1W} W`,
      `Q1查表温度：${calculation.thermalLookups[0]?.temperatureC ?? "-"}℃（果品推荐贮藏温区中间温度，无需用户录入）`,
      "公式：重量换算kg → 按果品+推荐贮藏温度线性插值 q_resp → Q1 = m × q_resp；COP = Q1 / W",
      `【预约预估值】COP = ${calculation.cop}`,
      "",
      ...(calculation.copScope === "allocated"
        ? [
            "机组热负荷分摊：",
            ...calculation.rooms.map(
              (room) =>
                `  ${room.roomCode}: Qi=${room.qW} W，负荷占比 ${room.loadSharePct}%，分摊功率 Wi=${room.allocatedPowerW} W，COPi=${room.cop}`,
            ),
            "",
          ]
        : [
            "单库房COP：直接使用该库房 Q1 与本次PLC电功率 W 计算，不做机组分摊。",
            "",
          ]),
      "说明：该结果用于预约阶段和调度库房预选参考，不替代入库后正式核算。",
    );
    return lines.join("\n");
  }

  const lots = calculation.lots;
  const totals = calculation.totals;
  lines.push(
    `果品中心温度：${calculation.centerTempC}℃`,
    `库房当前温度：${calculation.roomTempC}℃`,
    `ΔT（中心温度-库房温度）：${
      calculation.centerTempC !== null && calculation.roomTempC !== null
        ? round(calculation.centerTempC - calculation.roomTempC, 2)
        : "-"
    } K`,
    `入库单据：${lots.length} 个到货批次`,
    "",
  );
  lots.forEach((lot, index) => {
    lines.push(
      `${index + 1}. ${lot.sourceDocId}（关联预约 ${lot.appointmentId || "-"}，库房 ${lot.roomCode}）`,
      `   果品/吨位：${lot.fruit} / ${lot.tonnage} t`,
      `   中心温度/库房温度/ΔT：${lot.centerTempC}℃ / ${lot.roomTempC}℃ / ${lot.deltaTK} K`,
      `   比热 c：${lot.specificHeatKjPerKgK} kJ/(kg·K)（${
        lot.specificHeatPhase === "above_freezing" ? "高于" : "低于"
      }冰点 ${lot.freezingPointC}℃档，档内定值）`,
      `   q_resp：${lot.qRespWPerTon} W/t = ${lot.qRespWPerKg} W/kg（按 ${lot.centerTempC}℃ 线性插值）`,
      `   Q2显热 = m·c·ΔT：${lot.q2Kj} kJ，按预冷时长 ${lot.precoolParameters.durationHours} h 折算 ${lot.q2SensibleW} W`,
      `   Q2呼吸热 = m·q_resp：${lot.q2RespirationW} W`,
      `   Q2实际热负荷 = 显热平均功率 + 呼吸热：${lot.q2W} W`,
      `   本批次 COP = ${lot.cop}`,
      `   冷负荷（Q2实际热负荷）：${lot.coldLoadW} W`,
      `   热物性来源：${lot.thermalSource}`,
      `   预冷参数：目标 ${lot.precoolParameters.targetTempC}℃（${lot.precoolParameters.targetTempZone}），时长 ${lot.precoolParameters.durationHours} h，静压差 ${lot.precoolParameters.staticPressurePa} Pa，送风温差 ${lot.precoolParameters.supplyAirDeltaTC}℃，风速 ${lot.precoolParameters.airVelocityMs} m/s`,
      `   碳排放：${lot.carbonEmissionKgCO2e} kgCO2e`,
      "",
    );
  });
  lines.push(
    "──────── 合计 ────────",
    `Q1（预约参考）：${
      calculation.q1W === null ? "不适用/缺少预约温度" : `${calculation.q1W} W`
    }`,
    `Q2（实际热负荷）合计：${calculation.q2W} W`,
    `W（PLC电功率）：${calculation.wPowerW} W`,
    `【正式核算值】COP = ${totals.cop}`,
    `PLC COP：${totals.plcCop}`,
    `冷负荷合计：${totals.coldLoadW} W`,
    `碳排放合计：${totals.carbonEmissionKgCO2e} kgCO2e`,
    "",
    ...(calculation.copScope === "allocated"
      ? [
          "机组分摊等效COP：",
          ...calculation.rooms.map(
            (room) =>
              `  ${room.roomCode}: Qi=${room.qW} W，负荷占比 ${room.loadSharePct}%，分摊功率 Wi=${room.allocatedPowerW} W，COPi=${room.cop}`,
          ),
          "",
          "说明：按各库房Q2热负荷比例分摊机组总功率W，再计算各库房COPi；整体COP=Q2总/W总。",
        ]
      : [
          "单库房COP：",
          `目标库房：${calculation.roomCode}`,
          `COP = 该库房Q2 / W = ${calculation.cop}`,
          "",
          "说明：单库房COP直接使用所选库房的Q2热负荷除以本次PLC电功率W，不做机组分摊。",
        ]),
    "正式核算使用实际果品中心温度、PLC库房当前温度、查表c/q_resp和PLC电功率；PLC定时采样与存储在后台同步运行。",
  );
  return lines.join("\n");
}

function handleCopCalculation(
  state: ColdStorageState,
): Partial<ColdStorageState> {
  const count = state.ledgerDocuments.length;
  logAgent(
    "xiaoke",
    `收到master下发的入库单数据 ${count} 条，开始正式COP核算，请稍候……`,
  );
  const centerTempC = toNumber(state.taskData?.centerTempC);
  if (centerTempC === null || centerTempC < -5 || centerTempC > 45) {
    logAgent(
      "xiaoke",
      "缺少有效的果品中心温度，请用户先测量并录入果品中心温度后再发起正式核算",
    );
    return {
      phase: "cop_report_result",
      routeTo: "master",
      nextAgent: "",
      reportPayload: {
        skipped: true,
        message:
          "缺少有效的果品中心温度，未进行正式COP核算。请先测量果品中心温度并重新发起菜单4请求。",
      },
      error: "缺少果品中心温度",
      executedAgent: "xiaoke",
    };
  }

  const plc =
    (state.copPlcSnapshot as PlcSnapshot | null) ??
    ((state.copRecords ?? []).at(-1) as PlcSnapshot | undefined);
  if (!plc) {
    logAgent("xiaoke", "缺少本次PLC实时参数，无法核算COP");
    return {
      phase: "cop_report_result",
      routeTo: "master",
      nextAgent: "",
      reportPayload: {
        skipped: true,
        message: "缺少本次PLC实时参数，无法核算COP报告，请重新发起请求。",
      },
      error: "缺少本次PLC实时参数",
      executedAgent: "xiaoke",
    };
  }

  const calculation = calculateFormalCopCalculation(state, plc);
  if (!calculation) {
    logAgent("xiaoke", "台账没有可用的到货入库单，无法进行COP核算");
    return {
      phase: "cop_report_result",
      routeTo: "master",
      nextAgent: "",
      reportPayload: {
        skipped: true,
        message: "台账没有可用的到货入库单，无法关联货物生成COP核算报告。",
      },
      executedAgent: "xiaoke",
    };
  }

  logAgent(
    "xiaoke",
    `正式核算完成：到货批次 ${calculation.lots.length} 个，` +
      `果品中心温度 ${centerTempC}℃，库房温度 ${calculation.roomTempC}℃，Q2 折算热负荷 ${calculation.totals.q2W}W，` +
      `【正式核算值】COP=${calculation.cop}`,
  );
  logAgent("xiaoke", "正在把COP核算结果提交质检员审核，请稍候……");
  return {
    copCalculation: calculation,
    copReportMode: "formal",
    copRetryCount: 0,
    phase: "cop_calc_review",
    routeTo: "reviewer",
    nextAgent: "",
    reviewPass: false,
    reviewReason: "",
    reportPayload: null,
    结果: "",
    error: "",
    executedAgent: "xiaoke",
  };
}

async function handleEstimateRequest(
  state: ColdStorageState,
): Promise<Partial<ColdStorageState>> {
  const appointmentId = String(state.taskData?.appointmentId ?? "").trim();
  logAgent(
    "xiaoke",
    "收到master转达的预约单数据，开始预约阶段COP预估，正在向PLC调取实时功率，请稍候……",
  );
  const plcOutcome = await fetchFreshPlcForCop("xiaoke-cop-estimate-plc");
  if (!plcOutcome.ok) {
    logAgent("xiaoke", `预约预估PLC取数失败：${plcOutcome.failureMessage}`);
    return {
      phase: "cop_report_result",
      routeTo: "master",
      nextAgent: "",
      reportPayload: {
        skipped: true,
        message: `预约阶段COP预估未能取得PLC参数：${plcOutcome.failureMessage}`,
      },
      error: plcOutcome.failureMessage,
      executedAgent: "xiaoke",
    };
  }
  const snapshot = plcOutcome.snapshot;
  const copRecords = [...(state.copRecords ?? []), snapshot].slice(
    -MAX_COP_SAMPLES,
  );
  let calculation: CopCalculation;
  try {
    calculation = calculateEstimateCopCalculation(state, snapshot);
  } catch (error) {
    const message =
      error instanceof CopCalculationInputError
        ? error.message
        : error instanceof ThermalLookupError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
    logAgent("xiaoke", `预约阶段COP预估终止：${message}`);
    return {
      phase: "cop_report_result",
      routeTo: "master",
      nextAgent: "",
      reportPayload: {
        skipped: true,
        alarmRequired: true,
        mode: "estimate",
        retryCount: 0,
        message,
      },
      error: message,
      executedAgent: "xiaoke",
    };
  }
  logAgent(
    "xiaoke",
    `预约预估完成：${calculation.scopeLabel}，Q1=${calculation.q1W}W，` +
      `W=${calculation.wPowerW}W，【预约预估值】COP=${calculation.cop}，正在提交质检员审核`,
  );
  const conditionByDocId = new Map(
    calculation.qRespConditions.map((condition) => [
      condition.docId,
      condition,
    ]),
  );
  const updatedRecords = (state.记录 ?? []).map((record) => {
    if (record?.docType !== "appointment") return record;
    const condition = conditionByDocId.get(String(record?.docId ?? ""));
    if (!condition) return record;
    return {
      ...record,
      qRespConditionTempC: condition.conditionTempC,
      qRespConditionSource: condition.source,
      qRespConditionUpdatedAt: nowIso(),
    };
  });
  const thermalPlcHistory = [
    ...(state.thermalPlcHistory ?? []),
    ...calculation.qRespConditions.map((condition) => ({
      recordedAt: nowIso(),
      source: "estimate_cop",
      appointmentId: condition.docId,
      fruit: condition.fruit,
      qRespConditionTempC: condition.conditionTempC,
      qRespWPerTon: condition.qRespWPerTon,
      qRespConditionSource: condition.source,
      plcSnapshot: snapshot,
    })),
  ];
  return {
    记录: updatedRecords,
    thermalPlcHistory,
    copRecords,
    copPlcSnapshot: snapshot,
    copCalculation: calculation,
    copReportMode: "estimate",
    copRetryCount: 0,
    phase: "cop_calc_review",
    routeTo: "reviewer",
    nextAgent: "",
    reviewPass: false,
    reviewReason: "",
    reportPayload: null,
    结果: "",
    error: "",
    executedAgent: "xiaoke",
  };
}

async function handleCopReportAfterReview(
  state: ColdStorageState,
): Promise<Partial<ColdStorageState>> {
  const calculation = state.copCalculation as CopCalculation | null;
  if (!state.reviewPass || !calculation) {
    const reason =
      String(state.reviewReason ?? "").trim() ||
      state.error ||
      "质检员未通过本次COP核算结果";
    const retryCount = Number(state.copRetryCount ?? 0);
    const mode = (state.copReportMode ||
      calculation?.mode ||
      "formal") as "estimate" | "formal";

    if (retryCount < 3) {
      const nextRetry = retryCount + 1;
      logAgent(
        "xiaoke",
        `COP核算结果质检未通过（${reason}），准备第 ${nextRetry}/3 轮重试：重新调取PLC并重算`,
      );
      const plcOutcome = await fetchFreshPlcForCop(
        "xiaoke-cop-report-retry-plc",
      );
      if (!plcOutcome.ok) {
        logAgent(
          "xiaoke",
          `COP重试PLC取数失败：${plcOutcome.failureMessage}`,
        );
        return {
          phase: "cop_report_result",
          routeTo: "master",
          nextAgent: "",
          reportPayload: {
            skipped: true,
            mode,
            retryCount,
            message: `COP核算重试时PLC取数失败：${plcOutcome.failureMessage}`,
          },
          error: plcOutcome.failureMessage,
          executedAgent: "xiaoke",
        };
      }
      const snapshot = plcOutcome.snapshot;
      const copRecords = [...(state.copRecords ?? []), snapshot].slice(
        -MAX_COP_SAMPLES,
      );
      let nextCalculation: CopCalculation;
      try {
        nextCalculation =
          mode === "estimate"
            ? calculateEstimateCopCalculation(state, snapshot)
            : calculateFormalCopCalculation(state, snapshot);
      } catch (error) {
        const message =
          error instanceof CopCalculationInputError
            ? error.message
            : error instanceof ThermalLookupError
              ? error.message
              : error instanceof Error
                ? error.message
                : String(error);
        logAgent("xiaoke", `COP重试查表/核算失败：${message}`);
        return {
          phase: "cop_report_result",
          routeTo: "master",
          nextAgent: "",
          reportPayload: {
            skipped: true,
            alarmRequired: true,
            mode,
            retryCount,
            message: `COP重试时查表或核算参数缺失，终止核算：${message}`,
          },
          error: message,
          executedAgent: "xiaoke",
        };
      }
      logAgent(
        "xiaoke",
        `第 ${nextRetry}/3 轮重算完成，COP=${nextCalculation.cop}，重新提交质检`,
      );
      return {
        copRecords,
        copPlcSnapshot: snapshot,
        copCalculation: nextCalculation,
        copReportMode: mode,
        copRetryCount: nextRetry,
        phase: "cop_calc_review",
        routeTo: "reviewer",
        nextAgent: "",
        reviewPass: false,
        reviewReason: "",
        reportPayload: null,
        结果: "",
        error: "",
        executedAgent: "xiaoke",
      };
    }

    logAgent(
      "xiaoke",
      `COP核算结果重试3轮后仍未通过质检，终止本次核算，不生成报告；最后原因：${reason}`,
    );
    return {
      phase: "cop_report_result",
      routeTo: "master",
      nextAgent: "",
      reportPayload: {
        skipped: true,
        alarmRequired: true,
        mode,
        retryCount,
        message: `COP核算结果经3轮重试后仍未通过质检，本次核算终止，未生成报告。最后原因：${reason}`,
      },
      error: reason,
      executedAgent: "xiaoke",
    };
  }

  const mode = (state.copReportMode ||
    calculation.mode ||
    "formal") as "estimate" | "formal";
  logAgent("xiaoke", "质检通过，小柯正在制作COP核算报告，请稍候……");
  const displayText = formatCopReport(calculation);
  logAgent("xiaoke", "COP核算报告已生成，正在回传管理员");

  return {
    phase: "cop_report_result",
    routeTo: "master",
    nextAgent: "",
    reportPayload: {
      skipped: false,
      mode,
      label: calculation.label,
      copScope: calculation.copScope,
      scopeLabel: calculation.scopeLabel,
      roomCode: calculation.roomCode,
      rooms: calculation.rooms,
      q1W: calculation.q1W,
      q2W: calculation.q2W,
      wPowerW: calculation.wPowerW,
      thermalSource: calculation.thermalSource,
      thermalDetails: calculation.thermalDetails,
      cop: calculation.cop,
      retryCount: state.copRetryCount ?? 0,
      generatedAt: nowIso(),
      calculationGeneratedAt: calculation.generatedAt,
      sourceDocIds: calculation.sourceDocIds,
      plcSnapshot: calculation.plcSnapshot,
      lots: calculation.lots,
      appointment: calculation.appointment,
      centerTempC: calculation.centerTempC,
      roomTempC: calculation.roomTempC,
      qValue: calculation.qValue,
      qUnit: calculation.qUnit,
      totals: calculation.totals,
      displayText,
      reviewPassed: true,
    },
    error: "",
    executedAgent: "xiaoke",
  };
}

/**
 * 小柯入口：
 * 1. plc_poll：5分钟定时采集并存储PLC历史，不自动生成COP报告；
 * 2. master_request_cop_report：菜单4正式核算，实时取PLC后请求入库单；
 * 3. master_forward_to_xiaoke：正式核算结果提交reviewer；
 * 4. master_forward_estimate_to_xiaoke：无入库单时自动转预约预估并提交reviewer；
 * 5. cop_calc_review_complete：质检出结果后制报或重试/告警。
 */
export async function xiaokeNode(
  state: ColdStorageState,
): Promise<Partial<ColdStorageState>> {
  if (state.phase === "plc_poll") {
    return handlePlcPoll(state);
  }
  if (state.phase === "scheduler_arrival_deviation_check") {
    return evaluateArrivalDeviation(state);
  }
  if (state.phase === "scheduler_arrival_replan_ready") {
    return handleArrivalReplanReady(state);
  }
  if (state.phase === "master_request_cop_inbound") {
    return handleCopInboundRequest(state);
  }
  if (state.phase === "master_forward_formal_to_xiaoke") {
    return handleFormalAfterCenter(state);
  }
  if (state.phase === "master_forward_estimate_to_xiaoke") {
    return handleEstimateRequest(state);
  }
  if (state.phase === "master_request_cop_report") {
    return handleCopReportStart(state);
  }
  if (state.phase === "master_forward_to_xiaoke") {
    return handleCopCalculation(state);
  }
  if (state.phase === "cop_calc_review_complete") {
    return handleCopReportAfterReview(state);
  }

  logAgent("xiaoke", `收到无法识别的消息阶段：${state.phase || "空"}`);
  return {
    routeTo: "",
    nextAgent: "",
    phase: "",
    finalAnswer: "",
    executedAgent: "xiaoke",
  };
}
