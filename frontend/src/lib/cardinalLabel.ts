/** 角度を方位の呼び名へ（と、風向を矢印の向きへ）。**画面部品ではなくここに置く**（描くものの持ち物ではない）。
 *
 * 呼び名の並びは源泉が配り（`domain/geo.py: COMPASS_LABELS`）、区分の幅はその数から決まる。
 * 丸め方だけが画面側にあり、区分の境界を含む角度でbackendと同じ呼び名になることは、backendが出す
 * 表（生成物`geo-expectations.json`）をテストが通して確かめる。
 */
import { mapDisplay } from "@/types/generated/mapDisplay";

const CARDINAL_LABELS = mapDisplay.compassLabels;

/** 角度を0以上360未満へ畳む。 */
export function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** 角度を`stepDeg`刻みの最も近い角度（0以上360未満）へ丸める。 */
export function snapDeg(deg: number, stepDeg: number): number {
  return normalizeDeg(Math.round(deg / stepDeg) * stepDeg);
}

/** 気象の風向（風が吹いてくる向き）を、風が吹いていく向き（矢印の向き。北=0・時計回り）へ。 */
export function downwindDeg(windFromDeg: number): number {
  return normalizeDeg(windFromDeg + 180);
}

/** 気象の風向を、`mapBearingDeg`（地図の上が真北から時計回りに何度か）だけ回った地図の上で風が吹いていく向き
 * （画面の上=0・時計回り）へ。画面に置く風の矢印（走りの帯・天気欄）はこの基準で向ける。 */
export function downwindOnMapDeg(windFromDeg: number, mapBearingDeg: number): number {
  return normalizeDeg(downwindDeg(windFromDeg) - mapBearingDeg);
}

/** 角度を、北を中心にした`count`等分の区分の番号（0〜count-1）へ丸める。境界は上の区分へ倒す。 */
export function bearingSector(bearingDeg: number, count: number): number {
  return Math.round(normalizeDeg(bearingDeg) / (360 / count)) % count;
}

export function cardinalLabel(bearingDeg: number): string {
  return CARDINAL_LABELS[bearingSector(bearingDeg, CARDINAL_LABELS.length)];
}
