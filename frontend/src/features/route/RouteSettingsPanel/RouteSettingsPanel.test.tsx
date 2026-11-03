/**
 * `RouteSettingsPanel/RouteSettingsPanel.tsx`——「負担」タブ。費用の軸ごとの倍率を段で選ぶ。
 *
 * 見るもの: 費用の軸の定義がまだ無い（一覧が404）間は選べないことを案内し、取れなかったとは知らせないこと、一覧を取れないときの
 * 告知と再試行で軸が出ること、書いていない軸は標準を選んだ状態で出し、選んだ段を上げること、「標準に戻す」が標準の間は押せず、
 * 押すと倍率だけを標準に戻すこと。
 *
 * ここで見ないもの: 選んだ倍率が生成の要求に載ること → `app/page.test.tsx`。軸の名前・(i)の奥の説明（一覧の値をそのまま描く）。
 *
 * 差し替えたもの: 費用の軸の一覧の応答（網の層）。つまみと倍率は親が持つので、テストの包みが上がった値を持ち直して渡す。
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { inTurn, onBackend } from "@/testing/backendServer";
import { serveCostAxisCatalog, TWO_COST_AXES } from "@/testing/costAxes";
import type { CostPreference } from "@/types/route";

import RouteSettingsPanel from "./RouteSettingsPanel";

/** 親の代わりに、上がった値を持ち直して渡す包み。 */
function renderPanel(initial: CostPreference = { strength: 1, multipliers: {} }) {
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
  it("定義がまだ無い間は選べないことを案内し、取れなかったとは知らせない", async () => {
    serveCostAxisCatalog(null);
    renderPanel();

    expect(await screen.findByText(/まだ選べません/)).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("取れなければ標準の倍率で作ることを知らせ、再試行で取れたら軸ごとの倍率を出す", async () => {
    onBackend("GET", "/api/cost-axes", inTurn(new Response(null, { status: 503 }), Response.json(TWO_COST_AXES)));
    renderPanel();

    expect(await screen.findByRole("status")).toHaveTextContent("標準の倍率で作ります");

    await userEvent.click(screen.getByRole("button", { name: "再試行" }));

    expect(await screen.findByRole("radiogroup", { name: "振動の倍率" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("倍率", () => {
  it("書いていない軸は標準を選んだ状態で出し、選んだ段を上げる。「標準に戻す」は標準の間は押せず、押すと倍率だけを戻す", async () => {
    serveCostAxisCatalog();
    const { onCostPreferenceChange } = renderPanel({ strength: 1.5, multipliers: { ascent: 1 } });
    const vibration = await levelsOf("振動の倍率");
    expect(vibration.getByRole("radio", { name: "標準" })).toBeChecked();
    expect(screen.getByRole("button", { name: "標準に戻す" })).toBeDisabled();

    await userEvent.click(vibration.getByRole("radio", { name: "無視" }));
    expect(onCostPreferenceChange).toHaveBeenLastCalledWith({
      strength: 1.5,
      multipliers: { ascent: 1, vibration: 0 },
    });

    await userEvent.click(screen.getByRole("button", { name: "標準に戻す" }));
    expect(onCostPreferenceChange).toHaveBeenLastCalledWith({ strength: 1.5, multipliers: {} });
  });
});
