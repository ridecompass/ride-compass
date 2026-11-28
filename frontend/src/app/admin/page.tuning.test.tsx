/**
 * `app/admin/page.tsx` の「較正値」タブ——backendが返した較正値が入力欄に出て、変えて「DBへ保存」した値がそのとおり送られること。
 *
 * 並べる項目はbackendが返したものだけを使う（画面側に一覧を持たない）ため、テストも架空の項目を与える。
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { TuningParameter } from "@/features/admin/adminApi";
import { onSameOrigin } from "@/testing/backendServer";

import AdminPage from "./page";

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

describe("AdminPage 較正値", () => {
  it("返った値を入力欄に出し、変えて保存すると、変えた行の値をそのまま送る", async () => {
    onSameOrigin("GET", "/admin/api/tuning", () => Response.json([alpha, beta]));
    const sent = onSameOrigin("PUT", "/admin/api/tuning/:paramId", ({ body }) =>
      Response.json({ ...alpha, value: (body as { value: number }).value }),
    );
    const user = userEvent.setup();
    render(<AdminPage />);
    await user.click(screen.getByRole("tab", { name: "較正値" }));

    const input = await screen.findByRole("spinbutton", { name: "アルファ" });
    expect(input).toHaveValue(10);
    expect(screen.getByRole("spinbutton", { name: "ベータ" })).toHaveValue(7);

    await user.clear(input);
    await user.type(input, "0.005");
    await user.click(screen.getByRole("button", { name: "DBへ保存" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent.map(({ path, body }) => [path, body])).toEqual([["/admin/api/tuning/g.alpha", { value: 0.005 }]]);
  });
});
