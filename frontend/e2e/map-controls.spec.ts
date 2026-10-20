import { expect, test, type Page } from "@playwright/test";
import { INTRO_CLOSED, installApiMocks, openMobileApp, openMobileSheet, seedStoredState } from "./fixtures";
import { WIDTHS } from "./states";

// 地図の右の列（拡大・縮小か走行中の倍率から、走行モードまで）のボタンが、ほかの部品の下に潜らず押せ、継ぎ目の間隔が揃うこと（パターン4 観点1）。
// 押す所の大きさ（24px四方）は全状態の走査が両方の幅で見るので、ここでは重なりと間隔だけを見る。どちらも実寸と重なりの順番で
// 決まり、単体テストでは見えない。押す点（中心）のヒットテストがボタン自身か子孫を返せば、上に何も重なっていない。
// 間隔は、方位磁針から下の継ぎ目が全部 `--map-ctrl-stack-gap` であること（拡大・縮小（走行中は倍率）・方位磁針は1つの枠に
// 隙間なく並ぶので見ない）。ボタンを包む要素が行の箱の分だけ高くなると、その継ぎ目だけ広がり、走行中に列の上の
// ボタンの数が変わったのに積み始めの位置が追わなければ、方位磁針の下の継ぎ目が広がるか重なる。

const RIGHT_COLUMN =
  /^(拡大|縮小|倍率|地図の向き|北を上にする|進む向きを上にする|出発時刻|想定速度|現在地に移動|走行モード)/;

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
  await expect(page.getByText("地図を読み込み中…")).toBeHidden({ timeout: 15_000 });
  await openMobileSheet(page, "ルート設定");
  await expectColumnSound(page, NOT_RIDING);
});

test("PC: 地図の右の列のボタンはほかの部品の下に潜らず、継ぎ目の間隔が揃う", async ({ page }) => {
  await installApiMocks(page);
  await page.setViewportSize(WIDTHS.desktop);
  await seedStoredState(page, INTRO_CLOSED);
  await page.goto("/");
  await expect(page.getByText("地図を読み込み中…")).toBeHidden({ timeout: 15_000 });
  await expectColumnSound(page, NOT_RIDING);
});

// 走行モードの間は、拡大・縮小の代わりに倍率のボタン1つを方位磁針の上に置き、その下に走行モードのボタンを積む。
test("スマホ: 走行モードの間も、地図の右の列のボタンはほかの部品の下に潜らず、継ぎ目の間隔が揃う", async ({ page }) => {
  await openMobileApp(page);
  await expect(page.getByText("地図を読み込み中…")).toBeHidden({ timeout: 15_000 });
  await page.getByRole("button", { name: "走行モード" }).click();
  await expect(page.getByRole("button", { name: /^倍率/ })).toBeVisible();
  await expectColumnSound(page, { head: [], compass: "進む向きを上にする（いまは北が上）", stacked: 1 });
});

// 「表示」の一覧は画面の下端まで伸びるので、スマホではシート・タブバーと重なる。重なった所でも一覧が上にあり、末尾まで押せること
// （重なりの順番で決まり、単体テストでは見えない）。末尾がシートの上端より下にあることを先に見て、重なっていない配置で素通りさせない。
test("スマホ: ルート設定のシートを開いたまま「表示」の一覧を末尾まで送っても、末尾の操作がシートの下に潜らず押せる", async ({
  page,
}) => {
  await openMobileApp(page);
  await expect(page.getByText("地図を読み込み中…")).toBeHidden({ timeout: 15_000 });
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
