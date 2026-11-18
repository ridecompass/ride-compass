import type { MapTheme } from "@/lib/mapTheme";
import type { RoadAvoidanceOverride, RoadAvoidanceView } from "@/types/route";

// 道の区分の行ごとの避け方。**行・段・既定と段の色は画面の設定（`road_classes.avoidance`）が配る**。端末に覚えるのは利用者が
// 選んだ段だけで、要求へもそのまま送る——足りない行の既定の段はbackendが今の行へ揃える（画面の設定が届く前に送っても、選んだ段が
// 落ちない）。

export type AvoidanceLevel = RoadAvoidanceOverride[string];
export type AvoidanceRow = RoadAvoidanceView["rows"][number];
export type AvoidanceLevelView = RoadAvoidanceView["levels"][number];

/** 道路タブの「地図で見る」（道路タブを出している間、段を地図の道に塗るか。端末に覚える）と、塗っている間に塗れない理由
 * （拡大が足りない・取れない等。無ければnull）。地図の見え方が持ち、道路タブへ渡す。 */
export interface RoadTabMap {
  on: boolean;
  onChange: (on: boolean) => void;
  notice: string | null;
}

/** 段が地図に塗る色を持つか。持たない段は何も指定していない扱い。 */
export function isPainted(level: AvoidanceLevelView): level is AvoidanceLevelView & { color: string } {
  return level.color !== null;
}

/** 画面に出す行の段。選べない行と、選んでいない行は既定の段。 */
export function avoidanceLevelOf(row: AvoidanceRow, chosen: RoadAvoidanceOverride): AvoidanceLevel {
  return (row.selectable ? chosen[row.key] : undefined) ?? row.default;
}

/** 地図に塗る段（並びは画面の設定の`levels`の並びで、1つの道がいくつもの行に当たれば後ろの段が効く。`color`は地の明るさに
 * 合わせた色）と、段ごとにその段にした行（タイルのプロパティ`section`の値`classKey`）。 */
export interface AvoidanceChoice {
  readonly levels: readonly { readonly key: AvoidanceLevel; readonly color: string }[];
  readonly rows: readonly { readonly section: string; readonly classKey: string; readonly level: AvoidanceLevel }[];
}

export function avoidanceChoiceOf(
  avoidance: RoadAvoidanceView,
  chosen: RoadAvoidanceOverride,
  theme: MapTheme,
): AvoidanceChoice {
  const levels = avoidance.levels
    .filter(isPainted)
    .map((level) => ({ key: level.key, color: theme === "dark" ? (level.color_on_dark ?? level.color) : level.color }));
  const painted = new Set(levels.map(({ key }) => key));
  const rows = avoidance.rows.flatMap((row) => {
    const level = avoidanceLevelOf(row, chosen);
    return painted.has(level) ? [{ section: row.section, classKey: row.class_key, level }] : [];
  });
  return { levels, rows };
}

/** 区間が通る、段の付いた（地図に塗る）道の区分の行1つ。 */
export interface PaintedStretch {
  /** 行の載るまとまりの名前（道路タブの見出し）。 */
  readonly section: string;
  readonly row: AvoidanceRow;
  readonly level: AvoidanceLevelView & { color: string };
  /** 区間の中でその区分を通る長さ（km）。 */
  readonly km: number;
}

/**
 * 区間の道の区分の長さ（応答の`road_classes`）のうち、生成に使った避け方（`applied`）で段の付いた行を、画面の設定の行の並びで返す。
 * 地図のルートの両脇の線（好む・避けるの区間）が、どの区分から出たかを見せるのに使う。段の向き（好む・避ける）は段の名前と色が示す。
 */
export function paintedStretches(
  roadClasses: Readonly<Record<string, readonly { distance_km: number; value: string | null }[]>>,
  applied: RoadAvoidanceOverride,
  view: RoadAvoidanceView,
): PaintedStretch[] {
  return view.rows.flatMap((row) => {
    const level = view.levels.find((candidate) => candidate.key === avoidanceLevelOf(row, applied));
    if (level === undefined || !isPainted(level)) return [];
    const km = (roadClasses[row.section] ?? [])
      .filter((part) => part.value === row.class_key)
      .reduce((sum, part) => sum + part.distance_km, 0);
    if (km <= 0) return [];
    const section = view.sections.find((candidate) => candidate.key === row.section)?.label ?? row.section;
    return [{ section, row, level, km }];
  });
}
