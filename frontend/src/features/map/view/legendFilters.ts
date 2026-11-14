/** 凡例で隠した行の保存先の読み書き。
 *
 * 保存先は画面に1つだけで、レンズ・地図上チップの▶パネル・「絞り込みをすべて解除」の
 * どこから操作しても同じ場所を読み書きする。鍵は凡例を出す側の宣言が決める。
 */
import type { HiddenLegendKeys } from "./mapLook";

const NONE: readonly string[] = [];

export function hiddenKeysOf(store: HiddenLegendKeys, axisId: string): readonly string[] {
  return store[axisId] ?? NONE;
}

/** 空にした軸も空の並びとして残す——消すと、最初に隠す行を持つ軸が次の訪問でまた隠れる。 */
export function withHiddenKeys(store: HiddenLegendKeys, axisId: string, keys: readonly string[]): HiddenLegendKeys {
  return { ...store, [axisId]: keys };
}

export function toggleHiddenKey(store: HiddenLegendKeys, axisId: string, key: string): HiddenLegendKeys {
  const current = hiddenKeysOf(store, axisId);
  return withHiddenKeys(store, axisId, current.includes(key) ? current.filter((k) => k !== key) : [...current, key]);
}

/** 凡例の全段をまとめて切り替えたあとの隠す段。1つのチェックで両方向を兼ねる（全部表示中なら全部隠し、1つでも
 * 隠れていれば全部出す）。 */
export function hiddenAfterToggleAll(legend: readonly { key: string }[], hidden: readonly string[]): string[] {
  return hidden.length === 0 ? legend.map((entry) => entry.key) : [];
}

/** いま描いている凡例に実在する鍵だけ。保存先は段の綴りや段数が変わる前の値も持ちうるため、
 * 保存値の長さをそのまま使うと、隠れた段が無いのに絞り込み中に見える。 */
export function presentHiddenKeys(legend: readonly { key: string }[], hidden: readonly string[]): readonly string[] {
  return hidden.filter((key) => legend.some((entry) => entry.key === key));
}
