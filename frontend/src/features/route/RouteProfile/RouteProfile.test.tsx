/**
 * `features/route/RouteProfile/RouteProfile.tsx`——道のりのグラフの「表示」「評価で塗る」のタブ（名前は地図の2つの入口と同じ `lib/screenNames.ts`）と、
 * 選んだ地点の詳しく（`features/route/RouteProfile/ProfilePointDetail.tsx`）。
 *
 * 見るもの: 既定で「評価で塗る」（難易度のグラフ）を出すこと、その (i) が塗った軸の色と名前・値の無い区間の色・意味の文を出すこと
 * （塗る区間の無い軸は出さない）、「表示」のタブのチップが選んだ情報を重ね・外す知らせを上げること、標高の折れ線と最高・最低、
 * 走行中の現在地の印を最初の折れ線のその地点の高さに置くこと（値が無ければ中ほど）、出す情報が無いときと値が無いときの文、道の区分のレイヤの帯をレイヤごとに地図と同じ色で出し、その凡例を
 * 出すこと、両方のタブで経由地を通る所に線と番号の印を出し、
 * 走り終えた経由地を薄めること。タブは結果も走行中も地図の入口と同じ絵だけで出し（名前は読み上げに残す）、押すと図が替わること。走行中の図は、
 * 目盛り・図の下の文字を結果の図より大きくし、「表示」の図に標高の目盛りを出すこと。地点を選ぶと、結果も走行中も図の下に3行の詳しく
 * （標高・勾配・何km地点・到達予想・閉じる／当たる道の区分と風のチップ／区間の総合難易度と軸ごとの寄与）を出し、当たらない区分
 * （該当なし・データなし）はチップにせず、閉じると選択を外すこと。地図で押した区間（地物から組み直した写し）も、図がその区間と押した所の地点を探して詳しくを出すこと。
 *
 * 差し替えたもの: グラフの実寸（`getBoundingClientRect`。テスト環境は実寸を返さない）。道の区分の層は軸カタログの応答としてテストが組む
 * （本番の層は管理DBが持つ）。
 *
 * ここで見ないもの: 難易度の塗り・なぞって地点を選ぶ操作 → `DifficultyProfile.test.tsx`。折れ線の点・帯の切れ目と地点の値・行の計算 →
 * `profileLayers.test.ts`。選んだレイヤを覚えること → `useProfileLayers.test.ts`。風のチップの方角の呼び名 →
 * `lib/cardinalLabel.test.ts`。
 */
import { EVALUATION_PAINT_NAME, FACT_DISPLAY_NAME } from "@/lib/screenNames";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { serveAxisCatalog } from "@/testing/backendServer";
import {
  catalogEntry,
  catalogOf,
  catalogResponse,
  roadClass,
  roadClassCatalog,
  roadMapLayer,
} from "@/testing/catalogAxes";
import { makeRouteSegment } from "@/testing/routeFixtures";
import { mapDisplay } from "@/types/generated/mapDisplay";
import type { RouteSegmentDetail, SelectedRouteSegment } from "@/types/route";

import RouteProfile from "./RouteProfile";

const ENTRIES = [catalogEntry({ axis_id: "axis_a", label: "坂" }), catalogEntry({ axis_id: "axis_b", label: "路面" })];
const CATALOG = catalogOf(ENTRIES);
const SURFACE_ROAD_CLASSES = [
  roadClass("paved", { label: "舗装", color: "#111111" }),
  roadClass("gravel", { label: "砂利・未舗装", color: "#222222" }),
];
const ROAD_LAYERS = [
  roadMapLayer("surface", { label: "路面の種類", has_no_data: true, classes: SURFACE_ROAD_CLASSES }),
  roadMapLayer("tunnel", { label: "トンネル", classes: [roadClass("tunnel", { label: "トンネル" })] }),
];
const surfaceColor = (key: string) => SURFACE_ROAD_CLASSES.find((roadClass) => roadClass.key === key)!.color;

beforeEach(() => {
  serveAxisCatalog(catalogResponse(ENTRIES, { road_classes: roadClassCatalog({ map_layers: ROAD_LAYERS }) }));
});
// 北緯35度の上を東へ1kmずつ進む2区間。前は坂だけが効き、標高を持つ。後ろは難易度も標高も無い。
const CLIMB = makeRouteSegment({
  distance_km: 1,
  difficulty: 40,
  axis_contributions: { axis_a: 40 },
  elevations: [{ distance_km: 1, start_elevation_m: 12, end_elevation_m: 31.6 }],
  start_latitude: 35,
  start_longitude: 139,
  end_latitude: 35,
  end_longitude: 139.01,
});
const UNKNOWN = makeRouteSegment({
  distance_km: 1,
  difficulty: null,
  start_latitude: 35,
  start_longitude: 139.01,
  end_latitude: 35,
  end_longitude: 139.02,
});
// 地点の詳しくを見る区間。舗装の道でトンネルではない（「該当なし」）。
const PAVED: RouteSegmentDetail = {
  ...CLIMB,
  estimated_arrival_time: "2026-10-04T00:42:00Z",
  axis_difficulties: { axis_a: 72.4 },
  wind: { speed_ms: 3, direction_deg: 180, forecast_at: "2026-10-04T09:00" },
  road_classes: { surface: [{ distance_km: 1, value: "paved" }], tunnel: [{ distance_km: 1, value: null }] },
};

type Props = React.ComponentProps<typeof RouteProfile>;

function renderProfile(props: Partial<Props> = {}) {
  const toggle = vi.fn();
  const view = render(
    <RouteProfile
      segments={[CLIMB, UNKNOWN]}
      overallDifficulty={20}
      axes={CATALOG.axes}
      axisColors={CATALOG.axisColors}
      scaleKm={2}
      selected={null}
      layers={{ ids: ["elevation"], toggle }}
      waypointKms={[]}
      {...props}
    />,
  );
  return { ...view, toggle };
}

/** 図に載っている区間`segment`を選んだ図（図の上の地点は区間の始まり）。 */
function renderSelected(overrides: Partial<RouteSegmentDetail> = {}) {
  const segment = { ...PAVED, ...overrides };
  const onSelect = vi.fn();
  renderProfile({ segments: [segment], selected: { segment, latitude: 35, longitude: 139 }, onSelect });
  return { onSelect };
}

const detail = () => screen.getByRole("group", { name: "選んだ地点の詳しく" });
const chipTexts = () =>
  within(screen.getByRole("list", { name: "この地点の道と風" }))
    .getAllByRole("listitem")
    .map((item) => item.textContent);

async function openLayers() {
  await userEvent.click(screen.getByRole("tab", { name: FACT_DISPLAY_NAME }));
}

describe("RouteProfile", () => {
  it("はじめは「評価で塗る」で難易度を出し、(i) で塗った軸の色と名前・値の無い区間・グラフの意味を開く", async () => {
    renderProfile();
    expect(screen.getByRole("tab", { name: EVALUATION_PAINT_NAME })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("img", { name: "道のりに沿った難易度" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "難易度のグラフの見方を表示" }));
    const note = screen.getByRole("dialog");
    expect(within(note).getByText("坂").previousElementSibling).toHaveStyle({
      backgroundColor: CATALOG.axisColors.axis_a,
    });
    expect(within(note).queryByText("路面")).toBeNull();
    expect(within(note).getByText("値の無い区間")).toBeInTheDocument();
    expect(note).toHaveTextContent(
      "高さは区間の難易度、塗った面積はルートの負荷にほぼ一致し、横の右端は一覧の中で最も長い候補の距離",
    );
  });

  it("「表示」のタブは選んだ情報の折れ線と最高・最低を出し、「グラフに出す情報」の一覧で重ねる・外す", async () => {
    const { toggle } = renderProfile();
    await openLayers();
    const chart = screen.getByRole("img", { name: "道のりに沿った情報" });
    expect(chart.querySelectorAll("polyline")).toHaveLength(1);
    expect(screen.getByText("標高 最高 32m・最低 12m")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "難易度のグラフの見方を表示" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "グラフに出す情報" }));
    const elevation = within(screen.getByRole("dialog")).getByRole("checkbox", { name: "標高" });
    expect(elevation).toBeChecked();
    await userEvent.click(elevation);
    expect(toggle).toHaveBeenCalledWith("elevation");
  });

  it("「表示」のタブの現在地の印は、最初の折れ線のその地点の値の高さに置き、その地点に値が無ければ図の中ほどに置く", async () => {
    const { rerender } = renderProfile({ scaleKm: 2, progressKm: 0.25 });
    await openLayers();
    const mark = () => screen.getByRole("img", { name: "現在地" });
    // 標高12〜31.6mの1/4の高さ（上下の余白8を除いた84の1/4だけ下端から上がる）。
    expect(mark().style).toMatchObject({ left: "12.5%", top: "71%" });

    rerender(
      <RouteProfile
        segments={[CLIMB, UNKNOWN]}
        overallDifficulty={20}
        axes={CATALOG.axes}
        axisColors={CATALOG.axisColors}
        scaleKm={2}
        selected={null}
        layers={{ ids: ["elevation"], toggle: vi.fn() }}
        progressKm={1.5}
        waypointKms={[]}
      />,
    );
    expect(mark().style).toMatchObject({ left: "75%", top: "50%" });
  });

  it("道の区分のレイヤは、レイヤごとに地図と同じ色の帯を出し、帯に現れた区分の凡例を「グラフに出す情報」の一覧の行に出す", async () => {
    const paved = {
      ...CLIMB,
      road_classes: { surface: [{ distance_km: 1, value: "paved" }], tunnel: [{ distance_km: 1, value: "tunnel" }] },
    };
    const gravel = {
      ...UNKNOWN,
      road_classes: { surface: [{ distance_km: 1, value: "gravel" }], tunnel: [{ distance_km: 1, value: null }] },
    };
    renderProfile({ segments: [paved, gravel], layers: { ids: ["surface", "tunnel"], toggle: vi.fn() } });
    await openLayers();
    const chart = screen.getByRole("img", { name: "道のりに沿った情報" });
    // 道の層は軸カタログが届いてから出る。
    const surfaceBand = await waitFor(() => chart.querySelector('[data-layer="surface"]')!);
    expect([...surfaceBand.querySelectorAll("rect")].map((rect) => rect.getAttribute("fill"))).toEqual([
      surfaceColor("paved"),
      surfaceColor("gravel"),
    ]);
    expect(chart.querySelectorAll('[data-layer="tunnel"] rect')).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: "グラフに出す情報" }));
    expect(
      within(screen.getByRole("list", { name: "路面の種類の凡例" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["舗装", "砂利・未舗装"]);
  });

  it.each<{ why: string; ids: string[]; segments: RouteSegmentDetail[]; text: string }>([
    { why: "出す情報を選んでいない", ids: [], segments: [CLIMB], text: "出す情報を選んでください。" },
    { why: "選んだ情報の値が無い", ids: ["elevation"], segments: [UNKNOWN], text: "標高の値がありません。" },
  ])("$why ときは、折れ線の代わりに文で知らせる", async ({ ids, segments, text }) => {
    renderProfile({ segments, layers: { ids, toggle: vi.fn() } });
    await openLayers();
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "道のりに沿った情報" }).querySelector("polyline")).toBeNull();
  });

  it("両方のタブで、経由地を通る所に縦の線と地図のピンと同じ番号の印を出し、走行中は走り終えた経由地を薄める", async () => {
    renderProfile({ waypointKms: [0.5, 1.5], progressKm: 1 });
    const marks = () =>
      screen.getAllByRole("img", { name: /^経由地/ }).map((mark) => ({
        name: mark.getAttribute("aria-label"),
        number: mark.textContent,
        left: mark.style.left,
        opacity: mark.style.opacity,
      }));
    const expected = [
      {
        name: "経由地 1（0.5km地点）",
        number: "1",
        left: "25%",
        opacity: String(mapDisplay.route.opacities.travelled),
      },
      { name: "経由地 2（1.5km地点）", number: "2", left: "75%", opacity: "" },
    ];
    const lines = (name: string) =>
      [...screen.getByRole("img", { name }).querySelectorAll("[data-waypoint]")].map((line) => line.getAttribute("x1"));

    expect(marks()).toEqual(expected);
    expect(lines("道のりに沿った難易度")).toEqual(["250", "750"]);
    await openLayers();
    expect(marks()).toEqual(expected);
    expect(lines("道のりに沿った情報")).toEqual(["250", "750"]);
  });

  it.each([
    { riding: false, large: false },
    { riding: true, large: true },
  ])(
    "タブは結果も走行中（$riding）も絵だけで出して押すと図が替わり、走行中だけ距離の目盛り・図の下の文字を大きくする",
    async ({ riding, large }) => {
      renderProfile({ riding, progressKm: riding ? 0.25 : null });
      for (const name of [FACT_DISPLAY_NAME, EVALUATION_PAINT_NAME]) {
        const tab = screen.getByRole("tab", { name });
        expect(tab.querySelector("svg")).not.toBeNull();
        expect(within(tab).getByText(name)).toHaveClass("sr-only");
      }
      await openLayers();
      expect(screen.getByRole("img", { name: "道のりに沿った情報" })).toBeInTheDocument();
      expect(screen.queryByRole("img", { name: "道のりに沿った難易度" })).toBeNull();
      for (const text of [screen.getByText("2.0km"), screen.getByText("標高 最高 32m・最低 12m")])
        expect(text.closest(".text-base") !== null).toBe(large);

      await userEvent.click(screen.getByRole("tab", { name: EVALUATION_PAINT_NAME }));
      expect(screen.getByRole("img", { name: "道のりに沿った難易度" })).toBeInTheDocument();
    },
  );

  it("走行中の「表示」の図は、最初の折れ線の最高と最低の高さに単位つきの標高の目盛りを出す（結果の図には出さない）", async () => {
    const { rerender } = renderProfile({ riding: true, progressKm: 0.25 });
    await openLayers();
    // 帯の無い図の上下の余白8の位置。
    expect(screen.getByText("標高 32m").style.top).toBe("8%");
    expect(screen.getByText("12m").style.top).toBe("92%");

    rerender(
      <RouteProfile
        segments={[CLIMB, UNKNOWN]}
        overallDifficulty={20}
        axes={CATALOG.axes}
        axisColors={CATALOG.axisColors}
        scaleKm={2}
        selected={null}
        layers={{ ids: ["elevation"], toggle: vi.fn() }}
        waypointKms={[]}
      />,
    );
    expect(screen.queryByText("標高 32m")).toBeNull();
  });

  it.each([
    { riding: true, tab: EVALUATION_PAINT_NAME },
    { riding: false, tab: FACT_DISPLAY_NAME },
  ])(
    "走行中（$riding）の「$tab」の図をなぞって地点を選ぶと、図の下に標高・勾配・地点・到達予想、当たる区分と風のチップ、総合難易度と寄与の3行を出し、閉じると外す",
    async ({ riding, tab }) => {
      // 選択はページが持つので、選んだ地点を図へ戻す。
      function Profile() {
        const [selected, setSelected] = useState<SelectedRouteSegment | null>(null);
        return (
          <RouteProfile
            segments={[PAVED, UNKNOWN]}
            overallDifficulty={20}
            axes={CATALOG.axes}
            axisColors={CATALOG.axisColors}
            scaleKm={2}
            selected={selected}
            onSelect={setSelected}
            layers={{ ids: ["elevation"], toggle: vi.fn() }}
            waypointKms={[]}
            progressKm={riding ? 1.5 : null}
            riding={riding}
          />
        );
      }
      render(<Profile />);
      await userEvent.click(screen.getByRole("tab", { name: tab }));
      expect(screen.queryByRole("group", { name: "選んだ地点の詳しく" })).toBeNull();
      const slider = screen.getByRole("slider");
      vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ left: 0, width: 200 } as DOMRect);
      // 横幅200pxのうち25px＝2kmの物差しで0.25km地点。
      fireEvent.pointerDown(slider, { pointerId: 1, clientX: 25, buttons: 1 });
      fireEvent.pointerUp(slider, { pointerId: 1, clientX: 25 });

      // 標高は12mから31.6mへ1kmで上る道の1/4の地点。地点は区間の始まりの道のり、到達予想は日本時間。
      expect(detail()).toHaveTextContent("標高 17m勾配 +2.0%0.0km地点到達予想 09:42");
      // トンネルの「該当なし」と、値の無い区分の「データなし」はチップにしない。区分のチップは行の凡例の色の印を持つ。
      await waitFor(() => expect(chipTexts()).toEqual(["路面の種類 舗装", "南 3.0m/s"]));
      const pavedChip = within(detail()).getByText("舗装").closest("li")!;
      expect(pavedChip.querySelector("span[style]")).toHaveStyle({ backgroundColor: surfaceColor("paved") });
      await userEvent.click(
        within(detail()).getByRole("button", { name: "区間の風（最寄りの格子点の値 南 3.0m/s）の説明を表示" }),
      );
      expect(screen.getByRole("dialog")).toHaveTextContent(
        /^最寄りの格子点の09:00の計算値この区間を通る見込みの時刻の/,
      );
      await userEvent.keyboard("{Escape}");
      expect(within(detail()).getByText("総合難易度").parentElement).toHaveTextContent("総合難易度40.0/100");
      expect(within(detail()).getByRole("img", { name: "難易度の内訳" })).toBeInTheDocument();

      await userEvent.click(within(detail()).getByRole("button", { name: "区間の選択を解除" }));
      expect(screen.queryByRole("group", { name: "選んだ地点の詳しく" })).toBeNull();
      expect(slider).toHaveAttribute("aria-valuenow", "0");
    },
  );

  it("地図で押した区間（地物から組み直した写し）も、図はその区間の押した所の地点に線を引き、その地点の標高・区分・風・総合難易度を出す", async () => {
    renderProfile({
      segments: [PAVED, UNKNOWN],
      // 地図は区間を自分の地物から組み直すので、図の区間と同じものではない。押した所は前の区間の始まりから0.3km東。
      selected: { segment: { ...PAVED, geometry: null }, latitude: 35, longitude: 139.003 },
      onSelect: vi.fn(),
    });
    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuenow", "0.3");
    // 標高は12mから31.6mへ1kmで上る道の0.3kmの地点。
    expect(detail()).toHaveTextContent("標高 18m勾配 +2.0%");
    await waitFor(() => expect(chipTexts()).toEqual(["路面の種類 舗装", "南 3.0m/s"]));
    expect(within(detail()).getByText("総合難易度").parentElement).toHaveTextContent("総合難易度40.0/100");
  });

  it.each([
    ["寄与のある", { difficulty: 12.4, axis_contributions: { axis_a: 12.4 } }, "12.4", false],
    ["寄与が全部0の", { difficulty: 0, axis_contributions: { axis_a: 0 } }, "0.0", true],
    ["算出できなかった", { difficulty: null, axis_contributions: {} }, "—", false],
  ])("%s区間は総合難易度を出し、全部0のときだけ0であることを文で言う", (_, segment, shown, allZero) => {
    renderSelected(segment);
    expect(within(detail()).getByText("総合難易度").parentElement).toHaveTextContent(`総合難易度${shown}/100`);
    expect(within(detail()).queryByText("どの評価軸も0（易しい）") !== null).toBe(allZero);
  });

  it.each([
    ["到達予想が無い", null],
    ["到達予想が時刻として読めない", "not-a-time"],
  ])("%s区間は、到達予想を「不明」と出す", (_, arrival) => {
    renderSelected({ estimated_arrival_time: arrival });
    expect(detail()).toHaveTextContent("到達予想 不明");
  });
});
