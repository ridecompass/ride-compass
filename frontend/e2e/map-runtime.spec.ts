import { expect, test, type Page } from "@playwright/test";
import { allLayersOn, installApiMocks, runGeneration, seedStoredState } from "./fixtures";

// 地図（MapLibre）が実ブラウザでしか見せない挙動（パターン4 観点2）。単体テストの代役地図は
// Worker・描画・スタイル検証・`idle`・canvasへの実クリックを持たないため、ここでしか確かめられない。

/** 描けたかを見分けるための塗り色。基礎地図・アプリのUIが使わない色にする。 */
const PROBE_FILL = { r: 255, g: 0, b: 255 };

/**
 * 地図のcanvasが見えている範囲のうち、`PROBE_FILL`で塗られた画素の割合。
 * MapLibreは既定で描画バッファを保持しないため`toDataURL`は空を返す。画面の写しを取り、
 * ページの2D canvasで画素へ戻して数える。
 */
async function probeFillRatio(page: Page): Promise<number> {
  const canvas = page.locator("canvas.maplibregl-canvas");
  const png = (await canvas.screenshot()).toString("base64");
  return page.evaluate(
    async ({ png, fill }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const scratch = document.createElement("canvas");
      scratch.width = image.width;
      scratch.height = image.height;
      const context = scratch.getContext("2d");
      if (!context) return 0;
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, image.width, image.height);
      let hits = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (
          Math.abs(data[i] - fill.r) < 8 &&
          Math.abs(data[i + 1] - fill.g) < 8 &&
          Math.abs(data[i + 2] - fill.b) < 8
        ) {
          hits += 1;
        }
      }
      return hits / (data.length / 4);
    },
    { png, fill: PROBE_FILL },
  );
}

// 「描けた」＝GeoJSONソースの面が画素として出たこと。GeoJSONの取り込みはWorkerが行うため、
// Workerの読み込みに失敗すると（本番ビルドでWorkerのURLが404になる等）canvasは残ったまま
// この色が1画素も出ない。DOMの状態・canvasの有無・サイズは、その状態でも変わらない。
test("地図が描ける（Workerが動き、ソースの面が画素になる）", async ({ page }) => {
  await installApiMocks(page);
  await page.route("**/api/basemap/**", (route) =>
    route.fulfill({
      json: {
        version: 8,
        sources: {
          probe: {
            type: "geojson",
            data: {
              type: "Feature",
              properties: {},
              geometry: {
                type: "Polygon",
                coordinates: [
                  [
                    [-179, -85],
                    [179, -85],
                    [179, 85],
                    [-179, 85],
                    [-179, -85],
                  ],
                ],
              },
            },
          },
        },
        layers: [
          {
            id: "probe",
            type: "fill",
            source: "probe",
            paint: { "fill-color": `rgb(${PROBE_FILL.r}, ${PROBE_FILL.g}, ${PROBE_FILL.b})` },
          },
        ],
      },
    }),
  );

  await page.goto("/");

  // 地図の上にはチップ・パネル等が重なるため、全面ではなく過半を条件にする。
  await expect.poll(() => probeFillRatio(page), { timeout: 20_000 }).toBeGreaterThan(0.5);
});

// sceneが組むレイヤーの式は、MapLibreのスタイル検証（addLayer時）を実ブラウザでしか通らない。
// 検証に落ちても例外にはならず、map.on("error")へ出てそのレイヤーだけが黙って描かれない
// （docs/modules/frontend/static-map-layers.md「MapLibreの式を組むときの前提」）。
// タイル世代を配り（無いとタイルのソース自体が作られない）、宣言されたレイヤーを全部ONにして、
// 取得の失敗（sourceIdを持つ）以外の地図のエラーが1件も出ないことを見る。
test("宣言された地図レイヤーを全部ONにしても、スタイル検証のエラーが出ない", async ({ page }) => {
  const styleErrors: string[] = [];
  page.on("console", async (message) => {
    if (!message.text().includes("[map:error]")) return;
    const detail = (await message
      .args()[1]
      ?.jsonValue()
      .catch(() => null)) as { sourceId?: string } | null;
    if (!detail?.sourceId) styleErrors.push(message.text());
  });

  await installApiMocks(page);
  await seedStoredState(page, {
    ...allLayersOn(),
    // installApiMocks の軸カタログが持つ軸。
    "ridecompass:route-style-mode": "axis_a",
  });
  await page.goto("/");
  await expect(page.getByText("地図を読み込み中…")).toBeHidden({ timeout: 15_000 });
  // 一部のレイヤーはカタログ・世代が届いてから作られる。落ち着くのを待つ。
  await page.waitForTimeout(3000);

  expect(styleErrors).toEqual([]);
});

// ルートを収める余白は、地図の上に重ねた部品が覆う幅を含む（含まないと、ルートの端が操作列の下に隠れる）。
// 余白はMapLibreへ渡した値をデバッグログで読み、覆う幅は部品を名前で探して実寸で測る——余白を決めた側の印とは
// 別の入力で確かめる。
test("ルートを収めるとき、地図の上の操作部品が覆う所へルートの端を置かない", async ({ page }) => {
  const fit: { padding?: Record<"top" | "bottom" | "left" | "right", number> } = {};
  page.on("console", async (message) => {
    if (!message.text().includes("[map:viewport] ルートを収める")) return;
    Object.assign(fit, await message.args()[1]?.jsonValue());
  });
  await installApiMocks(page);
  await seedStoredState(page, { "ridecompass:debug-enabled": "1" });
  await page.goto("/");
  await expect(page.getByText("地図を読み込み中…")).toBeHidden({ timeout: 15_000 });
  await runGeneration(page);
  await expect.poll(() => fit.padding, { timeout: 10_000 }).toBeDefined();

  const canvas = (await page.locator("canvas.maplibregl-canvas").boundingBox())!;
  const covers = async (name: string | RegExp) => {
    const boxes = await Promise.all((await page.getByRole("button", { name }).all()).map((b) => b.boundingBox()));
    return boxes.filter((box) => box !== null);
  };
  const depths = {
    right: (await covers(/^(拡大|縮小|地図の向き|現在地に移動)$/)).map((box) => canvas.x + canvas.width - box.x),
    top: (await covers(/^(評価で塗る:|地図に出す情報$)/)).map((box) => box.y + box.height - canvas.y),
  };
  for (const [edge, values] of Object.entries(depths) as [keyof typeof depths, number[]][]) {
    expect(values.length, `${edge}の辺を覆う部品が見つからない`).toBeGreaterThan(0);
    expect(fit.padding![edge], `${edge}の余白`).toBeGreaterThanOrEqual(Math.max(...values));
  }
});
