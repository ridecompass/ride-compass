import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { BACKEND_INTERNAL_URL } from "./src/lib/backendInternalUrl";
import { backendRewrites, lanHosts, PROD_DATA_API_PREFIX, prodDataBackend } from "./src/lib/backendRewrites";

// 開発機の画面を本番のデータで開くとき（docs/architecture/setup.md「開発機の画面を本番のデータで開く」）の本番の backend。
// 本番の宛先の正本はリポジトリの根の production-origins.json で、像のビルドの場には無いので、切り替えが入ったときだけ読む。
const PROD_DATA_BACKEND = prodDataBackend(process.env, () => {
  const origins = JSON.parse(readFileSync(path.join(process.cwd(), "..", "production-origins.json"), "utf8"));
  return origins.backend as string;
});
// 本番のデータで開くときは、画面の API の宛先を取り次ぎの口にする（本番の backend は開発機の画面のオリジンを CORS で許していない）。
// `.env.local` の値より先に効かせるため、Next.js が `NEXT_PUBLIC_*` を画面へ埋め込む前のここで上書きする。
if (PROD_DATA_BACKEND) process.env.NEXT_PUBLIC_API_URL = PROD_DATA_API_PREFIX;

const nextConfig: NextConfig = {
  output: "standalone",
  // 本番のデータで開くときは、同じ Wi-Fi の端末から開く開発機の LAN の住所も開発サーバーへ入れる。
  ...(PROD_DATA_BACKEND ? { allowedDevOrigins: lanHosts(networkInterfaces()) } : {}),
  // e2eのビルド（npm run build:e2e）だけ型を検査しない。型はCIのfrontendジョブのtsc --noEmitが見る
  // （.claude/skills/run-checks/SKILL.md「E2E・画面の撮影の走らせ方」）。
  typescript: { ignoreBuildErrors: process.env.npm_lifecycle_event === "build:e2e" },
  experimental: {
    // rewritesの外部プロキシ（タイル類）は既定で30秒で打ち切り、backendが処理を完走
    // していてもブラウザへは「フロントエンド発の500」を返す（next/dist/server/lib/router-utils/
    // proxy-request.js）。MapLibreは失敗したタイルを再試行しないため、DBの一時的な混雑等で
    // 30秒を超えた外れ値のタイルは空白のまま残る。通常のタイルは30秒を大きく下回るので、
    // 外れ値だけを救う余裕として延ばす。ミリ秒指定。
    proxyTimeout: 60_000,
  },
  // タイルはフロントエンドと同じオリジンで見せ、backend へ取り次ぐ（どの口をどこへ向けるかは backendRewrites が持つ）。
  async rewrites() {
    return backendRewrites(BACKEND_INTERNAL_URL, PROD_DATA_BACKEND);
  },
};

export default nextConfig;
