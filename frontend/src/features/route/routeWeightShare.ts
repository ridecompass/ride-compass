import { roundToDigits } from "@/lib/numberFormat";
import type { RoutePreferenceWeights } from "@/types/route";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

// 重み配分の調整量の刻みと、1軸が取りうる重みの下限。下限は0ではない——0まで下げると
// その軸は「チェックOFF」（weight>0が有効の判定基準）に化けるため、配分の調整操作で
// 軸の有効/無効を兼ねさせない。
export const WEIGHT_STEP = 0.01;
const MIN_AXIS_WEIGHT = WEIGHT_STEP;
// 境界を刻みの数へ直すときの浮動小数点の誤差の許し（0.29 / 0.01 = 28.999…を29と読む）。
const STEP_EPSILON = 1e-9;
/** 既定の重みが0の軸を入れたときの重み（backendの宣言）。 */
export const ENABLED_AXIS_WEIGHT = routeGenerateConfig.enabled_axis_weight;

function roundToStep(value: number): number {
  return roundToDigits(value, 2);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function totalWeight(weights: RoutePreferenceWeights): number {
  return Object.values(weights).reduce((sum, w) => sum + (w > 0 ? w : 0), 0);
}

/** 帯グラフの境界（隣り合う2軸の重み合計を変えずに一方から他方へ移す）ドラッグで、
 * 生の移動量（重み単位）を、両軸が下限MIN_AXIS_WEIGHT以上に収まるようクランプし、WEIGHT_STEP単位へ
 * 丸めた最終的な2軸ぶんの新しい重みを返す。
 * 丸めは範囲の内側の刻みへ寄せる（近い刻みへ丸めると下限をわずかに割る）。
 * 合計（weightA+weightB）は常に変わらない——丸め後もdeltaを共有するため浮動小数点誤差で
 * ずれない。 */
export function clampBoundaryDrag(
  weightA: number,
  weightB: number,
  rawDelta: number,
): { weightA: number; weightB: number } {
  const minSteps = Math.ceil((MIN_AXIS_WEIGHT - weightA) / WEIGHT_STEP - STEP_EPSILON);
  const maxSteps = Math.floor((weightB - MIN_AXIS_WEIGHT) / WEIGHT_STEP + STEP_EPSILON);
  const steps = clamp(Math.round(rawDelta / WEIGHT_STEP), minSteps, maxSteps);
  const steppedDelta = steps * WEIGHT_STEP;
  return {
    weightA: roundToStep(weightA + steppedDelta),
    weightB: roundToStep(weightB - steppedDelta),
  };
}
