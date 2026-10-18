/**
 * `RouteSettingsPanel/HardFilterPanel.tsx`——「除外」タブ。地図の道のレイヤの凡例の行ごとの避け方の選びと、自転車が通れない道の
 * 固定の行。
 *
 * 見るもの: 固定の行を「通らない」に鍵を付けて並びの先頭に出し、選ぶ操作を持たないこと。行の避け方をレイヤごとに畳んで並べ、
 * 選ぶとその行だけを変えた値を上げ、既定から変えた行の数を畳んだ見出しに出すこと。見出しの行と全部を既定へ戻す操作を持たないこと。
 *
 * ここで見ないもの: 保存値を今の行へ揃えること → `features/route/useGenerationConditions.test.ts`・
 * `features/route/savedConditions.test.ts`（このパネルは全行の揃った値を受け取る）。生成の要求へ載せること →
 * `features/route/useRouteGeneration.test.ts`。(i)の奥の文（書いた文・生成物の説明を写すだけ）。
 *
 * 行・段・名前・既定は生成物（`route-generate-config.json`）から読み、テストに書き写さない。
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AVOIDABLE_ROWS, AVOIDANCE_LEVELS, DEFAULT_ROAD_AVOIDANCE } from "@/features/route/roadAvoidance";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";
import type { RoadAvoidanceOverride } from "@/types/route";

import HardFilterPanel from "./HardFilterPanel";

const [ROW] = AVOIDABLE_ROWS;
// 行の今の段と違う段（選び直す先）。
const OTHER_LEVEL = AVOIDANCE_LEVELS.find(({ key }) => key !== DEFAULT_ROAD_AVOIDANCE[ROW.key])!;
const EXCLUDE = AVOIDANCE_LEVELS.find(({ key }) => key === "exclude")!;

function renderPanel(roadAvoidance: RoadAvoidanceOverride = DEFAULT_ROAD_AVOIDANCE) {
  const onRoadAvoidanceChange = vi.fn();
  render(<HardFilterPanel roadAvoidance={roadAvoidance} onRoadAvoidanceChange={onRoadAvoidanceChange} />);
  return { onRoadAvoidanceChange };
}

/** 最初の行だけを既定から変えた避け方。 */
const AVOIDANCE_CUSTOMIZED: RoadAvoidanceOverride = { ...DEFAULT_ROAD_AVOIDANCE, [ROW.key]: OTHER_LEVEL.key };

const layerTrigger = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });

describe("HardFilterPanel", () => {
  it("自転車が通れない道の行は、畳まずに先頭へ「通らない」と鍵で出し、選び直す操作を持たない", () => {
    renderPanel();

    for (const { label } of routeGenerateConfig.road_avoidance.fixed_rows) {
      expect(screen.getByRole("img", { name: `${label}はいつも${EXCLUDE.label}（変えられません）` })).toBeVisible();
      expect(screen.queryByRole("radiogroup", { name: `${label}の避け方` })).toBeNull();
    }
  });

  it("行の避け方はレイヤごとに畳んで並べ、開いて選ぶとその行だけを変えた値を上げる", async () => {
    const { onRoadAvoidanceChange } = renderPanel();
    const layerLabels = [...new Set(AVOIDABLE_ROWS.map(({ layer_label }) => layer_label))];
    for (const label of layerLabels) expect(layerTrigger(label)).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(layerTrigger(ROW.layer_label));
    const group = screen.getByRole("radiogroup", { name: `${ROW.label}の避け方` });
    expect(within(group).getByRole("radio", { checked: true })).toHaveTextContent(
      AVOIDANCE_LEVELS.find(({ key }) => key === DEFAULT_ROAD_AVOIDANCE[ROW.key])!.label,
    );
    await userEvent.click(within(group).getByRole("radio", { name: OTHER_LEVEL.label }));

    expect(onRoadAvoidanceChange).toHaveBeenCalledExactlyOnceWith(AVOIDANCE_CUSTOMIZED);
  });

  it("既定から変えた行があるレイヤは、畳んだ見出しに変えた行の数を出す", () => {
    renderPanel(AVOIDANCE_CUSTOMIZED);
    const otherLayer = AVOIDABLE_ROWS.find(({ layer }) => layer !== ROW.layer)!;

    expect(layerTrigger(ROW.layer_label)).toHaveTextContent("既定から1件変更");
    expect(layerTrigger(otherLayer.layer_label)).not.toHaveTextContent("既定から");
  });

  it("見出しの行を持たず、全部を既定へ戻す操作も置かない（並びは固定の行から始まる）", () => {
    const { container } = render(
      <HardFilterPanel roadAvoidance={AVOIDANCE_CUSTOMIZED} onRoadAvoidanceChange={vi.fn()} />,
    );
    const [firstFixed] = routeGenerateConfig.road_avoidance.fixed_rows;

    expect(container.firstElementChild!.firstElementChild).toHaveTextContent(new RegExp(`^${firstFixed.label}`));
    expect(screen.queryByRole("button", { name: /既定(値)?に戻す/ })).toBeNull();
  });
});
