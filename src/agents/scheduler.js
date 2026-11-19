import { FRUIT_SPECS, MAX_RETRIES, applyPendingChanges, findAppointmentRecord, formatDateTime, logAgent, nextDocId, normalizeFruit, nowIso, recordBrief, toNumber, } from "../state";
import { resourceScheduler } from "../resource-scheduler";
import { DEFAULT_ROOM_CODE, DEFAULT_ROOM_ID, DEFAULT_UNIT_ID, getRoomInfo, markRoomOccupied, } from "../equipment-registry";
function buildAppointmentDocument(state) {
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
function buildArrivalDocument(state) {
    const data = state.taskData ?? {};
    const appointmentId = String(data.appointmentId ?? "").trim().toUpperCase();
    const appointment = findAppointmentRecord(state.记录, appointmentId);
    const fruit = normalizeFruit(appointment?.fruit) ??
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
        scheduledAt: appointment?.scheduledAt ?? "",
        storageDays: toNumber(appointment?.storageDays),
        roomId: appointment?.roomId ?? appointment?.roomName ?? DEFAULT_ROOM_ID,
        roomCode: appointment?.roomCode ??
            state.taskData?.roomCode ??
            DEFAULT_ROOM_CODE,
        roomName: appointment?.roomName ?? "",
        unitId: appointment?.unitId ?? DEFAULT_UNIT_ID,
        createdBy: state.account || "未知账号",
        createdAt: nowIso(),
        source: "scheduler",
    };
    const updates = [];
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
function assembleInboundDocument(state) {
    if (state.taskKind === "arrival") {
        return buildArrivalDocument(state);
    }
    return buildAppointmentDocument(state);
}
async function handleInboundTask(state) {
    logAgent("scheduler", "收到master下发的入库任务");
    logAgent("scheduler", `组装单据类型：${state.taskKind}`);
    if (state.taskKind === "appointment") {
        const selectedRoomCode = String(state.taskData?.roomCode ?? "")
            .trim()
            .toUpperCase();
        const room = getRoomInfo(selectedRoomCode);
        if (!room || !room.bookable) {
            logAgent("scheduler", `预约库房校验未通过：${selectedRoomCode || "(空)"}（必须是候选且未占用、机组正常）`);
            return {
                phase: "inbound_failed",
                routeTo: "master",
                nextAgent: "",
                pendingDocument: null,
                pendingUpdates: [],
                结果: "预约库房校验未通过：必须从候选库房中选择未占用且机组正常的库房。",
                error: "预约库房无效",
                executedAgent: "scheduler",
            };
        }
    }
    const outcome = await resourceScheduler.run({
        resource: "ledger",
        priority: "user",
        label: `scheduler-assemble-${state.taskKind || "unknown"}`,
    }, (signal) => {
        signal.throwIfAborted();
        return assembleInboundDocument(state);
    });
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
    logAgent("scheduler", `组装单据 ${String(doc.docId)} 完成，发送reviewer审核（第1次）`);
    return {
        pendingDocument: doc,
        pendingUpdates: updates,
        retryCount: 0,
        reviewPass: false,
        phase: "inbound_awaiting_review",
        routeTo: "reviewer",
        nextAgent: "",
        rejectTarget: "",
        结果: "",
        finalAnswer: "",
        executedAgent: "scheduler",
    };
}
async function handleReviewResult(state) {
    const passed = Boolean(state.reviewPass);
    const reviewReason = String(state.reviewReason ?? "").trim();
    logAgent("scheduler", `收到reviewer审核结果：${passed ? "通过" : "不通过"}${!passed && reviewReason ? `，原因：${reviewReason}` : ""}`);
    if (passed) {
        const pending = state.pendingDocument;
        const outcome = await resourceScheduler.run({
            resource: "ledger",
            priority: "user",
            label: "scheduler-commit-ledger",
        }, (signal) => {
            signal.throwIfAborted();
            return applyPendingChanges(state.记录, pending, state.pendingUpdates);
        });
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
            logAgent("scheduler", `预约通过审核，库房 ${pending.roomCode}（${pending.roomName || pending.roomId || "-"}）标记为占用`);
        }
        logAgent("scheduler", "审核通过：仅将入库单据写入台账，不进入小柯COP核算报告链路");
        logAgent("scheduler", `台账现有入库单据 ${records.length} 条`);
        const result = [
            "入库单据已通过质检并写入台账。",
            `单据：${pending ? recordBrief(pending) : "未知单据"}`,
            `本次审核重试次数：${state.retryCount}/${MAX_RETRIES}`,
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
    if (state.retryCount < MAX_RETRIES) {
        const retryCount = state.retryCount + 1;
        logAgent("scheduler", `审核不通过，原因：${reviewReason || "reviewer未提供具体原因"}；退回重试 ${retryCount}/${MAX_RETRIES}，重新发送reviewer（第${retryCount + 1}次审核）`);
        return {
            retryCount,
            reviewPass: false,
            phase: "inbound_awaiting_review",
            routeTo: "reviewer",
            rejectTarget: "",
            executedAgent: "scheduler",
        };
    }
    logAgent("scheduler", `重试次数已达上限 ${MAX_RETRIES} 次，终止任务，不生成有效入库单据；最后原因：${reviewReason || "reviewer未提供具体原因"}`);
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
        结果: `入库单据审核连续未通过，已重试 ${MAX_RETRIES} 次，任务终止，未写入台账。\n最后一次审核不通过原因：${reviewReason || "reviewer未提供具体原因"}`,
        executedAgent: "scheduler",
    };
}
async function handleLedgerQuery(state) {
    logAgent("scheduler", `收到master转达的台账查询请求（用途：${state.ledgerQueryPurpose || "未知"}）`);
    const purpose = state.ledgerQueryPurpose;
    const outcome = await resourceScheduler.run({
        resource: "ledger",
        priority: "user",
        label: `scheduler-ledger-query-${purpose || "unknown"}`,
    }, (signal) => {
        signal.throwIfAborted();
        if (purpose === "cop_report") {
            return (state.记录 ?? []).filter((record) => record?.docType === "arrival");
        }
        if (purpose === "my_appointments") {
            return (state.记录 ?? []).filter((record) => record?.docType === "appointment" &&
                record?.createdBy === state.account);
        }
        if (purpose === "cop_inbound") {
            return (state.记录 ?? []).filter((record) => record?.docType === "arrival");
        }
        if (purpose === "appointment_estimate") {
            // 预估需要全部预约单用于动态计算 Q总/分摊，单库房或整机组由小柯按选择处理。
            return (state.记录 ?? []).filter((record) => record?.docType === "appointment");
        }
        return state.记录 ?? [];
    });
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
    const purposeLabel = purpose === "cop_report"
        ? "小柯COP核算报告"
        : purpose === "cop_inbound"
            ? "小柯探测入库单"
            : purpose === "appointment_estimate"
                ? "预约阶段COP预估"
                : purpose === "my_appointments"
                    ? "库外账号查询自己的预约单"
                    : "用户查看";
    logAgent("scheduler", `调取台账单据：${records.length} 条（用途：${purposeLabel}）`);
    logAgent("scheduler", "将台账单据返回master");
    return {
        ledgerDocuments: records,
        phase: "scheduler_ledger_result",
        routeTo: "master",
        nextAgent: "",
        error: "",
        executedAgent: "scheduler",
    };
}
function handleRoomInventoryReady(state) {
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
    const candidates = inventory.filter((room) => {
        const tempMin = toNumber(room?.tempMin);
        const tempMax = toNumber(room?.tempMax);
        const capacityTons = toNumber(room?.capacityTons);
        if (room?.bookable !== true)
            return false;
        if (room?.unitStatus !== "normal")
            return false;
        if (room?.occupancy !== "available")
            return false;
        if (tempMin === null ||
            tempMax === null ||
            capacityTons === null ||
            capacityTons < tonnage) {
            return false;
        }
        return tempMin <= spec.tempMin && tempMax >= spec.tempMax;
    });
    logAgent("scheduler", `按果品 ${fruit}（${spec.tempText}，${spec.humidity}）和吨位 ${tonnage}t 筛选库房；` +
        `库存 ${inventory.length} 间，可预约 ${candidates.length} 间：${candidates.map((room) => `${room.roomCode}(${room.roomName})`).join("、") ||
            "无"}`);
    return {
        phase: "scheduler_room_candidates_result",
        routeTo: "master",
        nextAgent: "",
        roomCandidates: candidates,
        error: "",
        结果: candidates.length > 0
            ? `已筛选出 ${candidates.length} 间满足果品、机组和占用条件的库房，提交master展示。`
            : "没有同时满足果品温湿度、机组正常和未占用条件的库房。",
        executedAgent: "scheduler",
    };
}
/** 调度员：组装单据、管理重试、通过后写台账、响应台账查询。 */
export async function schedulerNode(state) {
    if (state.phase === "master_dispatch_inbound" &&
        state.taskKind === "appointment") {
        logAgent("scheduler", "【来源：scheduler】收到预约任务，请求master代为向小柯查询全部库房库存和状态");
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
    if (state.phase === "master_dispatch_inbound" ||
        state.phase === "master_room_choice_confirmed") {
        return handleInboundTask(state);
    }
    if (state.phase === "review_complete") {
        return handleReviewResult(state);
    }
    if (state.phase === "master_query_ledger_user" ||
        state.phase === "master_query_ledger_cop" ||
        state.phase === "master_query_ledger_estimate" ||
        state.phase === "master_query_cop_inbound" ||
        state.phase === "master_query_appointments_estimate") {
        return handleLedgerQuery(state);
    }
    logAgent("scheduler", `收到未知阶段消息：${state.phase || "空"}`);
    return {
        routeTo: "master",
        nextAgent: "",
        executedAgent: "scheduler",
    };
}
