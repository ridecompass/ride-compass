/**
 * `RoadInspectorPopup.tsx`——押した道の評価を取りに行き、軸ごとの効き方を出すこと。
 *
 * ここで見ないもの:
 * - 評価を利用者のいまの重みで取りに行くこと → 受けた重みをそのまま取得の口へ渡す1行の委譲（testing.md「そのテストは
 *   要るか」の1問目）。重みを要求の項目へ載せることは`features/map/regionApi.test.ts`が見る
 * - 重み・走行の条件が変わったときに評価を取り直すか → `RoadInspectorPopup.refetch.test.tsx`
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { setDebugEnabled } from "@/lib/debugLog";
import { AXES, AXIS_COLORS, inspectorResult, openEvaluation, RIDE, serveInspector } from "@/testing/roadInspector";
import materialCatalog from "@/types/generated/material-catalog.json";
import RoadInspectorPopup from "./RoadInspectorPopup";
import type { RoadSurfacePopupProperties } from "./roadFacts";

/** 路面の種類の項目名と、呼び名を持つ値の1つ（書き写さず材料カタログから引く）。 */
const SURFACE = materialCatalog.find((material) => material.material_id === "surface")!;
const [SURFACE_VALUE, SURFACE_LABEL] = Object.entries(SURFACE.value_labels ?? {}).find(
  (entry): entry is [string, string] => typeof entry[1] === "string",
)!;

/** 路面の種類を持つ1本の道。 */
const SURFACED_ROAD: RoadSurfacePopupProperties = {
  osm_way_id: 1,
  feature_key: "1",
  surface: SURFACE_VALUE,
};

function renderPopup(properties: RoadSurfacePopupProperties = SURFACED_ROAD) {
  return render(
    <RoadInspectorPopup properties={properties} track={null} axes={AXES} axisColors={AXIS_COLORS} {...RIDE} />,
  );
}

describe("RoadInspectorPopup", () => {
  it("上の帯に地図の道の種類の名前と路面を出し、評価は押したときに取りに行く（クリックのたびに引かない）", () => {
    render(
      <RoadInspectorPopup
        properties={SURFACED_ROAD}
        track={{ key: "residential", label: "住宅街の道", color: "#123456" }}
        axes={AXES}
        axisColors={AXIS_COLORS}
        {...RIDE}
      />,
    );

    // 名前の無い道は、地図の道の色の凡例の名前で呼ぶ。
    const header = within(screen.getByRole("group", { name: "道の小窓の上の帯" }));
    expect(header.getByText("住宅街の道")).toBeInTheDocument();
    expect(header.getByText(SURFACE_LABEL)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "この道の評価を見る" })).toBeInTheDocument();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("道に名前があれば、上の帯は名前で呼ぶ", () => {
    renderPopup({ ...SURFACED_ROAD, name: "明治通り" });

    expect(within(screen.getByRole("group", { name: "道の小窓の上の帯" })).getByText("明治通り")).toBeInTheDocument();
  });

  it("押した物の難易度の塊を出し、土地被覆は最も多いクラスのチップにする", async () => {
    const user = userEvent.setup();
    serveInspector(inspectorResult());
    renderPopup();

    await openEvaluation(user);

    // 押した物（その倍率で地図が塗る区間か道1本）の値なので、地図の線の色と窓の値が一致する。
    const pressed = within(await screen.findByRole("region", { name: "難易度" }));
    expect(screen.getByRole("region", { name: "難易度" })).toHaveTextContent("難易度40.0/100");
    expect(pressed.getByText("30.0")).toBeInTheDocument();

    // チップを押すと割合の大きい順に開く。0%のクラス（水面・湿地・裸地・雪氷・草地）は行自体を作らない。
    await user.click(pressed.getByRole("button", { name: "周囲の土地被覆（建物 50%）の内訳を表示" }));
    const breakdown = within(screen.getByText("周囲の土地被覆").parentElement!);
    expect(breakdown.getAllByRole("term").map((term) => term.textContent)).toEqual(["建物", "農地", "樹木"]);
  });

  it("評価はルート結果と同じ寄与度で出し、算出できない軸は並べない", async () => {
    const user = userEvent.setup();
    serveInspector(inspectorResult());
    renderPopup();

    await openEvaluation(user);

    const way = within(await screen.findByRole("region", { name: "難易度" }));
    // チップから開く詳細は、その軸の難易度をルート結果と同じ桁で出す。
    await user.click(way.getByRole("button", { name: "見本の軸の詳細を表示" }));
    expect(screen.getByText("この評価軸の難易度 57.8/100")).toBeInTheDocument();
    // この道に値の出ない軸（勾配）はそもそも並ばない。
    expect(way.queryByLabelText("勾配の詳細を表示")).not.toBeInTheDocument();
  });

  it("どの軸の寄与も0の道では、帯の代わりにどの軸も0だと言う（空の欄にしない）", async () => {
    const user = userEvent.setup();
    serveInspector(
      inspectorResult({
        axes: [
          { axis_id: "axis_sample", difficulty: 0, contribution: 0 },
          { axis_id: "night", difficulty: 0, contribution: 0 },
        ],
        composite_difficulty: { value: 0, covered_weight_fraction: 1 },
      }),
    );
    renderPopup();

    await openEvaluation(user);

    const way = within(await screen.findByRole("region", { name: "難易度" }));
    expect(way.getByText("どの評価軸も0（易しい）")).toBeInTheDocument();
  });

  it.each([
    [0.8, ["重みの約80%ぶんの評価軸だけ（残りはこの走る条件で値が出せません）"]],
    [0.996, []],
  ])("合成に使えた重みの割合が%sなら、添える断りは%j（100%に丸まるなら添えない）", async (covered, notes) => {
    const user = userEvent.setup();
    serveInspector(inspectorResult({ composite_difficulty: { value: 40, covered_weight_fraction: covered } }));
    renderPopup();

    await openEvaluation(user);

    const way = within(await screen.findByRole("region", { name: "難易度" }));
    expect(way.queryAllByText(/^重みの約/).map((note) => note.textContent)).toEqual(notes);
  });

  it("属性は畳み、日本語の値だけを項目ごとに1度出し、英語の生の値と登録外のタグは「その他のタグ」にさらに畳む", async () => {
    const user = userEvent.setup();
    serveInspector({ ...inspectorResult(), tags: { surface: SURFACE_VALUE, lit: "yes", name: "明治通り" } });
    renderPopup();

    const attributes = screen.getByText("この道の属性").closest("details")!;
    expect(screen.getByText(SURFACE.name)).not.toBeVisible();
    // 畳みを開くと、評価を取る前からタイルの事実が読める。
    await user.click(screen.getByText("この道の属性"));
    expect(screen.getByText(SURFACE.name)).toBeVisible();
    await openEvaluation(user);

    const others = (await screen.findByText("その他のタグ")).closest("details")!;
    // 道路種別は評価と一緒に届き、対訳で出す。タイルとタグの両方が持つ路面は1度だけ。
    const facts = attributes.querySelector(":scope > dl")!;
    const labels = Array.from(facts.querySelectorAll("dt")).map((dt) => dt.textContent);
    expect(labels).toContain("道路種別");
    expect(new Set(labels).size).toBe(labels.length);
    expect(facts.textContent).toContain("住宅街の道路");
    expect(facts.textContent).not.toMatch(/residential|yes/);
    expect(others.textContent).toContain("明治通り");
    expect(others.textContent).toContain("yes");
  });
});

describe("道の識別子", () => {
  // 一般の利用者には読めない値なので既定では出さず、デバッグログONなら地図で押した1本をそのままbackendの調査へ渡せるように出す。
  it.each([
    [false, []],
    [true, ["OSM way id: 4242"]],
  ])("デバッグログが%sなら、出すのは%j", (debug, shown) => {
    setDebugEnabled(debug);
    renderPopup({ osm_way_id: 4242 });

    expect(screen.queryAllByText(/OSM way id/).map((element) => element.textContent)).toEqual(shown);
    setDebugEnabled(false);
  });
});
