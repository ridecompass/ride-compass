/**
 * `RoadInspectorPopup.tsx`——開いたら道の負担を取りに行き、地図が塗る向きの区間の合計・負担のある軸ごとの秒と、切り替えで元の事実を出すこと。
 *
 * ここで見ないもの:
 * - 負担を利用者のいまの値で取りに行くこと → 受けた値をそのまま取得の口へ渡す1行の委譲（testing.md「そのテストは
 *   要るか」の1問目）。値を要求の項目へ載せることは`features/map/regionApi.test.ts`が見る
 * - 利用者の値・走行の条件が変わったときに負担を取り直すか → `RoadInspectorPopup.refetch.test.tsx`
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { onBackend, serveCostAxisCatalog } from "@/testing/backendServer";
import { setDebugEnabled } from "@/lib/debugLog";
import { inspectorResult, lensDirection, RIDE, serveInspector } from "@/testing/roadInspector";
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
  it.each([
    ["名前のある道は名前と要約", { ...SURFACED_ROAD, name: "明治通り" }, `明治通り${SURFACE_LABEL}`],
    // 地図の道の色の凡例の名前（「データなし」等）で呼ぶと、道の名前と読み違える。
    ["名前の無い道は要約だけ", SURFACED_ROAD, SURFACE_LABEL],
  ])("上の帯は、%s", (_, properties, header) => {
    serveInspector(inspectorResult());
    render(
      <RoadInspectorPopup
        properties={properties}
        track={{ key: "residential", label: "住宅街の道", color: "#123456" }}
        {...RIDE}
      />,
    );

    expect(screen.getByRole("group", { name: "道の小窓の上の帯" }).textContent).toBe(header);
  });

  it("開いたら負担を取りに行き、地図が塗る向きの区間の合計と負担のある軸ごとの秒を出し、「換算前」に切り替えると軸ごとの元の事実を出す", async () => {
    const user = userEvent.setup();
    const direction = (climb: number) =>
      lensDirection(7, {
        axes: [
          { axis_id: "ascent", seconds: 4.4 },
          { axis_id: "friction", seconds: 2 },
          { axis_id: "headwind", seconds: 0.6 },
          { axis_id: "vibration", seconds: 0 },
        ],
        // 区分の事実は値を持たず、区分の名前だけを出す。求められない事実（風を読めないときの向かい風）は届かない。
        facts: {
          ascent: { label: "登り", value: climb, unit: "m" },
          friction: { label: "砂利", value: null, unit: "" },
        },
      });
    serveInspector(
      inspectorResult({ painted: "against", along: direction(12), against: direction(0) }),
      costAxisCatalog(
        costAxisEntry("ascent", { label: "登坂" }),
        costAxisEntry("friction", { label: "摩擦" }),
        costAxisEntry("headwind", { label: "向かい風" }),
        costAxisEntry("vibration", { label: "振動" }),
      ),
    );
    renderPopup();
    expect(screen.getByText("負担を読み込んでいます")).toBeInTheDocument();
    const breakdown = async () => screen.findByRole("group", { name: "負担の内訳" });

    // 軸は絵で出し、名前は読み上げに残す。負担の無い軸は出さない。
    expect(await breakdown()).toHaveTextContent(/^負担 \+7秒登坂\+4秒摩擦\+2秒向かい風\+1秒$/);
    expect(screen.getByText("逆向き")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "換算前" }));
    expect(await breakdown()).toHaveTextContent(/^登坂登り 0m摩擦砂利$/);
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

describe("負担を取れなかったとき", () => {
  it("取れなかったと出し、再試行で取り直す（開いたままで止まらない）", async () => {
    const user = userEvent.setup();
    serveCostAxisCatalog();
    let answered = 0;
    onBackend("POST", "/api/region/road-inspector", () =>
      answered++ === 0 ? new HttpResponse(null, { status: 500 }) : Response.json(inspectorResult()),
    );
    renderPopup();

    await user.click(await screen.findByRole("button", { name: "再試行" }));

    expect(await screen.findByRole("group", { name: "負担の内訳" })).toHaveTextContent("+12秒");
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
