/**
 * `AxisCalibration.tsx`——1つの軸の較正: 数値の軸は0点・100点の端（密度の軸は100点の端だけ）を、対応表の軸は
 * 種類ごとの点数を、地図の段の境界と合わせて動かし、段ごとの延長を下書きと保存済みで見比べて、公開の状態のまま保存する。
 *
 * 管理APIは網の層で応える。点数は折れ点ごとに決めた値を返す代役で（計算はbackendの`score_at`が持つ）、地図の段は
 * 送られた境界の上書きを返し、無ければ既定の境界を返す代役にする。種類ごとの延長は決めた割合を返す代役にする。
 *
 * ここで見ないもの:
 * - グラフの座標の換算・ドラッグの丸め → `BreakpointCurveEditor.test.tsx`
 * - 3つの入力から作る折れ点 → `breakpointTools.test.ts`（期待値は`generateBreakpoints`から引く）
 * - 地図の段の求め方 → backendの`test_axis_admin_routes.py`
 * - 種類ごとの延長の集め方 → backendの`test_value_distribution.py`
 * - 一覧の行を開いて軸を選ぶこと → `AxisStudio.test.tsx`
 * - 下書きの点数の地図（別の機能の部品で、組み立てるページが渡す） → `app/admin/page.calibration.test.tsx`
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_DIFFICULTY_BOUNDARIES } from "@/lib/mapDisplay/valueScale";
import { onSameOrigin, type SentRequest } from "@/testing/backendServer";
import type { AxisDefinitionPayload, AxisDefinitionResponse } from "@/types/route";

import { AxisCalibration } from "./AxisCalibration";
import { generateBreakpoints } from "./breakpointTools";

type Breakpoints = [number, number][];

function axis(
  axisId: string,
  label: string,
  breakpoints: Breakpoints,
  overrides: Partial<AxisDefinitionResponse> = {},
) {
  return {
    axis_id: axisId,
    label,
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
      breakpoints,
    },
    ...overrides,
  } satisfies AxisDefinitionResponse;
}

const SLOPE_LINE = generateBreakpoints(0, 8, "flat");
const SLOPE = axis("steepness", "急さ", SLOPE_LINE);
const DENSITY_LINE: Breakpoints = [
  [0, 0],
  [4, 100],
];
const DENSITY = axis("signals", "信号の多さ", DENSITY_LINE);
const HAND_EDITED_LINE: Breakpoints = [
  [0, 0],
  [3, 80],
  [8, 100],
];
const HAND_EDITED = axis("hand_edited", "手で動かした軸", HAND_EDITED_LINE);
const SIGNED = axis("gradient", "勾配", SLOPE_LINE);
const SURFACE_MAPPING = { asphalt: 10, gravel: 50 };
const CATEGORICAL = axis("surface", "路面", [], {
  shape: { kind: "categorical", material: "surface", mapping: SURFACE_MAPPING },
});
/** 値を持つ道の延長のうち、対応表に無い値（未舗装）が2割を占める。 */
const SURFACE_SHARES = [
  { value: "asphalt", label: "舗装", share: 0.5 },
  { value: "gravel", label: "砂利", share: 0.3 },
  { value: "unpaved", label: "未舗装", share: 0.2 },
];

/** 分布の2つの階級（代表値1と3）に、保存済みの線は10点・50点を、ほかの線は50点・90点を付ける代役。 */
const BINS: [number, number, number][] = [
  [0, 2, 0.5],
  [2, 4, 0.5],
];
const SAVED_SCORES = [10, 50];
const DRAFT_SCORES = [50, 90];

let updated: SentRequest[];
const SAVED_LINES = [SLOPE_LINE, DENSITY_LINE, HAND_EDITED_LINE].map((line) => JSON.stringify(line));

beforeEach(() => {
  updated = onSameOrigin("PUT", "/admin/api/axis-definitions/:axisId", ({ body }) => Response.json(body));
  onSameOrigin("GET", "/admin/api/material-catalog/:materialId/value-shares", () =>
    Response.json({ available: true, sample_ways: 10, total_km: 5, values: SURFACE_SHARES }),
  );
  onSameOrigin("POST", "/admin/api/axis-definitions/preview-distribution", () =>
    Response.json({ sample_ways: 2, total_km: 2, quantiles: {}, bins: BINS }),
  );
  onSameOrigin("POST", "/admin/api/axis-definitions/preview-scores", ({ body }) => {
    const { shape } = body as { shape: { breakpoints: Breakpoints } };
    const saved = SAVED_LINES.includes(JSON.stringify(shape.breakpoints));
    return Response.json({ scores: saved ? SAVED_SCORES : DRAFT_SCORES });
  });
  onSameOrigin("POST", "/admin/api/axis-definitions/preview-calibration", ({ body }) => {
    const { definition } = body as { definition: AxisDefinitionPayload };
    const thresholds = definition.display_thresholds_override ?? [...DEFAULT_DIFFICULTY_BOUNDARIES];
    const signed = definition.axis_id === SIGNED.axis_id;
    return Response.json({
      map_paint: {
        value: signed ? { kind: "signed_material", material: "speed_limit" } : { kind: "difficulty" },
        unit: "",
        thresholds,
        legend: { boundaries: thresholds, unit: signed ? "%" : null },
        band_labels: null,
      },
      averages_density: definition.axis_id === DENSITY.axis_id,
    });
  });
});

const NO_MAP = () => null;

async function openAxis(def: AxisDefinitionResponse) {
  const user = userEvent.setup();
  const onSaved = vi.fn(async () => {});
  render(<AxisCalibration definition={def} onSaved={onSaved} calibrationMap={NO_MAP} />);
  await screen.findByRole("img");
  return { user, onSaved };
}

const saveButton = () => screen.getByRole("button", { name: "保存する" });

async function savedPayload(): Promise<AxisDefinitionPayload> {
  await waitFor(() => expect(updated).toHaveLength(1));
  return updated[0].body as AxisDefinitionPayload;
}

describe("線を決めて保存する", () => {
  it("数の入力で100点にする値を変えると、その値で作った線を、公開の状態と応答だけの欄を除いた定義で保存し、知らせる", async () => {
    const { user, onSaved } = await openAxis(SLOPE);
    expect(saveButton()).toBeDisabled();

    const hundred = screen.getByRole("spinbutton", { name: "100点にする値" });
    await user.clear(hundred);
    await user.type(hundred, "6");
    await user.click(saveButton());

    const payload = await savedPayload();
    expect(updated[0].path).toBe(`/admin/api/axis-definitions/${SLOPE.axis_id}`);
    expect(payload.shape).toEqual({ ...SLOPE.shape, breakpoints: generateBreakpoints(0, 6, "flat") });
    expect(payload.is_published).toBe(true);
    expect(payload).not.toHaveProperty("weight_share_when_published");
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("グラフの端は横にだけ動き、動かした値で作った線を保存する。動かす前の線は灰色で重ね、元に戻すと消す", async () => {
    const { user } = await openAxis(SLOPE);
    expect(screen.queryByLabelText("保存済みの線")).not.toBeInTheDocument();
    const end = screen.getByRole("slider", { name: "100点の端" });
    expect(screen.getByRole("slider", { name: "0点の端" })).toBeInTheDocument();

    fireEvent.keyDown(end, { key: "ArrowUp" });
    expect(saveButton()).toBeDisabled();
    fireEvent.keyDown(end, { key: "ArrowRight" });
    const moved = Number(screen.getByRole("slider", { name: "100点の端" }).getAttribute("aria-valuenow"));
    expect(moved).toBeGreaterThan(8);
    expect(screen.getByLabelText("保存済みの線")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "元に戻す" }));
    expect(screen.queryByLabelText("保存済みの線")).not.toBeInTheDocument();
    expect(saveButton()).toBeDisabled();

    fireEvent.keyDown(screen.getByRole("slider", { name: "100点の端" }), { key: "ArrowRight" });
    await user.click(saveButton());
    expect((await savedPayload()).shape).toEqual({
      ...SLOPE.shape,
      breakpoints: generateBreakpoints(0, moved, "flat"),
    });
  });

  it("0点の端を100点の端の向こうへ動かしても、つかんだ取っ手は0点の端のまま動き続ける", async () => {
    await openAxis(SLOPE);
    const zeroEnd = screen.getByRole("slider", { name: "0点の端" });
    const zeroInput = screen.getByRole("spinbutton", { name: "0点にする値" });
    const hundredInput = screen.getByRole("spinbutton", { name: "100点にする値" });

    // 保存済みの線は0〜8で、Shiftつきの1回は8より小さく、2回で8を越える。
    fireEvent.keyDown(zeroEnd, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(zeroEnd, { key: "ArrowRight", shiftKey: true });
    const crossed = Number((zeroInput as HTMLInputElement).value);
    expect(crossed).toBeGreaterThan(8);
    expect(zeroEnd).toHaveAccessibleName("0点の端");

    fireEvent.keyDown(zeroEnd, { key: "ArrowRight" });
    expect(Number((zeroInput as HTMLInputElement).value)).toBeGreaterThan(crossed);
    expect(hundredInput).toHaveValue(8);
  });

  it("0点と100点を同じ値にすると、そう言って保存させない", async () => {
    const { user } = await openAxis(SLOPE);
    const hundred = screen.getByRole("spinbutton", { name: "100点にする値" });
    await user.clear(hundred);
    await user.type(hundred, "0");
    expect(screen.getByText("0点にする値と100点にする値を別の値にしてください。")).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it("密度の軸は100点にする値だけを決め、0点の端は動かせず点も足せない。保存する線は0から伸びる直線", async () => {
    const { user } = await openAxis(DENSITY);
    await screen.findByRole("slider", { name: "100点の端" });
    expect(screen.queryByRole("slider", { name: "0点の端" })).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "0点にする値" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "効き方" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /折れ点を追加/ })).not.toBeInTheDocument();

    const hundred = screen.getByRole("spinbutton", { name: "100点にする値" });
    await user.clear(hundred);
    await user.type(hundred, "2.5");
    await user.click(saveButton());
    expect((await savedPayload()).shape).toEqual({
      ...DENSITY.shape,
      breakpoints: [
        [0, 0],
        [2.5, 100],
      ],
    });
  });

  it("保存済みの線が3つの入力で作れない形なら、置き換わることを言い、そのままでも保存できる", async () => {
    await openAxis(HAND_EDITED);
    expect(screen.getByText(/保存すると、上の値で作った線に置き換わります/)).toBeInTheDocument();
    expect(screen.getByLabelText("保存済みの線")).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it("密度の軸でも、保存済みの線が0から伸びる直線でなければ、置き換わることを言う", async () => {
    const edited = axis(DENSITY.axis_id, DENSITY.label, HAND_EDITED_LINE);
    await openAxis(edited, [edited]);
    expect(await screen.findByText(/保存すると、上の値で作った線に置き換わります/)).toBeInTheDocument();
    expect(screen.getByLabelText("保存済みの線")).toBeInTheDocument();
  });

  it("保存に失敗したら、backendの理由をそのまま出す", async () => {
    onSameOrigin("PUT", "/admin/api/axis-definitions/:axisId", () =>
      Response.json({ detail: "折れ点が昇順ではありません" }, { status: 422 }),
    );
    const { user, onSaved } = await openAxis(SLOPE);
    fireEvent.keyDown(screen.getByRole("slider", { name: "100点の端" }), { key: "ArrowRight" });
    await user.click(saveButton());
    expect(await screen.findByText("折れ点が昇順ではありません")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe("地図の段の境界", () => {
  it("グラフの境界を上下に動かすと、隣の境界の内側に収めて入力欄へ出し、その境界で保存する", async () => {
    const { user } = await openAxis(SLOPE);
    const [low, high] = DEFAULT_DIFFICULTY_BOUNDARIES;
    const first = await screen.findByRole("slider", { name: "段の境界1" });
    fireEvent.keyDown(first, { key: "ArrowUp" });
    expect(screen.getByRole("textbox", { name: "段の境界" })).toHaveValue(`${low + 1}, ${high}`);

    for (let i = 0; i < 10; i++)
      fireEvent.keyDown(screen.getByRole("slider", { name: "段の境界1" }), { key: "ArrowUp", shiftKey: true });
    expect(screen.getByRole("textbox", { name: "段の境界" })).toHaveValue(`${high - 1}, ${high}`);

    await user.click(saveButton());
    expect((await savedPayload()).display_thresholds_override).toEqual([high - 1, high]);
  });

  it("隣の境界との間が狭く、動かすと隣と重なるときは動かさない", async () => {
    const narrow = axis(SLOPE.axis_id, SLOPE.label, SLOPE_LINE, { display_thresholds_override: [10, 10.5, 11] });
    await openAxis(narrow, [narrow]);
    const middle = await screen.findByRole("slider", { name: "段の境界2" });
    fireEvent.keyDown(middle, { key: "ArrowUp" });
    fireEvent.keyDown(screen.getByRole("slider", { name: "段の境界2" }), { key: "ArrowDown" });
    expect(screen.getByRole("textbox", { name: "段の境界" })).toHaveValue("10, 10.5, 11");
  });

  it("数の入力でも境界を決めて保存でき、「自動に戻す」で上書きを外す", async () => {
    const { user } = await openAxis(SLOPE);
    const field = screen.getByRole("textbox", { name: "段の境界" });
    await user.type(field, "20, 70");
    expect(await screen.findByRole("slider", { name: "段の境界2" })).toHaveAttribute("aria-valuenow", "70");

    await user.click(screen.getByRole("button", { name: "境界を自動に戻す" }));
    expect(field).toHaveValue("");
    expect(saveButton()).toBeDisabled();

    await user.type(field, "20, 70");
    await user.click(saveButton());
    expect((await savedPayload()).display_thresholds_override).toEqual([20, 70]);
  });

  it("数として読めない境界は理由を出し、保存させない", async () => {
    const { user } = await openAxis(SLOPE);
    await user.type(screen.getByRole("textbox", { name: "段の境界" }), "20, x");
    expect(screen.getByText("数値として読めない値があります: x")).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it("材料の値で塗る軸は、境界をグラフに重ねず、そう断る", async () => {
    await openAxis(SIGNED);
    expect(screen.getByText(/段の境界は材料の値です/)).toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: "段の境界1" })).not.toBeInTheDocument();
  });
});

describe("段ごとの延長", () => {
  it("下書きと公開中の線それぞれで、地図の段ごとの延長の割合を並べる", async () => {
    await openAxis(SLOPE);
    fireEvent.keyDown(screen.getByRole("slider", { name: "100点の端" }), { key: "ArrowRight" });
    const shares = (title: string) =>
      within(screen.getByRole("group", { name: title }))
        .getAllByText(/%$/)
        .map((cell) => cell.textContent);
    // 保存済みは10点・50点、下書きは50点・90点で、既定の境界の段（低・中・高）へ半分ずつ入る。
    await waitFor(() => expect(shares("下書き")).toEqual(["0.0%", "50.0%", "50.0%"]));
    await waitFor(() => expect(shares("公開中")).toEqual(["50.0%", "50.0%", "0.0%"]));
  });
});

describe("対応表の軸", () => {
  async function openCategorical() {
    const user = userEvent.setup();
    const onSaved = vi.fn(async () => {});
    render(<AxisCalibration definition={CATEGORICAL} onSaved={onSaved} calibrationMap={NO_MAP} />);
    const rows = await screen.findByRole("region", { name: "種類ごとの点数" });
    return { user, onSaved, rows };
  }
  const percents = (container: HTMLElement) =>
    within(container)
      .getAllByText(/%$/)
      .map((cell) => cell.textContent);
  const bandShares = (title: string) => percents(screen.getByRole("group", { name: title }));

  it("種類ごとに点数と延長の割合を並べ、対応表に無い値の道の割合も1行で出す", async () => {
    const { rows } = await openCategorical();
    expect(within(rows).getByRole("spinbutton", { name: "舗装の点数" })).toHaveValue(10);
    expect(within(rows).getByRole("spinbutton", { name: "砂利の点数" })).toHaveValue(50);
    await waitFor(() => expect(percents(rows)).toEqual(["50.0%", "30.0%", "20.0%"]));
    expect(within(rows).getByText("対応表に無い値（評価しない）")).toBeInTheDocument();
  });

  it("点数を変えると、点数の付く道の延長で割った段ごとの延長を下書きと公開中で並べ、点数と境界を保存する", async () => {
    const { user, onSaved } = await openCategorical();
    // 公開中は舗装10点・砂利50点で低い段と中の段へ、下書きは舗装を90点にして高い段へ移る（未舗装の2割は数えない）。
    await waitFor(() => expect(bandShares("公開中")).toEqual(["62.5%", "37.5%", "0.0%"]));
    const asphalt = screen.getByRole("spinbutton", { name: "舗装の点数" });
    await user.clear(asphalt);
    await user.type(asphalt, "90");
    await waitFor(() => expect(bandShares("下書き")).toEqual(["0.0%", "37.5%", "62.5%"]));

    await user.type(screen.getByRole("textbox", { name: "段の境界" }), "20, 70");
    await user.click(saveButton());
    const payload = await savedPayload();
    expect(payload.shape).toEqual({ kind: "categorical", material: "surface", mapping: { asphalt: 90, gravel: 50 } });
    expect(payload.display_thresholds_override).toEqual([20, 70]);
    expect(payload).not.toHaveProperty("weight_share_when_published");
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("元に戻すと、点数も境界も保存済みへ戻り、保存できなくなる", async () => {
    const { user } = await openCategorical();
    const asphalt = screen.getByRole("spinbutton", { name: "舗装の点数" });
    await user.clear(asphalt);
    await user.type(asphalt, "90");
    const field = screen.getByRole("textbox", { name: "段の境界" });
    await user.type(field, "20, 70");
    expect(saveButton()).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "元に戻す" }));
    expect(asphalt).toHaveValue(10);
    expect(field).toHaveValue("");
    expect(saveButton()).toBeDisabled();
  });
});
