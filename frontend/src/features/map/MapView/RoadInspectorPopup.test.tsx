/**
 * `RoadInspectorPopup.tsx`——押した道の負担を取りに行き、地図が塗る向きの総合・軸ごとの秒と元の事実を出すこと。
 *
 * ここで見ないもの:
 * - 負担を利用者のいまの値で取りに行くこと → 受けた値をそのまま取得の口へ渡す1行の委譲（testing.md「そのテストは
 *   要るか」の1問目）。値を要求の項目へ載せることは`features/map/regionApi.test.ts`が見る
 * - 利用者の値・走行の条件が変わったときに負担を取り直すか → `RoadInspectorPopup.refetch.test.tsx`
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { setDebugEnabled } from "@/lib/debugLog";
import { inspectorResult, lensDirection, openInspection, RIDE, serveInspector } from "@/testing/roadInspector";
import { costAxisCatalog, costAxisEntry } from "@/testing/costAxes";
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
  return render(<RoadInspectorPopup properties={properties} track={null} {...RIDE} />);
}

describe("RoadInspectorPopup", () => {
  it("上の帯に地図の道の種類の名前と路面を出し、負担は押したときに取りに行く（クリックのたびに引かない）", () => {
    render(
      <RoadInspectorPopup
        properties={SURFACED_ROAD}
        track={{ key: "residential", label: "住宅街の道", color: "#123456" }}
        {...RIDE}
      />,
    );

    // 名前の無い道は、地図の道の色の凡例の名前で呼ぶ。
    const header = within(screen.getByRole("group", { name: "道の小窓の上の帯" }));
    expect(header.getByText("住宅街の道")).toBeInTheDocument();
    expect(header.getByText(SURFACE_LABEL)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "この道の負担を見る" })).toBeInTheDocument();
    expect(screen.queryByText(/秒\/km/)).not.toBeInTheDocument();
  });

  it("費用の軸のレンズの値が届いたら、地図が塗る向きの総合と軸ごとの1kmあたりの代償の秒と、その元の事実を出す", async () => {
    const user = userEvent.setup();
    const direction = (total: number, climb: number) =>
      lensDirection(total, {
        axes: [{ axis_id: "ascent", seconds_per_km: total }],
        // 事実は名前と単位つきで届き、値の無い事実は届かない。
        facts: [
          { label: "一番急な登り", value: climb, unit: "%" },
          { label: "向かい風", value: 1.5, unit: "m/s" },
          { label: "止まる回数", value: 2, unit: "回/km" },
        ],
      });
    serveInspector(
      inspectorResult({ painted: "against", along: direction(30, 12), against: direction(4, 0), surface: "舗装" }),
      costAxisCatalog(costAxisEntry("ascent", { label: "登坂" })),
    );
    renderPopup();

    await openInspection(user);

    expect(await screen.findByText("総合の負担 4秒/km")).toBeInTheDocument();
    expect(screen.getByText("逆向き")).toBeInTheDocument();
    const rows = screen.getAllByRole("term").map((term) => `${term.textContent}:${term.nextSibling?.textContent}`);
    expect(rows).toEqual(
      expect.arrayContaining(["登坂:4秒/km", "一番急な登り:0%", "向かい風:1.5m/s", "止まる回数:2回/km", "路面:舗装"]),
    );
  });

  it("道に名前があれば、上の帯は名前で呼ぶ", () => {
    renderPopup({ ...SURFACED_ROAD, name: "明治通り" });

    expect(within(screen.getByRole("group", { name: "道の小窓の上の帯" })).getByText("明治通り")).toBeInTheDocument();
  });

  it("属性は畳み、日本語の値だけを項目ごとに1度出し、英語の生の値と登録外のタグは「その他のタグ」にさらに畳む", async () => {
    const user = userEvent.setup();
    serveInspector({ ...inspectorResult(), tags: { surface: SURFACE_VALUE, lit: "yes", name: "明治通り" } });
    renderPopup();

    const attributes = screen.getByText("この道の属性").closest("details")!;
    expect(screen.getByText(SURFACE.name)).not.toBeVisible();
    // 畳みを開くと、負担を取る前からタイルの事実が読める。
    await user.click(screen.getByText("この道の属性"));
    expect(screen.getByText(SURFACE.name)).toBeVisible();
    await openInspection(user);

    const others = (await screen.findByText("その他のタグ")).closest("details")!;
    // 道路種別は負担と一緒に届き、対訳で出す。タイルとタグの両方が持つ路面は1度だけ。
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
