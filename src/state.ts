import path from "node:path";
import { fileURLToPath } from "node:url";

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { Annotation } from "@langchain/langgraph";
import dotenv from "dotenv";
import { managedConsoleLog } from "./console-gate";
import type { AccountType } from "./account-store";

// 项目根目录 .env，不覆盖外部已注入的环境变量
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });

export const AGENT_SCHEDULER = "调度器" as const;
export const AGENT_XIAOKE = "小珂" as const;
export type AgentName = "" | typeof AGENT_SCHEDULER | typeof AGENT_XIAOKE;

export type FlowType = "" | "user" | "plc";
export type RouteTarget = "" | "master" | "scheduler" | "reviewer" | "xiaoke";
export type TaskKind =
  | ""
  | "appointment"
  | "arrival"
  | "ledger"
  | "cop_report"
  | "cop_estimate"
  | "clear_cop_alarm"
  | "clear_device_alarm"
  | "plc_poll";
export type LedgerQueryPurpose =
  | ""
  | "user_ledger"
  | "my_appointments"
  | "cop_report"
  | "cop_inbound"
  | "appointment_estimate";
export type FlowPhase =
  | ""
  | "user_start"
  | "master_dispatch_inbound"
  | "master_query_ledger_user"
  | "scheduler_ledger_result"
  | "inbound_awaiting_review"
  | "scheduler_rectification_request"
  | "scheduler_rectification_ready"
  | "review_complete"
  | "inbound_done"
  | "inbound_failed"
  | "plc_poll"
  | "master_request_cop_report"
  | "master_request_cop_inbound"
  | "cop_inbound_request"
  | "master_query_cop_inbound"
  | "master_query_appointments_estimate"
  | "waiting_center_temp"
  | "center_temp_provided"
  | "master_forward_formal_to_xiaoke"
  | "cop_ledger_request"
  | "master_query_ledger_cop"
  | "master_forward_to_xiaoke"
  | "master_query_ledger_estimate"
  | "master_forward_estimate_to_xiaoke"
  | "scheduler_room_status_request"
  | "master_room_status_ok"
  | "scheduler_room_inventory_request"
  | "master_room_inventory_ready"
  | "scheduler_room_candidates_result"
  | "scheduler_room_precheck"
  | "reviewer_room_precheck_failed"
  | "waiting_room_choice"
  | "room_choice_provided"
  | "master_room_choice_confirmed"
  | "scheduler_arrival_deviation_check"
  | "arrival_deviation_ok"
  | "scheduler_arrival_review"
  | "arrival_deviation_alert"
  | "waiting_arrival_replan"
  | "arrival_replan_choice_provided"
  | "master_arrival_replan_request"
  | "scheduler_arrival_replan_ready"
  | "appointment_timeout_alert"
  | "waiting_timeout_rebook"
  | "appointment_timeout_choice_provided"
  | "cop_calc_review"
  | "cop_calc_review_complete"
  | "cop_report_result"
  | "device_abnormal_alert";

export const MAX_RETRIES = 3;
export const DEMO_MODE =
  process.env.COLD_STORAGE_DEMO_MODE === "1" ||
  process.env.COLD_STORAGE_DEMO_MODE === "true";
export const COP_MIN = 1.8;
export const COP_MAX = 4.2;
export const GRID_EMISSION_FACTOR_KG_PER_KWH = 0.5366;
export const COLD_ROOM_CAPACITY_TONS = (() => {
  const value = Number(process.env.COLD_ROOM_CAPACITY_TONS ?? 2000);
  return Number.isFinite(value) && value > 0 ? value : 2000;
})();

export interface FruitSpec {
  tempMin: number;
  tempMax: number;
  tempText: string;
  humidity: string;
  dailyKwhPerTon: number;
}

/** 预约阶段Q1查表使用果品推荐贮藏温区的中间温度。 */
export function recommendedStorageTempC(fruit: string): number | null {
  const spec = FRUIT_SPECS[fruit];
  if (!spec) return null;
  return (spec.tempMin + spec.tempMax) / 2;
}

export const FRUIT_SPECS: Record<string, FruitSpec> = {
  杨梅: {
    tempMin: 0.5,
    tempMax: 2,
    tempText: "0.5~2°C",
    humidity: "90%",
    dailyKwhPerTon: 2.4,
  },
  柚子: {
    tempMin: 5,
    tempMax: 10,
    tempText: "5~10°C",
    humidity: "85%",
    dailyKwhPerTon: 1.9,
  },
  苹果: {
    tempMin: -1,
    tempMax: 0,
    tempText: "-1~0°C",
    humidity: "90%",
    dailyKwhPerTon: 1.7,
  },
};

/**
 * 双链路状态：
 * - 用户链路：master -> scheduler -> reviewer -> scheduler -> master
 * - 小柯异步链路：xiaoke -> master -> scheduler -> master -> xiaoke -> master
 *
 * 指定字段仍然保留：userInput、nextAgent、taskContent、结果、reviewPass、
 * rejectTarget、retryCount、记录。
 */
export const ColdStorageStateAnnotation = Annotation.Root({
  userInput: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),
  menuChoice: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),
  account: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),
  accountType: Annotation<AccountType | "">({
    reducer: (_current, next) => next,
    default: () => "",
  }),
  flowType: Annotation<FlowType>({
    reducer: (_current, next) => next,
    default: () => "",
  }),
  phase: Annotation<FlowPhase>({
    reducer: (_current, next) => next,
    default: () => "",
  }),
  routeTo: Annotation<RouteTarget>({
    reducer: (_current, next) => next,
    default: () => "",
  }),
  taskKind: Annotation<TaskKind>({
    reducer: (_current, next) => next,
    default: () => "",
  }),
  taskData: Annotation<Record<string, any>>({
    reducer: (_current, next) => next,
    default: () => ({}),
  }),
  nextAgent: Annotation<AgentName>({
    reducer: (_current, next) => next,
    default: () => "",
  }),
  taskContent: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),
  结果: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),
  reviewPass: Annotation<boolean>({
    reducer: (_current, next) => next,
    default: () => false,
  }),
  reviewReason: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),
  rectificationGuidance: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),
  arrivalDeviation: Annotation<Record<string, any> | null>({
    reducer: (_current, next) => next,
    default: () => null,
  }),
  arrivalReplanChoice: Annotation<"" | "add" | "change">({
    reducer: (_current, next) => next,
    default: () => "",
  }),
  arrivalReplanRevision: Annotation<number>({
    reducer: (_current, next) => next,
    default: () => 0,
  }),
  rejectTarget: Annotation<AgentName>({
    reducer: (_current, next) => next,
    default: () => "",
  }),
  retryCount: Annotation<number>({
    reducer: (_current, next) => next,
    default: () => 0,
  }),
  记录: Annotation<Array<Record<string, any>>>({
    reducer: (_current, next) => next,
    default: () => [],
  }),

  // 入库审核暂存
  pendingDocument: Annotation<Record<string, any> | null>({
    reducer: (_current, next) => next,
    default: () => null,
  }),
  pendingUpdates: Annotation<Array<Record<string, any>>>({
    reducer: (_current, next) => next,
    default: () => [],
  }),

  // Master 与 Scheduler 之间的台账查询中转
  ledgerQueryPurpose: Annotation<LedgerQueryPurpose>({
    reducer: (_current, next) => next,
    default: () => "",
  }),
  ledgerDocuments: Annotation<Array<Record<string, any>>>({
    reducer: (_current, next) => next,
    default: () => [],
  }),

  // COP取单诊断：区分单据不存在、未通过质检、通讯异常等
  copInboundDiagnostic: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),
  copAppointmentDiagnostic: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),

  // 库房库存/候选库房：小柯提供状态，scheduler筛选，master展示给用户选择
  roomInventory: Annotation<Array<Record<string, any>>>({
    reducer: (_current, next) => next,
    default: () => [],
  }),
  roomCandidates: Annotation<Array<Record<string, any>>>({
    reducer: (_current, next) => next,
    default: () => [],
  }),
  roomPrecheckAttempt: Annotation<number>({
    reducer: (_current, next) => next,
    default: () => 0,
  }),
  roomPrecheckRejectedRooms: Annotation<string[]>({
    reducer: (_current, next) => next,
    default: () => [],
  }),
  roomPrecheckFailures: Annotation<Array<Record<string, any>>>({
    reducer: (_current, next) => next,
    default: () => [],
  }),

  // 小柯 PLC 定时采样与按需 COP 报告
  copRecords: Annotation<Array<Record<string, any>>>({
    reducer: (_current, next) => next,
    default: () => [],
  }),
  thermalPlcHistory: Annotation<Array<Record<string, any>>>({
    reducer: (_current, next) => next,
    default: () => [],
  }),
  reportPayload: Annotation<Record<string, any> | null>({
    reducer: (_current, next) => next,
    default: () => null,
  }),
  copPlcSnapshot: Annotation<Record<string, any> | null>({
    reducer: (_current, next) => next,
    default: () => null,
  }),
  copCalculation: Annotation<Record<string, any> | null>({
    reducer: (_current, next) => next,
    default: () => null,
  }),
  copReportMode: Annotation<"" | "estimate" | "formal">({
    reducer: (_current, next) => next,
    default: () => "",
  }),
  copScope: Annotation<"" | "single" | "allocated">({
    reducer: (_current, next) => next,
    default: () => "",
  }),
  copRoomCode: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),
  copRetryCount: Annotation<number>({
    reducer: (_current, next) => next,
    default: () => 0,
  }),
  reportRecords: Annotation<Array<Record<string, any>>>({
    reducer: (_current, next) => next,
    default: () => [],
  }),
  latestReportText: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),

  executedAgent: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),
  finalAnswer: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),
  error: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),
});

export type ColdStorageState = typeof ColdStorageStateAnnotation.State;

/* -------------------------------------------------------------------------- */
/* 日志与业务工具                                                              */
/* -------------------------------------------------------------------------- */

export function logAgent(agent: "master" | "scheduler" | "reviewer" | "xiaoke", message: string): void {
  managedConsoleLog(`[${agent}] ${message}`);
}

export function nowIso(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  ].join(" ");
}

export function toNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;
  const match = value.replace(/,/g, "").match(/[-+]?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeFruit(value: unknown): string | null {
  const text = String(value ?? "").trim();
  for (const name of Object.keys(FRUIT_SPECS)) {
    if (text.includes(name)) return name;
  }
  return null;
}

export function parseAppointmentTime(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const text = String(value ?? "")
    .trim()
    .replace(/：/g, ":")
    .replace(/\//g, "-")
    .replace("T", " ");
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    return null;
  }
  return date;
}

export function formatDateTime(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    const pad = (part: number) => String(part).padStart(2, "0");
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(
      value.getDate(),
    )} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
  }
  const parsed = parseAppointmentTime(value);
  return parsed ? formatDateTime(parsed) : String(value ?? "");
}

export function nextDocId(
  prefix: string,
  records: Array<Record<string, any>> | undefined,
): string {
  const date = new Date();
  const datePart = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(
    2,
    "0",
  )}${String(date.getDate()).padStart(2, "0")}`;
  const ids = new Set(
    (records ?? [])
      .map((record) => record?.docId)
      .filter((id): id is string => typeof id === "string"),
  );
  let sequence = 1;
  while (ids.has(`${prefix}-${datePart}-${String(sequence).padStart(3, "0")}`)) {
    sequence += 1;
  }
  return `${prefix}-${datePart}-${String(sequence).padStart(3, "0")}`;
}

export function findAppointmentRecord(
  records: Array<Record<string, any>> | undefined,
  appointmentId: unknown,
): Record<string, any> | undefined {
  const target = String(appointmentId ?? "").trim().toUpperCase();
  if (!target) return undefined;
  return (records ?? []).find(
    (record) =>
      record?.docType === "appointment" &&
      String(record?.docId ?? "").trim().toUpperCase() === target,
  );
}

export function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
}

export function capacityConflict(
  records: Array<Record<string, any>> | undefined,
  scheduledAt: Date,
  storageDays: number,
  tonnage: number,
  excludeDocId = "",
): string | null {
  if (!Number.isFinite(storageDays) || storageDays <= 0) {
    return "计划贮藏天数必须为正数。";
  }
  if (!Number.isFinite(tonnage) || tonnage <= 0) {
    return "吨位必须为正数。";
  }
  if (tonnage > COLD_ROOM_CAPACITY_TONS) {
    return `单笔超过总库容 ${COLD_ROOM_CAPACITY_TONS} t。`;
  }

  const newEnd = addDays(scheduledAt, storageDays);
  let occupied = 0;
  for (const record of records ?? []) {
    if (record?.docType !== "appointment") continue;
    if (record?.status === "cancelled") continue;
    if (excludeDocId && record?.docId === excludeDocId) continue;
    const otherStart = parseAppointmentTime(record?.scheduledAt);
    const otherDays = toNumber(record?.storageDays);
    if (!otherStart || otherDays === null || otherDays <= 0) continue;
    const otherEnd = addDays(otherStart, otherDays);
    if (scheduledAt < otherEnd && newEnd > otherStart) {
      occupied += toNumber(record?.actualTonnage ?? record?.tonnage) ?? 0;
    }
  }
  return occupied + tonnage > COLD_ROOM_CAPACITY_TONS + 1e-9
    ? `库容时段冲突，重叠占用 ${occupied.toFixed(1)} t。`
    : null;
}

export function applyPendingChanges(
  records: Array<Record<string, any>> | undefined,
  pendingRecord: Record<string, any> | null | undefined,
  pendingUpdates: Array<Record<string, any>> | undefined,
): {
  records: Array<Record<string, any>>;
  addedIds: string[];
  updatedIds: string[];
} {
  const merged = JSON.parse(JSON.stringify(records ?? [])) as Array<
    Record<string, any>
  >;
  const addedIds: string[] = [];
  const updatedIds: string[] = [];

  if (pendingRecord) {
    const docId = String(pendingRecord?.docId ?? "");
    if (docId && !merged.some((item) => item?.docId === docId)) {
      merged.push(JSON.parse(JSON.stringify(pendingRecord)) as Record<string, any>);
      addedIds.push(docId);
    }
  }

  for (const update of pendingUpdates ?? []) {
    const docId = String(update?.docId ?? "");
    const patch = update?.patch;
    if (!docId || !patch || typeof patch !== "object") continue;
    const target = merged.find((item) => item?.docId === docId);
    if (!target) continue;
    Object.assign(target, JSON.parse(JSON.stringify(patch)));
    updatedIds.push(docId);
  }

  return { records: merged, addedIds, updatedIds };
}

function roomDisplay(record: Record<string, any>): string {
  const roomCode = String(record?.roomCode ?? "").trim();
  const roomName = String(record?.roomName ?? "").trim();
  if (roomName && roomCode) return `${roomName}（${roomCode}）`;
  if (roomName) return roomName;
  if (roomCode) return roomCode;
  return "-";
}

export function recordBrief(record: Record<string, any>): string {
  const docId = String(record?.docId ?? "无单号");
  const creator = String(record?.createdBy ?? "未知");
  if (record?.docType === "appointment") {
    return `${docId} | 入库预约单 | ${record?.statusName ?? record?.status ?? "-"} | ${
      record?.fruit ?? "-"
    } ${Number(record?.tonnage ?? 0).toFixed(1)}t | 预约果温 ${
      record?.fruitTempC ?? "-"
    }℃ | 库房 ${roomDisplay(record)} | 入库 ${formatDateTime(
      record?.scheduledAt,
    )} | 贮藏 ${record?.storageDays ?? "-"} 天 | ${
      record?.tempZone ?? "-"
    } | 创建人 ${creator}`;
  }
  if (record?.docType === "arrival") {
    return `${docId} | 到货入库单 | ${record?.statusName ?? record?.status ?? "-"} | 关联 ${
      record?.appointmentId ?? "-"
    } | 库房 ${roomDisplay(record)} | ${record?.fruit ?? "-"} ${Number(
      record?.actualTonnage ?? 0,
    ).toFixed(1)}t | 货温 ${record?.cargoTempC ?? "-"}℃ | 创建人 ${creator}`;
  }
  return `${docId} | ${record?.docTypeName ?? record?.docType ?? "单据"} | ${
    record?.statusName ?? record?.status ?? "-"
  } | 创建人 ${creator}`;
}

export function ledgerText(
  records: Array<Record<string, any>> | undefined,
  title = "入库台账",
): string {
  if (!records || records.length === 0) {
    return `${title}为空。`;
  }
  return [
    `${title}（共 ${records.length} 条）：`,
    ...records.map((record, index) => `${index + 1}. ${recordBrief(record)}`),
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* DeepSeek 客户端（只给 reviewer 使用）                                       */
/* -------------------------------------------------------------------------- */

interface DeepSeekApiMessage {
  role: "system" | "user";
  content: string;
}

interface DeepSeekResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .join("");
  }
  return String(content ?? "");
}

function buildApiMessages(
  systemPrompt: string,
  userPrompt: string,
): DeepSeekApiMessage[] {
  // 使用 @langchain/core 的消息结构组织提示词
  const messages = [new SystemMessage(systemPrompt), new HumanMessage(userPrompt)];
  return messages.map((message, index) => ({
    role: index === 0 ? "system" : "user",
    content: contentToText(message.content),
  }));
}

function extractJsonObject(text: string): Record<string, any> | null {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, any>)
      : null;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, any>)
        : null;
    } catch {
      return null;
    }
  }
}

function chatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  return normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
}

export async function callDeepSeekJson<T extends Record<string, any>>(
  systemPrompt: string,
  userPrompt: string,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const apiKey = String(process.env.DEEPSEEK_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error("缺少 DEEPSEEK_API_KEY，请检查项目根目录的 .env 文件。");
  }
  const baseUrl =
    String(process.env.DEEPSEEK_BASE_URL ?? "").trim() ||
    "https://api.deepseek.com";
  const model = String(process.env.DEEPSEEK_MODEL ?? "").trim() || "deepseek-chat";
  const messages = buildApiMessages(systemPrompt, userPrompt);
  const requestSignal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
    : AbortSignal.timeout(120_000);
  let lastContent = "";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(chatCompletionsUrl(baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.1,
        max_tokens: 1024,
        response_format: { type: "json_object" },
        stream: false,
      }),
      signal: requestSignal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`DeepSeek API 返回 ${response.status}：${detail.slice(0, 300)}`);
    }

    const payload = (await response.json()) as DeepSeekResponse;
    lastContent = contentToText(payload?.choices?.[0]?.message?.content);
    const parsed = extractJsonObject(lastContent);
    if (parsed) return parsed as T;

    if (attempt === 0) {
      messages.push({
        role: "user",
        content:
          "上一条输出不是合法 JSON。请只返回一个 JSON 对象，不要 Markdown 代码块和额外解释。",
      });
    }
  }

  throw new Error(`DeepSeek 未返回可解析的 JSON：${lastContent.slice(0, 200)}`);
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
