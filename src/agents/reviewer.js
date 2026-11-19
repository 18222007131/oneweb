import { COLD_ROOM_CAPACITY_TONS, FRUIT_SPECS, callDeepSeekJson, capacityConflict, findAppointmentRecord, logAgent, normalizeFruit, parseAppointmentTime, safeJson, toNumber, } from "../state";
import { resourceScheduler } from "../resource-scheduler";
import { computeHistoryStats, evaluateCopAgainstHistory, } from "../plc-monitor";
const REVIEWER_SYSTEM = `你是冷库入库单质检员，只做合规校验，不生成方案、不做任何计算。
严格只输出一个 JSON 对象：
{"passed": true 或 false, "reason": "简短中文原因"}

校验规则：
1. 入库预约单：果品必须是杨梅/柚子/苹果；温区、相对湿度必须匹配内置参数；
   吨位、预约入库时间、计划贮藏天数必须有效；库容时段不能冲突；
   预约单中绝不能出现到货货温。
2. 到货入库单：必须关联已存在且状态为 booked 的预约单；实际吨位、到货货温必须有效。
3. 不要输出冷负荷、预冷参数、功率、COP、碳排等任何计算结果。
4. 审核通过时 reason 可写“符合要求”；审核不通过时必须用简短中文说明具体原因。`;
const COP_REVIEWER_SYSTEM = `你是冷库COP核算结果质检员。小柯已经提交计算结果，你只审核结果是否完整、来源是否一致、数值是否合理，不重新计算、不修改结果、不生成报告。
严格只输出一个 JSON 对象：
{"passed": true 或 false, "reason": "简短中文原因"}

审核规则：
1. 必须包含本次实时PLC参数、核算类型、COP类型（单库房COP/整机组COP）、来源单据、机组功率、COP。
2. 单库房COP（copScope=single）就是分摊等效COP：必须有库房编号（如A1）、Q总、W总、该库房Qi、负荷占比、Wi和COPi；标记必须包含【单库房COP（分摊等效COP）】。
3. 整机组COP（copScope=unit）必须标记【整机组COP】，按整机组Q总/W总计算。
4. 正式核算（mode=formal）还必须有果品中心温度、库房温度、到货批次、Q2、冷负荷和碳排放；每个到货批次必须有来源单号、正吨位和正冷负荷。
5. 预约预估（mode=estimate）必须有预约单/Q1来源、Q1。
6. 预设边界：正式核算COP为1.8到4.2；预约预估COP为0.01到10。碳排放不得为负数。
7. 来源单号数量必须与来源一致；系统会按相同核算类型和相同COP类型（单库房还按相同库房编号）做5天历史均值和异常值校验，不能跨类型混用。
8. 审核不通过时必须用简短中文说明具体原因；通过时 reason 可写“符合要求”。`;
function normalizeReviewReason(value, fallback) {
    const text = String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    return text ? text.slice(0, 500) : fallback;
}
function parseBoolean(value) {
    if (typeof value === "boolean")
        return value;
    const text = String(value ?? "").trim().toLowerCase();
    if (["true", "1", "yes", "pass", "passed", "通过"].includes(text))
        return true;
    if (["false", "0", "no", "fail", "failed", "不通过", "驳回"].includes(text)) {
        return false;
    }
    return null;
}
/** 本地硬规则只用于防止模型误放行；不通过时必须给出具体原因。 */
function localComplianceResult(state) {
    const doc = state.pendingDocument;
    if (!doc) {
        return { passed: false, reason: "没有收到待审核的入库单据。" };
    }
    if (doc.docType === "appointment") {
        const fruit = normalizeFruit(doc.fruit);
        const spec = fruit ? FRUIT_SPECS[fruit] : undefined;
        if (!fruit || !spec) {
            return {
                passed: false,
                reason: "预约单果品不合法，必须是杨梅、柚子或苹果。",
            };
        }
        if (doc.tempZone !== spec.tempText || doc.humidity !== spec.humidity) {
            return {
                passed: false,
                reason: `预约单温区或湿度与${fruit}标准不一致。`,
            };
        }
        const tonnage = toNumber(doc.tonnage);
        const storageDays = toNumber(doc.storageDays);
        const scheduledAt = parseAppointmentTime(doc.scheduledAt);
        if (tonnage === null || tonnage <= 0) {
            return { passed: false, reason: "预约吨位必须是大于0的数值。" };
        }
        if (tonnage > COLD_ROOM_CAPACITY_TONS) {
            return {
                passed: false,
                reason: `预约吨位超过总库容 ${COLD_ROOM_CAPACITY_TONS} 吨。`,
            };
        }
        if (!scheduledAt) {
            return { passed: false, reason: "预约入库时间格式无效。" };
        }
        if (scheduledAt.getTime() <= Date.now()) {
            return {
                passed: false,
                reason: "预约入库时间必须晚于当前本机时间。",
            };
        }
        if (storageDays === null ||
            !Number.isInteger(storageDays) ||
            storageDays <= 0) {
            return { passed: false, reason: "计划贮藏天数必须是正整数。" };
        }
        if ("cargoTempC" in doc || "arrivalTempC" in doc) {
            return {
                passed: false,
                reason: "预约单中不能出现到货货温。",
            };
        }
        const conflict = capacityConflict(state.记录, scheduledAt, storageDays, tonnage);
        if (conflict) {
            return { passed: false, reason: conflict };
        }
        return { passed: true, reason: "" };
    }
    if (doc.docType === "arrival") {
        const appointment = findAppointmentRecord(state.记录, doc.appointmentId);
        if (!appointment) {
            return {
                passed: false,
                reason: `关联预约单 ${String(doc.appointmentId ?? "").trim() || "(空)"} 不存在。`,
            };
        }
        if (appointment.status !== "booked") {
            return {
                passed: false,
                reason: `关联预约单 ${appointment.docId} 状态为 ${appointment.statusName ?? appointment.status}，不可入库。`,
            };
        }
        const fruit = normalizeFruit(appointment.fruit);
        const spec = fruit ? FRUIT_SPECS[fruit] : undefined;
        if (!fruit || !spec) {
            return {
                passed: false,
                reason: "关联预约单果品不合法。",
            };
        }
        if (doc.fruit !== fruit || doc.tempZone !== spec.tempText) {
            return {
                passed: false,
                reason: "到货单果品、温区与关联预约单不一致。",
            };
        }
        const actualTonnage = toNumber(doc.actualTonnage);
        const cargoTempC = toNumber(doc.cargoTempC);
        if (actualTonnage === null || actualTonnage <= 0) {
            return { passed: false, reason: "实际到货吨位必须是大于0的数值。" };
        }
        if (actualTonnage > COLD_ROOM_CAPACITY_TONS) {
            return {
                passed: false,
                reason: `实际到货吨位超过总库容 ${COLD_ROOM_CAPACITY_TONS} 吨。`,
            };
        }
        if (cargoTempC === null || cargoTempC < -5 || cargoTempC > 45) {
            return {
                passed: false,
                reason: "到货货温必须在 -5℃ 到 45℃ 之间。",
            };
        }
        return { passed: true, reason: "" };
    }
    return { passed: false, reason: "无法识别的入库单据类型。" };
}
function localCopCalculationResult(state, calculation) {
    if (!calculation) {
        return { passed: false, reason: "没有收到可审核的COP核算结果。" };
    }
    const mode = calculation.mode === "estimate" ? "estimate" : "formal";
    const plc = calculation.plcSnapshot;
    const cop = toNumber(calculation.cop);
    if (!plc || toNumber(plc.powerW) === null || toNumber(plc.cop) === null) {
        return { passed: false, reason: "COP核算结果缺少本次实时PLC参数。" };
    }
    if (cop === null || cop <= 0) {
        return { passed: false, reason: "COP核算结果不是有效的正数。" };
    }
    const sourceDocIds = Array.isArray(calculation.sourceDocIds)
        ? calculation.sourceDocIds
        : [];
    const copScope = calculation.copScope === "unit" ? "unit" : "single";
    const expectedScopeLabel = copScope === "unit"
        ? "【整机组COP】"
        : "【单库房COP（分摊等效COP）】";
    if (calculation.scopeLabel !== expectedScopeLabel) {
        return {
            passed: false,
            reason: `COP类型标记不正确，应为${expectedScopeLabel}。`,
        };
    }
    if (copScope === "single") {
        if (!/^[A-Z]\d{1,3}$/.test(String(calculation.roomCode ?? ""))) {
            return { passed: false, reason: "单库房COP缺少有效的库房编号（如A1）。" };
        }
        const rooms = Array.isArray(calculation.rooms) ? calculation.rooms : [];
        if (rooms.length === 0) {
            return {
                passed: false,
                reason: "单库房COP缺少库房热负荷分摊数据。",
            };
        }
        let shareTotal = 0;
        let selectedRoomFound = false;
        for (const room of rooms) {
            const roomCode = String(room?.roomCode ?? "");
            const roomQ = toNumber(room?.qW);
            const share = toNumber(room?.loadSharePct);
            const allocatedPower = toNumber(room?.allocatedPowerW);
            const roomCop = toNumber(room?.cop);
            if (!/^[A-Z]\d{1,3}$/.test(roomCode)) {
                return { passed: false, reason: "COP分摊数据中存在非法库房编号。" };
            }
            if (roomQ === null ||
                roomQ <= 0 ||
                share === null ||
                share <= 0 ||
                allocatedPower === null ||
                allocatedPower <= 0 ||
                roomCop === null ||
                roomCop <= 0) {
                return {
                    passed: false,
                    reason: `库房 ${roomCode} 的Qi/占比/Wi/COPi分摊数据无效。`,
                };
            }
            if (roomCode === String(calculation.roomCode ?? "")) {
                selectedRoomFound = true;
            }
            shareTotal += share;
        }
        if (!selectedRoomFound) {
            return {
                passed: false,
                reason: "单库房COP的目标库房没有出现在分摊数据中。",
            };
        }
        if (shareTotal < 95 || shareTotal > 105) {
            return {
                passed: false,
                reason: `分摊等效COP的库房负荷占比合计异常（${shareTotal.toFixed(2)}%）。`,
            };
        }
    }
    let historySamples = [];
    if (mode === "estimate") {
        if (sourceDocIds.length < 1) {
            return {
                passed: false,
                reason: "预约阶段COP预估缺少预约单来源。",
            };
        }
        const q1 = toNumber(calculation.qValue);
        if (q1 === null || q1 <= 0) {
            return { passed: false, reason: "预约阶段COP预估的Q1无效。" };
        }
        historySamples = (state.reportRecords ?? [])
            .filter((report) => report?.reportMode === mode &&
            report?.copScope === calculation.copScope &&
            (calculation.copScope !== "single" ||
                String(report?.roomCode ?? "") ===
                    String(calculation.roomCode ?? "")) &&
            Number.isFinite(Number(report?.cop)))
            .map((report) => ({
            timestamp: String(report?.generatedAt ?? report?.createdAt ?? ""),
            cop: Number(report.cop),
        }));
    }
    else {
        const lots = Array.isArray(calculation.lots) ? calculation.lots : [];
        if (lots.length === 0) {
            return { passed: false, reason: "正式COP核算结果没有到货批次。" };
        }
        if (sourceDocIds.length !== lots.length) {
            return {
                passed: false,
                reason: "COP核算结果的来源单号数量与到货批次数量不一致。",
            };
        }
        const totals = calculation.totals ?? {};
        const coldLoadW = toNumber(totals.coldLoadW);
        const powerW = toNumber(totals.powerW);
        const carbon = toNumber(totals.carbonEmissionKgCO2e);
        if (coldLoadW === null || coldLoadW <= 0) {
            return { passed: false, reason: "COP核算结果的总冷负荷无效。" };
        }
        if (powerW === null || powerW <= 0) {
            return { passed: false, reason: "COP核算结果的机组功率无效。" };
        }
        if (carbon === null || carbon < 0) {
            return { passed: false, reason: "COP核算结果的碳排放数值无效。" };
        }
        for (let index = 0; index < lots.length; index += 1) {
            const lot = lots[index];
            const tonnage = toNumber(lot?.tonnage);
            const lotColdLoad = toNumber(lot?.coldLoadW);
            const lotCarbon = toNumber(lot?.carbonEmissionKgCO2e);
            if (!String(lot?.sourceDocId ?? "").trim()) {
                return {
                    passed: false,
                    reason: `第 ${index + 1} 个到货批次缺少来源单号。`,
                };
            }
            if (tonnage === null || tonnage <= 0) {
                return {
                    passed: false,
                    reason: `第 ${index + 1} 个到货批次吨位无效。`,
                };
            }
            if (lotColdLoad === null || lotColdLoad <= 0) {
                return {
                    passed: false,
                    reason: `第 ${index + 1} 个到货批次冷负荷无效。`,
                };
            }
            if (lotCarbon === null || lotCarbon < 0) {
                return {
                    passed: false,
                    reason: `第 ${index + 1} 个到货批次碳排放无效。`,
                };
            }
        }
        historySamples = (state.reportRecords ?? [])
            .filter((report) => report?.reportMode === mode &&
            report?.copScope === calculation.copScope &&
            (calculation.copScope !== "single" ||
                String(report?.roomCode ?? "") ===
                    String(calculation.roomCode ?? "")) &&
            Number.isFinite(Number(report?.cop)))
            .map((report) => ({
            timestamp: String(report?.generatedAt ?? report?.createdAt ?? ""),
            cop: Number(report.cop),
        }));
    }
    const history = computeHistoryStats(historySamples, new Date(), "");
    const quality = evaluateCopAgainstHistory({
        cop,
        mode,
        history,
    });
    logAgent("reviewer", `历史比对范围：核算类型=${mode}，COP类型=${copScope}，库房=${copScope === "single" ? calculation.roomCode : "机组汇总"}；历史样本=${history.count}，均值=${history.mean ?? "无"}；当前COP=${cop}，偏离=${quality.deviationPct === null
        ? "无可用历史"
        : `${quality.deviationPct.toFixed(2)}%`}`);
    if (!quality.passed) {
        return {
            passed: false,
            reason: quality.reasons.join("；"),
        };
    }
    return { passed: true, reason: "" };
}
async function reviewCopCalculation(state) {
    const calculation = state.copCalculation;
    logAgent("reviewer", "收到小柯提交的COP核算结果，开始质检");
    logAgent("reviewer", "质检校验项：异常值、预设边界、相对该库房5天历史均值短时偏离是否超过5%");
    logAgent("reviewer", "质检员正在审核COP核算结果，请稍候……");
    if (!calculation) {
        const reason = "没有收到可审核的COP核算结果。";
        logAgent("reviewer", `COP核算质检不通过，原因：${reason}`);
        return {
            reviewPass: false,
            reviewReason: reason,
            phase: "cop_calc_review_complete",
            routeTo: "xiaoke",
            error: "",
            executedAgent: "reviewer",
        };
    }
    const localResult = localCopCalculationResult(state, calculation);
    const llmOutcome = await resourceScheduler.run({
        resource: "llm",
        priority: "reviewer",
        label: "reviewer-cop-calc-compliance",
    }, async (signal) => callDeepSeekJson(COP_REVIEWER_SYSTEM, safeJson({
        account: state.account,
        calculation,
    }), { signal }));
    let llmPassed = false;
    let llmReason = "";
    if (llmOutcome.ok) {
        llmPassed = parseBoolean(llmOutcome.value.passed) ?? false;
        llmReason = normalizeReviewReason(llmOutcome.value.reason, "DeepSeek审核未通过（未提供具体原因）。");
    }
    else {
        llmReason = `大模型审核任务失败：${llmOutcome.failureMessage}`;
        logAgent("reviewer", `大模型资源任务失败：${llmOutcome.failureMessage}`);
    }
    const passed = localResult.passed && llmPassed;
    const reasons = [];
    if (!localResult.passed)
        reasons.push(localResult.reason);
    if (!llmPassed)
        reasons.push(llmReason);
    const reviewReason = passed
        ? ""
        : reasons.filter(Boolean).join("；") || "COP核算结果未通过质检。";
    logAgent("reviewer", passed
        ? "COP核算结果质检通过，允许小柯制作报告"
        : `COP核算结果质检不通过，原因：${reviewReason}`);
    return {
        reviewPass: passed,
        reviewReason,
        phase: "cop_calc_review_complete",
        routeTo: "xiaoke",
        error: "",
        executedAgent: "reviewer",
    };
}
/** 质检员：只返回审核通过/不通过。 */
export async function reviewerNode(state) {
    if (state.phase === "cop_calc_review") {
        return reviewCopCalculation(state);
    }
    const doc = state.pendingDocument;
    logAgent("reviewer", `收到scheduler送审单据：${String(doc?.docId ?? "无单号")}`);
    logAgent("reviewer", "调用DeepSeek做入库单据合规校验");
    const ledgerOutcome = await resourceScheduler.run({
        resource: "ledger",
        priority: "reviewer",
        label: "reviewer-ledger-compliance",
    }, () => localComplianceResult(state));
    const localResult = ledgerOutcome.ok
        ? ledgerOutcome.value
        : {
            passed: false,
            reason: `台账资源任务失败：${ledgerOutcome.failureMessage}`,
        };
    if (!ledgerOutcome.ok) {
        logAgent("reviewer", `台账资源任务失败：${ledgerOutcome.failureMessage}`);
    }
    const llmOutcome = await resourceScheduler.run({
        resource: "llm",
        priority: "reviewer",
        label: "reviewer-deepseek-compliance",
    }, async (signal) => callDeepSeekJson(REVIEWER_SYSTEM, safeJson({
        taskKind: state.taskKind,
        pendingDocument: doc,
        appointmentContext: (state.记录 ?? []).filter((record) => record?.docType === "appointment"),
    }), { signal }));
    let llmPassed = false;
    let llmReason = "";
    if (llmOutcome.ok) {
        llmPassed = parseBoolean(llmOutcome.value.passed) ?? false;
        llmReason = normalizeReviewReason(llmOutcome.value.reason, "DeepSeek审核未通过（未提供具体原因）。");
    }
    else {
        llmReason = `大模型审核任务失败：${llmOutcome.failureMessage}`;
        logAgent("reviewer", `大模型资源任务失败：${llmOutcome.failureMessage}`);
    }
    const passed = localResult.passed && llmPassed;
    const reasons = [];
    if (!localResult.passed)
        reasons.push(localResult.reason);
    if (!llmPassed)
        reasons.push(llmReason);
    const reviewReason = passed
        ? ""
        : reasons.filter(Boolean).join("；") || "入库单据未通过质检。";
    logAgent("reviewer", passed
        ? "审核通过，结果返回scheduler"
        : `审核不通过，原因：${reviewReason}，结果返回scheduler`);
    return {
        reviewPass: passed,
        reviewReason,
        phase: "review_complete",
        routeTo: "scheduler",
        error: "",
        executedAgent: "reviewer",
    };
}
