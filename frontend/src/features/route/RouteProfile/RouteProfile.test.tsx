/**
 * `features/route/RouteProfile/RouteProfile.tsx`——道のりのグラフの「表示」「評価で塗る」のタブ（名前は地図の2つの入口と同じ `lib/screenNames.ts`）と、
 * 地点を選んでいる間の「区間を地図で見る」。
 *
 * 見るもの: 既定で「評価で塗る」（難易度のグラフ）を出すこと、その (i) が塗った軸の色と名前・値の無い区間の色・意味の文を出すこと
 * （塗る区間の無い軸は出さない）、両方のタブで経由地を通る所に線と番号の印を出し、走り終えた経由地を薄めること。タブは結果も
 * 走行中も地図の入口と同じ絵だけで出し（名前は読み上げに残す）、押すと図が替わること。走行中の図は、目盛り・図の下の文字を
 * 結果の図より大きくすること。地点を選ぶと、右上に「区間を地図で見る」を出すこと。
 *
 * 差し替えたもの: グラフの実寸（`getBoundingClientRect`。テスト環境は実寸を返さない）。道の区分の層は軸カタログの応答としてテストが組む
 * （本番の層は管理DBが持つ）。
 *
 * ここで見ないもの: 「表示」の図の折れ線・帯・現在地の印・値の目盛りと、出す情報の一覧 → `RouteProfile.layers.test.tsx`。
 * 難易度の塗り・なぞって地点を選ぶ操作 → `DifficultyProfile.test.tsx`。地点の値・行の計算 → `profileLayers.test.ts`。
 * 選んだ地点の値（区間の小窓）→ `features/route/SegmentDetail/SegmentDetail.test.tsx`。
 */
import { EVALUATION_PAINT_NAME, FACT_DISPLAY_NAME } from "@/lib/screenNames";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CATALOG,
  PAVED,
  UNKNOWN,
  openLayers,
  profileElement,
  renderProfile,
  serveProfileCatalog,
} from "@/testing/routeProfile";
import { mapDisplay } from "@/types/generated/mapDisplay";
import type { SelectedRouteSegment } from "@/types/route";

beforeEach(serveProfileCatalog);

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

  it.each([
    { riding: true, tab: EVALUATION_PAINT_NAME },
    { riding: false, tab: FACT_DISPLAY_NAME },
  ])(
    "走行中（$riding）の「$tab」の図をなぞって地点を選ぶと、右上に「区間を地図で見る」を出す",
    async ({ riding, tab }) => {
      // 選択はページが持つので、選んだ地点を図へ戻す。
      function Profile() {
        const [selected, setSelected] = useState<SelectedRouteSegment | null>(null);
        return profileElement({
          segments: [PAVED, UNKNOWN],
          selected,
          onSelect: setSelected,
          segmentOnMap: { outside: false, onShow: vi.fn() },
          progressKm: riding ? 1.5 : null,
          riding,
        });
      }
      render(<Profile />);
      await userEvent.click(screen.getByRole("tab", { name: tab }));
      expect(screen.queryByRole("button", { name: "区間を地図で見る" })).toBeNull();
      const slider = screen.getByRole("slider");
      vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ left: 0, width: 200 } as DOMRect);
      // 横幅200pxのうち25px＝2kmの物差しで0.25km地点。
      fireEvent.pointerDown(slider, { pointerId: 1, clientX: 25, buttons: 1 });
      fireEvent.pointerUp(slider, { pointerId: 1, clientX: 25 });

      expect(screen.getByRole("button", { name: "区間を地図で見る" })).toBeInTheDocument();
    },
  );
});
