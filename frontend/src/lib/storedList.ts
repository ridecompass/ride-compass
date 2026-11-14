/** 一覧へ1件を入れる。`replaces`が真を返す件を置き換え、入れた件を先頭に置く（最近保存したものほど上）。 */
export function withEntryFirst<T>(list: readonly T[], entry: T, replaces: (saved: T) => boolean): T[] {
  return [entry, ...list.filter((saved) => !replaces(saved))];
}
