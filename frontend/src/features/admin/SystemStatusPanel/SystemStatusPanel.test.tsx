/**
 * `SystemStatusPanel.tsx`——フロントとbackendが返した稼働状況（版・外部サービスの呼び出しの集計・429で拒否した件数・
 * 予報の同期の鮮度）が画面に出ること。
 *
 * 日時の書式はOSの時間帯で変わるため、日時の文字列そのものは見ない（testing.md パターン10）。
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { getDebugStats } from "@/features/admin/adminApi";
import { onBackend, onSameOrigin } from "@/testing/backendServer";

import SystemStatusPanel from "./SystemStatusPanel";

type DebugStats = Awaited<ReturnType<typeof getDebugStats>>;

const stats: DebugStats = {
  commit: "backend-sha",
  started_at: "2026-09-24T00:00:00Z",
  debug_mode: true,
  external: {
    "jma-tile": {
      calls: 12,
      errors: 3,
      max_ms: 120,
      avg_ms: 30,
      cache_hit_rate: 0.456,
      error_types: { TimeoutError: 3 },
      last_error: null,
    },
  },
  rate_limit_rejections: { "route-generate": 4 },
  msm: { last_run_at: "2026-09-24T00:00:00Z", run_age_hours: 3, remaining_hours: 45, healthy: true },
};

describe("SystemStatusPanel", () => {
  it("返った版・外部サービスの集計・拒否の件数・予報の鮮度を出す", async () => {
    onBackend("GET", "/api/debug/stats", () => Response.json(stats));
    onSameOrigin("GET", "/api/version", () =>
      Response.json({ commit: "front-sha", started_at: "2026-09-24T00:00:00Z" }),
    );
    render(<SystemStatusPanel open onClose={() => {}} />);

    expect(await screen.findByText("backend-sha")).toBeInTheDocument();
    expect(await screen.findByText("front-sha")).toBeInTheDocument();
    expect(screen.getByText("debug_mode ON")).toBeInTheDocument();
    const row = screen.getByText("jma-tile").closest("tr")!;
    const cells = within(row)
      .getAllByRole("cell")
      .map((cell) => cell.textContent);
    expect(cells).toEqual(["jma-tile", "12", "3TimeoutError:3", "—", "46%", "30ms", "120ms"]);
    expect(screen.getByText("429拒否: route-generate 4件")).toBeInTheDocument();
    expect(screen.getByText("予報（MSM）").parentElement).toHaveTextContent("予報の残り 45時間");
  });
});
