/**
 * `RouteForm/RouteForm.tsx`——「ルート設定」区分の各タブの中身。「条件」タブ（候補数・地点の並びと詳しく・全長の目標）を
 * 描き、「重み」「除外」タブと「保存済み」タブの「プリセット」には受け取った中身を置き、「保存済み」タブの「地点」には保存した地点を並べる。
 *
 * 見るもの: 候補数のステッパー（今の件数・1件ずつの増減・端で押せない）、全長の目標の入り切り（押して上がる値・
 * 外している間はルーラーを動かせない）とルーラーのコマ（5km刻みの範囲・今の値）と動かして上がる値、全長の目標の(i)の奥の
 * 許容差（軸カタログが配る較正値で、引けない間は書かない）、距離・候補数の値と地点の並びの札の名前の文字の大きさのそろい、
 * 経由地が上限のときに保存した地点を経由地に足せないこと、タブを切り替えても各タブの中身を外さないこと。
 *
 * ここで見ないもの: タブの列と選んだタブ、どのタブの中身が見えるか（スタイルで隠す）、呼び出した地点を選んで「条件」タブへ移ること
 * → `app/page.tsx`。
 * 書いた定数や受け取った値をそのまま渡すもの（今の値と km の表記・候補の距離の幅、(i)の奥の文）。
 * 呼び出した地点をどの役割で上げるか・周回の間に目的地にできないこと → `SavedPlacesPanel/SavedPlacesPanel.test.tsx`。
 * 周回の切り替えと地点の並び → `RouteForm/RouteForm.points.test.tsx`。押した地点の詳しく → `RouteForm/RouteForm.pointDetail.test.tsx`。
 * ルーラーのドラッグ・横スクロール・押せない間の止め方 → `components/ui/Ruler/Ruler.test.tsx`。
 *
 * 差し替えたもの: 辺りの口の応答（網の層）。テストが応答を渡さなければ辺り無しと答える。
 */
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { CLIENT_TUNING_IDS } from "@/lib/axisCatalog";
import { onBackend, serveAxisCatalog } from "@/testing/backendServer";
import { catalogResponse } from "@/testing/catalogAxes";
import { DESTINATION, button, renderForm, waypointsOf } from "@/testing/routeForm";
import { FACILITY_CANDIDATE as FACILITY } from "@/testing/routeFixtures";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

// 詳しくは置いた地点の辺りを引く。辺りを見ないテストには、辺り無しと答える（見るテストは後から応答を渡す）。
beforeEach(() => {
  onBackend("GET", "/api/place-area", () => Response.json({ area: null }));
  serveAxisCatalog(catalogResponse([]));
});

/** 全長の目標のルーラー。 */
function distanceRuler() {
  return screen.getByRole("slider", { name: "全長の目標" });
}

describe("RouteForm 候補数", () => {
  it("1件ずつ増減した値を文字列で上げる", async () => {
    const { setMaxRoutesInput } = renderForm({ maxRoutesInput: "8" });

    await userEvent.click(screen.getByRole("button", { name: "候補数を増やす" }));
    await userEvent.click(screen.getByRole("button", { name: "候補数を減らす" }));

    expect(setMaxRoutesInput.mock.calls).toEqual([["9"], ["7"]]);
  });

  it.each([
    ["1", "候補数を減らす"],
    [String(routeGenerateConfig.max_routes), "候補数を増やす"],
  ])("%s件では「%s」を押せない", (maxRoutesInput, name) => {
    renderForm({ maxRoutesInput });

    expect(screen.getByRole("button", { name })).toBeDisabled();
  });
});

describe("RouteForm 全長の目標", () => {
  it.each([
    [true, "全長の目標をやめる", "true", false],
    [false, "全長の目標を決める", "false", true],
  ] as const)(
    "決めているか（%s）で入り切りの操作を「%s」とし、外している間はルーラーを動かせなくして、押すと反対を上げる",
    async (distanceTargeted, name, pressed, raised) => {
      const { setDistanceTargeted } = renderForm({ distanceTargeted });

      expect(button(name)).toHaveAttribute("aria-pressed", pressed);
      expect(distanceRuler()).toHaveAttribute("tabindex", distanceTargeted ? "0" : "-1");
      await userEvent.click(button(name));

      expect(setDistanceTargeted).toHaveBeenCalledExactlyOnceWith(raised);
    },
  );

  it.each([
    [
      { [CLIENT_TUNING_IDS.distanceToleranceRatio]: 0.15 },
      "ルート全体の長さの目標です。作る候補は、この長さの±15%（30kmなら±4.5km）に入るものだけです。",
    ],
    [{}, "ルート全体の長さの目標です。外すと長さを決めず"],
  ])("(i)の奥に、軸カタログが配る許容差（%o）を割合と今の目標での長さで書く", async (clientTuning, text) => {
    serveAxisCatalog(catalogResponse([], { client_tuning: clientTuning }));
    renderForm({ distanceInput: "30" });
    await userEvent.click(button("全長の目標の説明を表示"));

    expect(await screen.findByText(new RegExp(`^${text}`))).toBeInTheDocument();
  });

  it("ルーラーは5kmから上限まで5km刻みのコマを持ち、今の値のコマを選んでいる", () => {
    renderForm({ distanceInput: "30" });

    expect(distanceRuler()).toHaveAttribute("aria-valuetext", "30km");
    expect(distanceRuler()).toHaveAttribute("aria-valuemax", String(routeGenerateConfig.max_distance_km / 5 - 1));
  });

  it("ルーラーを1コマ動かすと、隣の値を文字列のまま上げる", async () => {
    const { setDistanceInput } = renderForm({ distanceInput: "30" });

    act(() => distanceRuler().focus());
    await userEvent.keyboard("{ArrowRight}");

    expect(setDistanceInput).toHaveBeenCalledExactlyOnceWith("35");
  });
});

describe("RouteForm 文字の大きさ", () => {
  /** 要素に効く文字の大きさのトークン（自分か、いちばん近い祖先が書いたもの）。 */
  function fontSizeToken(element: HTMLElement): string | null {
    for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
      const token = /text-\[length:var\((--font-size-[a-z]+)\)\]/.exec(node.className)?.[1];
      if (token !== undefined) return token;
    }
    return null;
  }

  it("全長の目標の値・候補数の値と、地点の並びの札の名前を同じ文字の大きさで出す", () => {
    renderForm({ destination: DESTINATION, maxRoutesInput: "8", distanceInput: "30" });

    const points = within(screen.getByRole("group", { name: "地点の並び" }));
    const tokens = [
      screen.getByText("30km"),
      screen.getByText("8件"),
      points.getByText("現在地"),
      points.getByText("地図で選んだ地点"),
    ].map(fontSizeToken);
    expect(tokens[0]).not.toBeNull();
    expect(new Set(tokens)).toEqual(new Set([tokens[0]]));
  });
});

describe("RouteForm 保存した地点を呼び出す", () => {
  /** 「保存済み」タブの「地点」で、保存した地点の「呼び出す」のメニューを開いて返す。 */
  async function openRecallMenu() {
    await userEvent.click(screen.getByRole("button", { name: `「${FACILITY.name}」を呼び出す` }));
    return screen.getByRole("dialog", { name: `「${FACILITY.name}」をどこに置くか` });
  }
  const savedPlaces = { places: [FACILITY], save: () => {}, remove: () => {} };

  it("経由地を上限まで置いたあとは「経由地に足す」を押せない", async () => {
    renderForm({ savedPlaces, waypoints: waypointsOf(routeGenerateConfig.max_waypoints) }, "saved");

    expect(within(await openRecallMenu()).getByRole("button", { name: "経由地に足す" })).toBeDisabled();
  });
});

describe("RouteForm タブの中身", () => {
  /** 打った文字を自分の中に持つ中身（タブを切り替えて外れると消える）。 */
  function Draft({ name }: { name: string }) {
    const [text, setText] = useState("");
    return <input aria-label={name} value={text} onChange={(e) => setText(e.target.value)} />;
  }

  it("「重み」「除外」と「保存済み」の「プリセット」に受け取った中身を置き、タブを切り替えても外さない", async () => {
    const { showTab } = renderForm(
      {
        weightsPanel: <Draft name="重みの中身" />,
        exclusionsPanel: <Draft name="除外の中身" />,
        savedConditionsPanel: <Draft name="保存の中身" />,
      },
      "weights",
    );
    await userEvent.type(screen.getByRole("textbox", { name: "重みの中身" }), "動かした配分");
    showTab("exclusions");
    await userEvent.type(screen.getByRole("textbox", { name: "除外の中身" }), "外した種類");
    showTab("saved");
    await userEvent.type(screen.getByRole("textbox", { name: "保存の中身" }), "書きかけの名前");

    showTab("generate");
    showTab("weights");

    expect(screen.getByRole("textbox", { name: "重みの中身" })).toHaveValue("動かした配分");
    expect(screen.getByRole("textbox", { name: "除外の中身" })).toHaveValue("外した種類");
    expect(screen.getByRole("textbox", { name: "保存の中身" })).toHaveValue("書きかけの名前");
  });
});
