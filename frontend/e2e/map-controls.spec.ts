import { expect, test, type Page } from "@playwright/test";
import {
  doneJobFixture,
  generateRoutes,
  openMapApp,
  openMobileApp,
  openMobileSheet,
  routeGenerateResponseFixture,
} from "./fixtures";
import { WIDTHS } from "./states";

// 地図の右の列（拡大・縮小か走行中の縮尺から、走行モードまで）のボタンが、ほかの部品の下に潜らず押せ、継ぎ目の間隔が揃うこと（パターン4 観点1）。
// 押す所の大きさ（24px四方）は全状態の走査が両方の幅で見るので、ここでは重なりと間隔だけを見る。どちらも実寸と重なりの順番で
// 決まり、単体テストでは見えない。押す点（中心）のヒットテストがボタン自身か子孫を返せば、上に何も重なっていない。
// 間隔は、方位磁針から下の継ぎ目が全部 `--map-ctrl-stack-gap` であること（拡大・縮小（走行中は縮尺）・方位磁針は1つの枠に
// 隙間なく並ぶので見ない）。ボタンを包む要素が行の箱の分だけ高くなると、その継ぎ目だけ広がり、走行中に列の上の
// ボタンの数が変わったのに積み始めの位置が追わなければ、方位磁針の下の継ぎ目が広がるか重なる。

const RIGHT_COLUMN =
  /^(拡大|縮小|縮尺|地図の向き|北を上にする|進む向きを上にする|出発時刻|想定速度|現在地に移動|走行モード)/;

type ColumnButton = { name: string; onTop: boolean; top: number; bottom: number };

/** 走っていない間の列: 拡大・縮小と方位磁針の下に、出発時刻・想定速度・現在地に移動・走行モードを積む。 */
const NOT_RIDING = { head: ["拡大", "縮小"], compass: "地図の向き", stacked: 4 };

/** 右の列のボタンの名前・押す点で最前面にあるか・上端と下端（上から順）。 */
async function rightColumnButtons(page: Page): Promise<ColumnButton[]> {
  const buttons = await page.getByRole("button", { name: RIGHT_COLUMN }).all();
  const measured = await Promise.all(
    buttons.map((button) =>
      button.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return {
          name: el.getAttribute("aria-label") ?? "",
          onTop: hit !== null && el.contains(hit),
          top: box.top,
          bottom: box.bottom,
        };
      }),
    ),
  );
  return measured.sort((a, b) => a.top - b.top);
}

/** `head`は方位磁針より上のボタンの名前、`compass`は方位磁針の名前、`stacked`はその下に積むボタンの数（走行モードまで）。 */
async function expectColumnSound(
  page: Page,
  { head, compass, stacked }: { head: string[]; compass: string; stacked: number },
) {
  const column = await rightColumnButtons(page);
  // 走行モードが列の末尾まで並んでいること（見つからない名前を素通りさせない）。
  expect(column.map(({ name }) => name)).toEqual(expect.arrayContaining([...head, compass, "走行モード"]));
  expect(column.at(-1)?.name).toBe("走行モード");
  expect(column.filter(({ onTop }) => !onTop)).toEqual([]);

  const stackGap = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--map-ctrl-stack-gap")),
  );
  expect(stackGap).toBeGreaterThan(0);
  const fromCompass = column.slice(column.findIndex(({ name }) => name === compass));
  expect(fromCompass.length).toBeGreaterThanOrEqual(stacked + 1);
  const seams = fromCompass.slice(1).map((button, i) => ({
    seam: `${fromCompass[i].name} → ${button.name}`,
    gap: Math.round((button.top - fromCompass[i].bottom) * 10) / 10,
  }));
  expect(seams.filter(({ gap }) => Math.abs(gap - stackGap) > 0.5)).toEqual([]);
}

test("スマホ: ルート設定のシートを開いても、地図の右の列のボタンはほかの部品の下に潜らず、継ぎ目の間隔が揃う", async ({
  page,
}) => {
  await openMobileApp(page);
  await openMobileSheet(page, "ルート設定");
  await expectColumnSound(page, NOT_RIDING);
});

test("PC: 地図の右の列のボタンはほかの部品の下に潜らず、継ぎ目の間隔が揃う", async ({ page }) => {
  await page.setViewportSize(WIDTHS.desktop);
  await openMapApp(page);
  await expectColumnSound(page, NOT_RIDING);
});

// 走行モードの間は、拡大・縮小の代わりに縮尺のボタン1つを方位磁針の上に置き、その下に走行モードのボタンを積む。
test("スマホ: 走行モードの間も、地図の右の列のボタンはほかの部品の下に潜らず、継ぎ目の間隔が揃う", async ({ page }) => {
  await openMobileApp(page);
  await page.getByRole("button", { name: "走行モード" }).click();
  await expect(page.getByRole("button", { name: /^縮尺/ })).toBeVisible();
  await expectColumnSound(page, { head: [], compass: "進む向きを上にする（いまは北が上）", stacked: 1 });
});

// 「表示」の一覧は画面の下端まで伸びるので、スマホではシート・タブバーと重なる。重なった所でも一覧が上にあり、末尾まで押せること
// （重なりの順番で決まり、単体テストでは見えない）。末尾がシートの上端より下にあることを先に見て、重なっていない配置で素通りさせない。
test("スマホ: ルート設定のシートを開いたまま「表示」の一覧を末尾まで送っても、末尾の操作がシートの下に潜らず押せる", async ({
  page,
}) => {
  await openMobileApp(page);
  const sheet = await openMobileSheet(page, "ルート設定");
  await page.getByRole("button", { name: "地図に出す情報", exact: true }).click();
  const last = page
    .getByRole("dialog", { name: "地図に出す情報", exact: true })
    .getByRole("button", { name: "絞り込みをすべて解除" });
  await last.scrollIntoViewIfNeeded();

  const sheetTop = (await sheet.boundingBox())!.y;
  const lastBox = (await last.boundingBox())!;
  expect(lastBox.y + lastBox.height / 2).toBeGreaterThan(sheetTop);
  const onTop = await last.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit !== null && el.contains(hit);
  });
  expect(onTop).toBe(true);
});

// 走行中に曲がる所のカードと「画面を点けたままにできません」の知らせが両方出ても、知らせがカードに重ならず、カードの距離が読める
// （パターン4 観点1: 実寸。知らせは右の列から左へ、カードは左上から右へ伸び、どちらの幅も文字で決まる）。曲がる所は、走り出す位置
// （候補の線の始点）より先に1つ置く。Wake Lock の口を消して、画面を点けたままにできない端末にする。
test("スマホ: 走行中、曲がる所のカードと、画面を点けたままにできない知らせが重ならない", async ({ page }) => {
  const generated = routeGenerateResponseFixture();
  const [first, ...rest] = generated.routes;
  const turn = {
    distance_km: 0.8,
    direction: "right" as const,
    latitude: 35.765,
    longitude: 139.75,
    other_road_bearings_deg: [0, 180],
  };
  await page.setViewportSize(WIDTHS.mobile);
  await page.addInitScript(() => {
    delete (Navigator.prototype as { wakeLock?: unknown }).wakeLock;
  });
  await openMapApp(page, {
    routes: (page) =>
      page.route("**/api/routes/generate/*", (route) =>
        route.fulfill({ json: doneJobFixture({ ...generated, routes: [{ ...first, turns: [turn] }, ...rest] }) }),
      ),
  });
  await generateRoutes(page);
  await page.getByRole("button", { name: "走行モード" }).click();

  const card = page.getByRole("status", { name: /先で右折/ });
  // 知らせは閉じるボタンを含む箱全体で測る。
  const notice = page.getByText(/この端末では画面を点けたままにできません/).locator("..");
  await expect(card).toBeVisible();
  await expect(notice).toBeVisible();
  const [a, b] = [(await card.boundingBox())!, (await notice.boundingBox())!];
  const overlaps = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  expect({ card: a, notice: b, overlaps }).toEqual(expect.objectContaining({ overlaps: false }));
});
