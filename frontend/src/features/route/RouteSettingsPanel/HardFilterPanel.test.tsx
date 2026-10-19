/**
 * `RouteSettingsPanel/HardFilterPanel.tsx`——「除外」タブ。道の区分の行ごとの避け方の選びと、自転車が通れない道の固定の行。
 *
 * 見るもの: 固定の行を「通らない」に鍵を付けて並びの先頭に出し、選ぶ操作を持たないこと（軸カタログが届く前も出す）。行の避け方を
 * 節ごとに畳んで並べ（行の無い節は出さない）、選ぶとその行だけを変えた値を上げ、既定から変えた行の数を畳んだ見出しに出すこと。
 * 選んでいない行は、前の鍵に選んだ段のうち強い方を、それも無ければ既定の段を出すこと。見出しの行と全部を既定へ戻す操作を持たないこと。
 *
 * ここで見ないもの: 保存値を読むこと → `features/route/useGenerationConditions.test.ts`。生成の要求へ載せること →
 * `features/route/useRouteGeneration.test.ts`。(i)の奥の文（配られた説明を写すだけ）。
 *
 * 固定の行は生成物（`route-generate-config.json`）から読む。行・段・節は軸カタログが配る（本番の値は管理DBが持つ）ので、テストが組む。
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AVOIDANCE_LEVELS, avoidanceRow } from "@/testing/catalogAxes";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";
import type { RoadAvoidanceOverride, RoadAvoidanceView } from "@/types/route";

import HardFilterPanel from "./HardFilterPanel";

const AVOIDANCE: RoadAvoidanceView = {
  levels: AVOIDANCE_LEVELS,
  sections: [
    { key: "surface", label: "路面", description: "路面の区分ごとに選びます。" },
    { key: "empty", label: "行の無い節", description: "" },
    { key: "access", label: "通行", description: "" },
  ],
  rows: [
    avoidanceRow("gravel", "surface", { label: "砂利" }),
    avoidanceRow("unpaved", "surface", { label: "未舗装", default: "avoid", former_keys: ["dirt", "mud"] }),
    avoidanceRow("private", "access", { label: "私道", default: "exclude" }),
  ],
};
const NO_AVOIDANCE: RoadAvoidanceView = { levels: [], sections: [], rows: [] };

function renderPanel(roadAvoidance: RoadAvoidanceOverride = {}, avoidance: RoadAvoidanceView = AVOIDANCE) {
  const onRoadAvoidanceChange = vi.fn();
  const view = render(
    <HardFilterPanel
      avoidance={avoidance}
      roadAvoidance={roadAvoidance}
      onRoadAvoidanceChange={onRoadAvoidanceChange}
    />,
  );
  return { ...view, onRoadAvoidanceChange };
}

const sectionTrigger = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });
const checkedLevel = (row: string) =>
  within(screen.getByRole("radiogroup", { name: `${row}の避け方` })).getByRole("radio", { checked: true });

describe("HardFilterPanel", () => {
  it.each([
    ["軸カタログが届いたあと", AVOIDANCE],
    ["軸カタログが届く前", NO_AVOIDANCE],
  ])("%sも、自転車が通れない道の行は畳まずに鍵で出し、選び直す操作を持たない", (_, avoidance) => {
    renderPanel({}, avoidance);

    expect(routeGenerateConfig.hard_filters.length).toBeGreaterThan(0);
    for (const { label } of routeGenerateConfig.hard_filters) {
      expect(screen.getByRole("img", { name: `${label}はいつも経路から外れます（変えられません）` })).toBeVisible();
      expect(screen.queryByRole("radiogroup", { name: `${label}の避け方` })).toBeNull();
    }
  });

  it("行の避け方は行のある節ごとに畳んで並べ、開いて選ぶとその行だけを変えた値を上げる", async () => {
    const { onRoadAvoidanceChange } = renderPanel({ private: "avoid" });
    expect(sectionTrigger("路面")).toHaveAttribute("aria-expanded", "false");
    expect(sectionTrigger("通行")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /^行の無い節/ })).toBeNull();

    await userEvent.click(sectionTrigger("路面"));
    expect(screen.getByText("路面の区分ごとに選びます。")).toBeVisible();
    expect(checkedLevel("砂利")).toHaveTextContent("通る");
    await userEvent.click(
      within(screen.getByRole("radiogroup", { name: "砂利の避け方" })).getByRole("radio", { name: "通らない" }),
    );

    expect(onRoadAvoidanceChange).toHaveBeenCalledExactlyOnceWith({ private: "avoid", gravel: "exclude" });
  });

  it.each([
    ["何も選んでいなければ既定の段", {}, "なるべく避ける"],
    ["前の鍵に選んだ段があれば、そのうち強い方", { dirt: "exclude", mud: "pass" }, "通らない"],
    ["今の鍵に選んだ段があれば、前の鍵より今の鍵", { unpaved: "pass", dirt: "exclude" }, "通る"],
  ] as const)("選んでいない行は、%sを出す", async (_, roadAvoidance, shown) => {
    renderPanel(roadAvoidance);
    await userEvent.click(sectionTrigger("路面"));

    expect(checkedLevel("未舗装")).toHaveTextContent(shown);
  });

  it("既定から変えた行がある節は、畳んだ見出しに変えた行の数を出す", () => {
    renderPanel({ gravel: "avoid", dirt: "exclude", private: "exclude" });

    expect(sectionTrigger("路面")).toHaveTextContent("既定から2件変更");
    expect(sectionTrigger("通行")).not.toHaveTextContent("既定から");
  });

  it("見出しの行を持たず、全部を既定へ戻す操作も置かない（並びは固定の行から始まる）", () => {
    const { container } = renderPanel({ gravel: "avoid" });
    const [firstFixed] = routeGenerateConfig.hard_filters;

    expect(container.firstElementChild!.firstElementChild).toHaveTextContent(new RegExp(`^${firstFixed.label}`));
    expect(screen.queryByRole("button", { name: /既定(値)?に戻す/ })).toBeNull();
  });
});
