/** 道の線で描く属性と、その凡例の行（分類・その他／該当なし・データなし）。地図の線・地図の凡例・道のりのグラフの帯が
 * 同じ行を読む——別々に持つと、同じ道が地図と帯で違う色・呼び名になる。 */
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";
import { primaryAttributes } from "@/types/generated/primaryAttributes";

import { NO_DATA_LEGEND_BAND } from "@/lib/mapDisplay/mapColorLegend";

/** 線で描くもの。**源泉が「線の幾何を持ち、表示の定義がある」と言ったものが出る。**
 * 束ね方・行の名前・並び・色はすべて源泉が決め、ここは受け取って塗るだけ
 * （`backend/app/domain/primary_attributes.py: display_axes`、色は`display_palette.py`）。 */
export const ROAD_TRACKS = primaryAttributes.filter(
  (attr): attr is Extract<typeof attr, { geometry: "line"; tile_kind: string }> =>
    attr.geometry === "line" && attr.display_axes.length > 0,
);

export type RoadTrack = (typeof ROAD_TRACKS)[number];

/** 線は軸を1本しか持たない（プロパティ＝属性そのもの）。**軸を持つものだけを線にする**のは
 * 源泉の側で、そこが保証する（`tests/test_material_catalog.py`）。 */
export function roadTrackAxis(track: RoadTrack): RoadTrack["display_axes"][number] {
  return track.display_axes[0];
}

/** 値の無い道がタイルに現れうるか。**源泉の宣言が決める**（その値を載せる材料の欠け方`missing_semantics`）
 * ——トンネル・一方通行のように、タグの不在も「該当しない」という確定した値として載る属性がある。 */
export function roadTrackHasMissing(track: RoadTrack): boolean {
  return roadTrackAxis(track).missing_semantics === "unknown";
}

/** 凡例の「その他」（タグはあるが、どの分類にも当てはまらない値）の鍵。分類の鍵・「不明」の鍵と重ならない
 * （`legends.test.ts`が全属性で確かめる）。 */
export const ROAD_OTHER_KEY = "other";

export type RoadTrackRow = {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly color: string;
  readonly isFallback?: boolean;
};

/** 分類に当てはまらない値の道の行。タグの不在も確定した値として載る属性（トンネル等）では、それが「該当しない」
 * ことそのものなので呼び方を変える。 */
function otherRow(track: RoadTrack): RoadTrackRow {
  const row = roadTrackHasMissing(track)
    ? mapDisplay.legendSharedRows.other
    : mapDisplay.legendSharedRows.notApplicable;
  return { key: ROAD_OTHER_KEY, ...row, color: palette.semantic.no_data };
}

/** 凡例の行の並び。分類、その他（該当なし）、タグが無い道が現れうる属性ではデータなし。 */
export function roadTrackRows(track: RoadTrack): readonly RoadTrackRow[] {
  return [
    ...roadTrackAxis(track).categories.map((category) => ({
      key: category.key,
      label: category.label,
      description: category.description,
      color: category.color,
    })),
    otherRow(track),
    ...(roadTrackHasMissing(track) ? [NO_DATA_LEGEND_BAND] : []),
  ];
}

/** 道の値`value`が入る凡例の行。値が無ければ、タグが無い道が現れうる属性ではデータなし、ほかは該当なし。 */
export function roadTrackRowOf(track: RoadTrack, value: string | boolean | null): RoadTrackRow {
  if (value === null) return roadTrackHasMissing(track) ? NO_DATA_LEGEND_BAND : otherRow(track);
  const category = roadTrackAxis(track).categories.find((candidate) =>
    (candidate.values as readonly (string | boolean)[]).includes(value),
  );
  if (category === undefined) return otherRow(track);
  return { key: category.key, label: category.label, description: category.description, color: category.color };
}
