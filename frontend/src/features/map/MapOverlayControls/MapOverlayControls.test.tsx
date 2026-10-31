/**
 * `MapOverlayControls.tsx`——「表示」のボタンが開く一覧が、先頭のルートの行で選んだ候補の線を出し入れし、行のチェックでON/OFFし、
 * ⓘ・▶を行のすぐ下に開いて説明・内訳・案内・取得状態を読ませ、内訳から凡例を絞り込めること。末尾のまとめての操作が、押せるときだけ押せること。
 *
 * ここで見ないもの:
 * - 浮かせた一覧の位置取り・画面端での縮み・外を押すと閉じること → Radix Popover
 * - チェックボックスの一覧の描き方 → `LegendCheckboxList`
 * - 保存の読み書きの失敗の扱い → `useStoredState`
 * - 群への束ね方・群のたたみ・一覧に並べる項目の選び方 → `MapOverlayControls.groups.test.tsx`
 */
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FACT_DISPLAY_NAME } from "@/lib/screenNames";
import { chip, LIST_NAME, propsOf, ROUTE_ROW, setup } from "@/testing/mapOverlayControls";
import MapOverlayControls from "./MapOverlayControls";
import type { LegendFilterSummaryAxis } from "./LegendDetails";
import type { OverlayLayerChip } from "./OverlayLayerRow";
import { LAYER_DATA_STATUS_LABELS } from "@/features/map/layers/mapLayers";

function legend(axisId: string | undefined, keys: string[], hiddenKeys: string[] = []): LegendFilterSummaryAxis {
  return {
    label: `軸${axisId ?? ""}`,
    axisId,
    hiddenKeys,
    legend: keys.map((key) => ({ key, label: `項目${key}`, color: `#${key}${key}${key}` })),
  };
}

/** 行のtitle（行の名前のチェックボックスを包むラベルが持つ）。 */
const rowTitle = (name: string) => screen.getByRole("checkbox", { name }).closest("label")?.getAttribute("title");

afterEach(() => {
  window.localStorage.clear();
});

describe("一覧の行", () => {
  it("ONをチェックで表し、押すとレイヤーidと反転した値で知らせる", async () => {
    const { user, props } = await setup([chip("shown", { on: true }), chip("other")]);

    expect(screen.getByRole("checkbox", { name: "shown" })).toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "shown" }));
    await user.click(screen.getByRole("checkbox", { name: "other" }));
    expect(props.onToggle.mock.calls).toEqual([
      ["shown", false],
      ["other", true],
    ]);
  });

  it("▶は、凡例があればOFFでも出し（ONにすると何が出るかを先に確かめられる）、中身が無ければ出さない。押すと内訳を一覧の中の行の下に開き、もう一度押すと閉じる", async () => {
    const { user, list } = await setup([
      chip("member", { legendDetails: [legend("a", ["1"])] }),
      chip("empty", { on: true }),
    ]);
    expect(screen.queryByRole("button", { name: "emptyの凡例" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "memberの凡例" }));
    expect(within(list).getByRole("region", { name: "memberの内訳" })).toHaveTextContent("項目1");
    await user.click(screen.getByRole("button", { name: "memberの凡例" }));
    expect(screen.queryByRole("region", { name: "memberの内訳" })).not.toBeInTheDocument();
  });

  it("説明のある行にだけⓘを出し、押すと説明を一覧の中の行の下に開く", async () => {
    const { user, list } = await setup([chip("with_hint", { panelHint: "説明文" }), chip("plain")]);
    expect(within(list).queryByRole("button", { name: /plainの説明/ })).not.toBeInTheDocument();
    await user.click(within(list).getByRole("button", { name: "with_hintの説明を表示" }));
    expect(within(list).getByText("説明文")).toBeInTheDocument();
  });
});

describe("▶の内訳", () => {
  async function openDetails(layer: OverlayLayerChip) {
    const view = await setup([layer]);
    await view.user.click(screen.getByRole("button", { name: `${layer.label}の凡例` }));
    return { ...view, panel: screen.getByRole("region", { name: `${layer.label}の内訳` }) };
  }

  it("絞り込める軸は、軸の名前の見出しを持ち、1行ずつと見出しでまとめて切り替えられる", async () => {
    const { user, props, panel } = await openDetails(
      chip("layer", { on: true, legendDetails: [legend("a", ["1", "2"])] }),
    );
    expect(within(panel).getByText("軸a")).toBeInTheDocument();
    await user.click(within(panel).getByRole("checkbox", { name: /項目1/ }));
    await user.click(within(panel).getByRole("checkbox", { name: "軸aをまとめて表示/非表示" }));

    expect(props.onLegendEntryToggle).toHaveBeenCalledWith("a", "1");
    expect(props.onLegendAxisSetHidden).toHaveBeenCalledWith("a", ["1", "2"]);
  });

  it("絞り込めない軸（axisIdが無い）はチェックボックスを出さず、非表示の行に印を付ける", async () => {
    const { panel } = await openDetails(
      chip("layer", { on: true, legendDetails: [legend(undefined, ["1", "2"], ["2"])] }),
    );
    expect(within(panel).queryByRole("checkbox")).not.toBeInTheDocument();
    const [shown, hidden] = within(panel).getAllByRole("listitem");
    expect(shown).not.toHaveTextContent("非表示");
    expect(hidden).toHaveTextContent("非表示");
  });

  it("案内文があれば、凡例の有無にかかわらず凡例の代わりに案内文を出す", async () => {
    const { panel } = await openDetails(
      chip("layer", { on: true, notice: "ズームインすると表示されます", legendDetails: [legend("a", ["1"])] }),
    );
    expect(panel).toHaveTextContent("ズームインすると表示されます");
    expect(within(panel).queryByText("項目1")).not.toBeInTheDocument();
  });

  it("取得状態があれば、凡例の上へ同じ文言を出す（凡例が無くても▶を出す）", async () => {
    const { panel, unmount } = await openDetails(
      chip("layer", { on: true, dataStatus: "error", legendDetails: [legend("a", ["1"])] }),
    );
    expect(within(panel).getByRole("status")).toHaveTextContent(LAYER_DATA_STATUS_LABELS.error);
    expect(within(panel).getByText("項目1")).toBeInTheDocument();
    unmount();

    await setup([chip("status_only", { on: true, dataStatus: "empty" })]);
    expect(screen.getByRole("button", { name: "status_onlyの凡例" })).toBeInTheDocument();
  });
});

describe("行の印", () => {
  it("取得状態は、ONの間だけtitleへ添える（OFF・状態なしは添えない）", async () => {
    await setup([
      chip("loading", { on: true, dataStatus: "loading", title: "説明" }),
      chip("off", { dataStatus: "error", title: "説明" }),
      chip("normal", { on: true, title: "説明" }),
    ]);
    expect(rowTitle("loading")).toBe(`説明[${LAYER_DATA_STATUS_LABELS.loading}]`);
    expect(rowTitle("off")).toBe("説明");
    expect(rowTitle("normal")).toBe("説明");
  });

  it("凡例の一部を隠しているONの行だけ、titleに「絞り込み中」を添える", async () => {
    await setup([
      chip("filtered", { on: true, legendDetails: [legend("a", ["1"], ["1"])] }),
      chip("filtered_but_off", { legendDetails: [legend("a", ["1"], ["1"])] }),
      chip("unfiltered", { on: true, legendDetails: [legend("a", ["1"])] }),
    ]);
    expect(rowTitle("filtered")).toBe("絞り込み中");
    expect(rowTitle("filtered_but_off")).toBeNull();
    expect(rowTitle("unfiltered")).toBeNull();
  });

  it("「表示」のボタンは、地図に出している件数と、どれかの行が凡例を絞り込んでいれば「絞り込み中」を説明に添える", () => {
    const { rerender } = render(<MapOverlayControls {...propsOf([chip("on", { on: true }), chip("off")])} />);
    expect(screen.getByRole("button", { name: LIST_NAME })).toHaveAccessibleDescription(
      `${FACT_DISPLAY_NAME}（${LIST_NAME}）[1件を表示中]`,
    );

    rerender(
      <MapOverlayControls {...propsOf([chip("filtered", { on: true, legendDetails: [legend("a", ["1"], ["1"])] })])} />,
    );
    expect(screen.getByRole("button", { name: LIST_NAME })).toHaveAccessibleDescription(
      `${FACT_DISPLAY_NAME}（${LIST_NAME}）[1件を表示中]・絞り込み中`,
    );
  });
});

describe("ルートの行", () => {
  it("候補を選んでいれば、出し入れを反転した値で知らせる", async () => {
    const { user, props, list } = await setup([], { route: { shown: true, selectable: true } });
    const route = within(list).getByRole("checkbox", { name: ROUTE_ROW });
    expect(route).toBeChecked();
    await user.click(route);
    expect(props.route.onChange).toHaveBeenCalledWith(false);
  });

  it("候補を選ぶまでは押せず、ONに見えない", async () => {
    const { list } = await setup([], { route: { shown: true, selectable: false } });
    const route = within(list).getByRole("checkbox", { name: ROUTE_ROW });
    expect(route).toBeDisabled();
    expect(route).not.toBeChecked();
  });
});

describe("まとめての操作", () => {
  it("「表示中のレイヤーをすべて非表示」は出している行があるときだけ、「絞り込みをすべて解除」は凡例で隠している間だけ押せる。どちらも文字の無いアイコン", async () => {
    const shown = await setup([chip("on", { on: true })], { anyLegendHidden: false });
    for (const name of ["表示中のレイヤーをすべて非表示", "絞り込みをすべて解除"]) {
      expect(screen.getByRole("button", { name })).toHaveTextContent(/^$/);
    }
    expect(screen.getByRole("button", { name: "絞り込みをすべて解除" })).toBeDisabled();
    await shown.user.click(screen.getByRole("button", { name: "表示中のレイヤーをすべて非表示" }));
    expect(shown.props.onHideAllLayers).toHaveBeenCalledOnce();
    shown.unmount();

    const filtered = await setup([chip("off")], { anyLegendHidden: true });
    expect(screen.getByRole("button", { name: "表示中のレイヤーをすべて非表示" })).toBeDisabled();
    await filtered.user.click(screen.getByRole("button", { name: "絞り込みをすべて解除" }));
    expect(filtered.props.onShowAllLegendRows).toHaveBeenCalledOnce();
  });
});
