/** 評価軸で道を塗る線。軸は管理画面で増減するため、**軸ごとの分岐・定数を持たない**。
 *
 * 値は配信された得点を feature-state で受け取る。**feature-state の値は MapLibre の絞り込みからも
 * `line-dasharray` からも読めない**ため、凡例で隠した段は透明で落とし、値の無い道の破線は、破線だけの
 * 線を重ねて濃さ（feature-state を読める）で出し入れする。
 *
 * ソースは道路の線と同じ路面タイル。宣言は合成（`composeScene`）が1本へ畳む。
 */
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";

import type { MapSceneFeatureStates, MapSceneFeatureStateValue } from "@/features/map/scene/mapScene";
import { declareGroup, type SceneLayerEntry, type SceneSourceEntry } from "@/features/map/scene/mapSceneGroups";
import { LEGEND_NO_DATA_KEY, NO_DATA_LEGEND_BAND, UNDETERMINED_LEGEND_BAND } from "@/lib/mapDisplay/mapColorLegend";
import { ROAD_TRACKS } from "@/lib/mapDisplay/roadTracks";
import { bandCondition, type ValueBand } from "@/lib/mapDisplay/valueScale";

import { ROAD_LINE_SOURCE_ID } from "./roadLines";

/** 材料が同時に出ているときの下敷き。**材料の線が全部出たときの帯幅**から決まるので、
 * トラックが増えれば自動で広がる（直書きすると追従しない）。 */
const UNDERLAY_WIDTH_PX = (ROAD_TRACKS.length - 1) * mapDisplay.road.trackOffsetStepPx + mapDisplay.road.lineWidthPx;
export type AxisLineState = {
  readonly axes: readonly {
    readonly axisId: string;
    readonly visible: boolean;
    /** 段の並び（低い段から。`valueScale.ts: valueBands`）。 */
    readonly bands: readonly ValueBand[];
    /** 配信された値。値が無い道は鍵ごと無く、走行方位で値が決まらない道は null。 */
    readonly values: ReadonlyMap<string, number | null>;
    /** 今の範囲の値を取りに行っている間か。 */
    readonly loading: boolean;
    /** 凡例で隠した段の鍵。 */
    readonly hiddenBandKeys: readonly string[];
    /** その軸の材料が同時に出ているか（判定は呼び出し側が持つ）。 */
    readonly underlay: boolean;
  }[];
  readonly sourceLayer: string | null;
};

type AxisLine = AxisLineState["axes"][number];

/** feature-state のキー。軸idから機械的に決める（同じソースへ複数の軸が値を載せるため）。 */
function axisFeatureStateKey(axisId: string): string {
  return `${axisId}Value`;
}

/** 走行方位で値が決まらない道の feature-state のキー。値と同じキーへ番兵で載せると、段の大小比較に文字列が混ざる。 */
function axisUndeterminedStateKey(axisId: string): string {
  return `${axisId}Undetermined`;
}

function undeterminedCondition(axisId: string): unknown {
  return ["boolean", ["feature-state", axisUndeterminedStateKey(axisId)], false];
}

/** その道の値が無いことを示す式。段の大小比較はこれが偽のときにだけ評価させる——欠損と数値の比較は
 * 評価時エラーになり、そのレイヤーだけが黙って描かれなくなる。向きで決まらない道もこれが真になるので、
 * 先に向きの判定で外す。 */
function missingCondition(axisId: string): unknown {
  return ["==", ["feature-state", axisFeatureStateKey(axisId)], null];
}

/** 値の無い道を破線の線が描くか。下敷きは全体を薄く敷くだけ、取得中は取得中の色を見せる。 */
function dashesMissing(axis: AxisLine): boolean {
  return !axis.underlay && !axis.loading && !axis.hiddenBandKeys.includes(LEGEND_NO_DATA_KEY);
}

/** 段ごとの色。値が無い道と、まだ来ていない道は別の色にする。凡例で隠した段は透明にして下の路面の線を見せる。 */
function colorExpression(axis: AxisLine): unknown {
  const value = ["feature-state", axisFeatureStateKey(axis.axisId)];
  const shown = (key: string, color: string) => (axis.hiddenBandKeys.includes(key) ? palette.semantic.hidden : color);
  const cases = axis.bands.flatMap((band, index) => [
    bandCondition(axis.bands, index, value),
    shown(band.key, band.color),
  ]);
  // 取得中の色は「値なし」を隠していても残す——消すと「まだ来ていない」と「隠した」が区別できなくなる。
  // 破線の線が値の無い道を描くときは、実線の側は透明にする（重ねると破線が実線に埋もれる）。
  const missingColor = axis.loading
    ? palette.semantic.loading
    : dashesMissing(axis)
      ? palette.semantic.hidden
      : shown(LEGEND_NO_DATA_KEY, NO_DATA_LEGEND_BAND.color);
  return [
    "case",
    undeterminedCondition(axis.axisId),
    shown(UNDETERMINED_LEGEND_BAND.key, UNDETERMINED_LEGEND_BAND.color),
    missingCondition(axis.axisId),
    missingColor,
    ...cases,
    NO_DATA_LEGEND_BAND.color,
  ];
}

type SplitDelivered = {
  readonly values: ReadonlyMap<string, number>;
  readonly undetermined: ReadonlyMap<string, true>;
};

const splitByDelivered = new WeakMap<ReadonlyMap<string, number | null>, SplitDelivered>();

/** 配信の値を、値のある道と向きで決まらない道へ分ける。同じ配信の結果からは同じ参照を返す——当てる側は
 * 参照が同じなら道ごとに比べ直さない。 */
function splitDelivered(delivered: ReadonlyMap<string, number | null>): SplitDelivered {
  const cached = splitByDelivered.get(delivered);
  if (cached !== undefined) return cached;
  const values = new Map<string, number>();
  const undetermined = new Map<string, true>();
  for (const [featureId, value] of delivered) {
    if (value === null) undetermined.set(featureId, true);
    else values.set(featureId, value);
  }
  const split = { values, undetermined };
  splitByDelivered.set(delivered, split);
  return split;
}

function featureStatesFor(state: AxisLineState): MapSceneFeatureStates {
  const states = new Map<string, ReadonlyMap<string, MapSceneFeatureStateValue>>();
  for (const axis of state.axes) {
    const { values, undetermined } = splitDelivered(axis.values);
    states.set(axisFeatureStateKey(axis.axisId), values);
    states.set(axisUndeterminedStateKey(axis.axisId), undetermined);
  }
  return states;
}

export const axisLineGroup = declareGroup<AxisLineState>((state) => {
  if (state.sourceLayer === null) return { sources: [], layers: [] };

  const sources: readonly SceneSourceEntry[] = [
    // 宣言そのものは道路の線が持つ。ここは値だけを同じソースへ載せる。
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
        "line-opacity": [
          "case",
          undeterminedCondition(axis.axisId),
          0,
          missingCondition(axis.axisId),
          mapDisplay.road.unknownOpacity,
          0,
        ],
        "line-dasharray": ["literal", [...mapDisplay.noDataDash]],
      },
      visible: axis.visible && dashesMissing(axis),
    },
  ]);

  return { sources, layers };
});
