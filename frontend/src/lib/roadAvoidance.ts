import palette from "@/types/generated/palette.json";
import type { RoadAvoidanceOverride, RoadAvoidanceView } from "@/types/route";

// 道の区分の行ごとの避け方。**行・段・既定は画面の設定（`road_classes.avoidance`）が配る**。端末に覚えるのは利用者が選んだ段
// だけで、要求へもそのまま送る——足りない行の既定の段はbackendが今の行へ揃える（画面の設定が届く前に送っても、選んだ段が
// 落ちない）。

export type AvoidanceLevel = RoadAvoidanceOverride[string];
export type AvoidanceRow = RoadAvoidanceView["rows"][number];

/** 道路タブの段を地図の道に塗る色（道路タブの凡例と地図の線が同じものを読む）。通るは塗らない（何も指定していない扱い）。 */
export const AVOIDANCE_LEVEL_COLORS: Readonly<Record<Exclude<AvoidanceLevel, "pass">, string>> = {
  prefer: palette.semantic.road_avoidance_prefer,
  avoid: palette.semantic.road_avoidance_avoid,
  exclude: palette.semantic.road_avoidance_exclude,
};

/** 道路タブの「地図で見る」（道路タブを出している間、段を地図の道に塗るか。端末に覚える）と、塗っている間に塗れない理由
 * （拡大が足りない・取れない等。無ければnull）。地図の見え方が持ち、道路タブへ渡す。 */
export interface RoadTabMap {
  on: boolean;
  onChange: (on: boolean) => void;
  notice: string | null;
}

/** 画面に出す行の段。選んでいなければ既定の段。 */
export function avoidanceLevelOf(row: AvoidanceRow, chosen: RoadAvoidanceOverride): AvoidanceLevel {
  return chosen[row.key] ?? row.default;
}

/** 道路タブで「通る」以外にした行の段（行の鍵`<分け方>.<区分>` → 段。選んでいなければ既定の段）と、段の強さの並び（画面の設定の
 * `levels`の並び。倍率の小さい順で、後ろほど強い）。 */
export interface AvoidanceChoice {
  readonly levels: ReadonlyMap<string, AvoidanceLevel>;
  readonly order: readonly AvoidanceLevel[];
}

export function avoidanceChoiceOf(avoidance: RoadAvoidanceView, chosen: RoadAvoidanceOverride): AvoidanceChoice {
  const levels = new Map<string, AvoidanceLevel>();
  for (const row of avoidance.rows) {
    const level = avoidanceLevelOf(row, chosen);
    if (level !== "pass") levels.set(row.key, level);
  }
  return { levels, order: avoidance.levels.map((level) => level.key) };
}

/** 道の区分（分け方 → 区分の鍵）に当たる行の段のうち、いちばん強いもの（1つの道が見出しごとに複数の行に当たれば強い方が勝つ。
 * 通るは何も指定していない扱いなので数えない。backendが費用に掛ける段と同じ決め方）。どの行にも当たらなければ null。 */
export function strongestAvoidance(
  classes: Readonly<Record<string, string>>,
  choice: AvoidanceChoice,
): AvoidanceLevel | null {
  let strongest: AvoidanceLevel | null = null;
  for (const [classification, classKey] of Object.entries(classes)) {
    const level = choice.levels.get(`${classification}.${classKey}`);
    if (level !== undefined && (strongest === null || choice.order.indexOf(level) > choice.order.indexOf(strongest))) {
      strongest = level;
    }
  }
  return strongest;
}
