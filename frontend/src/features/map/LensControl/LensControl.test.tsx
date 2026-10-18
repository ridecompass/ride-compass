/**
 * `LensControl.tsx`——「評価で塗る」のピルが今の評価軸を示し、開いた一覧で評価軸を1つ選び・外し、選んでいる行の ▶ で
 * 凡例を絞り込み、行の印（走る条件・未使用・絞り込み中）と前提の文を読ませること。
 *
 * ここで見ないもの:
 * - 選択肢・凡例・前提の文の中身を軸カタログから組むこと → `features/map/view/lens.test.ts`
 * - 凡例の行のチェックの描き方 → `LegendCheckboxList`
 * - 浮かせた一覧の位置取り・外を押すと閉じること → Radix Popover
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LAYER_DATA_STATUS_LABELS } from "@/features/map/layers/mapLayers";
import { DIFFICULTY_LENS_LABEL, LENS_DIFFICULTY_ID } from "@/lib/mapDisplay/routeStyleModes";

import LensControl, { type LensOption } from "./LensControl";

const option = (id: string, overrides: Partial<LensOption> = {}): LensOption => ({
  id,
  label: `${id}の軸`,
  color: "#123456",
  unused: false,
  description: `${id}の説明`,
  conditions: [],
  ...overrides,
});
const OPTIONS = [option("idle", { unused: true }), option("used", { conditions: ["bearing_deg", "at"] })];
const LEGEND = [
  { key: "step-0", label: "低い", color: "#00ff00", filter: [] },
  { key: "step-1", label: "高い", color: "#ff0000", filter: [] },
];

function renderLens(props: Partial<Parameters<typeof LensControl>[0]> = {}) {
  const handlers = {
    onLensChange: vi.fn(),
    onToggleLegendKey: vi.fn(),
    onSetHiddenLegendKeys: vi.fn(),
    onKeepAfterRouteChange: vi.fn(),
  };
  render(
    <LensControl
      lens="used"
      axisOptions={OPTIONS}
      legend={LEGEND}
      hiddenLegendKeys={[]}
      keepAfterRoute
      hasDetail={false}
      routeHidden={false}
      premises={[]}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}
const pill = () => screen.getByRole("button", { name: /^評価で塗る:/ });
const open = () => userEvent.click(pill());
const list = () => screen.getByRole("radiogroup", { name: "評価で塗る" });

describe("LensControl", () => {
  it.each([
    ["used", false, "usedの軸"],
    [LENS_DIFFICULTY_ID, false, "評価軸を選ぶ"],
    [LENS_DIFFICULTY_ID, true, DIFFICULTY_LENS_LABEL],
  ])(
    "ピルは選んでいる評価軸（%s・ルートの確定後 %s）の名前を出し、選んでいなければ塗り方を出す",
    (lens, hasDetail, label) => {
      renderLens({ lens, hasDetail });
      expect(pill()).toHaveAccessibleName(`評価で塗る: ${label}（タップで変更）`);
    },
  );

  it("取得状態は、ピルのtitleと、開いた先の文で伝える", async () => {
    renderLens({ dataStatus: "error" });
    expect(pill()).toHaveAttribute("title", LAYER_DATA_STATUS_LABELS.error);
    await open();
    expect(screen.getByRole("status")).toHaveTextContent(LAYER_DATA_STATUS_LABELS.error);
  });

  it("一覧は重みのある軸を先に並べ、値が変わる走る条件と「未使用」を名前に添える", async () => {
    renderLens();
    await open();
    expect(
      within(list())
        .getAllByRole("radio")
        .map((row) => row.textContent),
    ).toEqual(["usedの軸（地図の向きで変わる）（出発時刻で変わる）", "idleの軸未使用"]);
  });

  it("行を押すとその評価軸を選び、一覧は閉じない。選んでいる行をもう一度押すと外す", async () => {
    const { onLensChange } = renderLens();
    await open();
    await userEvent.click(within(list()).getByRole("radio", { name: /^idleの軸/ }));
    expect(onLensChange).toHaveBeenLastCalledWith("idle");
    expect(list()).toBeInTheDocument();

    await userEvent.click(within(list()).getByRole("radio", { name: /^usedの軸/ }));
    expect(onLensChange).toHaveBeenLastCalledWith(LENS_DIFFICULTY_ID);
  });

  it.each([
    ["used", false],
    [LENS_DIFFICULTY_ID, true],
  ])("「選択を外す」は文字の無いアイコンで、評価軸を選んでいる（%s）間だけ押せる", async (lens, disabled) => {
    const { onLensChange } = renderLens({ lens });
    await open();
    const clear = screen.getByRole("button", { name: "選択を外す" });
    expect(clear).toHaveTextContent(/^$/);
    if (disabled) {
      expect(clear).toBeDisabled();
      return;
    }
    await userEvent.click(clear);
    expect(onLensChange).toHaveBeenCalledWith(LENS_DIFFICULTY_ID);
  });

  it("(i) で軸の説明を行の下に開く", async () => {
    renderLens();
    await open();
    await userEvent.click(screen.getByRole("button", { name: "idleの軸の説明を表示" }));
    expect(screen.getByText("idleの説明")).toBeInTheDocument();
  });

  it("選んでいる行にだけ ▶ を出し、開くと凡例と前提の文を出す", async () => {
    renderLens({ premises: ["前提の文"] });
    await open();
    expect(screen.queryByRole("button", { name: "idleの軸の凡例" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "usedの軸の凡例" }));
    const panel = screen.getByRole("region", { name: "usedの軸の内訳" });
    expect(within(panel).getByText("低い")).toBeInTheDocument();
    expect(within(panel).getByText("前提の文")).toBeInTheDocument();
  });

  it("凡例も前提も無い軸には ▶ を出さない", async () => {
    renderLens({ legend: [] });
    await open();
    expect(screen.queryByRole("button", { name: "usedの軸の凡例" })).not.toBeInTheDocument();
  });

  it.each([
    [[], ["step-0", "step-1"]],
    [["step-0"], []],
  ])(
    "凡例の見出しのチェックは、全部表示中（隠している段: %j）なら全段を隠し、一部でも隠していれば全段を戻す",
    async (hidden, next) => {
      const { onSetHiddenLegendKeys } = renderLens({ hiddenLegendKeys: hidden });
      await open();
      await userEvent.click(screen.getByRole("button", { name: "usedの軸の凡例" }));
      await userEvent.click(screen.getByRole("checkbox", { name: "凡例の全段階をまとめて表示/非表示" }));
      expect(onSetHiddenLegendKeys).toHaveBeenCalledWith(next);
    },
  );

  it.each([
    [[], false],
    [["step-0"], true],
  ])("段を隠している（%j）間だけ、選んでいる行に「絞り込み中」を添え、まとめて戻せる", async (hidden, filtered) => {
    const { onSetHiddenLegendKeys } = renderLens({ hiddenLegendKeys: hidden });
    await open();
    expect(within(list()).queryByText("絞り込み中") !== null).toBe(filtered);
    const clear = screen.getByRole("button", { name: "絞り込みをすべて解除" });
    if (!filtered) {
      expect(clear).toBeDisabled();
      return;
    }
    await userEvent.click(clear);
    expect(onSetHiddenLegendKeys).toHaveBeenCalledWith([]);
  });

  it("ルートの線を出していなければ、塗っていないことを開いた先で伝える", async () => {
    renderLens({ routeHidden: true });
    await open();
    expect(screen.getByRole("status")).toHaveTextContent("ルートの線は塗っていません");
  });

  it("「ルート後も周囲の道路を薄く塗る」を押すと、反転した値で知らせる", async () => {
    const { onKeepAfterRouteChange } = renderLens({ keepAfterRoute: true });
    await open();
    await userEvent.click(screen.getByRole("checkbox", { name: "ルート後も周囲の道路を薄く塗る" }));
    expect(onKeepAfterRouteChange).toHaveBeenCalledWith(false);
  });
});
