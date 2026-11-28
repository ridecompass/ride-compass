import { mapDisplay } from "@/types/generated/mapDisplay";

/** 地図のチップの最上位のまとまり（道路・環境・スポット等）の名前。backend の宣言が正本で、画面の文の辞書へ写さない。
 * 「ルート設定」の道路のタブのように、まとまりを名指す画面の文もこれを使う。 */
export const MAP_OVERLAY_GROUP_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  mapDisplay.overlayGroups.map((group) => [group.key, group.label]),
);
