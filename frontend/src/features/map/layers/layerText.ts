// チップの説明の文の差し込み口を埋める。文は源泉（`mapDisplay.layers`の`description`・`panelHint`と、道の線の層の`panel_hint`）が持つ。

import { mapDisplay } from "@/types/generated/mapDisplay";
import type { RoadMapLayerView } from "@/types/route";

/** 源泉の説明の文の差し込み口。 */
type LayerTextSlot =
  | Extract<NonNullable<(typeof mapDisplay.layers)[number]["description" | "panelHint"]>[number], { name: string }>
  | Extract<RoadMapLayerView["panel_hint"][number], { name: string }>;

type LayerTextPart = string | LayerTextSlot;

/** 説明の文の差し込み口の名前（源泉が宣言する）。 */
type LayerTextSlotName = LayerTextSlot["name"];

/** 源泉の説明の文の差し込み口を埋める。値が空の口は、前後の文ごと出さない。 */
export function fillLayerText(
  text: readonly LayerTextPart[],
  values: Readonly<Record<LayerTextSlotName, string>>,
): string {
  return text
    .map((part) => {
      if (typeof part === "string") return part;
      const value = values[part.name];
      return value ? `${part.before}${value}${part.after}` : "";
    })
    .join("");
}

/** 収録年の言い方（連続なら範囲、飛んでいれば並べる）。年は取込の宣言が正本で、軸カタログが運ぶ。 */
export function coverageYearsLabel(years: readonly number[]): string {
  if (years.length === 0) return "";
  const sorted = [...years].sort((a, b) => a - b);
  if (sorted.length === 1) return `${sorted[0]}年`;
  const continuous = sorted.every((year, index) => index === 0 || year === sorted[index - 1] + 1);
  return continuous ? `${sorted[0]}〜${sorted[sorted.length - 1]}年` : `${sorted.join("・")}年`;
}
