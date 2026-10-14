/** レンズ（地図を何で塗るか）の1つの値から、地図と`LensControl`へ渡すものを導く。
 *
 * 全道路の塗りもルート線の色分けも同じ`lens`から導き、軸の種類ごとの
 * 分岐は持たない——軸を公開すれば、ここへ何も足さずに選択肢と塗り分けへ現れる。
 */
import type { DedicatedWayValueAxis } from "@/lib/mapDisplay/axisLayers";
import {
  NO_DATA_LEGEND_BAND,
  UNDETERMINED_LEGEND_BAND,
  type MapColorLegendBand,
} from "@/lib/mapDisplay/mapColorLegend";
import { valueBands } from "@/lib/mapDisplay/valueScale";
import type { LegendEntry } from "@/lib/mapDisplay/legendFilter";
import {
  LENS_DIFFICULTY_ID,
  LENS_NEUTRAL_COLOR,
  type LensId,
  type RouteStyleMode,
} from "@/lib/mapDisplay/routeStyleModes";
import type { LensOption } from "@/features/map/LensControl/LensControl";
import type { CatalogAxis } from "@/lib/catalogAxis";
import { cardinalLabel } from "@/lib/cardinalLabel";

/** 全道路を塗っている軸。ルート確定後は、周囲も塗り続ける設定の間だけ塗る。 */
export function paintedAxisId(lens: LensId, hasDetail: boolean, keepAfterRoute: boolean): LensId | null {
  return !hasDetail || keepAfterRoute ? lens : null;
}

/** 周りの道の色が拠る走る条件の文（例:「北へ走る・時速20km・19:30出発」）。塗っている軸が使う条件だけを、軸カタログの
 * 宣言から並べる。塗っている軸が条件を使わなければnull——画面に出ていない条件で、同じ道の色が変わって見えないように出す。 */
export function lensConditionsLabel(
  paintedAxis: LensId | null,
  dedicatedAxes: readonly DedicatedWayValueAxis[],
  ride: { bearingDeg: number; speedKmh: number },
  departureLabel: string,
): string | null {
  const axis = dedicatedAxes.find((candidate) => candidate.axisId === paintedAxis);
  if (axis === undefined) return null;
  const parts = [
    axis.wayValueConditions.includes("bearing_deg") ? `${cardinalLabel(ride.bearingDeg)}へ走る` : null,
    axis.wayValueConditions.includes("speed_kmh") ? `時速${ride.speedKmh}km` : null,
    axis.wayValueConditions.includes("at") ? `${departureLabel}出発` : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join("・") : null;
}

/** 時間帯の印ごとの、周りの道の色の前提。周りの道は通過する時刻を持たないので、時間帯で効く軸は前提を書き添える。 */
const TIME_SCOPE_PREMISE: Record<CatalogAxis["timeScope"], string | null> = {
  always: null,
  night_only:
    "周りの道は通過する時刻を置かずに塗っています。この評価は夜に通る区間でだけ効き、ルートを作ると区間ごとに決まります。",
};

/** 凡例に書く、周りの道の色の前提（走る条件・時間帯）。どの入力に依るかは軸カタログの宣言（走る条件の文・時間帯の印）
 * から決め、軸idで分けない。前提の無い軸は空。 */
export function lensPremises(
  paintedAxis: LensId | null,
  axes: readonly CatalogAxis[],
  conditions: string | null,
): string[] {
  const timeScope = axes.find((axis) => axis.axisId === paintedAxis)?.timeScope ?? "always";
  return [
    conditions !== null ? `周りの道は「${conditions}」の条件で塗っています。` : null,
    TIME_SCOPE_PREMISE[timeScope],
  ].filter((premise) => premise !== null);
}

/** レンズの凡例。地図がいま塗っているものの凡例だけを出す——塗っていない間に出すと、
 * 地図のどこにも無い色見本の表になる。ルート確定後はルート線のモードの凡例。密度の軸はルートの前に線を塗らない。 */
export function lensLegend(
  lens: LensId,
  hasDetail: boolean,
  catalog: {
    routeStyleModes: readonly RouteStyleMode[];
    dedicatedAxes: readonly DedicatedWayValueAxis[];
  },
): readonly LegendEntry[] {
  if (hasDetail) return catalog.routeStyleModes.find((mode) => mode.id === lens)?.legend ?? [];
  const axis = catalog.dedicatedAxes.find((candidate) => candidate.axisId === lens);
  return axis !== undefined && axis.densityTerms === null ? dedicatedWayValueLegend(axis) : [];
}

/** レンズの選択肢（公開軸、カタログの並び順）。「なし」「総合難易度」は`LensControl`が足す。
 *
 * 「未使用」は`weights`（生成後は生成に使われた重み、生成前は今の設定の重み）が0の軸——重みタブが
 * 薄く出す軸と同じで、重みを変えずに生成すれば前後で並びが変わらない。 */
export function lensOptions(
  axes: readonly CatalogAxis[],
  weights: Readonly<Record<string, number>>,
  axisColors: Readonly<Record<string, string>>,
): LensOption[] {
  return axes.map((axis) => ({
    id: axis.axisId,
    label: axis.label,
    color: axisColors[axis.axisId] ?? LENS_NEUTRAL_COLOR,
    unused: (weights[axis.axisId] ?? 0) <= 0,
    routeOnly: false,
  }));
}

/** 地図上の色分け凡例。地図の線と同じ配色・しきい値から段階ラベル付きの凡例を組み立てる。
 * 段階ラベル（bandLabels）は要素数が段階数と一致する間だけ数値レンジの前に添える
 * （不一致な保存データへの防御）。末尾の「データなし」は値を受け取れなかった道路の受け皿で、
 * ルート確定後のルート線の凡例（`routeStyleModes.ts`）と段階の並び・キーを揃える。
 * 「向きで決まらない」は、配信がその道を返しうる軸だけに足す（ルートの線は実際に走る向きで決まるので持たない）。 */
function dedicatedWayValueLegend(axis: DedicatedWayValueAxis): MapColorLegendBand[] {
  const bands = valueBands(axis.display).map(({ key, label, color }) => ({ key, label, color }));
  return [...bands, ...(axis.undeterminedByBearing ? [UNDETERMINED_LEGEND_BAND] : []), NO_DATA_LEGEND_BAND];
}

// 既定のレンズは総合難易度（軸の公開状態に依存せず常に存在するモード）。
export const DEFAULT_ROUTE_STYLE_MODE_ID: LensId = LENS_DIFFICULTY_ID;

export function isRouteStyleModeId(
  modes: readonly RouteStyleMode[],
  value: string | null | undefined,
): value is LensId {
  return modes.some((mode) => mode.id === value);
}
