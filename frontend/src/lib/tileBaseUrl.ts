// 地図タイルを取りに行くオリジン。MapLibreはタイルをWeb Workerで取るので、常に絶対URLを返す。
export function tileBaseUrl(): string {
  return resolveTileBaseUrl(
    process.env.NEXT_PUBLIC_TILE_BASE_URL,
    typeof window !== "undefined" ? window.location.origin : null,
  );
}

/** 設定があれば末尾の`/`を外した設定、無ければ画面のオリジン（サーバー側の描画では空文字）。 */
export function resolveTileBaseUrl(configured: string | undefined, origin: string | null): string {
  if (configured) {
    return configured.replace(/\/+$/, "");
  }
  return origin ?? "";
}
