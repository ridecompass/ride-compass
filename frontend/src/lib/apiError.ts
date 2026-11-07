// FastAPIの`detail`は文字列か、入力の検証の失敗（422）では`[{msg, ...}, ...]`の配列で来る。そのまま
// 文字列にすると"[object Object]"になるので、文言を取り出す。
export function formatErrorDetail(detail: unknown): string | undefined {
  if (detail == null) return undefined;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const messages = detail.flatMap((item) =>
      item && typeof item === "object" && "msg" in item ? [String(item.msg)] : [],
    );
    if (messages.length > 0) return messages.join(" / ");
  }
  return JSON.stringify(detail);
}

/** 捕まえた例外を画面へ出す文言にする。`Error`以外が投げられたら`fallback`、無ければその値を文字列にする。 */
export function errorMessage(error: unknown, fallback?: string): string {
  if (error instanceof Error) return error.message;
  return fallback ?? String(error);
}
