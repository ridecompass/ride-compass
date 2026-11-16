/** 図の左上を原点にした箱（px）。 */
export type Box = { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number };

/** 札の置き方の入力。札を印の真下の真ん中に置いたときの横の中心・上の端と、札の大きさ（px、図の左上が原点）。 */
export type LabelSpot = {
  readonly centerX: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

/** 札を真下の真ん中から動かす量（px）。`y`がnullの札は、どこへ置いても重なるので見せない（横は図の内側へ寄せたまま）。 */
export type LabelShift = { readonly x: number; readonly y: number | null };

/** 札どうし・札と図の文字の間に空ける幅（px）。くっつくと2つの時刻が1つの文に読める。 */
const GAP_PX = 2;

/** 札を置く段の数（真下の段と、その下に札1つ分ずらした段）。 */
const ROWS = 2;

/** 上下に許す重なり（px）。文字の行の箱は字の上下に余白を持つので、この幅の重なりは字に届かない。 */
const SLACK_PX = 2;

const overlaps = (a: Box, b: Box) =>
  a.left < b.right + GAP_PX && b.left < a.right + GAP_PX && a.top < b.bottom - SLACK_PX && b.top < a.bottom - SLACK_PX;

/**
 * 着く時刻の札の置き方。左の札から順に、横は図の内側へ寄せ、先に置いた札・図の文字（`obstacles`）と重なれば下の段へずらし、
 * 図の下の端まで重ならずに置ける段が無ければ見せない。戻り値は`spots`と同じ並び。
 */
export function placeArrivalLabels(
  spots: readonly LabelSpot[],
  chart: { readonly width: number; readonly height: number },
  obstacles: readonly Box[],
): LabelShift[] {
  const placed: Box[] = [...obstacles];
  const shifts: LabelShift[] = spots.map(() => ({ x: 0, y: null }));
  const order = spots.map((_, index) => index).sort((a, b) => spots[a].centerX - spots[b].centerX);
  for (const index of order) {
    const { centerX, top, width, height } = spots[index];
    const left = Math.min(Math.max(centerX - width / 2, 0), Math.max(chart.width - width, 0));
    shifts[index] = { x: left - (centerX - width / 2), y: null };
    for (let row = 0; row < ROWS; row++) {
      const box = { left, right: left + width, top: top + row * height, bottom: top + (row + 1) * height };
      if (box.bottom > chart.height + SLACK_PX || placed.some((other) => overlaps(box, other))) continue;
      placed.push(box);
      shifts[index] = { ...shifts[index], y: row * height };
      break;
    }
  }
  return shifts;
}
