/**
 * `features/route/ProfileChart/ProfileChart.tsx`——道のりに沿った図の枠（難易度の図と「表示」の図が中身を差し込む）。
 *
 * 見るもの: 選ばれた区間の帯とスライダーとしての値、キーボード（矢印・Home・End）と1本の指（マウス）で横になぞる・
 * 押して離す操作で選ぶ区間と地点、押しただけ・ボタンを押していない動き・縦に動き出した操作・2本目の指が加わった操作では
 * 選ばないこと、自分で動かした地点の線（選ばれた区間の中にあるときだけ）、選ぶ受け口が無ければ見るだけの図にすること。
 *
 * ここで見ないもの: 図の中身（難易度の塗り・現在地の印の高さ） → `DifficultyProfile.test.tsx`・`RouteProfile.test.tsx`。
 * 区間の中の割合から地点を引く計算（道なりの形の上） → `lib/routeDistance.ts`。
 *
 * 差し替えたもの: グラフの実寸（`getBoundingClientRect`。テスト環境は実寸を返さない）。
 */
import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { makeRouteSegment } from "@/testing/routeFixtures";
import type { RouteSegmentDetail, SelectedRouteSegment } from "@/types/route";
import ProfileChart, { useProfileScale } from "./ProfileChart";

// 北緯35度の上を東へ1kmずつ進む2区間（道なりの形は持たず、始点と終点を結ぶ直線の上で地点を引く）。
const FIRST = makeRouteSegment({
  distance_km: 1,
  start_latitude: 35,
  start_longitude: 139,
  end_latitude: 35,
  end_longitude: 139.01,
});
const MISSING = makeRouteSegment({
  distance_km: 1,
  start_latitude: 35,
  start_longitude: 139.01,
  end_latitude: 35,
  end_longitude: 139.02,
});
const LABEL = "道のりの図";

type Props = {
  segments: RouteSegmentDetail[];
  scaleKm: number;
  selected: SelectedRouteSegment | null;
  onSelect?: (selection: SelectedRouteSegment) => void;
};

/** 物差しを`useProfileScale`で組んで、中身の無い枠を描く。 */
function Chart({ segments, scaleKm, selected, onSelect }: Props) {
  const scale = useProfileScale(segments, scaleKm);
  return (
    <ProfileChart
      scale={scale}
      label={LABEL}
      usage="なぞると地点を選ぶ"
      selected={selected}
      onSelect={onSelect}
      waypointKms={[]}
    >
      {null}
    </ProfileChart>
  );
}

function chartProps(props: Partial<Props> = {}): Props {
  return { segments: [FIRST, MISSING], scaleKm: 2, selected: null, onSelect: vi.fn(), ...props };
}

function renderProfile(props: Partial<Props> = {}) {
  const all = chartProps(props);
  const view = render(<Chart {...all} />);
  return {
    ...view,
    onSelect: all.onSelect as ReturnType<typeof vi.fn>,
    slider: within(view.container).queryByRole("slider"),
  };
}

function selection(segment: RouteSegmentDetail): SelectedRouteSegment {
  return { segment, latitude: segment.start_latitude, longitude: segment.start_longitude };
}

/** 地点を選んだ操作で上がった区間と、その地点の経度。 */
function lastSelection(onSelect: ReturnType<typeof vi.fn>): { segment: RouteSegmentDetail; longitude: number } {
  const [selected] = onSelect.mock.lastCall as [SelectedRouteSegment];
  expect(selected.latitude).toBeCloseTo(35, 9);
  return { segment: selected.segment, longitude: selected.longitude };
}

/** グラフの実寸を、左端100px・幅200pxにする。 */
function layOut(slider: HTMLElement) {
  vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ left: 100, width: 200 } as DOMRect);
}

describe("ProfileChart", () => {
  it("スライダーの値は、選ばれた区間の始まりの距離（選ばれていなければ0）", () => {
    const { slider, rerender } = renderProfile();
    expect(slider).toHaveAttribute("aria-valuemin", "0");
    expect(slider).toHaveAttribute("aria-valuemax", "2");
    expect(slider).toHaveAttribute("aria-valuenow", "0");
    expect(slider).toHaveAttribute("aria-valuetext", "0.0 km地点");
    expect(slider?.querySelector("rect")).toBeNull();

    rerender(<Chart {...chartProps({ selected: selection(MISSING) })} />);
    expect(slider).toHaveAttribute("aria-valuenow", "1");
    expect(slider).toHaveAttribute("aria-valuetext", "1.0 km地点");
    expect(slider?.querySelector("rect")).toHaveAttribute("x", "500");
    expect(slider?.querySelector("rect")).toHaveAttribute("width", "500");
  });

  it("Home・Endで道のりの始点・終点を選ぶ", () => {
    const { slider, onSelect } = renderProfile();
    fireEvent.keyDown(slider!, { key: "End" });
    expect(lastSelection(onSelect)).toEqual({ segment: MISSING, longitude: 139.02 });
    fireEvent.keyDown(slider!, { key: "Home" });
    expect(lastSelection(onSelect)).toEqual({ segment: FIRST, longitude: 139 });
  });

  it("矢印は選ばれた区間の始まりから全長の1%ずつ動き、始点より手前へは出ない", () => {
    const { slider, onSelect } = renderProfile({ selected: selection(MISSING) });
    fireEvent.keyDown(slider!, { key: "ArrowRight" });
    const right = lastSelection(onSelect);
    expect(right.segment).toBe(MISSING);
    // 1km地点から0.02km進む = 2つ目の区間の2%。
    expect(right.longitude).toBeCloseTo(139.0102, 9);

    const fresh = renderProfile();
    fireEvent.keyDown(fresh.slider!, { key: "ArrowLeft" });
    expect(lastSelection(fresh.onSelect)).toEqual({ segment: FIRST, longitude: 139 });
  });

  it("選ばれた区間が短くても、帯は見える幅で描く", () => {
    const short = makeRouteSegment({ ...FIRST, distance_km: 0.001 });
    const { slider } = renderProfile({ segments: [short, MISSING], selected: selection(short) });
    expect(slider?.querySelector("rect")).toHaveAttribute("width", "2");
  });

  it("横軸が候補より長いとき、候補の終わりより右を押すと終点を選び、線も終点に引く", () => {
    const { slider, onSelect, rerender } = renderProfile({ scaleKm: 4 });
    layOut(slider!);
    // 横幅200pxのうち150px＝4kmの物差しで3km地点（候補は2kmで終わる）。
    fireEvent.pointerDown(slider!, { pointerId: 1, clientX: 250, buttons: 1 });
    fireEvent.pointerUp(slider!, { pointerId: 1, clientX: 250 });
    expect(lastSelection(onSelect)).toEqual({ segment: MISSING, longitude: 139.02 });

    rerender(<Chart {...chartProps({ scaleKm: 4, selected: selection(MISSING) })} />);
    expect(slider?.querySelector("line")).toHaveAttribute("x1", "500");
    expect(slider).toHaveAttribute("aria-valuenow", "2");
  });

  it("矢印・Home・End以外のキーでは選ばない", () => {
    const { slider, onSelect } = renderProfile();
    fireEvent.keyDown(slider!, { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("自分で動かした地点に線を引くのは、その地点が選ばれた区間の中にある間だけ", () => {
    const { slider, rerender } = renderProfile();
    fireEvent.keyDown(slider!, { key: "End" });
    // 地図で別の区間を押した。
    rerender(<Chart {...chartProps({ selected: selection(FIRST) })} />);
    expect(slider?.querySelector("line")).toBeNull();
    expect(slider).toHaveAttribute("aria-valuenow", "0");
  });

  it("選ぶ受け口が無ければ、押せない（選べると読み上げず、キーでも移れない）見るだけの図として描く", () => {
    const { container } = render(<Chart {...chartProps({ onSelect: undefined })} />);
    expect(within(container).queryByRole("slider")).toBeNull();
    expect(within(container).getByRole("img", { name: LABEL })).not.toHaveAttribute("tabindex");
  });

  it("押したまま横へ動かすとその地点を選び、離した地点も選ぶ", () => {
    const { slider, onSelect } = renderProfile();
    layOut(slider!);
    fireEvent.pointerDown(slider!, { pointerId: 1, clientX: 140, clientY: 10, buttons: 1 });
    fireEvent.pointerMove(slider!, { pointerId: 1, clientX: 150, clientY: 12, buttons: 1 });
    expect(lastSelection(onSelect).segment).toBe(FIRST);
    expect(lastSelection(onSelect).longitude).toBeCloseTo(139.005, 9);

    fireEvent.pointerUp(slider!, { pointerId: 1, clientX: 250 });
    expect(lastSelection(onSelect).segment).toBe(MISSING);
    expect(lastSelection(onSelect).longitude).toBeCloseTo(139.015, 9);
  });

  it("縦に動き出した操作（シートのスクロール）は、そのあと横へ動かしても離しても選ばない", () => {
    const { slider, onSelect } = renderProfile();
    layOut(slider!);
    fireEvent.pointerDown(slider!, { pointerId: 1, clientX: 150, clientY: 10, buttons: 1 });
    fireEvent.pointerMove(slider!, { pointerId: 1, clientX: 152, clientY: 30, buttons: 1 });
    fireEvent.pointerMove(slider!, { pointerId: 1, clientX: 250, clientY: 30, buttons: 1 });
    fireEvent.pointerUp(slider!, { pointerId: 1, clientX: 250, clientY: 30 });
    expect(onSelect).not.toHaveBeenCalled();

    // 指が離れたあとの操作は、また向きを決め直す。
    fireEvent.pointerDown(slider!, { pointerId: 2, clientX: 150, clientY: 10, buttons: 1 });
    fireEvent.pointerUp(slider!, { pointerId: 2, clientX: 150, clientY: 10 });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("ボタンを押していない動きでは選ばない", () => {
    const { slider, onSelect } = renderProfile();
    layOut(slider!);
    fireEvent.pointerMove(slider!, { pointerId: 1, clientX: 150, buttons: 0 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("グラフの上で2本目の指が加わった操作は、全部の指が離れるまで選ばない", () => {
    const { slider, onSelect } = renderProfile();
    layOut(slider!);
    fireEvent.pointerDown(slider!, { pointerId: 1, clientX: 150, buttons: 1 });
    fireEvent.pointerDown(slider!, { pointerId: 2, clientX: 200, buttons: 1 });
    fireEvent.pointerMove(slider!, { pointerId: 1, clientX: 160, buttons: 1 });
    fireEvent.pointerUp(slider!, { pointerId: 1, clientX: 160 });
    fireEvent.pointerUp(slider!, { pointerId: 2, clientX: 200 });
    expect(onSelect).not.toHaveBeenCalled();

    // 指が全部離れたあとの1本の指の操作は、また選べる。
    fireEvent.pointerDown(slider!, { pointerId: 3, clientX: 150, buttons: 1 });
    fireEvent.pointerUp(slider!, { pointerId: 3, clientX: 150 });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("2本目の指がグラフの外に触れても、その操作では選ばない", () => {
    const { slider, onSelect } = renderProfile();
    layOut(slider!);
    fireEvent.pointerDown(slider!, { pointerId: 1, clientX: 150, buttons: 1 });
    fireEvent.pointerDown(document.body, { pointerId: 2, buttons: 1 });
    fireEvent.pointerMove(slider!, { pointerId: 1, clientX: 160, buttons: 1 });
    fireEvent.pointerUp(slider!, { pointerId: 1, clientX: 160 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("取り消された指は数えず、そのあとの1本の指の操作で選べる", () => {
    const { slider, onSelect } = renderProfile();
    layOut(slider!);
    fireEvent.pointerDown(slider!, { pointerId: 1, clientX: 150, buttons: 1 });
    fireEvent.pointerDown(slider!, { pointerId: 2, clientX: 200, buttons: 1 });
    fireEvent.pointerCancel(slider!, { pointerId: 1 });
    fireEvent.pointerCancel(slider!, { pointerId: 2 });
    fireEvent.pointerDown(slider!, { pointerId: 3, clientX: 150, buttons: 1 });
    fireEvent.pointerUp(slider!, { pointerId: 3, clientX: 150 });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
