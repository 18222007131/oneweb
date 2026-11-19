import { COP_MAX, COP_MIN, FRUIT_SPECS, GRID_EMISSION_FACTOR_KG_PER_KWH, logAgent, nowIso, toNumber, } from "../state";
import { resourceScheduler } from "../resource-scheduler";
import { DEFAULT_ROOM_ID, DEFAULT_UNIT_ID, getLastDeviceClearEpochMs, hasDeviceAbnormal, markDeviceAbnormal, } from "../equipment-registry";
import { detectLongTermAnomaly } from "../plc-monitor";
const MAX_COP_SAMPLES = 2000;
function round(value, digits = 2) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}
function clampCop(value) {
    return Math.min(COP_MAX, Math.max(COP_MIN, value));
}
/** 模拟PLC温度/压力采样；真实项目替换为Modbus/OPC UA/PLC网关读取。 */
async function requestPlcSample(signal) {
    signal.throwIfAborted();
    // 模拟PLC通信延迟，真实实现应在此读取PLC并响应AbortSignal
    await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 80);
        signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason ?? new Error("PLC request aborted"));
        }, { once: true });
    });
    signal.throwIfAborted();
    return pollPlc();
}
function pollPlc() {
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
async function handlePlcPoll(state) {
    const outcome = await resourceScheduler.run({
        resource: "plc",
        priority: "background",
        label: "xiaoke-plc-sample",
    }, async (signal) => {
        // 只有拿到PLC资源、真正开始执行后才输出日志
        logAgent("xiaoke", "开始向PLC设备请求温度、压力数据（当前为模拟PLC数据源）");
        return requestPlcSample(signal);
    });
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
    const copRecords = [...(state.copRecords ?? []), snapshot].slice(-MAX_COP_SAMPLES);
    logAgent("xiaoke", `PLC采样：供温 ${snapshot.supplyTempC}℃，回温 ${snapshot.returnTempC}℃，` +
        `吸气压力 ${snapshot.suctionPressureMPa}MPa，排气压力 ${snapshot.dischargePressureMPa}MPa，` +
        `计算功率 W=${snapshot.powerW}W，COP=${snapshot.cop}`);
    logAgent("xiaoke", "本次仅存储COP/W采样信息，不生成报告；管理员请求结果时再触发COP核算报告流程");
    if (!hasDeviceAbnormal()) {
        const detection = detectLongTermAnomaly(copRecords, new Date(), getLastDeviceClearEpochMs());
        if (detection.abnormal) {
            const alarm = markDeviceAbnormal({
                reason: detection.reason,
                windowStart: detection.windowStart,
                windowEnd: detection.windowEnd,
                sampleCount: detection.sampleCount,
            });
            logAgent("xiaoke", `检测到机组/传感器长期异常，已标记${alarm.roomId}/${alarm.unitId}为设备异常，正在上报master`);
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
async function fetchFreshPlcForCop(label) {
    const outcome = await resourceScheduler.run({
        resource: "plc",
        priority: "user",
        label,
    }, async (signal) => {
        logAgent("xiaoke", "已取得PLC资源，正在调取本次COP核算所需的实时参数");
        return requestPlcSample(signal);
    });
    if (!outcome.ok) {
        return { ok: false, failureMessage: outcome.failureMessage };
    }
    return { ok: true, snapshot: outcome.value };
}
function handleCopInboundRequest(state) {
    logAgent("xiaoke", "【来源：master】小柯→master：请求获取入库单，用于判断正式核算还是预约预估");
    return {
        phase: "cop_inbound_request",
        routeTo: "master",
        nextAgent: "",
        finalAnswer: "",
        结果: "",
        executedAgent: "xiaoke",
    };
}
async function handleFormalAfterCenter(state) {
    logAgent("xiaoke", "【来源：master】已取得入库单和果品中心温度，开始正式COP核算");
    const centerTempC = toNumber(state.taskData?.centerTempC);
    if (centerTempC === null ||
        centerTempC < -5 ||
        centerTempC > 45) {
        return {
            phase: "cop_report_result",
            routeTo: "master",
            nextAgent: "",
            reportPayload: {
                skipped: true,
                message: "缺少有效的果品中心温度，未进行正式COP核算。请先测量果品中心温度。",
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
    const copRecords = [...(state.copRecords ?? []), snapshot].slice(-MAX_COP_SAMPLES);
    const calculation = calculateFormalCopCalculation(state, snapshot);
    if (!calculation) {
        return {
            phase: "cop_report_result",
            routeTo: "master",
            nextAgent: "",
            reportPayload: {
                skipped: true,
                message: "无法进行正式COP核算：入库单或果品中心温度/PLC参数不足。",
            },
            executedAgent: "xiaoke",
        };
    }
    logAgent("xiaoke", `正式核算完成：${calculation.scopeLabel}，COP=${calculation.cop}，` +
        `库房温度=${calculation.roomTempC}℃，中心温度=${calculation.centerTempC}℃，正在提交质检`);
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
async function handleCopReportStart(state) {
    logAgent("xiaoke", "【来源：master】收到master的COP结果请求，触发COP计算功能");
    logAgent("xiaoke", "小柯正在向PLC设备调取实时温度、压力参数，请稍候……");
    const outcome = await resourceScheduler.run({
        resource: "plc",
        priority: "user",
        label: "xiaoke-cop-report-plc",
    }, async (signal) => {
        logAgent("xiaoke", "已取得PLC资源，正在调取本次核算所需的实时参数");
        return requestPlcSample(signal);
    });
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
    const copRecords = [...(state.copRecords ?? []), snapshot].slice(-MAX_COP_SAMPLES);
    logAgent("xiaoke", `实时PLC参数：供温 ${snapshot.supplyTempC}℃，回温 ${snapshot.returnTempC}℃，` +
        `吸气压力 ${snapshot.suctionPressureMPa}MPa，排气压力 ${snapshot.dischargePressureMPa}MPa，` +
        `功率 W=${snapshot.powerW}W，COP=${snapshot.cop}`);
    logAgent("xiaoke", "实时参数已保存，小柯→master：请求入库单数据，请稍候……");
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
function calculateFormalCopCalculation(state, plc) {
    const centerTempC = toNumber(state.taskData?.centerTempC);
    if (centerTempC === null ||
        centerTempC < -5 ||
        centerTempC > 45 ||
        !Number.isFinite(plc.powerW) ||
        plc.powerW <= 0) {
        return null;
    }
    const copScope = state.copScope === "unit" ? "unit" : "single";
    const requestedRoomCode = String(state.copRoomCode ?? "")
        .trim()
        .toUpperCase();
    if (copScope === "single" && !requestedRoomCode)
        return null;
    const roomTempC = toNumber(plc.roomTempC) ?? plc.returnTempC;
    const docs = (state.ledgerDocuments ?? []).filter((doc) => doc?.docType === "arrival");
    if (docs.length === 0)
        return null;
    const lots = [];
    for (const doc of docs) {
        const fruit = String(doc?.fruit ?? "");
        const spec = FRUIT_SPECS[fruit];
        const tonnage = toNumber(doc?.actualTonnage);
        const cargoTempC = toNumber(doc?.cargoTempC);
        if (!spec || tonnage === null || tonnage <= 0 || cargoTempC === null) {
            continue;
        }
        const storageDays = Math.max(toNumber(doc?.storageDays) ?? 1, 1);
        const targetTempC = (spec.tempMin + spec.tempMax) / 2;
        const deltaTK = Math.max(centerTempC - roomTempC, 0);
        const specificHeatKjPerKgK = spec.specificHeatKjPerKgK;
        const q2Kj = tonnage * 1000 * specificHeatKjPerKgK * deltaTK;
        const durationHours = round(Math.min(24, Math.max(4, 4 + deltaTK * 0.7 + tonnage * 0.08)), 1);
        const q2W = durationHours > 0 ? (q2Kj * 1000) / (durationHours * 3600) : 0;
        const respirationW = tonnage * spec.respirationKwPerTon * 1000;
        const auxiliaryW = Math.max(2000, tonnage * 250);
        const coldLoadW = q2W + respirationW + auxiliaryW;
        const cop = q2W / plc.powerW;
        const precoolEnergyKwh = q2Kj > 0.01 ? (q2Kj / 3600 / Math.max(plc.cop, 0.1)) * 1.12 : 0;
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
            deltaTK: round(deltaTK, 2),
            q2Kj: round(q2Kj, 2),
            q2W: round(q2W, 2),
            cop: round(cop, 2),
            coldLoadW: round(coldLoadW, 1),
            precoolParameters: {
                targetTempC: round(targetTempC, 1),
                targetTempZone: spec.tempText,
                durationHours,
                staticPressurePa: "250~400",
                supplyAirDeltaTC: "3~5",
                airVelocityMs: "1.5~2.5",
            },
            carbonEmissionKgCO2e: round(totalEnergyKwh * GRID_EMISSION_FACTOR_KG_PER_KWH, 2),
        });
    }
    if (lots.length === 0)
        return null;
    const totalQ2W = lots.reduce((sum, lot) => sum + lot.q2W, 0);
    const groupedRooms = new Map();
    for (const lot of lots) {
        groupedRooms.set(lot.roomCode, (groupedRooms.get(lot.roomCode) ?? 0) + lot.q2W);
    }
    const selectedRoomQ = groupedRooms.get(requestedRoomCode) ?? 0;
    if (copScope === "single" && selectedRoomQ <= 0)
        return null;
    const allocatedRooms = Array.from(groupedRooms.entries()).map(([roomCode, qW]) => {
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
    const formalCop = plc.powerW > 0 ? totalQ2W / plc.powerW : 0;
    const selectedAllocation = allocatedRooms.find((room) => room.roomCode === requestedRoomCode);
    const cop = copScope === "single"
        ? selectedAllocation?.cop ?? 0
        : formalCop;
    const rooms = copScope === "single" ? allocatedRooms : [];
    for (const lot of lots) {
        lot.cop = round(cop, 4);
    }
    const totals = {
        coldLoadW: round(lots.reduce((sum, lot) => sum + lot.coldLoadW, 0), 1),
        q2W: round(totalQ2W, 2),
        selectedRoomQ2W: round(selectedRoomQ, 2),
        powerW: plc.powerW,
        cop: round(cop, 4),
        plcCop: plc.cop,
        carbonEmissionKgCO2e: round(lots.reduce((sum, lot) => sum + lot.carbonEmissionKgCO2e, 0), 2),
        roomCount: groupedRooms.size,
    };
    const now = nowIso();
    return {
        mode: "formal",
        label: "【正式核算值】",
        copScope,
        scopeLabel: copScope === "unit"
            ? "【整机组COP】"
            : "【单库房COP（分摊等效COP）】",
        roomCode: copScope === "single" ? requestedRoomCode : "ALL",
        computedAt: now,
        generatedAt: now,
        sourceDocIds: lots.map((lot) => lot.sourceDocId),
        plcSnapshot: plc,
        lots,
        appointment: null,
        centerTempC: round(centerTempC, 1),
        roomTempC: round(roomTempC, 1),
        qValue: round(copScope === "single" ? selectedRoomQ : totalQ2W, 2),
        qUnit: "W（按预冷时长折算的平均热负荷）",
        cop: round(cop, 4),
        rooms,
        totals,
    };
}
function calculateEstimateCopCalculation(state, plc) {
    const copScope = state.copScope === "unit" ? "unit" : "single";
    const requestedRoomCode = String(state.copRoomCode ?? "")
        .trim()
        .toUpperCase();
    if (copScope === "single" && !requestedRoomCode)
        return null;
    const allAppointments = (state.ledgerDocuments ?? []).filter((doc) => doc?.docType === "appointment");
    if (allAppointments.length === 0)
        return null;
    const roomLoads = new Map();
    const sourceIds = [];
    for (const appointment of allAppointments) {
        const fruit = String(appointment?.fruit ?? "");
        const spec = FRUIT_SPECS[fruit];
        const tonnage = toNumber(appointment?.tonnage);
        if (!spec || tonnage === null || tonnage <= 0)
            continue;
        // m 换算为 kg；q_resp 从查表取得，kW/t 与 W/kg 数值等价。
        const massKg = tonnage * 1000;
        const qRespWPerKg = spec.respirationKwPerTon;
        const q1W = massKg * qRespWPerKg;
        const sourceDocId = String(appointment?.docId ?? "");
        sourceIds.push(sourceDocId);
        const roomCode = String(appointment?.roomCode ?? "A1")
            .trim()
            .toUpperCase();
        roomLoads.set(roomCode, (roomLoads.get(roomCode) ?? 0) + q1W);
    }
    if (sourceIds.length === 0)
        return null;
    const qTotal = Array.from(roomLoads.values()).reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(plc.powerW) || plc.powerW <= 0 || qTotal <= 0) {
        return null;
    }
    const selectedRoomQ1W = roomLoads.get(requestedRoomCode) ?? 0;
    if (copScope === "single" && selectedRoomQ1W <= 0)
        return null;
    const allocations = Array.from(roomLoads.entries()).map(([roomCode, qW]) => {
        const sharePct = qTotal > 0 ? (qW / qTotal) * 100 : 0;
        const allocatedPowerW = plc.powerW * (sharePct / 100);
        return {
            roomCode,
            qW: round(qW, 4),
            loadSharePct: round(sharePct, 2),
            allocatedPowerW: round(allocatedPowerW, 2),
            cop: allocatedPowerW > 0 ? round(qW / allocatedPowerW, 4) : 0,
        };
    });
    const selectedAllocation = allocations.find((room) => room.roomCode === requestedRoomCode);
    const cop = copScope === "single"
        ? selectedAllocation?.cop ?? 0
        : qTotal / plc.powerW;
    const calculatedQ = copScope === "single" ? selectedRoomQ1W : qTotal;
    const rooms = copScope === "single" ? allocations : [];
    const now = nowIso();
    return {
        mode: "estimate",
        label: "【预约预估值】",
        copScope,
        scopeLabel: copScope === "unit"
            ? "【整机组COP】"
            : "【单库房COP（分摊等效COP）】",
        roomCode: copScope === "single" ? requestedRoomCode : "ALL",
        computedAt: now,
        generatedAt: now,
        sourceDocIds: sourceIds,
        plcSnapshot: plc,
        lots: [],
        appointment: null,
        centerTempC: null,
        roomTempC: toNumber(plc.roomTempC),
        qValue: round(calculatedQ, 4),
        qUnit: "W（果蔬呼吸热 Q1）",
        cop: round(cop, 4),
        rooms,
        totals: {
            q1W: round(calculatedQ, 4),
            qTotalW: round(qTotal, 4),
            selectedRoomQ1W: round(selectedRoomQ1W, 4),
            powerW: plc.powerW,
            cop: round(cop, 4),
            plcCop: plc.cop,
            coldLoadW: round(calculatedQ, 4),
            carbonEmissionKgCO2e: 0,
            roomCount: rooms.length,
        },
    };
}
function formatCopReport(calculation) {
    const plc = calculation.plcSnapshot;
    const lines = [
        "──────── 小柯COP核算报告 ────────",
        `输出标记：${calculation.label} / ${calculation.scopeLabel}`,
        `COP类型：${calculation.scopeLabel}${calculation.copScope === "single"
            ? `（目标库房 ${calculation.roomCode}）`
            : "（整机组汇总）"}`,
        `核算类型：${calculation.mode === "estimate"
            ? "预约阶段预估计算"
            : "入库后正式核算"}`,
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
        lines.push("──────── 预约预估计算 ────────", `来源预约单：${calculation.sourceDocIds.length} 条`, `Q总（预约呼吸热）：${calculation.totals.qTotalW ?? calculation.qValue} W`, calculation.copScope === "single"
            ? `目标库房 ${calculation.roomCode} 的 Qi：${calculation.totals.selectedRoomQ1W ?? calculation.qValue} W`
            : `整机组 Q总：${calculation.totals.qTotalW ?? calculation.qValue} W`, `Q1（仅果蔬呼吸热）：${calculation.qValue} W`, "公式：Q1 = m × q_resp；单库房按分摊功率计算 COPi，整机组按 Q总/W总计算 COP", `【预约预估值】COP = ${calculation.cop}`, "", ...(calculation.copScope === "single"
            ? [
                "库房热负荷与分摊：",
                ...calculation.rooms.map((room) => `  ${room.roomCode}: Qi=${room.qW} W，负荷占比 ${room.loadSharePct}%，分摊功率 Wi=${room.allocatedPowerW} W，COPi=${room.cop}`),
                "",
            ]
            : []), "说明：该结果用于预约阶段和调度库房预选参考，不替代入库后正式核算。");
        return lines.join("\n");
    }
    const lots = calculation.lots;
    const totals = calculation.totals;
    lines.push(`果品中心温度：${calculation.centerTempC}℃`, `库房当前温度：${calculation.roomTempC}℃`, `ΔT（中心温度-库房温度）：${calculation.centerTempC !== null && calculation.roomTempC !== null
        ? round(calculation.centerTempC - calculation.roomTempC, 2)
        : "-"} K`, `入库单据：${lots.length} 个到货批次`, "");
    lots.forEach((lot, index) => {
        lines.push(`${index + 1}. ${lot.sourceDocId}（关联预约 ${lot.appointmentId || "-"}，库房 ${lot.roomCode}）`, `   果品/吨位：${lot.fruit} / ${lot.tonnage} t`, `   中心温度/库房温度/ΔT：${lot.centerTempC}℃ / ${lot.roomTempC}℃ / ${lot.deltaTK} K`, `   果品比热 c：${lot.specificHeatKjPerKgK} kJ/(kg·K)`, `   Q2 = m·c·ΔT：${lot.q2Kj} kJ，按预冷时长 ${lot.precoolParameters.durationHours} h 折算平均热负荷 ${lot.q2W} W`, `   本批次 COP = ${lot.cop}`, `   冷负荷（含呼吸/辅助）：${lot.coldLoadW} W`, `   预冷参数：目标 ${lot.precoolParameters.targetTempC}℃（${lot.precoolParameters.targetTempZone}），时长 ${lot.precoolParameters.durationHours} h，静压差 ${lot.precoolParameters.staticPressurePa} Pa，送风温差 ${lot.precoolParameters.supplyAirDeltaTC}℃，风速 ${lot.precoolParameters.airVelocityMs} m/s`, `   碳排放：${lot.carbonEmissionKgCO2e} kgCO2e`, "");
    });
    lines.push("──────── 合计 ────────", `Q2 折算平均热负荷合计：${totals.q2W} W`, `机组功率：${totals.powerW} W`, `【正式核算值】COP = ${totals.cop}`, `PLC COP：${totals.plcCop}`, `冷负荷合计：${totals.coldLoadW} W`, `碳排放合计：${totals.carbonEmissionKgCO2e} kgCO2e`, "", ...(calculation.copScope === "single"
        ? [
            "单库房COP（分摊等效COP）：",
            `目标库房：${calculation.roomCode}`,
            ...calculation.rooms.map((room) => `  ${room.roomCode}: Qi=${room.qW} W，负荷占比 ${room.loadSharePct}%，分摊功率 Wi=${room.allocatedPowerW} W，COPi=${room.cop}`),
            "",
            "说明：单库房COP先按 Q总 分摊机组总功率得到 Wi，再用该库房 Qi/Wi 计算分摊等效COPi。",
        ]
        : [
            "整机组COP：",
            `Q总=${totals.q2W} W，W总=${totals.powerW} W，COP=Q总/W总=${totals.cop}`,
            "",
            "说明：整机组COP直接使用机组当前全部库房热负荷合计除以机组总功率。",
        ]), "正式核算使用果品中心温度、PLC库房当前温度、果品比热和PLC电功率；PLC定时采样与存储在后台同步运行。");
    return lines.join("\n");
}
function handleCopCalculation(state) {
    const count = state.ledgerDocuments.length;
    logAgent("xiaoke", `收到master下发的入库单数据 ${count} 条，开始正式COP核算，请稍候……`);
    const centerTempC = toNumber(state.taskData?.centerTempC);
    if (centerTempC === null || centerTempC < -5 || centerTempC > 45) {
        logAgent("xiaoke", "缺少有效的果品中心温度，请用户先测量并录入果品中心温度后再发起正式核算");
        return {
            phase: "cop_report_result",
            routeTo: "master",
            nextAgent: "",
            reportPayload: {
                skipped: true,
                message: "缺少有效的果品中心温度，未进行正式COP核算。请先测量果品中心温度并重新发起菜单4请求。",
            },
            error: "缺少果品中心温度",
            executedAgent: "xiaoke",
        };
    }
    const plc = state.copPlcSnapshot ??
        (state.copRecords ?? []).at(-1);
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
    logAgent("xiaoke", `正式核算完成：到货批次 ${calculation.lots.length} 个，` +
        `果品中心温度 ${centerTempC}℃，库房温度 ${calculation.roomTempC}℃，Q2 折算热负荷 ${calculation.totals.q2W}W，` +
        `【正式核算值】COP=${calculation.cop}`);
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
async function handleEstimateRequest(state) {
    const appointmentId = String(state.taskData?.appointmentId ?? "").trim();
    logAgent("xiaoke", "收到master转达的预约单数据，开始预约阶段COP预估，正在向PLC调取实时功率，请稍候……");
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
    const copRecords = [...(state.copRecords ?? []), snapshot].slice(-MAX_COP_SAMPLES);
    const calculation = calculateEstimateCopCalculation(state, snapshot);
    if (!calculation) {
        logAgent("xiaoke", "预约单不存在、果品/吨位无效或缺少PLC功率，无法进行预约阶段预估");
        return {
            phase: "cop_report_result",
            routeTo: "master",
            nextAgent: "",
            reportPayload: {
                skipped: true,
                message: "无法完成预约阶段COP预估：预约单不存在或果品/吨位/PLC功率无效。",
            },
            executedAgent: "xiaoke",
        };
    }
    logAgent("xiaoke", `预约预估完成：${calculation.scopeLabel}，Q1=${calculation.qValue}W，` +
        `Q总=${calculation.totals.qTotalW ?? calculation.qValue}W，` +
        `【预约预估值】COP=${calculation.cop}，正在提交质检员审核`);
    return {
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
async function handleCopReportAfterReview(state) {
    const calculation = state.copCalculation;
    if (!state.reviewPass || !calculation) {
        const reason = String(state.reviewReason ?? "").trim() ||
            state.error ||
            "质检员未通过本次COP核算结果";
        const retryCount = Number(state.copRetryCount ?? 0);
        const mode = (state.copReportMode ||
            calculation?.mode ||
            "formal");
        if (retryCount < 3) {
            const nextRetry = retryCount + 1;
            logAgent("xiaoke", `COP核算结果质检未通过（${reason}），准备第 ${nextRetry}/3 轮重试：重新调取PLC并重算`);
            const plcOutcome = await fetchFreshPlcForCop("xiaoke-cop-report-retry-plc");
            if (!plcOutcome.ok) {
                logAgent("xiaoke", `COP重试PLC取数失败：${plcOutcome.failureMessage}`);
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
            const copRecords = [...(state.copRecords ?? []), snapshot].slice(-MAX_COP_SAMPLES);
            const nextCalculation = mode === "estimate"
                ? calculateEstimateCopCalculation(state, snapshot)
                : calculateFormalCopCalculation(state, snapshot);
            if (!nextCalculation) {
                return {
                    phase: "cop_report_result",
                    routeTo: "master",
                    nextAgent: "",
                    reportPayload: {
                        skipped: true,
                        mode,
                        retryCount,
                        message: "COP重试时缺少有效核算数据，未继续质检。",
                    },
                    executedAgent: "xiaoke",
                };
            }
            logAgent("xiaoke", `第 ${nextRetry}/3 轮重算完成，COP=${nextCalculation.cop}，重新提交质检`);
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
        logAgent("xiaoke", `COP核算结果重试3轮后仍未通过质检，终止本次核算，不生成报告；最后原因：${reason}`);
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
        "formal");
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
export async function xiaokeNode(state) {
    if (state.phase === "plc_poll") {
        return handlePlcPoll(state);
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
