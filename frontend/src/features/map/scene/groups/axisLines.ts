/** 評価軸で道を塗る線。軸は管理画面で増減するため、**軸ごとの分岐・定数を持たない**。
 *
 * 道の値は、backend が配る式の木（軸カタログの `way_value_formula`）を地図の式へ置き換えて、地図が道ごとに求める。
 * 木へ入れる道ごとの材料は feature-state で、走る条件（向き・想定速度）は地図全体の global-state で受け取る——向き・
 * 速度を変えても材料は取り直さず、global-state を置き直すだけで色が変わる。**feature-state の値は MapLibre の絞り込み
 * からも `line-dasharray` からも読めない**ため、凡例で隠した段は透明で落とし、値の無い道の破線は、破線だけの線を
 * 重ねて濃さ（feature-state を読める）で出し入れする。
 *
 * ソースは道路の線と同じ路面タイル。宣言は合成（`composeScene`）が1本へ畳む。
 */
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";

import type { MapSceneFeatureStates, MapSceneGlobalState } from "@/features/map/scene/mapScene";
import { declareGroup, type SceneLayerEntry, type SceneSourceEntry } from "@/features/map/scene/mapSceneGroups";
import { missingExpression, wayValueExpressions, type WayValueFormula } from "@/features/map/scene/wayValueFormula";
import { LEGEND_NO_DATA_KEY, NO_DATA_LEGEND_BAND, UNDETERMINED_LEGEND_BAND } from "@/lib/mapDisplay/mapColorLegend";
import { ROAD_TRACKS } from "@/lib/mapDisplay/roadTracks";
import { bandStep, type ValueBand } from "@/lib/mapDisplay/valueScale";

import { ROAD_LINE_SOURCE_ID } from "./roadLines";

/** 材料が同時に出ているときの下敷き。**材料の線が全部出たときの帯幅**から決まるので、
 * トラックが増えれば自動で広がる（直書きすると追従しない）。 */
const UNDERLAY_WIDTH_PX = (ROAD_TRACKS.length - 1) * mapDisplay.road.trackOffsetStepPx + mapDisplay.road.lineWidthPx;

/** 道ごとの材料。feature_key → 材料の名前 → 値（値の無い材料は鍵ごと無い）。 */
export type WayMaterials = ReadonlyMap<string, Readonly<Record<string, number>>>;

/** 式の木が読む走る条件。名前は木の `condition` の名前で、値の無い条件は鍵ごと無い。 */
export type WayConditions = MapSceneGlobalState;

export type AxisLineState = {
  readonly axes: readonly {
    readonly axisId: string;
    readonly visible: boolean;
    /** 段の並び（低い段から。`valueScale.ts: valueBands`）。 */
    readonly bands: readonly ValueBand[];
    /** 道の値を求める式の木。 */
    readonly formula: WayValueFormula;
    /** 今の範囲の材料。 */
    readonly materials: WayMaterials;
    /** 今の範囲の材料を取りに行っている間か。 */
    readonly loading: boolean;
    /** 凡例で隠した段の鍵。 */
    readonly hiddenBandKeys: readonly string[];
    /** その軸の材料が同時に出ているか（判定は呼び出し側が持つ）。 */
    readonly underlay: boolean;
  }[];
  readonly conditions: WayConditions;
  readonly sourceLayer: string | null;
};

type AxisLine = AxisLineState["axes"][number];

/** 材料の feature-state のキー。同じソースへ複数の軸が材料を載せ、軸ごとに同じ名前の材料が違う値を持ちうるので、
 * 軸idを前に付ける。 */
function materialStateKey(axisId: string, name: string): string {
  return `${axisId}:${name}`;
}

/** 走る条件は地図全体で1つなので、木の条件の名前をそのまま global-state の名前にする。 */
const conditionStateKey = (name: string): string => name;

/** 軸の木を置き換えた式。`value` が NaN の道は値が無い。 */
function expressionsOf(axis: AxisLine) {
  return wayValueExpressions(axis.formula, {
    featureStateKey: (name) => materialStateKey(axis.axisId, name),
    globalStateKey: conditionStateKey,
  });
}

/** 値の無い道を破線の線が描くか。下敷きは全体を薄く敷くだけ、取得中は取得中の色を見せる。 */
function dashesMissing(axis: AxisLine): boolean {
  return !axis.underlay && !axis.loading && !axis.hiddenBandKeys.includes(LEGEND_NO_DATA_KEY);
}

/** 道の値を `let` で束ね、向きで決まらない道・値の無い道・それ以外の順に場合分けする。値の無い道を先に分けるので、
 * それ以外の枝（段の選び方）は値のある道だけを受ける。 */
function byWayValue(
  axis: AxisLine,
  cases: (value: unknown) => { undetermined: unknown; missing: unknown; otherwise: unknown },
): unknown {
  const { value, undetermined } = expressionsOf(axis);
  const ref = ["var", "wayValue"];
  const branches = cases(ref);
  return [
    "let",
    "wayValue",
    value,
    ["case", undetermined, branches.undetermined, missingExpression(ref), branches.missing, branches.otherwise],
  ];
}

/** 段ごとの色。値が無い道と、まだ来ていない道は別の色にする。凡例で隠した段は透明にして下の路面の線を見せる。 */
function colorExpression(axis: AxisLine): unknown {
  const shown = (key: string, color: string) => (axis.hiddenBandKeys.includes(key) ? palette.semantic.hidden : color);
  // 取得中の色は「値なし」を隠していても残す——消すと「まだ来ていない」と「隠した」が区別できなくなる。
  // 破線の線が値の無い道を描くときは、実線の側は透明にする（重ねると破線が実線に埋もれる）。
  const missingColor = axis.loading
    ? palette.semantic.loading
    : dashesMissing(axis)
      ? palette.semantic.hidden
      : shown(LEGEND_NO_DATA_KEY, NO_DATA_LEGEND_BAND.color);
  return byWayValue(axis, (value) => ({
    undetermined: shown(UNDETERMINED_LEGEND_BAND.key, UNDETERMINED_LEGEND_BAND.color),
    missing: missingColor,
    otherwise: bandStep(axis.bands, value, (band) => shown(band.key, band.color)),
  }));
}

/** 値の無い道だけを見せる濃さ。 */
function noDataOpacityExpression(axis: AxisLine): unknown {
  return byWayValue(axis, () => ({
    undetermined: 0,
    missing: mapDisplay.road.unknownOpacity,
    otherwise: 0,
  }));
}

const statesByMaterials = new WeakMap<WayMaterials, Map<string, Map<string, number>>>();

/** 道ごとの材料を、材料の名前ごとの feature-state へ移す。同じ材料の結果からは同じ参照を返す——当てる側は
 * 参照が同じなら道ごとに比べ直さない。 */
function materialStates(axisId: string, materials: WayMaterials): ReadonlyMap<string, ReadonlyMap<string, number>> {
  const cached = statesByMaterials.get(materials);
  if (cached !== undefined) return cached;
  const states = new Map<string, Map<string, number>>();
  for (const [featureId, values] of materials) {
    for (const [name, value] of Object.entries(values)) {
      const key = materialStateKey(axisId, name);
      let byFeature = states.get(key);
      if (byFeature === undefined) states.set(key, (byFeature = new Map()));
      byFeature.set(featureId, value);
    }
  }
  statesByMaterials.set(materials, states);
  return states;
}

function featureStatesFor(state: AxisLineState): MapSceneFeatureStates {
  const states = new Map<string, ReadonlyMap<string, number>>();
  for (const axis of state.axes) {
    for (const [key, values] of materialStates(axis.axisId, axis.materials)) states.set(key, values);
  }
  return states;
}

export const axisLineGroup = declareGroup<AxisLineState>((state) => {
  if (state.sourceLayer === null) return { sources: [], layers: [] };

  const sources: readonly SceneSourceEntry[] = [
    // 宣言そのものは道路の線が持つ。ここは材料だけを同じソースへ載せる。
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
    sourceLayer: state.sourceLayer ?? undefined,
    type: "line",
  });
  const layers: readonly SceneLayerEntry[] = state.axes.flatMap((axis) => [
    {
      ...lineOf(axis.axisId),
      paint: {
        "line-color": colorExpression(axis),
        "line-width": axis.underlay ? UNDERLAY_WIDTH_PX : mapDisplay.road.lineWidthPx,
        // 取得中は薄くしない——薄くすると「まだ来ていない」と「対象外」が区別できない。
        "line-opacity": axis.underlay ? mapDisplay.road.underlayOpacity : mapDisplay.road.knownOpacity,
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
      visible: axis.visible && dashesMissing(axis),
    },
  ]);

  return { sources, layers, globalState: state.conditions };
});
