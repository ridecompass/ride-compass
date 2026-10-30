/**
 * `features/route/RouteOutcome/RouteOutcome.tsx`——「ルート結果」の中身のうち、選んだ候補の中身。
 *
 * 見るもの: 編集で作ったルートの「元との違い」の元と名前、道のりのグラフ（横軸・押した区間・動かして選ぶこと）、
 * 候補の内訳、編集中は編集面だけを出し、
 * 同じ道の候補を一覧の名前で渡すこと。
 *
 * ここで見ないもの: 候補が無い間の案内・候補の上の知らせ・候補の一覧 → `RouteOutcome.test.tsx`。選んだ区間の中身
 * （地図の区間の小窓）→ `features/route/SegmentDetail/SegmentDetail.test.tsx`。子の部品（道のりのグラフ・
 * 内訳・寄与の帯・元との違い・編集面）は本物を描き、ここでは受け渡し（親の値が子のどこに出るか・子の操作で親の
 * 何が変わるか）だけを見る。子が値をどう描くか（書式・並び・空のときの案内）は各部品のテストが見る。道のりのグラフの塗り
 * （積む軸の並び・色・値の無い区間の高さ）は読み上げに出ないので見ない。
 *
 * 差し替えたもの: 軸カタログの応答（網の層）。結果の状態は値で組む（`testing/routeOutcome.tsx`）。
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { serveAxisCatalog } from "@/testing/backendServer";
import { makeRouteSegment } from "@/testing/routeFixtures";
import {
  CATALOG,
  CATALOG_RESPONSE,
  FAST,
  SLOW,
  renderOutcome,
  resultsOf,
  route,
  type Splice,
} from "@/testing/routeOutcome";

beforeEach(() => {
  serveAxisCatalog(CATALOG_RESPONSE);
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
    const graph = screen.getByRole("slider", { name: /^道のりに沿った難易度/ });
    expect(graph).toHaveAttribute("aria-valuetext", "1.0 km地点");
    expect(screen.getByText("20.0km")).toBeInTheDocument();
    graph.focus();
    await userEvent.keyboard("{Home}");
    expect(results.selectSegment).toHaveBeenCalledWith(expect.objectContaining({ segment: first }));
  });

  it("候補の総合難易度の内訳を出す", () => {
    const candidate = route("fast", { overall_difficulty: { average: 30, load: 300 } });
    renderOutcome({ results: resultsOf({ generated: [candidate] }) });
    expect(screen.getByText("総合難易度").parentElement).toHaveTextContent("総合難易度30.0/100");
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
      axes: CATALOG.axes,
      axisColors: CATALOG.axisColors,
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
