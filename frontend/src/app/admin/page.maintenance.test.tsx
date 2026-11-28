/**
 * `app/admin/page.tsx` の「データ保守」タブ——本番DBの状態は押したときだけ集計して、手当ての要る件数と行を出すこと。
 *
 * 開いただけでは要求を出さない（DB全体の走査のため）。応答を与えていない要求はテストを落とすので、
 * 押す前に応答を与えないことで、押すまで送らないことを見る。
 *
 * ここで見ないもの:
 * - 叩く先 → `app/admin/adminApi.test.ts`
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { inTurn, onSameOrigin } from "@/testing/backendServer";
import type { DbStatusResponse } from "@/types/route";

import AdminPage from "./page";

const MB = 1024 * 1024;

async function openMaintenanceTab() {
  const user = userEvent.setup();
  render(<AdminPage />);
  await user.click(screen.getByRole("tab", { name: "データ保守" }));
  return user;
}

/** 見出しが`title`のカード。 */
function card(title: string): HTMLElement {
  return screen.getByText(title).closest<HTMLElement>("[class*='flex-col']")!;
}

/** 行の開いた先の項目と値。 */
function detailOf(container: HTMLElement, name: string): [string | null, string | null][] {
  return Array.from(within(container).getByText(name).closest("details")!.querySelectorAll("dt")).map((dt) => [
    dt.textContent,
    dt.nextElementSibling?.textContent ?? null,
  ]);
}

describe("AdminPage データ保守 本番DBの状態", () => {
  const TITLE = "本番DBの状態";
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
      table({ table_name: "hot", row_count: 1000, dead_tuples: 50, needs_attention: true, note: "VACUUMが遅れている" }),
      table({ table_name: "calm_a", row_count: 1000, total_bytes: 10.4 * MB }),
      table({ table_name: "calm_b", row_count: 2000, total_bytes: 20 * MB }),
    ],
    database_bytes: 3 * 1024 * MB,
  };

  it("押したときだけ集計し、失敗しても理由を出して再集計の口を残す", async () => {
    const user = await openMaintenanceTab();
    onSameOrigin(
      "GET",
      "/admin/api/db-status",
      inTurn(Response.json({ detail: "DBに届きません" }, { status: 503 }), Response.json(report)),
    );

    await user.click(within(card(TITLE)).getByRole("button", { name: "集計する" }));
    expect(await within(card(TITLE)).findByText("集計失敗: DBに届きません")).toBeInTheDocument();

    await user.click(within(card(TITLE)).getByRole("button", { name: "集計する" }));
    expect(await within(card(TITLE)).findByRole("button", { name: "再集計する" })).toBeEnabled();
    expect(within(card(TITLE)).queryByText(/^集計失敗/)).not.toBeInTheDocument();
  });

  it("注意の数と母数を先頭に出し、取込・接続・テーブルの順に並べ、注意の無いテーブルは基準を名乗る1行へ畳む", async () => {
    onSameOrigin("GET", "/admin/api/db-status", () => Response.json(report));
    const user = await openMaintenanceTab();
    await user.click(within(card(TITLE)).getByRole("button", { name: "集計する" }));

    expect(await within(card(TITLE)).findByText("2件に注意")).toBeInTheDocument();
    expect(within(card(TITLE)).getByText("3テーブル ・ 4,000行 ・ 3.0 GB ・ 9/24 10:02")).toBeInTheDocument();
    expect(within(card(TITLE)).getByText("osm").closest("summary")).toHaveTextContent("#7 失敗注意が要る");
    expect(within(card(TITLE)).getByText("同時接続").closest("summary")).toHaveTextContent("問題なし");
    expect(detailOf(card(TITLE), "hot")).toContainEqual(["不要行", "50件"]);
    expect(within(card(TITLE)).getByText("VACUUMが遅れている")).toBeInTheDocument();
    expect(within(card(TITLE)).getByText("注意なし 2テーブル").closest("summary")).toHaveTextContent(
      "3,000行 ・ 30 MB",
    );
    expect(detailOf(card(TITLE), "注意なし 2テーブル")).toEqual([
      ["calm_a", "1,000行 ・ 10 MB"],
      ["calm_b", "2,000行 ・ 20 MB"],
    ]);
  });
});
