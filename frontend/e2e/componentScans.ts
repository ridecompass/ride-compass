import type { CDPSession, Page } from "@playwright/test";

// 部品の検査（パターン4 観点2・3）: 要素と祖先の計算後のスタイルで決まるので、段階ごとに各部品1回だけ当てる
// （window.__e2e.firstInPhase）。違反を文字列の配列で返す（空なら違反なし）。どの状態に当てるかは states.ts が決める。
// 配置の検査（座標・寸法を読み、状態ごとに当てる）は e2e/scans.ts が持つ。

/**
 * Tailwindの余白ユーティリティ（`p-2`・`px-[0.9rem]`・`-mt-1`等）。変種付き（`sm:`・`hover:`）は、今の画面で
 * その条件が成り立つかを判定しないので対象外。
 */
const SPACING_UTILITY = /^(-?)([pm])([xytrblse]?)-(\d+(?:\.\d+)?|\[[^\]]+\])$/;

const SIDES: Record<string, readonly string[]> = {
  "": ["top", "right", "bottom", "left"],
  x: ["right", "left"],
  y: ["top", "bottom"],
  t: ["top"],
  r: ["right"],
  b: ["bottom"],
  l: ["left"],
  s: ["left"],
  e: ["right"],
};

/**
 * 観点3（部品の検査）: Tailwindの余白ユーティリティが、globals.cssのリセットに潰されていないか。
 * リセット（`* { padding: 0; margin: 0 }`・`button`の既定の余白）は`@layer base`に置かれ、
 * Tailwindの`@layer utilities`に負ける。リセットが層の外へ出ると、詳細度に関係なくユーティリティを
 * 潰す（層の外のルールは、どの層のルールより強い）。期待値は同じ親に置いた試し要素へ
 * そのユーティリティの値を`!important`で与え、ブラウザに計算させる。
 */
export async function scanSpacingUtilities(page: Page): Promise<{ checked: number; problems: string[] }> {
  return page.evaluate(
    ({ pattern, sides }) => {
      const utility = new RegExp(pattern);
      let checked = 0;
      const problems: string[] = [];
      for (const element of document.querySelectorAll<HTMLElement>("body *")) {
        if (![...element.classList].some((token) => utility.test(token))) continue;
        if (!window.__e2e.firstInPhase("spacing", window.__e2e.componentKey(element))) continue;
        for (const token of element.classList) {
          const match = utility.exec(token);
          if (!match) continue;
          const [, negative, kind, axis, amount] = match;
          const property = kind === "p" ? "padding" : "margin";
          const length = amount.startsWith("[")
            ? amount.slice(1, -1).replaceAll("_", " ")
            : `calc(var(--spacing) * ${amount})`;
          const probe = document.createElement("div");
          probe.style.position = "absolute";
          probe.style.visibility = "hidden";
          probe.style.setProperty(`${property}-left`, negative ? `calc(${length} * -1)` : length, "important");
          element.parentElement?.appendChild(probe);
          const expected = getComputedStyle(probe).getPropertyValue(`${property}-left`);
          probe.remove();
          const computed = getComputedStyle(element);
          for (const side of sides[axis]) {
            const actual = computed.getPropertyValue(`${property}-${side}`);
            if (actual !== expected) {
              const name = (element.textContent ?? "").trim().slice(0, 20);
              problems.push(
                `${element.tagName.toLowerCase()} "${name}" の ${token}（${side}）が ${actual}（本来 ${expected}）`,
              );
            }
          }
          checked += 1;
        }
      }
      return { checked, problems };
    },
    { pattern: SPACING_UTILITY.source, sides: SIDES },
  );
}

/** 2本の指を(x, y)の左右に置き、外へ開く。Input.synthesizePinchGestureはページの拡大を再現しない
 * （.claude/rules/testing-e2e.md パターン4）。 */
export async function pinchOpen(client: CDPSession, x: number, y: number): Promise<void> {
  const fingers = (spread: number) => [
    { x: x - 2 - spread, y, id: 1 },
    { x: x + 2 + spread, y, id: 2 },
  ];
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: fingers(0) });
  for (let step = 1; step <= 12; step += 1) {
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: fingers(step * 8) });
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/**
 * 観点2（部品の検査）: 地図のcanvas以外の部品から始めたピンチが、ページ全体の拡大にならないか（地図の上の
 * ピンチが地図を拡大することは map-touch.spec.ts が見る）。対象は、見えている要素の中心点で最前面になる要素
 * （指が実際に触れる要素）。指は1回の移動で画面の左右の端まで開く——ブラウザがピンチとして扱うかが見えれば足り、
 * 移動を分けても検知は変わらない。指はつまみ・スライダーを動かしうるので、ピンチの間は画面の状態を止める
 * （`window.__e2e.isolate`）。拡大したら倍率を戻す（戻らなければ座標がずれるので、残りは未検査として打ち切る）。
 */
export async function scanPinch(page: Page, client: CDPSession): Promise<{ checked: number; problems: string[] }> {
  const { width, targets } = await page.evaluate(() => {
    const canvas = document.querySelector("canvas.maplibregl-canvas");
    const found: { x: number; y: number; label: string }[] = [];
    for (const el of document.querySelectorAll("body *")) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
      const hit = document.elementFromPoint(x, y);
      if (!hit || hit === canvas || !window.__e2e.firstInPhase("pinch", window.__e2e.componentKey(hit))) continue;
      const name = hit.getAttribute("aria-label") ?? (hit.textContent ?? "").trim().slice(0, 16);
      found.push({ x, y, label: `${hit.tagName.toLowerCase()} "${name}"` });
    }
    return { width: window.innerWidth, targets: found };
  });
  const problems: string[] = [];
  for (const [index, target] of targets.entries()) {
    await page.evaluate(({ x, y }) => window.__e2e.isolate(x, y), target);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: target.x - 2, y: target.y, id: 1 },
        { x: target.x + 2, y: target.y, id: 2 },
      ],
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: 0, y: target.y, id: 1 },
        { x: width - 1, y: target.y, id: 2 },
      ],
    });
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const scale = await page.evaluate(() => {
      window.__e2e.release();
      return window.__e2e.stableScale();
    });
    if (scale === 1) continue;
    problems.push(
      `${target.label} (${Math.round(target.x)},${Math.round(target.y)}) から始めたピンチでページが×${scale.toFixed(2)}に拡大した`,
    );
    await client.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
    if ((await page.evaluate(() => window.__e2e.stableScale())) !== 1) {
      problems.push(`（倍率を戻せないため、残り${targets.length - index - 1}件は未検査）`);
      break;
    }
  }
  return { checked: targets.length, problems };
}
