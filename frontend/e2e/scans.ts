import type { CDPSession, Page } from "@playwright/test";

// 1つの画面状態に当てる配置の検査（パターン4 観点1）。どれも「画面に在るもの全部」を性質で集め、
// 違反を文字列の配列で返す（空なら違反なし）。判定が座標・寸法を読み、何が開いているかで変わるので、状態ごとに当てる。
// どの状態に当てるかは states.ts が決める。部品の検査（段階ごとに各部品1回）は e2e/componentScans.ts が持つ。

/**
 * 操作できる部品のロール。WAI-ARIA 1.2「5.3.2 Widget Roles」（https://www.w3.org/TR/wai-aria-1.2/#widget_roles）の
 * 単独の部品とまとめ役の部品。separatorはフォーカスできるときだけ部品に当たる（同節）。
 */
const WIDGET_ROLES = new Set([
  "button",
  "checkbox",
  "gridcell",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "progressbar",
  "radio",
  "scrollbar",
  "searchbox",
  "separator",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "tabpanel",
  "textbox",
  "treeitem",
  "combobox",
  "grid",
  "listbox",
  "menu",
  "menubar",
  "radiogroup",
  "tablist",
  "tree",
  "treegrid",
]);

interface AXNode {
  ignored: boolean;
  role?: { value?: string };
  backendDOMNodeId?: number;
  properties?: { name: string; value: { value?: unknown } }[];
}

/**
 * 観点1（配置の検査）: ページが横にスクロールしないこと、操作できる部品が画面の横幅からはみ出さないこと、
 * 操作できる部品の中心点（押す点）が祖先に切り取られていないこと、操作できる部品の箱が24px四方以上であること
 * （WCAG 2.2 達成基準 2.5.8 Target Size (Minimum)。https://www.w3.org/TR/WCAG22/#target-size-minimum の例外のうち、
 * 見るのを外すのはブラウザが描く部品（User agent control）だけで、間隔で補う形（Spacing）等は使わない）。
 * 部品はブラウザが計算したロール（アクセシビリティツリー）で決める。部品が横スクロールする容器（祖先の計算後の
 * `overflow-x`が`auto`・`scroll`。縦にスクロールする容器も計算後は`auto`になる）の中にあれば、容器を
 * スクロールすれば届くので、部品の代わりに最も近いその容器が画面の横幅に収まるかを見る（件数は`viaContainer`）。
 * 切り取りは、スクロールしない祖先（その軸の`overflow`が`hidden`・`clip`）の外に中心点があるかで見る。
 * その軸でスクロールする祖先より外側の切り取りは、スクロールすれば届くので見ない。
 * `resolved`は解決済みのノードの使い回し（同じページの間だけ有効）。
 */
export async function scanLayout(
  page: Page,
  client: CDPSession,
  resolved: Map<number, string>,
): Promise<{ checked: number; viaContainer: number; problems: string[] }> {
  const problems: string[] = [];
  const scroll = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    return root.scrollWidth > window.innerWidth + 1 ? root.scrollWidth : null;
  });
  if (scroll !== null) problems.push(`ページが横にスクロールする（幅${scroll}px）`);

  const { nodes } = (await client.send("Accessibility.getFullAXTree")) as { nodes: AXNode[] };
  const objectIds: string[] = [];
  for (const node of nodes) {
    const role = String(node.role?.value ?? "").toLowerCase();
    if (node.ignored || !node.backendDOMNodeId || !WIDGET_ROLES.has(role)) continue;
    if (role === "separator" && !node.properties?.some((p) => p.name === "focusable" && p.value.value === true))
      continue;
    let objectId = resolved.get(node.backendDOMNodeId);
    if (!objectId) {
      const { object } = (await client.send("DOM.resolveNode", { backendNodeId: node.backendDOMNodeId })) as {
        object: { objectId?: string };
      };
      objectId = object.objectId;
      if (!objectId) continue;
      resolved.set(node.backendDOMNodeId, objectId);
    }
    objectIds.push(objectId);
  }
  if (objectIds.length === 0) return { checked: 0, viaContainer: 0, problems };

  const { result } = (await client.send("Runtime.callFunctionOn", {
    objectId: objectIds[0],
    returnByValue: true,
    arguments: objectIds.map((objectId) => ({ objectId })),
    functionDeclaration: `function (...targets) {
      return targets.map((node) => {
        const el = node.nodeType === 1 ? node : node.parentElement;
        if (!el) return null;
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0 || !el.checkVisibility({ visibilityProperty: true })) return null;
        const label = (e) =>
          e.tagName.toLowerCase() + ' "' + (e.getAttribute("aria-label") ?? (e.textContent ?? "").trim().slice(0, 20)) + '"';
        const describe = (e, b) =>
          label(e) + " が画面の横からはみ出す（" + Math.round(b.left) + "〜" + Math.round(b.right) + "px）";
        const fits = (b) => b.left >= -1 && b.right <= window.innerWidth + 1;
        const scrolls = (v) => v === "auto" || v === "scroll";
        const clips = (v) => v === "hidden" || v === "clip";
        const cx = box.left + box.width / 2;
        const cy = box.top + box.height / 2;
        let container = null;
        let clipped = "";
        let reachX = false;
        let reachY = false;
        // 絶対・固定配置の要素を切り取り・スクロールで動かすのは、包含ブロックとその外側の祖先だけ。
        let position = getComputedStyle(el).position;
        // ページ全体のスクロール要素まで来たら、部品自身で見る（ページの横スクロールは別に見ている）。
        for (let p = el.parentElement; p && p !== document.scrollingElement; p = p.parentElement) {
          const style = getComputedStyle(p);
          const containing = style.transform !== "none" || (position === "absolute" && style.position !== "static");
          if ((position === "absolute" || position === "fixed") && !containing) continue;
          position = style.position;
          const outer = p.getBoundingClientRect();
          const outX = !reachX && clips(style.overflowX) && (cx < outer.left || cx > outer.right);
          const outY = !reachY && clips(style.overflowY) && (cy < outer.top || cy > outer.bottom);
          if (!clipped && (outX || outY)) {
            clipped = label(el) + " の押す点（" + Math.round(cx) + "," +
              Math.round(cy) + "）が祖先 " + p.tagName.toLowerCase() + "（" + Math.round(outer.left) + "〜" +
              Math.round(outer.right) + " × " + Math.round(outer.top) + "〜" + Math.round(outer.bottom) +
              "px）に切り取られて押せない";
          }
          if (scrolls(style.overflowX)) {
            container ??= p;
            reachX = true;
          }
          if (scrolls(style.overflowY)) reachY = true;
        }
        // 入力欄の中の欄・▼の印のように、ブラウザが入力欄の内側に描く部品は大きさを作り手が決めないので見ない
        // （達成基準 2.5.8 の User agent control の例外）。
        const root = el.getRootNode();
        const drawnByBrowser = root instanceof ShadowRoot && root.host.shadowRoot === null &&
          ["INPUT", "SELECT", "TEXTAREA", "VIDEO", "AUDIO"].includes(root.host.tagName);
        let small = "";
        if (!drawnByBrowser && (box.width < 24 || box.height < 24)) {
          small = label(el) + " の押す所が24px四方に満たない（" +
            Math.round(box.width * 10) / 10 + "×" + Math.round(box.height * 10) / 10 + "px）";
        }
        if (container) {
          const outer = container.getBoundingClientRect();
          return { via: true, problems: [fits(outer) ? "" : "容器 " + describe(container, outer), clipped, small] };
        }
        return { via: false, problems: [fits(box) ? "" : describe(el, box), clipped, small] };
      });
    }`,
  })) as { result: { value: ({ via: boolean; problems: string[] } | null)[] } };
  let checked = 0;
  let viaContainer = 0;
  for (const value of result.value) {
    if (value === null) continue;
    checked += 1;
    if (value.via) viaContainer += 1;
    problems.push(...value.problems.filter((problem) => problem !== ""));
  }
  return { checked, viaContainer, problems };
}

/**
 * 観点1（配置の検査）: 省略記号で切られている文字が無いこと。対象は見えている要素のうち、計算後の
 * `text-overflow`が`ellipsis`で、中身が箱より広い（`scrollWidth > clientWidth`）もの。切られた文字は
 * 画面のどこにも出ないので、値でも題名でも読めなくなる。
 */
export async function scanTruncatedText(page: Page): Promise<{ checked: number; problems: string[] }> {
  return page.evaluate(() => {
    let checked = 0;
    const problems: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>("body *")) {
      if (getComputedStyle(element).textOverflow !== "ellipsis") continue;
      if (element.clientWidth === 0 || !element.checkVisibility({ visibilityProperty: true })) continue;
      checked += 1;
      if (element.scrollWidth <= element.clientWidth) continue;
      const text = (element.textContent ?? "").trim().slice(0, 30);
      problems.push(
        `${element.tagName.toLowerCase()} "${text}" が省略されている（中身${element.scrollWidth}px > 箱${element.clientWidth}px）`,
      );
    }
    return { checked, problems };
  });
}

/**
 * 観点1（配置の検査）: 中身が箱から横にはみ出して、親の縁の外へ漏れている要素が無いこと。対象は見えている要素のうち、
 * 自分と親の計算後の`overflow-x`がどちらも`visible`（はみ出しを切りもスクロールもしない）で、中身が箱より広い
 * （`scrollWidth > clientWidth`）もの。親がはみ出しを切るかスクロールする（横に流す帯等）なら、見せ方は親が決めているので見ない。
 * 祖先は子のはみ出しも自分の中身に数えるので、はみ出した要素を含む祖先は出さず、いちばん内側だけを出す。
 */
export async function scanOverflowingContent(page: Page): Promise<{ checked: number; problems: string[] }> {
  return page.evaluate(() => {
    let checked = 0;
    const overflowing: HTMLElement[] = [];
    for (const element of document.querySelectorAll<HTMLElement>("body *")) {
      if (!(element instanceof HTMLElement) || getComputedStyle(element).overflowX !== "visible") continue;
      if (!element.parentElement || getComputedStyle(element.parentElement).overflowX !== "visible") continue;
      if (element.clientWidth === 0 || !element.checkVisibility({ visibilityProperty: true })) continue;
      checked += 1;
      if (element.scrollWidth > element.clientWidth + 1) overflowing.push(element);
    }
    const problems = overflowing
      .filter((element) => !overflowing.some((other) => other !== element && element.contains(other)))
      .map((element) => {
        const name = (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 30);
        return `${element.tagName.toLowerCase()} "${name}" の中身が箱から横にはみ出す（中身${element.scrollWidth}px > 箱${element.clientWidth}px）`;
      });
    return { checked, problems };
  });
}
