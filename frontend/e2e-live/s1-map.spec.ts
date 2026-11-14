import { expect, test } from "@playwright/test";
import { branch, expectNoOwnFailures, externalErrors, fetchCatalog, openLive, reportExternal } from "./live";
import { chooseLens, currentLensLabel, renderedRoads, roadSourceId, settleMap } from "./mapReads";
import { allLayersOn, longPressRoad } from "../e2e/fixtures";
import { FEATURE_KEY_PROPERTY } from "@/features/map/scene/groups/roadLines";
import materialCatalog from "@/types/generated/material-catalog.json";

/** 道の詳細が必ず持つ行（路面の種類）の項目名。名前は材料カタログが持つ。 */
const SURFACE_ROW_LABEL = materialCatalog.find((material) => material.material_id === "surface")!.name;

// S1 地図の描画（生成前）。実データが式・部品へ入って初めて壊れるもの（レンズの道ごとの材料が届かず地図に出ない・
// 巻き添えで消える、取得の失敗が空で返る、道を押すと例外で開かない）を見る。
// 幹: 起点を現在地として与え、全レイヤーONで開く。枝: 下のC〜G。

test("S1 地図の描画（生成前）", async ({ page }) => {
  const catalog = await fetchCatalog();
  const { lenses } = catalog;
  expect(lenses.length, "レンズが1つも無い").toBeGreaterThan(0);
  const statsBefore = await externalErrors();

  const watch = await openLive(page, { storedState: allLayersOn(catalog.config.road_classes.map_layers) });
  const source = await roadSourceId(page);

  // C: 地図のエラー（取得の失敗も含む）が0件。
  expect.soft(watch.mapErrors, "[map:error]（取得の失敗を含む）").toEqual([]);

  // D: 表示範囲の路面タイルに道が1件以上。
  const tileRoads = [...watch.roadTiles.values()].flat();
  expect(tileRoads.length, "取得した路面タイルに道が無い").toBeGreaterThan(0);

  // E→F: レンズを1つずつ選ぶ → そのレンズの材料を持つ道が描かれている。
  const originalLens = await currentLensLabel(page, catalog);
  for (const lens of lenses) {
    await branch(
      page,
      `レンズ「${lens.label}」`,
      async () => {
        const errorsBefore = watch.mapErrors.length;
        const materialsBefore = watch.wayMaterials.length;
        await chooseLens(page, lens.label);
        await settleMap(page);
        const drawn = await renderedRoads(page, source);
        expect.soft(drawn.length, `「${lens.label}」: 道が描かれていない`).toBeGreaterThan(0);
        // 道ごとの材料を受け取り、それが描かれている道を指すこと（材料の鍵は路面の地物の鍵）。
        const received = watch.wayMaterials.slice(materialsBefore).filter((entry) => entry.lensId === lens.lensId);
        const featureKeys = new Set(received.flatMap((entry) => Object.keys(entry.materials)));
        expect.soft(featureKeys.size, `「${lens.label}」: 道ごとの材料を1件も受け取っていない`).toBeGreaterThan(0);
        const drawnWithMaterials = drawn.filter((road) => featureKeys.has(String(road[FEATURE_KEY_PROPERTY]))).length;
        expect
          .soft(drawnWithMaterials, `「${lens.label}」: 材料を受け取った道が1本も描かれていない`)
          .toBeGreaterThan(0);
        expect.soft(watch.mapErrors.slice(errorsBefore), `「${lens.label}」を選んだあとの[map:error]`).toEqual([]);
      },
      () => chooseLens(page, originalLens),
    );
  }

  // G: 道を1本長押しする → 道の詳細が開き、例外・エラー表示が無い。
  const popup = page.locator(".maplibregl-popup");
  await branch(
    page,
    "道を押す",
    async () => {
      const errorsBefore = watch.pageErrors.length;
      await longPressRoad(page);
      await expect(popup).toBeVisible({ timeout: 10_000 });
      // 開いたのが道の詳細であること（道の詳細は路面の種類の行を必ず持つ。属性は畳んで開くので、開いてから見る）。
      // 描画の例外はエラー境界（app/error.tsx）が受けてページの例外にならないので、中身が出たかで見る。
      await popup.getByText("この道の属性", { exact: true }).click();
      await expect(popup.getByText(SURFACE_ROW_LABEL, { exact: true })).toBeVisible();
      await settleMap(page);
      expect.soft(watch.pageErrors.slice(errorsBefore), "道を押したあとのページの例外").toEqual([]);
      await expect.soft(popup.getByRole("alert")).toHaveCount(0);
    },
    async () => {
      await page.keyboard.press("Escape");
      if (await popup.isVisible()) {
        await page.locator(".maplibregl-popup-close-button").click();
      }
      await expect(popup).toBeHidden();
    },
  );

  expectNoOwnFailures(watch);
  reportExternal(watch, statsBefore, await externalErrors());
});
