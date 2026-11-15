import { LIVE_API, LIVE_POINT, decodeRoadTile, tileOf } from "./live";
import regionTileConfig from "@/types/generated/region-tile-config.json";

// 前提の不成立（backendが動いていない・起点が取込範囲外・予報が古い）を最初に確かめ、
// 個々のテストの失敗として出さずに「前提不成立: 何を直せばよいか」で止める。テストの失敗は壊れ方の検知だけにする。

class Unmet extends Error {
  constructor(what: string, fix: string) {
    super(`前提不成立: ${what}。${fix}`);
  }
}

export default async function globalSetup(): Promise<void> {
  const health = await fetch(`${LIVE_API}/health`).catch(() => null);
  if (!health?.ok) {
    throw new Unmet(
      `${LIVE_API}/health に応答が無い`,
      "開発DBへ向けたbackendを手元で起動するか、E2E_LIVE_API を本番のbackendへ向ける（.claude/skills/run-checks/SKILL.md「E2E・画面の撮影の走らせ方」）",
    );
  }

  const { z, x, y } = tileOf(regionTileConfig.road_tile_max_zoom, LIVE_POINT);
  const tile = await fetch(`${LIVE_API}/api/region/road-surface-tiles/${z}/${x}/${y}.pbf`);
  const roads = tile.ok ? decodeRoadTile(Buffer.from(await tile.arrayBuffer())) : [];
  if (roads.length === 0) {
    throw new Unmet(
      `起点（${LIVE_POINT.latitude},${LIVE_POINT.longitude}）の路面タイル ${z}/${x}/${y} に道が無い（HTTP ${tile.status}）`,
      "backendのDBの取込範囲の中の地点を E2E_LIVE_POINT=緯度,経度 で与える",
    );
  }

  // 予報（MSM）が古いと、時刻を入力に取る軸の値が来ないのは欠陥ではない。S3の該当の枝はこれを見て判定をやめる。
  const stats = (await (await fetch(`${LIVE_API}/api/debug/stats`)).json()) as { msm: { healthy: boolean } | null };
  process.env.E2E_LIVE_MSM_HEALTHY = stats.msm?.healthy ? "1" : "0";
}
