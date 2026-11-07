/** 道の線の層（画面の設定の`road_classes.map_layers`。分け方1つが層1つ）と、道路タブを地図で見ている間に道路タブの段を道に
 * 塗る線と、詳細を見ている道の強調。
 *
 * 道の層の値（区分の鍵か「データなし」）はbackendが決め、地図は道ごとに feature-state で受け取って塗るだけにする——ルートの
 * 区間の帯と同じ値になる。**feature-state の値は MapLibre の絞り込みからも `line-dasharray` からも読めない**ため、凡例で隠した
 * 行は透明で落とし、データなしの道の破線は、破線だけの線を重ねて濃さで出し入れする。区分の外の道は値を持たないので、値を
 * 取っている間は、値の無い道をどれも取得中の色で描く（届いていない道と区分の外の道は、取り終えるまで見分けられない）。
 *
 * 道の層の線は**同じ路面タイルのソース**を共有する。レンズの線も同じソースを読むため、
 * ソースの宣言は合成（`composeScene`）が1本へ畳む。道の線は押せない——道は押した所に近い道を backend に問うて開く
 * （`features/map/MapView/mapTaps.ts: bindMapTaps`）ので、道の層を出していなくても押せる。強調は、その答えの線の形を
 * 自分のソースで描き、道のタイルを読まない。
 *
 * **同じ道へ複数の線を重ねると後から描いた方が隠す**ので、出ている本数から対称に
 * 横へ割り付ける（1本なら中央）。線の太さは意味を運ばず、線種が運ぶのは値が無いこと（データなし）だけ
 * ——1本の線へ2つの分類を載せると、色の意味がもう一方のON/OFFで入れ替わる。
 */
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";
import regionTileConfig from "@/types/generated/region-tile-config.json";

import { featureStatesByName, sceneSourceId, zoomScaleExpression } from "@/features/map/scene/sceneBuilders";
import { LEGEND_NO_DATA_KEY } from "@/lib/mapDisplay/mapColorLegend";
import { ROAD_OTHER_KEY, roadTrackRowOf, type RoadTrackRow } from "@/lib/mapDisplay/roadTracks";
import { strongestAvoidance, type AvoidanceChoice, type AvoidanceLevel } from "@/lib/roadAvoidance";
import type { RoadMapLayerView } from "@/types/route";

import { declareGroup, type SceneLayerEntry, type SceneSourceEntry } from "@/features/map/scene/mapSceneGroups";

const ROAD = mapDisplay.road;

/** 道路タブの段を地図の道に塗る線の役割。 */
export const ROAD_AVOIDANCE_ROLE = "roadAvoidance";

/** 道路タブの段を道に塗る段と色。通るは塗らない（何も指定していない扱い）。 */
const ROAD_AVOIDANCE_COLORS: Readonly<Record<Exclude<AvoidanceLevel, "pass">, string>> = {
  prefer: palette.semantic.road_avoidance_prefer,
  avoid: palette.semantic.road_avoidance_avoid,
  exclude: palette.semantic.road_avoidance_exclude,
};

export const ROAD_LINE_SOURCE_ID = sceneSourceId("road-tiles");
const ROAD_INSPECTED_SOURCE_ID = sceneSourceId("road-inspected");

/** `feature_key`は地物へ安定したidを与えるための昇格先（**この列でなければ feature-state が効かない**
 * ——タイルの地物はズームによって道1本にも区間にもなり、この列だけがその単位に追従する）。列名はタイルを焼くbackendが配る。 */
const FEATURE_KEY_PROPERTY = regionTileConfig.road_surface.properties.feature_key;

export type RoadLineState = {
  /** 道の線の層。**画面の設定が届くまでは空**。 */
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
  /** 地図の道に塗る、道路タブの段。道路タブを地図で見ていなければ空。 */
  readonly avoidance: AvoidanceChoice;
  /** 詳細を見ている道の線の形（経度, 緯度）。開いていなければ null。 */
  readonly inspectedShape: readonly (readonly [number, number])[] | null;
};

/** 道ごとの層の値。feature_key → 層のid → 区分の鍵か「データなし」（区分の外の道の層は鍵ごと無い）。 */
export type RoadClassValues = ReadonlyMap<string, Readonly<Record<string, string>>>;

/** 道ごとの、当たる行の段のうち一番強いもの（`lib/roadAvoidance.ts: strongestAvoidance`）を載せる名前。層のidと重ならない
 * 綴りにする。 */
const AVOIDANCE_NAME = "<avoidance>";

const withAvoidanceByInput = new WeakMap<RoadClassValues, { choice: AvoidanceChoice; values: RoadClassValues }>();

/** 道ごとの層の値に、一番強い段（`AVOIDANCE_NAME`）を足したもの。同じ入力からは同じ参照を返す（feature-state を比べ直さない）。 */
function withStrongestAvoidance(classes: RoadClassValues, choice: AvoidanceChoice): RoadClassValues {
  const cached = withAvoidanceByInput.get(classes);
  if (cached?.choice === choice) return cached.values;
  const values = new Map(
    [...classes].map(([featureKey, byLayer]) => {
      const level = strongestAvoidance(byLayer, choice);
      return [featureKey, level === null ? byLayer : { ...byLayer, [AVOIDANCE_NAME]: level }] as const;
    }),
  );
  withAvoidanceByInput.set(classes, { choice, values });
  return values;
}

const NO_DATA_VALUE = ROAD.noDataValue;

/** 層の値の feature-state のキー。レンズの線が同じソースへ載せる材料のキーと重ならないよう、前に印を付ける。 */
const stateKey = (layerId: string): string => `road:${layerId}`;

/** 道の層`layerId`の値（`AVOIDANCE_NAME`は道ごとの一番強い段）。値の届いていない道と区分の外の道は空文字。 */
function valueOf(layerId: string): unknown {
  return ["to-string", ["feature-state", stateKey(layerId)]];
}

/** 道路タブの段を道に塗るか（塗る段があるか。道路タブを地図で見ていない間は段が空）。塗るときだけ下の地図を薄め、道の層の値を取る。 */
export function paintsRoadAvoidance(avoidance: AvoidanceChoice): boolean {
  return avoidance.levels.size > 0;
}

/** 道（`feature_key`）が、「表示」で出している道の層の先頭の層で入る凡例の行（地図の線の色と同じ値から引く）。道の層を
 * 出していなければ null。 */
export function shownRoadTrackOf(
  featureKey: string,
  layers: readonly RoadMapLayerView[],
  visible: Readonly<Record<string, boolean>>,
  classes: RoadClassValues,
): RoadTrackRow | null {
  const layer = layers.find((candidate) => visible[candidate.id] === true);
  return layer === undefined ? null : roadTrackRowOf(layer, classes.get(featureKey)?.[layer.id] ?? null);
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
  return pairs.length === 0 ? other : ["match", valueOf(layer.id), ...pairs, other];
}

/** 区分に入る道は濃く、それ以外（その他・データなし）は薄く（消さずに薄くする）。 */
function opacityExpression(layer: RoadMapLayerView): unknown {
  const keys = layer.classes.map((roadClass) => roadClass.key);
  return keys.length === 0
    ? ROAD.unknownOpacity
    : ["match", valueOf(layer.id), keys, ROAD.knownOpacity, ROAD.unknownOpacity];
}

/** 出ている本数から、対称に割り付けた横位置。1本なら0。 */
function offsetsFor(visibleCount: number): readonly number[] {
  return Array.from({ length: visibleCount }, (_, index) => (index - (visibleCount - 1) / 2) * ROAD.trackOffsetStepPx);
}

export const roadLineGroup = declareGroup<RoadLineState>((state) => {
  const inspectedSource: SceneSourceEntry = {
    id: ROAD_INSPECTED_SOURCE_ID,
    spec: { type: "geojson" },
    data: {
      type: "FeatureCollection",
      features:
        state.inspectedShape === null
          ? []
          : [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: state.inspectedShape } }],
    },
  };
  const inspected: SceneLayerEntry = {
    role: "inspected",
    tier: "observedLine",
    source: ROAD_INSPECTED_SOURCE_ID,
    type: "line",
    paint: { "line-color": palette.semantic.inspected, "line-width": ROAD.inspectedWidthPx, "line-opacity": 1 },
    visible: state.inspectedShape !== null,
  };
  if (state.tiles === null) return { sources: [inspectedSource], layers: [inspected] };
  const tiles = state.tiles;

  const sources: readonly SceneSourceEntry[] = [
    inspectedSource,
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
      featureStates: featureStatesByName(withStrongestAvoidance(state.classes, state.avoidance), stateKey),
    },
  ];

  const shown = state.layers.filter((layer) => state.visible[layer.id] === true);
  const offsets = offsetsFor(shown.length);
  const offsetOf = new Map(shown.map((layer, index) => [layer.id, offsets[index] ?? 0]));

  const line = {
    tier: "observedLine",
    source: ROAD_LINE_SOURCE_ID,
    sourceLayer: tiles.sourceLayer,
    type: "line",
  } as const;
  const layers: SceneLayerEntry[] = state.layers.flatMap((layer) => {
    const hiddenKeys = state.hiddenKeys[layer.id] ?? [];
    const visible = state.visible[layer.id] === true;
    const offset = offsetOf.get(layer.id) ?? 0;
    return [
      {
        ...line,
        role: layer.id,
        paint: {
          "line-color": colorExpression(layer, hiddenKeys, state.loading && visible),
          "line-width": ROAD.lineWidthPx,
          "line-opacity": opacityExpression(layer),
          "line-offset": offset,
        },
        visible,
      },
      // データなしの道だけを、薄い破線で描く。
      {
        ...line,
        role: `${layer.id}-no-data`,
        paint: {
          "line-color": palette.semantic.no_data,
          "line-width": ROAD.lineWidthPx,
          "line-opacity": ["case", ["==", valueOf(layer.id), NO_DATA_VALUE], ROAD.unknownOpacity, 0],
          "line-dasharray": ["literal", [...mapDisplay.noDataDash]],
          "line-offset": offset,
        },
        visible: visible && layer.has_no_data && !hiddenKeys.includes(LEGEND_NO_DATA_KEY),
      },
    ];
  });

  // 道路タブの段。道ごとの一番強い段（feature-state）の色で、道の線の層の上を不透明に塗る（段の色が道の層の色に混ざらない）。
  const tracksSpread = 2 * Math.max(0, ...offsets.map(Math.abs));
  layers.push({
    ...line,
    role: ROAD_AVOIDANCE_ROLE,
    paint: {
      "line-color": [
        "match",
        valueOf(AVOIDANCE_NAME),
        ...Object.entries(ROAD_AVOIDANCE_COLORS).flat(),
        palette.semantic.hidden,
      ],
      // 横に分けて並べた道の線の層を覆う（出している層の外側の線の縁まで太くする）。
      "line-width": zoomScaleExpression(
        1,
        mapDisplay.roadAvoidance.widthByZoom.map(([zoom, width]) => [zoom, width + tracksSpread] as const),
      ),
      "line-opacity": 1,
    },
    visible: paintsRoadAvoidance(state.avoidance),
  });

  layers.push(inspected);

  return { sources, layers };
});
