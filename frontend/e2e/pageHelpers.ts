// 全状態の走査と e2e-live がページへ入れる補助（ブラウザの中で動く）。走査の段取りは e2e/states.ts が持つ。

export interface Opener {
  id: number;
  label: string;
  /** 同じタブ列のタブ（同時に1つしか選べない兄弟）。開閉の部品はnull。 */
  group: number | null;
  /** タブ列で押す前に選ばれていたタブ。 */
  restoreId: number | null;
}
export interface Spot {
  x: number;
  y: number;
  pressable: boolean;
}

interface PageHelpers {
  /** 部品の見分け: 要素から祖先（htmlの手前）までの、タグと並べ替えたクラスの並び。同じ並びには同じCSSの規則が当たる。 */
  componentKey(el: Element): string;
  /** 部品の検査を段階ごとに1回にする。その段階でkindについて初めて見る部品ならtrue（見たことを記録する）。 */
  firstInPhase(kind: string, key: string): boolean;
  resetPhase(): void;
  fingerprint(): string;
  snapshot(skipKeys: string[]): { fp: string; present: string[]; openers: Opener[] };
  center(id: number): Spot | null;
  settle(): Promise<{ ok: boolean; fp: string }>;
  stableScale(): Promise<number>;
  /** 検査のタッチが画面の状態を変えないようにする。(x, y)の入力欄の値を覚え、アプリへのタッチ・ポインタ・入力の
   * イベントを止める（ページの拡大はブラウザが`touch-action`で決めるので、止めても変わらない）。 */
  isolate(x: number, y: number): void;
  /** isolateをやめ、覚えた入力欄の値を戻す（ブラウザの既定の動きでスライダーのつまみが動くため）。 */
  release(): void;
}

declare global {
  interface Window {
    __e2e: PageHelpers;
  }
}

/** ページが読み込まれる前に入れる補助（`page.addInitScript`へ渡す。ブラウザの中で動く）。 */
export function installPageHelpers(): void {
  const OPENER = '[aria-expanded="false"], [role="tab"][aria-selected="false"]';
  const SWITCH = '[aria-expanded], [role="tab"]';

  // 落ち着きの判定で待つ通信は、メインスレッドのfetch・XHRだけ（地図のタイルはWorkerの中で取るので、この包みは及ばない）。
  let inflight = 0;
  const originalFetch = window.fetch;
  window.fetch = function (...args: Parameters<typeof fetch>) {
    inflight += 1;
    return originalFetch.apply(this, args).finally(() => (inflight -= 1));
  };
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args: Parameters<XMLHttpRequest["send"]>) {
    inflight += 1;
    this.addEventListener("loadend", () => (inflight -= 1), { once: true });
    return originalSend.apply(this, args);
  };
  let mutations = 0;
  new MutationObserver((records) => (mutations += records.length)).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });

  const ids = new WeakMap<Element, number>();
  const nodes = new Map<number, Element>();
  let next = 1;
  const id = (el: Element) => {
    let n = ids.get(el);
    if (!n) {
      n = next++;
      ids.set(el, n);
      nodes.set(n, el);
    }
    return n;
  };
  const seen = new Map<string, Set<string>>();
  const visible = (el: Element) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && el.checkVisibility({ visibilityProperty: true });
  };
  const componentKey = (el: Element) => {
    const parts: string[] = [];
    for (let e: Element | null = el; e && e !== document.documentElement; e = e.parentElement) {
      parts.push(
        e.tagName.toLowerCase() +
          [...e.classList]
            .sort()
            .map((c) => `.${c}`)
            .join(""),
      );
    }
    return parts.join("<");
  };
  // 同じタブ列のタブは見分けが同じになり、選ばれたタブが移っても多重集合は変わらないので、列の中の位置を添える。
  const switchKey = (el: Element) => {
    if (el.getAttribute("role") !== "tab") return componentKey(el);
    const tabs = [...(el.closest('[role="tablist"]')?.querySelectorAll('[role="tab"]') ?? [])];
    return `${componentKey(el)}#${tabs.indexOf(el)}`;
  };
  // 指紋: 開閉の値を部品の見分けごとに集めたもの（同じ部品が複数あれば多重集合）と倍率。localStorageは入れない
  // ——辿る間にページを読み直さないので、保存値はアプリの状態を通してしか画面に効かず、それは開閉の値で読める。
  const fingerprint = () =>
    [
      ...[...document.querySelectorAll(SWITCH)]
        .map((el) => `${switchKey(el)} = ${el.getAttribute("aria-expanded")}/${el.getAttribute("aria-selected")}`)
        .sort(),
      `倍率 ${window.visualViewport?.scale ?? 1}`,
    ].join("\n");
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  // アプリより先に入れるので、windowの捕捉の段でアプリのどの受け口よりも先に呼ばれる。
  let held: { input: HTMLInputElement; value: string } | null = null;
  let isolating = false;
  for (const type of [
    "touchstart",
    "touchmove",
    "touchend",
    "touchcancel",
    "pointerdown",
    "pointermove",
    "pointerup",
    "pointercancel",
    "input",
    "change",
  ]) {
    window.addEventListener(type, (event) => isolating && event.stopImmediatePropagation(), {
      capture: true,
      passive: true,
    });
  }

  window.__e2e = {
    componentKey,
    firstInPhase(kind, key) {
      const keys = seen.get(kind) ?? new Set<string>();
      seen.set(kind, keys);
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    },
    resetPhase() {
      seen.clear();
    },
    fingerprint,
    snapshot(skipKeys) {
      const skip = new Set(skipKeys);
      const present = [...new Set([...document.querySelectorAll(SWITCH)].filter(visible).map(componentKey))];
      const openers: Opener[] = [];
      for (const el of document.querySelectorAll(OPENER)) {
        if (!visible(el) || skip.has(componentKey(el))) continue;
        let group: number | null = null;
        let restoreId: number | null = null;
        if (el.getAttribute("role") === "tab") {
          const list = el.closest('[role="tablist"]');
          group = list ? id(list) : null;
          const selected = list?.querySelector('[role="tab"][aria-selected="true"]');
          restoreId = selected ? id(selected) : null;
        }
        const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30);
        openers.push({
          id: id(el),
          label: `${el.getAttribute("role") ?? el.tagName.toLowerCase()} "${name}"`,
          group,
          restoreId,
        });
      }
      return { fp: fingerprint(), present, openers };
    },
    // 押せる: 中心点（Playwrightが押す点と同じ）が画面内にあり、そこでのヒットテストが部品自身か子孫を返す。
    center(n) {
      const el = nodes.get(n);
      if (!el || !el.isConnected) return null;
      const box = el.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const inside = x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight;
      const hit = inside ? document.elementFromPoint(x, y) : null;
      return { x, y, pressable: !!hit && el.contains(hit) };
    },
    // 落ち着いた: メインスレッドの通信0件・実行中のアニメーション0件・1フレームの間のDOMの変化0件・指紋が前の
    // フレームと同じ。
    async settle() {
      const deadline = performance.now() + 15_000;
      let previous = "";
      while (performance.now() < deadline) {
        mutations = 0;
        await frame();
        const running = document.getAnimations().filter((a) => a.playState === "running").length;
        const current = fingerprint();
        if (current === previous && running === 0 && inflight === 0 && mutations === 0)
          return { ok: true, fp: current };
        previous = current;
      }
      return { ok: false, fp: fingerprint() };
    },
    async stableScale() {
      let previous = -1;
      for (let i = 0; i < 60; i += 1) {
        await frame();
        const scale = window.visualViewport?.scale ?? 1;
        if (scale === previous) return scale;
        previous = scale;
      }
      return previous;
    },
    isolate(x, y) {
      const hit = document.elementFromPoint(x, y);
      held = hit instanceof HTMLInputElement ? { input: hit, value: hit.value } : null;
      isolating = true;
    },
    release() {
      isolating = false;
      if (held) held.input.value = held.value;
      held = null;
    },
  };
}
