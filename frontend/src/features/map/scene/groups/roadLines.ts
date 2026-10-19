/** 道の線の層（軸カタログの`road_classes.map_layers`。分け方1つが層1つ）と、詳細を見ている1本の道の強調。
 *
 * 区分の条件はタイルのプロパティに対する式へ組み、どの道がどの区分に入るかを地図が決める。2つ以上の区分に当たる道は
 * 区分なし（backendの振り分けと同じ規則）。真偽のプロパティは値が真のときだけタイルに載るので、「事実がある」はプロパティが
 * あること、値はその文字列で比べる。
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

import { noDataDashExpression, sceneSourceId, valueInExpression } from "@/features/map/scene/sceneBuilders";
import { LEGEND_NO_DATA_KEY } from "@/lib/mapDisplay/mapColorLegend";
import { ROAD_OTHER_KEY } from "@/lib/mapDisplay/roadTracks";
import type { RoadClassTermView, RoadMapLayerView } from "@/types/route";

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
  /** 詳細を見ている道。開いていなければ null。 */
  readonly inspectedWayId: number | null;
};

/** 条件の項1つが当たるか。タイルに載らない事実（`property`がnull）は、どの道にも事実が無いとして読む。 */
function termMatch(term: RoadClassTermView): unknown {
  if (term.property === null) return term.matches_absent;
  const listed = valueInExpression(["to-string", ["get", term.property]], term.values);
  return ["case", ["has", term.property], term.negated ? ["!", listed] : listed, term.matches_absent];
}

/** 区分の条件のどれかに当たるか。条件の中は項が全部当たる。 */
function classMatch(conditions: RoadMapLayerView["classes"][number]["conditions"]): unknown {
  return ["any", ...conditions.map((condition) => ["all", ...condition.map(termMatch)])];
}

/** 道の入る区分の鍵。どの区分にも当たらない道と、2つ以上の区分に当たる道は空文字。 */
function classKeyOf(layer: RoadMapLayerView): unknown {
  const { classes } = layer;
  if (classes.length === 0) return "";
  if (classes.length === 1) return ["case", classMatch(classes[0].conditions), classes[0].key, ""];
  const bound = classes.map((_, index) => `class${index}`);
  const hits = ["+", ...bound.map((name) => ["case", ["var", name], 1, 0])];
  return [
    "let",
    ...classes.flatMap((roadClass, index) => [bound[index], classMatch(roadClass.conditions)]),
    [
      "case",
      ["==", hits, 1],
      ["case", ...classes.flatMap((roadClass, index) => [["var", bound[index]], roadClass.key]), ""],
      "",
    ],
  ];
}

/** 区分に入る道か。 */
function knownMatch(layer: RoadMapLayerView): unknown {
  return ["!=", classKeyOf(layer), ""];
}

/** データなしの道（区分に入らず、無ければデータなしとするプロパティも無い）。区分の外でもプロパティのある道（その他）とは分ける
 * ——前者は値が分からず、後者は値があって区分の外にあるだけ。データなしを分けない層ではnull。 */
function missingOf(layer: RoadMapLayerView): unknown | null {
  if (layer.no_data_property === null) return null;
  return ["all", ["!", knownMatch(layer)], ["!", ["has", layer.no_data_property]]];
}

function colorExpression(layer: RoadMapLayerView): unknown {
  if (layer.classes.length === 0) return palette.semantic.no_data;
  return [
    "match",
    classKeyOf(layer),
    ...layer.classes.flatMap((roadClass) => [roadClass.key, roadClass.color]),
    palette.semantic.no_data,
  ];
}

/** 区分に入る道は濃く、それ以外（その他・データなし）は薄く（消さずに薄くする）。 */
function opacityExpression(layer: RoadMapLayerView): unknown[] {
  return ["case", knownMatch(layer), ROAD.knownOpacity, ROAD.unknownOpacity];
}

function layerFilter(layer: RoadMapLayerView, hiddenKeys: readonly string[]): FilterSpecification | undefined {
  const hidden = layer.classes
    .filter((roadClass) => hiddenKeys.includes(roadClass.key))
    .map((roadClass) => roadClass.key);
  const conditions: unknown[] = [];
  if (hidden.length > 0) conditions.push(["!", valueInExpression(classKeyOf(layer), hidden)]);
  const missing = missingOf(layer);
  if (hiddenKeys.includes(ROAD_OTHER_KEY)) {
    const known = knownMatch(layer);
    conditions.push(missing === null ? known : ["any", missing, known]);
  }
  if (missing !== null && hiddenKeys.includes(LEGEND_NO_DATA_KEY)) conditions.push(["!", missing]);
  if (conditions.length === 0) return undefined;
  return ["all", ...conditions] as unknown as FilterSpecification;
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
    },
  ];

  const shown = state.layers.filter((layer) => state.visible[layer.id] === true);
  const offsets = offsetsFor(shown.length);
  const offsetOf = new Map(shown.map((layer, index) => [layer.id, offsets[index] ?? 0]));

  const layers: SceneLayerEntry[] = state.layers.map((layer) => {
    const missing = missingOf(layer);
    return {
      role: layer.id,
      tier: "observedLine",
      source: ROAD_LINE_SOURCE_ID,
      sourceLayer: tiles.sourceLayer,
      type: "line",
      paint: {
        "line-color": colorExpression(layer),
        "line-width": ROAD.lineWidthPx,
        "line-opacity": opacityExpression(layer),
        ...(missing !== null ? { "line-dasharray": noDataDashExpression(missing) } : {}),
        "line-offset": offsetOf.get(layer.id) ?? 0,
      },
      visible: state.visible[layer.id] === true,
      hitTargets: [ROAD_LINE_HIT_TARGET],
      filter: layerFilter(layer, state.hiddenKeys[layer.id] ?? []),
    };
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
