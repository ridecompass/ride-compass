/**
 * `AxisMapDisplaySection.tsx`——「地図表示・公開」の節: 色分けしきい値のまとめ入力（読めたときだけ下書きへ入れ、
 * 読めない間は親の検証へ伝える）・段階プレビュー・体感ラベル・チップの表示要素・公開。
 *
 * 段の配色（`mapBandColors`）は親が渡すものを与える。
 *
 * ここで見ないもの:
 * - まとめ入力の読み方・段数合わせ → `axisDraft.test.ts`
 * - 凡例の段のレンジ表記 → `lib/mapDisplay/mapColorLegend`
 * - 保存前の検証（読めない入力で止めること） → `AxisComposer.test.tsx`
 */
import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AXIS_ICON_PALETTE } from "@/components/ui/icons/axisIconPalette";

import { AxisMapDisplaySection } from "./AxisMapDisplaySection";
import { emptyDraft, type Draft } from "./axisDraft";

const onThresholdErrorChange = vi.fn();

interface HarnessProps {
  initial: Draft;
  restrictedDisplayOnly?: boolean;
  republishing?: boolean;
  mapBandColors?: (boundaries: readonly number[]) => readonly string[];
}

function Harness({ initial, restrictedDisplayOnly = false, republishing = false, mapBandColors }: HarnessProps) {
  const [draft, setDraft] = useState(initial);
  const [thresholdError, setThresholdError] = useState<string | null>(null);
  return (
    <>
      <output data-testid="draft">{JSON.stringify(draft)}</output>
      <AxisMapDisplaySection
        draft={draft}
        setDraft={setDraft}
        restrictedDisplayOnly={restrictedDisplayOnly}
        republishing={republishing}
        mapBandColors={mapBandColors}
        mapValueUnit=""
        thresholdError={thresholdError}
        setThresholdError={(error) => {
          setThresholdError(error);
          onThresholdErrorChange(error);
        }}
      />
    </>
  );
}

function draftWith(overrides: Partial<Draft> = {}): Draft {
  return { ...emptyDraft([]), ...overrides };
}

function renderSection(props: Partial<HarnessProps> = {}) {
  const user = userEvent.setup();
  render(<Harness initial={draftWith()} {...props} />);
  return user;
}

const draft = (): Draft => JSON.parse(screen.getByTestId("draft").textContent!);
const thresholdInput = () => screen.getByRole("textbox", { name: "色分けのしきい値（まとめて入力）" });

async function typeThresholds(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.clear(thresholdInput());
  await user.type(thresholdInput(), text);
}

beforeEach(() => {
  onThresholdErrorChange.mockReset();
});

describe("色分けしきい値", () => {
  it("上書きしていなければ設定の口だけを置き、押すと空の入力欄を出す（下書きは空の上書き）", async () => {
    const user = renderSection();
    expect(screen.queryByRole("textbox", { name: /しきい値/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "+ しきい値を自分で設定する" }));
    expect(thresholdInput()).toHaveValue("");
    expect(draft().displayThresholdsOverride).toEqual([]);
  });

  it("入力欄は、下書きのしきい値をまとめた形で始まる", () => {
    renderSection({ initial: draftWith({ displayThresholdsOverride: [1, 2.5] }) });
    expect(thresholdInput()).toHaveValue("1, 2.5");
  });

  it("読めない入力は下書きへ入れず（直前の並びを残す）、理由を出して親へ伝える。直せば理由は消える", async () => {
    const user = renderSection({ initial: draftWith({ displayThresholdsOverride: [1, 2] }) });
    await user.type(thresholdInput(), ", x");

    expect(draft().displayThresholdsOverride).toEqual([1, 2]);
    const [message] = onThresholdErrorChange.mock.lastCall!;
    expect(message).toEqual(expect.stringContaining("x"));
    expect(screen.getByText(message)).toBeInTheDocument();

    await typeThresholds(user, "1, 2, 4");
    expect(draft().displayThresholdsOverride).toEqual([1, 2, 4]);
    expect(onThresholdErrorChange).toHaveBeenLastCalledWith(null);
    expect(screen.queryByText(message)).not.toBeInTheDocument();
  });

  it("体感ラベルを上書きしているとき、しきい値の数が変わればラベルの数を段の数へ合わせる", async () => {
    const user = renderSection({
      initial: draftWith({ displayThresholdsOverride: [1], displayBandLabelsOverride: ["低", "高"] }),
    });
    await user.type(thresholdInput(), " 2 3");
    expect(draft().displayBandLabelsOverride).toEqual(["低", "高", "", ""]);
  });

  it("「自動計算に戻す」で、しきい値と体感ラベルの上書きを両方外し、誤りも消す", async () => {
    const user = renderSection({
      initial: draftWith({ displayThresholdsOverride: [1], displayBandLabelsOverride: ["低", "高"] }),
    });
    await user.type(thresholdInput(), "x");
    await user.click(screen.getByRole("button", { name: "自動計算に戻す" }));

    expect(draft()).toMatchObject({ displayThresholdsOverride: null, displayBandLabelsOverride: null });
    expect(onThresholdErrorChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole("button", { name: "+ しきい値を自分で設定する" })).toBeInTheDocument();
  });
});

describe("段階プレビュー", () => {
  const preview = () => screen.getByLabelText(/色分けプレビュー/);

  it("しきい値が無ければ出さない", () => {
    renderSection({ initial: draftWith({ displayThresholdsOverride: [] }) });
    expect(screen.queryByLabelText(/色分けプレビュー/)).not.toBeInTheDocument();
  });

  it("段の数は入力した境界で数え、配色もその境界で決める", () => {
    const mapBandColors = vi.fn((boundaries: readonly number[]) =>
      Array.from({ length: boundaries.length + 1 }, (_, i) => `rgb(${i}, 0, 0)`),
    );
    renderSection({
      initial: draftWith({ displayThresholdsOverride: [1, 3] }),
      mapBandColors,
    });

    expect(preview()).toHaveTextContent("3段階になります");
    expect(mapBandColors).toHaveBeenLastCalledWith([1, 3]);
    const swatches = Array.from(preview().querySelectorAll("li > span[aria-hidden]")) as HTMLElement[];
    expect(swatches.map((swatch) => swatch.style.background)).toEqual(["rgb(0, 0, 0)", "rgb(1, 0, 0)", "rgb(2, 0, 0)"]);
    expect(screen.queryByText(/配色はまだ決まっていません/)).not.toBeInTheDocument();
  });

  it("配色が決まっていない軸は、色を付けず、その旨を添える", () => {
    renderSection({ initial: draftWith({ displayThresholdsOverride: [1] }) });
    expect(preview().querySelectorAll("li > span[aria-hidden]")).toHaveLength(0);
    expect(screen.getByText(/配色はまだ決まっていません/)).toBeInTheDocument();
  });

  it("体感ラベルは、各段にその段のラベルを添える", () => {
    renderSection({
      initial: draftWith({ displayThresholdsOverride: [1, 2], displayBandLabelsOverride: ["低", "中", "高"] }),
    });
    const items = within(preview()).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("低"),
      expect.stringContaining("中"),
      expect.stringContaining("高"),
    ]);
  });
});

describe("体感ラベル", () => {
  it("しきい値を上書きしていなければ、体感ラベルの欄自体を出さない", () => {
    renderSection();
    expect(screen.queryByRole("button", { name: "+ 体感ラベルを設定する" })).not.toBeInTheDocument();
  });

  it("設定すると段の数ぶんの空欄を出し、段ごとに打てる。やめると上書きを外す", async () => {
    const user = renderSection({ initial: draftWith({ displayThresholdsOverride: [1, 2] }) });
    await user.click(screen.getByRole("button", { name: "+ 体感ラベルを設定する" }));
    expect(draft().displayBandLabelsOverride).toEqual(["", "", ""]);

    await user.type(screen.getByRole("textbox", { name: "体感ラベル2" }), "中");
    expect(draft().displayBandLabelsOverride).toEqual(["", "中", ""]);

    await user.click(screen.getByRole("button", { name: "体感ラベルの設定をやめる" }));
    expect(draft().displayBandLabelsOverride).toBeNull();
    expect(draft().displayThresholdsOverride).toEqual([1, 2]);
  });
});

describe("アイコン", () => {
  it("選んだアイコンを下書きへ入れる", async () => {
    const iconIds = Object.keys(AXIS_ICON_PALETTE);
    expect(iconIds.length).toBeGreaterThan(0);
    const user = renderSection();

    await user.selectOptions(screen.getByRole("combobox", { name: "アイコン" }), iconIds[0]);

    expect(draft().iconId).toBe(iconIds[0]);
  });

  it("アイコンは未設定（汎用）も選べる", async () => {
    const user = renderSection({ initial: draftWith({ iconId: Object.keys(AXIS_ICON_PALETTE)[0] }) });
    await user.selectOptions(screen.getByRole("combobox", { name: "アイコン" }), "");
    expect(draft().iconId).toBe("");
  });
});

describe("公開", () => {
  it("下書きの軸は、公開するかを切り替えられる", async () => {
    const user = renderSection({ initial: draftWith({ isPublished: false }) });
    await user.click(screen.getByRole("checkbox", { name: "公開する" }));
    expect(draft().isPublished).toBe(true);
  });

  it.each([
    ["公開済みの軸を表示だけ編集している間は、出さない", { restrictedDisplayOnly: true }, false],
    ["「調整する」で下書きへ戻している間は、出さずに、保存すると公開へ戻ると言う", { republishing: true }, true],
  ])("公開の切り替えを、%s", (_case, props, saysRepublish) => {
    renderSection(props);
    expect(screen.queryByRole("checkbox", { name: "公開する" })).not.toBeInTheDocument();
    expect(screen.queryByText(/保存すると公開へ戻ります/) !== null).toBe(saysRepublish);
  });
});
