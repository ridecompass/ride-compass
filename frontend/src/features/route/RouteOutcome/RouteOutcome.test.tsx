/**
 * `features/route/RouteOutcome/RouteOutcome.tsx`——「ルート結果」の中身のうち、候補が無い間の案内と、候補の上の知らせと、候補の一覧。
 *
 * 見るもの:
 * - 候補が無い間の案内（生成中の進み方・生成前）と、候補がある間の条件のずれ・既定の配分で作ったこと・目的地の補正・
 *   前に出た予報の風で作ったことの知らせ、乗り換えで作った経路と同じ道だったので選んだ候補の知らせと、選んだカードを一覧の横の見える範囲へ送ること
 * - 候補の一覧: 群（最速・生成した候補・合成）の間の区切りの線と名前の印（意味を読み上げの名前に持つ）、カードに出す
 *   名前・距離・基準線の所要時間・ほかの候補の基準線との差・負担（内訳が無ければ「—」）と、下の帯の色（1kmあたりの負担を
 *   地図の総合のレンズと同じ段の色・内訳が無ければ値の無い色）、選ばれているタブ（選んだ候補・無ければ先頭）と、タブを押したときに上がる操作
 *
 * ここで見ないもの: 選んだ候補の中身（元との違い・道のりのグラフ・内訳・区間の詳しく・編集面） → `RouteOutcome.selected.test.tsx`。
 * 一覧の並び・群・名前・基準線と差の決め方 → `features/route/routeTabLabel.ts`。
 * 結果の状態の移り変わり → `features/route/useRouteResults.ts`。値を子・文へそのまま渡すだけの所
 * （内訳・事実・所要の前提の知らせ等）は1行の委譲なので見ない。候補1本への操作（走る・合成・GPX）
 * → `features/route/RouteCandidateActions/RouteCandidateActions.tsx`（置き場は見出しの行の`RouteOutcomeHeaderActions.tsx`）。値から段を引く判断 →
 * `lib/mapDisplay/valueScale.ts: bandAt`。シートが開いたときに合わせる高さ → `components/BottomSheet/BottomSheet.tsx`。
 *
 * 差し替えたもの: 画面の設定と費用の軸の一覧の応答（網の層）。結果の状態は値で組む（`testing/routeOutcome.tsx`）。
 *
 * 軸は架空のもの（`axis_a`等）を`testing/costAxes.ts: costAxisEntry`の雛形から作る。
 */
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EditedRoute } from "@/features/route/useRouteResults";
import { NO_DATA_LEGEND_BAND } from "@/lib/mapDisplay/mapColorLegend";
import { costLensPaint } from "@/lib/mapDisplay/costLensPaint";
import { valueBands } from "@/lib/mapDisplay/valueScale";
import { serveClientConfig, serveCostAxisCatalog } from "@/testing/backendServer";
import { costAxisCatalog } from "@/testing/costAxes";
import { FAST, SLOW, generationOf, renderOutcome, resultsOf, route } from "@/testing/routeOutcome";

beforeEach(() => {
  serveClientConfig();
  serveCostAxisCatalog();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function listTexts(): string[] {
  const list = screen.getByRole("tablist", { name: "ルート結果" });
  return Array.from(list.children).map((child) =>
    child.getAttribute("role") === "separator" || child.tagName === "HR" ? "―" : (child.textContent ?? ""),
  );
}

describe("候補が無い間", () => {
  it("生成中は進み方を出す", () => {
    renderOutcome({ generation: generationOf({ running: true, progressLabel: "生成中...(3秒経過)" }) });
    expect(screen.getByText("生成中...(3秒経過)")).toBeInTheDocument();
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
  it.each([true, false])("条件のずれ・目的地の補正を、それぞれの間だけ知らせる（当たる: %s）", (on) => {
    renderOutcome({
      results: resultsOf({ generated: [FAST] }),
      generation: generationOf({ conditionsDirty: on, destinationCorrected: on }),
    });
    for (const text of ["生成条件が変更されています", /近くの自転車で行ける地点へ移しました/]) {
      expect(screen.queryByText(text) !== null).toBe(on);
    }
  });

  it.each([true, false])("前に出た予報の風で作った候補が並ぶ間だけ、そのことを知らせる（当たる: %s）", (on) => {
    renderOutcome({ results: resultsOf({ generated: [FAST, { ...SLOW, wind_from_previous_run: on }] }) });
    expect(screen.queryByText(/前の予報で作りました/) !== null).toBe(on);
  });

  it("乗り換えで作った経路と同じ道だったので選んだ候補は、一覧の名前で知らせ、そのカードを一覧の横の見える範囲へ送る", () => {
    // 一覧は幅300pxで、選んだ2枚目のカードは右へ100pxはみ出している。
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("role") === "tablist") return new DOMRect(0, 0, 300, 44);
      if (this.getAttribute("aria-selected") === "true") return new DOMRect(322, 0, 78, 44);
      return new DOMRect(0, 0, 0, 0);
    });
    renderOutcome({ results: resultsOf({ generated: [FAST, SLOW], selectedRouteId: "slow", reusedRouteId: "slow" }) });

    expect(
      screen.getByText("作った組み合わせは既存の候補「2」と同じ道のため、その候補を選びました"),
    ).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "ルート結果" }).scrollLeft).toBe(100);
  });
});

describe("候補の一覧", () => {
  it("最速の印の無い生成は最速を分けず、番号・距離・時間・負担の列だけで並べ、区切りの線も群の印も出さない", () => {
    renderOutcome({ results: resultsOf({ generated: [FAST, SLOW] }) });
    expect(listTexts()).toEqual(["1 10.0km 30分 負担+5分", "2 20.0km +12分 負担+0分"]);
    expect(within(screen.getByRole("tablist")).queryByRole("img")).not.toBeInTheDocument();
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
      " 10.0km 30分 負担+5分",
      "―",
      "1 20.0km +12分 負担+0分",
      "―",
      "1 12.0km −3分 負担+0分",
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

  it("カードの下の帯は、1kmあたりの負担を地図の総合のレンズと同じ段の色で塗り、内訳の無い候補は値の無い色で塗る", async () => {
    renderOutcome({ results: resultsOf({ generated: [FAST, SLOW] }) });
    const bandOf = (name: RegExp) => screen.getByRole("tab", { name }).querySelector(":scope > span[aria-hidden]");
    // 速い候補は1kmあたり30秒で、総合のレンズの境目（10秒）より上の段。
    const heavy = valueBands(costLensPaint(costAxisCatalog().total_lens, "light"))[1].color;
    await waitFor(() => expect(bandOf(/^1 /)).toHaveStyle({ backgroundColor: heavy }));
    expect(bandOf(/^2 /)).toHaveStyle({ backgroundColor: NO_DATA_LEGEND_BAND.color });
  });
});
