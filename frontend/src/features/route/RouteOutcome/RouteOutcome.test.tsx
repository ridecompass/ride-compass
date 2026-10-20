/**
 * `features/route/RouteOutcome/RouteOutcome.tsx`——「ルート結果」の中身。
 *
 * 見るもの:
 * - 候補が無い間の案内（生成中の進み方・生成前）と、候補がある間の条件のずれ・既定の配分で作ったこと・目的地の補正の
 *   知らせ、乗り換えで作った経路と同じ道だったので選んだ候補の知らせと、選んだカードを一覧の横の見える範囲へ送ること
 * - 候補の一覧: 群（最速・生成した候補・合成）の間の区切りの線と名前の印（意味を読み上げの名前に持つ）、カードに出す
 *   名前・距離・基準線の所要時間・ほかの候補の基準線との差・総合難易度（無ければ「—」）と、下の帯の色（地図の総合難易度の
 *   段の色・無ければ値の無い色）、選ばれているタブ（選んだ候補・無ければ先頭）と、タブを押したときに上がる操作
 * - 選んだ候補の中身: 編集で作ったルートの「元との違い」の元と名前、
 *   道のりのグラフ（横軸・押した区間・動かして選ぶこと）、区間を押している間は内訳の代わりにグラフの下へ区間の詳しくが出ることと
 *   その解除、押していない間の内訳、編集中は編集面だけを出し、同じ道の候補を一覧の名前で渡すこと
 *
 * ここで見ないもの: 一覧の並び・群・名前・基準線と差の決め方 → `features/route/routeTabLabel.ts`。
 * 結果の状態の移り変わり → `features/route/useRouteResults.ts`。区間の詳しくの中身（総合難易度・寄与・風・到達予想の書き方）→
 * `features/route/RouteProfile/RouteProfile.test.tsx`。子の部品（道のりのグラフ・内訳・寄与の帯・
 * 元との違い・区間の風・編集面）は本物を描き、ここでは受け渡し（親の値が子のどこに出るか・子の操作で親の何が変わるか）
 * だけを見る。子が値をどう描くか（書式・並び・空のときの案内）は各部品のテストが見る。値を子・文へそのまま渡すだけの所
 * （内訳の生値・材料の値・所要の前提の知らせ・内訳に渡す重み等）は1行の委譲なので見ない。候補1本への操作（走る・合成・GPX）
 * → `features/route/RouteCandidateActions/RouteCandidateActions.tsx`（置き場は見出しの行の`RouteOutcomeHeaderActions.tsx`）。値から段を引く判断 →
 * `lib/mapDisplay/valueScale.ts: bandAt`。シートが開いたときに合わせる高さ → `components/BottomSheet/BottomSheet.tsx`。
 * 道のりのグラフの塗り（積む軸の並び・色・値の無い区間の高さ）は読み上げに出ないので見ない。
 *
 * 差し替えたもの: 軸カタログの応答（網の層）。
 *
 * 軸は架空のもの（`axis_a`等）を`src/testing/catalogAxes.ts`の雛形から作る。
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EditedRoute, RouteResults } from "@/features/route/useRouteResults";
import { NO_DATA_LEGEND_BAND } from "@/lib/mapDisplay/mapColorLegend";
import { bandAt, DIFFICULTY_PAINT, valueBands } from "@/lib/mapDisplay/valueScale";
import { serveAxisCatalog } from "@/testing/backendServer";
import { catalogEntry, catalogOf, catalogResponse } from "@/testing/catalogAxes";
import { makeRouteCandidate, makeRouteSegment } from "@/testing/routeFixtures";
import type { RouteCandidate, RouteSegmentDetail } from "@/types/route";
import RouteOutcome from "./RouteOutcome";

const ENTRIES = [
  catalogEntry({ axis_id: "axis_a", label: "軸A" }),
  catalogEntry({ axis_id: "axis_b", label: "軸B" }),
  catalogEntry({ axis_id: "axis_c", label: "軸C" }),
];
const CATALOG = catalogOf(ENTRIES);

beforeEach(() => {
  serveAxisCatalog(catalogResponse(ENTRIES));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function route(id: string, overrides: Partial<RouteCandidate> = {}): RouteCandidate {
  return makeRouteCandidate({ id, direction_label: id, ...overrides });
}

const FAST = route("fast", {
  distance_km: 10,
  estimated_duration_seconds: 1800,
  overall_difficulty: { average: 41.6, load: 416 },
});
const SLOW = route("slow", { distance_km: 20, estimated_duration_seconds: 2520, overall_difficulty: null });

function resultsOf(
  state: Partial<
    Pick<RouteResults, "generated" | "edits" | "selectedRouteId" | "reusedRouteId" | "selectedRouteSegment">
  > = {},
): RouteResults {
  const generated = state.generated ?? [];
  const edits = state.edits ?? [];
  const routes = [...generated, ...edits.map((edit) => edit.route)];
  const selectedRouteId = state.selectedRouteId ?? null;
  const selectedCandidate = routes.find((candidate) => candidate.id === selectedRouteId) ?? null;
  const edit = edits.find((item) => item.route.id === selectedRouteId);
  return {
    routes,
    generated,
    edits,
    selectedRouteId,
    reusedRouteId: state.reusedRouteId ?? null,
    selectedCandidate,
    selectedEdit: edit ? { ...edit, origin: routes.find((candidate) => candidate.id === edit.originId) ?? null } : null,
    hasDetail: (selectedCandidate?.segments.length ?? 0) > 0,
    selectedRouteSegment: state.selectedRouteSegment ?? null,
    selectSegment: vi.fn(),
    usedWeights: null,
    replaceWithGenerated: vi.fn(),
    addEdit: vi.fn(),
    clear: vi.fn(),
    selectTab: vi.fn(),
    selectReused: vi.fn(),
  };
}

type Generation = ComponentProps<typeof RouteOutcome>["generation"];

function generationOf(overrides: Partial<Generation> = {}): Generation {
  return {
    running: false,
    progressLabel: undefined,
    conditionsDirty: false,
    weightsNotApplied: false,
    destinationCorrected: false,
    ...overrides,
  };
}

type Splice = ComponentProps<typeof RouteOutcome>["splice"];

function renderOutcome({
  results = resultsOf(),
  generation = generationOf(),
  splice = { panel: null },
}: {
  results?: RouteResults;
  generation?: Generation;
  splice?: Splice;
} = {}) {
  render(
    <RouteOutcome
      results={results}
      generation={generation}
      splice={splice}
      routeWeights={{}}
      profileLayers={{ ids: ["elevation"], toggle: vi.fn() }}
    />,
  );
  return { results, splice };
}

/** 一覧のカードを、左からカードの文で（区切りの線は「―」）。 */
function listTexts(): string[] {
  const list = screen.getByRole("tablist", { name: "ルート結果" });
  return Array.from(list.children).map((child) =>
    child.getAttribute("role") === "separator" || child.tagName === "HR" ? "―" : (child.textContent ?? ""),
  );
}

/** 区間を持つ候補と、地図でその候補の区間を押した選択（地図は区間を自分の地物から組み直すので、候補の区間と同じものではない）。 */
function segmentPressed(): Pick<RouteResults, "generated" | "selectedRouteSegment"> {
  const segment: RouteSegmentDetail = makeRouteSegment({
    distance_km: 1,
    cumulative_distance_km: 3.25,
    estimated_arrival_time: "2026-10-04T00:42:00Z",
    axis_contributions: { axis_a: 12 },
    wind: { speed_ms: 3, direction_deg: 90, forecast_at: "2026-10-04T09:00" },
  });
  return {
    generated: [{ ...FAST, segments: [segment] }],
    selectedRouteSegment: { segment: { ...segment }, latitude: 35, longitude: 139 },
  };
}

describe("候補が無い間", () => {
  it.each([
    { progressLabel: "順番待ち...", text: "順番待ち..." },
    { progressLabel: undefined, text: "生成中..." },
  ])("生成中は進み方（届く前は「生成中...」）を出す: $text", ({ progressLabel, text }) => {
    renderOutcome({ generation: generationOf({ running: true, progressLabel }) });
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("案内が無ければ、生成を押すと候補が並ぶことを案内する", () => {
    renderOutcome();
    expect(screen.getByText(/候補がここに並びます/)).toHaveTextContent(
      "「ルート設定」のルート生成を押すと候補がここに並びます",
    );
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });
});

describe("候補の上の知らせ", () => {
  it.each([true, false])(
    "条件のずれ・既定の配分で作ったこと・目的地の補正を、それぞれの間だけ知らせる（当たる: %s）",
    (on) => {
      renderOutcome({
        results: resultsOf({ generated: [FAST] }),
        generation: generationOf({ conditionsDirty: on, weightsNotApplied: on, destinationCorrected: on }),
      });
      for (const text of [
        "生成条件が変更されています",
        "重み配分を反映できず、既定の配分で作りました。",
        /近くのアクセス可能な地点へ補正しました/,
      ]) {
        expect(screen.queryByText(text) !== null).toBe(on);
      }
    },
  );

  it("乗り換えで作った経路と同じ道だったので選んだ候補は、一覧の名前で知らせ、そのカードを一覧の横の見える範囲へ送る", () => {
    // 一覧は幅300pxで、選んだ2枚目のカードは右へ100pxはみ出している。
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("role") === "tablist") return new DOMRect(0, 0, 300, 44);
      if (this.getAttribute("aria-selected") === "true") return new DOMRect(322, 0, 78, 44);
      return new DOMRect(0, 0, 0, 0);
    });
    renderOutcome({ results: resultsOf({ generated: [FAST, SLOW], selectedRouteId: "slow", reusedRouteId: "slow" }) });

    expect(screen.getByText("作った組み合わせは「2」と同じ道なので、「2」を選びました")).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "ルート結果" }).scrollLeft).toBe(100);
  });
});

describe("候補の一覧", () => {
  it("最速の印の無い生成は最速を分けず、番号・距離・時間・難易度の列だけで並べ、区切りの線も群の印も出さない", () => {
    renderOutcome({ results: resultsOf({ generated: [FAST, SLOW] }) });
    expect(listTexts()).toEqual(["1 10.0km 30分 難易度41.6", "2 20.0km +12分 難易度—"]);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("最速・生成した候補・合成がそろうと、その順に並べて群の間に線を引き、最速と合成は名前の列の印に意味を持ち、時間の列は最速の行と比べる", () => {
    // 合成の方が最速の行より速く見積もられても、比べる基準は最速の行のまま
    const edit: EditedRoute = {
      route: route("spliced-1", { distance_km: 12, estimated_duration_seconds: 1620 }),
      originId: "fast",
      number: 1,
    };
    renderOutcome({ results: resultsOf({ generated: [SLOW, { ...FAST, is_fastest: true }], edits: [edit] }) });
    expect(listTexts()).toEqual([
      " 10.0km 30分 難易度41.6",
      "―",
      "1 20.0km +12分 難易度—",
      "―",
      "1 12.0km −3分 難易度—",
    ]);
    const [fastest, , spliced] = screen.getAllByRole("tab");
    expect(within(fastest).getByRole("img", { name: "最速ルート" })).toHaveAttribute("title", "最速ルート");
    expect(within(spliced).getByRole("img", { name: "合成ルート" })).toHaveAttribute("title", "合成ルート");
  });

  it.each([
    ["slow", /^2 /],
    [null, /^1 /],
  ])("選んだ候補（%s。無ければ先頭）のタブが選ばれている", (selectedRouteId, name) => {
    renderOutcome({ results: resultsOf({ generated: [FAST, SLOW], selectedRouteId }) });
    expect(screen.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
  });

  it("カードの下の帯は、総合難易度を地図と同じ段の色で塗り、算出できなかった候補は値の無い色で塗る", () => {
    renderOutcome({ results: resultsOf({ generated: [FAST, SLOW] }) });
    const bandOf = (name: RegExp) => screen.getByRole("tab", { name }).querySelector(":scope > span[aria-hidden]");
    expect(bandOf(/^1 /)).toHaveStyle({ backgroundColor: bandAt(valueBands(DIFFICULTY_PAINT), 41.6).color });
    expect(bandOf(/^2 /)).toHaveStyle({ backgroundColor: NO_DATA_LEGEND_BAND.color });
  });
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
    expect(results.selectTab).toHaveBeenCalledWith("slow");
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

  it("区間を押していない間は、候補の総合難易度の内訳を出す", () => {
    const candidate = route("fast", { overall_difficulty: { average: 30, load: 300 } });
    renderOutcome({ results: resultsOf({ generated: [candidate] }) });
    expect(screen.getByText("総合難易度").parentElement).toHaveTextContent("総合難易度30.0/100");
    expect(screen.queryByRole("button", { name: "区間の選択を解除" })).not.toBeInTheDocument();
  });

  it("区間を押している間は、候補の内訳の代わりに、グラフの下へその区間の詳しくを出す", () => {
    renderOutcome({ results: resultsOf(segmentPressed()) });
    const detail = screen.getByRole("group", { name: "選んだ地点の詳しく" });
    expect(detail).toHaveTextContent("3.3km地点到達予想 09:42");
    expect(within(detail).getByRole("button", { name: /^区間の風/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "総合難易度の説明を表示" })).not.toBeInTheDocument();
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
