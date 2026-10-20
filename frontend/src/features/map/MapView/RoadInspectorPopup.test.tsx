/**
 * `RoadInspectorPopup.tsx`——押した道の評価を取りに行き、軸ごとの効き方を出すこと。
 *
 * ここで見ないもの:
 * - 評価を利用者のいまの重みで取りに行くこと → 受けた重みをそのまま取得の口へ渡す1行の委譲（testing.md「そのテストは
 *   要るか」の1問目）。重みを要求の項目へ載せることは`features/map/regionApi.test.ts`が見る
 * - 重み・走行の条件が変わったときに評価を取り直すか → `RoadInspectorPopup.refetch.test.tsx`
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { setDebugEnabled } from "@/lib/debugLog";
import { AXES, AXIS_COLORS, inspectorResult, openEvaluation, RIDE, serveInspector } from "@/testing/roadInspector";
import materialCatalog from "@/types/generated/material-catalog.json";
import RoadInspectorPopup from "./RoadInspectorPopup";
import type { RoadSurfacePopupProperties } from "./roadFacts";

/** 路面の種類の項目名と、呼び名を持つ値の1つ（書き写さず材料カタログから引く）。 */
const SURFACE = materialCatalog.find((material) => material.material_id === "surface")!;
const [SURFACE_VALUE] = Object.entries(SURFACE.value_labels ?? {}).find(
  (entry): entry is [string, string] => typeof entry[1] === "string",
)!;

/** 路面の種類を持つ1本の道。 */
const SURFACED_ROAD: RoadSurfacePopupProperties = {
  osm_way_id: 1,
  feature_key: "1",
  surface: SURFACE_VALUE,
};

function renderPopup(properties: RoadSurfacePopupProperties = SURFACED_ROAD) {
  return render(<RoadInspectorPopup properties={properties} axes={AXES} axisColors={AXIS_COLORS} {...RIDE} />);
}

/** 窓の中の、押した区間の評価と道1本の評価のまとまり。 */
const segmentRegion = () => screen.getByRole("region", { name: "押した区間" });
const wayRegion = () => screen.getByRole("region", { name: "この道全体" });

describe("RoadInspectorPopup", () => {
  it("周囲の土地被覆は畳んでおき、閉じている間は最も多いクラスだけを見せる", async () => {
    const user = userEvent.setup();
    serveInspector(inspectorResult());
    renderPopup();

    await openEvaluation(user);

    // 閉じている間は要約だけを見せる。走行中のスマホが主用途のため、既定で行を並べない
    // （`details`は閉じていても子をDOMへ残すため、存在ではなく見えるかで確かめる）。
    await screen.findByText("この道全体");
    const way = within(wayRegion());
    const summary = way.getByText("周囲の土地被覆: 建物 50%");
    expect(way.getByText("農地")).not.toBeVisible();

    await user.click(summary);

    // 開くと割合の大きい順。0%のクラス（水面・湿地・裸地・雪氷・草地）は行自体を作らない。
    expect(way.getByText("農地")).toBeVisible();
    expect(way.getByText("樹木")).toBeVisible();
    expect(way.queryByText("水面")).not.toBeInTheDocument();
  });

  it("事実だけを先に出し、評価は押したときに取りに行く（クリックのたびに引かない）", () => {
    renderPopup({ ...SURFACED_ROAD, name: "明治通り" });

    expect(screen.getByText("明治通り")).toBeInTheDocument();
    const inspect = screen.getByRole("button", { name: "この道の評価を見る" });
    expect(inspect).toHaveTextContent(/^$/);
    expect(inspect.querySelector("svg")).not.toBeNull();
  });

  it("評価はルート結果と同じ寄与度で出し、算出できない軸は並べない", async () => {
    const user = userEvent.setup();
    serveInspector(inspectorResult());
    renderPopup();

    await openEvaluation(user);

    await screen.findByText("この道全体");
    const way = within(wayRegion());
    // 寄与度バーの凡例は軸アイコン＋値（ルート結果と同じ部品）。
    expect(way.getByText("30.0")).toBeInTheDocument();
    expect(way.getByText("10.0")).toBeInTheDocument();
    // チップから開く詳細は、その軸の難易度をルート結果と同じ桁で出す。
    await user.click(way.getByRole("button", { name: "見本の軸の詳細を表示" }));
    expect(screen.getByText("この評価軸の難易度 57.8/100")).toBeInTheDocument();
    // この道に値の出ない軸（勾配）はそもそも並ばない。
    expect(way.queryByLabelText("勾配の詳細を表示")).not.toBeInTheDocument();
  });

  it("押した区間の値と、その区間を含む道1本の値を、どちらの値かが分かる見出しの下に並べて出す", async () => {
    const user = userEvent.setup();
    serveInspector(inspectorResult());
    renderPopup();

    await openEvaluation(user);

    await screen.findByText("押した区間");
    const segment = within(segmentRegion());
    const way = within(wayRegion());
    // 区間は寄せた地図の色、道1本は引いた地図の色と同じ値なので、取り違えると地図の色と窓の値が食い違う。
    expect(segment.getByText("45.0")).toBeInTheDocument();
    expect(segment.getByText("この区間で見た難易度: 48.0/100")).toBeInTheDocument();
    expect(segment.getByText("周囲の土地被覆: 樹木 70%")).toBeInTheDocument();
    expect(way.getByText("30.0")).toBeInTheDocument();
    expect(way.getByText(/この道全体で見た難易度: 40\.0\/100/)).toBeInTheDocument();
    expect(way.getByText("周囲の土地被覆: 建物 50%")).toBeInTheDocument();
  });

  it("どの軸の寄与も0の道では、帯の代わりに値を出せる軸が無いと案内する（空の欄にしない）", async () => {
    const user = userEvent.setup();
    serveInspector(
      inspectorResult({
        axes: [
          { axis_id: "axis_sample", difficulty: 0, contribution: 0 },
          { axis_id: "night", difficulty: 0, contribution: 0 },
        ],
      }),
    );
    renderPopup();

    await openEvaluation(user);

    expect(await screen.findByText("この道全体で値を出せる評価軸がありません。")).toBeInTheDocument();
  });

  it("合成は注記として出す（実際の探索コストとは一致しないため主役にしない）", async () => {
    const user = userEvent.setup();
    serveInspector(inspectorResult());
    renderPopup();

    await openEvaluation(user);

    expect(await screen.findByText(/この道全体で見た難易度: 40\.0\/100/)).toBeInTheDocument();
    expect(screen.getByText(/重みの約80%ぶんの評価軸だけ。残りの評価軸は、この道全体と/)).toBeInTheDocument();
  });

  it("出す割合が100%に丸まるなら、一部の軸だけだという注記を添えない", async () => {
    const user = userEvent.setup();
    serveInspector(inspectorResult({ composite_difficulty: { value: 40, covered_weight_fraction: 0.996 } }));
    renderPopup();

    await openEvaluation(user);

    expect(await screen.findByText(/この道全体で見た難易度: 40\.0\/100/)).toBeInTheDocument();
    expect(screen.queryByText(/重みの約/)).not.toBeInTheDocument();
  });

  it("カタログ外の生タグは畳んで置く（数が読めないため、開いたときだけ縦に伸ばす）", async () => {
    const user = userEvent.setup();
    serveInspector(inspectorResult());
    renderPopup();

    await openEvaluation(user);

    await waitFor(() => expect(screen.getByText("その他のタグ")).toBeInTheDocument());
    // 生タグは属性の中でさらに畳む。登録済みの属性（lit）は属性の畳みの中に直接並ぶ。
    const others = screen.getByText("その他のタグ").closest("details");
    expect(others?.textContent).toContain("明治通り");
    expect(others?.textContent).not.toContain("yes");
  });

  it("属性は畳んでおき、タイルとタグの両方が持つ項目は1度だけ出す", async () => {
    const user = userEvent.setup();
    serveInspector({ ...inspectorResult(), tags: { highway: "residential", lit: "yes" } });
    renderPopup();

    const attributes = screen.getByText("この道の属性").closest("details");
    expect(screen.getByText(SURFACE.name)).not.toBeVisible();
    // 畳みを開くと、評価を取る前からタイルの事実が読める。
    await user.click(screen.getByText("この道の属性"));
    expect(screen.getByText(SURFACE.name)).toBeVisible();
    await openEvaluation(user);

    await waitFor(() => expect(screen.getByText("residential")).toBeInTheDocument());
    const labels = Array.from(attributes?.querySelectorAll("dt") ?? []).map((dt) => dt.textContent);
    expect(labels.length).toBeGreaterThan(1);
    expect(new Set(labels).size).toBe(labels.length);
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
