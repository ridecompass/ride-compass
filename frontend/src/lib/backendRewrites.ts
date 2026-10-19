// next.config.ts の取り次ぎ（rewrites）の組み立てと、開発機の画面を本番のデータで開く切り替えの判断。
// next.config.ts は Next.js のパスの別名より前に読まれるので、ここは相対 import だけで書く。
import type { NetworkInterfaceInfo } from "node:os";

export interface Rewrite {
  source: string;
  destination: string;
}

// 同じ住所経由で backend へ取り次ぐタイルの口。どれも MapLibre がパン・ズームのたびに多数取りに行くので、
// API の呼び出しと同じ backend のオリジンから取ると、ブラウザのオリジンごとの同時接続の上限を埋めて API が詰まる。
// JMA のタイルは、ブラウザから JMA へ直接取りに行くと利用者の数だけ JMA への要求が増えるので、backend のキャッシュを通す。
const TILE_PATHS = [
  "/api/region/road-surface-tiles",
  "/api/region/point-tiles",
  "/api/region/landcover-tiles",
  "/api/jma-tile",
  "/api/gsi-relief-tile",
] as const;

const DERIVED_DATABASE_PATH = "/api/derived-database";

/** 本番のデータで開くとき、API の呼び出しを本番の backend へ取り次ぐ口。画面の API の宛先（NEXT_PUBLIC_API_URL）にこれを置く。 */
export const PROD_DATA_API_PREFIX = "/prod";

/**
 * 本番のデータで開くときの本番の backend の住所。切り替え（`RC_PROD_DATA=1`）が入った開発サーバーのときだけ返し、
 * 本番の像のビルド（`NODE_ENV=production`）では入っていても null にする。住所は読むときだけ引く（像のビルドの場には住所の正本が無い）。
 */
export function prodDataBackend(
  env: { RC_PROD_DATA?: string; NODE_ENV?: string },
  productionBackend: () => string,
): string | null {
  if (env.RC_PROD_DATA !== "1" || env.NODE_ENV === "production") return null;
  return productionBackend();
}

/**
 * 取り次ぎの一覧。本番のデータで開くときは、タイルと API の呼び出しを本番の backend へ向ける。
 * 地図の下地だけは開発機の backend から取る（本番の下地のスタイルは本番の backend の住所を中に持ち、画面から直接は読めない）。
 */
export function backendRewrites(internalBackend: string, prodData: string | null): Rewrite[] {
  const tiles = prodData ?? internalBackend;
  return [
    { source: "/api/basemap/:path*", destination: `${internalBackend}/api/basemap/:path*` },
    ...TILE_PATHS.map((path) => ({ source: `${path}/:path*`, destination: `${tiles}${path}/:path*` })),
    // 地図の出典表記が同じオリジンの相対の住所でリンクする、派生データベースの書き出し。
    { source: DERIVED_DATABASE_PATH, destination: `${tiles}${DERIVED_DATABASE_PATH}` },
    ...(prodData ? [{ source: `${PROD_DATA_API_PREFIX}/:path*`, destination: `${prodData}/:path*` }] : []),
  ];
}

/** 同じ Wi-Fi の端末から開発サーバーを開くときの、開発機の LAN の住所（外へ出る IPv4 のうちプライベートの範囲のもの）。 */
export function lanHosts(interfaces: Record<string, NetworkInterfaceInfo[] | undefined>): string[] {
  return Object.values(interfaces)
    .flatMap((addresses) => addresses ?? [])
    .filter((a) => a.family === "IPv4" && !a.internal && isPrivateIPv4(a.address))
    .map((a) => a.address);
}

function isPrivateIPv4(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
