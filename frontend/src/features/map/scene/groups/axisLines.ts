/** レンズで道を塗る線。費用の軸は管理APIで増減するため、**レンズごとの分岐・定数を持たない**。
 *
 * 道の値は、式の木を地図の式へ置き換えて MapLibre と同じ評価器で画面のコードが道ごとに1回ずつ求め、値1つだけを
 * feature-state で地図へ渡す（理由と値の無い道の描き方は docs/modules/frontend/map-axis-coloring.md「レンズの線」）。
 *
 * ソースは道路の線と同じ路面タイル。宣言は合成（`composeScene`）が1本へ畳む。
 */
import { createExpression, type StyleExpression } from "@maplibre/maplibre-gl-style-spec";

import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";

import type { MapSceneFeatureStates, MapSceneFeatureStateValue } from "@/features/map/scene/mapScene";
import { declareGroup, type SceneLayerEntry, type SceneSourceEntry } from "@/features/map/scene/mapSceneGroups";
import { LENS_LAYER_MIN_ZOOM } from "@/features/map/layers/mapLayers";
import { wayValueExpression, type WayValueFormula } from "@/features/map/scene/wayValueFormula";
import { NO_DATA_LEGEND_BAND } from "@/lib/mapDisplay/mapColorLegend";
import { bandStep, type ValueBand } from "@/lib/mapDisplay/valueScale";

import { ROAD_LINE_SOURCE_ID } from "./roadLines";

/** 道ごとの材料。feature_key → 材料の名前 → 値（値の無い材料は鍵ごと無い）。 */
export type WayMaterials = ReadonlyMap<string, Readonly<Record<string, number>>>;

/** 式の木が読む走る条件。名前は木の `condition` の名前で、値の無い条件は鍵ごと無い。 */
export type WayConditions = Readonly<Record<string, number>>;

export type AxisLineState = {
  readonly axes: readonly {
    readonly axisId: string;
    readonly visible: boolean;
    /** 段の並び（低い段から。`valueScale.ts: valueBands`）。 */
    readonly bands: readonly ValueBand[];
    /** 道の値を求める式の木。 */
    readonly formula: WayValueFormula;
    /** 今の範囲の材料。届いたタイルの道は、値が無くても鍵を持つ（値の無い道は空の材料）。 */
    readonly materials: WayMaterials;
  }[];
  readonly conditions: WayConditions;
  readonly sourceLayer: string;
};

type AxisLine = AxisLineState["axes"][number];

/** 材料は届いたが値の無い道の印。feature-state の値に NaN を置けないので、文字で持つ。届いていない道は鍵を持たない。 */
const NO_VALUE = "none";

/** 道の値の feature-state のキー。同じソースへ複数の軸が値を載せるので、軸ごとに分ける。 */
function valueStateKey(axisId: string): string {
  return `${axisId}:value`;
}

/** 式を評価するときの地図の状態と地物。道の値は倍率にも地物のプロパティにも依らない（材料と条件だけで決まる）。 */
const EVALUATION_GLOBALS = { zoom: 0 } as never;
const EVALUATION_FEATURE = { type: 2, properties: {} } as never;

const compiledByFormula = new WeakMap<WayValueFormula, Map<string, StyleExpression>>();

/** 式の木を、走る条件を入れて評価器に読ませたもの。木と条件が同じなら同じものを返す（覚えた値を使い回す鍵になる）。 */
function compiledFor(formula: WayValueFormula, conditions: WayConditions): StyleExpression {
  const key = JSON.stringify(conditions);
  let byConditions = compiledByFormula.get(formula);
  if (byConditions === undefined) compiledByFormula.set(formula, (byConditions = new Map()));
  let compiled = byConditions.get(key);
  if (compiled === undefined) {
    const result = createExpression(wayValueExpression(formula), "paint", null, { ...conditions });
    if (result.result !== "success") throw new Error(result.value.map((error) => error.message).join("; "));
    compiled = result.value;
    byConditions.set(key, compiled);
  }
  return compiled;
}

/** 道1本の材料ごとに求めた値（評価器ごと）。タイルの応答の材料は届いたあと変わらないので、材料の参照で覚える。 */
const valueByMaterial = new WeakMap<
  StyleExpression,
  WeakMap<Readonly<Record<string, number>>, number | typeof NO_VALUE>
>();

function wayValue(compiled: StyleExpression, material: Readonly<Record<string, number>>): number | typeof NO_VALUE {
  let values = valueByMaterial.get(compiled);
  if (values === undefined) valueByMaterial.set(compiled, (values = new WeakMap()));
  let value = values.get(material);
  if (value === undefined) {
    const evaluated: unknown = compiled.evaluateWithoutErrorHandling(EVALUATION_GLOBALS, EVALUATION_FEATURE, material);
    value = typeof evaluated === "number" && !Number.isNaN(evaluated) ? evaluated : NO_VALUE;
    values.set(material, value);
  }
  return value;
}

const valuesByMaterials = new WeakMap<
  WayMaterials,
  Map<StyleExpression, ReadonlyMap<string, MapSceneFeatureStateValue>>
>();

/** 軸の道ごとの値。同じ材料と条件からは同じ参照を返す（当てる側は参照が同じなら道ごとに比べ直さない）。 */
function wayValues(axis: AxisLine, conditions: WayConditions): ReadonlyMap<string, MapSceneFeatureStateValue> {
  const compiled = compiledFor(axis.formula, conditions);
  let byCompiled = valuesByMaterials.get(axis.materials);
  if (byCompiled === undefined) valuesByMaterials.set(axis.materials, (byCompiled = new Map()));
  let values = byCompiled.get(compiled);
  if (values === undefined) {
    values = new Map([...axis.materials].map(([featureId, material]) => [featureId, wayValue(compiled, material)]));
    byCompiled.set(compiled, values);
  }
  return values;
}

/** 段ごとの色。値が無い道は破線の線が描くので透明にし（重ねると破線が実線に埋もれる）、まだ来ていない道は取得中の色にする。 */
function colorExpression(axis: AxisLine): unknown {
  const value = ["feature-state", valueStateKey(axis.axisId)];
  return [
    "case",
    ["==", ["typeof", value], "number"],
    bandStep(axis.bands, ["number", value], (band) => band.color),
    ["==", value, NO_VALUE],
    palette.semantic.hidden,
    palette.semantic.loading,
  ];
}

/** 破線の線の濃さ。値が無いと決まった道だけを見せる（`line-dasharray` は feature-state を読めないので、濃さで出し入れする）。 */
function noDataOpacityExpression(axis: AxisLine): unknown {
  return ["case", ["==", ["feature-state", valueStateKey(axis.axisId)], NO_VALUE], mapDisplay.road.unknownOpacity, 0];
}

function featureStatesFor(state: AxisLineState): MapSceneFeatureStates {
  return new Map(state.axes.map((axis) => [valueStateKey(axis.axisId), wayValues(axis, state.conditions)]));
}

export const axisLineGroup = declareGroup<AxisLineState>((state) => {
  const sources: readonly SceneSourceEntry[] = [
    // 宣言そのものは道路の線が持つ。ここは道の値だけを同じソースへ載せる。
    {
      id: ROAD_LINE_SOURCE_ID,
      spec: { type: "vector" },
      sourceLayer: state.sourceLayer,
      featureStates: featureStatesFor(state),
    },
  ];

  const lineOf = (role: string): Omit<SceneLayerEntry, "paint" | "visible"> => ({
    role,
    tier: "lensLine",
    source: ROAD_LINE_SOURCE_ID,
    sourceLayer: state.sourceLayer,
    type: "line",
    minzoom: LENS_LAYER_MIN_ZOOM,
  });
  const layers: readonly SceneLayerEntry[] = state.axes.flatMap((axis) => [
    {
      ...lineOf(axis.axisId),
      paint: {
        "line-color": colorExpression(axis),
        "line-width": mapDisplay.road.lineWidthPx,
        "line-opacity": mapDisplay.road.knownOpacity,
      },
      visible: axis.visible,
    },
    // 値の無い道だけを、薄い破線で描く。
    {
      ...lineOf(`${axis.axisId}-no-data`),
      paint: {
        "line-color": NO_DATA_LEGEND_BAND.color,
        "line-width": mapDisplay.road.lineWidthPx,
        "line-opacity": noDataOpacityExpression(axis),
        "line-dasharray": ["literal", [...mapDisplay.noDataDash]],
      },
      visible: axis.visible,
    },
  ]);

  return { sources, layers };
});
