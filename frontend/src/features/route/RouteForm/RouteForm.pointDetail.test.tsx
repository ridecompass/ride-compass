/**
 * `RouteForm/PointDetail.tsx`を`RouteForm`の中で使う所——押した地点の詳しくに、どの地点の何を渡すか。`RouteForm`を描いて確かめる。
 *
 * 見るもの: 押した地点の詳しく（呼び名・出どころ・名前・その位置から引いた辺り）、出発地の印の色、地図で置ける間の探すボタンの
 * 文言、消す/現在地に戻す操作。
 *
 * ここで見ないもの: 探すボタンで地図の上端の欄を開き、選んだ候補をその地点として置くこと → `app/page.places.test.tsx`。
 * 探して置いた地点の辺りと代表の位置 → `RouteForm/PointDetail.test.tsx`。
 * 検索で置いた地点が、ピンを動かすまでその候補のままか → `features/route/useGenerationConditions.points.test.ts`。
 * 地点の並びと押した地点の選び → `RouteForm/RouteForm.points.test.tsx`。
 * 受け取った値をそのまま渡すもの（出発地が現在地にある間に戻す操作を押せなくすること、経由地が上限の間に探す欄を押せなくすること）。
 *
 * 差し替えたもの: 検索の口と辺りの口の応答（網の層）。辺りの口は、テストが応答を渡さなければ辺り無しと答える。
 */
import { within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { ORIGIN_MARK_FALLBACK_COLOR, PIN_MARK_COLOR } from "@/components/PinMark/PinMark";
import { onBackend, serveAxisCatalog } from "@/testing/backendServer";
import { catalogResponse } from "@/testing/catalogAxes";
import { DESTINATION, ORIGIN, button, detail, renderForm, searchButton, waypointsOf } from "@/testing/routeForm";
import { FACILITY_CANDIDATE as FACILITY } from "@/testing/routeFixtures";

// 詳しくは置いた地点の辺りを引く。辺りを見ないテストには、辺り無しと答える（見るテストは後から応答を渡す）。
beforeEach(() => {
  onBackend("GET", "/api/place-area", () => Response.json({ area: null }));
  serveAxisCatalog(catalogResponse([]));
});

describe("RouteForm 出発地", () => {
  /** 印（スタートの旗）を描く要素。 */
  function originMark() {
    const mark = detail("出発地").querySelector<HTMLElement>("svg")?.parentElement;
    if (!mark) throw new Error("出発地の印が無い");
    return mark;
  }

  it.each([
    [true, "現在地", PIN_MARK_COLOR.origin],
    [false, "現在地を取得できていません", ORIGIN_MARK_FALLBACK_COLOR],
  ])("現在地を取れたか（%s）で名前を「%s」とし、印の色を変える", (originLocated, name, color) => {
    renderForm({ originLocated });

    expect(detail("出発地")).toHaveTextContent(`出発地${name}`);
    expect(originMark()).toHaveStyle({ color });
  });

  it.each([
    [null, "出発地地図で選んだ地点", "地図で選んだ地点"],
    [FACILITY, `出発地${FACILITY.name}探して選んだ地点`, "探して選んだ地点"],
  ])(
    "置いた出発地は、探して置いたときの位置のままなら名前、ほかは「地図で選んだ地点」と出し、現在地に戻す操作を出す",
    async (originFound, text, once) => {
      const { onOriginReset } = renderForm({ originManual: true, originAtHere: false, originFound });

      expect(detail("出発地").textContent).toContain(text);
      expect(detail("出発地").textContent?.split(once)).toHaveLength(2);
      await userEvent.click(button("出発地を現在地に戻す"));

      expect(onOriginReset).toHaveBeenCalledOnce();
    },
  );
});

describe("RouteForm 地点の詳しく", () => {
  it.each([
    [true, "地図をタップか、住所・施設で探す"],
    [false, "住所・施設で置き直す"],
  ])("地図で置ける間か（%s）で、選んでいる地点の探すボタンに「%s」と出す", (placing, text) => {
    renderForm({ placing });

    expect(searchButton("出発地")).toHaveTextContent(text);
  });

  it.each([
    [3, "地図をタップ[3地点]か、住所・施設で探す"],
    [0, "地図をタップか、住所・施設で探す"],
  ])(
    "置いた経由地が%i件のとき、新しい経由地を選んでいれば探すボタンに件数があれば添えて「地図をタップ」を出す",
    (count, hint) => {
      renderForm({ waypoints: waypointsOf(count), selectedPoint: { role: "waypoint", index: null }, placing: true });

      expect(searchButton("新しい経由地")).toHaveTextContent(hint);
    },
  );

  it.each([
    ["出発地: 現在地", "出発地", ORIGIN],
    ["経由地2: 地図で選んだ地点", "経由地2", waypointsOf(2)[1]],
    ["目的地: 地図で選んだ地点", "目的地", DESTINATION],
  ])("押した地点（%s）の詳しくに、その位置から引いた辺りを出す", async (chip, title, point) => {
    onBackend("GET", "/api/place-area", ({ query }) =>
      Response.json({ area: query.latitude === String(point.latitude) ? "押した地点の辺り" : "ほかの地点の辺り" }),
    );
    renderForm({ waypoints: waypointsOf(2), destination: DESTINATION });

    await userEvent.click(button(chip));

    expect(await within(detail(title)).findByText("押した地点の辺り")).toBeInTheDocument();
  });

  it("現在地を取れていない出発地は、仮の位置の辺りを引かない", async () => {
    const sent = onBackend("GET", "/api/place-area", () => Response.json({ area: "仮の位置の辺り" }));
    renderForm({ originLocated: false });

    // 引くなら詳しくを描いた直後に送る。少し待っても送っていない。
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent).toEqual([]);
  });
});

describe("RouteForm 経由地", () => {
  it("置いた経由地は、消す操作でその経由地を消す", async () => {
    const { removeWaypoint } = renderForm({ waypoints: waypointsOf(3) });

    await userEvent.click(button("経由地2: 地図で選んだ地点"));
    await userEvent.click(button("経由地2を消す"));

    expect(removeWaypoint).toHaveBeenCalledExactlyOnceWith(1);
  });
});

describe("RouteForm 目的地", () => {
  it("目的地が無い間は「未設定」と出して消す操作を押せなくしておく", async () => {
    renderForm({ distanceTargeted: false, destination: null });
    await userEvent.click(button("目的地: 未設定"));

    expect(detail("目的地")).toHaveTextContent("目的地未設定");
    expect(button("目的地を消す")).toBeDisabled();
  });

  it.each([
    [null, "目的地地図で選んだ地点", "地図で選んだ地点"],
    [FACILITY, `目的地${FACILITY.name}探して選んだ地点`, "探して選んだ地点"],
  ])(
    "置いた目的地は、探して置いたときの位置のままなら名前、ほかは「地図で選んだ地点」と出し、消す操作を押すと上げる",
    async (found, text, once) => {
      const { clearDestination } = renderForm({
        destination: DESTINATION,
        foundAt: (at) => (at === DESTINATION ? found : null),
      });
      await userEvent.click(button(`目的地: ${found?.name ?? "地図で選んだ地点"}`));

      expect(detail("目的地").textContent).toContain(text);
      expect(detail("目的地").textContent?.split(once)).toHaveLength(2);

      await userEvent.click(button("目的地を消す"));

      expect(clearDestination).toHaveBeenCalledOnce();
    },
  );
});
