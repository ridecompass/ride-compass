/**
 * `RouteForm/PointList.tsx`——「ルート設定」の条件タブの、周回か目的地かの2択と地点の縦の一覧。`RouteForm`の中に置かれる子なので、
 * `RouteForm`を描いて確かめる。
 *
 * 見るもの: 2択（選んでいる側と、押して上げる値）、地点の一覧（出発地・経由地・終点を通る順に並べ、周回の間の終点は押せない
 * 「出発地へ戻る」）、行を押すとその地点を選んで上げ、その地点を探す小窓を開くこと、行の✕で消すこと、「＋ 経由地」で目的地の手前に
 * 足す行を出し、✕でやめること・上限で押せないこと、行の「地図で置く」で小窓を開かずにその地点を選ぶこと、つまみを押さえて上下へ動かす並べ替えと、動かせない行。仮の出発地の置き方の文と、
 * 地図で置けない間は地図を案内しないこと。キーボードで小窓へ入って出られること、説明を見る状態の案内へ移っても小窓を閉じないこと。
 *
 * ここで見ないもの: 選んでいる地点をどう決めるか・並べ替えで地点の役割がどう変わるか →
 * `features/route/useGenerationConditions.points.test.ts`。小窓の中身 → `PlaceSearch/PointSearch.test.tsx`。
 * 生成を押したときに出発地の行を強調してフォーカスを移すこと・小窓を開いたまま地図を押すと閉じるだけで置かないこと →
 * `app/page.places.test.tsx`。
 *
 * 差し替えたもの: 辺りの口の応答（網の層）。辺り無しと答える。行の枠（テスト環境はレイアウトを持たない）。
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { USAGE_GUIDE_ATTRIBUTE } from "@/components/UsageGuide/usageTarget";
import { onBackend, serveClientConfig } from "@/testing/backendServer";
import { DESTINATION, ORIGIN, button, openPointSearch, pointRows, renderForm, waypointsOf } from "@/testing/routeForm";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

beforeEach(() => {
  window.localStorage.clear();
  onBackend("GET", "/api/place-area", () => Response.json({ area: null }));
  serveClientConfig();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("RouteForm 周回か目的地か", () => {
  it.each([
    [true, "周回", "目的地", false],
    [false, "目的地", "周回", true],
  ] as const)(
    "周回か（%s）で「%s」を選んでいて、「%s」を押すと反対（%s）を上げる",
    async (loop, chosen, other, raised) => {
      const { setLoop } = renderForm({ loop });

      expect(screen.getByRole("radio", { name: chosen })).toHaveAttribute("aria-checked", "true");
      await userEvent.click(screen.getByRole("radio", { name: other }));

      expect(setLoop).toHaveBeenCalledExactlyOnceWith(raised);
    },
  );
});

describe("RouteForm 地点の一覧", () => {
  it.each([
    {
      label: "目的地",
      loop: false,
      rows: ["出発地 現在地", "経由地1 地図で選んだ地点", "目的地 地図で選んだ地点"],
      end: false,
    },
    { label: "周回", loop: true, rows: ["出発地 現在地", "経由地1 地図で選んだ地点"], end: true },
  ])("出発地・経由地・終点を通る順に並べる（$label の終点は押せない「出発地へ戻る」）", ({ loop, rows, end }) => {
    renderForm({ loop, waypoints: waypointsOf(1), destination: DESTINATION });

    expect(pointRows()).toEqual(rows);
    expect(screen.queryByText("出発地へ戻る") !== null).toBe(end);
  });

  it("行を押すとその地点を選んで上げ、その地点を探す小窓を開く", async () => {
    const { selectPoint } = renderForm({ waypoints: waypointsOf(2) });

    await openPointSearch("経由地2");

    expect(selectPoint).toHaveBeenCalledExactlyOnceWith({ role: "waypoint", index: 1 });
    await userEvent.keyboard("{Escape}");
    expect(button("経由地2 地図で選んだ地点")).toHaveAttribute("aria-pressed", "true");
  });

  it.each([
    { title: "経由地1", raised: "removeWaypoint", args: [0] },
    { title: "目的地", raised: "clearDestination", args: [] },
  ] as const)("行の✕でその地点を消す: $title", async ({ title, raised, args }) => {
    const handlers = renderForm({ destination: DESTINATION, waypoints: waypointsOf(2) });

    await userEvent.click(button(`${title}を消す`));

    expect(handlers[raised]).toHaveBeenCalledExactlyOnceWith(...args);
  });

  it("行の「地図で置く」は、小窓を開かずにその地点を選んで上げる", async () => {
    const { selectPoint } = renderForm({ waypoints: waypointsOf(1) });

    await userEvent.click(button("経由地1を地図で置く"));

    expect(selectPoint).toHaveBeenCalledExactlyOnceWith({ role: "waypoint", index: 0 });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(button("経由地1 地図で選んだ地点")).toHaveAttribute("aria-pressed", "true");
  });

  it("地図で置けない間は、行の「地図で置く」を出さない", () => {
    renderForm({ waypoints: waypointsOf(1), placing: false });

    expect(screen.queryByRole("button", { name: "経由地1を地図で置く" })).toBeNull();
  });

  it("置いていない目的地は消せず、出発地の行には消す✕を出さない", () => {
    renderForm({ waypoints: waypointsOf(1) });

    expect(button("目的地を消す")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "出発地を消す" })).toBeNull();
  });
});

describe("RouteForm 経由地を足す", () => {
  it("「＋ 経由地」で目的地の手前に足す行を、小窓を開かずにほかの行と同じ操作で出し、行の✕でやめる", async () => {
    const { selectPoint } = renderForm({ waypoints: waypointsOf(1), destination: DESTINATION });

    await userEvent.click(button("＋ 経由地"));

    expect(selectPoint).toHaveBeenLastCalledWith({ role: "waypoint", index: null });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(button("新しい経由地を地図で置く")).toBeInTheDocument();
    expect(button("新しい経由地を保存した地点から選ぶ")).toBeInTheDocument();
    expect(pointRows()).toEqual([
      "出発地 現在地",
      "経由地1 地図で選んだ地点",
      "新しい経由地 未設定",
      "目的地 地図で選んだ地点",
    ]);
    await userEvent.click(button("経由地を足すのをやめる"));
    expect(selectPoint).toHaveBeenLastCalledWith({ role: "origin" });
    expect(pointRows()).toHaveLength(3);
  });

  it("経由地を上限まで置いたあとは「＋ 経由地」を押せない", () => {
    renderForm({ waypoints: waypointsOf(routeGenerateConfig.max_waypoints) });

    expect(button("＋ 経由地")).toBeDisabled();
  });
});

describe("RouteForm 地点の並べ替え", () => {
  // 行の高さはテスト環境に無いレイアウトの実寸なので、テストが決める（高さ32・間0で、上から32ずつ）。
  function layOutRows() {
    const rows = [...document.querySelectorAll<HTMLElement>("[data-point-row]")];
    rows.forEach((row, index) =>
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue(new DOMRect(0, index * 32, 300, 32)),
    );
    return rows;
  }

  function drag(title: string, dy: number) {
    const rows = layOutRows();
    const handle = button(`${title}を動かす`);
    const y = rows.findIndex((row) => row.contains(handle)) * 32 + 16;
    fireEvent.pointerDown(handle, { pointerId: 1, isPrimary: true, clientY: y });
    fireEvent.pointerMove(handle, { pointerId: 1, isPrimary: true, clientY: y + dy });
    fireEvent.pointerUp(handle, { pointerId: 1, isPrimary: true, clientY: y + dy });
  }

  it.each([
    {
      label: "経由地を先頭へ動かす",
      originLocated: true,
      destination: null,
      title: "経由地2",
      dy: -80,
      from: 2,
      to: 0,
    },
    {
      label: "目的地を間へ動かす",
      originLocated: true,
      destination: DESTINATION,
      title: "目的地",
      dy: -80,
      from: 3,
      to: 1,
    },
    {
      label: "経由地を空の目的地の席へ動かす",
      originLocated: true,
      destination: null,
      title: "経由地1",
      dy: 80,
      from: 1,
      to: 3,
    },
    {
      label: "仮の出発地の前へは入れない",
      originLocated: false,
      destination: null,
      title: "経由地2",
      dy: -80,
      from: 2,
      to: 1,
    },
  ])(
    "つまみを押さえたまま上下へ動かして離すと、その順へ動かすことを上げる: $label",
    ({ originLocated, destination, title, dy, from, to }) => {
      const { reorderPoints } = renderForm({ originLocated, destination, waypoints: waypointsOf(2) });

      drag(title, dy);

      expect(reorderPoints).toHaveBeenCalledExactlyOnceWith(from, to, ORIGIN);
    },
  );

  it.each([
    { label: "置いていない目的地", loop: false, originLocated: true, waypointCount: 2, title: "目的地" },
    { label: "仮の地点のままの出発地", loop: false, originLocated: false, waypointCount: 2, title: "出発地" },
    {
      label: "周回の間に、仮の出発地のほかに1つだけある経由地",
      loop: true,
      originLocated: false,
      waypointCount: 1,
      title: "経由地1",
    },
  ])("動かせない行のつまみは押せない: $label", ({ loop, originLocated, waypointCount, title }) => {
    renderForm({ loop, originLocated, waypoints: waypointsOf(waypointCount) });

    expect(button(`${title}を動かす`)).toBeDisabled();
  });
});

describe("RouteForm 仮の出発地", () => {
  it.each([
    { placing: true, guide: "押して探すか、地図をタップ" },
    { placing: false, guide: "押して探す" },
  ])(
    "出発地が仮の地点のままなら、名前の所で置き方を言い、地図で置けない間（$placing）は地図を案内しない",
    async ({ placing, guide }) => {
      renderForm({ originLocated: false, placing });

      expect(within(screen.getByRole("list", { name: "通る順" })).getByText(guide)).toBeVisible();
      expect(pointRows()[0]).toBe("出発地 未設定");
      await openPointSearch("出発地");
      expect(screen.queryByRole("button", { name: "地図で置く" }) !== null).toBe(placing);
    },
  );
});

describe("RouteForm 小窓のフォーカス", () => {
  it("キーボードで行から開くと小窓へ移って Tab で欄へ進め、閉じると押した行へ戻る", async () => {
    renderForm({ waypoints: waypointsOf(1) });
    const row = button("経由地1 地図で選んだ地点");
    row.focus();

    await userEvent.keyboard("{Enter}");
    await userEvent.tab();
    await userEvent.tab();
    expect(screen.getByRole("searchbox", { name: "経由地1を住所・施設で探す" })).toHaveFocus();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "経由地1を探す" })).toBeNull();
    expect(row).toHaveFocus();
  });

  it("説明を見る状態の案内へフォーカスが移っても、小窓を閉じない", async () => {
    renderForm({ waypoints: waypointsOf(1) });
    const guide = document.createElement("button");
    guide.setAttribute(USAGE_GUIDE_ATTRIBUTE, "");
    document.body.append(guide);
    await openPointSearch("経由地1");

    act(() => guide.focus());

    expect(screen.getByRole("dialog", { name: "経由地1を探す" })).toBeInTheDocument();
    guide.remove();
  });
});
