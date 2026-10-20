// 動的気象レイヤー（時刻で中身が変わる格子・タイルのレイヤー）のデータ層。共通の契約（格子の共有・表現の種類・
// 時刻の1本のスライダー・データの差はデータ層で吸収）と、要素を足す手順は
// docs/modules/frontend/dynamic-weather-layers.mdが持つ。

import { mapDisplay } from "@/types/generated/mapDisplay";
import { nearestTimeIndex } from "@/lib/time";

interface DynamicWeatherSourceState {
  visible: boolean;
  payload: DynamicWeatherRenderPayload | undefined;
}

/** 動的気象のチップ（1つのチップが複数の名前付きソースを束ねる。どれがチップかは源泉が決める）。 */
export type DynamicWeatherLayerId = (typeof mapDisplay.weatherLayerGroups)[number];

/** 災害のチップのid（源泉の気象のグループの名前）。 */
export const DISASTER_LAYER_ID = "disaster" as const;

export type DisasterElement = Extract<(typeof mapDisplay.weatherElements)[number], { group: typeof DISASTER_LAYER_ID }>;

/** 災害のチップに載る要素。並びは源泉の宣言のまま。 */
export const DISASTER_ELEMENTS: readonly DisasterElement[] = mapDisplay.weatherElements.filter(
  (element): element is DisasterElement => element.group === DISASTER_LAYER_ID,
);

/** 配信元のタイルで描く描き方。それ以外の描き方は、中身をGeoJSONで持つ。 */
export type TileRenderKind = "rasterTile" | "vectorTile";

/** 配信元のタイルで描くコマの描画内容（ベクタの色分けに使うプロパティ名等は描き方の宣言が持つ）。 */
type TileRenderPayload = { kind: TileRenderKind; tileUrlTemplate: string };

/** 1コマの描画内容。表示層はkindだけで描き方を決める（どの配信元由来かはデータ層が吸収済み）。
 * GeoJSONの`outline`は配信元が配る領域の輪郭線で、属性は読まず線として描くだけ。 */
export type DynamicWeatherRenderPayload =
  TileRenderPayload | { kind: "gridFill" | "gridMark" | "outline"; geojson: GeoJSON.FeatureCollection };

/** 配信元のタイルで描く描き方か。 */
export function isTileRenderKind(kind: DynamicWeatherRenderPayload["kind"]): kind is TileRenderKind {
  return kind === "rasterTile" || kind === "vectorTile";
}

/** 配信元のタイルで描く描画内容か。 */
export function isTilePayload(payload: DynamicWeatherRenderPayload): payload is TileRenderPayload {
  return isTileRenderKind(payload.kind);
}

/** グループの中の名前付きソースのキー。ソースが1つのグループも1キーを持つ（特例を作らない）。 */
type DynamicWeatherSourceId = string;

/** 1グループぶんの状態。ソースキー→状態。 */
export type DynamicWeatherGroupState = Partial<Record<DynamicWeatherSourceId, DynamicWeatherSourceState>>;

// 範囲の判定の許容幅（目盛りがコマの時刻そのものの境界で、丸めに揺られないように）。
const FRAME_RANGE_EPSILON_MS = 1000;

/** 対象の時刻が今から`windowMs`先までの窓に入るか（コマの列を持たない単発の配信用）。 */
export function isWithinFutureWindow(target: Date, now: Date, windowMs: number): boolean {
  const diffMs = target.getTime() - now.getTime();
  return diffMs >= -FRAME_RANGE_EPSILON_MS && diffMs <= windowMs;
}

/** 時刻のコマ。`ref`はそのレイヤーのデータ層だけが読む参照（表示層は`time`しか見ない）。 */
export interface DynamicWeatherFrame<TRef = unknown> {
  time: Date;
  ref: TRef;
}

/** 対象の時刻に最も近いコマ。データの範囲の外ならnull（描かない——範囲外で最後のコマを出し続けない）。 */
export function frameIndexForTime(frames: readonly { time: Date }[], target: Date): number | null {
  if (frames.length === 0) return null;
  const targetMs = target.getTime();
  const firstMs = frames[0].time.getTime();
  const lastMs = frames[frames.length - 1].time.getTime();
  if (targetMs < firstMs - FRAME_RANGE_EPSILON_MS || targetMs > lastMs + FRAME_RANGE_EPSILON_MS) return null;
  return nearestTimeIndex(
    frames.map((f) => f.time),
    target,
  );
}

/** 観測だけが届くレイヤーのコマ。観測は必ず遅れて届くので、遅れのぶん（源泉が宣言する）は最新の観測を出し、
 * それより先を指していれば描かない（古い観測を先の時刻の値として出さない）。 */
export function observationIndexForTime(
  frames: readonly { time: Date }[],
  target: Date,
  toleranceMs: number,
): number | null {
  if (frames.length === 0) return null;
  const lastMs = frames[frames.length - 1].time.getTime();
  const targetMs = target.getTime();
  if (targetMs > lastMs + toleranceMs) return null;
  if (targetMs > lastMs) return frames.length - 1;
  return frameIndexForTime(frames, target);
}

/** 格子点のうち値が取れた点だけを地物にする（1点の欠けで全体を落とさない）。 */
export function gridToFeatureCollection<TPoint, TValue, TGeometry extends GeoJSON.Geometry, TProps>(
  grid: readonly TPoint[],
  extract: (point: TPoint) => TValue | null,
  buildFeature: (point: TPoint, value: TValue) => GeoJSON.Feature<TGeometry, TProps>,
): GeoJSON.FeatureCollection<TGeometry, TProps> {
  const features: GeoJSON.Feature<TGeometry, TProps>[] = [];
  for (const point of grid) {
    const value = extract(point);
    if (value == null) continue;
    features.push(buildFeature(point, value));
  }
  return { type: "FeatureCollection", features };
}

/** 格子点を中心に、緯度・経度の間隔の半分ずつ広げた升目（閉じたリング）。 */
export function gridCellRing(
  latitude: number,
  longitude: number,
  latitudeStepDeg: number,
  longitudeStepDeg: number,
): GeoJSON.Position[] {
  const halfLat = latitudeStepDeg / 2;
  const halfLon = longitudeStepDeg / 2;
  return [
    [longitude - halfLon, latitude - halfLat],
    [longitude + halfLon, latitude - halfLat],
    [longitude + halfLon, latitude + halfLat],
    [longitude - halfLon, latitude + halfLat],
    [longitude - halfLon, latitude - halfLat],
  ];
}

/** 描く中身が、配信元のタイルが返らなくなっているコマを指すか。`failures`は配信要素→失敗したコマのテンプレート
 * （`jmaTileProtocol.ts: jmaTileFailures`）。コマが進んで別のテンプレートを指せば当たらない。自前で取る表現は
 * フェッチ自身が状態を持つので対象外。 */
export function pointsAtFailedTiles(
  payload: DynamicWeatherRenderPayload | undefined,
  failures: ReadonlyMap<string, string>,
): boolean {
  if (payload === undefined || !isTilePayload(payload)) return false;
  return [...failures.values()].includes(payload.tileUrlTemplate);
}
