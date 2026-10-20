/**
 * 画面を点けたままにする頼み（`features/ride/useScreenWakeLock.ts: useScreenWakeLock`）——走行モードの間だけ頼み、
 * 画面が隠れて端末に外されたら見えたときに頼み直し、走行モードを止めたら外す。頼めない端末ではそれを返す。
 *
 * 差し替えたもの: 画面を点けたままにする口（`navigator.wakeLock`。テスト環境に無いブラウザの機能）と、画面が見えているか
 * （`document.visibilityState`）。口は頼みごとに印（sentinel）を返し、テストが端末の側から外せる。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useScreenWakeLock } from "./useScreenWakeLock";

class FakeSentinel extends EventTarget {
  released = false;
  readonly type = "screen";
  async release() {
    if (this.released) return;
    this.released = true;
    this.dispatchEvent(new Event("release"));
  }
}

let sentinels: FakeSentinel[] = [];
let visibility: DocumentVisibilityState = "visible";

/** 頼みを受ける口を置く。`refuse`なら頼みを断る（省電力の設定等）。 */
function installWakeLock({ refuse = false }: { refuse?: boolean } = {}) {
  sentinels = [];
  const wakeLock = {
    async request() {
      if (refuse) throw new DOMException("refused", "NotAllowedError");
      const sentinel = new FakeSentinel();
      sentinels.push(sentinel);
      return sentinel;
    },
  };
  Object.defineProperty(navigator, "wakeLock", { value: wakeLock, configurable: true });
}

/** 画面を隠す・見せる。隠れると端末が頼みを外す（Screen Wake Lock の仕様の、見えなくなったときの手順）。 */
async function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  await act(async () => {
    if (next === "hidden") for (const sentinel of sentinels) await sentinel.release();
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

const held = () => sentinels.filter((sentinel) => !sentinel.released).length;

Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });

afterEach(() => {
  visibility = "visible";
  Reflect.deleteProperty(navigator, "wakeLock");
});

describe("useScreenWakeLock", () => {
  it("走行モードの間だけ頼み、隠れて外されたら見えたときに頼み直し、止めたら外す", async () => {
    installWakeLock();
    const { result, rerender } = renderHook(({ active }) => useScreenWakeLock(active), {
      initialProps: { active: false },
    });
    expect(result.current).toBe("off");
    expect(held()).toBe(0);

    rerender({ active: true });
    await waitFor(() => expect(result.current).toBe("held"));
    expect(held()).toBe(1);

    await setVisibility("hidden");
    expect(held()).toBe(0);
    await setVisibility("visible");
    await waitFor(() => expect(held()).toBe(1));
    expect(result.current).toBe("held");

    rerender({ active: false });
    await waitFor(() => expect(held()).toBe(0));
    expect(result.current).toBe("off");
  });

  it.each([
    { case: "口の無い端末", install: () => {} },
    { case: "頼みを断る端末", install: () => installWakeLock({ refuse: true }) },
  ])("$case では、走行モードの間「頼めない」を返す", async ({ install }) => {
    install();
    const { result } = renderHook(() => useScreenWakeLock(true));
    await waitFor(() => expect(result.current).toBe("unavailable"));
  });
});
