/**
 * `app/page.tsx`——トップページ。機能（地図・ルートの設定と結果・走行条件・天候）を1つの画面に束ね、機能の間の値を受け渡す。
 *
 * 見ること（利用者の操作の流れで、ある機能の変化が別の機能の振る舞いを変える受け渡し）:
 * - ルートを作る: 「ルート生成」が地図の塗りを添えて送ること、結果が出たら閉じていた「ルート結果」を
 *   開くこと、候補が「ルート結果」と地図の両方へ出て、選んだ候補が地図でも選ばれ、区間を持つかで周りの塗りが決まること、
 *   全消去は確認の窓で「消す」を押してから両方から消えること、候補がある間だけ条件のずれの印が点き全消去で消えること、走行条件の想定速度・出発時刻が
 *   生成と地図の道の詳細へ同じ値で渡ること、「評価で塗る」の未使用を分ける重み（生成の前はいまの重み・後は使われた重み）、
 *   保存した条件が地図で置いた出発地を持ち、呼び出すとその出発地から生成すること、前に保存した条件が「保存」の「設定」に出ること
 * - 地図で扱えること: 地図を押したときの意味は効いているパネルで決まり（「ルート設定」の条件タブは選んでいる地点を置く、
 *   「ルート結果」は候補の線でそのルートを選び区間でその中身を出す、閉じている間は押した物の中身を小窓に出すだけ）、PC で
 *   2つの区分を開いていれば最後に触った区分が効いてその題に添えること、ピンを押しても消えずルート設定ではその地点を選ぶこと、
 *   目的地の行で探して置いた地点と、名前のある点を押して置いた地点が地図に立ち、行にその名前が出ること、
 *   名前を付けて保存した地点を打つ欄から選び直せ、「保存」の「地点」から呼び出すと条件タブへ移って置くこと、編集の間は地図で地点も区間も扱わず全部の候補を重ね、
 *   「ルート結果」の見出しに候補1本への操作を出さず、作り直すと編集が終わること、作ると直前の作り直しの失敗の文言を消し、合成ルートを選んでいる間は元のルートだけを重ねること、
 *   地図の表示をまとめて戻す操作（「表示」の一覧の末尾と右上のメニュー）
 * - 画面の枠: スマホの下部タブとシート（1枚ずつ開く・地点を扱える間・結果の合図・候補が届いた時点で「ルート設定」を開いて
 *   いれば「ルート結果」へ移ってそこから全消去でき、ほかのときは移らず合図を出すこと・候補を出せなかった理由の1行・
 *   決めた高さを2枚のシートで分け合うこと）、区分の開閉の保存、
 *   ヘッダーの「未取得」に並ぶ出所と「現在地に移動」の失敗、「現在地に移動」が出発地を変えずに地図を寄せて現在地に点を
 *   出すこと、メニューから入る使い方の説明とデバッグログ、
 *   走行モードの間の配置（プロファイルは見るだけ・休んでいる間だけ「現在地へ戻る」・「表示」と「評価で塗る」は走っていないときと
 *   同じに出し、走行中に効かない操作は出さないこと）と、届いた現在地がプロファイルの印と
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
 * 操作を押せるか）は1行の委譲なので見ない。シートの高さの決め方・覚え方は`components/BottomSheet/BottomSheet.test.tsx`、
 * ルートを収めるときにシートを避けることは実寸が要るので`e2e/mobile.spec.ts`が見る。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得（`navigator.geolocation`）、地図の描画（`maplibre-gl`）。
 * どれもテスト環境に無いものか、その手前の境界。地図は `@/testing/maplibre` の代役が受けたものを記録し、地図の操作
 * （押す・押した所に描かれている地物）はテストが代役から起こす。
 */
import { FACT_DISPLAY_NAME } from "@/lib/screenNames";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLIENT_TUNING_IDS } from "@/lib/axisCatalog";
import { setDebugEnabled } from "@/lib/debugLog";
import { MINUTE_MS } from "@/lib/duration";
import { formatJstHourMinute } from "@/lib/time";
import { heldReplies, onBackend, onSameOrigin, serveAxisCatalog } from "@/testing/backendServer";
import { catalogEntry, catalogResponse, dedicatedEntry } from "@/testing/catalogAxes";
import { serveGenerationJobs } from "@/testing/generationJobs";
import { installGeolocation } from "@/testing/geolocation";
import { mapOnScreen, type PointedFeature } from "@/testing/maplibre";
import { POINT_TILE_SOURCES } from "@/features/map/scene/groups/points";
import { sceneLayerId } from "@/features/map/scene/sceneBuilders";
import {
  makeGenerationConditions,
  makeRouteCandidate,
  makeRouteSegment,
  routeThrough,
  type Places,
} from "@/testing/routeFixtures";
import type { Coordinates, RouteCandidate } from "@/types/route";
import type { AxisInspectorResult } from "@/features/map/regionApi";
import regionTileConfig from "@/types/generated/region-tile-config.json";
import type { AmedasObservation, WeatherConditions } from "@/types/weather";

import Home from "./page";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

const HERE: Coordinates = { latitude: 35.7, longitude: 139.7 };
const DESTINATION: Coordinates = { latitude: 35.6, longitude: 139.73 };
const ELSEWHERE: Coordinates = { latitude: 35.65, longitude: 139.72 };

// 地図が道路のタイルを載せる（軸で塗れる）のは、タイルの世代が全部の系統で揃ってから。
const CATALOG = catalogResponse([dedicatedEntry("axis_a", [25, 50, 75], { label: "軸A", default_weight: 1 })], {
  client_tuning: { [CLIENT_TUNING_IDS.minStretchKm]: 0.1 },
  tile_versions: Object.fromEntries(regionTileConfig.tile_version_kinds.map((kind) => [kind, "1-test"])),
});

// 予報と実測（ここでは中身を見ない）。
const FORECAST: WeatherConditions = {
  precipitation_mm: null,
  twilight: null,
  precipitation_max_mm: null,
  wind_speed_max_ms: null,
  temperature_range: null,
  today_periods: [],
  today_period_interval_hours: 2,
};
const OBSERVATION: AmedasObservation = {
  station_name: "観測所",
  observed_at: "2026-01-01T12:00:00+09:00",
  temperature_c: null,
  apparent_temperature_c: null,
  wind_speed_ms: null,
  wind_direction: null,
  precipitation_10min_mm: null,
  twilight: null,
  weather_code: null,
  valid_area: null,
};

let jobs: ReturnType<typeof serveGenerationJobs>;

function useMobileLayout() {
  document.documentElement.style.setProperty("--is-mobile", "1");
}

beforeEach(() => {
  window.localStorage.clear();
  installGeolocation(HERE);
  jobs = serveGenerationJobs();
  serveAxisCatalog(CATALOG);
  onSameOrigin("GET", "/api/jma-tile/*", () => Response.json([]));
  onBackend("GET", "/api/jma-tile-index", () => Response.json({ available: false, coverage: null, elements: {} }));
  onBackend("GET", "/api/weather", () => Response.json(FORECAST));
  onBackend("GET", "/api/weather/amedas", () => Response.json(OBSERVATION));
  onBackend("GET", "/api/weather/warnings", () => Response.json({ warnings: [] }));
  onBackend("GET", "/api/weather/wbgt", () => Response.json({ reading: null }));
  onBackend("GET", "/api/weather/flood-forecast", () => Response.json({ forecasts: [] }));
  onBackend("GET", "/api/place-area", () => Response.json({ area: null }));
});

afterEach(() => {
  document.documentElement.style.removeProperty("--is-mobile");
  setDebugEnabled(false);
});

function route(id: string, overrides: Partial<RouteCandidate> = {}): RouteCandidate {
  return makeRouteCandidate({ id, direction_label: id, ...overrides });
}

const SEGMENT = makeRouteSegment({ start_latitude: 35.7, start_longitude: 139.7, distance_km: 1 });
const FIRST = route("first", {
  estimated_duration_seconds: 1800,
  segments: [SEGMENT],
  geometry: {
    type: "LineString",
    coordinates: [
      [139.7, 35.7],
      [139.71, 35.7],
    ],
  },
});
const SECOND = route("second", {
  estimated_duration_seconds: 2400,
  geometry: {
    type: "LineString",
    coordinates: [
      [139.7, 35.7],
      [139.7, 35.71],
    ],
  },
});

/** 道の評価の応答（ここでは中身を見ない）。 */
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

const INSPECTED_ROAD: AxisInspectorResult = {
  highway: "residential",
  tags: {},
  segment: { axes: [], composite_difficulty: { value: 40, covered_weight_fraction: 1 }, landcover: null },
  way: { axes: [], composite_difficulty: { value: 40, covered_weight_fraction: 1 }, landcover: null },
};

/** 地図のソースに載った線の座標。 */
function linesOn(sourceId: string): unknown[] {
  return mapOnScreen()
    .sourceFeatures(sourceId)
    .map((feature) => (feature.geometry as GeoJSON.LineString).coordinates);
}

/** 地図に引いたルートの線（候補と、選んだ候補）。 */
function routeLinesOnMap(): unknown[] {
  const lines = [...linesOn("route-candidates"), ...linesOn("route-selected")];
  return lines.filter(
    (line, index) => lines.findIndex((other) => JSON.stringify(other) === JSON.stringify(line)) === index,
  );
}

/** 全部の道路をその軸で塗っているか。 */
function paints(axisId: string): boolean {
  return mapOnScreen().visibleLayerIds().includes(`road-tiles-${axisId}`);
}

/** 地図のその地点に置いた印。 */
function marksAt(point: Coordinates) {
  return mapOnScreen()
    .markers()
    .filter((mark) => mark.coordinates.latitude === point.latitude && mark.coordinates.longitude === point.longitude);
}

/** 要素の中に描いた矢印の線。 */
function arrowPaths(element: HTMLElement) {
  return [...element.querySelectorAll("path")].map((path) => path.getAttribute("d"));
}

/** 地点の並びで目的地を押して選ぶ（「ルート設定」が効いている間、地図を押すと選んでいる地点を置く。何も押していなければ出発地）。 */
async function selectDestination(user: User) {
  await user.click(screen.getByRole("button", { name: "目的地: 未設定" }));
}

/** 地図を押す。`features`はそこに描かれている地物。 */
function clickMap(at: Coordinates, features: PointedFeature[] = []) {
  act(() => mapOnScreen().click(at, features));
}

/** 地図に描いた区間を押す。 */
function clickSegment(segment: GeoJSON.Feature, at: Coordinates) {
  clickMap(at, [
    { layer: "route-segments-detailHit", properties: segment.properties ?? {}, geometry: segment.geometry },
  ]);
}

const LOOP_CONDITIONS = makeGenerationConditions({ latitude: HERE.latitude, longitude: HERE.longitude });

function renderHome() {
  const user = userEvent.setup();
  const rendered = render(<Home />);
  act(() => mapOnScreen().emit("load"));
  return { user, ...rendered };
}

type User = ReturnType<typeof userEvent.setup>;

/** 「地図に出す情報」の一覧で道路のレイヤー（路面の種類）を出す。 */
async function showRoadSurface(user: User) {
  await user.click(screen.getByRole("button", { name: "地図に出す情報" }));
  await user.click(screen.getByRole("checkbox", { name: "路面の種類" }));
  await user.keyboard("{Escape}");
}

/** 「ルート生成」を押し、出した要求を返す。 */
async function generate(user: User) {
  const before = jobs.submitted.length;
  await user.click(screen.getByRole("button", { name: "ルート生成" }));
  await waitFor(() => expect(jobs.submitted).toHaveLength(before + 1));
  return jobs.submitted[before].body as Record<string, unknown>;
}

function candidateTabs() {
  return within(screen.getByRole("tablist", { name: "ルート結果" })).getAllByRole("tab");
}

/** 全消去の確認の窓で「消す」を押す。 */
async function confirmClear(user: User) {
  const dialog = screen.getByRole("dialog", { name: "候補をすべて消します" });
  await user.click(within(dialog).getByRole("button", { name: "消す" }));
}

function section(name: "ルート設定" | "ルート結果") {
  return screen.getByRole("button", { name });
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

    fireEvent.change(screen.getByLabelText("全長の目標"), { target: { value: "50" } });
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
    // 保存も呼び出しも「保存」の「設定」で行う（見出しの行にも保存のボタンがあれば、ボタンが2つに当たって落ちる）。
    const openSavedConditions = async () => {
      await user.click(screen.getByRole("tab", { name: "保存" }));
      await user.click(screen.getByRole("tab", { name: "設定" }));
    };
    const saveAs = async (name: string) => {
      await openSavedConditions();
      await user.click(screen.getByRole("button", { name: "いまの設定を保存" }));
      const dialog = screen.getByRole("dialog", { name: "いまの設定を保存" });
      const nameInput = within(dialog).getByRole("textbox", { name: "保存する名前" });
      await user.clear(nameInput);
      await user.type(nameInput, name);
      await user.click(within(dialog).getByRole("button", { name: "保存" }));
    };
    const recall = async (name: string) => {
      await openSavedConditions();
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
    await user.click(screen.getByRole("tab", { name: "条件" }));
    await user.click(screen.getByRole("button", { name: "出発地を現在地に戻す" }));

    jobs.respond([FIRST], LOOP_CONDITIONS);
    await recall("置いた所");
    expect(origin(await generate(user))).toEqual(PLACED);
  });

  it("前に保存した設定は、「保存」の「設定」に出る", async () => {
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

    await user.click(screen.getByRole("tab", { name: "保存" }));
    await user.click(screen.getByRole("tab", { name: "設定" }));

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

describe("地図で扱えること", () => {
  it("地図を押したときの意味は効いているパネルで決まる: 「ルート設定」の条件タブは選んでいる地点を置き、ほかのタブ・閉じている間は置かない", async () => {
    const { user } = renderHome();
    await selectDestination(user);
    clickMap(DESTINATION);
    expect(marksAt(DESTINATION)).toEqual([expect.objectContaining({ draggable: true })]);
    expect(screen.getByRole("button", { name: "目的地を消す" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "経由地を足す" }));
    await user.click(screen.getByRole("tab", { name: "重み" }));
    clickMap(ELSEWHERE);
    expect(marksAt(ELSEWHERE)).toEqual([]);
    expect(marksAt(DESTINATION)).toEqual([expect.objectContaining({ draggable: false })]);

    await user.click(screen.getByRole("tab", { name: "条件" }));
    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));
    expect(screen.queryByRole("button", { name: "ルート設定" })).toBeNull();
    clickMap(ELSEWHERE);
    expect(marksAt(ELSEWHERE)).toEqual([]);
    expect(marksAt(DESTINATION)).toEqual([expect.objectContaining({ draggable: false })]);

    await user.click(screen.getByRole("button", { name: "パネルを開く" }));
    clickMap(ELSEWHERE);
    expect(marksAt(ELSEWHERE)).toEqual([expect.objectContaining({ draggable: true })]);
    expect(screen.getByRole("button", { name: "経由地1: 地図で選んだ地点" })).toBeInTheDocument();
  });

  it("PC で2つの区分を開いているときは最後に触った区分が効いてその題に添え、「ルート結果」では候補の線を押すとそのルートを選ぶ", async () => {
    const { user } = renderHome();
    expect(section("ルート設定")).toHaveAccessibleDescription("地図で操作中");
    expect(section("ルート結果")).not.toHaveAccessibleDescription();

    jobs.respond([FIRST, SECOND], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(2));
    // 結果が届いたら「ルート結果」が効く。
    expect(section("ルート結果")).toHaveAccessibleDescription("地図で操作中");
    expect(section("ルート設定")).not.toHaveAccessibleDescription();
    const [secondLine] = mapOnScreen()
      .sourceFeatures("route-candidates")
      .filter((line) => line.properties?.routeId === SECOND.id);
    clickMap(ELSEWHERE, [
      {
        layer: "route-candidates-candidateHit",
        properties: secondLine.properties ?? {},
        geometry: secondLine.geometry,
      },
    ]);
    expect(linesOn("route-selected")).toEqual([SECOND.geometry.coordinates]);
    expect(marksAt(ELSEWHERE)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "出発地: 現在地" }));
    expect(section("ルート設定")).toHaveAccessibleDescription("地図で操作中");
    clickMap(ELSEWHERE);
    expect(marksAt(ELSEWHERE)).toHaveLength(1);
  });

  it("ピンを押しただけでは消えず、ルート設定ではその地点を選んで詳しくを出し、閉じている間は呼び名と名前を小窓に出す", async () => {
    const { user } = renderHome();
    await selectDestination(user);
    clickMap(DESTINATION);
    await user.click(screen.getByRole("button", { name: "出発地: 現在地" }));

    const [destinationPin] = marksAt(DESTINATION);
    await user.click(destinationPin.element);
    expect(marksAt(DESTINATION)).toHaveLength(1);
    expect(screen.getByRole("region", { name: "目的地" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));
    await user.click(destinationPin.element);
    expect(marksAt(DESTINATION)).toHaveLength(1);
    expect(screen.getByText("目的地: 地図で選んだ地点")).toBeInTheDocument();
  });

  it("名前のある点を押すと、選んでいる地点をその点へその名前で置き、地図と地点の並びに出す。閉じている間は置かない", async () => {
    const shop: Coordinates = { latitude: 35.71, longitude: 139.71 };
    const pointed = [
      {
        layer: sceneLayerId(POINT_TILE_SOURCES.poi.sourceId, "supply_poi"),
        properties: { name: "角の店", kind: "convenience" },
        geometry: { type: "Point", coordinates: [shop.longitude, shop.latitude] },
      } satisfies PointedFeature,
    ];
    const { user } = renderHome();
    await user.click(screen.getByRole("button", { name: "地図に出す情報" }));
    await user.click(screen.getByRole("checkbox", { name: "補給・休憩ポイント" }));
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "経由地を足す" }));
    // 押した所は絵の端でも、点そのものの位置へ置く。
    clickMap(ELSEWHERE, pointed);
    expect(marksAt(shop)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "経由地1: 角の店" })).toBeInTheDocument();

    await selectDestination(user);
    clickMap(shop, pointed);
    expect(marksAt(shop)).toHaveLength(2);
    expect(screen.getByRole("button", { name: "目的地: 角の店" })).toBeInTheDocument();
    // 地図の印は役割の名前で見分けられ、地点の並びの印と同じ記号を描く。
    const [waypointMark, destinationMark] = marksAt(shop).map(({ element }) => element);
    expect(waypointMark).toHaveAccessibleName("経由地 1");
    expect(destinationMark).toHaveAccessibleName("目的地");
    expect(screen.getByRole("img", { name: "出発地" })).toBeInTheDocument();
    const listedDestination = screen.getByRole("button", { name: "目的地: 角の店" }).querySelector("svg");
    // 大きさは置き場ごとに違うので、記号の中身で比べる。
    expect(listedDestination?.innerHTML).toBeTruthy();
    expect(destinationMark.querySelector("svg")?.innerHTML).toBe(listedDestination?.innerHTML);

    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));
    clickMap(ELSEWHERE, pointed);
    expect(marksAt(shop)).toHaveLength(2);
  });

  it("目的地を探して選んだ地点は地図に目的地として立ち、地点の並びにその名前が出る", async () => {
    const candidate = {
      kind: "facility",
      level: "point",
      name: "浅草寺",
      area: "台東区浅草二丁目",
      latitude: 35.7148,
      longitude: 139.7967,
    } as const;
    onBackend("GET", "/api/place-search", () => Response.json({ candidates: [candidate] }));
    const { user } = renderHome();
    await user.click(screen.getByRole("button", { name: "目的地: 未設定" }));
    const searchBox = screen.getByRole("searchbox", { name: "目的地を住所・施設で探す" });

    await user.type(searchBox, "浅草寺{Enter}");
    await user.click(await screen.findByRole("button", { name: new RegExp(candidate.name) }));

    expect(marksAt(candidate)).toHaveLength(1);
    expect(screen.getByRole("button", { name: `目的地: ${candidate.name}` })).toBeInTheDocument();
  });

  it("名前を付けて保存した地点は、目的地を消したあとも打つ欄を押して選び直せ、「保存」の「地点」から呼び出すと条件タブへ移って置く", async () => {
    const { user } = renderHome();
    await selectDestination(user);
    clickMap(DESTINATION);
    await user.click(screen.getByRole("button", { name: "地点を保存" }));
    const dialog = screen.getByRole("dialog", { name: "地点を保存" });
    const nameInput = within(dialog).getByRole("textbox", { name: "保存する地点の名前" });
    await user.clear(nameInput);
    await user.type(nameInput, "いつものカフェ");
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    await user.click(screen.getByRole("button", { name: "目的地を消す" }));
    expect(marksAt(DESTINATION)).toEqual([]);

    await user.click(screen.getByRole("searchbox", { name: "目的地を住所・施設で探す" }));
    const saved = screen.getByRole("list", { name: "保存した地点" });
    await user.click(within(saved).getByRole("button", { name: /いつものカフェ/ }));

    expect(marksAt(DESTINATION)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "目的地: いつものカフェ" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "保存" }));
    await user.click(screen.getByRole("tab", { name: "地点" }));
    await user.click(screen.getByRole("button", { name: "「いつものカフェ」を呼び出す" }));
    const menu = screen.getByRole("dialog", { name: "「いつものカフェ」をどこに置くか" });
    await user.click(within(menu).getByRole("button", { name: "経由地に足す" }));

    expect(screen.getByRole("tab", { name: "条件" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("region", { name: "経由地1" })).toHaveTextContent("いつものカフェ");
    expect(marksAt(DESTINATION)).toHaveLength(2);
  });

  it("区間を押すと、「ルート結果」が効いている間はその中に、閉じている間は地図の小窓に中身を出し、「ルート設定」が効いている間は出さない", async () => {
    const { user } = renderHome();
    jobs.respond([FIRST], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    const [drawnSegment] = mapOnScreen().sourceFeatures("route-segments");

    clickSegment(drawnSegment, HERE);
    await user.click(screen.getByRole("button", { name: "区間の選択を解除" }));

    await user.click(screen.getByRole("button", { name: "出発地: 現在地" }));
    clickSegment(drawnSegment, HERE);
    expect(screen.queryByText(/km地点/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));
    clickSegment(drawnSegment, HERE);
    expect(screen.getByText(/km地点/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "区間の選択を解除" })).toBeNull();
  });

  describe("区間の乗り換え", () => {
    // 地点（[経度, 緯度]）。元の候補は P0→P1→P2→P3→P4 を進み、もう1本は P1 と P2 の間を Q、P3 と P4 の間を R を通って進む
    // （片方の分かれ道だけを乗り換えると、どちらの候補とも違う道になる）。
    const PLACES: Places = {
      P0: [139.7, 35.6],
      P1: [139.71, 35.6],
      P2: [139.72, 35.6],
      P3: [139.73, 35.6],
      P4: [139.74, 35.6],
      Q: [139.715, 35.61],
      R: [139.735, 35.61],
    };

    function through(id: string, names: string[], overrides: Partial<RouteCandidate> = {}) {
      return route(id, { kind: "destination", spliceable: true, ...routeThrough(PLACES, names), ...overrides });
    }

    const BASE = through("base", ["P0", "P1", "P2", "P3", "P4"], { estimated_duration_seconds: 1800 });
    const OTHER = through("other", ["P0", "P1", "Q", "P2", "P3", "R", "P4"], { estimated_duration_seconds: 2400 });
    const DESTINATION_CONDITIONS = makeGenerationConditions({
      latitude: HERE.latitude,
      longitude: HERE.longitude,
      destination: DESTINATION,
    });

    /** 目的地を置いて2本の候補を作る。 */
    async function generateTwo(user: User) {
      await selectDestination(user);
      clickMap(DESTINATION);
      jobs.respond([BASE, OTHER], DESTINATION_CONDITIONS);
      await generate(user);
    }

    /** 先頭の候補で編集を始める。 */
    async function startEditing(user: User) {
      await user.click(await screen.findByRole("button", { name: "ルートを合成" }));
      await waitFor(() => expect(mapOnScreen().sourceFeatures("route-splice-bands").length).toBeGreaterThan(0));
    }

    it("編集している間は地図で地点も区間も扱わず、全部の候補を重ね、見出しに候補1本への操作を出さない。作り直すと編集が終わる", async () => {
      const { user } = renderHome();
      await generateTwo(user);
      await startEditing(user);
      expect(screen.queryByRole("button", { name: "GPX出力" })).toBeNull();
      expect(routeLinesOnMap()).toHaveLength(2);
      expect(routeLinesOnMap()).toEqual(
        expect.arrayContaining([BASE.geometry.coordinates, OTHER.geometry.coordinates]),
      );
      clickMap(ELSEWHERE);
      expect(marksAt(ELSEWHERE)).toEqual([]);
      expect(marksAt(DESTINATION)).toEqual([expect.objectContaining({ draggable: false })]);

      clickSegment(mapOnScreen().sourceFeatures("route-segments")[0], ELSEWHERE);
      await user.click(screen.getByRole("button", { name: "編集をやめて候補へ戻る" }));
      expect(screen.queryByRole("button", { name: "区間の選択を解除" })).toBeNull();

      await user.click(screen.getByRole("button", { name: "ルートを合成" }));
      jobs.respond([BASE, OTHER], DESTINATION_CONDITIONS);
      await generate(user);
      await waitFor(() => expect(mapOnScreen().sourceFeatures("route-splice-bands")).toEqual([]));
    });

    it("乗り換えの帯が区間と道に重なった所を押すと、帯の乗り換えだけを選び、区間も道も開かない", async () => {
      const { user } = renderHome();
      await showRoadSurface(user);
      await generateTwo(user);
      await startEditing(user);
      const [band] = mapOnScreen().sourceFeatures("route-splice-bands");
      const [segment] = mapOnScreen().sourceFeatures("route-segments");
      // 一番上に描かれた地物から並べる（帯は区間の上に重ねて描く）。
      clickMap(HERE, [
        { layer: "route-splice-bands-spliceBandHit", properties: band.properties ?? {}, geometry: band.geometry },
        { layer: "route-segments-detailHit", properties: segment.properties ?? {}, geometry: segment.geometry },
        { layer: "road-tiles-surface", properties: { osm_way_id: 1, feature_key: "1" } },
      ]);

      expect(await screen.findByRole("button", { name: "1つ戻す" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "この道の評価を見る" })).toBeNull();
      await user.click(screen.getByRole("button", { name: "編集をやめて候補へ戻る" }));
      expect(screen.queryByRole("button", { name: "区間の選択を解除" })).toBeNull();
    });

    it("作り直しの失敗は前の候補を残して窓で知らせ、作った合成ルートを選んでいる間は、地図に元のルートだけを重ねる", async () => {
      const { user } = renderHome();
      await generateTwo(user);
      jobs.fail("混雑しています");
      await generate(user);
      const notice = await screen.findByRole("dialog", { name: "作り直せませんでした" });
      expect(notice).toHaveAccessibleDescription("混雑しています");
      await user.click(within(notice).getByRole("button", { name: "閉じる" }));
      expect(routeLinesOnMap()).toHaveLength(2);
      await startEditing(user);
      const [band] = mapOnScreen().sourceFeatures("route-splice-bands");
      clickMap(HERE, [
        { layer: "route-splice-bands-spliceBandHit", properties: band.properties ?? {}, geometry: band.geometry },
      ]);
      jobs.respond(
        [route("evaluated", { edge_ids: ["P0-P1", "P1-Q", "Q-P2", "P2-P3", "P3-P4"] })],
        DESTINATION_CONDITIONS,
      );
      await user.click(await screen.findByRole("button", { name: "新しいルートを作成" }));

      await waitFor(() => expect(routeLinesOnMap()).toHaveLength(2));
      const [created] = linesOn("route-selected");
      expect(routeLinesOnMap()).toEqual(expect.arrayContaining([BASE.geometry.coordinates, created]));
      expect(created).not.toEqual(BASE.geometry.coordinates);
      expect(created).not.toEqual(OTHER.geometry.coordinates);
    });
  });

  it("地図の表示をまとめて戻す: 「表示」の一覧で行を全部消すとルートのほかの地図のレイヤーが消え、その一覧の絞り込みの解除は「評価で塗る」の凡例を数えず、そちらは「評価で塗る」の解除で戻す。右上のメニューの再描画は地図の描き直しを求める", async () => {
    const { user } = renderHome();
    const fromList = async <T,>(name: string, inspect: (button: HTMLButtonElement) => Promise<T> | T) => {
      await user.click(screen.getByRole("button", { name: "地図に出す情報" }));
      const result = await inspect(screen.getByRole("button", { name }) as HTMLButtonElement);
      await user.keyboard("{Escape}");
      return result;
    };
    const canRun = (name: string) => fromList(name, (button) => !button.disabled);
    const run = (name: string) => fromList(name, (button) => user.click(button));
    // ルートの線は一覧の先頭の行が出し入れし、まとめて消す操作では消さない。
    const nonRouteLayers = () =>
      mapOnScreen()
        .visibleLayerIds()
        .filter((id) => !id.startsWith("route-"));
    await showRoadSurface(user);
    expect(nonRouteLayers()).not.toEqual([]);
    const routeLayers = mapOnScreen()
      .visibleLayerIds()
      .filter((id) => id.startsWith("route-"));
    await run("表示中のレイヤーをすべて非表示");
    expect(nonRouteLayers()).toEqual([]);
    expect(mapOnScreen().visibleLayerIds()).toEqual(routeLayers);

    expect(await canRun("絞り込みをすべて解除")).toBe(false);
    await user.click(screen.getByRole("button", { name: /^評価で塗る: / }));
    await user.click(await screen.findByRole("radio", { name: /軸A/ }));
    await user.click(screen.getByRole("button", { name: "軸Aの凡例" }));
    await user.click(await screen.findByRole("checkbox", { name: "凡例の全段階をまとめて表示/非表示" }));
    await user.keyboard("{Escape}");
    expect(await canRun("絞り込みをすべて解除")).toBe(false);
    await user.click(screen.getByRole("button", { name: /^評価で塗る: / }));
    await user.click(screen.getByRole("button", { name: "絞り込みをすべて解除" }));
    expect(screen.getByRole("button", { name: "絞り込みをすべて解除" })).toBeDisabled();
    await user.keyboard("{Escape}");

    const before = mapOnScreen().styles.length;
    await user.click(screen.getByRole("button", { name: "メニュー" }));
    await user.click(screen.getByRole("button", { name: "地図の表示を再描画" }));
    expect(mapOnScreen().styles).toHaveLength(before + 1);
  });
});

describe("画面の枠", () => {
  it("走行モードの間は、上の帯を走りの数字に替え、パネルと「現在地に移動」を隠し、選んだ候補のプロファイルを見るだけで地図の下に出す。止めると元に戻る", async () => {
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
    expect(within(rideProfile()!).getByRole("img", { name: "道のりに沿った難易度" })).toBeInTheDocument();
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

  it("走行中も「表示」と「評価で塗る」を出してピルから一覧を開け、出したまま現在地を追い、走行方位・走行条件・「現在地に移動」は出さない", async () => {
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
    expect([
      screen.queryByRole("button", { name: "走行方位を設定" }),
      screen.queryByRole("group", { name: "走行条件" }),
      screen.queryByRole("button", { name: "現在地に移動" }),
    ]).toEqual([null, null, null]);
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

  it("スマホでは、走行モードの間は下部タブも隠す", async () => {
    useMobileLayout();
    const { user } = renderHome();
    expect(screen.getByRole("navigation", { name: "パネル切り替え" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "走行モード" }));
    expect(screen.queryByRole("navigation", { name: "パネル切り替え" })).toBeNull();
  });

  it("走行モードのボタンで休むか地図を指で動かすと、ルートと進み具合を残して地図の下に「現在地へ戻る」を出し、押すと休む前の進み具合から続ける。ボタンで案内を終えると止める", async () => {
    const geolocation = installGeolocation(HERE);
    const { user } = renderHome();
    jobs.respond([RIDDEN], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    const backToHere = () => screen.queryByRole("button", { name: "現在地へ戻る" });
    const moveMapByHand = () =>
      act(() => mapOnScreen().emit("movestart", { originalEvent: new MouseEvent("mousedown") }));
    const rideButton = () => screen.getByRole("button", { name: "走行モード" });
    await user.click(rideButton());
    geolocation.deliver({ ...RIDDEN_MIDDLE, accuracy: 20 });
    const rideBar = screen.getByRole("group", { name: "走りの数字" });
    expect(rideBar).toHaveTextContent("残り: 0.5km");
    expect(backToHere()).toBeNull();

    // ボタンを押すと選ぶ所を出し、休むを選ぶと走行モードのまま（ルートと進み具合を残して）休む。
    await user.click(rideButton());
    await user.click(screen.getByRole("button", { name: "休む" }));
    expect(rideButton()).toHaveAttribute("data-ride", "paused");
    expect(rideBar).toHaveTextContent("残り: 0.5km");
    // 休んでいる間も位置を受けて進み具合を当てるので、再開すると休む前の続きから進む。
    geolocation.deliver({ latitude: 35.7, longitude: 139.708, accuracy: 20 });
    expect(rideBar).toHaveTextContent("残り: 0.2km");
    await user.click(backToHere()!);
    expect(backToHere()).toBeNull();
    expect(rideButton()).toHaveAttribute("data-ride", "following");
    expect(rideBar).toHaveTextContent("残り: 0.2km");

    moveMapByHand();
    expect(backToHere()).not.toBeNull();
    await user.click(rideButton());
    await user.click(screen.getByRole("button", { name: "案内を終える" }));
    expect(screen.queryByRole("group", { name: "走りの数字" })).toBeNull();
    expect(backToHere()).toBeNull();
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

  it("スマホでは下部タブでシートを1枚ずつ開き、地図で地点を扱えるのは「ルート設定」の条件タブを開いている間だけ。結果の合図は「ルート結果」を開くまで残り、押した結果が候補を出せなかった理由（候補0件の理由・入力の誤り）はシートでなく窓で出し、閉じると消える。候補0件の合図は成功と見分ける", async () => {
    installGeolocation(null);
    useMobileLayout();
    const { user } = renderHome();
    const settingsTab = () => screen.getByRole("button", { name: "ルート設定", expanded: false });
    const outcomeTab = screen.getByRole("button", { name: "ルート結果" });
    // 現在地が取れないので、地図の印は出発地の1つだけ。
    const originMark = () => mapOnScreen().markers()[0];
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(originMark().draggable).toBe(false);

    await user.click(settingsTab());
    const settingsSheet = screen.getByRole("dialog", { name: "ルート設定" });
    await user.click(within(settingsSheet).getByRole("button", { name: "ルート生成" }));
    const notice = screen.getByRole("dialog", { name: "ルートを作れませんでした" });
    expect(notice).toHaveAccessibleDescription(/^現在地が分かりません/);
    expect(within(settingsSheet).queryByText(/^現在地が分かりません/)).toBeNull();
    expect(outcomeTab).toHaveAccessibleDescription("生成に失敗しました");
    await user.click(within(notice).getByRole("button", { name: "閉じる" }));
    expect(screen.queryByRole("dialog", { name: "ルートを作れませんでした" })).toBeNull();

    expect(originMark().draggable).toBe(true);
    await user.click(within(settingsSheet).getByRole("tab", { name: "重み" }));
    expect(originMark().draggable).toBe(false);
    await user.click(within(settingsSheet).getByRole("tab", { name: "条件" }));
    clickMap(HERE);
    jobs.respond([FIRST], LOOP_CONDITIONS);
    expect(await generate(user)).toMatchObject({ latitude: HERE.latitude, longitude: HERE.longitude });
    const outcomeSheet = await screen.findByRole("dialog", { name: "ルート結果" });
    await user.click(within(outcomeSheet).getByRole("button", { name: "閉じる" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(settingsTab());
    fireEvent.change(screen.getByLabelText("全長の目標"), { target: { value: "50" } });
    expect(outcomeTab).toHaveAccessibleDescription("生成条件が変更されています");
    jobs.respond([], LOOP_CONDITIONS, "起点の近くに道路データがありません");
    await generate(user);
    await waitFor(() => expect(outcomeTab).toHaveAccessibleDescription("候補が見つかりませんでした"));
    const empty = screen.getByRole("dialog", { name: "候補が見つかりませんでした" });
    expect(empty).toHaveAccessibleDescription("起点の近くに道路データがありません");
    await user.click(within(empty).getByRole("button", { name: "閉じる" }));
    await user.click(screen.getByRole("button", { name: "ルート設定", expanded: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("スマホで「ルート設定」から作って候補が出たら「ルート結果」のシートへ移り（開いたので結果の合図は点かない）、そこから候補を全消去できる", async () => {
    useMobileLayout();
    const { user } = renderHome();
    const outcomeTab = screen.getByRole("button", { name: "ルート結果" });
    await user.click(screen.getByRole("button", { name: "ルート設定" }));
    jobs.respond([FIRST], LOOP_CONDITIONS);
    await generate(user);

    const outcomeSheet = await screen.findByRole("dialog", { name: "ルート結果" });
    expect(screen.queryByRole("dialog", { name: "ルート設定" })).toBeNull();
    expect(outcomeTab).not.toHaveAccessibleDescription();
    await user.click(within(outcomeSheet).getByRole("button", { name: "候補を全消去" }));
    await confirmClear(user);
    expect(within(outcomeSheet).queryByRole("tablist", { name: "ルート結果" })).toBeNull();
    expect(routeLinesOnMap()).toEqual([]);
  });

  it.each([
    { leave: "シートを閉じる", outcomeSheetOpen: false },
    { leave: "「ルート結果」へ切り替える", outcomeSheetOpen: true },
  ])(
    "スマホで「ルート設定」から作ったあと、待つ間に（$leave）候補が出てもシートは移らず「ルート結果」のタブに合図が出る",
    async ({ outcomeSheetOpen }) => {
      useMobileLayout();
      const { user } = renderHome();
      const outcomeTab = screen.getByRole("button", { name: "ルート結果" });
      await user.click(screen.getByRole("button", { name: "ルート設定" }));
      const job = heldReplies();
      jobs.answerWith(job.reply);
      await generate(user);
      const settingsSheet = screen.getByRole("dialog", { name: "ルート設定" });
      await user.click(outcomeSheetOpen ? outcomeTab : within(settingsSheet).getByRole("button", { name: "閉じる" }));

      await job.answer(0, Response.json({ status: "done", result: { routes: [FIRST], conditions: LOOP_CONDITIONS } }));
      await waitFor(() => expect(outcomeTab).toHaveAccessibleDescription("新しい結果があります"));
      expect(screen.queryByRole("dialog", { name: "ルート設定" })).toBeNull();
      expect(screen.queryByRole("dialog", { name: "ルート結果" }) !== null).toBe(outcomeSheetOpen);
    },
  );

  it("スマホのシートの高さは、確定した値を2枚のシートで共有し、次に開いたときも使う", async () => {
    useMobileLayout();
    const { user, unmount } = renderHome();
    await user.click(screen.getByRole("button", { name: "ルート設定" }));
    const handle = screen.getByRole("separator", { name: "パネルの高さを変更" });
    handle.focus();
    await user.keyboard("{ArrowUp}");
    expect(handle).toHaveAttribute("aria-valuenow", "55");
    unmount();

    renderHome();
    await user.click(screen.getByRole("button", { name: "ルート結果" }));
    expect(screen.getByRole("separator", { name: "パネルの高さを変更" })).toHaveAttribute("aria-valuenow", "55");
  });

  it("区分の開閉は、次に開いたときも同じになる", async () => {
    const { user, unmount } = renderHome();
    await user.click(section("ルート設定"));
    unmount();

    renderHome();
    expect(section("ルート設定")).toHaveAttribute("aria-expanded", "false");
    expect(section("ルート結果")).toHaveAttribute("aria-expanded", "true");
  });

  it("ヘッダーの「未取得」に、現在地・軸の一覧・警報の取れないものが並ぶ。「現在地に移動」が取れなければ地図の上に理由を出す", async () => {
    installGeolocation(null);
    onBackend("GET", "/api/axis-catalog", () => Response.json({ detail: "失敗" }, { status: 502 }));
    onBackend("GET", "/api/weather/warnings", () => Response.json({ detail: "失敗" }, { status: 502 }));
    const { user } = renderHome();
    const missing = () => screen.getByRole("button", { name: /を取得できていません。押すと/ });
    await waitFor(() => expect(missing()).toHaveAccessibleName(/現在地.*評価軸の一覧|評価軸の一覧.*現在地/));
    expect(missing()).not.toHaveAccessibleName(/警報/);

    await user.click(screen.getByRole("button", { name: "現在地に移動" }));
    expect(screen.getByText(/現在地を取得できませんでした/)).toBeInTheDocument();

    clickMap(HERE);
    await waitFor(() => expect(missing()).toHaveAccessibleName(/警報/));
    expect(missing()).not.toHaveAccessibleName(/現在地/);
  });

  it("「現在地に移動」は現在地を取り直して地図を寄せ、出発地は変えずに現在地に点を出す", async () => {
    const { user } = renderHome();
    clickMap(ELSEWHERE);
    expect(marksAt(ELSEWHERE)).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "現在地に移動" }));

    expect(marksAt(ELSEWHERE)).toHaveLength(1);
    expect(screen.getByRole("img", { name: "現在地" })).toBeInTheDocument();
    expect(marksAt(HERE).map(({ element }) => element.getAttribute("aria-label"))).toEqual(["現在地"]);
  });

  it("メニューから使い方の説明に入って「やめる」で抜け、デバッグログをメニューから開いてログの側から閉じられる", async () => {
    const { user } = renderHome();
    // 地図を開いたあとに入れる（代役の地図は基礎地図の道路を持たず、地図がそのことをデバッグログへ警告する）。
    act(() => setDebugEnabled(true));
    await user.click(screen.getByRole("button", { name: "メニュー" }));
    await user.click(screen.getByRole("button", { name: "使い方を見る" }));
    expect(screen.getByText("説明モード")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "やめる" }));
    expect(screen.queryByText("説明モード")).toBeNull();

    await user.click(screen.getByRole("button", { name: "メニュー" }));
    await user.click(screen.getByRole("button", { name: "デバッグログを表示" }));
    expect(screen.getByText(/^デバッグログ\[/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^デバッグログ\[.*を閉じる$/ }));
    expect(screen.queryByText(/^デバッグログ\[/)).toBeNull();
  });
});
