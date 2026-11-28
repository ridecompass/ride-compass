/**
 * `BackendLogsPanel.tsx`——入れた絞り込みがそのまま問い合わせとして送られ、backendが返したログの行が画面に出ること。
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { translate } from "@/i18n/config";
import { describe, expect, it } from "vitest";

import { onSameOrigin } from "@/testing/backendServer";

import BackendLogsPanel from "./BackendLogsPanel";

describe("BackendLogsPanel", () => {
  it("押すと、入れた絞り込みで問い合わせ、返った行を出す", async () => {
    // 届いた問い合わせの項目を1行のログとして返し、送った絞り込みを出た行から読む。
    onSameOrigin("GET", "/admin/api/debug/logs", ({ query }) => Response.json([JSON.stringify(query)]));
    const user = userEvent.setup();
    render(<BackendLogsPanel />);

    await user.type(screen.getByPlaceholderText(translate("admin.logs.contains")), "jma-tile");
    await user.selectOptions(screen.getByRole("combobox", { name: translate("admin.logs.minLevel") }), "ERROR");
    const limit = screen.getByRole("spinbutton", { name: translate("admin.logs.limit") });
    await user.clear(limit);
    await user.type(limit, "50");
    await user.click(screen.getByRole("button", { name: translate("admin.logs.fetch") }));

    const line = await screen.findByText(/^\{.*\}$/);
    expect(JSON.parse(line.textContent!)).toEqual({ contains: "jma-tile", min_level: "ERROR", limit: "50" });
  });
});
