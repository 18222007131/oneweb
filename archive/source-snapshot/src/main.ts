import { randomUUID } from "node:crypto";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";

import {
  COLD_ROOM_CAPACITY_TONS,
  ColdStorageState,
  ColdStorageStateAnnotation,
  TaskKind,
  formatDateTime,
  parseAppointmentTime,
  toNumber,
} from "./state";
import { masterNode } from "./agents/master";
import { reviewerNode } from "./agents/reviewer";
import { schedulerNode } from "./agents/scheduler";
import { xiaokeNode } from "./agents/xiaoke";
import {
  managedConsoleLog,
  setInteractiveInputActive,
} from "./console-gate";
import {
  accountTypeLabel,
  canAccessBusinessMenu,
  getAutoLoginAccount,
  loginAccount,
  logoutAccount,
} from "./account-store";
import type { AccountSession, AccountType } from "./account-store";
import {
  getCopAlarm,
  getDeviceAlarm,
  getEquipmentSnapshot,
} from "./equipment-registry";

const PLC_POLL_INTERVAL_MS = (() => {
  const value = Number(
    process.env.PLC_POLL_INTERVAL_MS ??
      process.env.XIAOKE_INTERVAL_MS ??
      5 * 60 * 1000,
  );
  return Number.isFinite(value) && value >= 3_000
    ? value
    : 5 * 60 * 1000;
})();

type MasterRoute = "scheduler" | "xiaoke" | "end";
type SchedulerRoute = "reviewer" | "master" | "xiaoke";
type ReviewerRoute = "scheduler" | "xiaoke" | "master";
type XiaokeRoute = "master" | "reviewer" | "scheduler" | "end";

/** 构建同一张 LangGraph：START 区分用户链路和小柯PLC定时采样链路。 */
export function buildGraph() {
  const graph = new StateGraph(ColdStorageStateAnnotation)
    .addNode("master", masterNode)
    .addNode("scheduler", schedulerNode)
    .addNode("reviewer", reviewerNode)
    .addNode("xiaoke", xiaokeNode)
    .addConditionalEdges(
      START,
      (state: ColdStorageState): "master" | "xiaoke" =>
        state.flowType === "plc" && state.phase === "plc_poll"
          ? "xiaoke"
          : "master",
      {
        master: "master",
        xiaoke: "xiaoke",
      },
    )
    .addConditionalEdges(
      "master",
      (state: ColdStorageState): MasterRoute => {
        if (state.routeTo === "scheduler") return "scheduler";
        if (state.routeTo === "xiaoke") return "xiaoke";
        return "end";
      },
      {
        scheduler: "scheduler",
        xiaoke: "xiaoke",
        end: END,
      },
    )
    .addConditionalEdges(
      "scheduler",
      (state: ColdStorageState): SchedulerRoute => {
        if (state.routeTo === "reviewer") return "reviewer";
        if (state.routeTo === "xiaoke") return "xiaoke";
        return "master";
      },
      {
        reviewer: "reviewer",
        master: "master",
        xiaoke: "xiaoke",
      },
    )
    .addConditionalEdges(
      "reviewer",
      (state: ColdStorageState): ReviewerRoute => {
        if (state.routeTo === "xiaoke") return "xiaoke";
        if (state.routeTo === "master") return "master";
        return "scheduler";
      },
      {
        scheduler: "scheduler",
        xiaoke: "xiaoke",
        master: "master",
      },
    )
    .addConditionalEdges(
      "xiaoke",
      (state: ColdStorageState): XiaokeRoute => {
        if (state.flowType === "plc") {
          return state.routeTo === "master" ? "master" : "end";
        }
        if (state.routeTo === "reviewer") return "reviewer";
        if (state.routeTo === "scheduler") return "scheduler";
        return state.routeTo === "master" ? "master" : "end";
      },
      {
        master: "master",
        reviewer: "reviewer",
        scheduler: "scheduler",
        end: END,
      },
    );

  return graph.compile({ checkpointer: new MemorySaver() });
}

/**
 * 注意：scheduler 没有指向 xiaoke 的边。
 * 定时链路只有 xiaoke -> PLC，直接保存COP/W采样，不经过Master，也不生成报告。
 * 管理员请求COP报告时才走：master -> xiaoke -> master -> scheduler -> master -> xiaoke -> master。
 */

function printMenu(session: AccountSession): void {
  const internal = session.type === "internal";
  const lines = [
    "",
    "============================================================",
    "冷库多智能体管理平台（LangGraph JS + DeepSeek）",
    `当前账号：${session.username}（${accountTypeLabel(session.type)}）`,
    "============================================================",
  ];
  lines.push("1. 提交入库预约（果品/吨位/入库时间/贮藏天数）");
  if (internal) {
    lines.push("2. 录入到货入库单");
  }
  lines.push(
    `3. ${internal ? "查看历史入库台账" : "查看我的预约单"}`,
  );
  if (internal) {
    lines.push("4. 请求小柯COP核算报告（自动判断正式/预估）");
  }
  lines.push("5. 切换账号", "6. 退出登录");
  if (internal) {
    lines.push(
      "8. 解除核算异常警报",
      "9. 解除设备异常标记",
    );
  }
  lines.push("0. 退出");
  lines.push("------------------------------------------------------------");
  if (internal) {
    const equipment = getEquipmentSnapshot();
    const copAlarm = getCopAlarm();
    const deviceAlarm = getDeviceAlarm();
    lines.push(
      "说明：库内、库外账号均可提交入库预约，预约表单只填写果品/吨位/入库时间/贮藏天数。",
      "      库内人员通过菜单4发起COP核算，不需要手动录入果品、吨位或温度；小柯自动取已审核单据。",
      "      小柯自动调取已通过质检的预约单/入库单；有入库单走正式核算，仅有预约单则走预约预估。",
      "      小柯定时向PLC请求温度/压力，每次计算W和COP后只保存采样，不生成报告。",
      `当前状态：${
        deviceAlarm
          ? `设备异常未解除（${deviceAlarm.roomId}/${deviceAlarm.unitId}，菜单9排查解除）`
          : `设备正常（${equipment.roomId}/${equipment.unitId}）`
      }；${
        copAlarm
          ? `核算异常警报未解除（菜单8）`
          : "无核算异常警报"
      }。`,
    );
  } else {
    lines.push(
      "权限：库外账号可填写预约表单、提交预约并查看自己的预约单。",
      "      库内账号也可提交预约，并负责到货入库、COP核算、库房筛选确认和警报处理。",
    );
  }
  lines.push("");
  console.log(lines.join("\n"));
}

async function askRequired(
  rl: ReturnType<typeof createInterface>,
  label: string,
): Promise<string> {
  while (true) {
    const value = (await rl.question(`${label}：`)).trim();
    if (value) return value;
    console.log("该项不能为空，请重新输入。");
  }
}

interface CollectedTask {
  taskKind: TaskKind;
  taskData: Record<string, any>;
  userInput: string;
}

function normalizeRoomCode(value: unknown): string {
  const code = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]\d{1,3}$/.test(code) ? code : "";
}

async function askCopScope(
  rl: ReturnType<typeof createInterface>,
): Promise<{ copScope: "single" | "allocated"; roomCode: string }> {
  console.log("\nmaster：请选择COP核算类型：");
  console.log("1. 单库房COP（必须填写库房编号，如A1）");
  console.log("2. 机组分摊等效COP（一机拖多库房时按热负荷比例分摊总功耗）");
  let choice = "";
  while (!["1", "2"].includes(choice)) {
    choice = (await rl.question("核算类型编号（1/2）：")).trim();
    if (!["1", "2"].includes(choice)) {
      console.log("请输入 1 或 2。");
    }
  }
  if (choice === "1") {
    let roomCode = "";
    while (!roomCode) {
      const input = await askRequired(
        rl,
        "库房编号（区域号+编号，例如A区1号为A1）",
      );
      roomCode = normalizeRoomCode(input);
      if (!roomCode) {
        console.log("库房编号格式错误，必须为区域号+编号，如A区1号为A1、B区2号为B2，请重新输入。");
      }
    }
    return { copScope: "single", roomCode };
  }
  return { copScope: "allocated", roomCode: "" };
}

async function collectTask(
  rl: ReturnType<typeof createInterface>,
  choice: string,
  accountType: AccountType,
): Promise<CollectedTask> {
  if (choice === "1") {
    console.log("\n请输入预约字段（预约阶段不录入到货实测货温）：");
    const fruit = await askRequired(rl, "果品（杨梅/柚子/苹果）");
    let tonnage = await askRequired(rl, "吨位（t）");
    let tonnageValue = toNumber(tonnage);
    while (
      tonnageValue === null ||
      tonnageValue <= 0 ||
      tonnageValue > COLD_ROOM_CAPACITY_TONS
    ) {
      console.log(
        `库容错误：最大输入容量为 ${COLD_ROOM_CAPACITY_TONS} 吨，请输入大于0且不超过该上限的吨位。`,
      );
      tonnage = await askRequired(rl, "吨位（t）");
      tonnageValue = toNumber(tonnage);
    }

    let scheduledAt = await askRequired(
      rl,
      "预约入库时间（YYYY-MM-DD HH:MM）",
    );
    let scheduledDate = parseAppointmentTime(scheduledAt);
    while (!scheduledDate || scheduledDate.getTime() <= Date.now()) {
      console.log(
        `时间错误：预约时间必须晚于当前本机时间（${formatDateTime(
          new Date(),
        )}），请重新输入。`,
      );
      scheduledAt = await askRequired(
        rl,
        "预约入库时间（YYYY-MM-DD HH:MM）",
      );
      scheduledDate = parseAppointmentTime(scheduledAt);
    }
    const normalizedScheduledAt = formatDateTime(scheduledDate);
    const storageDays = await askRequired(rl, "计划贮藏天数（天）");
    return {
      taskKind: "appointment",
      taskData: {
        fruit,
        tonnage,
        scheduledAt: normalizedScheduledAt,
        storageDays,
      },
      userInput: `提交入库预约：果品${fruit}，吨位${tonnage}吨，预约入库时间${normalizedScheduledAt}，计划贮藏${storageDays}天；库房由调度者按果品和状态筛选后选择。Q1采用该果品推荐贮藏温区的呼吸强度。`,
    };
  }

  if (choice === "2") {
    console.log("\n请输入到货入库字段：");
    const appointmentId = await askRequired(rl, "关联预约单号");
    let actualTonnage = await askRequired(rl, "实际到货吨位（t）");
    let actualTonnageValue = toNumber(actualTonnage);
    while (
      actualTonnageValue === null ||
      actualTonnageValue <= 0 ||
      actualTonnageValue > COLD_ROOM_CAPACITY_TONS
    ) {
      console.log(
        `库容错误：最大输入容量为 ${COLD_ROOM_CAPACITY_TONS} 吨，请输入大于0且不超过该上限的实际到货吨位。`,
      );
      actualTonnage = await askRequired(rl, "实际到货吨位（t）");
      actualTonnageValue = toNumber(actualTonnage);
    }
    const cargoTempC = await askRequired(rl, "到货货温（℃）");
    return {
      taskKind: "arrival",
      taskData: { appointmentId, actualTonnage, cargoTempC },
      userInput: `录入到货入库单：关联预约单号${appointmentId}，实际到货${actualTonnage}吨，到货货温${cargoTempC}℃。`,
    };
  }

  if (choice === "3") {
    return {
      taskKind: "ledger",
      taskData: {},
      userInput:
        accountType === "external"
          ? "查看我的预约单。"
          : "查看历史入库台账。",
    };
  }

  if (choice === "4") {
    const scope = await askCopScope(rl);
    return {
      taskKind: "cop_report",
      taskData: {
        copScope: scope.copScope,
        roomCode: scope.roomCode,
      },
      userInput: `请求小柯COP核算报告（${
        scope.copScope === "single"
          ? `单库房COP，库房${scope.roomCode}`
          : "机组分摊等效COP"
      }）。`,
    };
  }

  return {
    taskKind: "cop_report",
    taskData: {},
    userInput: "请求小柯COP核算报告。",
  };
}

function createUserTurnState(
  choice: string,
  task: CollectedTask,
  copRecords: Array<Record<string, any>>,
  session: AccountSession,
): Partial<ColdStorageState> {
  return {
    flowType: "user",
    phase: "user_start",
    routeTo: "",
    userInput: task.userInput,
    menuChoice: choice,
    account: session.username,
    accountType: session.type,
    taskKind: task.taskKind,
    taskData: task.taskData,
    nextAgent: "",
    taskContent: "",
    结果: "",
    reviewPass: false,
    reviewReason: "",
    rectificationGuidance: "",
    arrivalDeviation: null,
    arrivalReplanChoice: "",
    arrivalReplanRevision: 0,
    rejectTarget: "",
    retryCount: 0,
    pendingDocument: null,
    pendingUpdates: [],
    ledgerQueryPurpose: "",
    ledgerDocuments: [],
    copInboundDiagnostic: "",
    copAppointmentDiagnostic: "",
    roomInventory: [],
    roomCandidates: [],
    roomPrecheckAttempt: 0,
    roomPrecheckRejectedRooms: [],
    roomPrecheckFailures: [],
    copRecords: [...copRecords],
    reportPayload: null,
    copPlcSnapshot: null,
    copCalculation: null,
    copReportMode: "",
    copScope: "",
    copRoomCode: "",
    copRetryCount: 0,
    executedAgent: "",
    finalAnswer: "",
    error: "",
  };
}

function createPlcPollState(
  copRecords: Array<Record<string, any>>,
  ledgerRecords: Array<Record<string, any>>,
): Partial<ColdStorageState> {
  return {
    flowType: "plc",
    phase: "plc_poll",
    routeTo: "",
    userInput: "",
    menuChoice: "",
    taskKind: "plc_poll",
    taskData: {},
    nextAgent: "",
    taskContent: "",
    结果: "",
    reviewPass: false,
    reviewReason: "",
    rectificationGuidance: "",
    arrivalDeviation: null,
    arrivalReplanChoice: "",
    arrivalReplanRevision: 0,
    rejectTarget: "",
    retryCount: 0,
    pendingDocument: null,
    pendingUpdates: [],
    ledgerQueryPurpose: "",
    ledgerDocuments: [],
    记录: [...ledgerRecords],
    copRecords: [...copRecords],
    reportPayload: null,
    copReportMode: "",
    copScope: "",
    copRoomCode: "",
    copRetryCount: 0,
    executedAgent: "",
    finalAnswer: "",
    error: "",
  };
}

export async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.warn(
      "[main] 未检测到 DEEPSEEK_API_KEY；reviewer 将使用本地合规硬规则兜底。",
    );
  }

  const app = buildGraph();
  const uuid = randomUUID();
  // 用户链路和PLC后台链路使用独立的LangGraph线程，互不阻塞
  const userConfig = {
    configurable: { thread_id: `clod-storage-user-${uuid}` },
    recursionLimit: 60,
  };
  const plcConfig = {
    configurable: { thread_id: `clod-storage-plc-${uuid}` },
    recursionLimit: 30,
  };
  const rl = createInterface({ input, output });
  let latestCopRecords: Array<Record<string, any>> = [];
  let latestLedgerRecords: Array<Record<string, any>> = [];
  let plcTickChain: Promise<void> = Promise.resolve();

  async function runPlcPollTick(): Promise<void> {
    // 定时到点只进入队列，排队期间不打印任何日志。
    // 实际执行日志由 resourceScheduler 和 xiaoke 在拿资源后输出。
    try {
      const result = await app.invoke(
        createPlcPollState(latestCopRecords, latestLedgerRecords),
        plcConfig,
      );
      if (Array.isArray(result.copRecords)) {
        latestCopRecords = result.copRecords;
      }
      const deviceAlert = String(result.finalAnswer ?? "").trim();
      if (deviceAlert) {
        managedConsoleLog(deviceAlert);
      }
    } catch (error) {
      managedConsoleLog(
        `[main] PLC定时采样失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const timer = setInterval(() => {
    // PLC后台任务自身按顺序排队，不与用户链路互相阻塞
    plcTickChain = plcTickChain
      .then(() => runPlcPollTick())
      .catch((error) => {
        managedConsoleLog(
          `[main] PLC后台队列异常：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }, PLC_POLL_INTERVAL_MS);

  console.log(
    `小柯PLC采样间隔：${PLC_POLL_INTERVAL_MS / 1000}s；定时链路为 xiaoke -> PLC（只保存W/COP采样，不生成报告）。`,
  );
  console.log(
    process.env.COLD_STORAGE_DEMO_MODE === "1" ||
      process.env.COLD_STORAGE_DEMO_MODE === "true"
      ? "演示模式：已开启（审核驳回优先整改重提，兜底上限6次）。"
      : "正式模式：审核驳回先整改重提，兜底上限3次。",
  );
  console.log("提示：输入 0 退出；入库台账、PLC采样和COP报告均保存在当前进程的 LangGraph State 中。");

  try {
    let session: AccountSession | null = getAutoLoginAccount();
    if (session) {
      console.log(
        `[账号] 已自动登录：${session.username}（${accountTypeLabel(session.type)}）`,
      );
    } else {
      console.log("[账号] 未找到上次登录账号，请先登录。");
    }

    while (true) {
      if (!session) {
        setInteractiveInputActive(true);
        console.log("\n=== 账号登录 ===");
        console.log(
          "库内账号需预先登记在 accounts.json；其他账号默认按库外账号处理。",
        );
        let username = "";
        while (!username) {
          username = (await rl.question("请输入账号：")).trim();
          if (!username) {
            console.log("账号不能为空，请重新输入。");
          }
        }
        session = loginAccount(username);
        setInteractiveInputActive(false);
        console.log(
          `登录成功：${session.username}（${accountTypeLabel(session.type)}）`,
        );
        continue;
      }

      // 每个任务结束后循环回到这里，自动重新显示有权限的菜单
      // 从菜单到所有字段输入完成，全程禁止后台日志干扰控制台输入
      setInteractiveInputActive(true);
      printMenu(session);
      const choice = (await rl.question("请选择菜单编号：")).trim();
      if (choice === "0") {
        setInteractiveInputActive(false);
        console.log("已退出。本次进程内台账随内存释放。");
        break;
      }
      if (choice === "5") {
        const nextUsername = await askRequired(rl, "请输入要切换的账号");
        session = loginAccount(nextUsername);
        setInteractiveInputActive(false);
        console.log(
          `已切换账号：${session.username}（${accountTypeLabel(session.type)}）`,
        );
        continue;
      }
      if (choice === "6") {
        logoutAccount();
        session = null;
        setInteractiveInputActive(false);
        console.log("已退出登录，请重新登录。");
        continue;
      }
      if (!["1", "2", "3", "4", "8", "9"].includes(choice)) {
        console.log("无效菜单，请输入菜单中存在的编号。\n");
        continue;
      }
      if (!canAccessBusinessMenu(session.type, choice)) {
        console.log(
          "权限不足：库外账号只能提交预约或查看自己的预约单；库内账号可使用到货、COP及警报菜单。\n",
        );
        continue;
      }

      const taskSession = session;
      let task: CollectedTask;
      if (choice === "8" || choice === "9") {
        const confirmation = (
          await askRequired(
            rl,
            choice === "8"
              ? "如已完成排查，请输入“确认解除”解除核算异常警报，其他输入取消"
              : "如已完成排查，请输入“确认解除”解除设备异常标记，其他输入取消",
          )
        ).trim();
        if (confirmation !== "确认解除") {
          console.log("已取消解除操作。\n");
          continue;
        }
        task =
          choice === "8"
            ? {
                taskKind: "clear_cop_alarm",
                taskData: {},
                userInput: "库内人员确认已排查完成，解除核算异常警报。",
              }
            : {
                taskKind: "clear_device_alarm",
                taskData: {},
                userInput: "库内人员确认已排查完成，解除设备异常标记。",
              };
      } else {
        task = await collectTask(rl, choice, taskSession.type);
      }
      // 输入完成，允许后台日志恢复输出
      setInteractiveInputActive(false);
      console.log("\n... 用户交互链路流转中 ...");
      try {
        let result = await app.invoke(
          createUserTurnState(choice, task, latestCopRecords, taskSession),
          userConfig,
        );
        let answer = String(result.finalAnswer ?? "").trim();
        let effectiveChoice = choice;

        // 入库超时：旧预约失效，询问是否重新预约
        if (result.phase === "waiting_timeout_rebook") {
          console.log(`\n${"=".repeat(64)}`);
          console.log(answer || "预约已超时失效。");
          console.log(`${"=".repeat(64)}`);
          setInteractiveInputActive(true);
          let timeoutChoice = "";
          while (!timeoutChoice) {
            const selected = (
              await askRequired(
                rl,
                "是否重新发起新预约？1 是，2 否",
              )
            ).trim();
            if (selected === "1" || selected === "是") {
              timeoutChoice = "yes";
            } else if (selected === "2" || selected === "否") {
              timeoutChoice = "no";
            } else {
              console.log("请输入 1（是）或 2（否）。");
            }
          }
          setInteractiveInputActive(false);
          const timeoutContinuation = await app.invoke(
            {
              flowType: "user",
              phase: "appointment_timeout_choice_provided",
              menuChoice: choice,
              taskKind: "arrival",
              account: taskSession.username,
              accountType: taskSession.type,
              taskData: { ...task.taskData, timeoutChoice },
              userInput:
                timeoutChoice === "yes"
                  ? "超时旧预约作废，重新发起预约"
                  : "超时旧预约作废，不重新预约",
            },
            userConfig,
          );
          if (timeoutChoice === "yes") {
            setInteractiveInputActive(true);
            const rebookTask = await collectTask(
              rl,
              "1",
              taskSession.type,
            );
            task = rebookTask;
            effectiveChoice = "1";
            setInteractiveInputActive(false);
            result = await app.invoke(
              createUserTurnState(
                "1",
                rebookTask,
                latestCopRecords,
                taskSession,
              ),
              userConfig,
            );
            answer = String(result.finalAnswer ?? "").trim();
          } else {
            result = timeoutContinuation;
            answer = String(result.finalAnswer ?? "").trim();
          }
        }

        // 预约提交后先由调度者/小柯筛选库房，用户只能从候选库房中选择
        if (result.phase === "waiting_room_choice") {
          console.log(`\n${"=".repeat(64)}`);
          console.log(answer || "请选择可预约库房。");
          console.log(`${"=".repeat(64)}`);
          const candidates = Array.isArray(result.roomCandidates)
            ? result.roomCandidates
            : [];
          const candidateCodes = new Set(
            candidates.map((room) =>
              String(room?.roomCode ?? "").trim().toUpperCase(),
            ),
          );
          if (candidateCodes.size === 0) {
            console.log("没有可选库房。");
          } else {
            setInteractiveInputActive(true);
            let selectedRoomCode = "";
            while (!selectedRoomCode) {
              const selected = await askRequired(
                rl,
                "请选择可预约库房（输入序号或库房编号，如1或A1）",
              );
              const index = Number(selected);
              const normalized = Number.isInteger(index) &&
                index >= 1 &&
                index <= candidates.length
                ? String(
                    candidates[index - 1]?.roomCode ?? "",
                  ).trim().toUpperCase()
                : normalizeRoomCode(selected);
              if (!normalized || !candidateCodes.has(normalized)) {
                console.log(
                  `无效库房：只能从本次列出的候选库房中选择（${Array.from(
                    candidateCodes,
                  ).join("/")}）。`,
                );
                continue;
              }
              selectedRoomCode = normalized;
            }
            setInteractiveInputActive(false);
            console.log(
              `\n... 已选择库房 ${selectedRoomCode}，继续提交预约审核 ...`,
            );
            result = await app.invoke(
              {
                flowType: "user",
                phase: "room_choice_provided",
                menuChoice: effectiveChoice,
                taskKind: "appointment",
                account: taskSession.username,
                accountType: taskSession.type,
                taskData: {
                  ...task.taskData,
                  roomCode: selectedRoomCode,
                },
                userInput: `已选择可预约库房 ${selectedRoomCode}，继续提交预约审核。`,
              },
              userConfig,
            );
            answer = String(result.finalAnswer ?? "").trim();
          }
        }

        // 到货货温/吨位相对预约条件偏差>5%：库内人员选择增加库房或更换库房
        if (result.phase === "waiting_arrival_replan") {
          console.log(`\n${"=".repeat(64)}`);
          console.log(answer || "到货参数偏差超过5%，需要重新规划贮藏方案。");
          console.log(`${"=".repeat(64)}`);
          setInteractiveInputActive(true);
          let replanChoice = "";
          while (!replanChoice) {
            const selected = (
              await askRequired(
                rl,
                "请选择：1 增加库房，2 更换库房",
              )
            ).trim();
            if (selected === "1" || /^增加库房$/.test(selected)) {
              replanChoice = "add";
            } else if (selected === "2" || /^更换库房$/.test(selected)) {
              replanChoice = "change";
            } else {
              console.log("请输入 1（增加库房）或 2（更换库房）。");
            }
          }
          setInteractiveInputActive(false);
          console.log(
            `\n... 已选择${replanChoice === "add" ? "增加库房" : "更换库房"}，调度员正在重新规划 ...`,
          );
          result = await app.invoke(
            {
              flowType: "user",
              phase: "arrival_replan_choice_provided",
              menuChoice: choice,
              taskKind: "arrival",
              account: taskSession.username,
              accountType: taskSession.type,
              taskData: { ...task.taskData, replanChoice },
              userInput: `到货偏差重规划选择：${
                replanChoice === "add" ? "增加库房" : "更换库房"
              }。`,
            },
            userConfig,
          );
          answer = String(result.finalAnswer ?? "").trim();
        }

        // 小柯先查入库单；只有存在入库单、进入正式核算时，才向管理员索要中心温度
        if (result.phase === "waiting_center_temp") {
          console.log(`\n${"=".repeat(64)}`);
          console.log(answer || "正式COP核算需要果品中心温度。");
          console.log(`${"=".repeat(64)}`);
          setInteractiveInputActive(true);
          console.log(
            "\n小柯正式核算需要果品中心温度。请先测量并录入后再继续：",
          );
          let centerText = await askRequired(rl, "果品中心温度（℃）");
          let centerValue = toNumber(centerText);
          while (
            centerValue === null ||
            centerValue < -5 ||
            centerValue > 45
          ) {
            console.log(
              "温度错误：果品中心温度必须在 -5℃ 到 45℃ 之间，请先测量后重新输入。",
            );
            centerText = await askRequired(rl, "果品中心温度（℃）");
            centerValue = toNumber(centerText);
          }
          setInteractiveInputActive(false);
          console.log("\n... 已录入中心温度，继续正式COP核算 ...");
          result = await app.invoke(
            {
              flowType: "user",
              phase: "center_temp_provided",
              menuChoice: choice,
              taskKind: "cop_report",
              account: taskSession.username,
              accountType: taskSession.type,
              taskData: { ...task.taskData, centerTempC: centerValue },
              userInput: "已测量果品中心温度，继续正式COP核算。",
            },
            userConfig,
          );
          answer = String(result.finalAnswer ?? "").trim();
        }

        if (Array.isArray(result.记录)) {
          latestLedgerRecords = result.记录;
        }
        console.log(`\n${"=".repeat(64)}`);
        console.log(answer || "本轮没有返回最终结果。");
        console.log(`${"=".repeat(64)}`);
        if (taskSession.type === "external") {
          const ownAppointments = (result.记录 ?? []).filter(
            (record) =>
              record?.docType === "appointment" &&
              record?.createdBy === taskSession.username,
          );
          console.log(`我的预约单：${ownAppointments.length} 条\n`);
        } else {
          console.log(
            `当前入库台账：${Array.isArray(result.记录) ? result.记录.length : 0} 条；` +
              `PLC采样：${Array.isArray(result.copRecords) ? result.copRecords.length : 0} 条；` +
              `已保存COP报告：${Array.isArray(result.reportRecords) ? result.reportRecords.length : 0} 条\n`,
          );
        }
      } catch (error) {
        console.error(
          "\n[本轮用户链路失败]",
          error instanceof Error ? error.message : String(error),
        );
        console.log("返回菜单，请检查输入或 API 配置后重试。\n");
      }
    }
  } finally {
    setInteractiveInputActive(false);
    clearInterval(timer);
    rl.close();
  }
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(
      "[致命错误]",
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  });
}
