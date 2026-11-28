/**
 * `RouteSettingsPanel/RouteSettingsPanel.tsx`——「走りにくさ」タブ。一番上の「全体」で走りにくさの全部を数える割合を、その下で費用の軸ごとに
 * 割合の段か無効を選ぶ。
 *
 * 見るもの: 一覧を取れないときの告知と再試行で軸が出ること、全体の行が軸の行より上に割合の段で出て、選ぶと全体の割合を上げること、
 * 書いていない軸は標準を選んだ状態で出し、無効と段を選ぶと、その軸を無効と倍率の片方にだけ置いて上げること、「標準に戻す」が
 * 標準の間は押せず、押すと軸の割合と無効を標準に戻すこと、全体が無効の間は軸の割合が効かないと添えること。選んだ段の丸の色
 * （軸の行は標準より小さい段が通りやすくする向き・大きい段が避ける向きの色、全体の行は小さい段が灰色）。
 *
 * ここで見ないもの: 選んだ割合が生成の要求に載ること → `app/page.test.tsx`。軸の名前・(i)の奥の説明（一覧の値をそのまま描く）。
 * 目盛りの印の形（`RouteSettingsPanel/LevelScale.tsx`が描き、道路タブと同じ）。
 *
 * 差し替えたもの: 費用の軸の一覧の応答（網の層）。つまみと倍率は親が持つので、テストの包みが上がった値を持ち直して渡す。
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { inTurn, onBackend, serveCostAxisCatalog } from "@/testing/backendServer";
import { TWO_COST_AXES } from "@/testing/costAxes";
import type { CostPreference } from "@/types/route";

import RouteSettingsPanel from "./RouteSettingsPanel";
import { STANDARD_COST_PREFERENCE } from "@/lib/costPreference";

/** 親の代わりに、上がった値を持ち直して渡す包み。 */
function renderPanel(initial: CostPreference = STANDARD_COST_PREFERENCE) {
  const onCostPreferenceChange = vi.fn<(next: CostPreference) => void>();
  function Parent() {
    const [preference, setPreference] = useState(initial);
    return (
      <RouteSettingsPanel
        costPreference={preference}
        onCostPreferenceChange={(next) => {
          onCostPreferenceChange(next);
          setPreference(next);
        }}
      />
    );
  }
  render(<Parent />);
  return { onCostPreferenceChange };
}

const levelsOf = async (name: string) => within(await screen.findByRole("radiogroup", { name }));

describe("費用の軸の一覧", () => {
  it("取れなければ倍率を変えられないことを知らせ、再試行で取れたら軸ごとの倍率を出す", async () => {
    onBackend("GET", "/api/cost-axes", inTurn(new Response(null, { status: 503 }), Response.json(TWO_COST_AXES)));
    renderPanel();

    expect(await screen.findByRole("status")).toHaveTextContent("走りにくさの種類ごとの割合を変えられません");

    await userEvent.click(screen.getByRole("button", { name: "再試行" }));

    expect(await screen.findByRole("radiogroup", { name: "振動の割合" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("倍率", () => {
  it("書いていない軸は標準を選んだ状態で出し、無効と段を選ぶとその軸を片方にだけ置いて上げる。「標準に戻す」は標準の間は押せず、押すと倍率と無効を戻す", async () => {
    serveCostAxisCatalog();
    const { onCostPreferenceChange } = renderPanel({
      ...STANDARD_COST_PREFERENCE,
      strength: 1.5,
      multipliers: { ascent: 1 },
    });
    const vibration = await levelsOf("振動の割合");
    expect(vibration.getByRole("radio", { name: "100%" })).toBeChecked();
    expect(screen.getByRole("button", { name: "標準に戻す" })).toBeDisabled();

    await userEvent.click(vibration.getByRole("radio", { name: "無効" }));
    expect(onCostPreferenceChange).toHaveBeenLastCalledWith({
      ...STANDARD_COST_PREFERENCE,
      strength: 1.5,
      multipliers: { ascent: 1 },
      disabled_axes: ["vibration"],
    });
    await userEvent.click(vibration.getByRole("radio", { name: "200%" }));
    expect(onCostPreferenceChange).toHaveBeenLastCalledWith({
      ...STANDARD_COST_PREFERENCE,
      strength: 1.5,
      multipliers: { ascent: 1, vibration: 2 },
    });
    await userEvent.click(vibration.getByRole("radio", { name: "無効" }));

    await userEvent.click(screen.getByRole("button", { name: "標準に戻す" }));
    expect(onCostPreferenceChange).toHaveBeenLastCalledWith({ ...STANDARD_COST_PREFERENCE, strength: 1.5 });
  });

  it("全体が無効の間は、軸の割合が効かないと添える（軸の割合は選べるまま）", async () => {
    serveCostAxisCatalog();
    renderPanel({ ...STANDARD_COST_PREFERENCE, strength: 0 });
    const vibration = await levelsOf("振動の割合");
    expect(screen.getByRole("status")).toHaveTextContent("全体が無効のため、種類ごとの割合は使いません");
    expect(vibration.getByRole("radio", { name: "無効" })).toBeEnabled();
    // どの軸も標準なら、つまみが無効でも戻すものは無い。
    expect(screen.getByRole("button", { name: "標準に戻す" })).toBeDisabled();
  });

  it("全体の行は軸の行より上に割合の段で出て、選ぶと全体の割合を上げる。軸の行も割合の段で出る", async () => {
    serveCostAxisCatalog();
    const { onCostPreferenceChange } = renderPanel();
    const vibration = await levelsOf("振動の割合");
    const overall = await levelsOf("全体の割合");
    const names = (group: typeof overall) =>
      group.getAllByRole("radio").map((radio) => radio.getAttribute("aria-label"));
    expect(names(overall)).toEqual(["無効", "50%", "100%", "150%", "200%"]);
    expect(names(vibration)).toEqual(["無効", "50%", "100%", "200%"]);
    const [overallGroup, firstAxisGroup] = screen.getAllByRole("radiogroup");
    expect(overallGroup).toHaveAccessibleName("全体の割合");
    expect(firstAxisGroup).not.toHaveAccessibleName("全体の割合");

    await userEvent.click(overall.getByRole("radio", { name: "150%" }));
    expect(onCostPreferenceChange).toHaveBeenLastCalledWith({ ...STANDARD_COST_PREFERENCE, strength: 1.5 });
  });
});
