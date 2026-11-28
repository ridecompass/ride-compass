/**
 * `app/admin/page.tsx` の「データ保守」タブ——押して集計した本番DBの状態のうち、backendが返した値が画面に出ること。
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { onSameOrigin } from "@/testing/backendServer";
import type { DbStatusResponse } from "@/types/route";

import AdminPage from "./page";

type TableEntry = DbStatusResponse["tables"][number];

function table(overrides: Partial<TableEntry>): TableEntry {
  return {
    table_name: "t",
    row_count: 0,
    total_bytes: 0,
    dead_tuples: 0,
    analyzed_at: null,
    vacuumed_at: null,
    needs_attention: false,
    note: "",
    ...overrides,
  };
}

const report: DbStatusResponse = {
  computed_at: "2026-09-24T01:02:03Z",
  imports: [
    {
      label: "osm",
      latest: { id: 7, status: "failed", finished_at: null, item_count: null, identity: { region: "kanto" } },
      latest_succeeded: { id: 6, finished_at: "2026-09-23T00:00:00Z" },
      needs_attention: true,
      note: "",
    },
  ],
  connections: {
    total: 3,
    max_connections: 100,
    idle_in_transaction: 0,
    longest_idle_transaction_seconds: 0,
    longest_query_seconds: 0,
    needs_attention: false,
    note: "",
  },
  tables: [
    table({ table_name: "hot", needs_attention: true, note: "VACUUMが遅れている" }),
    table({ table_name: "calm" }),
  ],
  database_bytes: 0,
};

describe("AdminPage データ保守 本番DBの状態", () => {
  it("押すと集計し、返った取込・テーブルの名前と注意の理由を出す", async () => {
    onSameOrigin("GET", "/admin/api/db-status", () => Response.json(report));
    const user = userEvent.setup();
    render(<AdminPage />);
    await user.click(screen.getByRole("tab", { name: "データ保守" }));
    const card = screen.getByText("本番DBの状態").closest<HTMLElement>("[class*='flex-col']")!;
    await user.click(within(card).getByRole("button", { name: "集計する" }));

    expect(await within(card).findByText("osm")).toBeInTheDocument();
    for (const shown of ["hot", "VACUUMが遅れている", "calm"]) {
      expect(within(card).getByText(shown)).toBeInTheDocument();
    }
  });
});
