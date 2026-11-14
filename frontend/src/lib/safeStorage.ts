// 端末の保存値（localStorage）の読み書きの口。保存値はJSONで書き、JSONとして読む。失敗（ブラウザが断る・容量の上限・
// JSONでない）は、どの保存値かを添えた`StoredValueError`にして投げ、その値を使う操作・画面が出す。保存されていないことだけは
// 失敗でなく、読むとnull。

/** 端末の保存値`label`（画面の名前）を読めなかった・書けなかったこと。メッセージは利用者へそのまま出せる形（鍵は出さない）。 */
export class StoredValueError extends Error {
  constructor(operation: "read" | "write", label: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`端末に保存した${label}を${operation === "read" ? "読めませんでした" : "保存できませんでした"}[${reason}]`, {
      cause,
    });
    this.name = "StoredValueError";
  }
}

/** 保存値`label`を読む。保存されていなければnull。 */
export function readStored<T>(key: string, label: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch (error) {
    throw new StoredValueError("read", label, error);
  }
}

/** 保存値`label`を書く。 */
export function writeStored(key: string, label: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    throw new StoredValueError("write", label, error);
  }
}

/** 保存値を消す。 */
export function removeStoredValue(key: string): void {
  localStorage.removeItem(key);
}

/** 端末の保存値を、鍵が`keepPrefixes`のどれかで始まるものを除いて全部消し、保存されていない状態へ戻す（画面のエラーの境目が出す。
 * 古い形の保存値で落ちたときも、どの値かを知らずに抜けられる）。 */
export function clearStoredValues(keepPrefixes: readonly string[]): void {
  const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
  for (const key of keys) {
    if (key !== null && !keepPrefixes.some((prefix) => key.startsWith(prefix))) localStorage.removeItem(key);
  }
}
