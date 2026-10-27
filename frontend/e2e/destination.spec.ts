import { expect, test, type Page } from "@playwright/test";
import {
  INTRO_CLOSED,
  KEYBOARD_HEIGHT,
  installApiMocks,
  installMapFinder,
  openMobileApp,
  openMobileSheet,
  seedStoredState,
} from "./fixtures";

// 目的地を探して置く操作の、実ブラウザでしか出ない挙動（パターン4 観点1・2）。

// 目的地を探して置いた地点は、実際の地図のその位置にピンとして立ち、ピンを実際につかんで動かすと地点が動く（パターン4 観点2）。
// 単体テストの代役地図はピンの位置もドラッグも持たないため、ここで見る。置いた・動かした位置は、生成の要求に載る目的地で読む
// ——画面の印とは別の出口で確かめる。
test("目的地を探して置いた地点は地図のその位置にピンが立ち、ピンを動かすと目的地が動く", async ({ page }) => {
  const candidate = {
    kind: "address",
    level: "aza",
    name: "東京都北区王子一丁目",
    area: null,
    latitude: 35.7536,
    longitude: 139.7378,
  };
  await installApiMocks(page);
  await page.route("**/api/place-search*", (route) => route.fulfill({ json: { candidates: [candidate] } }));
  await seedStoredState(page, INTRO_CLOSED);
  await page.addInitScript(installMapFinder);
  await page.goto("/");
  await expect(page.getByText("地図を読み込み中…")).toBeHidden({ timeout: 15_000 });

  await page.getByRole("button", { name: "周回", pressed: true }).click();
  await page.getByRole("button", { name: "目的地: 未設定", exact: true }).click();
  const searchBox = page.getByRole("searchbox", { name: "目的地を住所・施設で探す" });
  await searchBox.fill("王子");
  await searchBox.press("Enter");
  await page
    .getByRole("list", { name: "地点の候補" })
    .getByRole("button", { name: new RegExp(candidate.name) })
    .click();

  // ピンの位置（印の要素の中心）が、地図がその地点を描く位置にある。寄せる動きが終わるまで待つ。
  const pin = page.getByRole("img", { name: "目的地", exact: true });
  const offset = async () => {
    const box = (await pin.boundingBox())!;
    const at = await page.evaluate(
      ([lng, lat]) => {
        const map = window.__liveMap();
        const projected = map.project([lng, lat]);
        const canvas = map.getCanvas().getBoundingClientRect();
        return { x: canvas.left + projected.x, y: canvas.top + projected.y, moving: map.isMoving() };
      },
      [candidate.longitude, candidate.latitude],
    );
    return at.moving ? Infinity : Math.hypot(box.x + box.width / 2 - at.x, box.y + box.height / 2 - at.y);
  };
  await expect.poll(offset, { timeout: 10_000 }).toBeLessThan(2);

  // 落とす先の地点は、動かす前の地図で求める（ピンをつかめないと地図のほうが動き、後で求めると落とした先がずれる）。
  const box = (await pin.boundingBox())!;
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const to = { x: from.x + 80, y: from.y + 50 };
  const target = await page.evaluate(({ x, y }) => {
    const map = window.__liveMap();
    const canvas = map.getCanvas().getBoundingClientRect();
    const lngLat = map.unproject([x - canvas.left, y - canvas.top]);
    return { latitude: lngLat.lat, longitude: lngLat.lng };
  }, to);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();

  const request = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/api/routes/generate"));
  await page.getByRole("button", { name: "ルート生成" }).click();
  const { destination } = (await request).postDataJSON() as { destination: { latitude: number; longitude: number } };
  // 動かした量に比べて十分小さい差なら、落とした先に動いている。
  const distance = (a: typeof target, b: typeof target) =>
    Math.hypot(a.latitude - b.latitude, a.longitude - b.longitude);
  expect(distance(destination, target)).toBeLessThan(distance(candidate, target) / 20);
});

/**
 * キーボードが出たときにブラウザがすることを、見える範囲（visual viewport）の高さで見立てる。Playwright の Chromium は
 * ソフトウェアキーボードを出さないので、見える範囲を下から縮めて縮んだことを知らせる（fixed の基準は縮めない）。
 */
async function showKeyboard(page: Page): Promise<number> {
  return page.evaluate((keyboard) => {
    const viewport = window.visualViewport!;
    const height = window.innerHeight - keyboard;
    Object.defineProperty(viewport, "height", { configurable: true, get: () => height });
    viewport.dispatchEvent(new Event("resize"));
    return height;
  }, KEYBOARD_HEIGHT);
}

// 狭い画面では、地点の詳しくの探すボタンで地図の上端の欄を開き、候補は欄のすぐ下からキーボードの上までの中で送る。
// 候補が多くてもキーボードに覆われずに末尾まで押せて、押した候補が目的地になることを実ブラウザの寸法で見る（単体テストは
// レイアウトの実寸を持たない）。
test("モバイル: 目的地を探すと候補を地図の上端の欄の下でキーボードに隠れずに選べ、選ぶと地点の並びにその名前が出る", async ({
  page,
}) => {
  const candidates = Array.from({ length: 30 }, (_, index) => ({
    kind: "facility",
    level: "point",
    name: `浅草寺${index + 1}`,
    area: "台東区浅草二丁目",
    latitude: 35.7148 + index * 0.001,
    longitude: 139.7967,
  }));
  // 末尾の候補を選ぶ（候補が多いと、隠れうるのは末尾の側）。
  const candidate = candidates[candidates.length - 1];
  await openMobileApp(page, {
    routes: (p) => p.route("**/api/place-search*", (route) => route.fulfill({ json: { candidates } })),
  });
  const settings = await openMobileSheet(page, "ルート設定");
  await settings.getByRole("button", { name: "周回", pressed: true }).click();
  await settings.getByRole("button", { name: "目的地: 未設定", exact: true }).click();
  await settings.getByRole("button", { name: "目的地を探す" }).click();
  const searchBox = page.getByRole("searchbox", { name: "目的地を住所・施設で探す" });
  await expect(searchBox).toBeFocused();
  const keyboardTop = await showKeyboard(page);
  await searchBox.fill("浅草寺");
  await searchBox.press("Enter");
  const list = page.getByRole("list", { name: "地点の候補" });
  await expect(list).toBeVisible();
  const box = (await searchBox.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(keyboardTop);
  const choice = list.getByRole("button", { name: new RegExp(`${candidate.name}\\b`) });
  // 一覧の下端まで送る（中ほどへ送ると、一覧の下端がキーボードの裏にあっても見えてしまう）。
  await choice.evaluate((element) => element.scrollIntoView({ block: "end" }));
  const choiceBox = (await choice.boundingBox())!;
  expect(choiceBox.y).toBeGreaterThan(box.y + box.height);
  expect(choiceBox.y + choiceBox.height).toBeLessThanOrEqual(keyboardTop);
  await choice.click();

  await expect(settings.getByRole("button", { name: `目的地: ${candidate.name}` })).toBeVisible();
});

// 検索を開いている間のブラウザの「戻る」は、アプリから離れずに検索だけを閉じ、ルート設定のシートに戻る。閉じたあと（「戻る」でも ✕ でも）の「戻る」は
// 履歴に余分な項目を残さず、アプリの前の頁へ戻る。履歴の項目の積み・戻しは実ブラウザの履歴でしか見えないので、ここで見る。
test("モバイル: 検索を開いている間の「戻る」は検索だけを閉じてシートに戻り、閉じたあとの「戻る」はアプリから離れる", async ({
  page,
}) => {
  // アプリの前の頁を作る（離れたことを URL で読む）。
  await page.goto("about:blank");
  await openMobileApp(page);
  const appUrl = page.url();
  const settings = await openMobileSheet(page, "ルート設定");
  await settings.getByRole("button", { name: "周回", pressed: true }).click();
  await settings.getByRole("button", { name: "目的地: 未設定", exact: true }).click();
  const searchButton = settings.getByRole("button", { name: "目的地を探す" });
  const searchBox = page.getByRole("searchbox", { name: "目的地を住所・施設で探す" });
  const closeButton = page.getByRole("button", { name: "目的地の候補を閉じる" });

  await searchButton.click();
  await expect(closeButton).toBeVisible();
  await page.goBack();
  await expect(closeButton).toBeHidden();
  await expect(searchBox).not.toBeFocused();
  await expect(settings).toBeVisible();
  expect(page.url()).toBe(appUrl);

  await searchButton.click();
  await closeButton.click();
  await expect(closeButton).toBeHidden();
  await page.goBack();
  await expect(page).toHaveURL("about:blank");
});
