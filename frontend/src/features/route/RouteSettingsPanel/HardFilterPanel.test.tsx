/**
 * `RouteSettingsPanel/HardFilterPanel.tsx`——「除外」タブ。通らない道路の種類の切り替えと、地図の道のレイヤの凡例の行ごとの
 * 避け方の選びと、両方を既定へ戻す操作。
 *
 * 見るもの: 種類の切り替えが重みのタブの軸のチップと同じ形で入り・切りを出し、押すとその種類だけを反転した値を上げること。
 * 行の避け方をレイヤごとに畳んで並べ、選ぶとその行だけを変えた値を上げ、既定から変えた行の数を畳んだ見出しに出すこと。
 * 既定と違う間だけ既定へ戻す操作を押せ、押すと両方を既定へ戻すこと。
 *
 * ここで見ないもの: 保存値を今の項目・行へ揃えること → `features/route/useGenerationConditions.test.ts`・
 * `features/route/savedConditions.test.ts`（このパネルは全項目の揃った値を受け取る）。生成の要求へ載せること →
 * `features/route/useRouteGeneration.test.ts`。(i)の奥の文（書いた文・生成物の説明を写すだけ）。
 *
 * 種類・行・段・名前・既定は生成物（`route-generate-config.json`）から読み、テストに書き写さない。
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AVOIDABLE_ROWS, AVOIDANCE_LEVELS, DEFAULT_ROAD_AVOIDANCE } from "@/features/route/roadAvoidance";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";
import type { HardFilterOverride, RoadAvoidanceOverride } from "@/types/route";

import HardFilterPanel, { DEFAULT_HARD_FILTERS } from "./HardFilterPanel";

const [FIRST] = routeGenerateConfig.hard_filters.filters;
const [ROW] = AVOIDABLE_ROWS;
// 行の今の段と違う段（選び直す先）。
const OTHER_LEVEL = AVOIDANCE_LEVELS.find(({ key }) => key !== DEFAULT_ROAD_AVOIDANCE[ROW.key])!;

function renderPanel(hardFilters: HardFilterOverride, roadAvoidance: RoadAvoidanceOverride = DEFAULT_ROAD_AVOIDANCE) {
  const onHardFiltersChange = vi.fn();
  const onRoadAvoidanceChange = vi.fn();
  render(
    <HardFilterPanel
      hardFilters={hardFilters}
      onHardFiltersChange={onHardFiltersChange}
      roadAvoidance={roadAvoidance}
      onRoadAvoidanceChange={onRoadAvoidanceChange}
    />,
  );
  return { onHardFiltersChange, onRoadAvoidanceChange };
}

/** 最初の種類だけを既定から反転した値。 */
const CUSTOMIZED: HardFilterOverride = { ...DEFAULT_HARD_FILTERS, [FIRST.key]: !DEFAULT_HARD_FILTERS[FIRST.key] };
/** 最初の行だけを既定から変えた避け方。 */
const AVOIDANCE_CUSTOMIZED: RoadAvoidanceOverride = { ...DEFAULT_ROAD_AVOIDANCE, [ROW.key]: OTHER_LEVEL.key };

const layerTrigger = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });

describe("HardFilterPanel", () => {
  it("種類の切り替えは軸のチップと同じく、切っている間は薄く出し、押すとその種類だけを反転した値を上げる", async () => {
    const { onHardFiltersChange } = renderPanel(CUSTOMIZED);
    const toggle = screen.getByRole("button", { name: `${FIRST.label}を除外` });

    expect(toggle).toHaveAttribute("aria-pressed", String(CUSTOMIZED[FIRST.key]));
    expect(toggle.closest("li")).toHaveAttribute("data-checked", String(CUSTOMIZED[FIRST.key]));

    await userEvent.click(toggle);

    expect(onHardFiltersChange).toHaveBeenCalledExactlyOnceWith(DEFAULT_HARD_FILTERS);
  });

  it("行の避け方はレイヤごとに畳んで並べ、開いて選ぶとその行だけを変えた値を上げる", async () => {
    const { onRoadAvoidanceChange } = renderPanel(DEFAULT_HARD_FILTERS);
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
    renderPanel(DEFAULT_HARD_FILTERS, AVOIDANCE_CUSTOMIZED);
    const otherLayer = AVOIDABLE_ROWS.find(({ layer }) => layer !== ROW.layer)!;

    expect(layerTrigger(ROW.layer_label)).toHaveTextContent("既定から1件変更");
    expect(layerTrigger(otherLayer.layer_label)).not.toHaveTextContent("既定から");
  });

  it.each<[string, HardFilterOverride, RoadAvoidanceOverride]>([
    ["種類", CUSTOMIZED, DEFAULT_ROAD_AVOIDANCE],
    ["行の避け方", DEFAULT_HARD_FILTERS, AVOIDANCE_CUSTOMIZED],
  ])("%sが既定と違うときだけ既定へ戻す操作を押せ、押すと両方を既定へ戻す", async (_, hardFilters, roadAvoidance) => {
    renderPanel(DEFAULT_HARD_FILTERS);
    expect(screen.getByRole("button", { name: "除外を既定値に戻す" })).toBeDisabled();
    cleanup();

    const { onHardFiltersChange, onRoadAvoidanceChange } = renderPanel(hardFilters, roadAvoidance);
    await userEvent.click(screen.getByRole("button", { name: "除外を既定値に戻す" }));

    expect(onHardFiltersChange).toHaveBeenCalledExactlyOnceWith(DEFAULT_HARD_FILTERS);
    expect(onRoadAvoidanceChange).toHaveBeenCalledExactlyOnceWith(DEFAULT_ROAD_AVOIDANCE);
  });
});
