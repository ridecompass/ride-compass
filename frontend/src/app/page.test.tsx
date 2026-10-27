/**
 * `app/page.tsx`——トップページ。機能（地図・ルートの設定と結果・走行条件・天候）を1つの画面に束ね、機能の間の値を受け渡す。
 * ページの結合テストは場面ごとにファイルを分け、ここはルートを作る流れを見る。地図を押したときに起きることは
 * `app/page.map.test.tsx`、選んだ区間を地図で見ることは`app/page.sectionOnMap.test.tsx`、地図に置く地点は`app/page.places.test.tsx`、区間の乗り換えの編集は`app/page.splice.test.tsx`、
 * 走行モードは`app/page.ride.test.tsx`（見えるもの）と`app/page.rideControl.test.tsx`（操作）、画面の枠
 * （地図の上の操作・ヘッダー・メニュー）は`app/page.layout.test.tsx`、スマホのシートは`app/page.mobile.test.tsx`が見る。
 *
 * 見ること（利用者の操作の流れで、ある機能の変化が別の機能の振る舞いを変える受け渡し）: 「ルート生成」が地図の塗りを添えて
 * 送ること、結果が出たら閉じていた「ルート結果」を開くこと、候補が「ルート結果」と地図の両方へ出て、選んだ候補が地図でも
 * 選ばれ、区間を持つかで周りの塗りが決まること、全消去は確認の窓で「消す」を押してから両方から消えること、候補がある間だけ
 * 条件のずれの印が点き全消去で消えること、走行条件の想定速度・出発時刻が生成と地図の道の詳細へ同じ値で渡ること、
 * 「評価で塗る」の未使用を分ける重み（生成の前はいまの重み・後は使われた重み）、「条件」タブで保存した条件が地図で置いた
 * 出発地を持ち、呼び出すとその出発地から生成すること、前に保存した条件が「保存済み」の「プリセット」に出ること。
 *
 * ここで見ないもの: 子の部品は本物を描き、子が値をどう描くか（一覧の書式・印の色・天候の値）は各部品のテストが見る。
 * 地図の見え方の中身（どのレイヤーをどの色・重なりで描くか・レンズの選択肢・凡例）は地図の側（`features/map/scene/`）の
 * テストが見て、ここでは地図に何が載ったか（線のソースの地物・レイヤーの表示・印）と、地図の操作で何が起きるかだけを見る。
 * 機能の状態の移り変わり（生成の検証と要求の形・候補の並び・地点の置き方・レイヤーと凡例の状態）は各フックのテストが
 * 見る。子へ渡す受け口へフックの関数や値をそのまま渡す所（重み・除外の入力・経由地を地図で動かす・消す・「現在地に戻す」・
 * 保存した条件を呼び出して現在地へ戻す・実行中の「ルート生成」・取り直している間の「現在地に移動」・まとめてレイヤーを消す
 * 操作を押せるか）は1行の委譲なので見ない。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得（`navigator.geolocation`）、地図の描画（`maplibre-gl`）。
 * どれもテスト環境に無いものか、その手前の境界。地図は `@/testing/maplibre` の代役が受けたものを記録し、地図の操作
 * （押す・押した所に描かれている地物）はテストが代役から起こす。
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { heldReplies, onBackend, serveAxisCatalog } from "@/testing/backendServer";
import { catalogEntry, catalogResponse } from "@/testing/catalogAxes";
import {
  FIRST,
  HERE,
  LOOP_CONDITIONS,
  SECOND,
  candidateTabs,
  clickMap,
  confirmClear,
  generate,
  linesOn,
  renderHome,
  routeLinesOnMap,
  section,
  serveHome,
  serveRoadsAt,
  longPressMap,
} from "@/testing/homePage";
import { mapOnScreen } from "@/testing/maplibre";
import type { Coordinates } from "@/types/route";
import type { AxisInspectorResult } from "@/features/map/regionApi";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

let jobs: ReturnType<typeof serveHome>;

beforeEach(() => {
  jobs = serveHome();
});

/** 道の評価の応答（ここでは中身を見ない）。 */
const INSPECTED_ROAD: AxisInspectorResult = {
  highway: "residential",
  tags: {},
  values: { axes: [], composite_difficulty: { value: 40, covered_weight_fraction: 1 }, landcover: null },
};

/** 全部の道路をその軸で塗っているか。 */
function paints(axisId: string): boolean {
  return mapOnScreen().visibleLayerIds().includes(`road-tiles-${axisId}`);
}

describe("ルートを作る", () => {
  it("生成の結果が出たら閉じていた「ルート結果」を開く。候補は一覧と地図に出て、選んだ候補が区間を持つかで周りの塗りが決まる。全消去で両方から消える", async () => {
    const { user } = renderHome();
    await user.click(section("ルート結果"));
    expect(section("ルート結果")).toHaveAttribute("aria-expanded", "false");

    await user.click(screen.getByRole("button", { name: /^評価で塗る: / }));
    await user.click(await screen.findByRole("radio", { name: /軸A/ }));
    await user.click(screen.getByRole("checkbox", { name: "ルート後も周囲の道路を薄く塗る" }));
    await user.keyboard("{Escape}");
    expect(paints("axis_a")).toBe(true);

    const job = heldReplies();
    jobs.answerWith(job.reply);
    await generate(user);
    expect(screen.getByRole("button", { name: "生成中..." })).toBeInTheDocument();

    await job.answer(
      0,
      Response.json({ status: "done", result: { routes: [FIRST, SECOND], conditions: LOOP_CONDITIONS } }),
    );
    await waitFor(() => expect(section("ルート結果")).toHaveAttribute("aria-expanded", "true"));
    expect(candidateTabs()).toHaveLength(2);
    expect(routeLinesOnMap()).toHaveLength(2);
    expect(routeLinesOnMap()).toEqual(
      expect.arrayContaining([FIRST.geometry.coordinates, SECOND.geometry.coordinates]),
    );
    expect(linesOn("route-selected")).toEqual([FIRST.geometry.coordinates]);
    expect(paints("axis_a")).toBe(false);

    await user.click(candidateTabs()[1]);
    expect(linesOn("route-selected")).toEqual([SECOND.geometry.coordinates]);
    expect(paints("axis_a")).toBe(true);

    await user.click(screen.getByRole("button", { name: "候補を全消去" }));
    expect(routeLinesOnMap()).toHaveLength(2);
    await confirmClear(user);
    expect(screen.queryByRole("tablist", { name: "ルート結果" })).toBeNull();
    expect(routeLinesOnMap()).toEqual([]);
    expect(screen.queryByRole("button", { name: "候補を全消去" })).toBeNull();
  });

  it("条件を変えたことの印は、候補がある間だけ「ルート生成」の隣に点き、押すと意味が開き、全消去で消える", async () => {
    const { user } = renderHome();
    const changedMark = () => screen.queryByRole("button", { name: "生成条件の変更を表示" });
    jobs.respond([FIRST], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));

    act(() => screen.getByRole("slider", { name: "全長の目標" }).focus());
    await user.keyboard("{ArrowRight}");
    await user.click(changedMark()!);
    expect(screen.getByRole("dialog")).toHaveTextContent("生成条件が変更されています");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "候補を全消去" }));
    await confirmClear(user);
    expect(changedMark()).toBeNull();
  });

  it("走行条件の想定速度と出発時刻を変えると、生成の要求と地図の道の詳細へ同じ値が渡る", async () => {
    const departure = new Date("2026-10-05T09:00:00+09:00");
    // 道の評価は、送られた条件が走行条件と同じときだけ返す。
    onBackend("POST", "/api/region/axis-inspector", ({ body }) => {
      const sent = body as { speed_kmh?: number; at?: string };
      return sent.speed_kmh === 25 && sent.at === departure.toISOString()
        ? Response.json(INSPECTED_ROAD)
        : Response.json({ detail: "条件が違う" }, { status: 400 });
    });
    const { user } = renderHome();
    await user.click(screen.getByRole("button", { name: /^想定速度: / }));
    const speed = await screen.findByRole("spinbutton", { name: "想定速度（km/h）" });
    await user.clear(speed);
    await user.type(speed, "25");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: /^出発時刻.*（タップで変更）$/ }));
    // 出発日時の入力は日本時間で読む。
    fireEvent.change(await screen.findByLabelText("出発日時を直接指定"), { target: { value: "2026-10-05T09:00" } });

    serveRoadsAt([{ at: HERE, properties: { osm_way_id: 1, feature_key: "1" } }]);
    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));
    longPressMap(HERE);
    await user.click(await screen.findByRole("button", { name: "この道の評価を見る" }));
    expect(await screen.findByRole("region", { name: "難易度" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "パネルを開く" }));
    jobs.respond([FIRST], LOOP_CONDITIONS);
    expect(await generate(user)).toMatchObject({ assumed_speed_kmh: 25, start_time: departure.toISOString() });
  });

  it("保存した条件は地図で置いた出発地を持ち、呼び出すとその出発地から生成する", async () => {
    const PLACED: Coordinates = { latitude: 35.65, longitude: 139.75 };
    const { user } = renderHome();
    // 保存は「条件」タブ、呼び出しは「保存済み」の「プリセット」で行う（隠れたタブの中身も描いてあるので、ほかのタブにも保存のボタンが
    // あれば、ボタンが2つに当たって落ちる）。
    const saveAs = async (name: string) => {
      await user.click(screen.getByRole("tab", { name: "条件" }));
      const saveButton = screen.getByRole("button", { name: "いまの設定を保存" });
      expect(screen.getByRole("tabpanel", { name: "条件" })).toContainElement(saveButton);
      await user.click(saveButton);
      const dialog = screen.getByRole("dialog", { name: "いまの設定を保存" });
      const nameInput = within(dialog).getByRole("textbox", { name: "保存する名前" });
      await user.clear(nameInput);
      await user.type(nameInput, name);
      await user.click(within(dialog).getByRole("button", { name: "保存" }));
    };
    const recall = async (name: string) => {
      await user.click(screen.getByRole("tab", { name: "保存済み" }));
      await user.click(screen.getByRole("tab", { name: "プリセット" }));
      await user.click(screen.getByRole("button", { name: `「${name}」を呼び出す` }));
      await user.click(
        within(screen.getByRole("dialog", { name: `「${name}」を反映します` })).getByRole("button", {
          name: "反映する",
        }),
      );
    };
    const origin = (body: Record<string, unknown>) => ({ latitude: body.latitude, longitude: body.longitude });

    await clickMap(PLACED);
    await saveAs("置いた所");
    await user.click(screen.getByRole("button", { name: "出発地を現在地に戻す" }));

    jobs.respond([FIRST], LOOP_CONDITIONS);
    await recall("置いた所");
    expect(origin(await generate(user))).toEqual(PLACED);
  });

  it("前に保存した設定は、「保存済み」の「プリセット」に出る", async () => {
    const stored = {
      name: "いつもの周回",
      routeMode: "loop",
      distance: "40",
      maxRoutes: "3",
      origin: null,
      waypoints: [],
    };
    window.localStorage.setItem(
      "ridecompass:saved-conditions",
      JSON.stringify([{ ...stored, destination: null, routePreference: null, hardFilters: {} }]),
    );
    const { user } = renderHome();

    await user.click(screen.getByRole("tab", { name: "保存済み" }));
    await user.click(screen.getByRole("tab", { name: "プリセット" }));

    expect(screen.getByRole("button", { name: "「いつもの周回」を呼び出す" })).toBeInTheDocument();
  });

  it("「評価で塗る」で未使用に分ける軸は、生成の前はいまの重み、生成の後は生成に使われた重みで決まる", async () => {
    serveAxisCatalog(
      catalogResponse([
        catalogEntry({ axis_id: "axis_a", label: "軸A", default_weight: 1 }),
        catalogEntry({ axis_id: "axis_b", label: "軸B", default_weight: 0 }),
      ]),
    );
    const { user } = renderHome();
    /** 「未使用」を添えた選択肢の文字。 */
    const unusedAxes = async () => {
      await user.click(screen.getByRole("button", { name: /^評価で塗る: / }));
      const options = await screen.findByRole("radiogroup", { name: "評価で塗る" });
      const unused = within(options)
        .getAllByRole("radio")
        .map((row) => row.textContent ?? "")
        .filter((text) => text.endsWith("未使用"))
        .join(" ");
      await user.keyboard("{Escape}");
      return unused;
    };
    const beforeGeneration = await unusedAxes();
    expect(beforeGeneration).toContain("軸B");
    expect(beforeGeneration).not.toContain("軸A");

    jobs.respond([FIRST], { ...LOOP_CONDITIONS, route_preference: { axis_a: 0, axis_b: 1 } });
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    const afterGeneration = await unusedAxes();
    expect(afterGeneration).toContain("軸A");
    expect(afterGeneration).not.toContain("軸B");
  });
});
