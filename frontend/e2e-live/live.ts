import { expect, type Page, type Response } from "@playwright/test";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import type { AxisCatalogResponse } from "@/types/route";
import regionTileConfig from "@/types/generated/region-tile-config.json";
import { lonLatToTileIndex } from "@/features/map/layers/webMercatorTile";
import { INTRO_CLOSED, MOBILE_VIEWPORT, installMapFinder, seedStoredState } from "../e2e/fixtures";
import { installPageHelpers } from "../e2e/pageHelpers";
import { settleMap } from "./mapReads";

// 実backendへ向けて回すe2eの共通の段取りと観測（.claude/skills/run-checks/SKILL.md「E2E・画面の撮影の走らせ方」）。
// 期待値は値そのものではなく性質（1件以上ある・2つの出どころが食い違わない・エラー0件）で書く。

/** 向けるbackend。アプリのビルドが埋め込む向け先（`NEXT_PUBLIC_API_URL`）と同じにする。既定は手元のbackend。 */
export const LIVE_API = process.env.E2E_LIVE_API ?? "http://localhost:8000";

/** 起点。backendのDBの取込範囲はリポジトリに記録が無いので、範囲から推測せず環境変数で与える。既定はアプリの既定地点。 */
export const LIVE_POINT = (() => {
  const [latitude, longitude] = (process.env.E2E_LIVE_POINT ?? "35.7597,139.7387").split(",").map(Number);
  return { latitude, longitude };
})();

export async function fetchCatalog(): Promise<AxisCatalogResponse> {
  const response = await fetch(`${LIVE_API}/api/axis-catalog`);
  if (!response.ok) throw new Error(`軸カタログの取得に失敗: ${response.status}`);
  return (await response.json()) as AxisCatalogResponse;
}

export function tileOf(z: number, { latitude, longitude }: { latitude: number; longitude: number }) {
  const [x, y] = lonLatToTileIndex(longitude, latitude, z);
  return { z, x, y };
}

/** 路面タイル（MVT）の地物ごとのプロパティ。 */
export function decodeRoadTile(body: Buffer): Record<string, unknown>[] {
  const tile = new VectorTile(new PbfReader(body));
  const layer = tile.layers[regionTileConfig.road_surface.layer_name];
  if (!layer) return [];
  return Array.from({ length: layer.length }, (_, i) => layer.feature(i).properties);
}

/** ページで起きた失敗の記録。`[map:error]`は取得の失敗（sourceIdを持つもの）も含めて数える。 */
export interface Watch {
  mapErrors: string[];
  pageErrors: string[];
  /** アプリがbackendから受け取った、backend自前の処理の失敗（429と、502・503・504以外の5xx、本文を解釈できない応答）。 */
  backendFailures: string[];
  /** backendが上流（外部の配信元・キャッシュ）の失敗として返した502・503・504（HTTPの定義で上流の失敗を表す）。合否に入れない。 */
  gatewayFailures: string[];
  roadTiles: Map<string, Record<string, unknown>[]>;
  wayMaterials: { axisId: string; url: string; materials: Record<string, Record<string, number>> }[];
  jmaTiles: { url: string; body: Buffer }[];
  generated: { routes: unknown[]; no_candidates_reason: string | null }[];
}

const ROAD_TILE = /\/api\/region\/road-surface-tiles\/(\d+)\/(\d+)\/(\d+)\.pbf/;
const WAY_MATERIALS = /\/api\/region\/way-materials\/([^/]+)\//;

async function record(watch: Watch, response: Response): Promise<void> {
  const url = response.url();
  const isBackend = url.startsWith(LIVE_API) || /\/api\//.test(new URL(url).pathname);
  const status = response.status();
  if (isBackend && [502, 503, 504].includes(status)) watch.gatewayFailures.push(`${status} ${url}`);
  else if (isBackend && (status >= 500 || status === 429)) watch.backendFailures.push(`${status} ${url}`);
  if (!response.ok()) return;
  const road = ROAD_TILE.exec(url);
  const wayMaterials = WAY_MATERIALS.exec(url);
  const isJmaTile = url.includes("/api/jma-tile/") && url.endsWith(".png");
  const isGeneration = url.includes("/api/routes/generate/");
  if (!road && !wayMaterials && !isJmaTile && !isGeneration) return;
  let body: Buffer;
  try {
    body = await response.body();
  } catch {
    // ページを離れた後に本文を読もうとした応答は数えない（本文が無いことは失敗の記録に入らない）。
    return;
  }
  try {
    if (road) watch.roadTiles.set(`${road[1]}/${road[2]}/${road[3]}`, decodeRoadTile(body));
    else if (wayMaterials)
      watch.wayMaterials.push({ axisId: wayMaterials[1], url, materials: JSON.parse(body.toString("utf-8")) });
    else if (isJmaTile) watch.jmaTiles.push({ url, body });
    else {
      const job = JSON.parse(body.toString("utf-8"));
      if (job.status === "done" && job.result) watch.generated.push(job.result);
    }
  } catch (error) {
    watch.backendFailures.push(`本文を解釈できない ${url}: ${String(error)}`);
  }
}

/**
 * 実backendへ向けてアプリを開き（既定はモバイル幅）、地図の読み込みが終わるまで待つ。
 * 起点はブラウザの現在地として、レイヤーのON/OFF等は保存状態として与える（利用者の操作を真似ない）。
 * 初回の案内（地図の上に重なる）は閉じた状態で開く。
 */
export async function openLive(
  page: Page,
  {
    storedState = {},
    viewport = MOBILE_VIEWPORT,
  }: { storedState?: Record<string, string>; viewport?: { width: number; height: number } } = {},
) {
  const watch: Watch = {
    mapErrors: [],
    pageErrors: [],
    backendFailures: [],
    gatewayFailures: [],
    roadTiles: new Map(),
    wayMaterials: [],
    jmaTiles: [],
    generated: [],
  };
  page.on("console", (message) => {
    if (message.text().includes("[map:error]")) watch.mapErrors.push(message.text());
  });
  page.on("pageerror", (error) => watch.pageErrors.push(String(error)));
  page.on("response", (response) => void record(watch, response));

  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation(LIVE_POINT);
  await page.setViewportSize(viewport);
  await page.addInitScript(installPageHelpers);
  await page.addInitScript(installMapFinder);
  await seedStoredState(page, { ...INTRO_CLOSED, ...storedState });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "メニュー" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("地図を読み込み中…")).toBeHidden({ timeout: 60_000 });
  await settleMap(page);
  return watch;
}

/**
 * 幹の終点から枝を1本見て、元へ戻す。戻せたかは地図の指紋（`window.__e2e.settle()`の`fp`。開閉の値と倍率）で確かめ、戻らなければ違反として落とす。
 * 枝の失敗（`expect.soft`）は他の枝を止めない。
 */
export async function branch(page: Page, name: string, body: () => Promise<void>, restore: () => Promise<void>) {
  const before = (await page.evaluate(() => window.__e2e.settle())).fp;
  const started = Date.now();
  try {
    await body();
  } catch (error) {
    expect.soft(String(error), `枝「${name}」が例外で止まった`).toBe("");
  }
  await restore();
  const after = (await page.evaluate(() => window.__e2e.settle())).fp;
  console.log(`[e2e-live] 枝「${name}」 ${((Date.now() - started) / 1000).toFixed(1)}秒`);
  expect(after, `枝「${name}」のあと元の状態へ戻らない`).toBe(before);
}

/** 前提が成り立たず判定しなかった枝を、黙って緑にせずログへ出す。 */
export function notApplicable(name: string, reason: string): void {
  console.log(`[e2e-live] 該当なし: ${name}（${reason}）`);
}

/** 後始末の検査: backendの外部呼び出しのカテゴリごとのエラーの増え方。合否には入れず「外部要因」として必ず出す。 */
export async function externalErrors(): Promise<Record<string, number>> {
  const stats = (await (await fetch(`${LIVE_API}/api/debug/stats`)).json()) as {
    external: Record<string, { errors: number }>;
  };
  return Object.fromEntries(Object.entries(stats.external).map(([category, s]) => [category, s.errors]));
}

export function reportExternal(watch: Watch, before: Record<string, number>, after: Record<string, number>): void {
  if (watch.gatewayFailures.length > 0) {
    console.log(
      `[e2e-live] 外部要因（backendが上流の失敗として返した応答。合否に入れない）: ${watch.gatewayFailures.join(", ")}`,
    );
  }
  const grown = Object.entries(after)
    .map(([category, errors]) => [category, errors - (before[category] ?? 0)] as const)
    .filter(([, delta]) => delta > 0);
  console.log(
    grown.length === 0
      ? "[e2e-live] 外部要因: なし"
      : `[e2e-live] 外部要因（backendの外部呼び出しのエラーの増分。合否に入れない）: ${grown.map(([c, d]) => `${c} +${d}`).join(", ")}`,
  );
}

/** 幹の最後に見る、自前の失敗の不在（ページの例外・backendの5xx/429・解釈できない本文）。 */
export function expectNoOwnFailures(watch: Watch): void {
  expect.soft(watch.pageErrors, "ページの例外").toEqual([]);
  expect
    .soft(watch.backendFailures, "backend自前の失敗（429と、502・503・504以外の5xx、本文を解釈できない応答）")
    .toEqual([]);
}
