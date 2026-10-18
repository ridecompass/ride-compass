// 地図の段の境界（しきい値）のまとめ入力の読み書きと、段の名前を段の数へ合わせる純関数（DOM非依存）。

/** 地図の色分けしきい値のまとめ入力を解釈する。区切りはカンマ（全角含む）・空白・改行・
 * 読点のいずれでもよい——利用者は他所からコピーした並びをそのまま貼るため、区切りの
 * 種類を当てさせない。
 *
 * 昇順・重複はbackendが保存時に検証する（写さない）。
 * 空文字は「1件も無い」（`values: []`）として返し、エラーにはしない——入力欄を空にする
 * 途中の状態を打ち消さないため、その判断は呼び出し側が行う。 */
export function parseThresholdList(text: string): { values: number[]; error: string | null } {
  const tokens = text
    .split(/[,，、\s]+/)
    .map((token) => token.trim())
    .filter((token) => token !== "");
  const values: number[] = [];
  for (const token of tokens) {
    const value = Number(token);
    if (!Number.isFinite(value)) {
      return { values: [], error: `数値として読めない値があります: ${token}` };
    }
    values.push(value);
  }
  return { values, error: null };
}

/** 解釈済みのしきい値を、まとめ入力欄へ表示する文字列へ戻す。 */
export function formatThresholdList(values: readonly number[]): string {
  return values.join(", ");
}

/** 段階ラベルを段階数（しきい値の件数+1）へ合わせる。増えた分は空欄、減った分は末尾から
 * 落とす。しきい値をまとめて入れ替えると段階数が何段階も動くため、1件ずつの増減では
 * 追従しきれない。 */
export function resizeBandLabels(labels: readonly string[], bandCount: number): string[] {
  return Array.from({ length: bandCount }, (_, index) => labels[index] ?? "");
}
