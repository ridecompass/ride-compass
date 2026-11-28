/**
 * `app/admin/page.tsx` の「ひな形」タブ——届いたひな形を並べ、足す・名前と説明と公開を直す・利用者の画面と同じ「難所」「道路」の
 * 部品で設定を選ぶ・消すを手元で行い、「DBへ保存」で全体を1回で送ること。断られたら理由を出し、直した全体を残すこと。
 *
 * ここで見ないもの:
 * - 「難所」「道路」の部品が段をどう描き、選んだ段をどう上げるか → `RouteSettingsPanel.test.tsx`・`HardFilterPanel.test.tsx`
 * - 公開したひな形が利用者の画面に並び、選ぶと入れ替わること → `app/page.test.tsx`
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { RouteProfile } from "@/features/admin/adminApi";
import { STANDARD_COST_PREFERENCE } from "@/lib/costPreference";
import { onSameOrigin, inTurn, serveClientConfig, serveCostAxisCatalog } from "@/testing/backendServer";
import { AVOIDANCE_LEVELS, avoidanceRow, clientConfigResponse, roadClassCatalog } from "@/testing/clientConfig";
import { MAP_OVERLAY_GROUP_LABELS } from "@/lib/mapDisplay/overlayGroups";

import AdminPage from "./page";

const PATH = "/admin/api/route-profiles";

const NIGHT: RouteProfile = {
  name: "夜",
  description: "暗い道を避けます",
  published: true,
  cost_preference: { strength: 1.5, multipliers: {}, disabled_axes: [] },
  road_avoidance: {},
};

async function openWith(profiles: RouteProfile[]) {
  onSameOrigin("GET", PATH, () => Response.json({ profiles }));
  const user = userEvent.setup();
  render(<AdminPage />);
  await user.click(screen.getByRole("tab", { name: "ひな形" }));
  await screen.findByRole("button", { name: "DBへ保存" });
  return user;
}

describe("AdminPage ひな形", () => {
  it("足したひな形の名前・公開・難所と道路の設定を直して保存すると、全体を1回で送り、未保存が消える", async () => {
    serveCostAxisCatalog();
    serveClientConfig(
      clientConfigResponse({
        road_classes: roadClassCatalog({
          avoidance: {
            levels: AVOIDANCE_LEVELS,
            sections: [{ key: "surface", label: "路面" }],
            rows: [avoidanceRow("surface.gravel", "surface")],
          },
        }),
      }),
    );
    const user = await openWith([NIGHT]);
    const sent = onSameOrigin("PUT", PATH, ({ body }) => Response.json(body));
    expect(screen.getByRole("button", { name: "DBへ保存" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "ひな形を足す" }));
    const added = within(screen.getAllByRole("listitem")[1]);
    await user.clear(added.getByRole("textbox", { name: "名前" }));
    await user.type(added.getByRole("textbox", { name: "名前" }), "雨");
    await user.click(added.getByRole("checkbox", { name: "雨を公開" }));
    await user.click(
      within(await added.findByRole("radiogroup", { name: "振動の割合" })).getByRole("radio", { name: "無効" }),
    );
    await user.click(added.getByRole("tab", { name: MAP_OVERLAY_GROUP_LABELS.road }));
    await user.click(added.getByRole("button", { name: /^路面/ }));
    await user.click(
      within(added.getByRole("radiogroup", { name: "surface.gravelの避け方" })).getByRole("radio", { name: "×2" }),
    );
    expect(screen.getByText("未保存")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "DBへ保存" }));

    await waitFor(() => expect(screen.queryByText("未保存")).not.toBeInTheDocument());
    expect(sent.map(({ body }) => body)).toEqual([
      {
        profiles: [
          NIGHT,
          {
            name: "雨",
            description: "",
            published: true,
            cost_preference: { ...STANDARD_COST_PREFERENCE, disabled_axes: ["vibration"] },
            road_avoidance: { "surface.gravel": "avoid" },
          },
        ],
      },
    ]);
  });

  it("断られたら理由を出し、直した全体を残して押し直せる。消したひな形は送らない", async () => {
    const user = await openWith([NIGHT, { ...NIGHT, name: "雨" }]);
    const sent = onSameOrigin(
      "PUT",
      PATH,
      inTurn(
        Response.json({ detail: "ひな形が通りません（夜: 無い軸）" }, { status: 409 }),
        Response.json({ profiles: [{ ...NIGHT, name: "雨" }] }),
      ),
    );

    await user.click(within(screen.getAllByRole("listitem")[0]).getByRole("button", { name: "消す" }));
    await user.click(screen.getByRole("button", { name: "DBへ保存" }));

    expect(await screen.findByText("ひな形が通りません（夜: 無い軸）")).toBeInTheDocument();
    expect(screen.getAllByRole("textbox", { name: "名前" }).map((input) => (input as HTMLInputElement).value)).toEqual([
      "雨",
    ]);
    await user.click(screen.getByRole("button", { name: "DBへ保存" }));
    await waitFor(() => expect(screen.queryByText("未保存")).not.toBeInTheDocument());
    expect(sent.map(({ body }) => body)).toEqual([
      { profiles: [{ ...NIGHT, name: "雨" }] },
      { profiles: [{ ...NIGHT, name: "雨" }] },
    ]);
  });
});
