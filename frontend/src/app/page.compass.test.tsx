/**
 * `app/page.tsx`——トップページの右上の方位磁針と拡大・縮小。
 *
 * 見ること: 方位磁針が地図の北を指し、開いたダイヤルで地図を回して北へ戻すこと（なぞる途中で閉じたら回さない）、塗っている
 * レンズの式が走行方位を読むときだけ連動と出すこと、＋・－の拡大・縮小と長押しの案内。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 */
import { act, fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { serveCostAxisCatalog } from "@/testing/backendServer";
import { ALONG_FORMULA, BEARING_FORMULA, TWO_COST_AXES } from "@/testing/costAxes";
import { renderHome, serveHome } from "@/testing/homePage";
import { mapOnScreen } from "@/testing/maplibre";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

beforeEach(() => {
  serveHome();
});

describe("右上の方位磁針と拡大・縮小", () => {
  // 走る向きを渡すのは走行中だけなので、ルートの前は式の木が走行方位を読んでも、地図を回して塗りは変わらない。
  it.each([
    ["走行方位の節を持つ", BEARING_FORMULA],
    ["走行方位の節を持たない", ALONG_FORMULA],
  ])("走っていない間は、塗っているレンズの式の木が%sでも、右上の方位磁針に連動の印を付けない", async (_, formula) => {
    const ascent = TWO_COST_AXES.axes[0];
    serveCostAxisCatalog({
      ...TWO_COST_AXES,
      axes: [{ ...ascent, map_lens: { ...ascent.map_lens, formula } }, ...TWO_COST_AXES.axes.slice(1)],
    });
    const { user } = renderHome();
    await user.click(screen.getByRole("button", { name: /^難所を色で見る/ }));
    await user.click(await screen.findByRole("radio", { name: /登坂/ }));

    expect(screen.getByRole("button", { name: "地図の向き" }).getAttribute("aria-description")).toBeNull();
  });

  it("右上の方位磁針は地図の北を指し、押すと開くダイヤルの輪をなぞる・矢印のキーで地図が回り、真ん中の針で北が上に戻る。ダイヤルの文は方位と度だけ。＋・－で拡大・縮小し、長押しで1本指の拡大・縮小の案内が出る", async () => {
    const { user } = renderHome();
    const compass = screen.getByRole("button", { name: "地図の向き" });
    const needleTurn = () => compass.querySelector<HTMLElement>("[style]")?.style.transform;

    act(() => mapOnScreen().rotateByHand(90));
    expect(needleTurn()).toBe("rotate(-90deg)");

    await user.click(compass);
    const dial = await screen.findByRole("slider", { name: "地図の向き" });
    expect(dial).toHaveAttribute("aria-valuetext", "E 90°");
    expect(screen.getByRole("dialog").textContent).toMatch(/^[A-Z0-9° ]+$/);
    dial.focus();
    await user.keyboard("{ArrowLeft}");
    expect(mapOnScreen().bearing()).toBe(85);
    // 輪の中心の真上から真右へ、時計回りに4分の1なぞると、指の下の方位が付いてくるよう地図は反時計回りに回る。
    const center = dial.getBoundingClientRect();
    const cx = center.left + center.width / 2;
    const cy = center.top + center.height / 2;
    fireEvent.pointerDown(dial, { clientX: cx, clientY: cy - 50 });
    fireEvent.pointerMove(window, { clientX: cx + 50, clientY: cy });
    fireEvent.pointerUp(window);
    expect(mapOnScreen().bearing()).toBe(355);
    expect(needleTurn()).toBe("rotate(-355deg)");
    await user.click(screen.getByRole("button", { name: "北を上にする" }));
    expect(mapOnScreen().bearing()).toBe(0);
    await user.keyboard("{Escape}");

    const zoom = mapOnScreen().zoom();
    await user.click(screen.getByRole("button", { name: "拡大" }));
    expect(mapOnScreen().zoom()).toBe(zoom + 1);
    await user.click(screen.getByRole("button", { name: "縮小" }));
    expect(mapOnScreen().zoom()).toBe(zoom);
    fireEvent.pointerDown(screen.getByRole("button", { name: "拡大" }), { pointerType: "touch", button: 0 });
    expect(await screen.findByRole("tooltip", {}, { timeout: 2000 })).toHaveTextContent(
      /指を離さずに上下へ動かしても拡大・縮小できます/,
    );
  });

  it("輪をなぞっている途中でダイヤルを閉じても、その後の指の動きで地図は回らない", async () => {
    const { user } = renderHome();
    await user.click(screen.getByRole("button", { name: "地図の向き" }));
    const dial = await screen.findByRole("slider", { name: "地図の向き" });
    const center = dial.getBoundingClientRect();
    fireEvent.pointerDown(dial, { clientX: center.left, clientY: center.top - 50 });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("slider", { name: "地図の向き" })).toBeNull();
    fireEvent.pointerMove(window, { clientX: center.left + 50, clientY: center.top });
    expect(mapOnScreen().bearing()).toBe(0);
  });
});
