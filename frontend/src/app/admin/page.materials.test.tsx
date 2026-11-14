/**
 * `app/admin/page.tsx` の「材料」タブ——材料ごとの欠損割合を押したときだけ集計し、「欠損時の扱い」の群ごとに欠損割合の
 * 高い順の表で出すこと。どの群にも入らない材料は別の群で拾い、集計対象外の材料は理由つきで畳む。
 *
 * 群の見出しと母集団の名前はbackendの宣言（生成物 `vocabulary.ts`）が配るため、期待値もそこから引く。
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { onSameOrigin } from "@/testing/backendServer";
import { vocabulary } from "@/types/generated/vocabulary";
import type { MaterialCoverageEntry, MaterialCoverageResponse } from "@/types/route";

import AdminPage from "./page";

type CountedEntry = Extract<MaterialCoverageEntry, { kind: "counted" }>;

const [affecting, reference] = vocabulary.materialMissingSemantics;
const [way, edge] = vocabulary.materialPopulations;

function counted(overrides: Partial<CountedEntry>): CountedEntry {
  return {
    kind: "counted",
    material_id: "m",
    label: "材料",
    dtype: "numeric",
    population: "way",
    total: 100,
    missing: 0,
    missing_ratio: 0,
    source: "tag",
    missing_semantics: affecting.key,
    ...overrides,
  };
}

const report: MaterialCoverageResponse = {
  computed_at: "2026-09-24T01:02:03Z",
  way_total: 12000,
  edge_total: 34000,
  materials: [
    counted({ material_id: "low", label: "低", missing: 1, missing_ratio: 0.01 }),
    counted({ material_id: "none", label: "割合なし", total: 0, missing_ratio: null }),
    counted({ material_id: "high", label: "高", missing: 1234, total: 2000, missing_ratio: 0.617 }),
    counted({ material_id: "ref", label: "参考", missing_semantics: reference.key }),
    counted({
      material_id: "odd",
      label: "未知",
      missing_semantics: "not-declared" as CountedEntry["missing_semantics"],
    }),
    { kind: "excluded", material_id: "ex", label: "除外", excluded_reason: "区間に持たない" },
  ],
};

/** 群の表の、材料名の列を上から順に。 */
function materialsIn(title: string): string[] {
  return within(screen.getByRole("region", { name: title }))
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelector("td")!.firstChild!.textContent!);
}

describe("AdminPage 材料", () => {
  it("押したときだけ集計し、欠損時の扱いの群ごとに欠損割合の高い順（割合の無いものは最後）に並べ、宣言に無い扱いと集計対象外も拾う", async () => {
    const user = userEvent.setup();
    render(<AdminPage />);
    onSameOrigin("GET", "/admin/api/material-catalog/coverage", () => Response.json(report));
    await user.click(screen.getByRole("button", { name: "集計する" }));

    expect(
      await screen.findByText(`${way.label} 12,000件 ・ ${edge.label} 34,000件 ・ 9/24 10:02`),
    ).toBeInTheDocument();
    expect(materialsIn(affecting.title)).toEqual(["高", "低", "割合なし"]);
    expect(materialsIn(reference.title)).toEqual(["参考"]);
    expect(materialsIn("欠損時の扱いが不明な材料")).toEqual(["未知"]);

    const high = within(screen.getByRole("region", { name: affecting.title }))
      .getByText("高")
      .closest("tr")!;
    expect(high).toHaveTextContent(way.label);
    expect(high).toHaveTextContent("61.7%");
    expect(high).toHaveTextContent("1,234 / 2,000");

    expect(screen.getByText("集計対象外の材料（1件）")).toBeInTheDocument();
    expect(screen.getByText(/区間に持たない/).closest("li")).toHaveTextContent("除外: 区間に持たない");
  });
});
