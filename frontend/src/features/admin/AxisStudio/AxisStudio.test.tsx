/**
 * `AxisStudio.tsx`——軸スタジオの一覧: 下書き・公開済みの一覧と、その行に出すもの。
 *
 * 管理APIは網の層で応える。材料は本物の一覧（生成物）を通す。
 *
 * ここで見ないもの:
 * - 較正の画面 → `AxisCalibration.test.tsx`（下書きの点数の地図は`app/admin/page.calibration.test.tsx`）
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { MATERIAL_CATALOG } from "@/lib/axisMaterialsCatalog";
import { onSameOrigin } from "@/testing/backendServer";
import type { AxisDefinitionResponse } from "@/types/route";

import AxisStudio from "./AxisStudio";

function axis(overrides: Partial<AxisDefinitionResponse> = {}): AxisDefinitionResponse {
  return {
    axis_id: "axis_a",
    label: "軸A",
    description: "",
    weight_share_when_published: null,
    priority_overrides: [],
    icon_id: null,
    display_thresholds_override: null,
    display_band_labels_override: null,
    category: "推定",
    default_weight: 0.25,
    is_published: false,
    time_scope: "always",
    shape: { kind: "breakpoint_linear", terms: [], preprocess: "identity", breakpoints: [] },
    ...overrides,
  };
}

function termsOf(...materials: string[]): AxisDefinitionResponse["shape"] {
  return {
    kind: "breakpoint_linear",
    terms: materials.map((material) => ({ material, weight: 1, required: true })),
    preprocess: "identity",
    breakpoints: [],
  };
}

const DRAFT = axis({ axis_id: "axis_draft", label: "下書きの軸" });
const PUBLISHED = axis({ axis_id: "axis_pub", label: "公開の軸", is_published: true });
const PUBLISHED_2 = axis({ axis_id: "axis_pub2", label: "公開の軸2", is_published: true });

const DEFINITIONS = "/admin/api/axis-definitions";

const failure = (detail: string) => Response.json({ detail }, { status: 409 });

/** 管理APIの軸の定義の一覧の代役。 */
function serveAxisDefinitions(axes: AxisDefinitionResponse[]) {
  onSameOrigin("GET", DEFINITIONS, () => Response.json(axes));
}

beforeEach(() => {
  serveAxisDefinitions([DRAFT, PUBLISHED, PUBLISHED_2]);
});

/** 描いて、既定の一覧が届くまで待つ（`loaded: false`なら待たない。一覧を差し替えたテスト用）。 */
async function renderStudio({ loaded = true } = {}) {
  const user = userEvent.setup();
  render(<AxisStudio calibrationMap={() => null} />);
  if (loaded) await screen.findByRole("tab", { name: "公開済み（2）" });
  return user;
}

async function openPublishedTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("tab", { name: /公開済み/ }));
}

describe("一覧", () => {
  it("開くと一覧を取り、下書きのタブを既定で開き、タブに件数を出す", async () => {
    await renderStudio();
    expect(await screen.findByRole("tab", { name: "下書き（1）", selected: true })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "公開済み（2）" })).toBeInTheDocument();
    expect(screen.getByText("下書きの軸")).toBeInTheDocument();
  });

  it("一覧を取れなければ、理由を出す", async () => {
    onSameOrigin("GET", DEFINITIONS, () => failure("リクエストに失敗しました"));
    await renderStudio({ loaded: false });
    expect(await screen.findByText("リクエストに失敗しました")).toBeInTheDocument();
  });

  it("どちらのタブも、軸が無ければそう言う", async () => {
    serveAxisDefinitions([]);
    const user = await renderStudio({ loaded: false });
    expect(await screen.findByText("下書きの軸はありません。")).toBeInTheDocument();
    await openPublishedTab(user);
    expect(screen.getByText("公開済みの軸はありません。")).toBeInTheDocument();
  });

  it("行には分類・既定重み（小数2桁）・使うものを出し、使うものは軸なら軸の名前、材料なら材料の名前、どちらでもなければidで出す", async () => {
    const material = MATERIAL_CATALOG[0];
    serveAxisDefinitions([
      axis({ axis_id: "axis_ref", label: "参照する軸", shape: termsOf("axis_base", material.id, "unknown_id") }),
      axis({ axis_id: "axis_base", label: "土台の軸" }),
    ]);
    await renderStudio({ loaded: false });

    const summary = `推定 ・ 重み0.25 ・ 土台の軸・${material.label}・unknown_id`;
    expect(await screen.findByText(new RegExp(summary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeInTheDocument();
  });
});
