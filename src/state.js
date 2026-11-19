import path from "node:path";
import { fileURLToPath } from "node:url";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { Annotation } from "@langchain/langgraph";
import dotenv from "dotenv";
import { managedConsoleLog } from "./console-gate";
// 项目根目录 .env，不覆盖外部已注入的环境变量
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });
export const AGENT_SCHEDULER = "调度器";
export const AGENT_XIAOKE = "小珂";
export const MAX_RETRIES = 3;
export const COP_MIN = 1.8;
export const COP_MAX = 4.2;
export const GRID_EMISSION_FACTOR_KG_PER_KWH = 0.5366;
export const COLD_ROOM_CAPACITY_TONS = (() => {
    const value = Number(process.env.COLD_ROOM_CAPACITY_TONS ?? 2000);
    return Number.isFinite(value) && value > 0 ? value : 2000;
})();
export const FRUIT_SPECS = {
    杨梅: {
        tempMin: 0.5,
        tempMax: 2,
        tempText: "0.5~2°C",
        humidity: "90%",
        dailyKwhPerTon: 2.4,
        respirationKwPerTon: 0.028,
        specificHeatKjPerKgK: 3.8,
    },
    柚子: {
        tempMin: 5,
        tempMax: 10,
        tempText: "5~10°C",
        humidity: "85%",
        dailyKwhPerTon: 1.9,
        respirationKwPerTon: 0.015,
        specificHeatKjPerKgK: 3.7,
    },
    苹果: {
        tempMin: -1,
        tempMax: 0,
        tempText: "-1~0°C",
        humidity: "90%",
        dailyKwhPerTon: 1.7,
        respirationKwPerTon: 0.012,
        specificHeatKjPerKgK: 3.6,
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
    userInput: Annotation({
        reducer: (_current, next) => next,
        default: () => "",
    }),
    menuChoice: Annotation({
        reducer: (_current, next) => next,
        default: () => "",
    }),
    account: Annotation({
        reducer: (_current, next) => next,
        default: () => "",
    }),
    accountType: Annotation({
        reducer: (_current, next) => next,
        default: () => "",
    }),
    flowType: Annotation({
        reducer: (_current, next) => next,
        default: () => "",
    }),
    phase: Annotation({
        reducer: (_current, next) => next,
        default: () => "",
    }),
    routeTo: Annotation({
        reducer: (_current, next) => next,
        default: () => "",
    }),
    taskKind: Annotation({
        reducer: (_current, next) => next,
        default: () => "",
    }),
    taskData: Annotation({
        reducer: (_current, next) => next,
        default: () => ({}),
    }),
    nextAgent: Annotation({
        reducer: (_current, next) => next,
        default: () => "",
    }),
    taskContent: Annotation({
        reducer: (_current, next) => next,
        default: () => "",
    }),
    结果: Annotation({
        reducer: (_current, next) => next,
        default: () => "",
    }),
    reviewPass: Annotation({
        reducer: (_current, next) => next,
        default: () => false,
    }),
    reviewReason: Annotation({
        reducer: (_current, next) => next,
        default: () => "",
    }),
    rejectTarget: Annotation({
        reducer: (_current, next) => next,
        default: () => "",
    }),
    retryCount: Annotation({
        reducer: (_current, next) => next,
        default: () => 0,
    }),
    记录: Annotation({
        reducer: (_current, next) => next,
        default: () => [],
    }),
    // 入库审核暂存
    pendingDocument: Annotation({
        reducer: (_current, next) => next,
        default: () => null,
    }),
    pendingUpdates: Annotation({
        reducer: (_current, next) => next,
        default: () => [],
    }),
    // Master 与 Scheduler 之间的台账查询中转
    ledgerQueryPurpose: Annotation({
        reducer: (_current, next) => next,
        default: () => "",
    }),
    ledgerDocuments: Annotation({
        reducer: (_current, next) => next,
        default: () => [],
    }),
    // 库房库存/候选库房：小柯提供状态，scheduler筛选，master展示给用户选择
    roomInventory: Annotation({
        reducer: (_current, next) => next,
        default: () => [],
    }),
    roomCandidates: Annotation({
        reducer: (_current, next) => next,
        default: () => [],
    }),
    // 小柯 PLC 定时采样与按需 COP 报告
    copRecords: Annotation({
        reducer: (_current, next) => next,
        default: () => [],
    }),
    reportPayload: Annotation({
        reducer: (_current, next) => next,
        default: () => null,
    }),
    copPlcSnapshot: Annotation({
        reducer: (_current, next) => next,
        default: () => null,
    }),
    copCalculation: Annotation({
        reducer: (_current, next) => next,
        default: () => null,
    }),
    copReportMode: Annotation({
        reducer: (_current, next) => next,
        default: () => "",
    }),
    copScope: Annotation({
        reducer: (_current, next) => next,
        default: () => "",
    }),
    copRoomCode: Annotation({
        reducer: (_current, next) => next,
        default: () => "",
    }),
    copRetryCount: Annotation({
        reducer: (_current, next) => next,
        default: () => 0,
    }),
    reportRecords: Annotation({
        reducer: (_current, next) => next,
        default: () => [],
    }),
    latestReportText: Annotation({
        reducer: (_current, next) => next,
        default: () => "",
    }),
    executedAgent: Annotation({
        reducer: (_current, next) => next,
        default: () => "",
    }),
    finalAnswer: Annotation({
        reducer: (_current, next) => next,
        default: () => "",
    }),
    error: Annotation({
        reducer: (_current, next) => next,
        default: () => "",
    }),
});
/* -------------------------------------------------------------------------- */
/* 日志与业务工具                                                              */
/* -------------------------------------------------------------------------- */
export function logAgent(agent, message) {
    managedConsoleLog(`[${agent}] ${message}`);
}
export function nowIso() {
    const date = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return [
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    ].join(" ");
}
export function toNumber(value) {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value !== "string")
        return null;
    const match = value.replace(/,/g, "").match(/[-+]?\d+(?:\.\d+)?/);
    if (!match)
        return null;
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : null;
}
export function normalizeFruit(value) {
    const text = String(value ?? "").trim();
    for (const name of Object.keys(FRUIT_SPECS)) {
        if (text.includes(name))
            return name;
    }
    return null;
}
export function parseAppointmentTime(value) {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
    }
    const text = String(value ?? "")
        .trim()
        .replace(/：/g, ":")
        .replace(/\//g, "-")
        .replace("T", " ");
    const match = /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/.exec(text);
    if (!match)
        return null;
    const [, yearText, monthText, dayText, hourText, minuteText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const date = new Date(year, month - 1, day, hour, minute, 0, 0);
    if (date.getFullYear() !== year ||
        date.getMonth() !== month - 1 ||
        date.getDate() !== day ||
        date.getHours() !== hour ||
        date.getMinutes() !== minute) {
        return null;
    }
    return date;
}
export function formatDateTime(value) {
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime()))
            return "";
        const pad = (part) => String(part).padStart(2, "0");
        return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
    }
    const parsed = parseAppointmentTime(value);
    return parsed ? formatDateTime(parsed) : String(value ?? "");
}
export function nextDocId(prefix, records) {
    const date = new Date();
    const datePart = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
    const ids = new Set((records ?? [])
        .map((record) => record?.docId)
        .filter((id) => typeof id === "string"));
    let sequence = 1;
    while (ids.has(`${prefix}-${datePart}-${String(sequence).padStart(3, "0")}`)) {
        sequence += 1;
    }
    return `${prefix}-${datePart}-${String(sequence).padStart(3, "0")}`;
}
export function findAppointmentRecord(records, appointmentId) {
    const target = String(appointmentId ?? "").trim().toUpperCase();
    if (!target)
        return undefined;
    return (records ?? []).find((record) => record?.docType === "appointment" &&
        String(record?.docId ?? "").trim().toUpperCase() === target);
}
export function addDays(value, days) {
    return new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
}
export function capacityConflict(records, scheduledAt, storageDays, tonnage, excludeDocId = "") {
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
        if (record?.docType !== "appointment")
            continue;
        if (record?.status === "cancelled")
            continue;
        if (excludeDocId && record?.docId === excludeDocId)
            continue;
        const otherStart = parseAppointmentTime(record?.scheduledAt);
        const otherDays = toNumber(record?.storageDays);
        if (!otherStart || otherDays === null || otherDays <= 0)
            continue;
        const otherEnd = addDays(otherStart, otherDays);
        if (scheduledAt < otherEnd && newEnd > otherStart) {
            occupied += toNumber(record?.actualTonnage ?? record?.tonnage) ?? 0;
        }
    }
    return occupied + tonnage > COLD_ROOM_CAPACITY_TONS + 1e-9
        ? `库容时段冲突，重叠占用 ${occupied.toFixed(1)} t。`
        : null;
}
export function applyPendingChanges(records, pendingRecord, pendingUpdates) {
    const merged = JSON.parse(JSON.stringify(records ?? []));
    const addedIds = [];
    const updatedIds = [];
    if (pendingRecord) {
        const docId = String(pendingRecord?.docId ?? "");
        if (docId && !merged.some((item) => item?.docId === docId)) {
            merged.push(JSON.parse(JSON.stringify(pendingRecord)));
            addedIds.push(docId);
        }
    }
    for (const update of pendingUpdates ?? []) {
        const docId = String(update?.docId ?? "");
        const patch = update?.patch;
        if (!docId || !patch || typeof patch !== "object")
            continue;
        const target = merged.find((item) => item?.docId === docId);
        if (!target)
            continue;
        Object.assign(target, JSON.parse(JSON.stringify(patch)));
        updatedIds.push(docId);
    }
    return { records: merged, addedIds, updatedIds };
}
function roomDisplay(record) {
    const roomCode = String(record?.roomCode ?? "").trim();
    const roomName = String(record?.roomName ?? "").trim();
    if (roomName && roomCode)
        return `${roomName}（${roomCode}）`;
    if (roomName)
        return roomName;
    if (roomCode)
        return roomCode;
    return "-";
}
export function recordBrief(record) {
    const docId = String(record?.docId ?? "无单号");
    const creator = String(record?.createdBy ?? "未知");
    if (record?.docType === "appointment") {
        return `${docId} | 入库预约单 | ${record?.statusName ?? record?.status ?? "-"} | ${record?.fruit ?? "-"} ${Number(record?.tonnage ?? 0).toFixed(1)}t | 库房 ${roomDisplay(record)} | 入库 ${formatDateTime(record?.scheduledAt)} | 贮藏 ${record?.storageDays ?? "-"} 天 | ${record?.tempZone ?? "-"} | 创建人 ${creator}`;
    }
    if (record?.docType === "arrival") {
        return `${docId} | 到货入库单 | ${record?.statusName ?? record?.status ?? "-"} | 关联 ${record?.appointmentId ?? "-"} | 库房 ${roomDisplay(record)} | ${record?.fruit ?? "-"} ${Number(record?.actualTonnage ?? 0).toFixed(1)}t | 货温 ${record?.cargoTempC ?? "-"}℃ | 创建人 ${creator}`;
    }
    return `${docId} | ${record?.docTypeName ?? record?.docType ?? "单据"} | ${record?.statusName ?? record?.status ?? "-"} | 创建人 ${creator}`;
}
export function ledgerText(records, title = "入库台账") {
    if (!records || records.length === 0) {
        return `${title}为空。`;
    }
    return [
        `${title}（共 ${records.length} 条）：`,
        ...records.map((record, index) => `${index + 1}. ${recordBrief(record)}`),
    ].join("\n");
}
function contentToText(content) {
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
            if (typeof part === "string")
                return part;
            if (part && typeof part === "object" && "text" in part) {
                return String(part.text ?? "");
            }
            return "";
        })
            .join("");
    }
    return String(content ?? "");
}
function buildApiMessages(systemPrompt, userPrompt) {
    // 使用 @langchain/core 的消息结构组织提示词
    const messages = [new SystemMessage(systemPrompt), new HumanMessage(userPrompt)];
    return messages.map((message, index) => ({
        role: index === 0 ? "system" : "user",
        content: contentToText(message.content),
    }));
}
function extractJsonObject(text) {
    const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    try {
        const parsed = JSON.parse(cleaned);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : null;
    }
    catch {
        const start = cleaned.indexOf("{");
        const end = cleaned.lastIndexOf("}");
        if (start < 0 || end <= start)
            return null;
        try {
            const parsed = JSON.parse(cleaned.slice(start, end + 1));
            return parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? parsed
                : null;
        }
        catch {
            return null;
        }
    }
}
function chatCompletionsUrl(baseUrl) {
    const normalized = baseUrl.trim().replace(/\/+$/, "");
    return normalized.endsWith("/chat/completions")
        ? normalized
        : `${normalized}/chat/completions`;
}
export async function callDeepSeekJson(systemPrompt, userPrompt, options = {}) {
    const apiKey = String(process.env.DEEPSEEK_API_KEY ?? "").trim();
    if (!apiKey) {
        throw new Error("缺少 DEEPSEEK_API_KEY，请检查项目根目录的 .env 文件。");
    }
    const baseUrl = String(process.env.DEEPSEEK_BASE_URL ?? "").trim() ||
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
        const payload = (await response.json());
        lastContent = contentToText(payload?.choices?.[0]?.message?.content);
        const parsed = extractJsonObject(lastContent);
        if (parsed)
            return parsed;
        if (attempt === 0) {
            messages.push({
                role: "user",
                content: "上一条输出不是合法 JSON。请只返回一个 JSON 对象，不要 Markdown 代码块和额外解释。",
            });
        }
    }
    throw new Error(`DeepSeek 未返回可解析的 JSON：${lastContent.slice(0, 200)}`);
}
export function safeJson(value) {
    try {
        return JSON.stringify(value, null, 2);
    }
    catch {
        return String(value);
    }
}
