// パスのテンプレートの`{名前}`。backendのOpenAPIのパスと、気象庁の配信のパスが同じ書き方を使う。

/** テンプレートの`{名前}`の1つ（名前を捕まえる）。`String.prototype.split`に渡すと、名前が奇数番目に並ぶ。 */
export const TEMPLATE_PLACEHOLDER = /\{([^}]+)\}/g;

/** `{名前}`を`values`の値で埋める。値はそのまま埋める（区切りの`/`を含めてよい）。`values`に無い名前は`{名前}`のまま
 * 残す——タイルの`{z}/{x}/{y}`は地図ライブラリが埋める。 */
export function fillTemplate(template: string, values: Partial<Record<string, string | number>>): string {
  return template.replace(TEMPLATE_PLACEHOLDER, (whole, name: string) => {
    const value = values[name];
    return value === undefined ? whole : String(value);
  });
}
