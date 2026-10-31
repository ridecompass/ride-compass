import { expect, type Locator, type Page } from "@playwright/test";
import type { components } from "@/types/generated/api";
import {
  amedasObservationFixture,
  defaultAxisCatalogFixture,
  doneJobFixture,
  E2E_ROAD_LAYERS,
  gridPointTodayFixture,
} from "./mockResponses";
import { installMapFinder } from "./liveMap";
import { mapDisplay } from "@/types/generated/mapDisplay";
import nextConfig from "../next.config";

// 応答の雛形と地図を押す段取りは別のファイルが持ち、ここから出し直す（撮影の口 `capture/context.ts` の `fixtures` は
// このモジュールごと載せるので、脚本はどれもここから呼べる）。
export * from "./mockResponses";
export * from "./liveMap";

// CIのE2Eスモークテストは「実バックエンド＋実外部API（
// OpenFreeMap）」には依存しない。APIコントラクトの正しさはCIのapi-contractジョブ
// （OpenAPIドリフト検知）が別途担保しており、E2Eはフロントの画面挙動（生成→表示、
// レイヤー切替）だけを決定的に検証する。バックエンドプロセスの起動・DB・APIキーが
// 不要になるぶん、CIが速く安定する。

/** モックを当てるbackendの宛先。試すアプリがビルドに焼き込んだ宛先（`NEXT_PUBLIC_API_URL`）と同じでないと、モックが当たらない。
 * CIは本番の宛先を焼き込んだ像の中身を試すので、その宛先を`E2E_API_BASE`で渡す。 */
export const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:8000";

/**
 * バックエンド・外部APIへの依存を断ち切るネットワークモックを登録する。
 * 各テストの冒頭（page.goto前）で呼ぶ。ここの応答はアプリを起動して画面を進めるための
 * 既定値であり、テストが判定する値を持たせない（.claude/rules/testing-e2e.md パターン4）。
 * テストが自分の値を返すときは、この後に同じURLへ`page.route`を登録する（後から登録した
 * ルートが先に当たる）。
 */
export async function installApiMocks(page: Page): Promise<void> {
  // 現在地を渡す。位置が取れない間は出発地が仮の地点のままで、生成が断られる。地点は候補の線の始点。
  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({ latitude: 35.7597, longitude: 139.7387 });

  // どのモックにも当たらないbackendへの要求は、ブラウザの外へ出さずに接続の拒否で返す（後から登録したルートが先に
  // 当たるので、最初に置いたこれは残りだけに当たる）。宛先が本番のbackendでも、要求は本番へ届かない。
  await page.route(`${API_BASE}/**`, (route) => route.abort("connectionrefused"));

  await page.route(`${API_BASE}/health`, (route) => route.fulfill({ json: { status: "ok" } }));

  await page.route(`${API_BASE}/api/weather/amedas*`, (route) => route.fulfill({ json: amedasObservationFixture() }));
  // `*` は `/` を越えないので、`/api/weather/...` の口には当たらない。
  await page.route(`${API_BASE}/api/weather?*`, (route) => route.fulfill({ json: gridPointTodayFixture() }));
  // 警告バッジ3種は「警告なし」の成功応答にする。応答しないと取得失敗の印がヘッダーに出る。
  const noWarnings: components["schemas"]["WeatherWarnings"] = { warnings: [], valid_area: null };
  const noWbgt: components["schemas"]["WbgtStatus"] = { reading: null, valid_area: null };
  const noFlood: components["schemas"]["FloodForecasts"] = { forecasts: [], valid_area: null };
  await page.route(`${API_BASE}/api/weather/warnings*`, (route) => route.fulfill({ json: noWarnings }));
  await page.route(`${API_BASE}/api/weather/wbgt*`, (route) => route.fulfill({ json: noWbgt }));
  await page.route(`${API_BASE}/api/weather/flood-forecast*`, (route) => route.fulfill({ json: noFlood }));
  // ルートを通る時刻の警報級の見込みも、通る区域が無い成功応答にする（選んだ候補があると取りに行く）。
  const noRouteTimeline: components["schemas"]["RouteWarningTimeline"] = { areas: [] };
  await page.route(`${API_BASE}/api/weather/route-warning-timeline`, (route) =>
    route.fulfill({ json: noRouteTimeline }),
  );

  // ルート生成はジョブで動く。POST（ジョブ投稿）は
  // 即座にjob_idを返し、GET .../generate/{job_id}（ポーリング）は1回目から
  // status="done"を返す（e2eはUI操作の疎通確認が目的で、待ち状態の遷移自体は
  // frontend/src/features/route/routeApi.test.tsが検証するためここでは再現しない）。
  await page.route(`${API_BASE}/api/routes/generate`, (route) =>
    route.fulfill({ status: 202, json: { job_id: "e2e-fake-job" } }),
  );
  await page.route(`${API_BASE}/api/routes/generate/*`, (route) => route.fulfill({ json: doneJobFixture() }));

  await page.route(`${API_BASE}/api/axis-catalog*`, (route) => route.fulfill({ json: defaultAxisCatalogFixture() }));
  // 軸のレンズで塗る道ごとの材料。材料を持つ道が無い形で答える。
  await page.route(`${API_BASE}/api/region/way-materials/**`, (route) => route.fulfill({ json: {} }));
  await page.route(`${API_BASE}/api/region/road-classes/**`, (route) => route.fulfill({ json: {} }));

  // 地点の詳しくが、置いた位置の辺りを引く。辺り無し（境界の外）で答える。
  await page.route(`${API_BASE}/api/place-area*`, (route) => route.fulfill({ json: { area: null } }));

  // Next.jsのrewritesでbackendへ中継される経路（タイル・時刻一覧等）。モックしないと、E2Eの
  // サーバーの中継が接続拒否をログへ出し続ける。経路は next.config.ts の宣言から取り、中身無しで
  // 返す。応答に中身が要る経路は、この後で個別に上書きする（後から登録したルートが先に当たる）。
  for (const { source } of await rewriteRules()) {
    await page.route(`**${source.replace("/:path*", "/**")}`, (route) =>
      route.fulfill({ status: 204, body: Buffer.alloc(0) }),
    );
  }

  // 基礎地図スタイル（/api/basemap/styles/liberty）と、それ以外のbasemap配下を、sources/layersの空の自己完結スタイルで応答する
  // （外部タイル・グリフ・スプライトへの追加リクエストが起きない。地図の見た目は検証対象外）。
  await page.route("**/api/basemap/**", (route) => route.fulfill({ json: { version: 8, sources: {}, layers: [] } }));

  // 気象庁の時刻一覧は配列が要る。空の配列（取得できたが時刻が無い）で返す。
  await page.route(
    (url) => url.pathname.startsWith("/api/jma-tile/") && url.pathname.includes("/targetTimes"),
    (route) => route.fulfill({ json: [] }),
  );
}

async function rewriteRules(): Promise<{ source: string }[]> {
  const rules = (await nextConfig.rewrites?.()) ?? [];
  return Array.isArray(rules)
    ? rules
    : [...(rules.beforeFiles ?? []), ...(rules.afterFiles ?? []), ...(rules.fallback ?? [])];
}

// ここから下は「UIを見たい場所まで進める」導線のヘルパー。テストごとに書き直すと、
// UIの中身とは無関係な段取り（シートを開く・生成の完了を待つ）で落ちて時間を使うため、
// 1箇所へ集約する。

/** スマホ縦持ち相当。useIsMobile（CSSの`--breakpoint-mobile`より狭い幅で立つ`--is-mobile`の旗）のモバイル分岐に入る幅。 */
export const MOBILE_VIEWPORT = { width: 390, height: 812 };

/** モバイルの下部タブバーが持つシート。値はタブのラベル兼シートのアクセシブル名。 */
export type MobileSheetName = "ルート設定" | "ルート結果";

/**
 * localStorageの初期値を流し込む（goto前に呼ぶ）。保存される画面状態（レイヤーのON/OFF・
 * シートの高さ・重みづけ等、page.tsxのStorage key定数）は、クリックで作らずここで与える。
 * 値はuseStoredStateのserializeが書く形式そのもの（キーによって生文字列とJSONがある）。
 */
export async function seedStoredState(page: Page, entries: Record<string, string>): Promise<void> {
  await page.addInitScript((items) => {
    for (const [key, value] of Object.entries(items)) {
      window.localStorage.setItem(key, value);
    }
  }, entries);
}

/** 初回の案内（地図の上に重なる）を閉じた保存状態。 */
export const INTRO_CLOSED: Record<string, string> = { "ridecompass:first-visit-intro-closed": "true" };

/** 全レイヤーONとデバッグログ（`[map:error]`を読むため）の保存状態。道の線の層は軸カタログが配るので、開く先の軸カタログの
 * 層を渡す（既定はモックの層）。 */
export function allLayersOn(roadLayers: readonly { id: string }[] = E2E_ROAD_LAYERS): Record<string, string> {
  const ids = [...mapDisplay.layers, ...roadLayers].map(({ id }) => id);
  return {
    "ridecompass:debug-enabled": "1",
    "ridecompass:layer-visibility": JSON.stringify(Object.fromEntries(ids.map((id) => [id, true]))),
  };
}

/**
 * スマホのキーボードの高さ（CSS の px）。Apple は高さを公開せず、アプリには実行時に測るよう求めるので、出どころは
 * 実測: iOS 27 のシミュレータで、6.1 型の iPhone（17e・18 Pro）の英字のキーボードが 301pt（変換の候補の帯なし。
 * https://github.com/Saffsanity/sill/pull/30 のコミット 9ee69c7）。
 */
export const KEYBOARD_HEIGHT = 301;

type OpenOptions = { storedState?: Record<string, string>; routes?: (page: Page) => Promise<unknown> };

/**
 * 今のビューポートでアプリを開き（APIモックの登録・goto）、地図の読み込みが終わるまで待つ。`window.__liveMap()`で地図を引ける。
 * `routes`は既定のモックの後・goto前に呼ばれる——テストが判定に使う応答や、置き直す現在地はここで与える。
 * 呼んだ直後は、まだクリックが効かない（ハイドレーション前の）可能性がある——
 * 操作はopenMobileSheet等のヘルパー経由で行う。
 * 初回の案内（地図の上に重なる）は閉じた状態で開く。
 */
export async function openMapApp(page: Page, { storedState, routes }: OpenOptions = {}): Promise<void> {
  await installApiMocks(page);
  if (routes) await routes(page);
  await seedStoredState(page, { ...INTRO_CLOSED, ...storedState });
  await page.addInitScript(installMapFinder);
  await page.goto("/");
  await expect(page.getByText("地図を読み込み中…")).toBeHidden({ timeout: 15_000 });
}

/** モバイル幅（`MOBILE_VIEWPORT`）で`openMapApp`する。 */
export async function openMobileApp(page: Page, options: OpenOptions = {}): Promise<void> {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await openMapApp(page, options);
}

/**
 * 下部シートを開く（既に開いていれば何もしない）。タブの再タップは閉じる操作なので、
 * 開閉状態を見てから押す。ハイドレーション前のクリックは画面に何も起こさないため、
 * 「押して開くまで」を再試行する（固定のwaitForTimeoutを置かない）。
 */
export async function openMobileSheet(page: Page, name: MobileSheetName) {
  const sheet = page.getByRole("dialog", { name });
  await expect(async () => {
    if (!(await sheet.isVisible())) {
      await page.getByRole("button", { name, exact: true }).click();
    }
    await expect(sheet).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  return sheet;
}

/**
 * 「ルート設定」シートから全長の目標を指定してルートを生成し、候補が出て移った「ルート結果」シートを返す。
 * @public 撮影の脚本が口（`capture/context.ts`の`fixtures`）越しに呼ぶ。knipは口越しの呼び出しを辿れない。
 */
export async function generateRoutes(page: Page, { distanceKm = 20 }: { distanceKm?: number } = {}) {
  const sheet = await openMobileSheet(page, "ルート設定");
  await setDistance(sheet, distanceKm);
  return generateInMobileSheet(page, sheet);
}

/** 開いている「ルート設定」シートの全長の目標のルーラーを、キー操作で`distanceKm`（5km刻み）のコマへ合わせる。 */
export async function setDistance(sheet: Locator, distanceKm: number) {
  const ruler = sheet.getByRole("slider", { name: "全長の目標", exact: true });
  await ruler.focus();
  await ruler.press("Home");
  for (let km = 5; km < distanceKm; km += 5) await ruler.press("ArrowRight");
  await expect(ruler).toHaveAttribute("aria-valuetext", `${distanceKm}km`);
}

/** 開いている「ルート設定」シートで「ルート生成」を押し、候補が出て「ルート結果」シートへ移るまで待って、そのシートを返す。
 * 候補が出ない応答では移らないので、候補0件・失敗を見るテストは使わない。 */
export async function generateInMobileSheet(
  page: Page,
  settings: Locator,
  { timeout = 60_000 }: { timeout?: number } = {},
): Promise<Locator> {
  await settings.getByRole("button", { name: "ルート生成" }).click();
  const outcome = page.getByRole("dialog", { name: "ルート結果" });
  await expect(outcome, "候補が出ず「ルート結果」へ移らなかった（候補0件・失敗は窓で知らせる）").toBeVisible({
    timeout,
  });
  return outcome;
}

/** 「ルート生成」を押し、生成が終わってボタンが再び押せるまで待つ。`scope`はボタンを含む範囲
 * （スマホ幅はシート、それ以外は画面）。スマホ幅で候補が出ると「ルート設定」シートを離れるので、そのときは
 * `generateInMobileSheet`を使う。 */
export async function runGeneration(
  scope: Page | Locator,
  { timeout = 60_000 }: { timeout?: number } = {},
): Promise<void> {
  await scope.getByRole("button", { name: "ルート生成" }).click();
  await expect(scope.getByRole("button", { name: "ルート生成" })).toBeEnabled({ timeout });
}
