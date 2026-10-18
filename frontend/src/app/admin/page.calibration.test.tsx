/**
 * `app/admin/page.tsx`——軸スタジオの較正の画面と、地図の機能の下書きの点数の地図の受け渡し: 下書きの点のつけ方で求めた
 * 道の点数を、画面で動かしている段の境界で塗り、地図を見ながら決めた線を保存する。
 *
 * 管理APIは網の層で応える。道の点数は、保存済みの線と、ほかの線で決めた値を返す代役にする。地図は`maplibre-gl`の代役へ描き、
 * 道の色は塗りの式をMapLibreと同じ評価器で道の状態へ当てて見る。道の点数の要求は数を見る——管理の口はタイルの要求の
 * 回数制限を共有する。
 *
 * ここで見ないもの:
 * - 較正の画面の操作・分布・段ごとの延長 → `features/admin/AxisStudio/AxisCalibration.test.tsx`
 * - 下書きの道の点数の計算 → backendの`test_axis_admin_routes.py`
 * - 道の線の塗り分け（取得中・値の無い道・凡例で隠した段） → `scene/groups/axisLines.test.ts`
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bandColorsFor, DEFAULT_DIFFICULTY_BOUNDARIES } from "@/lib/mapDisplay/valueScale";
import { onSameOrigin, serveAxisCatalog, type SentRequest } from "@/testing/backendServer";
import { catalogEntry, catalogResponse } from "@/testing/catalogAxes";
import { mapOnScreen } from "@/testing/maplibre";
import { evaluateExpression } from "@/testing/mapExpressions";
import regionTileConfig from "@/types/generated/region-tile-config.json";
import type { AxisDefinitionPayload, AxisDefinitionResponse } from "@/types/route";

import { generateBreakpoints } from "@/features/admin/AxisStudio/breakpointTools";

import AdminPage from "./page";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

const DEFINITIONS = "/admin/api/axis-definitions";
const SAVED_LINE = generateBreakpoints(0, 8, "flat");
const SLOPE = {
  axis_id: "steepness",
  label: "急さ",
  description: "",
  weight_share_when_published: 0.2,
  priority_overrides: [],
  icon_id: null,
  display_thresholds_override: null,
  display_band_labels_override: null,
  category: "推定",
  default_weight: 0.25,
  is_published: true,
  time_scope: "always",
  shape: {
    kind: "breakpoint_linear",
    terms: [{ material: "speed_limit", weight: 1, required: true }],
    preprocess: "identity",
    breakpoints: SAVED_LINE,
  },
} satisfies AxisDefinitionResponse;

/** 地図の道2本に、保存済みの線は10点・50点を、ほかの線は50点・90点を付ける代役。 */
const SAVED_WAY_VALUES = { "101": 10, "102": 50 };
const DRAFT_WAY_VALUES = { "101": 50, "102": 90 };
/** 道路タイルのズームの、狭い表示範囲（覆うタイルが1枚）。 */
const NARROW_VIEW = { west: 139.7, south: 35.68, east: 139.701, north: 35.681 };

let updated: SentRequest[];
let wayValueRequests: SentRequest[];
let calibrationRequests: SentRequest[];

beforeEach(() => {
  onSameOrigin("GET", DEFINITIONS, () => Response.json([SLOPE]));
  updated = onSameOrigin("PUT", `${DEFINITIONS}/:axisId`, ({ body }) => Response.json(body));
  onSameOrigin("POST", `${DEFINITIONS}/preview-distribution`, () =>
    Response.json({ sample_ways: 2, total_km: 2, quantiles: {}, bins: [[0, 2, 1]] }),
  );
  onSameOrigin("POST", `${DEFINITIONS}/preview-scores`, () => Response.json({ scores: [50], material_points: [] }));
  serveAxisCatalog(
    catalogResponse([catalogEntry({ axis_id: SLOPE.axis_id })], {
      tile_versions: Object.fromEntries(regionTileConfig.tile_version_kinds.map((kind) => [kind, "1-test"])),
    }),
  );
  wayValueRequests = onSameOrigin("POST", `${DEFINITIONS}/preview-way-values`, ({ body }) => {
    const { shape } = body as { shape: { breakpoints: unknown } };
    const saved = JSON.stringify(shape.breakpoints) === JSON.stringify(SAVED_LINE);
    return Response.json(saved ? SAVED_WAY_VALUES : DRAFT_WAY_VALUES);
  });
  calibrationRequests = onSameOrigin("POST", `${DEFINITIONS}/preview-calibration`, ({ body }) => {
    const { definition } = body as { definition: AxisDefinitionPayload };
    const thresholds = definition.display_thresholds_override ?? [...DEFAULT_DIFFICULTY_BOUNDARIES];
    return Response.json({
      map_paint: {
        value: { kind: "difficulty" },
        unit: "",
        thresholds,
        legend: { boundaries: thresholds, unit: null },
        band_labels: null,
      },
      averages_density: false,
    });
  });
});

/** 較正の画面で急さの軸を開き、地図のスタイルが読み込まれて狭い範囲を見ている状態にする。 */
async function openSlopeOnMap() {
  const user = userEvent.setup();
  render(<AdminPage />);
  // 較正の欄は軸の一覧が届く前から空のまま描かれるので、欄ではなく選ぶ軸の選択肢が出るのを待つ。
  await screen.findByRole("option", { name: new RegExp(`^${SLOPE.label}`) });
  await user.selectOptions(screen.getByRole("combobox", { name: "較正する軸" }), SLOPE.axis_id);
  await screen.findByRole("region", { name: "下書きの点数の地図" });
  act(() => {
    mapOnScreen().emit("load");
    mapOnScreen().moveTo(NARROW_VIEW, 14);
  });
  return user;
}

/** 地図がその道を塗っている色。 */
function roadColor(featureKey: string): unknown {
  const map = mapOnScreen();
  const paint = map.layerPaint(`road-tiles-${SLOPE.axis_id}`);
  return evaluateExpression(paint?.["line-color"], {}, map.featureState("road-tiles", featureKey) ?? {});
}

const defaultBandColors = bandColorsFor("difficulty", DEFAULT_DIFFICULTY_BOUNDARIES);

describe("下書きの点数の地図", () => {
  it("見ている範囲の道を、点のつけ方を動かすと下書きの点数で塗り直し、段の凡例を並べ、見ながら決めた線を保存する", async () => {
    const user = await openSlopeOnMap();
    await waitFor(() => expect(roadColor("101")).toBe(defaultBandColors[0]));
    expect(roadColor("102")).toBe(defaultBandColors[1]);
    const legend = within(screen.getByRole("region", { name: "下書きの点数の地図" })).getAllByRole("checkbox");
    expect(legend.length).toBe(DEFAULT_DIFFICULTY_BOUNDARIES.length + 2);

    fireEvent.keyDown(screen.getByRole("slider", { name: "100点の端" }), { key: "ArrowRight" });
    await waitFor(() => expect(roadColor("101")).toBe(defaultBandColors[1]));
    expect(roadColor("102")).toBe(defaultBandColors[2]);
    expect(wayValueRequests).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(updated).toHaveLength(1));
    const sent = (updated[0].body as AxisDefinitionPayload).shape as { breakpoints: unknown };
    expect(sent.breakpoints).toEqual(
      (wayValueRequests[1].body as { shape: { breakpoints: unknown } }).shape.breakpoints,
    );
  });

  it("段の境界だけを動かすと、道の点数を取り直さずに、その境界の段で塗り直す", async () => {
    const user = await openSlopeOnMap();
    await waitFor(() => expect(roadColor("101")).toBe(defaultBandColors[0]));

    await user.type(screen.getByRole("textbox", { name: "段の境界" }), "5, 20");
    const colors = bandColorsFor("difficulty", [5, 20]);
    expect(roadColor("101")).toBe(colors[1]);
    expect(roadColor("102")).toBe(colors[2]);
    // 境界の入力が落ち着いて段を問い合わせたあとも、道の点数の要求は最初の1回のまま。
    await waitFor(() =>
      expect(calibrationRequests.map((request) => request.body)).toContainEqual({
        definition: expect.objectContaining({ display_thresholds_override: [5, 20] }),
      }),
    );
    expect(wayValueRequests).toHaveLength(1);
  });

  it("道の点数を求められないと、backendの理由を出す", async () => {
    onSameOrigin("POST", `${DEFINITIONS}/preview-way-values`, () =>
      Response.json({ detail: "この軸には走行方位が必須です。" }, { status: 422 }),
    );
    await openSlopeOnMap();
    expect(await screen.findByText("この軸には走行方位が必須です。")).toBeInTheDocument();
  });
});
