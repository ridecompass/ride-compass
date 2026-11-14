/**
 * `app/admin/page.tsx` の「データ保守」タブ——タイルのキャッシュは押したときだけ消し、派生データの鮮度台帳と本番DBの状態は
 * 押したときだけ集計して、手当ての要る件数と行を出すこと。
 *
 * どれも開いただけでは要求を出さない（DB全体の走査・全利用者へ効く消去のため）。応答を与えていない要求はテストを落とすので、
 * 押す前に応答を与えないことで、押すまで送らないことを見る。
 *
 * ここで見ないもの:
 * - 叩く先 → `app/admin/adminApi.test.ts`
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { heldReplies, inTurn, onSameOrigin } from "@/testing/backendServer";
import type { DbStatusResponse, DerivedDataFreshnessResponse } from "@/types/route";

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

/** 行の名前（とまとまりの見出し）を並んだ順に。 */
function rowNames(container: HTMLElement): (string | null)[] {
  return within(container)
    .getAllByRole("listitem")
    .map((item) => item.querySelector("summary > span:not([aria-hidden])")?.textContent ?? item.textContent);
}

/** 行の開いた先の項目と値。 */
function detailOf(container: HTMLElement, name: string): [string | null, string | null][] {
  return Array.from(within(container).getByText(name).closest("details")!.querySelectorAll("dt")).map((dt) => [
    dt.textContent,
    dt.nextElementSibling?.textContent ?? null,
  ]);
}

describe("AdminPage データ保守 タイルキャッシュ", () => {
  const CLEAR = "タイルキャッシュを消去する";

  it("押すまで消さない。消去中は押せず、失敗なら理由を、押し直して成功すれば消したことだけを出す", async () => {
    const held = heldReplies();
    const user = await openMaintenanceTab();
    const sent = onSameOrigin("POST", "/admin/api/basemap/refresh", held.reply);

    await user.click(screen.getByRole("button", { name: CLEAR }));
    expect(screen.getByRole("button", { name: "消去中…" })).toBeDisabled();
    await held.answer(0, Response.json({ detail: "タイルキャッシュの消去に失敗しました" }, { status: 500 }));
    expect(await screen.findByText("タイルキャッシュの消去に失敗しました")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: CLEAR }));
    await held.answer(1, Response.json({}));
    expect(await screen.findByText(/^消去しました。/)).toHaveTextContent("Cache-Control");
    expect(screen.queryByText("タイルキャッシュの消去に失敗しました")).not.toBeInTheDocument();
    expect(sent).toHaveLength(2);
  });
});

describe("AdminPage データ保守 派生データ鮮度台帳", () => {
  const TITLE = "派生データ鮮度台帳";

  function freshness(overrides: Partial<DerivedDataFreshnessResponse>): DerivedDataFreshnessResponse {
    return { computed_at: "2026-09-24T01:02:03Z", sources: [], tables: [], tuning: [], ...overrides };
  }

  it("作り直しの要るソース・表・較正値を数えて先頭に出し、開いた先に取込の番号・列の増減・値なしの件数・較正値の新旧を並べる。全部最新ならそう言う", async () => {
    onSameOrigin(
      "GET",
      "/admin/api/derived-data/freshness",
      inTurn(
        Response.json(
          freshness({
            sources: [
              { source: "osm", latest_run_id: 5, derived_run_id: 3, needs_rebuild: true },
              { source: "accidents", latest_run_id: null, derived_run_id: null, needs_rebuild: false },
            ],
            tables: [
              {
                table_name: "way_values",
                row_count: 1200,
                columns: [
                  { column: "slope", null_count: 4 },
                  { column: "width", null_count: 0 },
                ],
                columns_change: { added: ["slope"], removed: ["old_a", "old_b"] },
                needs_rebuild: true,
              },
              { table_name: "edges", row_count: 10, columns: [], columns_change: null, needs_rebuild: false },
            ],
            tuning: [
              {
                param_id: "ring",
                label: "帯の幅",
                unit: "m",
                derived_value: 30,
                current_value: 40,
                needs_rebuild: true,
              },
              {
                param_id: "step",
                label: "断面の刻み",
                unit: "m",
                derived_value: null,
                current_value: 5,
                needs_rebuild: true,
              },
            ],
          }),
        ),
        Response.json(
          freshness({ sources: [{ source: "osm", latest_run_id: 5, derived_run_id: 5, needs_rebuild: false }] }),
        ),
      ),
    );
    const user = await openMaintenanceTab();
    await user.click(within(card(TITLE)).getByRole("button", { name: "集計する" }));

    expect(await within(card(TITLE)).findByText("4件が作り直し待ち")).toBeInTheDocument();
    expect(rowNames(card(TITLE))).toEqual([
      "取込",
      "osm",
      "accidents",
      "派生の表",
      "way_values",
      "edges",
      "較正値",
      "帯の幅",
      "断面の刻み",
    ]);
    expect(within(card(TITLE)).getByText("osm").closest("summary")).toHaveTextContent("作り直しが必要");
    expect(within(card(TITLE)).getByText("accidents").closest("summary")).toHaveTextContent("最新");
    expect(detailOf(card(TITLE), "osm")).toEqual([
      ["成功した最新の取込", "#5"],
      ["作り直しに使った取込", "#3"],
    ]);
    expect(detailOf(card(TITLE), "accidents")).toEqual([
      ["成功した最新の取込", "なし（取込が1度も成功していない）"],
      ["作り直しに使った取込", "なし（まだ作り直しに使っていない）"],
    ]);
    expect(detailOf(card(TITLE), "way_values")).toEqual([
      ["作り直しの後に足した列", "slope"],
      ["作り直しの後に消した列", "old_a、old_b"],
      ["slope", "値なし 4件"],
    ]);
    expect(detailOf(card(TITLE), "edges")).toEqual([
      ["作ったときの列", "記録なし（列を記録する作り直しをまだしていない）"],
    ]);
    expect(within(card(TITLE)).getByText("帯の幅").closest("summary")).toHaveTextContent("作り直しが必要");
    expect(detailOf(card(TITLE), "帯の幅")).toEqual([
      ["今の値", "40m"],
      ["作り直しに使った値", "30m"],
    ]);
    expect(detailOf(card(TITLE), "断面の刻み")).toEqual([
      ["今の値", "5m"],
      ["作り直しに使った値", "なし（まだ作り直しに使っていない）"],
    ]);

    await user.click(within(card(TITLE)).getByRole("button", { name: "再集計する" }));
    expect(await within(card(TITLE)).findByText("すべて最新")).toBeInTheDocument();
  });
});

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
    expect(rowNames(card(TITLE))).toEqual([
      "取込",
      "osm",
      "接続",
      "同時接続",
      "テーブル（容量の大きい順）",
      "hot",
      "注意なし 2テーブル",
    ]);
    expect(within(card(TITLE)).getByText("osm").closest("summary")).toHaveTextContent("#7 失敗注意が要る");
    expect(detailOf(card(TITLE), "osm")).toEqual([
      ["最終実行", "#7 ・ 記録なし"],
      ["成功した最新", "#6 ・ 9/23 09:00"],
      ["region", "kanto"],
    ]);
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
