/**
 * `RouteForm/RoutePoints.tsx`・`RouteForm/PointStrip.tsx`・`RouteForm/PointOrder.tsx`——周回の切り替えと地点の並びと通る順の並び。`RouteForm`の中に置かれる子なので、`RouteForm`を描いて確かめる。
 *
 * 見るもの: 周回の切り替え（押している状態と、押して上げる値）、地点の並び（出発地・経由地の番号の丸・終点。周回の間の終点は
 * 出発地の印と名前で押せない）、押した地点を選んで上げること、経由地の番号の丸を押さえて動かす並び替え、
 * 地点を選んでいる間に出す通る順の大きい丸の並び（出発地・経由地・目的地を押さえて動かす並び替え）、経由地を足す操作の上限、並びに出ている地点を全部消す操作。
 *
 * ここで見ないもの: 選んでいる地点をどう決めるか（何も選んでいない・選んだ経由地が消えた・探して足した経由地を選ぶ）
 * → `features/route/useGenerationConditions.points.test.ts`。押した地点の詳しくの中身 → `RouteForm/RouteForm.pointDetail.test.tsx`。
 * 並べ替えで地点の役割がどう変わるか → `features/route/useGenerationConditions.points.test.ts`。
 * 並びに入りきらないときに両端の札を印だけにすること・通る順の丸を縮めること（テスト環境はレイアウトの実寸を持たない）→ `e2e/all-states.spec.ts`の
 * 省略の検査（名前を途中で切っていないこと）。印の役割ごとの背景色（書いた定数をそのまま渡す）。
 *
 * 差し替えたもの: 辺りの口の応答（網の層）。辺り無しと答える。
 */
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PIN_MARK_COLOR } from "@/components/PinMark/PinMark";
import { onBackend, serveAxisCatalog } from "@/testing/backendServer";
import { catalogResponse } from "@/testing/catalogAxes";
import { DESTINATION, ORIGIN, button, detail, order, renderForm, strip, waypointsOf } from "@/testing/routeForm";
import { AZA_CANDIDATE as AZA, FACILITY_CANDIDATE as FACILITY } from "@/testing/routeFixtures";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

// 詳しくは置いた地点の辺りを引く。辺りを見ないテストには、辺り無しと答える（見るテストは後から応答を渡す）。
beforeEach(() => {
  onBackend("GET", "/api/place-area", () => Response.json({ area: null }));
  serveAxisCatalog(catalogResponse([]));
});

describe("RouteForm 地点の並び", () => {
  it("出発地・経由地の番号の丸・足す・目的地を並べ、選んでいる地点（既定は出発地）の詳しくを出す", () => {
    const [first, second] = waypointsOf(2);
    renderForm({
      waypoints: [first, second],
      destination: DESTINATION,
      foundAt: (at) => (at === second ? FACILITY : at === DESTINATION ? AZA : null),
    });

    expect(strip()).toEqual([
      "出発地: 現在地",
      "経由地1: 地図で選んだ地点",
      `経由地2: ${FACILITY.name}`,
      "経由地を足す",
      `目的地: ${AZA.name}`,
    ]);
    expect(button("出発地: 現在地")).toHaveAttribute("aria-pressed", "true");
    expect(detail("出発地")).toBeInTheDocument();
  });

  it("押した地点を選んで上げ、その詳しくを出す", async () => {
    const { selectPoint } = renderForm({
      waypoints: waypointsOf(2),
      foundAt: (at) => (at?.latitude === 35.01 ? FACILITY : null),
    });

    await userEvent.click(button(`経由地2: ${FACILITY.name}`));
    expect(selectPoint).toHaveBeenLastCalledWith({ role: "waypoint", index: 1 });
    expect(detail("経由地2").textContent).toContain(`経由地2${FACILITY.name}探して選んだ地点`);
    expect(button(`経由地2: ${FACILITY.name}`)).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(button("経由地を足す"));
    expect(selectPoint).toHaveBeenLastCalledWith({ role: "waypoint", index: null });
    expect(detail("新しい経由地")).toBeInTheDocument();
  });

  it.each([
    [routeGenerateConfig.max_waypoints, "経由地は上限まで置いてあります", true],
    [routeGenerateConfig.max_waypoints - 1, "経由地を足す", false],
  ])("経由地が%i件なら足す操作を「%s」とし、生成が受け付ける数までなら押せなくする", (waypointCount, name, full) => {
    renderForm({ waypoints: waypointsOf(waypointCount) });

    expect(button(name)).toHaveProperty("disabled", full);
  });

  it.each([
    [false, 0, null, "経由地と目的地を全部消す", true],
    [false, 1, null, "経由地と目的地を全部消す", false],
    [false, 0, DESTINATION, "経由地と目的地を全部消す", false],
    [true, 0, null, "経由地を全部消す", true],
  ])(
    "周回か（%s）・経由地が%i件・目的地が%oなら、全部消す操作を「%s」とし、押せない（%s）",
    (loop, waypointCount, destination, name, disabled) => {
      renderForm({ loop, waypoints: waypointsOf(waypointCount), destination });

      expect(button(name)).toHaveProperty("disabled", disabled);
    },
  );

  // 丸の幅はテスト環境に無いレイアウトの実寸なので、押さえた丸の幅をテストが決める。入る所は、離したときに丸いくつ分動いたかで決まる。
  it.each([
    { label: "丸1つ分より半分多く左へ動かすと、1つ前へ動かす", from: 2, dx: -45, to: 1 },
    { label: "並びの端より先へ動かすと、端へ動かす", from: 1, dx: 200, to: 2 },
  ])(
    "経由地の番号の丸を押さえたまま動かして離すと、その順へ動かすことを上げ、丸を選ばない: $label",
    ({ from, dx, to }) => {
      const { reorderPoints, selectPoint } = renderForm({ waypoints: waypointsOf(3) });
      const mark = button(`経由地${from + 1}: 地図で選んだ地点`);
      vi.spyOn(mark, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 0, 30, 30));

      fireEvent.pointerDown(mark, { pointerId: 1, isPrimary: true, clientX: 115 });
      fireEvent.pointerMove(mark, { pointerId: 1, isPrimary: true, clientX: 115 + dx });
      fireEvent.pointerUp(mark, { pointerId: 1, isPrimary: true, clientX: 115 + dx });
      fireEvent.click(mark);

      // 通る順の並びの番目は、先頭の出発地の分だけ経由地の番号より1つ後ろ。
      expect(reorderPoints).toHaveBeenCalledExactlyOnceWith(from + 1, to + 1, ORIGIN);
      expect(selectPoint).not.toHaveBeenCalled();
    },
  );

  it("経由地の番号の丸を押しただけなら、順を変えずにその経由地を選ぶ", async () => {
    const { reorderPoints, selectPoint } = renderForm({ waypoints: waypointsOf(3) });

    await userEvent.click(button("経由地2: 地図で選んだ地点"));

    expect(selectPoint).toHaveBeenLastCalledWith({ role: "waypoint", index: 1 });
    expect(reorderPoints).not.toHaveBeenCalled();
  });

  it("全部消す操作を押すと上げる", async () => {
    const { clearPoints } = renderForm({ waypoints: waypointsOf(2), destination: DESTINATION });

    await userEvent.click(button("経由地と目的地を全部消す"));

    expect(clearPoints).toHaveBeenCalledOnce();
  });
});

describe("RouteForm 通る順の並び", () => {
  /** 通る順の並びの丸の名前。 */
  const orderNames = () =>
    within(order() as HTMLElement)
      .getAllByRole("button")
      .map((mark) => mark.getAttribute("aria-label"));

  it.each([
    {
      label: "目的地を置いていなければ、末尾に空の目的地の丸を出す",
      loop: false,
      destination: null,
      names: ["出発地: 現在地（1番目）", "経由地1: 地図で選んだ地点（2番目）", "目的地: 未設定（3番目）"],
    },
    {
      label: "周回の間は、目的地の丸を出さない",
      loop: true,
      destination: DESTINATION,
      names: ["出発地: 現在地（1番目）", "経由地1: 地図で選んだ地点（2番目）"],
    },
  ])(
    "地点を押すと、詳しくの上に出発地・経由地・目的地の丸を通る順に並べ、動かし方を添える: $label",
    async ({ loop, destination, names }) => {
      renderForm({ loop, destination, waypoints: waypointsOf(1) });
      expect(order()).toBeNull();

      await userEvent.click(button("経由地1: 地図で選んだ地点"));

      expect(orderNames()).toEqual(names);
      expect(
        within(order() as HTMLElement).getByRole("button", { name: "経由地1: 地図で選んだ地点（2番目）" }),
      ).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText(/^丸を押さえたまま左右へ動かすと、通る順を入れ替えます/)).toBeInTheDocument();
    },
  );

  it("新しい経由地を置く間は、通る順の並びを出さない（探す欄を上に残す）", async () => {
    renderForm({ waypoints: waypointsOf(1) });

    await userEvent.click(button("経由地を足す"));

    expect(order()).toBeNull();
  });

  // 丸の幅はテスト環境に無いレイアウトの実寸なので、押さえた丸の幅をテストが決める。
  it.each([
    { label: "経由地を先頭へ動かす", originLocated: true, destination: null, from: 2, dx: -100, to: 0 },
    { label: "目的地を間へ動かす", originLocated: true, destination: DESTINATION, from: 3, dx: -88, to: 1 },
    { label: "経由地を空の目的地の席へ動かす", originLocated: true, destination: null, from: 1, dx: 100, to: 3 },
    { label: "仮の出発地の前へは入れない", originLocated: false, destination: null, from: 2, dx: -100, to: 1 },
  ])(
    "通る順の丸を押さえたまま動かして離すと、その順へ動かすことを上げ、丸を選ばない: $label",
    ({ originLocated, destination, from, dx, to }) => {
      const { reorderPoints, selectPoint } = renderForm({
        originLocated,
        destination,
        waypoints: waypointsOf(2),
        selectedPoint: { role: "waypoint", index: 0 },
        pointChosen: true,
      });
      const mark = within(order() as HTMLElement).getAllByRole("button")[from];
      vi.spyOn(mark, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 0, 44, 44));

      fireEvent.pointerDown(mark, { pointerId: 1, isPrimary: true, clientX: 120 });
      fireEvent.pointerMove(mark, { pointerId: 1, isPrimary: true, clientX: 120 + dx });
      fireEvent.pointerUp(mark, { pointerId: 1, isPrimary: true, clientX: 120 + dx });
      fireEvent.click(mark);

      expect(reorderPoints).toHaveBeenCalledExactlyOnceWith(from, to, ORIGIN);
      expect(selectPoint).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: "置いていない目的地の丸", originLocated: true, from: 3, target: { role: "destination" } },
    { label: "仮の地点のままの出発地の丸", originLocated: false, from: 0, target: { role: "origin" } },
  ])("押さえて動かしても動かさず、押すと選ぶ丸: $label", ({ originLocated, from, target }) => {
    const { reorderPoints, selectPoint } = renderForm({
      originLocated,
      waypoints: waypointsOf(2),
      selectedPoint: { role: "waypoint", index: 0 },
      pointChosen: true,
    });
    const mark = within(order() as HTMLElement).getAllByRole("button")[from];
    vi.spyOn(mark, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 0, 44, 44));

    fireEvent.pointerDown(mark, { pointerId: 1, isPrimary: true, clientX: 120 });
    fireEvent.pointerMove(mark, { pointerId: 1, isPrimary: true, clientX: 20 });
    fireEvent.pointerUp(mark, { pointerId: 1, isPrimary: true, clientX: 20 });
    fireEvent.click(mark);

    expect(reorderPoints).not.toHaveBeenCalled();
    expect(selectPoint).toHaveBeenLastCalledWith(target);
  });
});

describe("RouteForm 周回", () => {
  it.each([
    [true, "true", false],
    [false, "false", true],
  ] as const)(
    "周回か（%s）で切り替えを押した状態（%s）にし、押すと反対（%s）を上げる",
    async (loop, pressed, raised) => {
      const { setLoop } = renderForm({ loop });

      expect(button("周回")).toHaveAttribute("aria-pressed", pressed);
      await userEvent.click(button("周回"));

      expect(setLoop).toHaveBeenCalledExactlyOnceWith(raised);
    },
  );

  it("周回の間は、終点を出発地の印と「出発地の名前[周回]」で出し、押せない（変えられるのは経由地だけ）", () => {
    renderForm({ loop: true, waypoints: waypointsOf(1), distanceTargeted: false });

    const end = screen.getByText("終点: 現在地[周回]").parentElement;
    expect(end?.querySelector("svg")?.parentElement).toHaveStyle({ color: PIN_MARK_COLOR.origin });
    expect(strip()).toEqual(["出発地: 現在地", "経由地1: 地図で選んだ地点", "経由地を足す"]);
  });

  it("周回を外すと、終点は目的地の札で出し、目的地の印を付ける", () => {
    renderForm({ loop: false, destination: DESTINATION });

    const mark = button("目的地: 地図で選んだ地点").querySelector("svg")?.parentElement;
    expect(mark).toHaveStyle({ color: PIN_MARK_COLOR.destination });
    expect(screen.queryByText(/^終点:/)).toBeNull();
  });
});
