/**
 * `LensControl.tsx`——「負担で塗る」のピルが今のレンズと色の帯の向きを示し、開いた一覧でレンズを1つ選び・外し、選んでいる行の ▶ で
 * 帯の右に一番濃い段の名前を出し、行の印（走る条件）を読ませ、一覧の頭で行の印の意味と但し書きを読ませること。
 *
 * ここで見ないもの:
 * - 選択肢・凡例の中身を費用の軸の一覧から組むこと → `features/map/view/lens.test.ts`
 * - 浮かせた一覧の位置取り・外を押すと閉じること → Radix Popover
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LAYER_DATA_STATUS_LABELS } from "@/features/map/layers/mapLayers";
import { UNSELECTED_LENS_ID } from "@/lib/mapDisplay/routeStyleModes";

import LensControl from "./LensControl";
import type { LensOption } from "./LensRow";

const option = (id: string, overrides: Partial<LensOption> = {}): LensOption => ({
  id,
  label: `${id}の軸`,
  color: "#123456",
  description: `${id}の説明`,
  conditions: [],
  ...overrides,
});
const OPTIONS = [option("idle"), option("used", { conditions: ["bearing_deg", "at"] })];
const LEGEND = [
  { key: "step-0", label: "低い", color: "#00ff00", filter: [] },
  { key: "step-1", label: "高い", color: "#ff0000", filter: [] },
];

function renderLens(props: Partial<Parameters<typeof LensControl>[0]> = {}) {
  const handlers = { onLensChange: vi.fn() };
  render(
    <LensControl
      lens="used"
      axisOptions={OPTIONS}
      totalLabel="総合"
      legend={LEGEND}
      hasDetail={false}
      caveat={null}
      catalogNotice={null}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}
const pill = () => screen.getByRole("button", { name: /^負担で塗る:/ });
const open = () => userEvent.click(pill());
const list = () => screen.getByRole("radiogroup", { name: "負担で塗る" });

describe("LensControl", () => {
  it.each([
    ["used", false, "usedの軸"],
    [UNSELECTED_LENS_ID, false, "負担を色で見る"],
    [UNSELECTED_LENS_ID, true, "総合"],
  ])(
    "ピルは選んでいるレンズ（%s・ルートの確定後 %s）の名前を出し、選んでいなければ塗り方を出す",
    (lens, hasDetail, label) => {
      renderLens({ lens, hasDetail });
      expect(pill()).toHaveAccessibleName(`負担で塗る: ${label}（タップで変更）`);
    },
  );

  it.each([
    [LEGEND, "高い"],
    [[], ""],
  ])("ピルの色の帯は、段がある間だけ右に一番濃い段の名前を添える（段 %j）", (legend, ends) => {
    renderLens({ legend });
    expect(pill().textContent).toContain(`usedの軸${ends}▾`);
  });

  it("取得状態は、ピルのtitleと、開いた先の文で伝える", async () => {
    renderLens({ dataStatus: "error" });
    expect(pill()).toHaveAttribute("title", LAYER_DATA_STATUS_LABELS.error);
    await open();
    expect(screen.getByRole("status")).toHaveTextContent(LAYER_DATA_STATUS_LABELS.error);
  });

  it("一覧は、値が変わる走る条件を名前に添える", async () => {
    renderLens();
    await open();
    expect(
      within(list())
        .getAllByRole("radio")
        .map((row) => row.textContent),
    ).toEqual(["idleの軸", "usedの軸（地図の向きで変わる）（出発時刻で変わる）"]);
  });

  it("一覧の頭に、どれかの行に出る走る条件の印の意味を文字で並べる", async () => {
    renderLens();
    await open();
    expect(screen.getByText("出発時刻で変わる").closest("p")).toHaveTextContent(/^地図の向きで変わる出発時刻で変わる$/);
  });

  it("行を押すとそのレンズを選び、一覧は閉じない。選んでいる行をもう一度押すと外す", async () => {
    const { onLensChange } = renderLens();
    await open();
    await userEvent.click(within(list()).getByRole("radio", { name: /^idleの軸/ }));
    expect(onLensChange).toHaveBeenLastCalledWith("idle");
    expect(list()).toBeInTheDocument();

    await userEvent.click(within(list()).getByRole("radio", { name: /^usedの軸/ }));
    expect(onLensChange).toHaveBeenLastCalledWith(UNSELECTED_LENS_ID);
  });

  it.each([
    ["used", false],
    [UNSELECTED_LENS_ID, true],
  ])("「選択を外す」は文字の無いアイコンで、レンズを選んでいる（%s）間だけ押せる", async (lens, disabled) => {
    const { onLensChange } = renderLens({ lens });
    await open();
    const clear = screen.getByRole("button", { name: "選択を外す" });
    expect(clear).toHaveTextContent(/^$/);
    if (disabled) {
      expect(clear).toBeDisabled();
      return;
    }
    await userEvent.click(clear);
    expect(onLensChange).toHaveBeenCalledWith(UNSELECTED_LENS_ID);
  });

  it("(i) で軸の説明を行の下に開く", async () => {
    renderLens();
    await open();
    await userEvent.click(screen.getByRole("button", { name: "idleの軸の説明を表示" }));
    expect(screen.getByText("idleの説明")).toBeInTheDocument();
  });

  it("塗りの値の但し書きは、一覧の頭に出す", async () => {
    renderLens({ caveat: "但し書きの文" });
    await open();
    expect(screen.getByText("但し書きの文")).toBeInTheDocument();
  });
});
