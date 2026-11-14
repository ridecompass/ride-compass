// 絞り込めない表示専用の凡例（配信元が色を焼き込んだラスタ等）。絞り込める凡例は`scene/legends.ts`が出す。

import weatherScales from "@/types/generated/weather-scales.json";
import { mapDisplay } from "@/types/generated/mapDisplay";
import type { StaticMapLayerId } from "@/components/ui/icons/mapLayerIcons";
import type { LegendEntry } from "@/lib/mapDisplay/legendFilter";
import { LANDCOVER_PAINTED_CLASSES } from "@/lib/mapDisplay/landcoverClasses";
import { PRECIPITATION_INTENSITY_LEVELS, PRECIPITATION_LEGEND_HEADING } from "./precipitationNowcast";
import { WIND_SPEED_LEGEND_LEVELS } from "./windLayer";
import { DISASTER_ELEMENTS } from "./dynamicWeather";

/** 表示専用の凡例の1ブロック。 */
export interface ReadOnlyLegendBlock {
  /** ブロックの見出し。単一ブロックのレイヤーは空文字列。 */
  label: string;
  legend: readonly LegendEntry[];
}

type WeatherElementDeclaration = (typeof mapDisplay.weatherElements)[number];

/** 名前の並び。同じ名前を名乗る要素（描き方違いの同じ名前付きソース）は1つにする。 */
function labelList(elements: readonly WeatherElementDeclaration[]): string {
  return [...new Set(elements.map((element) => element.label))].join("・");
}

/** 災害の凡例。同じ段で塗る要素の名前を見出しにして、段を並べる（並びは要素が最初に現れた順）。 */
function disasterLegendBlocks(): ReadOnlyLegendBlock[] {
  const scales = [...new Set(DISASTER_ELEMENTS.flatMap((element) => element.levelScale ?? []))];
  return scales.map((scale) => ({
    label: labelList(DISASTER_ELEMENTS.filter((element) => element.levelScale === scale)),
    legend: weatherScales[scale],
  }));
}

type LegendColoredElement = Extract<WeatherElementDeclaration, { legendColor: string }>;

/** 降水の凡例のうち、凡例の色を持つ要素の行。同じ名前の要素（描き方・時刻の段の違い）は、先に現れた要素の1ブロックにする。 */
function precipitationElementLegendBlocks(): ReadOnlyLegendBlock[] {
  const byLabel = new Map<string, LegendColoredElement>();
  for (const element of mapDisplay.weatherElements) {
    if (element.group !== "precipitationNowcast" || element.legendColor === null) continue;
    if (!byLabel.has(element.label)) byLabel.set(element.label, element);
  }
  return [...byLabel.values()].map((element) => ({
    label: element.label,
    legend: [{ key: element.source, label: element.description, color: element.legendColor }],
  }));
}

export const READ_ONLY_LEGENDS: Partial<Record<StaticMapLayerId, readonly ReadOnlyLegendBlock[]>> = {
  landcover: [
    {
      label: "",
      legend: LANDCOVER_PAINTED_CLASSES.map((cls) => ({
        key: cls.percentField,
        label: cls.label,
        description: cls.description,
        color: cls.color,
      })),
    },
  ],
  // 1つのチップのまま、時刻の段ごとに配信元を切り替える（段は源泉が宣言する）。
  precipitationNowcast: [
    {
      label: PRECIPITATION_LEGEND_HEADING,
      legend: PRECIPITATION_INTENSITY_LEVELS,
    },
    ...precipitationElementLegendBlocks(),
  ],
  // 道路の色分け（向かい風・追い風）と別の配色なので、凡例は「矢印[風速]」と明示する。
  windVector: [
    {
      label: "矢印[風速]",
      legend: WIND_SPEED_LEGEND_LEVELS,
    },
  ],
  // 配信元が色を焼き込んだ画像なので絞り込めない。
  disaster: disasterLegendBlocks(),
};
