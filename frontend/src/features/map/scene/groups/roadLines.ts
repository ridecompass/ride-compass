/** 道の線の層（画面の設定の`road_classes.map_layers`。分け方1つが層1つ）と、道路タブを地図で見ている間に道路タブの段を道に
 * 塗る線と、詳細を見ている道の強調。
 *
 * 道の層の値（区分の鍵か「データなし」）はbackendが決めて路面タイルに焼き（層のidのプロパティ。区分の外の道は持たない）、地図は
 * それを読んで塗るだけにする——ルートの区間の帯と同じ値になる。凡例で隠した行は絞り込みで落とし、データなしの道は破線だけの
 * 線で描く（実線は落とす）。
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
import type { FilterSpecification } from "maplibre-gl";

import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";
import regionTileConfig from "@/types/generated/region-tile-config.json";

import { sceneSourceId, valueInExpression, zoomScaleExpression } from "@/features/map/scene/sceneBuilders";
import { LEGEND_NO_DATA_KEY } from "@/lib/mapDisplay/mapColorLegend";
import { ROAD_OTHER_KEY, roadTrackRowOf, type RoadTrackRow } from "@/lib/mapDisplay/roadTracks";
import type { AvoidanceChoice } from "@/lib/roadAvoidance";
import type { RoadMapLayerView } from "@/types/route";

import { declareGroup, type SceneLayerEntry, type SceneSourceEntry } from "@/features/map/scene/mapSceneGroups";

const ROAD = mapDisplay.road;

/** 道路タブの段を地図の道に塗る線の役割。 */
export const ROAD_AVOIDANCE_ROLE = "roadAvoidance";

export const ROAD_LINE_SOURCE_ID = sceneSourceId("road-tiles");
const ROAD_INSPECTED_SOURCE_ID = sceneSourceId("road-inspected");

/** `feature_key`は地物へ安定したidを与えるための昇格先（**この列でなければ道ごとの値（レンズ）の feature-state が効かない**
 * ——タイルの地物はズームによって道1本にも区間にもなり、この列だけがその単位に追従する。道ごとの鍵を持たない引いたズームの
 * 地物には無い）。列名はタイルを焼くbackendが配る。 */
export const FEATURE_KEY_PROPERTY = regionTileConfig.road_surface.properties.feature_key;

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
  /** 地図の道に塗る、道路タブの段。 */
  readonly avoidance: AvoidanceChoice;
  /** 道路タブを地図で見ているか（道路タブを出していて「地図で見る」がON）。見ている間は、どの道も段の色で塗り、下の地図を薄める。 */
  readonly avoidanceShown: boolean;
  /** 詳細を見ている道の線の形（経度, 緯度）。開いていなければ null。 */
  readonly inspectedShape: readonly (readonly [number, number])[] | null;
};

const NO_DATA_VALUE = ROAD.noDataValue;

/** 道の層`layerId`の値。区分の外の道は空文字。 */
function valueOf(layerId: string): unknown {
  return ["to-string", ["get", layerId]];
}

/** 道（タイルの地物のプロパティ）が、「表示」で出している道の層の先頭の層で入る凡例の行（地図の線の色と同じ値から引く）。道の層を
 * 出していなければ null。 */
export function shownRoadTrackOf(
  properties: Readonly<Record<string, unknown>>,
  layers: readonly RoadMapLayerView[],
  visible: Readonly<Record<string, boolean>>,
): RoadTrackRow | null {
  const layer = layers.find((candidate) => visible[candidate.id] === true);
  if (layer === undefined) return null;
  const value = properties[layer.id];
  return roadTrackRowOf(layer, typeof value === "string" ? value : null);
}

/** 区分ごとの色。区分の外（その他）は薄い灰。 */
function colorExpression(layer: RoadMapLayerView): unknown {
  const pairs = layer.classes.flatMap((roadClass) => [roadClass.key, roadClass.color]);
  return pairs.length === 0
    ? palette.semantic.no_data
    : ["match", valueOf(layer.id), ...pairs, palette.semantic.no_data];
}

/** 実線が描く道。凡例で隠した行と、データなしの道（破線の線が描く）を落とす。 */
function solidFilter(layer: RoadMapLayerView, hiddenKeys: readonly string[]): FilterSpecification {
  const value = valueOf(layer.id);
  const classKeys = layer.classes.map((roadClass) => roadClass.key);
  const hiddenClasses = classKeys.filter((key) => hiddenKeys.includes(key));
  return [
    "all",
    ["!=", value, NO_DATA_VALUE],
    ["!", valueInExpression(value, hiddenClasses)],
    ...(hiddenKeys.includes(ROAD_OTHER_KEY) ? [valueInExpression(value, classKeys)] : []),
  ] as unknown as FilterSpecification;
}

/** 塗る段ごとの、色とその段の行に当たる道の条件（強い段から。行の無い段は無い）。どの行にも当たらない道は塗らない。 */
function avoidanceConditions(choice: AvoidanceChoice): readonly (readonly [string, unknown])[] {
  return [...choice.levels].reverse().flatMap(({ key: level, color }) => {
    // タイルのプロパティごとに、この段にした値（プロパティ1つにつき比べ1つ）。
    const classKeys = new Map<string, string[]>();
    for (const row of choice.rows) {
      if (row.level === level) classKeys.set(row.section, [...(classKeys.get(row.section) ?? []), row.classKey]);
    }
    return classKeys.size === 0
      ? []
      : [
          [
            color,
            ["any", ...[...classKeys].map(([section, keys]) => valueInExpression(valueOf(section), keys))],
          ] as const,
        ];
  });
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
          "line-color": colorExpression(layer),
          "line-width": ROAD.lineWidthPx,
          "line-opacity": opacityExpression(layer),
          "line-offset": offset,
        },
        filter: solidFilter(layer, hiddenKeys),
        visible,
      },
      // データなしの道だけを、薄い破線で描く。
      {
        ...line,
        role: `${layer.id}-no-data`,
        paint: {
          "line-color": palette.semantic.no_data,
          "line-width": ROAD.lineWidthPx,
          "line-opacity": ROAD.unknownOpacity,
          "line-dasharray": ["literal", [...mapDisplay.noDataDash]],
          "line-offset": offset,
        },
        filter: ["==", valueOf(layer.id), NO_DATA_VALUE] as FilterSpecification,
        visible: visible && layer.has_no_data && !hiddenKeys.includes(LEGEND_NO_DATA_KEY),
      },
    ];
  });

  // 道路タブの段。道ごとの一番強い段の色で、道の線の層の上を不透明に塗る（段の色が道の層の色に混ざらない）。
  const tracksSpread = 2 * Math.max(0, ...offsets.map(Math.abs));
  const avoided = avoidanceConditions(state.avoidance);
  layers.push({
    ...line,
    role: ROAD_AVOIDANCE_ROLE,
    paint: {
      // 当たる段のうち一番強いものの色（強い段から順に当てる）。描くのはどれかの段の行に当たる道だけ（下の絞り込み）。
      "line-color":
        avoided.length === 0
          ? palette.semantic.hidden
          : ["case", ...avoided.flatMap(([color, condition]) => [condition, color]), palette.semantic.hidden],
      // 横に分けて並べた道の線の層を覆う（出している層の外側の線の縁まで太くする）。
      "line-width": zoomScaleExpression(
        1,
        mapDisplay.roadAvoidance.widthByZoom.map(([zoom, width]) => [zoom, width + tracksSpread] as const),
      ),
      "line-opacity": 1,
    },
    filter: ["any", ...avoided.map(([, condition]) => condition)] as unknown as FilterSpecification,
    visible: state.avoidanceShown,
  });

  layers.push(inspected);

  return { sources, layers };
});
