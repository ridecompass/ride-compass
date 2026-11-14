/**
 * `features/route/RouteOutcome/RouteOutcome.tsx`——「ルート結果」の中身のうち、選んだ候補の中身。
 *
 * 見るもの: 編集で作ったルートの「元との違い」の元と名前、道のりのグラフ（横軸・押した区間・動かして選ぶこと）、経由地の着く見込みの時刻、
 * 候補の内訳、編集中は編集面だけを出し、
 * 同じ道の候補を一覧の名前で渡すこと。
 *
 * ここで見ないもの: 候補が無い間の案内・候補の上の知らせ・候補の一覧 → `RouteOutcome.test.tsx`。選んだ区間の中身
 * （地図の区間の小窓）→ `app/page.popups.test.tsx`、区間の値の計算 → `features/route/RouteProfile/profileLayers.test.ts`。子の部品（道のりのグラフ・
 * 内訳・元との違い・編集面）は本物を描き、ここでは受け渡し（親の値が子のどこに出るか・子の操作で親の
 * 何が変わるか）だけを見る。子が値をどう描くか（書式・並び・空のときの案内）は各部品のテストが見る。道のりのグラフの塗り
 * （積む軸の並び・色）は読み上げに出ないので見ない。
 *
 * 差し替えたもの: 画面の設定と費用の軸の一覧の応答（網の層）。結果の状態は値で組む（`testing/routeOutcome.tsx`）。
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { serveClientConfig, serveCostAxisCatalog } from "@/testing/backendServer";
import { makeRouteSegment } from "@/testing/routeFixtures";
import { FAST, SLOW, renderOutcome, resultsOf, route, type Splice } from "@/testing/routeOutcome";

beforeEach(() => {
  serveClientConfig();
  serveCostAxisCatalog();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("選んだ候補の中身", () => {
  it("編集で作ったルートには、元とその一覧での名前で「元との違い」を出し、「元を見る」で元のタブを選ぶ", async () => {
    const edited = route("spliced-1", { distance_km: 12 });
    const { results } = renderOutcome({
      results: resultsOf({
        generated: [FAST, SLOW],
        edits: [{ route: edited, originId: "slow", number: 1 }],
        selectedRouteId: edited.id,
      }),
    });
    const difference = screen.getByRole("region", { name: "元との違い" });
    expect(difference).toHaveTextContent("元: 2 20.0km");
    expect(difference).toHaveTextContent("距離−8.0km");
    await userEvent.click(within(difference).getByRole("button", { name: "元を見る" }));
    expect(results.showRoute).toHaveBeenCalledWith("slow");
  });

  it("生成した候補・元が一覧に無い編集には「元との違い」を出さない", () => {
    const orphan = route("spliced-1");
    renderOutcome({
      results: resultsOf({
        generated: [FAST],
        edits: [{ route: orphan, originId: "gone", number: 1 }],
        selectedRouteId: orphan.id,
      }),
    });
    expect(screen.queryByRole("region", { name: "元との違い" })).not.toBeInTheDocument();
  });

  it("区間のある候補に道のりのグラフを出し、横軸は一覧で最も長い候補の距離で、押した区間を示し、動かすとその区間を選ぶ", async () => {
    const first = makeRouteSegment({ distance_km: 1 });
    const second = makeRouteSegment({ distance_km: 1 });
    const { results } = renderOutcome({
      results: resultsOf({
        generated: [route("fast", { distance_km: 2, segments: [first, second] }), SLOW],
        selectedRouteSegment: { segment: second, latitude: 35, longitude: 139 },
      }),
    });
    const graph = screen.getByRole("slider", { name: /^道のりに沿った負担/ });
    expect(graph).toHaveAttribute("aria-valuetext", "1.0 km地点");
    expect(screen.getByText("20.0km")).toBeInTheDocument();
    graph.focus();
    await userEvent.keyboard("{Home}");
    expect(results.selectSegment).toHaveBeenCalledWith(expect.objectContaining({ segment: first }));
  });

  it("道のりのグラフの経由地の印に、選んだ候補の区間の到着予想と所要時間から読んだ、着く見込みの時刻を添える", () => {
    // 2つ目の区間は 09:10 に入り、所要時間の終わりの 09:30 に抜ける。経由地はその中ほど。
    renderOutcome({
      results: resultsOf({
        generated: [
          route("fast", {
            distance_km: 2,
            estimated_duration_seconds: 30 * 60,
            waypoint_distances_km: [1.5],
            segments: [
              makeRouteSegment({ distance_km: 1, estimated_arrival_time: "2026-11-14T09:00:00+09:00" }),
              makeRouteSegment({ distance_km: 1, estimated_arrival_time: "2026-11-14T09:10:00+09:00" }),
            ],
          }),
        ],
      }),
    });
    expect(screen.getByRole("img", { name: "経由地 1（1.5km地点・09:20着）" })).toHaveTextContent("09:20着");
  });

  it("候補の負担を出し、道のりのグラフの「グラフに積む負担」の一覧に軸の名前（費用の軸の一覧）の付いた内訳と事実を出す", async () => {
    const candidate = route("fast", {
      segments: [makeRouteSegment({ distance_km: 1 })],
      penalty: { axis_seconds: { ascent: 240 }, preferred_seconds: 0, avoided_seconds: 0, total_seconds: 240 },
      facts: { axes: { ascent: { label: "登り", value: 120, unit: "m" } } },
    });
    renderOutcome({ results: resultsOf({ generated: [candidate] }) });
    expect(screen.getByRole("button", { name: "負担の説明を表示" }).parentElement).toHaveTextContent("負担+4分");
    await userEvent.click(screen.getByRole("button", { name: "グラフに積む負担" }));
    expect(await within(screen.getByRole("dialog")).findByText("登坂")).toBeInTheDocument();
    expect(screen.getByText("登り 120m")).toBeInTheDocument();
  });

  it("編集している間は、一覧の代わりに編集面だけを出し、同じ道の候補は一覧の名前で渡す", () => {
    const panel: Splice["panel"] = {
      displayed: { ...FAST, edge_ids: ["e1"] },
      appliedCount: 0,
      hasAlternatives: true,
      onUndo: vi.fn(),
      onReset: vi.fn(),
      preview: null,
      sameRouteId: "slow",
      previewing: false,
      onPreview: vi.fn(),
      onApply: vi.fn(),
      applying: false,
      error: null,
      onCancel: vi.fn(),
    };
    renderOutcome({
      results: resultsOf({ generated: [FAST, SLOW] }),
      splice: { panel },
    });
    expect(screen.getByRole("region", { name: "区間の乗り換え" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.getByText("この組み合わせは「2」と同じ道です")).toBeInTheDocument();
  });
});
