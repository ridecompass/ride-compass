/**
 * `features/route/RouteProfile/RouteProfile.tsx`——道のりのグラフの「表示」「負担で塗る」のタブ（名前は地図の2つの入口と同じ `lib/screenNames.ts`）と、
 * 地点を選んでいる間の「区間を地図で見る」。
 *
 * 見るもの: 既定で「負担で塗る」（負担のグラフ）を出すこと、選んでいなければルートで負担の大きい2つを積み、右上の
 * 「グラフに積む負担」の一覧に軸ごとの事実と負担の分を並べ、チェックで積む軸を足し・外して端末に覚えること（回避指定の行は
 * チェックを持たず、走行中の図は一覧を出さない）、両方のタブで経由地を通る所に線と番号の印を出し、走り終えた経由地を薄めること。タブは結果も
 * 走行中も地図の入口と同じ絵だけで出し（名前は読み上げに残す）、押すと図が替わること。走行中の図は、目盛り・図の下の文字を
 * 結果の図より大きくすること。地点を選ぶと、右上に「区間を地図で見る」を出すこと。
 *
 * 差し替えたもの: グラフの実寸（`getBoundingClientRect`。テスト環境は実寸を返さない）。道の区分の層は画面の設定の応答としてテストが組む
 * （本番の層は管理DBが持つ）。
 *
 * ここで見ないもの: 「表示」の図の折れ線・帯・現在地の印・値の目盛りと、出す情報の一覧 → `RouteProfile.layers.test.tsx`。
 * 負担の塗り → `DifficultyProfile.test.tsx`。なぞって地点を選ぶ操作 → `ProfileChart.test.tsx`。地点・選んだ区間の値と行の計算 → `profileLayers.test.ts`。
 */
import { BURDEN_PAINT_NAME, FACT_DISPLAY_NAME } from "@/lib/screenNames";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { makeRouteSegment, penaltyFields } from "@/testing/routeFixtures";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PAVED,
  PROFILE_COST_CATALOG,
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
  it("はじめは「負担で塗る」で、負担の大きい2つを積む。右上の「グラフに積む負担」の一覧は軸ごとに事実と負担の分を並べ、チェックで積む軸を足し・外して端末に覚え、回避指定の行にはチェックを置かない", async () => {
    window.localStorage.clear();
    const catalog = {
      ...PROFILE_COST_CATALOG,
      axes: [
        ...PROFILE_COST_CATALOG.axes,
        { axisId: "stopping", label: "停止" },
        { axisId: "friction", label: "摩擦" },
      ],
      axisColors: { ...PROFILE_COST_CATALOG.axisColors, stopping: "rgb(1, 2, 3)", friction: "rgb(4, 5, 6)" },
    };
    const segment = makeRouteSegment({
      distance_km: 1,
      ...penaltyFields({ ascent: 40, vibration: 10, stopping: 25 }, 1),
    });
    const element = () =>
      profileElement({
        segments: [segment],
        scaleKm: 1,
        catalog,
        penalty: {
          axis_seconds: { ascent: 300, vibration: 60, stopping: 120 },
          avoidance_seconds: 120,
          total_seconds: 600,
        },
        // 区分の事実は値を持たず、区分の名前だけを出す。
        facts: {
          ascent: { label: "登り", value: 240, unit: "m" },
          vibration: { label: "砂利", value: null, unit: "" },
        },
      });
    const { unmount } = render(element());
    expect(screen.getByRole("tab", { name: BURDEN_PAINT_NAME })).toHaveAttribute("aria-selected", "true");
    const openList = () => userEvent.click(screen.getByRole("button", { name: "グラフに積む負担" }));
    const rows = () =>
      within(screen.getByRole("dialog"))
        .getAllByRole("listitem")
        .map((row) => [row.textContent, within(row).queryByRole("checkbox")?.getAttribute("aria-checked") ?? null]);
    const fills = () =>
      [...screen.getByRole("img", { name: "道のりに沿った負担" }).querySelectorAll("path[fill]")].map((path) =>
        path.getAttribute("fill"),
      );

    await openList();
    expect(rows()).toEqual([
      ["登坂登り 240m+5分", "true"],
      ["振動砂利+1分", "false"],
      ["停止+2分", "true"],
      ["回避指定+2分", null],
    ]);
    expect(fills()).toEqual([catalog.axisColors.ascent, catalog.axisColors.stopping]);

    await userEvent.click(screen.getByRole("checkbox", { name: "振動" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "登坂" }));
    expect(fills()).toEqual([catalog.axisColors.vibration, catalog.axisColors.stopping]);

    unmount();
    render(element());
    await openList();
    expect(rows().map(([, checked]) => checked)).toEqual(["false", "true", "true", null]);
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
    expect(lines("道のりに沿った負担")).toEqual(["250", "750"]);
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
      for (const name of [FACT_DISPLAY_NAME, BURDEN_PAINT_NAME]) {
        const tab = screen.getByRole("tab", { name });
        expect(tab.querySelector("svg")).not.toBeNull();
        expect(within(tab).getByText(name)).toHaveClass("sr-only");
      }
      await openLayers();
      expect(screen.getByRole("img", { name: "道のりに沿った情報" })).toBeInTheDocument();
      expect(screen.queryByRole("img", { name: "道のりに沿った負担" })).toBeNull();
      for (const text of [screen.getByText("2.0km"), screen.getByText("標高 最高 32m・最低 12m")])
        expect(text.closest(".text-base") !== null).toBe(large);

      await userEvent.click(screen.getByRole("tab", { name: BURDEN_PAINT_NAME }));
      expect(screen.getByRole("img", { name: "道のりに沿った負担" })).toBeInTheDocument();
    },
  );

  it.each([
    { riding: true, tab: BURDEN_PAINT_NAME },
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
