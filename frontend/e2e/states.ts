import { expect, type Page } from "@playwright/test";
import { catalogEntry } from "@/testing/catalogAxes";
import { makeRouteCandidate, routeThrough, type Places } from "@/testing/routeFixtures";
import {
  API_BASE,
  MOBILE_VIEWPORT,
  axisCatalogFixture,
  clickMap,
  defaultAxisCatalogFixture,
  doneJobFixture,
  generateInMobileSheet,
  openMobileSheet,
  routeGenerateResponseFixture,
  runGeneration,
} from "./fixtures";
import type { Opener, Spot } from "./pageHelpers";

// 走査する画面の状態（.claude/rules/testing-e2e.md パターン4）。土台は幅 × 段階（ルートの生成前・生成後・区間を乗り換えた後）。
// 土台の上では、画面がARIAで宣言している開閉の部品（`aria-expanded`・`role="tab"`）のうち、最前面で
// 押せるものを押せる限り辿る。どの状態へも1回だけ入る: 幅 × 段階ごとに1枚のページで辿り、開いたものは閉じて戻す。

// 各レイアウトのいちばん狭い幅に置く。モバイルは320px（WCAG 2.1 達成基準 1.4.10 のリフローの幅で、小さいiPhoneを
// 画面表示の拡大にしたときの幅）。高さは縮めない——縮めると画面の外へ出た部品を押せず、辿れる状態が減る。
export const WIDTHS = {
  mobile: { ...MOBILE_VIEWPORT, width: 320 },
  desktop: { width: 641, height: 800 },
} as const;
export type WidthName = keyof typeof WIDTHS;

/** アプリの段階。ルートを生成する前と後、区間を乗り換えた後で、画面に出る部品の集合が入れ替わる。 */
export const PHASES = ["生成前", "生成後", "乗り換え後"] as const;

/** 幅の分岐はCSSのブレークポイント1つだけで、デスクトップの幅はその1px外側（デスクトップのいちばん狭い幅）に置く。 */
export async function assertWidthsStraddleBreakpoint(page: Page): Promise<void> {
  const breakpoint = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--breakpoint-mobile")),
  );
  expect(breakpoint, "--breakpoint-mobile が読めない").toBeGreaterThan(0);
  expect(WIDTHS.mobile.width).toBeLessThanOrEqual(breakpoint);
  expect(WIDTHS.desktop.width).toBe(breakpoint + 1);
}

async function settle(page: Page): Promise<string> {
  const settled = await page.evaluate(() => window.__e2e.settle());
  expect(settled.ok, "15秒たっても画面が落ち着かない").toBe(true);
  return settled.fp;
}

/** 画面を開き、基本の状態（シート・パネルを開いていない）で落ち着くまで待つ。 */
export async function openApp(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "メニュー" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("地図を読み込み中…")).toBeHidden({ timeout: 15_000 });
  await settle(page);
}

/** ルートを1回生成し、基本の状態へ戻して落ち着くまで待つ。 */
export async function generate(page: Page, width: WidthName): Promise<void> {
  if (width === "mobile") {
    const outcome = await generateInMobileSheet(page, await openMobileSheet(page, "ルート設定"));
    await page.getByRole("button", { name: "ルート結果", exact: true }).click();
    await expect(outcome).toBeHidden();
  } else {
    await runGeneration(page);
  }
  await settle(page);
}

// 乗り換え後の段階の段取り。目的地へ向かう2候補が途中の1区間だけ別の道（N1 → VIA → N2）を通り、その区間が乗り換え先になる。
// 地点は出発地（installApiMocks の現在地）の近くに置く。
const SPLICE_PLACES: Places = {
  S: [139.7387, 35.7597],
  N1: [139.7406, 35.7604],
  VIA: [139.7421, 35.7634],
  N2: [139.7436, 35.7613],
  D: [139.7466, 35.7622],
};

/** 走査の軸カタログが持つ重みのある軸の数。公開の軸が増えると見込む最大の数で、軸が並ぶ部品の溢れをこの数で見る。 */
const SCAN_WEIGHTED_AXES = 25;

/**
 * 走査の軸カタログ。アプリを開く前に入れる。重みのある軸を`SCAN_WEIGHTED_AXES`本持つ（重みのある軸が2つ以上のときだけ
 * 出る部品があり、既定の1軸では走査に入らない）。乗り換えの入口が出るように、区間を割る下限の較正値を持つ。
 */
export async function installScanMocks(page: Page): Promise<void> {
  const catalog = axisCatalogFixture([
    ...defaultAxisCatalogFixture().axes,
    ...Array.from({ length: SCAN_WEIGHTED_AXES }, (_, i) => ({
      ...catalogEntry({ axis_id: `axis-${i + 1}` }),
      default_weight: 1 / SCAN_WEIGHTED_AXES,
    })),
  ]);
  catalog.client_tuning = { "splice.min_stretch_km": 0 };
  await page.route(`${API_BASE}/api/axis-catalog*`, (route) => route.fulfill({ json: catalog }));
}

/**
 * 地図が見えている点（浮いた部品・シート・案内に覆われていない点）のうち真ん中に近い所へ、経度・緯度の点を寄せてから押す
 * （地図は生成した候補へ寄るので、そのままでは点が画面の外や部品の下に来うる）。
 */
export async function clickVisible(page: Page, lngLat: readonly [number, number]): Promise<void> {
  await page.evaluate(
    (center) => {
      const map = window.__liveMap();
      const canvas = map.getCanvas();
      const box = canvas.getBoundingClientRect();
      const middle = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      let best: { x: number; y: number } | null = null;
      for (let y = box.top + 20; y < Math.min(box.bottom, window.innerHeight) - 20; y += 20) {
        for (let x = box.left + 20; x < Math.min(box.right, window.innerWidth) - 20; x += 20) {
          if (document.elementFromPoint(x, y) !== canvas) continue;
          if (!best || Math.hypot(x - middle.x, y - middle.y) < Math.hypot(best.x - middle.x, best.y - middle.y))
            best = { x, y };
        }
      }
      if (!best) throw new Error("地図の見えている所が無い");
      map.easeTo({ center, zoom: 16, offset: [best.x - middle.x, best.y - middle.y], duration: 0 });
    },
    lngLat as [number, number],
  );
  await settle(page);
  await clickMap(page, lngLat as [number, number]);
}

/** 目的地を置いて2候補を生成し、1つ目の候補で合成を始めて乗り換え先を1つ押し、基本の状態へ戻して落ち着くまで待つ。 */
export async function splice(page: Page, width: WidthName): Promise<void> {
  const result = routeGenerateResponseFixture();
  result.routes = [
    makeRouteCandidate({
      ...routeThrough(SPLICE_PLACES, ["S", "N1", "N2", "D"]),
      id: "route-1",
      kind: "destination",
      distance_km: 3.1,
    }),
    makeRouteCandidate({
      ...routeThrough(SPLICE_PLACES, ["S", "N1", "VIA", "N2", "D"]),
      id: "route-2",
      kind: "destination",
      distance_km: 3.6,
    }),
  ];
  await page.route(`${API_BASE}/api/routes/generate/*`, (route) => route.fulfill({ json: doneJobFixture(result) }));
  const settings = width === "mobile" ? await openMobileSheet(page, "ルート設定") : null;
  const scope = settings ?? page;
  await scope.getByRole("button", { name: "周回", pressed: true }).click();
  await scope.getByRole("button", { name: "目的地: 未設定", exact: true }).click();
  // スマホ幅は、シートを閉じると地図で地点を置けなくなるので、開いたまま見えている地図を押す。
  await clickVisible(page, SPLICE_PLACES.D);
  await expect(scope.getByRole("button", { name: "目的地を消す" })).toBeEnabled();
  if (settings) {
    const sheet = await generateInMobileSheet(page, settings);
    await sheet.getByRole("button", { name: "ルートを合成" }).first().click();
    await page.getByRole("button", { name: "ルート結果", exact: true }).click();
    await expect(sheet).toBeHidden();
  } else {
    await runGeneration(page);
    await page.getByRole("button", { name: "ルートを合成" }).first().click();
  }
  await settle(page);
  await clickVisible(page, SPLICE_PLACES.VIA);
  await settle(page);
  if (width === "mobile") {
    const sheet = await openMobileSheet(page, "ルート結果");
    await expect(sheet.getByText("1回")).toBeVisible();
    await page.getByRole("button", { name: "ルート結果", exact: true }).click();
    await expect(sheet).toBeHidden();
  } else {
    await expect(page.getByText("1回")).toBeVisible();
  }
  await settle(page);
}

/** 部品の検査の「段階ごとに1回」を始め直す。 */
export async function resetPhase(page: Page): Promise<void> {
  await page.evaluate(() => window.__e2e.resetPhase());
}

/** 2つの指紋の違い（消えた行・増えた行）。部品の見分けは末尾の2段だけ出す。 */
function describeDiff(before: string, after: string): string {
  const count = (fp: string) => {
    const lines = new Map<string, number>();
    for (const line of fp.split("\n")) lines.set(line, (lines.get(line) ?? 0) + 1);
    return lines;
  };
  const a = count(before);
  const b = count(after);
  const short = (line: string) => {
    const [key, value] = line.split(" = ");
    return value === undefined ? line : `${key.split("<").slice(0, 2).join("<")} = ${value}`;
  };
  const lost = [...a].filter(([line, n]) => (b.get(line) ?? 0) < n).map(([line]) => short(line));
  const gained = [...b].filter(([line, n]) => (a.get(line) ?? 0) < n).map(([line]) => short(line));
  return `消えた ${lost.slice(0, 3).join(" | ")} ／ 増えた ${gained.slice(0, 3).join(" | ")}`;
}

export interface TraverseResult {
  /** 検査した状態の数（土台を含む）。 */
  states: number;
  problems: string[];
}

/**
 * 土台から開閉の部品を辿り、各状態で`inspect`を呼ぶ。祖先の状態にあった部品（部品の見分けが同じもの）は押さない。
 * 同じタブ列のタブは戻らずに次へ渡り、最後に元のタブへ戻す。閉じたあと指紋が押す前と一致しなければ違反にする。
 */
export async function traverse(
  page: Page,
  root: string,
  inspect: (path: string) => Promise<void>,
): Promise<TraverseResult> {
  const problems: string[] = [];
  let states = 0;
  const press = async (spot: Spot) => {
    await page.mouse.click(spot.x, spot.y);
    return settle(page);
  };
  const center = (n: number) => page.evaluate((n) => window.__e2e.center(n), n);
  const pressOrEscape = async (spot: Spot | null) => {
    if (spot?.pressable) return press(spot);
    await page.keyboard.press("Escape");
    return settle(page);
  };

  const visit = async (path: string, ancestors: string[], entered: string) => {
    states += 1;
    await inspect(path);
    const snap = await page.evaluate((skip) => window.__e2e.snapshot(skip), ancestors);
    if (snap.fp !== entered) problems.push(`検査の操作で状態が変わった: ${path}（${describeDiff(entered, snap.fp)}）`);
    const base = snap.fp;
    const next = [...ancestors, ...snap.present];
    const groups = new Map<number, Opener[]>();
    for (const opener of snap.openers) {
      if (opener.group !== null) groups.set(opener.group, [...(groups.get(opener.group) ?? []), opener]);
    }

    for (const opener of snap.openers.filter((o) => o.group === null)) {
      const spot = await center(opener.id);
      if (!spot?.pressable) continue;
      const opened = await press(spot);
      if (opened === base) continue;
      await visit(`${path} > ${opener.label}`, next, opened);
      const back = await pressOrEscape(await center(opener.id));
      if (back !== base)
        problems.push(`閉じても元に戻らない: ${path} > ${opener.label}（${describeDiff(base, back)}）`);
    }

    for (const members of groups.values()) {
      let current = base;
      let moved = false;
      for (const member of members) {
        const spot = await center(member.id);
        if (!spot?.pressable) continue;
        const opened = await press(spot);
        if (opened === current) continue;
        moved = true;
        await visit(`${path} > ${member.label}`, next, opened);
        current = opened;
      }
      const restoreId = members[0].restoreId;
      if (!moved) continue;
      if (restoreId === null) {
        problems.push(`選ばれていたタブが無く、タブ列を元へ戻せない: ${path}`);
        continue;
      }
      const back = await pressOrEscape(await center(restoreId));
      if (back !== base) problems.push(`元のタブへ戻せない: ${path}（${describeDiff(base, back)}）`);
    }
  };

  await visit(root, [], await page.evaluate(() => window.__e2e.fingerprint()));
  return { states, problems };
}
