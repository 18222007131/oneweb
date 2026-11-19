import { COP_MAX, COP_MIN } from "./state";
const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;
const LONG_TERM_WINDOW_MINUTES = (() => {
    const value = Number(process.env.PLC_LONG_TERM_WINDOW_MINUTES ?? 120);
    return Number.isFinite(value) && value > 0 ? value : 120;
})();
const LONG_TERM_MIN_SAMPLES = (() => {
    const value = Number(process.env.PLC_LONG_TERM_MIN_SAMPLES ?? 24);
    return Number.isFinite(value) && value >= 2 ? Math.floor(value) : 24;
})();
const LONG_TERM_WINDOW_MS = LONG_TERM_WINDOW_MINUTES * 60 * 1000;
function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}
export function parsePlcTimestamp(value) {
    const text = String(value ?? "").trim().replace(" ", "T");
    if (!text)
        return null;
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
}
function formatTime(date) {
    const pad = (part) => String(part).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function sampleCop(sample) {
    const value = finite(sample?.cop);
    return value === null || value <= 0 ? null : value;
}
/**
 * 计算截至 referenceTime 的 5 天历史统计。
 * excludeTimestamp 用于排除本次正在审核的 PLC 样本。
 */
export function computeHistoryStats(samples, referenceTime = new Date(), excludeTimestamp = "") {
    const windowEndMs = referenceTime.getTime();
    const windowStartMs = windowEndMs - FIVE_DAYS_MS;
    const values = [];
    for (const sample of samples ?? []) {
        if (excludeTimestamp && sample.timestamp === excludeTimestamp)
            continue;
        const timestamp = parsePlcTimestamp(sample.timestamp);
        if (!timestamp)
            continue;
        const time = timestamp.getTime();
        if (time < windowStartMs || time > windowEndMs)
            continue;
        const cop = sampleCop(sample);
        if (cop !== null)
            values.push(cop);
    }
    if (values.length === 0) {
        return {
            available: false,
            count: 0,
            mean: null,
            stdDev: null,
            windowStart: formatTime(new Date(windowStartMs)),
            windowEnd: formatTime(new Date(windowEndMs)),
        };
    }
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    return {
        available: true,
        count: values.length,
        mean: Math.round(mean * 10000) / 10000,
        stdDev: Math.round(Math.sqrt(variance) * 10000) / 10000,
        windowStart: formatTime(new Date(windowStartMs)),
        windowEnd: formatTime(new Date(windowEndMs)),
    };
}
export function evaluateCopAgainstHistory(input) {
    const bounds = input.bounds ??
        (input.mode === "formal"
            ? { min: COP_MIN, max: COP_MAX }
            : { min: 0.01, max: 10 });
    const reasons = [];
    const cop = finite(input.cop);
    let outlier = false;
    let outOfBounds = false;
    let deviationPct = null;
    if (cop === null || cop <= 0) {
        outlier = true;
        reasons.push("COP不是有效的正数，判定为异常值。");
    }
    else {
        outOfBounds = cop < bounds.min || cop > bounds.max;
        if (outOfBounds) {
            reasons.push(`COP=${cop} 超出预设边界 ${bounds.min}~${bounds.max}。`);
        }
        if (input.history.available && input.history.mean !== null) {
            deviationPct =
                Math.abs(cop - input.history.mean) / input.history.mean * 100;
            if (deviationPct > 5) {
                reasons.push(`COP相对5天历史均值 ${input.history.mean} 偏离 ${deviationPct.toFixed(2)}%，超过5%。`);
            }
            if (input.history.count >= 5 && input.history.stdDev !== null) {
                if (input.history.stdDev > 0) {
                    const zScore = Math.abs(cop - input.history.mean) / input.history.stdDev;
                    if (zScore > 3) {
                        outlier = true;
                        reasons.push(`COP相对历史样本偏离超过3个标准差（z=${zScore.toFixed(2)}），判定为异常值。`);
                    }
                }
                else if (deviationPct > 5) {
                    outlier = true;
                    reasons.push("COP相对稳定的历史均值发生明显偏离，判定为异常值。");
                }
            }
        }
    }
    return {
        passed: reasons.length === 0,
        outlier,
        outOfBounds,
        deviationPct,
        historyMean: input.history.mean,
        historyCount: input.history.count,
        historyAvailable: input.history.available,
        reasons,
    };
}
function inRange(value, min, max) {
    const number = finite(value);
    return number !== null && number >= min && number <= max;
}
function isBaselineNormalSample(sample) {
    return (inRange(sample.powerW, 50, 200000) &&
        inRange(sample.supplyTempC, -30, 20) &&
        inRange(sample.returnTempC, -30, 30) &&
        inRange(sample.suctionPressureMPa, 0.05, 3) &&
        inRange(sample.dischargePressureMPa, 0.2, 5) &&
        (sample.roomTempC === undefined || inRange(sample.roomTempC, -30, 30)) &&
        inRange(sample.cop, COP_MIN, COP_MAX));
}
function isSampleAnomalous(sample, historyBefore) {
    const reasons = [];
    if (!inRange(sample.powerW, 50, 200000)) {
        reasons.push("机组功率越界");
    }
    if (!inRange(sample.supplyTempC, -30, 20)) {
        reasons.push("供温越界");
    }
    if (!inRange(sample.returnTempC, -30, 30)) {
        reasons.push("回温越界");
    }
    if (!inRange(sample.suctionPressureMPa, 0.05, 3)) {
        reasons.push("吸气压力越界");
    }
    if (!inRange(sample.dischargePressureMPa, 0.2, 5)) {
        reasons.push("排气压力越界");
    }
    if (sample.roomTempC !== undefined &&
        !inRange(sample.roomTempC, -30, 30)) {
        reasons.push("库房温度越界");
    }
    if (!inRange(sample.cop, COP_MIN, COP_MAX)) {
        reasons.push("COP越界");
    }
    const cop = sampleCop(sample);
    if (cop !== null &&
        historyBefore.available &&
        historyBefore.mean !== null &&
        Math.abs(cop - historyBefore.mean) / historyBefore.mean > 0.05) {
        reasons.push("COP偏离5天历史均值超过5%");
    }
    return {
        anomalous: reasons.length > 0,
        reason: reasons.join("、"),
    };
}
/**
 * 检测连续2小时（默认24个5分钟样本）持续异常。
 * 短时单点扰动会被一次正常采样打断，不会被判定为长期异常。
 * 手动解除设备异常后，只从解除时间之后重新累计。
 */
export function detectLongTermAnomaly(samples, now = new Date(), lastClearedEpochMs = 0) {
    const parsed = (samples ?? [])
        .map((sample) => ({
        sample,
        time: parsePlcTimestamp(sample.timestamp),
    }))
        .filter((entry) => Boolean(entry.time) &&
        entry.time.getTime() > lastClearedEpochMs &&
        entry.time.getTime() <= now.getTime() + 60_000)
        .sort((a, b) => a.time.getTime() - b.time.getTime());
    let currentRun = [];
    let reason = "";
    for (let index = 0; index < parsed.length; index += 1) {
        const entry = parsed[index];
        // 历史基准只使用绝对边界内的正常样本，避免连续异常自身污染基准，
        // 这样短时正常样本可以正确打断异常连续段。
        const priorNormal = parsed
            .slice(0, index)
            .filter((item) => isBaselineNormalSample(item.sample))
            .map((item) => item.sample);
        const historyBefore = computeHistoryStats(priorNormal, entry.time, entry.sample.timestamp);
        const check = isSampleAnomalous(entry.sample, historyBefore);
        if (check.anomalous) {
            currentRun.push(entry);
            reason = check.reason;
        }
        else {
            currentRun = [];
            reason = "";
        }
    }
    if (currentRun.length < LONG_TERM_MIN_SAMPLES) {
        return {
            abnormal: false,
            reason: "",
            windowStart: "",
            windowEnd: "",
            sampleCount: currentRun.length,
        };
    }
    const first = currentRun[0];
    const last = currentRun[currentRun.length - 1];
    if (last.time.getTime() - first.time.getTime() < LONG_TERM_WINDOW_MS) {
        return {
            abnormal: false,
            reason: "",
            windowStart: "",
            windowEnd: "",
            sampleCount: currentRun.length,
        };
    }
    return {
        abnormal: true,
        reason: `连续${LONG_TERM_WINDOW_MINUTES / 60}小时持续异常：${reason}`,
        windowStart: first.sample.timestamp,
        windowEnd: last.sample.timestamp,
        sampleCount: currentRun.length,
    };
}
