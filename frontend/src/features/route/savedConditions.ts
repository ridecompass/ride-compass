import { avoidanceLevelOf } from "@/lib/roadAvoidance";
import { costPreferenceDescription } from "@/features/route/costPreference";
import type { CostAxisCatalog } from "@/hooks/useCostAxisCatalog";
import type { ClientConfig } from "@/lib/clientConfig";
import type { Coordinates, CostPreference, RoadAvoidanceOverride } from "@/types/route";
import { withEntryFirst } from "@/lib/storedList";

/** 生成の条件（「ルート設定」の入力）。いまの条件・保存・呼び出しが同じこの形を使う。出発地は位置の持ち主が持つので含まず、
 * その日の走行条件（出発時刻・想定速度）と、生成した候補も持たない。 */
export interface GenerationConditionsSnapshot {
  /** 周回か（終点を出発地にする）。周回の間も`destination`は覚えておき、外すと戻す。 */
  loop: boolean;
  /** 全長の目標を決めるか。外している間も距離の入力は残す（入れ直すと前の値に戻る）。 */
  distanceTargeted: boolean;
  /** 距離の入力（文字列のまま。「ルート設定」が持つ形）。 */
  distance: string;
  /** 候補数の入力（同上）。 */
  maxRoutes: string;
  waypoints: Coordinates[];
  /** 置いた目的地（周回の間は覚えておくだけで使わない）。 */
  destination: Coordinates | null;
  /** 代償の全体に掛けるつまみと、費用の軸ごとの倍率。 */
  costPreference: CostPreference;
  /** 道の区分の行ごとに選んだ避け方（選んでいない行は無い）。 */
  roadAvoidance: RoadAvoidanceOverride;
}

/** 名前を付けて保存した生成の条件。 */
export interface SavedCondition extends GenerationConditionsSnapshot {
  name: string;
  /** 地図で置いた出発地。nullは「現在地から」で、呼び出したときの現在地から生成する。 */
  origin: Coordinates | null;
}

/** 距離の刻み（km）。backendは0より大きい距離を受け付けるが、画面は狙った値へ合わせやすいよう、この刻みで選ばせる。
 * 距離の入力の下限も1刻み分。 */
export const DISTANCE_STEP_KM = 5;

// 名前と説明が並べる、ルートの形。
function routeShape(conditions: GenerationConditionsSnapshot) {
  return {
    toDestination: !conditions.loop,
    distance: conditions.distanceTargeted ? `${conditions.distance}km` : null,
    waypointCount: conditions.waypoints.length,
  };
}

/** 名前の欄に最初から入れておく仮の名前。 */
export function suggestedConditionName(conditions: GenerationConditionsSnapshot): string {
  const { toDestination, distance, waypointCount } = routeShape(conditions);
  return [toDestination ? "目的地" : "周回", distance, waypointCount > 0 ? `経由${waypointCount}地点` : null]
    .filter((part) => part !== null)
    .join(" ");
}

/** 保存の前と一覧の行に並べる、何が保存されるかの説明（出発地は`originDescription`）。 */
interface ConditionsDescription {
  /** 周回か目的地か・全長の目標・経由地・候補数。 */
  route: string;
  /** つまみと、標準でない軸の倍率（全部標準なら「標準」）。 */
  costPreference: string;
  /** 「通る」以外を選んだ行の名前を段ごとに（いつも通らない固定の行は含めない）。 */
  exclusions: string;
}

function routeDescription(conditions: GenerationConditionsSnapshot): string {
  const { toDestination, distance, waypointCount } = routeShape(conditions);
  const head = toDestination ? "目的地へ" : "周回";
  return [
    distance === null ? head : `${head} ${distance}`,
    waypointCount > 0 ? `経由 ${waypointCount}地点` : null,
    `候補 ${conditions.maxRoutes}本`,
  ]
    .filter((part) => part !== null)
    .join("・");
}

// 段ごとに「段の名前 行の名前・…」を、倍率の大きい段から並べる。行と段は画面の設定が配るもので、届く前は「なし」になる。
function exclusionsDescription(roadAvoidance: RoadAvoidanceOverride, catalog: ClientConfig): string {
  const { levels, rows } = catalog.roadClasses.avoidance;
  const parts = levels.toReversed().flatMap(({ key: level, label: levelLabel }) => {
    const labels = rows
      .filter((row) => level !== "pass" && avoidanceLevelOf(row, roadAvoidance) === level)
      .map(({ label }) => label);
    return labels.length === 0 ? [] : [`${levelLabel} ${labels.join("・")}`];
  });
  return parts.length === 0 ? "なし" : parts.join("／");
}

export function describeConditions(
  conditions: GenerationConditionsSnapshot,
  catalog: ClientConfig,
  costCatalog: CostAxisCatalog,
): ConditionsDescription {
  return {
    route: routeDescription(conditions),
    costPreference: costPreferenceDescription(conditions.costPreference, costCatalog),
    exclusions: exclusionsDescription(conditions.roadAvoidance, catalog),
  };
}

/** 出発地の扱いの名前（`fixed`は保存した地点から作る）。 */
export function originDescription(fixed: boolean): string {
  return fixed ? "保存した地点に固定" : "呼び出した時の現在地";
}

/** 保存した一覧へ1件を入れる。同じ名前の件は上書きする。 */
export function withSavedCondition(list: SavedCondition[], entry: SavedCondition): SavedCondition[] {
  return withEntryFirst(list, entry, (saved) => saved.name === entry.name);
}
