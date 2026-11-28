/**
 * `features/route/RouteOutcome/RouteOutcome.tsx`——「ルート結果」の中身のうち、候補が無い間の案内と、候補の上の知らせと、候補の一覧。
 *
 * ここで見ないもの: 選んだ候補の中身（元との違い・道のりのグラフ・内訳・区間の詳しく・編集面） → `RouteOutcome.selected.test.tsx`。
 * 一覧の並び・群・名前の決め方 → `features/route/routeTabLabel.ts`。
 * 結果の状態の移り変わり → `features/route/useRouteResults.ts`。値を子・文へそのまま渡すだけの所
 * （内訳・事実等）は1行の委譲なので見ない。候補1本への操作（走る・合成・GPX）
 * → `features/route/RouteCandidateActions/RouteCandidateActions.tsx`（置き場は見出しの行の`RouteOutcomeHeaderActions.tsx`）。値から段を引く判断 →
 * `lib/mapDisplay/valueScale.ts: bandAt`。シートが開いたときに合わせる高さ → `components/BottomSheet/BottomSheet.tsx`。
 *
 * 差し替えたもの: 画面の設定と費用の軸の一覧の応答（網の層）。結果の状態は値で組む（`testing/routeOutcome.tsx`）。
 *
 * 軸は架空のもの（`axis_a`等）を`testing/costAxes.ts: costAxisEntry`の雛形から作る。
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EditedRoute } from "@/features/route/useRouteResults";
import { NO_DATA_LEGEND_BAND } from "@/lib/mapDisplay/mapColorLegend";
import { costLensPaint } from "@/lib/mapDisplay/costLensPaint";
import { valueBands } from "@/lib/mapDisplay/valueScale";
import { serveClientConfig, serveCostAxisCatalog } from "@/testing/backendServer";
import { costAxisCatalog, costAxisEntry } from "@/testing/costAxes";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";
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
  return Array.from(list.children)
    .filter((child) => child !== cardSample())
    .map((child) =>
      child.getAttribute("role") === "separator" || child.tagName === "HR" ? "―" : (child.textContent ?? ""),
    );
}

/** 候補のカードの並びの先頭の、数字の見方の見本。 */
const cardSample = () => screen.getByRole("group", { name: "カードの数字の見方" });

describe("候補が無い間", () => {
  it("生成中は進み方を出す", () => {
    renderOutcome({ generation: generationOf({ running: true, progressLabel: "生成中...(3秒経過)" }) });
    expect(screen.getByText("生成中...(3秒経過)")).toBeInTheDocument();
  });

  it("案内が無ければ、生成を押すと候補が並ぶことを案内する", () => {
    renderOutcome();
    expect(screen.getByText(/候補がここに並びます/)).toHaveTextContent(
      /^「ルート設定」の.*ルート生成を押すと候補がここに並びます$/,
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

  it("作り直している間は、並んでいる候補の上に進み方を出す", () => {
    renderOutcome({
      generation: generationOf({ running: true, progressLabel: "生成中...(3秒経過)" }),
      results: resultsOf({ generated: [FAST, SLOW] }),
    });
    expect(screen.getByText("生成中...(3秒経過)")).toBeInTheDocument();
  });

  it.each([
    ["2026-11-16T15:00", "11/16 15:00から先の風は、前の予報の値です。"],
    [null, null],
  ])("前に出た予報の風で作った候補が並ぶ間だけ、その風に替わる時刻を知らせる（%s）", (from, notice) => {
    renderOutcome({ results: resultsOf({ generated: [FAST, { ...SLOW, wind_previous_run_from: from }] }) });
    expect(screen.queryByText(/前の予報の値です/)?.textContent ?? null).toBe(notice);
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
  it("最速の印の無い生成は最速を分けず、番号・距離・所要時間・走りにくさの列だけで並べ、区切りの線も群の印も出さない", () => {
    renderOutcome({ results: resultsOf({ generated: [FAST, SLOW] }) });
    expect(listTexts()).toEqual(["1 10.0km 30分 走りにくさ+5分", "2 20.0km 42分 走りにくさ+0分"]);
    expect(within(screen.getByRole("tablist")).queryByRole("img")).not.toBeInTheDocument();
  });

  it("最速・生成した候補・合成がそろうと、その順に並べて群の間に線を引き、最速と合成は名前の列の印に意味を持ち、どのカードも自分の所要時間を出す", () => {
    const edit: EditedRoute = {
      route: route("spliced-1", { distance_km: 12, estimated_duration_seconds: 1620 }),
      originId: "fast",
      number: 1,
    };
    renderOutcome({ results: resultsOf({ generated: [SLOW, { ...FAST, is_fastest: true }], edits: [edit] }) });
    expect(listTexts()).toEqual([
      " 10.0km 30分 走りにくさ+5分",
      "―",
      "1 20.0km 42分 走りにくさ+0分",
      "―",
      "1 12.0km 27分 走りにくさ+0分",
    ]);
    const [fastest, , spliced] = screen.getAllByRole("tab");
    expect(within(fastest).getByRole("img", { name: "最速ルート" })).toHaveAttribute("title", "最速ルート");
    expect(within(spliced).getByRole("img", { name: "合成ルート" })).toHaveAttribute("title", "合成ルート");
  });

  it("並びの先頭の見本は、カードの数字の位置に距離と所要・走りにくさを出し、押しても候補を選ばない。その(i)を開くと、段と印の読み方・所要時間の見積もり方・費用の軸の一覧の名前を差し込んだ走りにくさ・候補の並べ方を、1つずつ箇条書きの1行か1文で出す", async () => {
    serveCostAxisCatalog(
      costAxisCatalog(costAxisEntry("ascent", { label: "軸ア" }), costAxisEntry("stopping", { label: "軸イ" })),
    );
    const results = resultsOf({ generated: [FAST, SLOW] });
    renderOutcome({ results });
    expect(cardSample()).toHaveTextContent(/^距離所要走りにくさ$/);
    await userEvent.click(within(cardSample()).getByText("距離"));
    expect(results.selectRoute).not.toHaveBeenCalled();
    expect(results.focusRoute).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: /^1 / })).toHaveAttribute("aria-selected", "true");

    await userEvent.click(within(cardSample()).getByRole("button", { name: "所要時間と走りにくさの説明を表示" }));
    const items = (await screen.findAllByRole("listitem")).map((item) => item.textContent);
    expect(items).toEqual(expect.arrayContaining(["・上の段: 距離", "・稲妻の印: 最速ルート"]));
    expect(screen.getByText(`所要時間: ${routeGenerateConfig.duration_estimate_wording}`)).toBeInTheDocument();
    expect(
      screen.getByText(`走りにくさ[軸ア・軸イ]: ${routeGenerateConfig.penalty_wording}です。`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`並び: 先頭は最速、残りは${routeGenerateConfig.candidate_order_wording}です。`),
    ).toBeInTheDocument();
  });

  it.each([
    ["slow", /^2 /],
    [null, /^1 /],
  ])("選んだ候補（%s。無ければ先頭）のタブが選ばれている", (selectedRouteId, name) => {
    renderOutcome({ results: resultsOf({ generated: [FAST, SLOW], selectedRouteId }) });
    expect(screen.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
  });

  it("カードの下の帯は、1kmあたりの走りにくさを地図の総合のレンズと同じ段の色で塗り、内訳の無い候補は値の無い色で塗る", async () => {
    renderOutcome({ results: resultsOf({ generated: [FAST, SLOW] }) });
    const bandOf = (name: RegExp) => screen.getByRole("tab", { name }).querySelector(":scope > span[aria-hidden]");
    // 速い候補は1kmあたり30秒で、総合のレンズの境目（10秒）より上の段。
    const heavy = valueBands(costLensPaint(costAxisCatalog().total_lens, "light"))[1].color;
    await waitFor(() => expect(bandOf(/^1 /)).toHaveStyle({ backgroundColor: heavy }));
    expect(bandOf(/^2 /)).toHaveStyle({ backgroundColor: NO_DATA_LEGEND_BAND.color });
  });
});
