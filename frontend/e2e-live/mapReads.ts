import { expect, type Locator, type Page } from "@playwright/test";
import { featureFilter } from "@maplibre/maplibre-gl-style-spec";
import type { LiveCatalog } from "./live";
import { ROUTE_HIT_TARGET_SEGMENT } from "@/features/map/scene/groups/routes";

// 実backendへ向けて開いた地図の読み終わりを待ち、描かれたもの（路面・ルートの区間・レンズ）を読む。

/**
 * 地図の全ソースのタイルが読み終わるまで待つ。MapLibreの`idle`は、動き続けるレイヤー（時刻で進む気象の表示等）が
 * あると来ないので使わない。読み終わらないソースは名前を出して落とす。
 */
export async function settleMap(page: Page): Promise<void> {
  const pending = await page.evaluate(async () => {
    const map = window.__liveMap();
    const unloaded = () => Object.keys(map.getStyle().sources).filter((id) => !map.isSourceLoaded(id));
    const deadline = performance.now() + 45_000;
    let streak = 0;
    while (performance.now() < deadline) {
      streak = unloaded().length === 0 ? streak + 1 : 0;
      if (streak >= 3) return [];
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return unloaded();
  });
  expect(pending, "45秒たっても読み終わらない地図のソース").toEqual([]);
  await page.evaluate(() => window.__e2e.settle());
}

/** 路面タイルのソースのid（スタイルのうち、タイルのURLが路面タイルの経路を指すもの）。 */
export async function roadSourceId(page: Page): Promise<string> {
  const id = await page.evaluate(() => {
    const sources = window.__liveMap().getStyle().sources;
    return (
      Object.entries(sources).find(([, source]) =>
        ((source as { tiles?: string[] }).tiles ?? []).some((url) => url.includes("/road-surface-tiles/")),
      )?.[0] ?? null
    );
  });
  expect(id, "路面タイルのソースがスタイルに無い").not.toBeNull();
  return id!;
}

/** いま描かれている路面の地物のプロパティ（画面に出ている範囲）。 */
export async function renderedRoads(page: Page, sourceId: string): Promise<Record<string, unknown>[]> {
  return page.evaluate(
    (source) =>
      window
        .__liveMap()
        .queryRenderedFeatures()
        .filter((feature) => feature.source === source)
        .map((feature) => feature.properties),
    sourceId,
  );
}

/** 「負担で塗る」のピル（押すとレンズの一覧を開く）。 */
function lensPill(page: Page) {
  return page.getByRole("button", { name: /^負担で塗る: / });
}

/** レンズの一覧を開いて`read`を当て、Escape で閉じる。 */
async function inLensList<T>(page: Page, read: (group: Locator) => Promise<T>): Promise<T> {
  await lensPill(page).click();
  const group = page.getByRole("radiogroup", { name: "負担で塗る" });
  await expect(group).toBeVisible();
  const result = await read(group);
  await page.keyboard.press("Escape");
  await expect(group).toBeHidden();
  return result;
}

/** レンズを名前で選ぶ（null はレンズを選んでいない状態へ戻す）。一覧は選んでも閉じず、選んでいる行をもう一度押すと外れるので、
 *  選び済みなら押さず、Escape で閉じる。行の名前には走る条件の印が続くので、名前の要素で当てる。 */
export async function chooseLens(page: Page, label: string | null): Promise<void> {
  await inLensList(page, async (group) => {
    if (label === null) {
      const clear = page.getByRole("button", { name: "選択を外す" });
      if (await clear.isEnabled()) await clear.click();
    } else {
      const row = group.getByRole("radio").filter({ has: page.getByText(label, { exact: true }) });
      if ((await row.getAttribute("aria-checked")) !== "true") await row.click();
    }
  });
}

/** 今のレンズの名前。一覧で選んでいる行が無ければ、レンズを選んでいない（null）。ピルの名前は、選んでいない状態と
 *  あるレンズを選んだ状態で同じになりうるので読まない。 */
export async function currentLensLabel(page: Page, catalog: LiveCatalog): Promise<string | null> {
  return inLensList(page, async (group) => {
    const checked = group.getByRole("radio", { checked: true });
    for (const { label } of catalog.lenses) {
      if ((await checked.getByText(label, { exact: true }).count()) > 0) return label;
    }
    return null;
  });
}

/**
 * 選んでいる候補のルートの区間のうち、描かれている数と、そのうち「データなし」でない（いまのレンズの値で塗られた）数。
 * 区間は scene が区間の当たり判定（`ROUTE_HIT_TARGET_SEGMENT`）を宣言したソースで引き、「データなし」かは、いまの地図が
 * 区間の線に当てている「値が無ければ破線にする」式の条件を、MapLibre の式の評価器で区間のデータに当てて決める（塗り方の規則を
 * ここで書き直さない）。区間のデータは地図への問い合わせ（`queryRenderedFeatures`）ではなくソースから取る——問い合わせが返す地物は
 * 入れ子のプロパティ（`lens_seconds_per_km` 等）を文字列にしていて、式の条件がどの区間にも当たらない。
 */
export async function routeSegmentsPainted(page: Page): Promise<{ drawn: number; withValue: number }> {
  const { missing, drawn, segments } = await page.evaluate(async (target) => {
    const map = window.__liveMap();
    const layers = window.__liveScene().layers.map((layer) => ({
      ...layer,
      spec: layer.spec as { id: string; source?: string; paint?: Record<string, unknown> },
    }));
    const sources = new Set(
      layers.filter((layer) => layer.hitTargets.includes(target)).map((layer) => layer.spec.source),
    );
    const dashOf = (layer: (typeof layers)[number]) => layer.spec.paint?.["line-dasharray"];
    const line = layers.find((layer) => {
      const dash = dashOf(layer);
      return sources.has(layer.spec.source) && Array.isArray(dash) && dash[0] === "case";
    });
    if (!line) throw new Error("ルートの区間の線に「データなし」の式が無い（いまのレンズが値という考えを持たない）");
    const source = map.getSource(line.spec.source!) as unknown as { getData(): Promise<GeoJSON.FeatureCollection> };
    return {
      missing: (dashOf(line) as unknown[])[1],
      drawn: map.queryRenderedFeatures({ layers: [line.spec.id] }).length,
      segments: (await source.getData()).features.map((feature) => feature.properties ?? {}),
    };
  }, ROUTE_HIT_TARGET_SEGMENT);
  const hasValue = featureFilter(["!", missing] as never, "ルートの区間の値あり");
  const withValue = segments.filter((properties) =>
    hasValue.filter({ zoom: 0 }, { type: 2, properties } as never),
  ).length;
  return { drawn, withValue };
}
