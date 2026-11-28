/**
 * `app/admin/page.tsx` の「材料」タブ——押して集計した材料ごとの欠損のうち、backendが返した値が画面に出ること。
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { translate } from "@/i18n/config";
import { describe, expect, it } from "vitest";

import { onSameOrigin } from "@/testing/backendServer";
import { vocabulary } from "@/types/generated/vocabulary";
import type { MaterialCoverageResponse } from "@/types/route";

import AdminPage from "./page";

const report: MaterialCoverageResponse = {
  computed_at: "2026-09-24T01:02:03Z",
  way_total: 12000,
  edge_total: 34000,
  materials: [
    {
      kind: "counted",
      material_id: "high",
      label: "高",
      dtype: "numeric",
      population: "way",
      total: 2000,
      missing: 1234,
      missing_ratio: 0.617,
      source: "tag",
      missing_semantics: vocabulary.materialMissingSemantics[0].key,
    },
    { kind: "excluded", material_id: "ex", label: "除外", excluded_reason: "区間に持たない" },
  ],
};

describe("AdminPage 材料", () => {
  it("押すと集計し、返った材料の欠損の件数と割合、集計対象外の理由を出す", async () => {
    onSameOrigin("GET", "/admin/api/material-catalog/coverage", () => Response.json(report));
    const user = userEvent.setup();
    render(<AdminPage />);
    await user.click(screen.getByRole("button", { name: translate("admin.report.run") }));

    const high = (await screen.findByText("高")).closest("tr")!;
    expect(high).toHaveTextContent("61.7%");
    expect(high).toHaveTextContent("1,234 / 2,000");
    expect(screen.getByText(/区間に持たない/)).toBeInTheDocument();
  });
});
