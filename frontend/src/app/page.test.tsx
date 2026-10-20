/**
 * `app/page.tsx`——トップページ。機能（地図・ルートの設定と結果・走行条件・天候）を1つの画面に束ね、機能の間の値を受け渡す。
 * 地図を押したときに起きることは`app/page.map.test.tsx`、区間の乗り換えの編集は`app/page.splice.test.tsx`、画面の枠
 * （地図の上の操作・スマホのシート・ヘッダー・メニュー）は`app/page.layout.test.tsx`が見る。
 *
 * 見ること（利用者の操作の流れで、ある機能の変化が別の機能の振る舞いを変える受け渡し）:
 * - ルートを作る: 「ルート生成」が地図の塗りを添えて送ること、結果が出たら閉じていた「ルート結果」を
 *   開くこと、候補が「ルート結果」と地図の両方へ出て、選んだ候補が地図でも選ばれ、区間を持つかで周りの塗りが決まること、
 *   全消去は確認の窓で「消す」を押してから両方から消えること、候補がある間だけ条件のずれの印が点き全消去で消えること、走行条件の想定速度・出発時刻が
 *   生成と地図の道の詳細へ同じ値で渡ること、「評価で塗る」の未使用を分ける重み（生成の前はいまの重み・後は使われた重み）、
 *   「条件」タブで保存した条件が地図で置いた出発地を持ち、呼び出すとその出発地から生成すること、前に保存した条件が「保存済み」の「プリセット」に出ること
 * - 走行モード: 走行モードの間の配置（プロファイルは見るだけ・地図を指で動かした間だけ「現在地へ戻る」・休んでいる間は
 *   「続きから走る」・「表示」と「評価で塗る」は走っていないときと同じに出し、走行中に効かない操作は出さないこと・方位磁針で
 *   北が上と進む向きが上を切り替えること・スマホは下部タブも隠すこと）と、届いた現在地がプロファイルの印と
 *   地図のルート線の薄めと走りの帯の残りへ同じ距離で渡り、到着予想が位置を受けた時刻と選んだ候補の計画から出ること、
 *   走行中に帯の「ルート」で開いたパネルで選び直す・作り直すと走行モードが新しい候補を追い、パネルを出していない間は地図で
 *   何も変えも開きもしないこと、「このルートで走る」でその候補で走り始めてシートを閉じ、止めると走る前のシートへ戻ること
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
import { FACT_DISPLAY_NAME } from "@/lib/screenNames";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MINUTE_MS } from "@/lib/duration";
import { formatJstHourMinute } from "@/lib/time";
import { heldReplies, onBackend, serveAxisCatalog } from "@/testing/backendServer";
import { catalogEntry, catalogResponse } from "@/testing/catalogAxes";
import { installGeolocation } from "@/testing/geolocation";
import {
  ELSEWHERE,
  FIRST,
  HERE,
  LOOP_CONDITIONS,
  SECOND,
  candidateTabs,
  clickMap,
  clickSegment,
  confirmClear,
  generate,
  linesOn,
  marksAt,
  renderHome,
  route,
  routeLinesOnMap,
  section,
  selectedPointMarks,
  selectedSectionOnMap,
  serveHome,
  showRoadSurface,
  useMobileLayout,
} from "@/testing/homePage";
import { mapOnScreen } from "@/testing/maplibre";
import { makeRouteSegment } from "@/testing/routeFixtures";
import type { Coordinates } from "@/types/route";
import type { AxisInspectorResult } from "@/features/map/regionApi";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

let jobs: ReturnType<typeof serveHome>;

beforeEach(() => {
  jobs = serveHome();
});

// 東へ1km進む区間1つで、計画では4分かかるルート。走行モードのテストで、現在地をその真ん中（東経139.705度）に置く。
const RIDDEN = route("ridden", {
  segments: [
    makeRouteSegment({
      start_latitude: 35.7,
      start_longitude: 139.7,
      end_latitude: 35.7,
      end_longitude: 139.71,
      distance_km: 1,
      estimated_arrival_time: "2026-10-13T09:00:00+09:00",
    }),
  ],
  distance_km: 1,
  estimated_duration_seconds: 4 * 60,
});
const RIDDEN_MIDDLE: Coordinates = { latitude: 35.7, longitude: 139.705 };

/** 道の評価の応答（ここでは中身を見ない）。 */
const INSPECTED_ROAD: AxisInspectorResult = {
  highway: "residential",
  tags: {},
  segment: { axes: [], composite_difficulty: { value: 40, covered_weight_fraction: 1 }, landcover: null },
  way: { axes: [], composite_difficulty: { value: 40, covered_weight_fraction: 1 }, landcover: null },
};

/** 全部の道路をその軸で塗っているか。 */
function paints(axisId: string): boolean {
  return mapOnScreen().visibleLayerIds().includes(`road-tiles-${axisId}`);
}

/** 要素の中に描いた矢印の線。 */
function arrowPaths(element: HTMLElement) {
  return [...element.querySelectorAll("path")].map((path) => path.getAttribute("d"));
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

    // 道を押せるのは、道路のレイヤーを出していて、パネルを閉じて見るだけの間。
    await showRoadSurface(user);
    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));
    clickMap(HERE, [{ layer: "road-tiles-surface", properties: { osm_way_id: 1, feature_key: "1" } }]);
    await user.click(screen.getByRole("button", { name: "この道の評価を見る" }));
    expect(await screen.findByText(/この道全体で見た難易度/)).toBeInTheDocument();
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

    clickMap(PLACED);
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

describe("走行モード", () => {
  it("走行モードの間は、上の帯を走りの数字に替え、パネルと「現在地に移動」を隠し、選んだ候補のプロファイルを地図の下に出す（結果の図と同じくなぞると地図に地点の印とその区間の縁取りが出て、図の下に地点の詳しくが出る）。止めると元に戻る", async () => {
    const { user } = renderHome();
    jobs.respond([FIRST], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    const rideProfile = () => screen.queryByRole("region", { name: "予定ルートのプロファイル" });
    const shownWhileIdle = () => [
      screen.queryByText(/^気温:/),
      screen.queryByRole("button", { name: "ルート設定" }),
      screen.queryByRole("button", { name: "現在地に移動" }),
    ];
    await screen.findByText(/^気温:/);
    expect(shownWhileIdle().every((element) => element !== null)).toBe(true);
    expect(rideProfile()).toBeNull();

    await user.click(screen.getByRole("button", { name: "走行モード" }));
    expect(screen.getByRole("group", { name: "走りの数字" })).toBeInTheDocument();
    expect(shownWhileIdle()).toEqual([null, null, null]);
    const chart = within(rideProfile()!).getByRole("slider", { name: /^道のりに沿った難易度/ });
    expect(selectedPointMarks()).toHaveLength(0);
    fireEvent.keyDown(chart, { key: "Home" });
    expect(selectedPointMarks()).toHaveLength(1);
    expect(selectedSectionOnMap()).toEqual(linesOn("route-segments"));
    await user.click(within(rideProfile()!).getByRole("button", { name: "区間の選択を解除" }));
    expect(selectedPointMarks()).toHaveLength(0);
    expect(selectedSectionOnMap()).toEqual([]);
    // グラフに出す情報は、ページが持つ1つの選択（はじめは標高）を走行中の図にも渡す。
    await user.click(within(rideProfile()!).getByRole("tab", { name: FACT_DISPLAY_NAME }));
    await user.click(within(rideProfile()!).getByRole("button", { name: "グラフに出す情報" }));
    expect(within(screen.getByRole("dialog")).getByRole("checkbox", { name: "標高" })).toBeChecked();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "走行モード" }));
    await user.click(screen.getByRole("button", { name: "案内を終える" }));
    expect(screen.queryByRole("group", { name: "走りの数字" })).toBeNull();
    expect(shownWhileIdle().every((element) => element !== null)).toBe(true);
    expect(rideProfile()).toBeNull();
  });

  it("走行中も「表示」と「評価で塗る」を出してピルから一覧を開け、出したまま現在地を追い、方位磁針で北が上と進む向きが上を切り替え、走行条件・「現在地に移動」は出さない", async () => {
    const geolocation = installGeolocation(HERE);
    const { user } = renderHome();
    jobs.respond([FIRST], LOOP_CONDITIONS);
    await generate(user);

    await user.click(screen.getByRole("button", { name: "走行モード" }));
    geolocation.deliver(RIDDEN_MIDDLE);

    expect(screen.getByRole("button", { name: "地図に出す情報" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^評価で塗る: / }));
    expect(await screen.findByRole("radiogroup", { name: "評価で塗る" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "進む向きを上にする（いまは北が上）" }));
    expect(screen.getByRole("button", { name: "北を上にする（いまは進む向きが上）" })).toBeInTheDocument();
    expect([
      screen.queryByRole("group", { name: "走行条件" }),
      screen.queryByRole("button", { name: "現在地に移動" }),
    ]).toEqual([null, null]);
    geolocation.deliver(RIDDEN_MIDDLE);
    expect(screen.queryByRole("button", { name: "現在地へ戻る" })).toBeNull();
  });

  it("走行モードで届いた現在地を選んだ候補の上の距離へ当て、プロファイルに印を出し、地図のルート線のそこまでを薄め、走りの帯に残りと到着予想を出す", async () => {
    const geolocation = installGeolocation(HERE);
    const { user } = renderHome();
    jobs.respond([RIDDEN], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "走行モード" }));
    const fixedAt = Date.parse("2026-10-13T05:00:00Z");
    geolocation.deliver({ ...RIDDEN_MIDDLE, timestamp: fixedAt });

    // 残りの0.5kmは、計画では2分。計画の時刻（出発）ではなく、位置を受けた時刻から数える。
    const arrival = new Date(fixedAt + 2 * MINUTE_MS);
    const rideBar = screen.getByRole("group", { name: "走りの数字" });
    expect(rideBar).toHaveTextContent("残り: 0.5km");
    expect(rideBar).toHaveTextContent(`到着予想: ${formatJstHourMinute(arrival)}`);
    const profile = screen.getByRole("region", { name: "予定ルートのプロファイル" });
    expect(profile.querySelector('[data-progress="position"]')).not.toBeNull();
    const drawn = mapOnScreen().sourceFeatures("route-segments");
    expect(drawn.map((feature) => feature.properties?.travelled ?? false)).toEqual([true, false]);
  });

  it("走行中は、現在地より先でいちばん近い曲がる所の向きと距離を地図の上のカードに出し、その地点にカードと同じ矢印の札を出す", async () => {
    const geolocation = installGeolocation(HERE);
    const { user } = renderHome();
    const turnPoint = { latitude: 35.7, longitude: 139.708 };
    jobs.respond([{ ...RIDDEN, turns: [{ distance_km: 0.8, direction: "right", ...turnPoint }] }], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "走行モード" }));

    geolocation.deliver({ ...RIDDEN_MIDDLE, accuracy: 20 });
    const card = screen.getByRole("status", { name: "300m先で右折" });
    const [mark] = marksAt(turnPoint).map((mark) => mark.element);
    expect(mark).toHaveAccessibleName("曲がる所: 右折");
    expect(arrowPaths(mark)).toEqual(arrowPaths(card));
    // 現在地の印（強調色の丸）と取り違えないよう、丸でも強調色でもない。
    expect(mark.style.borderRadius).not.toBe("50%");
    expect(mark.style.background).not.toContain("--color-accent");

    // 曲がる所を過ぎたら出さない。
    geolocation.deliver({ latitude: 35.7, longitude: 139.709, accuracy: 20 });
    expect(screen.queryByRole("status", { name: /先で右折$/ })).toBeNull();
    expect(marksAt(turnPoint)).toEqual([]);
  });

  it("走行中にルートを外れたら、走りの帯に外れたと出して残りを外れた点のまま止め、ルートへ戻ったら戻った点から続ける", async () => {
    const geolocation = installGeolocation(HERE);
    const { user } = renderHome();
    jobs.respond([RIDDEN], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "走行モード" }));
    const rideBar = screen.getByRole("group", { name: "走りの数字" });

    geolocation.deliver({ ...RIDDEN_MIDDLE, accuracy: 20 });
    expect(rideBar).toHaveTextContent("残り: 0.5km");
    // 0.8km の所の北へ約220m（位置の誤差 20m を超えて）離れた。
    geolocation.deliver({ latitude: 35.702, longitude: 139.708, accuracy: 20 });
    expect(screen.getByRole("status", { name: "ルートを外れています" })).toBeInTheDocument();
    expect(screen.getByText(/ルートへ戻ると続きから案内します/)).toBeInTheDocument();
    expect(rideBar).toHaveTextContent("残り: 0.5km");
    // 回り道して、0.8km の所でルートへ戻った。
    geolocation.deliver({ latitude: 35.7, longitude: 139.708, accuracy: 20 });
    expect(screen.queryByRole("status", { name: "ルートを外れています" })).toBeNull();
    expect(screen.queryByText(/ルートへ戻ると続きから案内します/)).toBeNull();
    expect(rideBar).toHaveTextContent("残り: 0.2km");
  });

  it("走行中に画面を読み込み直しても、同じ候補を出して走行モードを続け、到着予想はその候補の計画から出す", async () => {
    const geolocation = installGeolocation(HERE);
    const first = renderHome();
    jobs.respond([RIDDEN], LOOP_CONDITIONS);
    await generate(first.user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    await first.user.click(screen.getByRole("button", { name: "走行モード" }));
    first.unmount();

    renderHome();
    const rideBar = await screen.findByRole("group", { name: "走りの数字" });
    expect(screen.getByRole("region", { name: "予定ルートのプロファイル" })).toBeInTheDocument();
    const fixedAt = Date.parse("2026-10-13T05:00:00Z");
    geolocation.deliver({ ...RIDDEN_MIDDLE, timestamp: fixedAt });
    const arrival = new Date(fixedAt + 2 * MINUTE_MS);
    expect(rideBar).toHaveTextContent(`到着予想: ${formatJstHourMinute(arrival)}`);
  });

  it("走行モードのボタンで休むと、位置を受けるのをやめてルートと進み具合を残し、読み込み直しても休んだまま戻り、地図の下の「続きから走る」で休む前の進み具合から続ける。地図を指で動かすと「現在地へ戻る」を出し、ボタンで案内を終えると止める", async () => {
    const geolocation = installGeolocation(HERE);
    const first = renderHome();
    jobs.respond([RIDDEN], LOOP_CONDITIONS);
    await generate(first.user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    const backToHere = () => screen.queryByRole("button", { name: "現在地へ戻る" });
    const moveMapByHand = () =>
      act(() => mapOnScreen().emit("movestart", { originalEvent: new MouseEvent("mousedown") }));
    const rideButton = () => screen.getByRole("button", { name: "走行モード" });
    await first.user.click(rideButton());
    geolocation.deliver({ ...RIDDEN_MIDDLE, accuracy: 20 });
    expect(screen.getByRole("group", { name: "走りの数字" })).toHaveTextContent("残り: 0.5km");
    expect(backToHere()).toBeNull();

    // ボタンを押すと選ぶ所を出し、休むを選ぶと位置を受けるのをやめ、走行モードのまま（ルートと進み具合を残して）休む。
    // 休む長さは分からないので、到着予想は出さない。
    await first.user.click(rideButton());
    await first.user.click(screen.getByRole("button", { name: "休む" }));
    expect(rideButton()).toHaveAttribute("data-ride", "resting");
    expect(geolocation.watching()).toBe(0);
    expect(screen.getByRole("group", { name: "走りの数字" })).toHaveTextContent("残り: 0.5km");
    expect(screen.getByRole("group", { name: "走りの数字" })).toHaveTextContent("到着予想: —");
    first.unmount();

    // 読み込み直しても、休んだまま戻る。
    const { user } = renderHome();
    const rideBar = await screen.findByRole("group", { name: "走りの数字" });
    expect(rideButton()).toHaveAttribute("data-ride", "resting");
    expect(geolocation.watching()).toBe(0);
    expect(rideBar).toHaveTextContent("残り: 0.5km");

    // 続きから走ると位置を受け直し、休む前の進み具合から続ける。
    await user.click(screen.getByRole("button", { name: "続きから走る" }));
    expect(geolocation.watching()).toBe(1);
    geolocation.deliver({ latitude: 35.7, longitude: 139.708, accuracy: 20 });
    expect(rideButton()).toHaveAttribute("data-ride", "following");
    expect(rideBar).toHaveTextContent("残り: 0.2km");
    expect(screen.queryByRole("button", { name: "続きから走る" })).toBeNull();

    moveMapByHand();
    await user.click(backToHere()!);
    expect(backToHere()).toBeNull();
    expect(rideButton()).toHaveAttribute("data-ride", "following");

    await user.click(rideButton());
    await user.click(screen.getByRole("button", { name: "案内を終える" }));
    expect(screen.queryByRole("group", { name: "走りの数字" })).toBeNull();
    expect(geolocation.watching()).toBe(0);
  });

  it("走行モードのまま帯の「ルート」で左のパネルを出し、候補を選び直す・作り直すと、走行モードはその候補を追い続ける", async () => {
    const geolocation = installGeolocation(HERE);
    const { user } = renderHome();
    // 東へ2km進む区間1つのルート。現在地（東経139.705度）はその4分の1の所。
    const longer = route("longer", {
      segments: [
        makeRouteSegment({
          start_latitude: 35.7,
          start_longitude: 139.7,
          end_latitude: 35.7,
          end_longitude: 139.72,
          distance_km: 2,
        }),
      ],
      distance_km: 2,
    });
    jobs.respond([RIDDEN, longer], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "走行モード" }));
    geolocation.deliver({ ...RIDDEN_MIDDLE, accuracy: 20 });
    const rideBar = screen.getByRole("group", { name: "走りの数字" });
    expect(rideBar).toHaveTextContent("残り: 0.5km");
    expect(screen.queryByRole("button", { name: "ルート結果" })).toBeNull();

    const routePanel = screen.getByRole("button", { name: "ルート" });
    await user.click(routePanel);
    expect(routePanel).toHaveAttribute("aria-expanded", "true");
    await user.click(candidateTabs()[1]);
    geolocation.deliver({ ...RIDDEN_MIDDLE, accuracy: 20 });
    expect(rideBar).toHaveTextContent("残り: 1.5km");

    jobs.respond([RIDDEN], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    geolocation.deliver({ ...RIDDEN_MIDDLE, accuracy: 20 });
    expect(screen.getByRole("group", { name: "走りの数字" })).toHaveTextContent("残り: 0.5km");

    await user.click(routePanel);
    expect(screen.queryByRole("button", { name: "ルート結果" })).toBeNull();
  });

  it("スマホでは、走行中に帯の「ルート」で「ルート結果」のシートを開き、下部タブで「ルート設定」へ移れ、閉じると地図だけに戻る", async () => {
    useMobileLayout();
    const { user } = renderHome();
    await user.click(screen.getByRole("button", { name: "走行モード" }));
    const routePanel = screen.getByRole("button", { name: "ルート" });

    await user.click(routePanel);
    expect(screen.getByRole("dialog", { name: "ルート結果" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ルート設定" }));
    expect(screen.getByRole("dialog", { name: "ルート設定" })).toBeInTheDocument();

    await user.click(routePanel);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "パネル切り替え" })).toBeNull();
    expect(screen.getByRole("group", { name: "走りの数字" })).toBeInTheDocument();
  });

  it("走行中は、帯の「ルート」で開いたパネルの中を除き、地図を押しても地点を置かず、線・区間・ピンを押しても選ばず中身も出さない", async () => {
    const { user } = renderHome();
    jobs.respond([FIRST, SECOND], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(2));
    const [secondLine] = mapOnScreen()
      .sourceFeatures("route-candidates")
      .filter((line) => line.properties?.routeId === SECOND.id);
    const clickSecondLine = () =>
      clickMap(ELSEWHERE, [
        {
          layer: "route-candidates-candidateHit",
          properties: secondLine.properties ?? {},
          geometry: secondLine.geometry,
        },
      ]);
    const [drawnSegment] = mapOnScreen().sourceFeatures("route-segments");
    await user.click(screen.getByRole("button", { name: "走行モード" }));

    clickMap(ELSEWHERE);
    expect(marksAt(ELSEWHERE)).toEqual([]);
    clickSecondLine();
    expect(linesOn("route-selected")).toEqual([FIRST.geometry.coordinates]);
    clickSegment(drawnSegment, HERE);
    expect(screen.queryByText(/km地点/)).toBeNull();
    const [originPin] = marksAt(HERE);
    expect(originPin.draggable).toBe(false);
    await user.click(originPin.element);
    expect(screen.queryByText(/^出発地: /)).toBeNull();

    await user.click(screen.getByRole("button", { name: "ルート" }));
    clickSecondLine();
    expect(linesOn("route-selected")).toEqual([SECOND.geometry.coordinates]);
  });

  it("「このルートで走る」を押すと、その候補を選んで走行モードを始め、スマホはシートを閉じる。止めると走る前のシートへ戻る", async () => {
    useMobileLayout();
    const { user } = renderHome();
    jobs.respond([FIRST, SECOND], LOOP_CONDITIONS);
    await user.click(screen.getByRole("button", { name: "ルート設定" }));
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(2));
    await user.click(candidateTabs()[1]);

    await user.click(screen.getByRole("button", { name: "このルートで走る" }));
    expect(screen.getByRole("group", { name: "走りの数字" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(linesOn("route-selected")).toEqual([SECOND.geometry.coordinates]);

    await user.click(screen.getByRole("button", { name: "走行モード" }));
    await user.click(screen.getByRole("button", { name: "案内を終える" }));
    expect(screen.getByRole("dialog", { name: "ルート結果" })).toBeInTheDocument();
  });
});
