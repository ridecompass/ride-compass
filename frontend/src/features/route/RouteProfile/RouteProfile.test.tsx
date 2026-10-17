/**
 * `features/route/RouteProfile/RouteProfile.tsx`——道のりのグラフの「表示」「評価で塗る」のタブ（名前は地図の2つの入口と同じ `lib/screenNames.ts`）。
 *
 * 見るもの: 既定で「評価で塗る」（難易度のグラフ）を出すこと、その (i) が塗った軸の色と名前・値の無い区間の色・意味の文を出すこと
 * （塗る区間の無い軸は出さない）、「表示」のタブのチップが選んだ情報を重ね・外す知らせを上げること、標高の折れ線と最高・最低、
 * 選んだ地点の標高、走行中の現在地の印を最初の折れ線のその地点の高さに置くこと（値が無ければ中ほど）、出す情報が無いときと値が無いときの文、道の区分のレイヤの帯をレイヤごとに地図と同じ色で出し、その凡例と
 * 選んだ地点の区分の呼び名を出すこと、点のレイヤはルートの近くの点を通る距離に地図と同じ色の印で並べ、選んだ地点の点の区分と名前と、
 * 現れた区分の凡例を出すこと。
 *
 * ここで見ないもの: 難易度の塗り・なぞって地点を選ぶ操作 → `DifficultyProfile.test.tsx`。折れ線の点・帯の切れ目と地点の値・行の計算 →
 * `profileLayers.test.ts`（点の印の色・区分の名前・地点の印の選び方も）。選んだレイヤを覚えること → `useProfileLayers.test.ts`。
 */
import { POINT_LAYERS } from "@/lib/mapDisplay/pointLayers";
import { roadTrackRows, ROAD_TRACKS } from "@/lib/mapDisplay/roadTracks";
import { EVALUATION_PAINT_NAME, FACT_DISPLAY_NAME } from "@/lib/screenNames";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { catalogEntry, catalogOf } from "@/testing/catalogAxes";
import { makeRouteSegment } from "@/testing/routeFixtures";
import type { RouteSegmentDetail } from "@/types/route";

import RouteProfile from "./RouteProfile";

const CATALOG = catalogOf([
  catalogEntry({ axis_id: "axis_a", label: "坂" }),
  catalogEntry({ axis_id: "axis_b", label: "路面" }),
]);
// 北緯35度の上を東へ1kmずつ進む2区間。前は坂だけが効き、標高を持つ。後ろは難易度も標高も無い。
const CLIMB = makeRouteSegment({
  distance_km: 1,
  difficulty: 40,
  axis_contributions: { axis_a: 40 },
  start_elevation_m: 12,
  end_elevation_m: 31.6,
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
      points={[]}
      {...props}
    />,
  );
  return { ...view, toggle };
}

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

  it("「表示」のタブは選んだ情報の折れ線と最高・最低を出し、地点を選べばその地点の値を足し、「グラフに出す情報」の一覧で重ねる・外す", async () => {
    const { rerender, toggle } = renderProfile();
    await openLayers();
    const chart = screen.getByRole("img", { name: "道のりに沿った情報" });
    expect(chart.querySelectorAll("polyline")).toHaveLength(1);
    expect(screen.getByText("標高 最高 32m・最低 12m")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "難易度のグラフの見方を表示" })).toBeNull();

    // 地図で前の区間を選ぶ（なぞっていないので、地点は区間の始まり）。
    rerender(
      <RouteProfile
        segments={[CLIMB, UNKNOWN]}
        overallDifficulty={20}
        axes={CATALOG.axes}
        axisColors={CATALOG.axisColors}
        scaleKm={2}
        selected={{ segment: CLIMB, latitude: 35, longitude: 139 }}
        layers={{ ids: ["elevation"], toggle }}
        points={[]}
      />,
    );
    expect(screen.getByText("標高 最高 32m・最低 12m・この地点 12m")).toBeInTheDocument();

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
        points={[]}
        progressKm={1.5}
      />,
    );
    expect(mark().style).toMatchObject({ left: "75%", top: "50%" });
  });

  it("道の区分のレイヤは、レイヤごとに地図と同じ色の帯を出し、選んだ地点の区分の呼び名をグラフの下に、帯に現れた区分の凡例を「グラフに出す情報」の一覧の行に出す", async () => {
    const surfaceRows = roadTrackRows(ROAD_TRACKS.find((track) => track.attr_id === "surface")!);
    const color = (key: string) => surfaceRows.find((row) => row.key === key)!.color;
    const paved = {
      ...CLIMB,
      road_classes: { surface: [{ distance_km: 1, value: "paved" }], tunnel: [{ distance_km: 1, value: true }] },
    };
    const gravel = {
      ...UNKNOWN,
      road_classes: { surface: [{ distance_km: 1, value: "gravel" }], tunnel: [{ distance_km: 1, value: null }] },
    };
    renderProfile({
      segments: [paved, gravel],
      selected: { segment: gravel, latitude: 35, longitude: 139.01 },
      layers: { ids: ["surface", "tunnel"], toggle: vi.fn() },
    });
    await openLayers();
    const chart = screen.getByRole("img", { name: "道のりに沿った情報" });
    const surfaceBand = chart.querySelector('[data-layer="surface"]')!;
    expect([...surfaceBand.querySelectorAll("rect")].map((rect) => rect.getAttribute("fill"))).toEqual([
      color("paved"),
      color("gravel"),
    ]);
    expect(chart.querySelectorAll('[data-layer="tunnel"] rect')).toHaveLength(2);

    expect(screen.getByText("路面の種類・この地点 砂利・未舗装")).toBeInTheDocument();
    expect(screen.getByText("トンネル・この地点 該当なし")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "グラフに出す情報" }));
    expect(
      within(screen.getByRole("list", { name: "路面の種類の凡例" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["舗装", "砂利・未舗装"]);
  });

  it("点のレイヤは、ルートの近くの点を通る距離に地図と同じ色の印で並べ、選んだ地点の点の区分と名前をグラフの下に、現れた区分の凡例を一覧の行に出す", async () => {
    const supply = POINT_LAYERS.find((layer) => layer.attr_id === "supply_poi")!;
    const color = (key: string) => supply.display_axes[0].categories.find((category) => category.key === key)!.color;
    renderProfile({
      selected: { segment: CLIMB, latitude: 35, longitude: 139 },
      layers: { ids: ["supply_poi"], toggle: vi.fn() },
      points: [
        { distance_km: 0.01, layer: "supply_poi", properties: { kind: "convenience", name: "ローソン 渋谷店" } },
        { distance_km: 0.8, layer: "stop_poi", properties: { kind: "stop" } },
        { distance_km: 1.5, layer: "supply_poi", properties: { kind: "toilets" } },
      ],
    });
    await openLayers();
    const chart = screen.getByRole("img", { name: "道のりに沿った情報" });
    const marks = [...chart.querySelectorAll('[data-layer="supply_poi"] line')];
    expect(marks.map((mark) => mark.getAttribute("stroke"))).toEqual([color("convenience"), color("toilets")]);
    expect(chart.querySelector('[data-layer="stop_poi"]')).toBeNull();

    expect(screen.getByText("補給・休憩ポイント・この地点 コンビニ ローソン 渋谷店")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "グラフに出す情報" }));
    expect(
      within(screen.getByRole("list", { name: "補給・休憩ポイントの凡例" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["コンビニ", "トイレ"]);
  });

  it.each<{ why: string; ids: string[]; segments: RouteSegmentDetail[]; text: string }>([
    { why: "出す情報を選んでいない", ids: [], segments: [CLIMB], text: "出す情報を選んでください。" },
    { why: "選んだ情報の値が無い", ids: ["elevation"], segments: [UNKNOWN], text: "標高の値がありません。" },
    {
      why: "選んだ点がルートの近くに無い",
      ids: ["supply_poi"],
      segments: [CLIMB],
      text: "補給・休憩ポイントはルートの近くにありません。",
    },
  ])("$why ときは、折れ線の代わりに文で知らせる", async ({ ids, segments, text }) => {
    renderProfile({ segments, layers: { ids, toggle: vi.fn() } });
    await openLayers();
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "道のりに沿った情報" }).querySelector("polyline")).toBeNull();
  });
});
