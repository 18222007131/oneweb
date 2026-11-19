import {
  AGENT_SCHEDULER,
  AGENT_XIAOKE,
  COLD_ROOM_CAPACITY_TONS,
  ColdStorageState,
  TaskKind,
  capacityConflict,
  findAppointmentRecord,
  formatDateTime,
  ledgerText,
  logAgent,
  nowIso,
  parseAppointmentTime,
  recordBrief,
  toNumber,
} from "../state";
import {
  accountTypeLabel,
  canAccessBusinessMenu,
} from "../account-store";
import {
  clearCopAlarm,
  clearDeviceAbnormal,
  createCopAlarm,
  getCopAlarm,
  getDeviceAlarm,
  getRoomInfo,
  hasCopAlarm,
  hasDeviceAbnormal,
  markDeviceAlarmPushed,
  queryRoomInventoryFromXiaoke,
  releaseRoomOccupancy,
} from "../equipment-registry";

function taskKindFromMenu(menuChoice: string): TaskKind {
  switch (menuChoice) {
    case "1":
      return "appointment";
    case "2":
      return "arrival";
    case "3":
      return "ledger";
    case "4":
      return "cop_report";
    default:
      return "";
  }
}

function userTaskLabel(kind: TaskKind): string {
  switch (kind) {
    case "appointment":
      return "入库预约";
    case "arrival":
      return "到货入库";
    case "ledger":
      return "查看历史入库台账";
    case "cop_report":
      return "请求小柯COP核算报告";
    case "cop_estimate":
      return "预约阶段COP预估";
    case "clear_cop_alarm":
      return "解除核算异常警报";
    case "clear_device_alarm":
      return "解除设备异常标记";
    default:
      return "未知任务";
  }
}

function normalizeCopRoomCode(value: unknown): string {
  const code = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]\d{1,3}$/.test(code) ? code : "";
}

function withSource(source: string, text: string): string {
  return `【消息来源：${source}】\n${text}`;
}

function buildRectificationGuidance(state: ColdStorageState): string {
  const reason = String(state.reviewReason ?? "").trim();
  const doc = state.pendingDocument ?? {};
  const data = state.taskData ?? {};
  const guidance: string[] = [];
  if (/吨位|重量|库容/.test(reason)) {
    guidance.push("核对任务数据中的吨位/实际吨位，修正后补齐说明");
  }
  if (/果品|品种|温区|湿度/.test(reason)) {
    guidance.push("按任务果品和果品推荐温湿度补全/修正单据字段");
  }
  if (/时间|预约|日期/.test(reason)) {
    guidance.push("核对预约时间、关联预约单和日期格式");
  }
  if (/货温|温度/.test(reason)) {
    guidance.push("核对到货实测货温或中心温度相关字段");
  }
  if (/状态|表述|说明/.test(reason)) {
    guidance.push("修正状态/表述，并在整改说明中逐条回应驳回原因");
  }
  if (/缺少|缺失|必填|空|无效/.test(reason)) {
    guidance.push("逐项补全驳回原因指出的必填/无效字段");
  }
  if (guidance.length === 0) {
    guidance.push("按驳回原因逐项核对参数或表述并修改，禁止原样重复提交");
  }
  guidance.push(
    `本次不能原样重提；请至少完成第${Number(doc.documentRevision ?? 0) + 1}版修订并写明整改点`,
  );
  guidance.push(
    `任务数据参考：果品 ${data.fruit ?? "-"}，吨位 ${data.tonnage ?? "-"}，库房 ${data.roomCode ?? "-"}`,
  );
  return guidance.join("；");
}

function copScopeInputError(state: ColdStorageState): string {
  const scope = String(state.taskData?.copScope ?? "");
  if (scope !== "single" && scope !== "allocated") {
    return "请选择COP核算类型：1 单库房COP，2 机组分摊等效COP。";
  }
  if (scope === "single" && !normalizeCopRoomCode(state.taskData?.roomCode)) {
    return "未填写有效库房编号，不能启动单库房COP核算。库房编号格式应为区域号+编号，如A区1号为A1、B区2号为B2。";
  }
  return "";
}

/** Master 在派发前做时间和总库容预校验，避免明显无效输入继续流转。 */
function inboundInputError(state: ColdStorageState, kind: TaskKind): string {
  const data = state.taskData ?? {};
  if (kind === "appointment") {
    const tonnage = toNumber(data.tonnage);
    if (
      tonnage === null ||
      tonnage <= 0 ||
      tonnage > COLD_ROOM_CAPACITY_TONS
    ) {
      return `库容错误：最大输入容量为 ${COLD_ROOM_CAPACITY_TONS} 吨，请重新输入。`;
    }

    const scheduledAt = parseAppointmentTime(data.scheduledAt);
    if (!scheduledAt || scheduledAt.getTime() <= Date.now()) {
      return `时间错误：预约时间必须晚于当前本机时间（${formatDateTime(
        new Date(),
      )}），请重新输入。`;
    }

    const storageDays = toNumber(data.storageDays);
    if (storageDays !== null && Number.isFinite(storageDays) && storageDays > 0) {
      const conflict = capacityConflict(
        state.记录,
        scheduledAt,
        storageDays,
        tonnage,
      );
      if (conflict) {
        return `库容错误：${conflict} 当前总库容为 ${COLD_ROOM_CAPACITY_TONS} 吨，请调整吨位或预约时段。`;
      }
    }
    return "";
  }

  if (kind === "arrival") {
    const actualTonnage = toNumber(data.actualTonnage);
    if (
      actualTonnage === null ||
      actualTonnage <= 0 ||
      actualTonnage > COLD_ROOM_CAPACITY_TONS
    ) {
      return `库容错误：最大输入容量为 ${COLD_ROOM_CAPACITY_TONS} 吨，请重新输入。`;
    }
  }
  return "";
}

/** Master：唯一用户入口、消息中转和统一输出。 */
export function masterNode(state: ColdStorageState): Partial<ColdStorageState> {
  const phase = state.phase;
  const kind = state.taskKind || taskKindFromMenu(state.menuChoice);

  if (phase === "appointment_timeout_alert") {
    const appointmentId = String(
      state.taskData?.appointmentId ?? "",
    ).trim();
    const appointment = findAppointmentRecord(
      state.记录,
      appointmentId,
    );
    const scheduledAt = String(appointment?.scheduledAt ?? "-");
    const actualAt = nowIso();
    const text = [
      "【预约入库超时】",
      `预约单：${appointmentId || "-"}`,
      `预约入库时间：${scheduledAt}`,
      `实际入库时间：${actualAt}`,
      "系统判定：实际入库时间晚于预约入库时间，旧预约单已超时失效，禁止直接继续入库。",
      "",
      "是否重新发起新预约？",
      "① 是：完整重跑预约→库房筛选→分配库房→打印结果",
      "② 否：作废超时旧单据，流程结束",
    ].join("\n");
    logAgent(
      "master",
      `预约单 ${appointmentId} 入库超时，等待库内人员选择是否重新预约`,
    );
    return {
      phase: "waiting_timeout_rebook",
      routeTo: "",
      nextAgent: "",
      finalAnswer: withSource("scheduler（经master转发）", text),
      executedAgent: "master",
    };
  }

  if (phase === "appointment_timeout_choice_provided") {
    const rawChoice = String(
      state.taskData?.timeoutChoice ?? "",
    ).toLowerCase();
    const rebook =
      rawChoice === "yes" || rawChoice === "1" || rawChoice === "是";
    const cancel =
      rawChoice === "no" || rawChoice === "2" || rawChoice === "否";
    if (!rebook && !cancel) {
      return {
        routeTo: "",
        nextAgent: "",
        finalAnswer: withSource(
          "master",
          "请选择 ① 重新预约 或 ② 作废结束。",
        ),
        executedAgent: "master",
      };
    }
    const appointmentId = String(
      state.taskData?.appointmentId ?? "",
    ).trim();
    const appointment = findAppointmentRecord(
      state.记录,
      appointmentId,
    );
    if (!appointment) {
      return {
        routeTo: "",
        nextAgent: "",
        finalAnswer: withSource(
          "master",
          `未找到超时预约单 ${appointmentId}，无法作废。`,
        ),
        executedAgent: "master",
      };
    }
    if (appointment.roomCode) {
      releaseRoomOccupancy(String(appointment.roomCode));
    }
    const expiredAt = nowIso();
    const records = (state.记录 ?? []).map((record) =>
      String(record?.docId ?? "").trim() === appointmentId
        ? {
            ...record,
            status: "expired",
            statusName: "已失效",
            expiredAt,
            expiredReason: "实际入库时间超过预约入库时间",
          }
        : record,
    );
    const message = rebook
      ? "超时旧预约单已作废，库房占用已释放。\n请填写新的预约表单，接下来将完整重新执行预约→库房筛选→分配库房流程。"
      : "超时旧预约单已作废，库房占用已释放。本次入库流程结束。";
    logAgent(
      "master",
      rebook
        ? `超时旧预约 ${appointmentId} 已作废，进入重新预约`
        : `超时旧预约 ${appointmentId} 已作废，流程结束`,
    );
    return {
      记录: records,
      phase: "inbound_failed",
      routeTo: "",
      nextAgent: "",
      finalAnswer: withSource("master", message),
      executedAgent: "master",
    };
  }

  if (phase === "arrival_deviation_alert") {
    const detail = state.arrivalDeviation;
    if (!detail) {
      return {
        routeTo: "",
        nextAgent: "",
        finalAnswer: withSource("小柯（经master转发）", "到货偏差详情缺失。"),
        executedAgent: "master",
      };
    }
    const original = detail.original ?? {};
    const actual = detail.actual ?? {};
    const deviations = detail.deviations ?? {};
    const text = [
      "【到货偏差超过5%，需重新规划贮藏方案】",
      `原始预约：预约单 ${original.appointmentId ?? "-"}，果品 ${original.fruit ?? "-"}，吨位 ${original.tonnage ?? "-"}t，库房 ${original.roomCode ?? "-"}（${original.roomName ?? "-"}）`,
      `对比基准温度（q_resp条件温度）：${original.qRespConditionTempC ?? "-"}℃（${original.qRespConditionSource ?? "-"}）`,
      `实际到货：吨位 ${actual.tonnage ?? "-"}t，货温 ${actual.cargoTempC ?? "-"}℃`,
      `吨位偏差：${deviations.tonnagePct ?? "-"}%，阈值 ${detail.thresholdPct ?? 5}%`,
      "说明：本次重规划仅由吨位偏差>5%触发；q_resp条件温度和到货货温仍记录用于追溯，但不作为温度偏差触发条件。",
      "",
      "小柯：该偏差属于贮藏方案需要重新规划，不进入普通单据整改重试。",
      "请库内人员选择：",
      "① 增加库房",
      "② 更换库房",
    ].join("\n");
    logAgent("master", "收到小柯到货偏差上报，等待库内人员选择增加/更换库房");
    return {
      phase: "waiting_arrival_replan",
      routeTo: "",
      nextAgent: "",
      finalAnswer: withSource("小柯（到货偏差，经master转达）", text),
      executedAgent: "master",
    };
  }

  if (phase === "arrival_replan_choice_provided") {
    const rawChoice = String(
      state.taskData?.replanChoice ?? state.arrivalReplanChoice ?? "",
    ).toLowerCase();
    const choice = rawChoice === "add" || rawChoice === "1"
      ? "add"
      : rawChoice === "change" || rawChoice === "2"
        ? "change"
        : "";
    if (!choice) {
      return {
        routeTo: "",
        nextAgent: "",
        finalAnswer: withSource(
          "master",
          "请选择 ① 增加库房 或 ② 更换库房。",
        ),
        executedAgent: "master",
      };
    }
    logAgent(
      "master",
      `库内人员选择${choice === "add" ? "增加库房" : "更换库房"}，转交scheduler重新规划`,
    );
    return {
      phase: "master_arrival_replan_request",
      routeTo: "scheduler",
      nextAgent: AGENT_SCHEDULER,
      arrivalReplanChoice: choice,
      executedAgent: "master",
    };
  }

  if (phase === "scheduler_rectification_request") {
    const guidance = buildRectificationGuidance(state);
    logAgent(
      "master",
      `【来源：scheduler】收到单据驳回整改请求，向上级确认整改指引：${guidance}`,
    );
    return {
      phase: "scheduler_rectification_ready",
      routeTo: "scheduler",
      nextAgent: AGENT_SCHEDULER,
      rectificationGuidance: guidance,
      executedAgent: "master",
    };
  }

  if (phase === "scheduler_room_inventory_request") {
    logAgent(
      "master",
      "【来源：scheduler】收到预约筛选请求，master代向小柯查询全部库房库存、占用和机组状态",
    );
    const roomInventory = queryRoomInventoryFromXiaoke();
    logAgent(
      "master",
      `【来源：小柯】已取得 ${roomInventory.length} 间库房状态，转交scheduler按果品筛选`,
    );
    return {
      phase: "master_room_inventory_ready",
      routeTo: "scheduler",
      nextAgent: AGENT_SCHEDULER,
      roomInventory,
      executedAgent: "master",
    };
  }

  if (phase === "scheduler_room_candidates_result") {
    const candidates = Array.isArray(state.roomCandidates)
      ? state.roomCandidates
      : [];
    if (candidates.length === 0) {
      logAgent(
        "master",
        "【暂时没有满足本次预约条件的合格库房】已上报管理员；不合格库房不会进入reviewer或入库流程",
      );
      return {
        routeTo: "",
        nextAgent: "",
        finalAnswer: withSource(
          "scheduler（经master转发）",
          "【暂时没有满足本次预约条件的合格库房】\n暂无匹配库房，本次预约无法分配贮藏位置。\n已上报管理员；本次单据直接终止，不进入reviewer审核，不推送任何不合格库房。",
        ),
        executedAgent: "master",
      };
    }
    const lines = [
      "可选库房（已排除机组异常、已占用、品类/温区/湿度/容量不适配的库房）：",
      ...candidates.map(
        (room, index) =>
          `${index + 1}. ${room.roomCode}（${room.roomName}） | ${room.unitId} | 温区 ${room.tempText} | 湿度${room.humidity} | 可用库容 ${room.availableCapacityTons ?? room.capacityTons}t\n   匹配说明：${room.matchNote ?? "品类/温区/库容/机组/占用全部匹配"}；可正常入库\n   前置Reviewer核验：${room.precheckNote ?? "前置快速核验通过"}`,
      ),
      "",
      "master：以上均为完成全部前置校验的合格库房，请选择一间；未出现在列表中的库房禁止预约。",
    ];
    logAgent(
      "master",
      `前置reviewer核验已通过，向用户展示 ${candidates.length} 间可预约库房：${candidates
        .map((room) => room.roomCode)
        .join("、")}`,
    );
    return {
      phase: "waiting_room_choice",
      routeTo: "",
      nextAgent: "",
      roomCandidates: candidates,
      finalAnswer: withSource(
        "scheduler（经master转发）",
        lines.join("\n"),
      ),
      executedAgent: "master",
    };
  }

  if (phase === "room_choice_provided") {
    const selectedCode = normalizeCopRoomCode(state.taskData?.roomCode);
    const candidates = Array.isArray(state.roomCandidates)
      ? state.roomCandidates
      : [];
    const selected = candidates.find(
      (room) =>
        String(room?.roomCode ?? "").trim().toUpperCase() === selectedCode,
    );
    const currentRoom = selectedCode ? getRoomInfo(selectedCode) : null;
    if (!selected || !currentRoom || !currentRoom.bookable) {
      return {
        routeTo: "",
        nextAgent: "",
        finalAnswer: withSource(
          "master",
          "所选库房不在本轮候选列表中，或已被占用/机组异常，预约未提交。请重新发起预约。",
        ),
        executedAgent: "master",
      };
    }
    logAgent(
      "master",
      `用户从候选库房中选择 ${selectedCode}（${selected.roomName}），转交scheduler提交预约审核`,
    );
    return {
      phase: "master_room_choice_confirmed",
      routeTo: "scheduler",
      nextAgent: AGENT_SCHEDULER,
      taskData: {
        ...state.taskData,
        roomCode: selectedCode,
        roomName: selected.roomName,
        roomId: selected.roomId,
        unitId: selected.unitId,
      },
      finalAnswer: "",
      executedAgent: "master",
    };
  }

  if (phase === "device_abnormal_alert") {
    const alarm = getDeviceAlarm();
    if (!alarm) {
      return {
        routeTo: "",
        nextAgent: "",
        finalAnswer: "",
        executedAgent: "master",
      };
    }
    const affectedGoods = (state.记录 ?? []).filter(
      (record) => record?.docType === "arrival",
    );
    const goodsLines = affectedGoods.length
      ? affectedGoods.map((record) => `  - ${recordBrief(record)}`)
      : ["  - 当前台账没有可识别的到货货品，请库内人员立即核对库内实物。"];
    const advice = [
      "【设备异常警报】",
      `库房/机组：${alarm.roomId} / ${alarm.unitId}`,
      `判定原因：${alarm.reason}`,
      `连续异常窗口：${alarm.windowStart} ~ ${alarm.windowEnd}（${alarm.sampleCount} 个采样）`,
      "受影响在库货品：",
      ...goodsLines,
      "换库建议：建议尽快将上述货品转移至备用冷库；转移前核对备用库温度、湿度、容量和预约占用情况。",
      "建议换库原因：机组或传感器连续2小时异常，库温存在失控风险，继续原库存放可能造成货品品质下降。",
      "排查建议：1) 校验供温/回温、吸排气压力传感器和PLC采集链路；2) 检查除霜周期、蒸发器和冷凝器状态；3) 检查压缩机和膨胀阀运行参数。",
      "状态影响：该库房已标记【设备异常】，scheduler 已禁止分配新预约；在库货品不会自动转移，需库内人员落实。",
      "解除方式：库内人员完成排查后，请通过菜单9手动解除设备异常标记。",
    ].join("\n");
    markDeviceAlarmPushed();
    logAgent("master", "收到小柯设备异常上报，已向库内人员推送设备警报");
    return {
      routeTo: "",
      nextAgent: "",
      finalAnswer: withSource("小柯", advice),
      executedAgent: "master",
    };
  }

  if (phase === "user_start") {
    const accountType = state.accountType;
    const displayLabel =
      accountType === "external" && kind === "ledger"
        ? "查看我的预约单"
        : userTaskLabel(kind);
    logAgent(
      "master",
      `当前账号：${state.account || "未登录"}${
        accountType ? `（${accountTypeLabel(accountType)}）` : ""
      }`,
    );
    logAgent("master", `收到用户输入：${displayLabel}`);
    logAgent("master", `用户原始输入：${state.userInput}`);

    const externalKindAllowed =
      accountType !== "external" ||
      kind === "appointment" ||
      kind === "ledger";
    if (
      !state.account ||
      !accountType ||
      !externalKindAllowed ||
      !canAccessBusinessMenu(accountType, state.menuChoice)
    ) {
      logAgent(
        "master",
        "权限校验未通过：当前账号无权执行该菜单功能，已拦截。",
      );
      return {
        routeTo: "",
        nextAgent: "",
        finalAnswer: withSource(
          "master",
          "权限不足：库外账号只能提交预约或查看自己的预约单；库内账号可使用到货、COP及警报菜单。",
        ),
        executedAgent: "master",
      };
    }

    if (kind === "clear_cop_alarm") {
      const cleared = clearCopAlarm();
      logAgent(
        "master",
        cleared
          ? "库内人员已确认排查完成，核算异常警报已解除"
          : "当前没有未解除的核算异常警报",
      );
      return {
        routeTo: "",
        nextAgent: "",
        finalAnswer: withSource(
          "master（库内人员确认操作）",
          cleared
            ? "核算异常警报已解除。可以重新发起菜单4请求COP核算。"
            : "当前没有未解除的核算异常警报。",
        ),
        executedAgent: "master",
      };
    }

    if (kind === "clear_device_alarm") {
      const cleared = clearDeviceAbnormal();
      logAgent(
        "master",
        cleared
          ? "库内人员已确认排查完成，设备异常标记已解除，库房重新开放"
          : "当前没有设备异常标记",
      );
      return {
        routeTo: "",
        nextAgent: "",
        finalAnswer: withSource(
          "master（库内人员确认操作）",
          cleared
            ? "设备异常标记已解除，库房重新开放给调度器分配新预约。PLC长期监测将从当前时间重新累计。"
            : "当前没有需要解除的设备异常标记。",
        ),
        executedAgent: "master",
      };
    }

    if (kind === "appointment" || kind === "arrival") {
      const inputError = inboundInputError(state, kind);
      if (inputError) {
        logAgent("master", `入库输入校验未通过：${inputError}`);
        return {
          routeTo: "",
          nextAgent: "",
          finalAnswer: withSource("master", inputError),
          reviewReason: "",
          executedAgent: "master",
        };
      }

      logAgent("master", "派发入库任务给scheduler，当前链路 master -> scheduler -> reviewer");
      return {
        taskKind: kind,
        phase: "master_dispatch_inbound",
        routeTo: "scheduler",
        nextAgent: AGENT_SCHEDULER,
        taskContent:
          kind === "appointment"
            ? "请组装入库预约单并送交reviewer质检。"
            : "请组装到货入库单并送交reviewer质检。",
        reviewPass: false,
        reviewReason: "",
        retryCount: 0,
        pendingDocument: null,
        pendingUpdates: [],
        ledgerDocuments: [],
        reportPayload: null,
        结果: "",
        finalAnswer: "",
        executedAgent: "master",
      };
    }

    if (kind === "ledger") {
      if (accountType === "external") {
        logAgent("master", "库外账号查询自己的预约单，向scheduler调取受限台账");
        return {
          taskKind: kind,
          phase: "master_query_ledger_user",
          routeTo: "scheduler",
          nextAgent: AGENT_SCHEDULER,
          ledgerQueryPurpose: "my_appointments",
          ledgerDocuments: [],
          结果: "",
          finalAnswer: "",
          executedAgent: "master",
        };
      }
      logAgent("master", "收到历史入库台账查询，向scheduler调取台账");
      return {
        taskKind: kind,
        phase: "master_query_ledger_user",
        routeTo: "scheduler",
        nextAgent: AGENT_SCHEDULER,
        ledgerQueryPurpose: "user_ledger",
        ledgerDocuments: [],
        结果: "",
        finalAnswer: "",
        executedAgent: "master",
      };
    }

    if (kind === "cop_report") {
      if (hasCopAlarm()) {
        const alarm = getCopAlarm();
        const message = `存在未解除的【核算异常警报】（${alarm?.alarmId ?? "未知"}）：${
          alarm?.reason ?? "单次COP核算异常"
        }。请库内人员排查并在菜单8手动确认解除后，再重新发起COP核算。`;
        logAgent("master", `COP请求被未解除警报拦截：${message}`);
        return {
          routeTo: "",
          nextAgent: "",
          finalAnswer: withSource("master", message),
          executedAgent: "master",
        };
      }
      const scopeError = copScopeInputError(state);
      if (scopeError) {
        logAgent("master", `COP类型/库房编号校验未通过：${scopeError}`);
        return {
          routeTo: "",
          nextAgent: "",
          finalAnswer: withSource("master", scopeError),
          executedAgent: "master",
        };
      }
      if (hasDeviceAbnormal()) {
        logAgent(
          "master",
          "当前库房处于设备异常状态；COP报告仍可核算，但新预约已经禁止",
        );
      }
      logAgent("master", "收到管理员COP核算请求");
      const selectedScope = String(state.taskData?.copScope) as
        | "single"
        | "allocated";
      const selectedRoomCode =
        selectedScope === "single"
          ? normalizeCopRoomCode(state.taskData?.roomCode)
          : "";
      logAgent(
        "master",
        `已收到COP请求（${
          selectedScope === "single"
            ? `单库房COP，库房${selectedRoomCode}`
            : "机组分摊等效COP"
        }），通知小柯先申请入库单，请稍候……`,
      );
      return {
        taskKind: kind,
        phase: "master_request_cop_inbound",
        routeTo: "xiaoke",
        nextAgent: AGENT_XIAOKE,
        copScope: selectedScope,
        copRoomCode: selectedRoomCode,
        ledgerDocuments: [],
        reportPayload: null,
        copPlcSnapshot: null,
        copCalculation: null,
        copReportMode: "",
        copRetryCount: 0,
        reviewReason: "",
        结果: "",
        finalAnswer: "",
        executedAgent: "master",
      };
    }

    if (kind === "cop_estimate") {
      if (hasCopAlarm()) {
        const alarm = getCopAlarm();
        const message = `存在未解除的【核算异常警报】（${alarm?.alarmId ?? "未知"}）：${
          alarm?.reason ?? "单次COP核算异常"
        }。请库内人员排查并在菜单8手动确认解除后，再重新发起COP预估。`;
        logAgent("master", `预约预估请求被未解除警报拦截：${message}`);
        return {
          routeTo: "",
          nextAgent: "",
          finalAnswer: withSource("master", message),
          executedAgent: "master",
        };
      }
      const scopeError = copScopeInputError(state);
      if (scopeError) {
        logAgent("master", `COP类型/库房编号校验未通过：${scopeError}`);
        return {
          routeTo: "",
          nextAgent: "",
          finalAnswer: withSource("master", scopeError),
          executedAgent: "master",
        };
      }
      const selectedScope = String(state.taskData?.copScope) as
        | "single"
        | "allocated";
      const selectedRoomCode =
        selectedScope === "single"
          ? normalizeCopRoomCode(state.taskData?.roomCode)
          : "";
      logAgent(
        "master",
        `收到预约阶段COP预估请求（${
          selectedScope === "single"
            ? `单库房COP ${selectedRoomCode}`
            : "机组分摊等效COP"
        }），正在查询预约单，请稍候……`,
      );
      return {
        taskKind: kind,
        phase: "master_query_ledger_estimate",
        routeTo: "scheduler",
        nextAgent: AGENT_SCHEDULER,
        ledgerQueryPurpose: "appointment_estimate",
        copScope: selectedScope,
        copRoomCode: selectedRoomCode,
        ledgerDocuments: [],
        reportPayload: null,
        copPlcSnapshot: null,
        copCalculation: null,
        copReportMode: "estimate",
        copRetryCount: 0,
        reviewReason: "",
        结果: "",
        finalAnswer: "",
        executedAgent: "master",
      };
    }
  }

  if (phase === "cop_ledger_request") {
    logAgent("master", "【来源：小柯】收到小柯入库单数据请求");
    logAgent(
      "master",
      "小柯已取得PLC实时参数，master正在代为向scheduler调取入库单据，请稍候……",
    );
    return {
      phase: "master_query_ledger_cop",
      routeTo: "scheduler",
      nextAgent: AGENT_SCHEDULER,
      ledgerQueryPurpose: "cop_report",
      ledgerDocuments: [],
      executedAgent: "master",
    };
  }

  if (phase === "cop_inbound_request") {
    logAgent(
      "master",
      "【来源：小柯】小柯申请获取入库单，master代向scheduler查询到货单",
    );
    return {
      phase: "master_query_cop_inbound",
      routeTo: "scheduler",
      nextAgent: AGENT_SCHEDULER,
      ledgerQueryPurpose: "cop_inbound",
      ledgerDocuments: [],
      finalAnswer: "",
      executedAgent: "master",
    };
  }

  if (phase === "center_temp_provided") {
    const centerTempC = toNumber(state.taskData?.centerTempC);
    if (
      centerTempC === null ||
      centerTempC < -5 ||
      centerTempC > 45
    ) {
      return {
        routeTo: "",
        nextAgent: "",
        finalAnswer: withSource(
          "master",
          "果品中心温度无效，正式COP核算无法继续。",
        ),
        executedAgent: "master",
      };
    }
    logAgent(
      "master",
      "【来源：用户/管理员】已录入果品中心温度，继续正式COP核算",
    );
    return {
      phase: "master_forward_formal_to_xiaoke",
      routeTo: "xiaoke",
      nextAgent: AGENT_XIAOKE,
      executedAgent: "master",
    };
  }

  if (phase === "scheduler_ledger_result") {
    if (state.error) {
      logAgent("master", `台账查询返回失败：${state.error}`);
      const copQuery =
        state.ledgerQueryPurpose === "cop_inbound" ||
        state.ledgerQueryPurpose === "appointment_estimate";
      if (copQuery) {
        const reason = `中转通讯异常：${state.error}`;
        const alarm = createCopAlarm({
          reason,
          mode: state.copReportMode === "formal" ? "formal" : "estimate",
          retryCount: Number(state.copRetryCount ?? 0),
        });
        const alert = [
          "【核算异常警报】",
          `警报编号：${alarm.alarmId}`,
          "类型：COP核算单据调取失败",
          `原因：${reason}`,
          "处理：本次核算终止，未生成COP报告。警报不会自动清除；请库内人员排查完成后在菜单8手动确认解除，之后才能重新发起COP请求。",
          "边界说明：单次COP异常不会把库房标记为设备故障，也不阻塞到货入库和新预约。",
        ].join("\n");
        return {
          routeTo: "",
          nextAgent: "",
          finalAnswer: withSource("scheduler（经master转发）", alert),
          executedAgent: "master",
        };
      }
      return {
        routeTo: "",
        nextAgent: "",
        finalAnswer: withSource(
          "scheduler（经master转发）",
          `台账资源任务失败：${state.error}`,
        ),
        executedAgent: "master",
      };
    }

    const count = state.ledgerDocuments.length;
    const ledgerPurposeLabel =
      state.ledgerQueryPurpose === "cop_report"
        ? "COP报告"
        : state.ledgerQueryPurpose === "cop_inbound"
          ? "COP入库单探测"
          : state.ledgerQueryPurpose === "appointment_estimate"
            ? "预约阶段COP预估"
            : state.ledgerQueryPurpose === "my_appointments"
              ? "我的预约单"
              : "用户查询";
    logAgent(
      "master",
      `收到scheduler返回的台账单据：${count} 条（${ledgerPurposeLabel}）`,
    );

    if (state.ledgerQueryPurpose === "cop_inbound") {
      if (count > 0) {
        logAgent(
          "master",
          "入库单存在，小柯进入正式核算；正式核算需要管理员补充果品中心温度",
        );
        return {
          ledgerDocuments: state.ledgerDocuments,
          copReportMode: "formal",
          phase: "waiting_center_temp",
          routeTo: "",
          nextAgent: "",
          finalAnswer: withSource(
            "小柯（经master转发）",
            `已取得 ${count} 条入库单，本次进入正式COP核算。\n小柯正式核算需要额外的果品中心温度，请先测量后录入。`,
          ),
          executedAgent: "master",
        };
      }
      logAgent(
        "master",
        `没有可用入库单（${state.copInboundDiagnostic || "入库单不存在"}），转去申请预约单进行预约阶段COP预估`,
      );
      return {
        phase: "master_query_appointments_estimate",
        routeTo: "scheduler",
        nextAgent: AGENT_SCHEDULER,
        ledgerQueryPurpose: "appointment_estimate",
        copReportMode: "estimate",
        ledgerDocuments: [],
        finalAnswer: "",
        executedAgent: "master",
      };
    }

    if (state.ledgerQueryPurpose === "appointment_estimate") {
      if (count === 0) {
        const inboundDiagnostic =
          state.copInboundDiagnostic || "入库单不存在";
        const appointmentDiagnostic =
          state.copAppointmentDiagnostic || "预约单不存在";
        const unapproved =
          inboundDiagnostic.includes("未通过质检") ||
          appointmentDiagnostic.includes("未通过质检");
        const reason = unapproved
          ? `单据未通过质检核对：${inboundDiagnostic}；${appointmentDiagnostic}。COP核算终止，未生成报告。`
          : `单据不存在：${inboundDiagnostic}；${appointmentDiagnostic}。COP核算终止，未生成报告。`;
        const alarm = createCopAlarm({
          reason,
          mode: "estimate",
          retryCount: Number(state.copRetryCount ?? 0),
        });
        const alert = [
          "【核算异常警报】",
          `警报编号：${alarm.alarmId}`,
          "类型：COP核算单据调取失败",
          `原因：${reason}`,
          "处理：本次核算终止，未生成COP报告。警报不会自动清除；请库内人员排查完成后在菜单8手动确认解除，之后才能重新发起COP请求。",
          "边界说明：单次COP异常不会把库房标记为设备故障，也不阻塞到货入库和新预约。",
        ].join("\n");
        logAgent("master", `COP单据调取失败：${reason}`);
        return {
          routeTo: "",
          nextAgent: "",
          finalAnswer: withSource("小柯（核算结果）", alert),
          executedAgent: "master",
        };
      }
      logAgent(
        "master",
        "【来源：scheduler】预约单数据已返回，master转交小柯做预约阶段COP预估",
      );
      return {
        phase: "master_forward_estimate_to_xiaoke",
        routeTo: "xiaoke",
        nextAgent: AGENT_XIAOKE,
        copReportMode: "estimate",
        executedAgent: "master",
      };
    }
    if (state.ledgerQueryPurpose === "cop_report") {
      logAgent(
        "master",
        "【来源：scheduler】入库单已返回，master正在转交小柯核算并送质检，请稍候……",
      );
      return {
        phase: "master_forward_to_xiaoke",
        routeTo: "xiaoke",
        nextAgent: AGENT_XIAOKE,
        executedAgent: "master",
      };
    }
    if (state.ledgerQueryPurpose === "my_appointments") {
      logAgent("master", "向库外账号输出其本人的预约单");
      return {
        routeTo: "",
        nextAgent: "",
        finalAnswer: withSource(
          "scheduler（经master转发）",
          ledgerText(state.ledgerDocuments, "我的预约单"),
        ),
        executedAgent: "master",
      };
    }
    logAgent("master", "向用户输出历史入库台账");
    return {
      routeTo: "",
      nextAgent: "",
      finalAnswer: withSource(
        "scheduler（经master转发）",
        ledgerText(state.ledgerDocuments),
      ),
      executedAgent: "master",
    };
  }

  if (phase === "cop_report_result") {
    logAgent("master", "收到xiaoke COP核算报告结果");
    const payload = state.reportPayload;
    if (!payload || payload.skipped) {
      const message = String(
        payload?.message ?? "小柯未生成COP核算报告。",
      );
      if (payload?.alarmRequired) {
        const alarm = createCopAlarm({
          reason: message,
          mode: payload.mode === "estimate" ? "estimate" : "formal",
          retryCount: Number(payload.retryCount ?? state.copRetryCount ?? 0),
        });
        const alert = [
          "【核算异常警报】",
          `警报编号：${alarm.alarmId}`,
          `类型：${
            alarm.mode === "estimate"
              ? "预约阶段COP预估"
              : "入库后正式COP核算"
          }`,
          `原因：${alarm.reason}`,
          `已重试：${alarm.retryCount} 轮`,
          "处理：本次核算终止，未生成COP报告。警报不会自动清除；请库内人员排查完成后在菜单8手动确认解除，之后才能重新发起COP请求。",
          "边界说明：单次COP异常不会把库房标记为设备故障，也不阻塞到货入库和新预约。",
        ].join("\n");
        logAgent("master", "已生成核算异常警报并推送库内人员");
        return {
          routeTo: "",
          nextAgent: "",
          finalAnswer: withSource("小柯（核算结果）", alert),
          executedAgent: "master",
        };
      }
      logAgent("master", message);
      return {
        routeTo: "",
        nextAgent: "",
        finalAnswer: withSource("小柯", message),
        executedAgent: "master",
      };
    }
    logAgent("master", "COP核算报告已通过质检，正在输出给用户");

    const batch = {
      reportId: `COP-${Date.now()}`,
      docType: "cop_report",
      reportMode:
        payload.mode === "estimate" ? "estimate" : "formal",
      reportLabel:
        payload.mode === "estimate"
          ? "【预约预估值】"
          : "【正式核算值】",
      copScope:
        payload.copScope === "allocated" ? "allocated" : "single",
      scopeLabel:
        payload.copScope === "allocated"
          ? "【机组分摊等效COP】"
          : "【单库房COP】",
      roomCode: String(payload.roomCode ?? ""),
      rooms: payload.rooms ?? [],
      q1W: payload.q1W ?? null,
      q2W: payload.q2W ?? null,
      wPowerW: payload.wPowerW ?? payload.plcSnapshot?.powerW ?? null,
      thermalSource: String(payload.thermalSource ?? ""),
      thermalDetails: payload.thermalDetails ?? [],
      cop: payload.cop ?? payload.totals?.cop ?? null,
      generatedAt: String(payload.generatedAt ?? nowIso()),
      sourceDocIds: payload.sourceDocIds ?? [],
      plcSnapshot: payload.plcSnapshot ?? null,
      lots: payload.lots ?? [],
      totals: payload.totals ?? {},
      displayText: String(payload.displayText ?? ""),
      createdBy: state.account || "未知账号",
      createdAt: nowIso(),
    };
    const reportRecords = [...(state.reportRecords ?? []), batch];
    const displayText = String(payload.displayText ?? "").trim();
    logAgent("master", `已保存COP报告 ${batch.reportId}，准备向用户展示`);
    return {
      结果: displayText,
      reportRecords,
      latestReportText: displayText,
      routeTo: "",
      nextAgent: "",
      finalAnswer: withSource(
        "小柯（核算结果，经master转发）",
        `${displayText}\n\nCOP核算报告已保存到会话State（报告 ${batch.reportId}）。`,
      ),
      executedAgent: "master",
    };
  }

  if (phase === "inbound_done" || phase === "inbound_failed") {
    logAgent("master", "收到scheduler返回的入库处理结果");
    const answer =
      String(state.结果 ?? "").trim() ||
      (phase === "inbound_done"
        ? "入库单据已通过审核并写入台账。"
        : "入库单据审核未通过，流程终止。");
    logAgent("master", "向用户输出入库流程结果");
    const resourceHint = state.error ? `\n资源/超时提示：${state.error}` : "";
    return {
      routeTo: "",
      nextAgent: "",
      finalAnswer: withSource(
        "scheduler（经master转发）",
        `${answer}${resourceHint}\n\n入库阶段已完成单据处理；小柯的异步定时任务会独立采集PLC数据。`,
      ),
      executedAgent: "master",
    };
  }

  logAgent("master", `无法处理当前阶段：${phase || "空"}`);
  return {
    routeTo: "",
    nextAgent: "",
    finalAnswer: withSource("master", "当前流程状态异常，请重新选择菜单。"),
    executedAgent: "master",
  };
}
