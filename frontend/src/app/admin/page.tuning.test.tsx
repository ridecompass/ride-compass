/**
 * `app/admin/page.tsx` の「較正値」タブ——backendが返した較正値を効き方ごとに並べ、打った値は「DBへ保存」で、変えた行だけを
 * 1行ずつ本番のDBへ書くこと。
 *
 * 並べる項目・効き方の見出しはbackendが返したものだけを使う（画面側に一覧を持たない）ため、テストも架空の項目を与える。
 *
 * ここで見ないもの:
 * - 数値の入力欄の途中の文字の扱い → `components/ui/NumberInput`
 * - 叩く先 → `app/admin/adminApi.test.ts`
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { TuningParameter } from "@/features/admin/adminApi";
import { heldReplies, inTurn, onSameOrigin, type SentRequest } from "@/testing/backendServer";

import AdminPage from "./page";

const LIST = "/admin/api/tuning";
const UPDATE = "/admin/api/tuning/:paramId";

function parameter(overrides: Partial<TuningParameter>): TuningParameter {
  return {
    id: "g.param",
    label: "項目",
    unit: "",
    description: "",
    effect: "live",
    effect_title: "すぐ効く",
    value: 0,
    ...overrides,
  };
}

const alpha = parameter({ id: "g.alpha", label: "アルファ", value: 10 });
const beta = parameter({ id: "g.beta", label: "ベータ", value: 7 });
const gamma = parameter({ id: "g.gamma", label: "ガンマ", value: 1 });

/** 保存に、送った値を効かせた行を返す。 */
function acceptUpdates(rows: TuningParameter[]): SentRequest[] {
  return onSameOrigin("PUT", UPDATE, ({ path, body }) => {
    const row = rows.find((candidate) => path.endsWith(`/${candidate.id}`))!;
    return Response.json({ ...row, value: (body as { value: number }).value });
  });
}

const updates = (sent: SentRequest[]) => sent.map(({ path, body }) => [path, body]);

async function openTuningTab() {
  const user = userEvent.setup();
  render(<AdminPage />);
  await user.click(screen.getByRole("tab", { name: "較正値" }));
  return user;
}

async function openWith(rows: TuningParameter[]) {
  onSameOrigin("GET", LIST, () => Response.json(rows));
  const user = await openTuningTab();
  await screen.findByRole("button", { name: "DBへ保存" });
  return user;
}

async function typeValue(user: ReturnType<typeof userEvent.setup>, label: string, value: string) {
  const input = screen.getByRole("spinbutton", { name: label });
  await user.clear(input);
  await user.type(input, value);
}

describe("AdminPage 較正値", () => {
  it("取得に失敗したら理由と読み込み直しの口を出し、届けば効き方ごとに届いた順の見出しで、行も届いた順に並べる", async () => {
    onSameOrigin(
      "GET",
      LIST,
      inTurn(
        Response.json({ detail: "リクエストに失敗しました" }, { status: 500 }),
        Response.json([
          parameter({ id: "a1", label: "A1", value: 3 }),
          parameter({ id: "b1", label: "B1", effect: "restart", effect_title: "再起動で効く" }),
          parameter({ id: "a2", label: "A2" }),
        ]),
      ),
    );
    const user = await openTuningTab();

    expect(await screen.findByText("リクエストに失敗しました")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "読み込み直す" }));

    expect(await screen.findByRole("spinbutton", { name: "A1" })).toHaveValue(3);
    expect(screen.queryByText("リクエストに失敗しました")).not.toBeInTheDocument();
    const headings = screen.getAllByText(/^(すぐ効く|再起動で効く)$/);
    expect(headings.map((heading) => heading.textContent)).toEqual(["すぐ効く", "再起動で効く"]);
    const labelsUnder = (heading: HTMLElement) =>
      within(heading.parentElement!)
        .getAllByRole("spinbutton")
        .map((input) => input.getAttribute("aria-label"));
    expect(labelsUnder(headings[0])).toEqual(["A1", "A2"]);
    expect(labelsUnder(headings[1])).toEqual(["B1"]);
  });

  it("打っただけでは送らず、今の値と違う行だけを未保存として数える。元の値へ戻せば数えない", async () => {
    const user = await openWith([alpha, beta]);
    const sent = acceptUpdates([alpha, beta]);
    expect(screen.getByRole("button", { name: "DBへ保存" })).toBeDisabled();

    await typeValue(user, "アルファ", "12");
    expect(screen.getByText("1件が未保存")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "DBへ保存" })).toBeEnabled();

    await typeValue(user, "アルファ", "10");
    expect(screen.queryByText(/件が未保存/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "DBへ保存" })).toBeDisabled();
    expect(sent).toEqual([]);
  });

  it("保存すると、値を変えた行だけを1行ずつ送り、返った値で行を置き換える", async () => {
    const user = await openWith([alpha, beta, gamma]);
    const sent = acceptUpdates([alpha, beta, gamma]);

    await typeValue(user, "アルファ", "12");
    await typeValue(user, "ガンマ", "0.005");
    await user.click(screen.getByRole("button", { name: "DBへ保存" }));

    await waitFor(() => expect(screen.queryByText(/件が未保存/)).not.toBeInTheDocument());
    expect(updates(sent)).toEqual([
      ["/admin/api/tuning/g.alpha", { value: 12 }],
      ["/admin/api/tuning/g.gamma", { value: 0.005 }],
    ]);
    expect(screen.getByRole("spinbutton", { name: "アルファ" })).toHaveValue(12);
    expect(screen.getByRole("spinbutton", { name: "ガンマ" })).toHaveValue(0.005);
    expect(screen.getByRole("button", { name: "DBへ保存" })).toBeDisabled();
  });

  it("保存中はそう出し、待つ間に打ち直した値は消さずに未保存として残す", async () => {
    const held = heldReplies();
    const user = await openWith([alpha]);
    onSameOrigin("PUT", UPDATE, held.reply);

    await typeValue(user, "アルファ", "12");
    await user.click(screen.getByRole("button", { name: "DBへ保存" }));
    expect(await screen.findByRole("button", { name: "保存中…" })).toBeInTheDocument();
    await typeValue(user, "アルファ", "15");
    await held.answer(0, Response.json({ ...alpha, value: 12 }));

    expect(await screen.findByRole("button", { name: "DBへ保存" })).toBeEnabled();
    expect(screen.getByRole("spinbutton", { name: "アルファ" })).toHaveValue(15);
    expect(screen.getByText("1件が未保存")).toBeInTheDocument();
  });

  it("途中の行で失敗したら、理由を出して後の行は送らず、打った値を残す。押し直すと残りを送り直せる", async () => {
    const user = await openWith([alpha, beta]);
    const sent = onSameOrigin(
      "PUT",
      UPDATE,
      inTurn(
        Response.json({ detail: "競合しました" }, { status: 409 }),
        Response.json({ ...alpha, value: 12 }),
        Response.json({ ...beta, value: 6 }),
      ),
    );

    await typeValue(user, "アルファ", "12");
    await typeValue(user, "ベータ", "6");
    await user.click(screen.getByRole("button", { name: "DBへ保存" }));

    expect(await screen.findByText("競合しました")).toBeInTheDocument();
    expect(updates(sent)).toEqual([["/admin/api/tuning/g.alpha", { value: 12 }]]);
    expect(screen.getByText("2件が未保存")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "ベータ" })).toHaveValue(6);
    // 一覧は届いているので、読み込み直しの口は出さない（保存の失敗は打ち直して押し直す）。
    expect(screen.queryByRole("button", { name: "読み込み直す" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "DBへ保存" }));
    await waitFor(() => expect(screen.queryByText(/件が未保存/)).not.toBeInTheDocument());
    expect(screen.queryByText("競合しました")).not.toBeInTheDocument();
    expect(updates(sent).slice(1)).toEqual([
      ["/admin/api/tuning/g.alpha", { value: 12 }],
      ["/admin/api/tuning/g.beta", { value: 6 }],
    ]);
  });
});
