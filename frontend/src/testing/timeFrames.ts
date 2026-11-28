// 時刻で変わる値のコマの一覧（`GET /api/region/time-frames`）を、テストが自分で組むための雛形。型はbackendの契約から生成したもの。
// 網の層（msw）を読まないので、e2e の模擬応答も同じ雛形を使う。網の層で返すのは`testing/backendServer.ts: serveTimeFrames`。
import type { TimeFrames } from "@/features/map/regionApi";

/** 路面タイルもレンズも、テストの時刻を覆う1つのコマ（出発の時刻を進めても印が変わらない）。 */
export const WIDE_TIME_FRAMES: TimeFrames = {
  road_surface: [{ start: "2000-01-01T00:00:00+09:00", end: "2100-01-01T00:00:00+09:00", key: "road" }],
  lens: [{ start: "2000-01-01T00:00:00+09:00", end: "2100-01-01T00:00:00+09:00", key: "lens" }],
};
