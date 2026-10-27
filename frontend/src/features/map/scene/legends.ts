/** 地図チップの凡例の行（道の属性・点・災害）を、地図を描いているのと同じ宣言から作る。
 *
 * 分類と色は、道は`lib/mapDisplay/roadTracks.ts: roadTrackRows`、点はグループ（`groups/*.ts`）の宣言、災害は源泉の気象の段、値が無い行は
 * `NO_DATA_LEGEND_BAND`から引く——凡例が別に色を持つと、地図とチップの色が静かに食い違う。
 * 評価軸の凡例はここではなく`features/map/view/lens.ts`が、地図の線と同じ段の関数から作る。
 */
import type { LegendEntry } from "@/lib/mapDisplay/legendFilter";
import { NO_DATA_LEGEND_BAND } from "@/lib/mapDisplay/mapColorLegend";
import { ROAD_OTHER_KEY, roadTrackRows } from "@/lib/mapDisplay/roadTracks";
import type { RoadMapLayerView } from "@/types/route";

import palette from "@/types/generated/palette.json";
import weatherScales from "@/types/generated/weather-scales.json";

import { pointAxisKey } from "@/features/map/scene/groups/points";
import { POINT_LAYERS, pointCategoryRadiusPx, type PointAxis } from "@/lib/mapDisplay/pointLayers";
import { DISASTER_ELEMENTS, DISASTER_LAYER_ID, type DisasterElement } from "@/features/map/layers/dynamicWeather";

/** 凡例1本ぶん。1つのチップが複数の軸を持つことがある（事故は当事者と重大度）。 */
type SceneLegendAxis = {
  /** 地図チップのid（＝レイヤーの役割）。 */
  readonly layerId: string;
  /** 隠した行を覚えておく鍵。 */
  readonly axisId: string;
  /** 軸が1本だけなら見出しは空でよい（チップ名で足りる）。 */
  readonly label: string;
  readonly entries: readonly LegendEntry[];
};

/** 道の線の層ごとの凡例。鍵は層の鍵（チップのidと、隠した行を覚えておく鍵を兼ねる）。 */
export function roadLegendAxes(layers: readonly RoadMapLayerView[]): readonly SceneLegendAxis[] {
  return layers.map((layer) => ({
    layerId: layer.id,
    axisId: layer.id,
    // 見出しはチップ名で足りる（軸が1本しかない）。
    label: "",
    entries: roadTrackRows(layer).map((row) => ({ ...row, line: true as const })),
  }));
}

/** 最初に凡例で隠しておく行。区分の外の道を隠す層（`hide_missing_rows`）の、値の無い道の行（データなしを分ける層では
 * データなし、分けない層では該当なし）。 */
export function initiallyHiddenLegendKeys(
  layers: readonly RoadMapLayerView[],
): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(
    layers
      .filter((layer) => layer.hide_missing_rows)
      .map((layer) => [layer.id, [layer.has_no_data ? NO_DATA_LEGEND_BAND.key : ROAD_OTHER_KEY]]),
  );
}

/** 点の凡例。**色見本を出すのは、地図の色式が読む先頭の軸だけ**——2本目以降（重大度）は
 * 地図では大きさだけで表れるので、見本も色を持たない灰で、地図と同じ大きさにする。絵記号で描く行は見本も絵記号にする。 */
function pointAxisLegend(layer: (typeof POINT_LAYERS)[number], axis: PointAxis, index: number): SceneLegendAxis {
  return {
    layerId: layer.attr_id,
    axisId: pointAxisKey(layer, axis),
    label: axis.label,
    entries: axis.categories.map((category) =>
      index === 0 && "color" in category
        ? {
            key: category.key,
            label: category.label,
            description: category.description,
            color: category.color,
            ...("glyph" in category ? { glyph: category.glyph } : {}),
            ...("glyph" in category && layer.point_name_property === null ? { roundFrame: true as const } : {}),
          }
        : {
            key: category.key,
            label: category.label,
            description: category.description,
            color: palette.semantic.legend_size_only,
            diameterPx: 2 * pointCategoryRadiusPx(category),
          },
    ),
  };
}

export function pointLegendAxes(): readonly SceneLegendAxis[] {
  return POINT_LAYERS.flatMap((layer) =>
    layer.display_axes.map((axis: PointAxis, index: number) => pointAxisLegend(layer, axis, index)),
  );
}

/** 段の並びから鍵で1段の色を引く。位置で引くと、源泉が段を足した・並べ替えたときに別の段を指す。 */
function levelColor(levels: readonly { key: string; color: string }[], key: string): string {
  const level = levels.find((candidate) => candidate.key === key);
  if (!level) throw new Error(`気象の段に鍵が無い: ${key}`);
  return level.color;
}

/** 段で塗る災害の要素の色見本にする段。注意を促す段の色（平常時の色を見本にすると、どの要素も同じに見える）。 */
const SWATCH_LEVEL_KEY: Record<NonNullable<DisasterElement["levelScale"]>, string> = {
  risk_levels: "level2",
  thunder_activity: "level2",
  tornado_potential: "potential1",
};

/** 段で塗らない災害の要素の色見本。鍵は源泉が段を宣言していないソースで、要素が増えれば型検査が落ちる。 */
const UNSCALED_SOURCE_SWATCH: Record<Extract<DisasterElement, { levelScale: null }>["source"], string> = {
  liden: palette.semantic.lightning,
};

function disasterSwatch(element: DisasterElement): string {
  return element.levelScale === null
    ? UNSCALED_SOURCE_SWATCH[element.source]
    : levelColor(weatherScales[element.levelScale], SWATCH_LEVEL_KEY[element.levelScale]);
}

/** 災害チップの要素ごとの表示切替。隠した要素は取りに行かない（地図の絞り込みではなく取得を止める）。
 * 行の並びと名前は源泉の要素の宣言のまま。 */
export function disasterSourceLegendAxis(): SceneLegendAxis {
  return {
    layerId: DISASTER_LAYER_ID,
    axisId: DISASTER_LAYER_ID,
    label: "表示する情報",
    entries: [...new Map(DISASTER_ELEMENTS.map((element) => [element.source, element]))].map(([source, element]) => ({
      key: source,
      label: element.label,
      description: element.description ?? undefined,
      color: disasterSwatch(element),
    })),
  };
}
