import { avoidanceLevelOf, readRoadAvoidance } from "@/features/route/roadAvoidance";
import { costPreferenceDescription, readCostPreference } from "@/features/route/costPreference";
import type { CostAxisCatalog } from "@/hooks/useCostAxisCatalog";
import type { ClientConfig } from "@/lib/clientConfig";
import { isCoordinates, readStoredList, withEntryFirst } from "@/lib/storedList";
import type { Coordinates, CostPreference, RoadAvoidanceOverride } from "@/types/route";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

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

/** 距離の入力として受け付ける値か。0より大きく上限以下の数なら、画面の刻みの近い方へ寄せて受け付ける（1km刻みだった頃の
 * 保存値も読める）。範囲が縮んだ後でも、範囲外の距離が復元されて送られない。 */
export function acceptedDistanceInput(raw: string): string | null {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > routeGenerateConfig.max_distance_km) return null;
  const snapped = Math.round(parsed / DISTANCE_STEP_KM) * DISTANCE_STEP_KM;
  return String(Math.min(Math.max(snapped, DISTANCE_STEP_KM), routeGenerateConfig.max_distance_km));
}

/** 候補数の入力として受け付ける値か。 */
export function acceptedMaxRoutesInput(raw: string): string | null {
  const parsed = Number(raw);
  return Number.isInteger(parsed) &&
    parsed >= routeGenerateConfig.min_routes &&
    parsed <= routeGenerateConfig.max_routes
    ? raw
    : null;
}

const coordinatesOrNull = (value: unknown) => (value === null || isCoordinates(value) ? value : undefined);

const isBoolean = (value: unknown) => (typeof value === "boolean" ? value : undefined);

// 保存した1件の項目ごとの読み方。今の画面が受け付けない値はundefinedを返し、その件を捨てる。キーは保存の形と同じ型の
// 写像なので、形に項目を足すと読み方が要る。前の形で保存した件は読み替えずに捨てる——ただしつまみと倍率は、読めなければ
// 件を捨てずに標準に戻す（割合の重みで保存した件も、場所と条件はそのまま呼び出せる）。消えた軸の倍率は送るときに外す。
const SAVED_FIELD_READERS: {
  [K in keyof SavedCondition]-?: (value: unknown) => SavedCondition[K] | undefined;
} = {
  name: (value) => (typeof value === "string" && value.trim() !== "" ? value : undefined),
  loop: isBoolean,
  distanceTargeted: isBoolean,
  distance: (value) => (typeof value === "string" ? (acceptedDistanceInput(value) ?? undefined) : undefined),
  maxRoutes: (value) => (typeof value === "string" ? (acceptedMaxRoutesInput(value) ?? undefined) : undefined),
  origin: coordinatesOrNull,
  waypoints: (value) =>
    Array.isArray(value) && value.length <= routeGenerateConfig.max_waypoints && value.every(isCoordinates)
      ? value
      : undefined,
  destination: coordinatesOrNull,
  costPreference: readCostPreference,
  roadAvoidance: (value) => (typeof value === "object" && value !== null ? readRoadAvoidance(value) : undefined),
};

// 1件を今の画面が受け付ける形で読む。読めない件はnull（ほかの件は残す）。
function readSavedCondition(value: unknown): SavedCondition | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;
  const read: Record<string, unknown> = {};
  for (const [key, readField] of Object.entries(SAVED_FIELD_READERS)) {
    const field = readField(entry[key]);
    if (field === undefined) return null;
    read[key] = field;
  }
  return read as unknown as SavedCondition;
}

/** 保存した生成の条件の一覧を読む。 */
export function readSavedConditions(raw: string): SavedCondition[] | null {
  return readStoredList(raw, readSavedCondition);
}

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
  /** 「通らない」を選んだ行と、なるべく避ける行の名前（いつも通らない固定の行は含めない）。 */
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

// 段ごとに「段の名前 行の名前・…」を、強い段から並べる。行と段は軸カタログが配るもので、届く前は「なし」になる。
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
