import {
  ColdStorageState,
  DEMO_MODE,
  FRUIT_SPECS,
  MAX_RETRIES,
  applyPendingChanges,
  findAppointmentRecord,
  formatDateTime,
  logAgent,
  nextDocId,
  normalizeFruit,
  nowIso,
  parseAppointmentTime,
  recordBrief,
  toNumber,
} from "../state";
import { resourceScheduler } from "../resource-scheduler";
function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

import {
  DEFAULT_ROOM_CODE,
  DEFAULT_ROOM_ID,
  DEFAULT_UNIT_ID,
  getRoomInfo,
  markRoomOccupied,
  queryRoomInventoryFromXiaoke,
  releaseRoomOccupancy,
} from "../equipment-registry";

function buildAppointmentDocument(state: ColdStorageState): {
  doc: Record<string, any>;
  updates: Array<Record<string, any>>;
} {
  const data = state.taskData ?? {};
  const fruit = normalizeFruit(data.fruit) ?? String(data.fruit ?? "").trim();
  const spec = FRUIT_SPECS[fruit];
  const docId = nextDocId("YY", state.记录);
  const selectedRoomCode = String(data.roomCode ?? "")
    .trim()
    .toUpperCase();
  const room = getRoomInfo(selectedRoomCode);

  return {
    doc: {
      docId,
      docType: "appointment",
      docTypeName: "入库预约单",
      status: "booked",
      statusName: "已预约",
      fruit,
      tonnage: toNumber(data.tonnage),
      scheduledAt: formatDateTime(data.scheduledAt),
      storageDays: toNumber(data.storageDays),
      tempZone: spec?.tempText ?? "",
      humidity: spec?.humidity ?? "",
      temperatureRequirement: spec?.tempText ?? "",
      humidityRequirement: spec?.humidity ?? "",
      tempMinC: spec?.tempMin ?? null,
      tempMaxC: spec?.tempMax ?? null,
      fruitSpec: spec
        ? {
            fruit,
            tempMinC: spec.tempMin,
            tempMaxC: spec.tempMax,
            tempText: spec.tempText,
            humidity: spec.humidity,
          }
        : null,
      roomCode: selectedRoomCode,
      roomId: room?.roomName ?? "",
      roomName: room?.roomName ?? "",
      unitId: room?.unitId ?? "",
      createdBy: state.account || "未知账号",
      createdAt: nowIso(),
      source: "scheduler",
    },
    updates: [],
  };
}

function buildArrivalDocument(state: ColdStorageState): {
  doc: Record<string, any>;
  updates: Array<Record<string, any>>;
} {
  const data = state.taskData ?? {};
  const appointmentId = String(data.appointmentId ?? "").trim().toUpperCase();
  const appointment = findAppointmentRecord(state.记录, appointmentId);
  const fruit =
    normalizeFruit(appointment?.fruit) ??
    normalizeFruit(data.fruit) ??
    String(appointment?.fruit ?? data.fruit ?? "").trim();
  const spec = FRUIT_SPECS[fruit];
  const docId = nextDocId("RK", state.记录);

  const doc = {
    docId,
    docType: "arrival",
    docTypeName: "到货入库单",
    status: "received",
    statusName: "已入库",
    appointmentId,
    fruit,
    actualTonnage: toNumber(data.actualTonnage),
    cargoTempC: toNumber(data.cargoTempC),
    tempZone: spec?.tempText ?? appointment?.tempZone ?? "",
    humidity: spec?.humidity ?? appointment?.humidity ?? "",
    temperatureRequirement:
      spec?.tempText ??
      appointment?.temperatureRequirement ??
      appointment?.tempZone ??
      "",
    humidityRequirement:
      spec?.humidity ??
      appointment?.humidityRequirement ??
      appointment?.humidity ??
      "",
    tempMinC: spec?.tempMin ?? appointment?.tempMinC ?? null,
    tempMaxC: spec?.tempMax ?? appointment?.tempMaxC ?? null,
    fruitSpec: spec
      ? {
          fruit,
          tempMinC: spec.tempMin,
          tempMaxC: spec.tempMax,
          tempText: spec.tempText,
          humidity: spec.humidity,
        }
      : appointment?.fruitSpec ?? null,
    scheduledAt: appointment?.scheduledAt ?? "",
    actualInboundAt: nowIso(),
    storageDays: toNumber(appointment?.storageDays),
    roomId: appointment?.roomId ?? appointment?.roomName ?? DEFAULT_ROOM_ID,
    roomCode:
      appointment?.roomCode ??
      state.taskData?.roomCode ??
      DEFAULT_ROOM_CODE,
    roomName: appointment?.roomName ?? "",
    unitId: appointment?.unitId ?? DEFAULT_UNIT_ID,
    createdBy: state.account || "未知账号",
    createdAt: nowIso(),
    source: "scheduler",
  };

  const updates: Array<Record<string, any>> = [];
  if (appointmentId) {
    updates.push({
      docId: appointmentId,
      patch: {
        status: "received",
        statusName: "已入库",
        actualTonnage: doc.actualTonnage,
        cargoTempC: doc.cargoTempC,
        receivedAt: nowIso(),
      },
    });
  }

  return { doc, updates };
}

function assembleInboundDocument(state: ColdStorageState): {
  doc: Record<string, any>;
  updates: Array<Record<string, any>>;
} {
  if (state.taskKind === "arrival") {
    return buildArrivalDocument(state);
  }
  return buildAppointmentDocument(state);
}

async function handleInboundTask(
  state: ColdStorageState,
): Promise<Partial<ColdStorageState>> {
  logAgent("scheduler", "收到master下发的入库任务");
  logAgent("scheduler", `组装单据类型：${state.taskKind}`);

  if (state.taskKind === "arrival") {
    const appointmentId = String(
      state.taskData?.appointmentId ?? "",
    ).trim();
    const appointment = findAppointmentRecord(
      state.记录,
      appointmentId,
    );
    const scheduledAt = parseAppointmentTime(appointment?.scheduledAt);
    const actualInboundAt = nowIso();
    if (scheduledAt && Date.now() > scheduledAt.getTime()) {
      logAgent(
        "scheduler",
        `入库超时：实际入库时间 ${actualInboundAt} > 预约入库时间 ${formatDateTime(
          scheduledAt,
        )}；旧预约单 ${appointmentId} 禁止继续入库`,
      );
      return {
        phase: "appointment_timeout_alert",
        routeTo: "master",
        nextAgent: "",
        pendingDocument: null,
        pendingUpdates: [],
        结果: `预约入库时间 ${formatDateTime(
          scheduledAt,
        )} 已早于实际入库时间 ${actualInboundAt}，旧预约单超时失效，禁止直接入库。`,
        error: "入库超时",
        executedAgent: "scheduler",
      };
    }
  }

  if (state.taskKind === "appointment") {
    const selectedRoomCode = String(state.taskData?.roomCode ?? "")
      .trim()
      .toUpperCase();
    const room = getRoomInfo(selectedRoomCode);
    if (!room || !room.bookable) {
      logAgent(
        "scheduler",
        `预约库房校验未通过：${selectedRoomCode || "(空)"}（必须是候选且未占用、机组正常）`,
      );
      return {
        phase: "inbound_failed",
        routeTo: "master",
        nextAgent: "",
        pendingDocument: null,
        pendingUpdates: [],
        结果:
          "预约库房校验未通过：必须从候选库房中选择未占用且机组正常的库房。",
        error: "预约库房无效",
        executedAgent: "scheduler",
      };
    }
  }

  const outcome = await resourceScheduler.run(
    {
      resource: "ledger",
      priority: "user",
      label: `scheduler-assemble-${state.taskKind || "unknown"}`,
    },
    (signal) => {
      signal.throwIfAborted();
      return assembleInboundDocument(state);
    },
  );

  if (!outcome.ok) {
    logAgent("scheduler", `台账资源任务失败：${outcome.failureMessage}`);
    return {
      phase: "inbound_failed",
      routeTo: "master",
      nextAgent: "",
      pendingDocument: null,
      pendingUpdates: [],
      结果: `入库任务失败：${outcome.failureMessage}`,
      error: outcome.failureMessage,
      executedAgent: "scheduler",
    };
  }

  const { doc, updates } = outcome.value;
  const arrivalNeedsDeviationCheck = state.taskKind === "arrival";
  logAgent(
    "scheduler",
    arrivalNeedsDeviationCheck
      ? `组装到货单 ${String(doc.docId)} 完成，先交小柯核查货温/吨位相对预约条件的偏差`
      : `组装单据 ${String(doc.docId)} 完成，发送reviewer审核（第1次）`,
  );

  return {
    pendingDocument: doc,
    pendingUpdates: updates,
    retryCount: 0,
    reviewPass: false,
    phase: arrivalNeedsDeviationCheck
      ? "scheduler_arrival_deviation_check"
      : "inbound_awaiting_review",
    routeTo: arrivalNeedsDeviationCheck ? "xiaoke" : "reviewer",
    nextAgent: "",
    rejectTarget: "",
    结果: "",
    finalAnswer: "",
    executedAgent: "scheduler",
  };
}

async function handleReviewResult(
  state: ColdStorageState,
): Promise<Partial<ColdStorageState>> {
  const passed = Boolean(state.reviewPass);
  const reviewReason = String(state.reviewReason ?? "").trim();
  const maxAttempts = DEMO_MODE ? 6 : MAX_RETRIES;
  logAgent(
    "scheduler",
    `收到reviewer审核结果：${passed ? "通过" : "不通过"}${
      !passed && reviewReason ? `，原因：${reviewReason}` : ""
    }`,
  );

  if (passed) {
    const pending = state.pendingDocument;
    if (pending) {
      pending.reviewPassed = true;
      pending.reviewedAt = nowIso();
      pending.reviewedBy = "reviewer";
    }
    const outcome = await resourceScheduler.run(
      {
        resource: "ledger",
        priority: "user",
        label: "scheduler-commit-ledger",
      },
      (signal) => {
        signal.throwIfAborted();
        return applyPendingChanges(
          state.记录,
          pending,
          state.pendingUpdates,
        );
      },
    );

    if (!outcome.ok) {
      logAgent("scheduler", `台账写入失败：${outcome.failureMessage}`);
      return {
        phase: "inbound_failed",
        routeTo: "master",
        nextAgent: "",
        pendingDocument: null,
        pendingUpdates: [],
        结果: `入库台账写入失败：${outcome.failureMessage}`,
        error: outcome.failureMessage,
        executedAgent: "scheduler",
      };
    }

    const { records } = outcome.value;
    if (pending?.docType === "appointment" && pending.roomCode) {
      markRoomOccupied(String(pending.roomCode));
      logAgent(
        "scheduler",
        `预约通过审核，库房 ${pending.roomCode}（${pending.roomName || pending.roomId || "-"}）标记为占用`,
      );
    }
    if (pending?.docType === "arrival") {
      if (
        pending.replanChoice === "change" &&
        pending.originalRoomCode &&
        String(pending.originalRoomCode) !== String(pending.roomCode)
      ) {
        releaseRoomOccupancy(String(pending.originalRoomCode));
        logAgent(
          "scheduler",
          `更换库房方案：原库房 ${pending.originalRoomCode} 释放占用`,
        );
      }
      const allocations = Array.isArray(pending.roomAllocations)
        ? pending.roomAllocations
        : pending.roomCode
          ? [{ roomCode: pending.roomCode }]
          : [];
      for (const allocation of allocations) {
        if (allocation?.roomCode) {
          markRoomOccupied(String(allocation.roomCode));
        }
      }
      logAgent(
        "scheduler",
        `到货通过审核，占用库房：${
          allocations
            .map(
              (room) =>
                `${room.roomCode}${room.role ? `(${room.role})` : ""}`,
            )
            .join("、") || pending.roomCode || "-"
        }`,
      );
    }
    logAgent(
      "scheduler",
      "审核通过：仅将入库单据写入台账，不进入小柯COP核算报告链路",
    );
    logAgent("scheduler", `台账现有入库单据 ${records.length} 条`);

    const result = [
      "入库单据已通过质检并写入台账。",
      `单据：${pending ? recordBrief(pending) : "未知单据"}`,
      `本次审核重试次数：${state.retryCount}/${DEMO_MODE ? 6 : MAX_RETRIES}`,
    ].join("\n");

    return {
      记录: records,
      pendingDocument: null,
      pendingUpdates: [],
      reviewPass: true,
      phase: "inbound_done",
      routeTo: "master",
      nextAgent: "",
      结果: result,
      error: "",
      executedAgent: "scheduler",
    };
  }

  if (state.retryCount < maxAttempts) {
    const retryCount = state.retryCount + 1;
    logAgent(
      "scheduler",
      `审核不通过，原因：${reviewReason || "reviewer未提供具体原因"}；` +
        `先读取驳回原因并向master确认整改指引，针对性修改后重提（第${retryCount}/${maxAttempts}次整改，禁止原样提交）`,
    );
    return {
      retryCount,
      reviewPass: false,
      phase: "scheduler_rectification_request",
      routeTo: "master",
      nextAgent: "",
      rectificationGuidance: "",
      rejectTarget: "",
      结果: "单据被驳回，scheduler 正在向 master 确认整改参数/表述后修改重提。",
      executedAgent: "scheduler",
    };
  }

  logAgent(
    "scheduler",
    `整改后审核仍未通过，达到${DEMO_MODE ? "演示模式" : "正式模式"}兜底上限 ${maxAttempts} 次，终止任务；最后原因：${
      reviewReason || "reviewer未提供具体原因"
    }`,
  );
  return {
    pendingDocument: null,
    pendingUpdates: [],
    reviewPass: false,
    reviewReason,
    retryCount: state.retryCount,
    phase: "inbound_failed",
    routeTo: "master",
    nextAgent: "",
    rejectTarget: "",
    结果: `入库单据整改后审核仍未通过，达到兜底上限 ${maxAttempts} 次，任务终止，未写入台账。\n最后一次审核不通过原因：${
      reviewReason || "reviewer未提供具体原因"
    }`,
    executedAgent: "scheduler",
  };
}

function rectifyPendingDocument(
  state: ColdStorageState,
): Partial<ColdStorageState> {
  const pending = state.pendingDocument;
  if (!pending) {
    return {
      phase: "inbound_failed",
      routeTo: "master",
      nextAgent: "",
      结果: "整改时未找到待修改单据，任务终止。",
      error: "待修改单据为空",
      executedAgent: "scheduler",
    };
  }
  const data = state.taskData ?? {};
  const reason = String(state.reviewReason ?? "").trim();
  const guidance = String(state.rectificationGuidance ?? "").trim();
  const doc: Record<string, any> = { ...pending };
  const revision = Number(doc.documentRevision ?? 0) + 1;
  const notes: string[] = Array.isArray(doc.rectificationNotes)
    ? [...doc.rectificationNotes]
    : [];
  const beforeFingerprint = JSON.stringify(pending);
  const addressed: string[] = [];

  if (doc.docType === "appointment") {
    const fruit =
      normalizeFruit(doc.fruit) ??
      normalizeFruit(data.fruit) ??
      String(doc.fruit ?? data.fruit ?? "").trim();
    if (fruit) {
      doc.fruit = fruit;
      const spec = FRUIT_SPECS[fruit];
      if (spec) {
        doc.tempZone = spec.tempText;
        doc.humidity = spec.humidity;
        addressed.push(`果品温区/湿度按${fruit}推荐值补全`);
      }
    }
    const tonnage = toNumber(doc.tonnage) ?? toNumber(data.tonnage);
    if (tonnage !== null && tonnage > 0) {
      doc.tonnage = tonnage;
      addressed.push("吨位按任务数据核对");
    }
    const storageDays =
      toNumber(doc.storageDays) ?? toNumber(data.storageDays);
    if (storageDays !== null && storageDays > 0) {
      doc.storageDays = storageDays;
    }
    if (!doc.scheduledAt && data.scheduledAt) {
      doc.scheduledAt = formatDateTime(data.scheduledAt);
      addressed.push("预约时间按任务数据补全");
    }
    if (!doc.roomCode && data.roomCode) {
      const room = getRoomInfo(String(data.roomCode));
      doc.roomCode = String(data.roomCode).trim().toUpperCase();
      doc.roomName = room?.roomName ?? "";
      doc.roomId = room?.roomName ?? "";
      doc.unitId = room?.unitId ?? "";
      addressed.push("候选库房信息补全");
    }
  } else if (doc.docType === "arrival") {
    const appointmentId = String(
      doc.appointmentId ?? data.appointmentId ?? "",
    )
      .trim()
      .toUpperCase();
    if (appointmentId) {
      doc.appointmentId = appointmentId;
      const appointment = findAppointmentRecord(
        state.记录,
        appointmentId,
      );
      if (appointment) {
        if (!doc.fruit) doc.fruit = appointment.fruit;
        if (!doc.roomCode) {
          doc.roomCode = appointment.roomCode;
          doc.roomName = appointment.roomName;
          doc.roomId = appointment.roomId;
          doc.unitId = appointment.unitId;
        }
      }
      addressed.push("关联预约单核对");
    }
    const actualTonnage =
      toNumber(doc.actualTonnage) ?? toNumber(data.actualTonnage);
    if (actualTonnage !== null && actualTonnage > 0) {
      doc.actualTonnage = actualTonnage;
      addressed.push("实际吨位按任务数据核对");
    }
    const cargoTempC =
      toNumber(doc.cargoTempC) ?? toNumber(data.cargoTempC);
    if (cargoTempC !== null) {
      doc.cargoTempC = cargoTempC;
      addressed.push("到货货温按任务数据核对");
    }
    const fruit = normalizeFruit(doc.fruit) ?? normalizeFruit(data.fruit);
    if (fruit && FRUIT_SPECS[fruit]) {
      doc.fruit = fruit;
      doc.tempZone = FRUIT_SPECS[fruit].tempText;
      doc.humidity = FRUIT_SPECS[fruit].humidity;
      addressed.push("果品温区/湿度按推荐值补全");
    }
  }

  const note =
    `第${revision}版整改：驳回原因「${reason || "未提供"}」；` +
    `master指引「${guidance || "按驳回原因逐项修正"}」；` +
    `已处理：${addressed.length ? addressed.join("、") : "调整单据表述与审核说明"}。`;
  notes.push(note);
  doc.rectificationNotes = notes;
  doc.rectificationCount = Number(doc.rectificationCount ?? 0) + 1;
  doc.documentRevision = revision;
  doc.rectifiedAt = nowIso();
  doc.lastReviewReason = reason;
  doc.reviewReasonAddressed = note;
  doc.updatedAt = nowIso();
  if (JSON.stringify(doc) === beforeFingerprint) {
    doc.rectificationNotes = [
      ...notes,
      `补充说明：针对驳回原因再次核对表述 ${nowIso()}`,
    ];
  }
  logAgent(
    "scheduler",
    `完成第${revision}版针对性整改：${note}；重新送reviewer（不原样提交）`,
  );
  return {
    pendingDocument: doc,
    rectificationGuidance: "",
    reviewPass: false,
    reviewReason: "",
    phase: "inbound_awaiting_review",
    routeTo: "reviewer",
    nextAgent: "",
    rejectTarget: "",
    结果: `单据已按驳回原因完成第${revision}版整改，重新送审。`,
    executedAgent: "scheduler",
  };
}

async function handleLedgerQuery(
  state: ColdStorageState,
): Promise<Partial<ColdStorageState>> {
  logAgent(
    "scheduler",
    `收到master转达的台账查询请求（用途：${
      state.ledgerQueryPurpose || "未知"
    }）`,
  );
  const purpose = state.ledgerQueryPurpose;
  const allRecords = state.记录 ?? [];
  const allArrivals = allRecords.filter(
    (record) => record?.docType === "arrival",
  );
  const allAppointments = allRecords.filter(
    (record) => record?.docType === "appointment",
  );
  const approvedArrivals = allArrivals.filter(
    (record) => record?.reviewPassed === true,
  );
  const approvedAppointments = allAppointments.filter(
    (record) => record?.reviewPassed === true,
  );
  const copInboundDiagnostic =
    approvedArrivals.length > 0
      ? ""
      : allArrivals.length > 0
        ? "入库单存在但未通过质检核对"
        : "入库单不存在";
  const copAppointmentDiagnostic =
    approvedAppointments.length > 0
      ? ""
      : allAppointments.length > 0
        ? "预约单存在但未通过质检核对"
        : "预约单不存在";
  const outcome = await resourceScheduler.run(
    {
      resource: "ledger",
      priority: "user",
      label: `scheduler-ledger-query-${purpose || "unknown"}`,
    },
    (signal) => {
      signal.throwIfAborted();
      if (purpose === "cop_report") {
        return approvedArrivals;
      }
      if (purpose === "my_appointments") {
        return allAppointments.filter(
          (record) => record?.createdBy === state.account,
        );
      }
      if (purpose === "cop_inbound") {
        return approvedArrivals;
      }
      if (purpose === "appointment_estimate") {
        // 预估需要全部已通过质检的预约单用于动态计算 Q总/分摊。
        return approvedAppointments;
      }
      return allRecords;
    },
  );

  if (!outcome.ok) {
    logAgent("scheduler", `台账查询失败：${outcome.failureMessage}`);
    return {
      ledgerDocuments: [],
      phase: "scheduler_ledger_result",
      routeTo: "master",
      nextAgent: "",
      结果: "",
      error: outcome.failureMessage,
      executedAgent: "scheduler",
    };
  }

  const records = outcome.value;
  const purposeLabel =
    purpose === "cop_report"
      ? "小柯COP核算报告"
      : purpose === "cop_inbound"
        ? "小柯探测入库单"
        : purpose === "appointment_estimate"
          ? "预约阶段COP预估"
          : purpose === "my_appointments"
            ? "库外账号查询自己的预约单"
            : "用户查看";
  logAgent(
    "scheduler",
    `调取台账单据：${records.length} 条（用途：${purposeLabel}）` +
      (purpose === "cop_inbound" && records.length === 0
        ? `；诊断：${copInboundDiagnostic}`
        : purpose === "appointment_estimate" && records.length === 0
          ? `；诊断：${copAppointmentDiagnostic}`
          : ""),
  );
  logAgent("scheduler", "将台账单据返回master");
  return {
    ledgerDocuments: records,
    copInboundDiagnostic,
    copAppointmentDiagnostic,
    phase: "scheduler_ledger_result",
    routeTo: "master",
    nextAgent: "",
    error: "",
    executedAgent: "scheduler",
  };
}

function handleArrivalReplan(
  state: ColdStorageState,
): Partial<ColdStorageState> {
  const pending = state.pendingDocument;
  const deviation = state.arrivalDeviation ?? {};
  const choice = state.arrivalReplanChoice;
  if (
    !pending ||
    pending.docType !== "arrival" ||
    (choice !== "add" && choice !== "change")
  ) {
    return {
      phase: "inbound_failed",
      routeTo: "master",
      nextAgent: "",
      结果: "到货偏差重规划缺少原单据或库内人员选择，终止本次入库。",
      error: "重规划参数不完整",
      executedAgent: "scheduler",
    };
  }
  const data = state.taskData ?? {};
  const appointmentId = String(pending.appointmentId ?? "").trim();
  const appointment = findAppointmentRecord(state.记录, appointmentId);
  const fruit = normalizeFruit(
    pending.fruit ?? appointment?.fruit ?? data.fruit,
  ) ?? String(pending.fruit ?? appointment?.fruit ?? data.fruit ?? "").trim();
  const spec = FRUIT_SPECS[fruit];
  const actualTonnage =
    toNumber(pending.actualTonnage) ?? toNumber(data.actualTonnage);
  const originalRoomCode = String(
    pending.roomCode ?? appointment?.roomCode ?? "",
  )
    .trim()
    .toUpperCase();
  if (!spec || actualTonnage === null || actualTonnage <= 0) {
    return {
      phase: "inbound_failed",
      routeTo: "master",
      nextAgent: "",
      结果: "到货偏差重规划缺少果品或实际吨位，终止本次入库。",
      error: "重规划参数不完整",
      executedAgent: "scheduler",
    };
  }
  const inventory = queryRoomInventoryFromXiaoke();
  const suitable = inventory.filter((room) => {
    if (!room.bookable) return false;
    if (room.roomCode === originalRoomCode) return false;
    if (room.unitStatus !== "normal") return false;
    if (room.occupancy !== "available") return false;
    if (
      !Array.isArray(room.suitableFruits) ||
      !room.suitableFruits.includes(fruit)
    ) {
      return false;
    }
    if (room.tempMin > spec.tempMin || room.tempMax < spec.tempMax) {
      return false;
    }
    return room.capacityTons >= actualTonnage;
  });
  if (suitable.length === 0) {
    logAgent(
      "scheduler",
      `到货重规划失败：果品${fruit}、实际${actualTonnage}t，没有可用且温区/容量匹配的其他库房`,
    );
    return {
      phase: "inbound_failed",
      routeTo: "master",
      nextAgent: "",
      结果:
        "到货参数偏差需要重新规划，但当前没有满足果品温区、容量、机组正常且未占用的其他库房，本次入库终止。",
      error: "无可用重规划库房",
      executedAgent: "scheduler",
    };
  }
  const revision = Number(state.arrivalReplanRevision ?? 0) + 1;
  const selectedRooms = suitable.slice(0, choice === "add" ? 1 : 1);
  const primaryRoom =
    choice === "change"
      ? selectedRooms[0]
      : getRoomInfo(originalRoomCode) ?? selectedRooms[0];
  if (!primaryRoom) {
    return {
      phase: "inbound_failed",
      routeTo: "master",
      nextAgent: "",
      结果: "到货重规划找不到基础库房，终止本次入库。",
      error: "无可用重规划库房",
      executedAgent: "scheduler",
    };
  }
  const originalRoom = originalRoomCode
    ? getRoomInfo(originalRoomCode)
    : null;
  const originalTonnage = Math.max(
    toNumber(appointment?.tonnage) ?? 0,
    0.1,
  );
  const addedTonnage = Math.max(actualTonnage - originalTonnage, 0);
  const allocations =
    choice === "add"
      ? [
          {
            roomCode: primaryRoom.roomCode,
            roomName: primaryRoom.roomName,
            unitId: primaryRoom.unitId,
            allocatedTonnage: round(originalTonnage, 2),
            role: "原预约库房",
          },
          ...selectedRooms.map((room) => ({
            roomCode: room.roomCode,
            roomName: room.roomName,
            unitId: room.unitId,
            allocatedTonnage: round(
              addedTonnage > 0 ? addedTonnage : actualTonnage / 2,
              2,
            ),
            role: "新增库房",
          })),
        ]
      : [
          {
            roomCode: primaryRoom.roomCode,
            roomName: primaryRoom.roomName,
            unitId: primaryRoom.unitId,
            allocatedTonnage: round(actualTonnage, 2),
            role: "更换后库房",
          },
        ];
  const newDocId = `${String(pending.docId)}-R${revision}`;
  const replanNotes = [
    `原始预约：${deviation.original?.appointmentId ?? appointmentId}，果品${deviation.original?.fruit ?? fruit}，吨位${deviation.original?.tonnage ?? originalTonnage}t，库房${originalRoomCode}，q_resp条件温度${deviation.original?.qRespConditionTempC ?? "-"}℃（${deviation.original?.qRespConditionSource ?? "-"}）`,
    `实际到货：吨位${deviation.actual?.tonnage ?? actualTonnage}t，货温${deviation.actual?.cargoTempC ?? pending.cargoTempC}℃`,
    `偏差：吨位${deviation.deviations?.tonnagePct ?? "-"}%，阈值${deviation.thresholdPct ?? 5}%（温度不参与触发）`,
    `库内人员选择：${choice === "add" ? "增加库房" : "更换库房"}`,
    `新方案：${allocations.map((room) => `${room.roomCode}(${room.roomName}) ${room.role} ${room.allocatedTonnage}t`).join("；")}`,
    `新入库单：${newDocId}`,
  ];
  const doc: Record<string, any> = {
    ...pending,
    docId: newDocId,
    status: "replanned",
    statusName: "重规划待审核",
    roomCode: primaryRoom.roomCode,
    roomName: primaryRoom.roomName,
    roomId: primaryRoom.roomId,
    unitId: primaryRoom.unitId,
    roomAllocations: allocations,
    addedRooms:
      choice === "add"
        ? allocations.filter((room) => room.role === "新增库房")
        : [],
    originalRoomCode,
    originalRoomName: originalRoom?.roomName ?? "",
    replanOf: String(pending.docId),
    replanChoice: choice,
    replanRevision: revision,
    replannedAt: nowIso(),
    replanNotes,
    deviationSummary: deviation,
    reviewPassed: false,
    reviewedAt: "",
    reviewedBy: "",
  };
  const pendingUpdates =
    choice === "change" && appointmentId
      ? [
          {
            docId: appointmentId,
            patch: {
              roomCode: primaryRoom.roomCode,
              roomName: primaryRoom.roomName,
              roomId: primaryRoom.roomId,
              unitId: primaryRoom.unitId,
              replanned: true,
              replannedAt: nowIso(),
            },
          },
        ]
      : [];
  logAgent(
    "scheduler",
    `到货偏差重规划：原始预约吨位${deviation.original?.tonnage ?? originalTonnage}t、库房${originalRoomCode}、q_resp条件温度${deviation.original?.qRespConditionTempC ?? "-"}℃；` +
      `实际吨位${deviation.actual?.tonnage ?? actualTonnage}t、货温${deviation.actual?.cargoTempC ?? "-"}℃；` +
      `偏差吨位${deviation.deviations?.tonnagePct ?? "-"}%（温度不参与触发）；` +
      `库内选择${choice === "add" ? "增加库房" : "更换库房"}；新方案${allocations
        .map((room) => `${room.roomCode}(${room.role})`)
        .join("、")}；新入库单${newDocId}`,
  );
  return {
    pendingDocument: doc,
    pendingUpdates,
    arrivalReplanRevision: revision,
    arrivalReplanChoice: choice,
    reviewPass: false,
    reviewReason: "",
    retryCount: 0,
    phase: "scheduler_arrival_replan_ready",
    routeTo: "xiaoke",
    nextAgent: "",
    rejectTarget: "",
    结果: `已按“${choice === "add" ? "增加库房" : "更换库房"}”生成新入库单 ${newDocId}。`,
    executedAgent: "scheduler",
  };
}

function handleRoomInventoryReady(
  state: ColdStorageState,
): Partial<ColdStorageState> {
  const data = state.taskData ?? {};
  const fruit = normalizeFruit(data.fruit) ?? String(data.fruit ?? "").trim();
  const spec = FRUIT_SPECS[fruit];
  const tonnage = toNumber(data.tonnage);
  const inventory = Array.isArray(state.roomInventory)
    ? state.roomInventory
    : [];
  if (!spec || tonnage === null || tonnage <= 0) {
    return {
      phase: "scheduler_room_candidates_result",
      routeTo: "master",
      nextAgent: "",
      roomCandidates: [],
      error: "果品或吨位无效，无法筛选库房",
      executedAgent: "scheduler",
    };
  }
  const fruitHumidity = Number(
    String(spec.humidity ?? "").replace(/[^\d.]/g, ""),
  );
  const rejectedRoomCodes = new Set(
    Array.isArray(state.roomPrecheckRejectedRooms)
      ? state.roomPrecheckRejectedRooms
      : [],
  );
  const qualified: Array<Record<string, any>> = [];
  for (const room of inventory) {
    const roomCode = String(room?.roomCode ?? "").trim().toUpperCase();
    const tempMin = toNumber(room?.tempMin);
    const tempMax = toNumber(room?.tempMax);
    const capacityTons = toNumber(room?.capacityTons);
    const roomHumidity = Number(
      String(room?.humidity ?? "").replace(/[^\d.]/g, ""),
    );
    const reasons: string[] = [];
    if (rejectedRoomCodes.has(roomCode)) {
      reasons.push("前置Reviewer已淘汰");
    }
    if (room?.bookable !== true || room?.occupancy !== "available") {
      reasons.push("库房已占用/不可预约");
    }
    if (room?.unitStatus !== "normal") {
      reasons.push("机组异常");
    }
    if (
      !Array.isArray(room?.suitableFruits) ||
      !room.suitableFruits.includes(fruit)
    ) {
      reasons.push("品类不匹配");
    }
    if (
      tempMin === null ||
      tempMax === null ||
      tempMin > spec.tempMin ||
      tempMax < spec.tempMax
    ) {
      reasons.push(`温区不匹配（库房${room?.tempText ?? "-"}，果品${spec.tempText}）`);
    }
    if (
      Number.isFinite(fruitHumidity) &&
      fruitHumidity > 0 &&
      Number.isFinite(roomHumidity) &&
      roomHumidity > 0 &&
      Math.abs(roomHumidity - fruitHumidity) > 5
    ) {
      reasons.push(`湿度不匹配（库房${room?.humidity ?? "-"}，果品${spec.humidity}）`);
    }
    if (
      capacityTons === null ||
      capacityTons < tonnage
    ) {
      reasons.push(`库容不足（可用${room?.capacityTons ?? "-"}t，需${tonnage}t）`);
    }
    const passed = reasons.length === 0;
    if (passed) {
      qualified.push(room);
    }
    logAgent(
      "scheduler",
      `预选比对 ${roomCode}（${room?.roomName ?? "-"}）：品类${room?.suitableFruits ?? "-"}，温区${room?.tempText ?? "-"}，湿度${room?.humidity ?? "-"}，可用库容${room?.capacityTons ?? "-"}t，机组${room?.unitId ?? "-"}，占用${room?.occupancy ?? "-"} -> ${
        passed ? "通过" : `淘汰（${reasons.join("；")}）`
      }`,
    );
  }
  const candidates: Array<Record<string, any>> = qualified.map((room) => ({
    ...room,
    availableCapacityTons: room.capacityTons,
    precheckStatus: "scheduler_passed",
    matchNote: `品类适配（${fruit}）；温区${room.tempText}覆盖${spec.tempText}；湿度${room.humidity}匹配${spec.humidity}；库容${room.capacityTons}t≥${tonnage}t；机组${room.unitId}正常；库房未占用；可正常入库`,
  }));
  if (candidates.length > 0) {
    const precheckAttempt = Number(state.roomPrecheckAttempt ?? 0) + 1;
    logAgent(
      "scheduler",
      `预选完成：果品${fruit}，吨位${tonnage}t；库存${inventory.length}间，温湿度/库容等预校验后候选${candidates.length}间：${candidates
        .map(
          (room) =>
            `${room.roomCode}(${room.roomName}) 温区${room.tempText} 湿度${room.humidity} 可用库容${room.availableCapacityTons}t`,
        )
        .join("；")}；送前置reviewer快速核验（第${precheckAttempt}次）`,
    );
    return {
      phase: "scheduler_room_precheck",
      routeTo: "reviewer",
      nextAgent: "",
      roomCandidates: candidates,
      roomPrecheckAttempt: precheckAttempt,
      roomPrecheckFailures: [],
      error: "",
      结果: `预选通过，${candidates.length}间候选库房送前置reviewer核验。`,
      executedAgent: "scheduler",
    };
  }
  logAgent(
    "scheduler",
    `【暂时没有满足本次预约条件的合格库房】果品${fruit}，吨位${tonnage}t；库存${inventory.length}间全部不满足品类/温区/湿度/库容/机组/占用条件。`,
  );
  logAgent(
    "scheduler",
    "暂无匹配库房，本次预约无法分配贮藏位置；已上报管理员。不合格库房不会进入reviewer或入库流程。",
  );
  return {
    phase: "scheduler_room_candidates_result",
    routeTo: "master",
    nextAgent: "",
    roomCandidates: [],
    error: "",
    结果:
      "【暂时没有满足本次预约条件的合格库房】暂无匹配库房，本次预约无法分配贮藏位置。",
    executedAgent: "scheduler",
  };
}

/** 调度员：组装单据、管理重试、通过后写台账、响应台账查询。 */
export async function schedulerNode(
  state: ColdStorageState,
): Promise<Partial<ColdStorageState>> {
  if (
    state.phase === "master_dispatch_inbound" &&
    state.taskKind === "appointment"
  ) {
    logAgent(
      "scheduler",
      "【来源：scheduler】收到预约任务，请求master代为向小柯查询全部库房库存和状态",
    );
    return {
      phase: "scheduler_room_inventory_request",
      routeTo: "master",
      nextAgent: "",
      executedAgent: "scheduler",
    };
  }

  if (state.phase === "master_room_inventory_ready") {
    return handleRoomInventoryReady(state);
  }

  if (state.phase === "reviewer_room_precheck_failed") {
    const failures = Array.isArray(state.roomPrecheckFailures)
      ? state.roomPrecheckFailures
      : [];
    const rejected = new Set([
      ...(Array.isArray(state.roomPrecheckRejectedRooms)
        ? state.roomPrecheckRejectedRooms
        : []),
      ...failures.map((failure) => String(failure?.roomCode ?? "")),
    ]);
    logAgent(
      "scheduler",
      `前置reviewer核验打回：${failures
        .map(
          (failure) =>
            `${failure.roomCode}(${failure.reasons?.join("；") ?? "-"})`,
        )
        .join("；")}；回退scheduler重新选库房，不进入用户选择、不进入入库整改重试`,
    );
    return handleRoomInventoryReady({
      ...state,
      roomPrecheckRejectedRooms: Array.from(rejected).filter(Boolean),
    });
  }

  if (
    state.phase === "master_dispatch_inbound" ||
    state.phase === "master_room_choice_confirmed"
  ) {
    return handleInboundTask(state);
  }

  if (state.phase === "review_complete") {
    return handleReviewResult(state);
  }

  if (state.phase === "scheduler_rectification_ready") {
    return rectifyPendingDocument(state);
  }

  if (state.phase === "arrival_deviation_ok") {
    logAgent(
      "scheduler",
      "小柯确认到货偏差已处理或未超过阈值，转reviewer审核",
    );
    return {
      pendingDocument: state.pendingDocument,
      pendingUpdates: state.pendingUpdates,
      reviewPass: false,
      reviewReason: "",
      phase: "inbound_awaiting_review",
      routeTo: "reviewer",
      nextAgent: "",
      rejectTarget: "",
      结果: "",
      finalAnswer: "",
      executedAgent: "scheduler",
    };
  }

  if (state.phase === "master_arrival_replan_request") {
    return handleArrivalReplan(state);
  }

  if (
    state.phase === "master_query_ledger_user" ||
    state.phase === "master_query_ledger_cop" ||
    state.phase === "master_query_ledger_estimate" ||
    state.phase === "master_query_cop_inbound" ||
    state.phase === "master_query_appointments_estimate"
  ) {
    return handleLedgerQuery(state);
  }

  logAgent("scheduler", `收到未知阶段消息：${state.phase || "空"}`);
  return {
    routeTo: "master",
    nextAgent: "",
    executedAgent: "scheduler",
  };
}
