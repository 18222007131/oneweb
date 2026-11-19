/**
 * 果品热物性查表模块（占位参考值，可替换为精准实验/手册数据）。
 *
 * 数据来源说明：
 * - USDA Handbook 66（The Commercial Storage of Fruits, Vegetables, and Florist
 *   and Nursery Stocks）及冷库/食品冷冻冷藏相关手册附表。
 * - 当前内置杨梅、柚子、苹果，q_resp 采用 W/t 表值，运行时按温度线性插值，
 *   再换算为 W/kg 参与 Q1/Q2 计算。
 * - c 按冻结点选择“高于冰点/低于冰点”档位，档内近似定值，不做温度插值。
 *
 * 注意：数值为参考占位值，用于流程调试；替换表值时保持接口不变即可。
 */

export const THERMAL_DATA_SOURCE =
  "USDA Handbook 66 / 冷库与食品冷冻冷藏手册附表（参考占位值，可替换）";

export interface RespirationPoint {
  tempC: number;
  /** 单位质量呼吸热，W/t（运行时 /1000 换算为 W/kg） */
  qRespWPerTon: number;
}

export interface FruitThermalProperty {
  fruit: string;
  freezingPointC: number;
  /** 高于冰点档位，kJ/(kg·K) */
  specificHeatAboveFreezingKjPerKgK: number;
  /** 低于冰点档位，kJ/(kg·K) */
  specificHeatBelowFreezingKjPerKgK: number;
  respirationTable: RespirationPoint[];
  source: string;
}

export const THERMAL_PROPERTIES: Record<string, FruitThermalProperty> = {
  杨梅: {
    fruit: "杨梅",
    freezingPointC: -0.8,
    specificHeatAboveFreezingKjPerKgK: 3.8,
    specificHeatBelowFreezingKjPerKgK: 1.9,
    source: THERMAL_DATA_SOURCE,
    respirationTable: [
      { tempC: -5, qRespWPerTon: 18 },
      { tempC: 0, qRespWPerTon: 28 },
      { tempC: 5, qRespWPerTon: 42 },
      { tempC: 10, qRespWPerTon: 63 },
      { tempC: 15, qRespWPerTon: 95 },
      { tempC: 20, qRespWPerTon: 140 },
      { tempC: 25, qRespWPerTon: 205 },
      { tempC: 30, qRespWPerTon: 300 },
      { tempC: 35, qRespWPerTon: 440 },
      { tempC: 40, qRespWPerTon: 650 },
      { tempC: 45, qRespWPerTon: 950 },
    ],
  },
  柚子: {
    fruit: "柚子",
    freezingPointC: -1.0,
    specificHeatAboveFreezingKjPerKgK: 3.7,
    specificHeatBelowFreezingKjPerKgK: 1.85,
    source: THERMAL_DATA_SOURCE,
    respirationTable: [
      { tempC: -5, qRespWPerTon: 8 },
      { tempC: 0, qRespWPerTon: 12 },
      { tempC: 5, qRespWPerTon: 17 },
      { tempC: 10, qRespWPerTon: 25 },
      { tempC: 15, qRespWPerTon: 36 },
      { tempC: 20, qRespWPerTon: 52 },
      { tempC: 25, qRespWPerTon: 75 },
      { tempC: 30, qRespWPerTon: 108 },
      { tempC: 35, qRespWPerTon: 155 },
      { tempC: 40, qRespWPerTon: 225 },
      { tempC: 45, qRespWPerTon: 320 },
    ],
  },
  苹果: {
    fruit: "苹果",
    freezingPointC: -1.5,
    specificHeatAboveFreezingKjPerKgK: 3.6,
    specificHeatBelowFreezingKjPerKgK: 1.8,
    source: THERMAL_DATA_SOURCE,
    respirationTable: [
      { tempC: -5, qRespWPerTon: 5 },
      { tempC: 0, qRespWPerTon: 8 },
      { tempC: 5, qRespWPerTon: 13 },
      { tempC: 10, qRespWPerTon: 19 },
      { tempC: 15, qRespWPerTon: 28 },
      { tempC: 20, qRespWPerTon: 41 },
      { tempC: 25, qRespWPerTon: 60 },
      { tempC: 30, qRespWPerTon: 88 },
      { tempC: 35, qRespWPerTon: 130 },
      { tempC: 40, qRespWPerTon: 190 },
      { tempC: 45, qRespWPerTon: 275 },
    ],
  },
};

export interface ThermalLookup {
  fruit: string;
  temperatureC: number;
  /** 线性插值后的单位质量呼吸热，W/t */
  qRespWPerTon: number;
  /** 单位换算后的单位质量呼吸热，W/kg */
  qRespWPerKg: number;
  /** 按冻结点档位选定的比热，kJ/(kg·K) */
  specificHeatKjPerKgK: number;
  phase: "above_freezing" | "below_freezing";
  freezingPointC: number;
  source: string;
  method: string;
}

export class ThermalLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThermalLookupError";
  }
}

function interpolateRespiration(
  points: RespirationPoint[],
  temperatureC: number,
): number | null {
  if (!Number.isFinite(temperatureC)) return null;
  if (points.length === 0) return null;
  const sorted = [...points].sort((a, b) => a.tempC - b.tempC);
  if (temperatureC < sorted[0].tempC || temperatureC > sorted[sorted.length - 1].tempC) {
    return null;
  }
  for (let index = 0; index < sorted.length; index += 1) {
    const point = sorted[index];
    if (Math.abs(point.tempC - temperatureC) < 1e-9) {
      return point.qRespWPerTon;
    }
    const next = sorted[index + 1];
    if (next && temperatureC > point.tempC && temperatureC < next.tempC) {
      const ratio = (temperatureC - point.tempC) / (next.tempC - point.tempC);
      return (
        point.qRespWPerTon +
        (next.qRespWPerTon - point.qRespWPerTon) * ratio
      );
    }
  }
  return null;
}

export function lookupThermal(
  fruit: string,
  temperatureC: number,
): ThermalLookup {
  const property = THERMAL_PROPERTIES[fruit];
  if (!property) {
    throw new ThermalLookupError(
      `热物性表缺少果品「${fruit || "空"}」，无法计算热负荷。`,
    );
  }
  if (!Number.isFinite(temperatureC)) {
    throw new ThermalLookupError(
      `果品 ${fruit} 的热物性查表温度无效，无法计算热负荷。`,
    );
  }
  const qRespWPerTon = interpolateRespiration(
    property.respirationTable,
    temperatureC,
  );
  if (qRespWPerTon === null) {
    throw new ThermalLookupError(
      `果品 ${fruit} 在 ${temperatureC}℃ 超出 q_resp 查表范围（${
        property.respirationTable[0].tempC
      }~${property.respirationTable[property.respirationTable.length - 1].tempC}℃），无法计算。`,
    );
  }
  const aboveFreezing = temperatureC >= property.freezingPointC;
  const specificHeatKjPerKgK = aboveFreezing
    ? property.specificHeatAboveFreezingKjPerKgK
    : property.specificHeatBelowFreezingKjPerKgK;
  return {
    fruit,
    temperatureC,
    qRespWPerTon,
    qRespWPerKg: qRespWPerTon / 1000,
    specificHeatKjPerKgK,
    phase: aboveFreezing ? "above_freezing" : "below_freezing",
    freezingPointC: property.freezingPointC,
    source: property.source,
    method: aboveFreezing
      ? `q_resp 在 ${temperatureC}℃ 线性插值，W/t÷1000→W/kg；c 取高于冰点档 ${specificHeatKjPerKgK} kJ/(kg·K)（冻结点 ${property.freezingPointC}℃）`
      : `q_resp 在 ${temperatureC}℃ 线性插值，W/t÷1000→W/kg；c 取低于冰点档 ${specificHeatKjPerKgK} kJ/(kg·K)（冻结点 ${property.freezingPointC}℃）`,
  };
}

export function getThermalSource(fruit: string): string {
  return THERMAL_PROPERTIES[fruit]?.source ?? THERMAL_DATA_SOURCE;
}

export function describeThermalLookup(lookup: ThermalLookup): string {
  return (
    `${lookup.fruit} @ ${lookup.temperatureC}℃：` +
    `q_resp=${lookup.qRespWPerTon} W/t（${lookup.qRespWPerKg} W/kg，线性插值）；` +
    `c=${lookup.specificHeatKjPerKgK} kJ/(kg·K)（${
      lookup.phase === "above_freezing" ? "高于" : "低于"
    }冰点 ${lookup.freezingPointC}℃档）；来源：${lookup.source}`
  );
}
