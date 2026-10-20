/**
 * `RouteForm/RoutePoints.tsx`・`RouteForm/PointStrip.tsx`——周回の切り替えと地点の並び。`RouteForm`の中に置かれる子なので、`RouteForm`を描いて確かめる。
 *
 * 見るもの: 周回の切り替え（押している状態と、押して上げる値）、地点の並び（出発地・経由地の番号の丸・終点。周回の間の終点は
 * 出発地の印と名前で押せない）、押した地点を選んで上げること、経由地を足す操作の上限、並びに出ている地点を全部消す操作。
 *
 * ここで見ないもの: 選んでいる地点をどう決めるか（何も選んでいない・選んだ経由地が消えた・探して足した経由地を選ぶ）
 * → `features/route/useGenerationConditions.test.ts`。押した地点の詳しくの中身 → `RouteForm/RouteForm.pointDetail.test.tsx`。
 * 並びに入りきらないときに両端の札を印だけにすること（テスト環境はレイアウトの実寸を持たない）→ `e2e/all-states.spec.ts`の
 * 省略の検査（名前を途中で切っていないこと）。印の役割ごとの背景色（書いた定数をそのまま渡す）。
 *
 * 差し替えたもの: 辺りの口の応答（網の層）。辺り無しと答える。
 */
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { PIN_MARK_COLOR } from "@/components/PinMark/PinMark";
import { onBackend, serveAxisCatalog } from "@/testing/backendServer";
import { catalogResponse } from "@/testing/catalogAxes";
import { DESTINATION, button, detail, renderForm, strip, waypointsOf } from "@/testing/routeForm";
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

  it("全部消す操作を押すと上げる", async () => {
    const { clearPoints } = renderForm({ waypoints: waypointsOf(2), destination: DESTINATION });

    await userEvent.click(button("経由地と目的地を全部消す"));

    expect(clearPoints).toHaveBeenCalledOnce();
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
