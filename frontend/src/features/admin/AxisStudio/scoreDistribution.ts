// 生値の分布を地図の段ごとの延長割合へまとめる純関数（DOM非依存）。
//
// backendは折れ点を通す前の生値のヒストグラムを返し（重い集計のため折れ点を動かしても取り直さない）、
// 各階級の代表値の点数は別の軽い問い合わせ（`useScoresPreview`、評価と同じ計算）が返す。ここは届いた点数を
// 段へ振り分けるだけで、点数を計算しない。

/** `POST /api/admin/axis-definitions/preview-distribution`の応答本体。
 *
 * backendの`ValueDistribution`をそのまま使う（手書きで写すと、フィールドを足した
 * ときに片側だけ古くなる。`bins`は[階級の下限, 上限, その階級が占める延長の割合]）。 */
import { bandAt, type ValueBand } from "@/lib/mapDisplay/valueScale";
import type { components } from "@/types/generated/api";
import { vocabulary } from "@/types/generated/vocabulary";

export type ValueDistribution = components["schemas"]["ValueDistribution"];

/** 分位点の名前（小さい比率から）。応答の`quantiles`の鍵はこの名前で、並びはbackendの語彙（生成物）が持つ。 */
export type QuantileName = (typeof vocabulary.quantiles)[number];

/** 分布の各階級の代表値（中央）。階級幅は分布全体を等分したもので、この粒度より細かい折れ点の差は画面上の
 * 意味を持たない。この値の点数を問い合わせ、`mapBandShares`へ渡す。 */
export function binMidpoints(distribution: ValueDistribution | null): number[] {
  return (distribution?.bins ?? []).map(([lower, upper]) => (lower + upper) / 2);
}

/** 分布の階級ごとの点数（`binMidpoints`の順）を、地図の段（低い段から）ごとの延長割合へまとめる。段への振り分けは地図と
 * 同じ`bandAt`。点数が届いていない・階級と数が合わない間はnull（前の折れ点の点数を今の分布へ当てない）。 */
export function mapBandShares(
  distribution: ValueDistribution,
  binScores: readonly number[] | null,
  bands: readonly ValueBand[],
): number[] | null {
  if (binScores === null || binScores.length !== distribution.bins.length) return null;
  const shares = bands.map(() => 0);
  for (const [i, [, , share]] of distribution.bins.entries()) {
    shares[bands.indexOf(bandAt(bands, binScores[i]))] += share;
  }
  return shares;
}

/** 種類の材料の値ごとの延長の割合を、対応表の点数で地図の段（低い段から）ごとの延長割合へまとめる。対応表に無い値の道は
 * 評価されず地図に塗られないので数えず、点数の付く道の延長で割る。点数の付く道が無ければ全段0。 */
export function categoryBandShares(
  valueShares: readonly { value: string; share: number }[],
  mapping: Readonly<Record<string, number>>,
  bands: readonly ValueBand[],
): number[] {
  const shares = bands.map(() => 0);
  let scored = 0;
  for (const { value, share } of valueShares) {
    if (!Object.hasOwn(mapping, value)) continue;
    shares[bands.indexOf(bandAt(bands, mapping[value]))] += share;
    scored += share;
  }
  return scored > 0 ? shares.map((share) => share / scored) : shares;
}
