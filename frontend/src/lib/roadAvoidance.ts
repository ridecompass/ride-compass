import palette from "@/types/generated/palette.json";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";
import type { RoadAvoidanceOverride, RoadAvoidanceView } from "@/types/route";

// 道の区分の行ごとの避け方。**行・段・既定は画面の設定（`road_classes.avoidance`）が配る**。端末に覚えるのは利用者が選んだ段
// だけで、要求へもそのまま送る——足りない行の既定の段はbackendが今の行へ揃える（画面の設定が届く前に送っても、選んだ段が
// 落ちない）。

export type AvoidanceLevel = RoadAvoidanceOverride[string];
export type AvoidanceRow = RoadAvoidanceView["rows"][number];

/** 道路タブの段を地図の道に塗る色（道路タブの凡例と地図の線が同じものを読む）。通るは楽でも苦でもない（何も指定していない）ので
 * 塗らない。 */
export const AVOIDANCE_LEVEL_COLORS: Readonly<Record<Exclude<AvoidanceLevel, "pass">, string>> = {
  prefer: palette.semantic.road_avoidance_prefer,
  slight_prefer: palette.semantic.road_avoidance_slight_prefer,
  slight_avoid: palette.semantic.road_avoidance_slight_avoid,
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

/** 道路タブで「通る」以外にした行（分け方`section`の区分`classKey`と段。選んでいなければ既定の段）と、段の強さの並び（画面の設定の
 * `levels`の並び。倍率の小さい順で、後ろほど強い）。1つの道が見出しごとに複数の行に当たれば強い段が勝ち、どの行にも当たらない道は
 * 通る（backendが費用に掛ける段と同じ決め方）。 */
export interface AvoidanceChoice {
  readonly rows: readonly { readonly section: string; readonly classKey: string; readonly level: AvoidanceLevel }[];
  readonly order: readonly AvoidanceLevel[];
}

/** 0次ハードフィルタ（道路タブの上の固定の行）は、いつも通らない。路面タイルは道の当たるフィルタの名前を、区分の分け方と別の
 * プロパティに載せる。 */
const HARD_FILTER_ROWS: AvoidanceChoice["rows"] = routeGenerateConfig.hard_filters.map(({ key }) => ({
  section: routeGenerateConfig.hard_filter_property,
  classKey: key,
  level: "exclude",
}));

export function avoidanceChoiceOf(avoidance: RoadAvoidanceView, chosen: RoadAvoidanceOverride): AvoidanceChoice {
  const rows = avoidance.rows.flatMap((row) => {
    const level = avoidanceLevelOf(row, chosen);
    return level === "pass" ? [] : [{ section: row.section, classKey: row.class_key, level }];
  });
  return { rows: [...HARD_FILTER_ROWS, ...rows], order: avoidance.levels.map((level) => level.key) };
}
