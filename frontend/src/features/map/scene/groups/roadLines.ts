/** 道の線の層（軸カタログの`road_classes.map_layers`。分け方1つが層1つ）と、詳細を見ている1本の道の強調。
 *
 * 道の層の値（区分の鍵か「データなし」）はbackendが決め、地図は道ごとに feature-state で受け取って塗るだけにする——ルートの
 * 区間の帯と同じ値になる。**feature-state の値は MapLibre の絞り込みからも `line-dasharray` からも読めない**ため、凡例で隠した
 * 行は透明で落とし、データなしの道の破線は、破線だけの線を重ねて濃さで出し入れする。区分の外の道は値を持たないので、値を
 * 取っている間は、値の無い道をどれも取得中の色で描く（届いていない道と区分の外の道は、取り終えるまで見分けられない）。
 *
 * すべて**同じ路面タイルのソース**を共有する。評価軸の線も同じソースを読むため、
 * ソースの宣言は合成（`composeScene`）が1本へ畳む。
 *
 * **同じ道へ複数の線を重ねると後から描いた方が隠す**ので、出ている本数から対称に
 * 横へ割り付ける（1本なら中央）。線の太さは意味を運ばず、線種が運ぶのは値が無いこと（データなし）だけ
 * ——1本の線へ2つの分類を載せると、色の意味がもう一方のON/OFFで入れ替わる。
 */
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";
import regionTileConfig from "@/types/generated/region-tile-config.json";
import type { FilterSpecification } from "maplibre-gl";

import { sceneLayerId, sceneSourceId } from "@/features/map/scene/sceneBuilders";
import { LEGEND_NO_DATA_KEY } from "@/lib/mapDisplay/mapColorLegend";
import { ROAD_OTHER_KEY } from "@/lib/mapDisplay/roadTracks";
import type { RoadMapLayerView } from "@/types/route";

import { declareGroup, type SceneLayerEntry, type SceneSourceEntry } from "@/features/map/scene/mapSceneGroups";

const ROAD = mapDisplay.road;

export const ROAD_LINE_SOURCE_ID = sceneSourceId("road-tiles");
/** 押したときに拾う対象。道路の線はどれも共通の名前を名乗る。 */
export const ROAD_LINE_HIT_TARGET = "road";

/** `feature_key`は地物へ安定したidを与えるための昇格先（**この列でなければ feature-state が効かない**
 * ——タイルの地物はズームによって道1本にも区間にもなり、この列だけがその単位に追従する）。`way_id`は詳細の強調が
 * 突き合わせる列（道1本の単位）。列名はタイルを焼くbackendが配る。 */
const { feature_key: FEATURE_KEY_PROPERTY, way_id: WAY_ID_PROPERTY } = regionTileConfig.road_surface.properties;

export type RoadLineState = {
  /** 道の線の層。**軸カタログが届くまでは空**。 */
  readonly layers: readonly RoadMapLayerView[];
  /** タイルの配信先。**世代が届くまでは null**。 */
  readonly tiles: {
    readonly urls: readonly string[];
    readonly sourceLayer: string;
    readonly minZoom: number;
    readonly maxZoom: number;
  } | null;
  /** 層の鍵ごとの表示ON/OFF。 */
  readonly visible: Readonly<Record<string, boolean>>;
  /** 層の鍵ごとの、凡例で隠した行の鍵。 */
  readonly hiddenKeys: Readonly<Record<string, readonly string[]>>;
  /** 今の範囲の道ごとの層の値。 */
  readonly classes: RoadClassValues;
  /** 今の範囲の層の値を取っている最中か。 */
  readonly loading: boolean;
  /** 詳細を見ている道。開いていなければ null。 */
  readonly inspectedWayId: number | null;
};

/** 道ごとの層の値。feature_key → 層のid → 区分の鍵か「データなし」（区分の外の道の層は鍵ごと無い）。 */
export type RoadClassValues = ReadonlyMap<string, Readonly<Record<string, string>>>;

const NO_DATA_VALUE = ROAD.noDataValue;

/** 層の値の feature-state のキー。評価軸の線が同じソースへ載せる材料のキーと重ならないよう、前に印を付ける。 */
const stateKey = (layerId: string): string => `road:${layerId}`;

/** 道の層の値。値の届いていない道と区分の外の道は空文字。 */
function valueOf(layer: RoadMapLayerView): unknown {
  return ["to-string", ["feature-state", stateKey(layer.id)]];
}

/** 押した道の線（地図のレイヤーid）が、凡例で隠した行の道か。透明に描いた道も当たり判定には残るので、押す側がこれで飛ばす。 */
export function hiddenRoadLineAt(
  layerId: string,
  state: Readonly<Record<string, unknown>>,
  layers: readonly RoadMapLayerView[],
  hiddenKeys: Readonly<Record<string, readonly string[]>>,
): boolean {
  const layer = layers.find((candidate) => sceneLayerId(ROAD_LINE_SOURCE_ID, candidate.id) === layerId);
  if (layer === undefined) return false;
  const value = state[stateKey(layer.id)];
  const row = typeof value !== "string" ? ROAD_OTHER_KEY : value === NO_DATA_VALUE ? LEGEND_NO_DATA_KEY : value;
  return (hiddenKeys[layer.id] ?? []).includes(row);
}

/** 区分ごとの色。凡例で隠した行は透明。データなしの道は破線の線が描くので、実線は透明にする。取得中の色は「その他」を
 * 隠していても残す——消すと「まだ来ていない」と「隠した」が区別できなくなる。 */
function colorExpression(layer: RoadMapLayerView, hiddenKeys: readonly string[], loading: boolean): unknown {
  const shown = (key: string, color: string) => (hiddenKeys.includes(key) ? palette.semantic.hidden : color);
  const pairs = [
    ...layer.classes.flatMap((roadClass) => [roadClass.key, shown(roadClass.key, roadClass.color)]),
    ...(layer.has_no_data ? [NO_DATA_VALUE, palette.semantic.hidden] : []),
  ];
  const other = loading ? palette.semantic.loading : shown(ROAD_OTHER_KEY, palette.semantic.no_data);
  return pairs.length === 0 ? other : ["match", valueOf(layer), ...pairs, other];
}

/** 区分に入る道は濃く、それ以外（その他・データなし）は薄く（消さずに薄くする）。 */
function opacityExpression(layer: RoadMapLayerView): unknown {
  const keys = layer.classes.map((roadClass) => roadClass.key);
  return keys.length === 0
    ? ROAD.unknownOpacity
    : ["match", valueOf(layer), keys, ROAD.knownOpacity, ROAD.unknownOpacity];
}

const statesByValues = new WeakMap<RoadClassValues, Map<string, Map<string, string>>>();

/** 道ごとの層の値を、層ごとの feature-state へ移す。同じ値の結果からは同じ参照を返す——当てる側は参照が同じなら道ごとに
 * 比べ直さない。 */
function classStates(values: RoadClassValues): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const cached = statesByValues.get(values);
  if (cached !== undefined) return cached;
  const states = new Map<string, Map<string, string>>();
  for (const [featureKey, byLayer] of values) {
    for (const [layerId, value] of Object.entries(byLayer)) {
      let byFeature = states.get(stateKey(layerId));
      if (byFeature === undefined) states.set(stateKey(layerId), (byFeature = new Map()));
      byFeature.set(featureKey, value);
    }
  }
  statesByValues.set(values, states);
  return states;
}

/** 出ている本数から、対称に割り付けた横位置。1本なら0。 */
function offsetsFor(visibleCount: number): readonly number[] {
  return Array.from({ length: visibleCount }, (_, index) => (index - (visibleCount - 1) / 2) * ROAD.trackOffsetStepPx);
}

export const roadLineGroup = declareGroup<RoadLineState>((state) => {
  if (state.tiles === null) return { sources: [], layers: [] };
  const tiles = state.tiles;

  const sources: readonly SceneSourceEntry[] = [
    {
      id: ROAD_LINE_SOURCE_ID,
      spec: {
        type: "vector",
        minzoom: tiles.minZoom,
        maxzoom: tiles.maxZoom,
        promoteId: { [tiles.sourceLayer]: FEATURE_KEY_PROPERTY },
      },
      sourceLayer: tiles.sourceLayer,
      tiles: tiles.urls,
      featureStates: classStates(state.classes),
    },
  ];

  const shown = state.layers.filter((layer) => state.visible[layer.id] === true);
  const offsets = offsetsFor(shown.length);
  const offsetOf = new Map(shown.map((layer, index) => [layer.id, offsets[index] ?? 0]));

  const layers: SceneLayerEntry[] = state.layers.flatMap((layer) => {
    const hiddenKeys = state.hiddenKeys[layer.id] ?? [];
    const visible = state.visible[layer.id] === true;
    const line = {
      tier: "observedLine",
      source: ROAD_LINE_SOURCE_ID,
      sourceLayer: tiles.sourceLayer,
      type: "line",
    } as const;
    const offset = offsetOf.get(layer.id) ?? 0;
    return [
      {
        ...line,
        role: layer.id,
        paint: {
          "line-color": colorExpression(layer, hiddenKeys, state.loading),
          "line-width": ROAD.lineWidthPx,
          "line-opacity": opacityExpression(layer),
          "line-offset": offset,
        },
        visible,
        hitTargets: [ROAD_LINE_HIT_TARGET],
      },
      // データなしの道だけを、薄い破線で描く。
      {
        ...line,
        role: `${layer.id}-no-data`,
        paint: {
          "line-color": palette.semantic.no_data,
          "line-width": ROAD.lineWidthPx,
          "line-opacity": ["case", ["==", valueOf(layer), NO_DATA_VALUE], ROAD.unknownOpacity, 0],
          "line-dasharray": ["literal", [...mapDisplay.noDataDash]],
          "line-offset": offset,
        },
        visible: visible && layer.has_no_data && !hiddenKeys.includes(LEGEND_NO_DATA_KEY),
      },
    ];
  });

  layers.push({
    role: "inspected",
    tier: "observedLine",
    source: ROAD_LINE_SOURCE_ID,
    sourceLayer: tiles.sourceLayer,
    type: "line",
    paint: { "line-color": palette.semantic.inspected, "line-width": ROAD.inspectedWidthPx, "line-opacity": 1 },
    visible: state.inspectedWayId !== null,
    filter: ["==", ["get", WAY_ID_PROPERTY], state.inspectedWayId ?? -1] as unknown as FilterSpecification,
  });

  return { sources, layers };
});
