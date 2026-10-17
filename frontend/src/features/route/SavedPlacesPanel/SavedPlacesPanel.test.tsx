/**
 * 「保存済み」タブの「地点」（`SavedPlacesPanel.tsx`）——保存した地点を名前と辺りで並べ、「呼び出す」で選んだ役割の地点として置き、
 * 「消す」は確認の窓で「消す」を押したときだけ消す。無ければ無いと出し、保存の仕方を(i)の奥に置く。
 *
 * ここで見ないもの:
 * - 地点の保存 → `RouteForm/PointDetail.test.tsx`
 * - 呼び出した地点が条件に置かれ、条件タブへ移ること → `RouteForm/RouteForm.test.tsx`・`app/page.test.tsx`
 * - (i)の奥の文（書いた文をそのまま出す）
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { SavedPlace } from "@/features/route/savedPlaces";

import SavedPlacesPanel from "./SavedPlacesPanel";

const CAFE: SavedPlace = {
  kind: "facility",
  level: "point",
  name: "いつものカフェ",
  area: "文京区本駒込二丁目",
  latitude: 35.73,
  longitude: 139.75,
};
const HOME: SavedPlace = {
  kind: "facility",
  level: "point",
  name: "自宅",
  area: null,
  latitude: 35.75,
  longitude: 139.73,
};

function renderPanel({ waypointsFull = false }: { waypointsFull?: boolean } = {}) {
  const handlers = { onRecall: vi.fn(), onRemove: vi.fn() };
  render(<SavedPlacesPanel places={[CAFE, HOME]} waypointsFull={waypointsFull} {...handlers} />);
  return handlers;
}

describe("SavedPlacesPanel", () => {
  it("保存した地点を名前と辺りで並べ、無ければ無いと出して保存の仕方を(i)に置く", () => {
    const props = { waypointsFull: false, onRecall: () => {}, onRemove: () => {} };
    const { rerender } = render(<SavedPlacesPanel places={[CAFE, HOME]} {...props} />);
    expect(screen.getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      `${CAFE.name}${CAFE.area}`,
      HOME.name,
    ]);

    rerender(<SavedPlacesPanel places={[]} {...props} />);
    expect(screen.getByText("保存した地点はまだありません。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "地点の保存の仕方を表示" })).toBeInTheDocument();
  });

  it.each([
    ["出発地にする", "origin"],
    ["経由地に足す", "waypoint"],
    ["目的地にする", "destination"],
  ])("「呼び出す」のメニューで「%s」を押すと、その地点をその役割で置き、メニューを閉じる", async (label, role) => {
    const { onRecall, onRemove } = renderPanel();

    await userEvent.click(screen.getByRole("button", { name: "「自宅」を呼び出す" }));
    const menu = screen.getByRole("dialog", { name: "「自宅」をどこに置くか" });
    await userEvent.click(within(menu).getByRole("button", { name: label }));

    expect(onRecall).toHaveBeenCalledExactlyOnceWith(role, HOME);
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("経由地が上限まであれば「経由地に足す」だけを押せない", async () => {
    renderPanel({ waypointsFull: true });

    await userEvent.click(screen.getByRole("button", { name: "「自宅」を呼び出す" }));
    const menu = screen.getByRole("dialog", { name: "「自宅」をどこに置くか" });

    expect(within(menu).getByRole("button", { name: "経由地に足す" })).toBeDisabled();
    expect(within(menu).getByRole("button", { name: "出発地にする" })).toBeEnabled();
  });

  it("「消す」で、確認の窓の「消す」を押したときだけその地点を消す", async () => {
    const { onRemove } = renderPanel();
    const confirmDialog = () => screen.getByRole("dialog", { name: "「自宅」を消します" });

    await userEvent.click(screen.getByRole("button", { name: "「自宅」を消す" }));
    await userEvent.click(within(confirmDialog()).getByRole("button", { name: "キャンセル" }));
    expect(onRemove).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "「自宅」を消す" }));
    await userEvent.click(within(confirmDialog()).getByRole("button", { name: "消す" }));

    expect(onRemove).toHaveBeenCalledExactlyOnceWith(HOME);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
