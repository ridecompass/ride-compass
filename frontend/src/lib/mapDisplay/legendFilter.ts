// 凡例の1行。道路の線の分類とルートの色分けのモード（routeStyleModes.ts）が同じ凡例UI・
// 絞り込みの仕組みを共有するため、両方が読むこの層に置く。

import type { primaryAttributes } from "@/types/generated/primaryAttributes";

type DisplayCategory = (typeof primaryAttributes)[number]["display_axes"][number]["categories"][number];

/** 源泉が点の行に付ける絵記号の名前。 */
export type PointGlyph = Extract<DisplayCategory, { glyph: string }>["glyph"];

export interface LegendEntry {
  /** カテゴリの安定識別子（表示/非表示状態のキー。ラベル文言の変更に影響されない） */
  key: string;
  color: string;
  label: string;
  /** 行の（i）から開く、この行に何が入るかの説明。行を宣言しているbackendの宣言が持ち、画面は書かない。
   * 持たない行（数の範囲の段・名前が説明そのものの行）には（i）を出さない。 */
  description?: string;
  /** 大きさで意味を示す行の見本の直径。持つ行は色ではなく大きさを見せる（地図の点と同じ大きさ）。`glyph`も持てば、その絵の外形で見せる。 */
  diameterPx?: number;
  /** 地図で線として描く行か。見本を地図と同じ線の形で見せる（持たない行は点の形）。 */
  line?: true;
  /** 地図でこの絵記号で描く行。見本も同じ形で見せる（線の絵記号は角丸の四角の枠に載せ、標識の絵記号は標識の形）。 */
  glyph?: PointGlyph;
  /** この地物がカテゴリに属するときtrueになるMapLibre式（凡例フィルタ用の述語）。
   * 絞り込みを自分で持つレイヤー（scene のグループが宣言するもの）は持たない。 */
  filter?: unknown[];
  /** 値が無いものの受け皿（不明・データなし）の行か。段の並びには数えない。 */
  isFallback?: boolean;
}

/** 凡例の色見本の縁取り（className）。見本を描くところはどれもこれを付ける。 */
export const LEGEND_SWATCH_RING_CLASS = "ring-1 ring-[var(--foreground)]";

/** 凡例の色見本の塗り。値が無い行は、地図の破線と同じく途切れた見本にする。 */
export function legendSwatchBackground(entry: LegendEntry): string {
  if (entry.isFallback !== true) return entry.color;
  return `repeating-linear-gradient(90deg, ${entry.color} 0 3px, transparent 3px 5px)`;
}
