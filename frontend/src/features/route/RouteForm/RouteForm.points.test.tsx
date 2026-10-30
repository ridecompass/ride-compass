/**
 * `RouteForm/RoutePoints.tsx`・`RouteForm/PointStrip.tsx`・`RouteForm/PointEditList.tsx`——周回の切り替えと地点の並びと地点の編集。`RouteForm`の中に置かれる子なので、`RouteForm`を描いて確かめる。
 *
 * 見るもの: 周回の切り替え（押している状態と、押して上げる値）、地点の並び（出発地・経由地の番号の丸・終点。周回の間の終点は
 * 出発地の印と名前で押せない）、押した地点を選んで上げること、経由地を足す操作の上限、並びに出ている地点を全部消す操作、
 * 地点の編集（地点を名前の行で通る順に並べ、開いたときに動かせる掴む所を揺らすこと、掴む所を押さえて動かす・矢印のキーで動かす並び替え、
 * 行の消すボタン、動かした行を前の位置から滑らせること、何が起きたかの読み上げの文）。
 *
 * ここで見ないもの: 選んでいる地点をどう決めるか（何も選んでいない・選んだ経由地が消えた・探して足した経由地を選ぶ）
 * → `features/route/useGenerationConditions.points.test.ts`。押した地点の詳しくの中身 → `RouteForm/RouteForm.pointDetail.test.tsx`。
 * 並べ替えで地点の役割がどう変わるか → `features/route/useGenerationConditions.points.test.ts`。
 * 並びに入りきらないときに両端の札を印だけにすること・経由地の番号の丸を縮めること（テスト環境はレイアウトの実寸を持たない）→ `e2e/all-states.spec.ts`の
 * 省略の検査（名前を途中で切っていないこと）。印の役割ごとの背景色（書いた定数をそのまま渡す）。
 *
 * 差し替えたもの: 辺りの口の応答（網の層）。辺り無しと答え、地点の編集では位置ごとの辺りを答える。地点の編集の行の枠と、行を滑らせる
 * `Element.animate`（テスト環境はレイアウトと動きを持たない）。
 */
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PIN_MARK_COLOR } from "@/components/PinMark/PinMark";
import { onBackend, serveAxisCatalog } from "@/testing/backendServer";
import { catalogResponse } from "@/testing/catalogAxes";
import { DESTINATION, ORIGIN, button, detail, editList, renderForm, strip, waypointsOf } from "@/testing/routeForm";
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

describe("RouteForm 地点の編集", () => {
  /** 地図で置いた地点・現在地の辺り（位置の緯度ごと）。 */
  const AREAS: Record<string, string> = {
    [String(ORIGIN.latitude)]: "王子",
    [String(waypointsOf(2)[0].latitude)]: "浅草",
    [String(waypointsOf(2)[1].latitude)]: "上野",
    [String(DESTINATION.latitude)]: "品川",
  };
  beforeEach(() => {
    onBackend("GET", "/api/place-area", ({ query }) => Response.json({ area: AREAS[String(query.latitude)] ?? null }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 編集の行の名前（通る順）。 */
  const rowNames = () =>
    within(editList() as HTMLElement)
      .getAllByRole("listitem")
      .map((row) => row.getAttribute("aria-label"));

  /** 何が起きたかの読み上げの文。 */
  const note = () => within(editList()?.parentElement as HTMLElement).getByRole("status").textContent;

  async function openEdit() {
    await userEvent.click(button("編集"));
    await within(editList() as HTMLElement).findByRole("listitem", { name: "出発地: 現在地（王子）" });
  }

  // 行の高さはテスト環境に無いレイアウトの実寸なので、テストが決める（高さ44・間6で、上から50ずつ）。
  function layOutRows() {
    const rows = within(editList() as HTMLElement).getAllByRole("listitem");
    rows.forEach((row, index) =>
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue(new DOMRect(0, index * 50, 300, 44)),
    );
    return rows;
  }

  function drag(title: string, dy: number) {
    const rows = layOutRows();
    const handle = button(`${title}を動かす`);
    const y = rows.findIndex((row) => row.contains(handle)) * 50 + 22;
    fireEvent.pointerDown(handle, { pointerId: 1, isPrimary: true, clientY: y });
    fireEvent.pointerMove(handle, { pointerId: 1, isPrimary: true, clientY: y + dy });
    fireEvent.pointerUp(handle, { pointerId: 1, isPrimary: true, clientY: y + dy });
  }

  it.each([
    [false, 0, null, true],
    [false, 1, null, false],
    [false, 0, DESTINATION, false],
    [true, 0, DESTINATION, true],
  ])(
    "周回か（%s）・経由地が%i件・目的地が%oなら、編集を押せない（%s）",
    (loop, waypointCount, destination, disabled) => {
      renderForm({ loop, waypoints: waypointsOf(waypointCount), destination });

      expect(button("編集")).toHaveProperty("disabled", disabled);
    },
  );

  it.each([
    {
      label: "目的地を置いていなければ、空の目的地の行を出す",
      loop: false,
      destination: null,
      names: ["出発地: 現在地（王子）", "経由地1: 浅草", "経由地2: 上野", "目的地: 未設定"],
    },
    {
      label: "周回の間は、目的地の行を出さない",
      loop: true,
      destination: DESTINATION,
      names: ["出発地: 現在地（王子）", "経由地1: 浅草", "経由地2: 上野"],
    },
  ])(
    "編集を押すと、詳しくの代わりに地点を通る順に名前の行で並べ、地図で置いた地点は辺りで呼ぶ: $label",
    async ({ loop, destination, names }) => {
      renderForm({ loop, destination, waypoints: waypointsOf(2) });
      expect(editList()).toBeNull();

      await openEdit();

      expect(rowNames()).toEqual(names);
      expect(button("編集")).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByRole("region", { name: "出発地" })).toBeNull();
    },
  );

  it.each([
    {
      label: "経由地を先頭へ動かす",
      originLocated: true,
      destination: null,
      title: "経由地2",
      dy: -120,
      to: 0,
      text: "「上野」を経由地2から出発地へ動かしました。前の出発地・経由地1は経由地1・経由地2になりました。",
    },
    {
      label: "目的地を間へ動かす",
      originLocated: true,
      destination: DESTINATION,
      title: "目的地",
      dy: -120,
      to: 1,
      text: "「品川」を目的地から経由地1へ動かしました。前の経由地1・経由地2は経由地2・目的地になりました。",
    },
    {
      label: "経由地を空の目的地の席へ動かす",
      originLocated: true,
      destination: null,
      title: "経由地1",
      dy: 120,
      to: 3,
      text: "「浅草」を経由地1から目的地へ動かしました。前の経由地2は経由地1になりました。",
    },
    {
      label: "仮の出発地の前へは入れない",
      originLocated: false,
      destination: null,
      title: "経由地2",
      dy: -120,
      to: 1,
      text: "「上野」を経由地2から経由地1へ動かしました。前の経由地1は経由地2になりました。",
    },
  ])(
    "行の掴む所を押さえたまま上下へ動かして離すと、その順へ動かすことを上げ、何がどこへ動いたかを書く: $label",
    async ({ originLocated, destination, title, dy, to, text }) => {
      const { reorderPoints } = renderForm({ originLocated, destination, waypoints: waypointsOf(2) });
      await userEvent.click(button("編集"));
      await within(editList() as HTMLElement).findByRole("listitem", { name: "経由地2: 上野" });
      const from = rowNames().findIndex((name) => name?.startsWith(`${title}:`));

      drag(title, dy);

      expect(reorderPoints).toHaveBeenCalledExactlyOnceWith(from, to, ORIGIN);
      expect(note()).toBe(text);
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
  ])("動かせない行の掴む所は押せない: $label", async ({ loop, originLocated, waypointCount, title }) => {
    renderForm({ loop, originLocated, waypoints: waypointsOf(waypointCount) });

    await userEvent.click(button("編集"));

    expect(button(`${title}を動かす`)).toBeDisabled();
  });

  it("編集を開くと、動かせる行の掴む所だけを上下へ揺らして動かせることを見せる", async () => {
    renderForm({ waypoints: waypointsOf(2) });
    const animate = vi.spyOn(Element.prototype, "animate");

    await openEdit();

    // 置いていない目的地の行は動かせないので揺らさない。
    expect(animate.mock.contexts).toEqual([
      button("出発地を動かす"),
      button("経由地1を動かす"),
      button("経由地2を動かす"),
    ]);
  });

  it("掴む所で上下の矢印のキーを押すと、1つずつ動かし、入れ替わった行を前の位置から滑らせる", async () => {
    const { reorderPoints } = renderForm({ destination: DESTINATION, waypoints: waypointsOf(2) });
    await openEdit();
    const animate = vi.spyOn(Element.prototype, "animate");
    // 地点を上げる先は差し替えなので、並びは描き変わらない。行の枠は動く前と同じで、入れ替わった2行が互いの位置から滑る。
    const rows = layOutRows();

    button("経由地1を動かす").focus();
    await userEvent.keyboard("{ArrowDown}");

    expect(reorderPoints).toHaveBeenCalledExactlyOnceWith(1, 2, ORIGIN);
    expect(animate.mock.contexts).toEqual([rows[1], rows[2]]);
    expect(animate.mock.calls.map(([frames]) => (frames as Keyframe[])[0].translate)).toEqual(["0 50px", "0 -50px"]);
  });

  it.each([
    {
      title: "経由地1",
      raised: "removeWaypoint",
      args: [0],
      text: "経由地1「浅草」を消しました。後ろの経由地の番号を1つ詰めました。",
    },
    { title: "目的地", raised: "clearDestination", args: [], text: "目的地「品川」を消しました。" },
  ] as const)("行の消すボタンで、その地点を消して書く: $title", async ({ title, raised, args, text }) => {
    const handlers = renderForm({ destination: DESTINATION, waypoints: waypointsOf(2) });
    await openEdit();

    await userEvent.click(button(`${title}を消す`));

    expect(handlers[raised]).toHaveBeenCalledExactlyOnceWith(...args);
    expect(note()).toBe(text);
  });

  it("出発地の行は消せない（消すボタンを出さない）", async () => {
    renderForm({ waypoints: waypointsOf(1) });
    await openEdit();

    expect(screen.queryByRole("button", { name: "出発地を消す" })).toBeNull();
  });

  it("並びの札を押すと、編集を閉じてその地点の詳しくを出す", async () => {
    renderForm({ waypoints: waypointsOf(2) });
    await openEdit();

    await userEvent.click(button("経由地2: 地図で選んだ地点"));

    expect(editList()).toBeNull();
    expect(detail("経由地2")).toBeInTheDocument();
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
