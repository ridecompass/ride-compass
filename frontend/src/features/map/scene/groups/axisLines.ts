/** レンズで道を塗る線。費用の軸は管理APIで増減するため、**レンズごとの分岐・定数を持たない**。
 *
 * 道の値は、backend が配る式の木（費用の軸の一覧の `map_lens.formula`）を地図の式へ置き換えて、地図が道ごとに求める。
 * 木へ入れる道ごとの材料は feature-state で、走る条件（向き・想定速度）は地図全体の global-state で受け取る——向き・
 * 速度を変えても材料は取り直さず、global-state を置き直すだけで色が変わる。**feature-state の値は MapLibre の絞り込み
 * からも `line-dasharray` からも読めない**ため、凡例で隠した段は透明で落とし、値の無い道は同じ線の中で薄い灰色の実線に
 * する（破線にするには全部の道を描く線をもう1つ重ねることになり、レンズを出している間の描く量が倍になる）。
 *
 * ソースは道路の線と同じ路面タイル。宣言は合成（`composeScene`）が1本へ畳む。
 */
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";

import type {
  MapSceneFeatureStates,
  MapSceneFeatureStateValue,
  MapSceneGlobalState,
} from "@/features/map/scene/mapScene";
import { declareGroup, type SceneLayerEntry, type SceneSourceEntry } from "@/features/map/scene/mapSceneGroups";
import { featureStatesByName } from "@/features/map/scene/sceneBuilders";
import { LENS_LAYER_MIN_ZOOM } from "@/features/map/layers/mapLayers";
import { missingExpression, wayValueExpression, type WayValueFormula } from "@/features/map/scene/wayValueFormula";
import { NO_DATA_LEGEND_BAND } from "@/lib/mapDisplay/mapColorLegend";
import { bandStep, type ValueBand } from "@/lib/mapDisplay/valueScale";

import { ROAD_LINE_SOURCE_ID } from "./roadLines";

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
    /** 今の範囲の材料。届いたタイルの道は、値が無くても鍵を持つ（値の無い道は空の材料）。 */
    readonly materials: WayMaterials;
  }[];
  readonly conditions: WayConditions;
  readonly sourceLayer: string;
};

type AxisLine = AxisLineState["axes"][number];

/** 材料の feature-state のキー。同じソースへ複数の軸が材料を載せ、軸ごとに同じ名前の材料が違う値を持ちうるので、
 * 軸idを前に付ける。 */
function materialStateKey(axisId: string, name: string): string {
  return `${axisId}:${name}`;
}

/** 材料が届いた道の印の feature-state のキー。取得中かを地図全体の1つの印で持つと、どれか1枚のタイルを取るたびに
 * 画面じゅうの値の無い道が「データなし」と「取得中」の間で切り替わるので、道ごとに持つ。 */
function fetchedStateKey(axisId: string): string {
  return `${axisId}#fetched`;
}

const fetchedByMaterials = new WeakMap<WayMaterials, ReadonlyMap<string, boolean>>();

/** 材料が届いた道ごとの印。同じ材料からは同じ参照を返す（当てる側は参照が同じなら道ごとに比べ直さない）。 */
function fetchedStates(materials: WayMaterials): ReadonlyMap<string, boolean> {
  let states = fetchedByMaterials.get(materials);
  if (states === undefined) {
    states = new Map([...materials.keys()].map((featureId) => [featureId, true]));
    fetchedByMaterials.set(materials, states);
  }
  return states;
}

/** 走る条件は地図全体で1つなので、木の条件の名前をそのまま global-state の名前にする。 */
const conditionStateKey = (name: string): string => name;

/** 道の材料がもう届いたか。 */
function fetchedExpression(axis: AxisLine): unknown {
  return ["boolean", ["feature-state", fetchedStateKey(axis.axisId)], false];
}

/** 道の値を `let` で束ね、値の無い道とそれ以外に場合分けする。値の無い道を先に分けるので、それ以外の枝（段の選び方）は
 * 値のある道だけを受ける。 */
function byWayValue(axis: AxisLine, cases: (value: unknown) => { missing: unknown; otherwise: unknown }): unknown {
  const ref = ["var", "wayValue"];
  const branches = cases(ref);
  const value = wayValueExpression(axis.formula, {
    featureStateKey: (name) => materialStateKey(axis.axisId, name),
    globalStateKey: conditionStateKey,
  });
  return ["let", "wayValue", value, ["case", missingExpression(ref), branches.missing, branches.otherwise]];
}

/** 段ごとの色。値が無い道と、まだ来ていない道は別の色にする。 */
function colorExpression(axis: AxisLine): unknown {
  return byWayValue(axis, (value) => ({
    missing: ["case", fetchedExpression(axis), NO_DATA_LEGEND_BAND.color, palette.semantic.loading],
    otherwise: bandStep(axis.bands, value, (band) => band.color),
  }));
}

/** 濃さ。材料が届いて値の無い道だけを、道路の線の値の無い道と同じ薄さにする（まだ来ていない道は薄くしない——薄くすると
 * 「まだ来ていない」と「値が無い」が区別できない）。 */
function opacityExpression(axis: AxisLine): unknown {
  const known = mapDisplay.road.knownOpacity;
  return byWayValue(axis, () => ({
    missing: ["case", fetchedExpression(axis), mapDisplay.road.unknownOpacity, known],
    otherwise: known,
  }));
}

function featureStatesFor(state: AxisLineState): MapSceneFeatureStates {
  return new Map(
    state.axes.flatMap((axis): [string, ReadonlyMap<string, MapSceneFeatureStateValue>][] => [
      ...featureStatesByName(axis.materials, (name) => materialStateKey(axis.axisId, name)),
      [fetchedStateKey(axis.axisId), fetchedStates(axis.materials)],
    ]),
  );
}

export const axisLineGroup = declareGroup<AxisLineState>((state) => {
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
    sourceLayer: state.sourceLayer,
    type: "line",
    minzoom: LENS_LAYER_MIN_ZOOM,
  });
  const layers: readonly SceneLayerEntry[] = state.axes.map((axis) => ({
    ...lineOf(axis.axisId),
    paint: {
      "line-color": colorExpression(axis),
      "line-width": mapDisplay.road.lineWidthPx,
      "line-opacity": opacityExpression(axis),
    },
    visible: axis.visible,
  }));

  return { sources, layers, globalState: state.conditions };
});
