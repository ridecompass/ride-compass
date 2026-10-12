// 数の丸めと、差の符号の書き方。

/** 値を小数`digits`桁へ丸める。 */
export function roundToDigits(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

/** 差の前に置く符号。正は「+」、負は「−」（U+2212。ハイフンより数字の幅に揃う）、0は付けない。 */
export function signMark(value: number): string {
  if (value > 0) return "+";
  if (value < 0) return "−";
  return "";
}
