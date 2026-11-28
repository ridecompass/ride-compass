// デバッグモードの間、画面を止めた長いコマ（Chrome の Long Animation Frames。50ms 以上）を、そのコマで時間を使ったスクリプトと
// 一緒にデバッグログへ出す。重さの原因を、利用者の端末で測るため。
// 仕組みは https://developer.mozilla.org/en-US/docs/Web/API/PerformanceLongAnimationFrameTiming 。Chrome 123 から。Safari と
// Firefox は対応しないので、そう書いて何もしない。

import { debugLog } from "@/lib/debugLog";

/** Long Animation Frames の項目のうち、ここで読むもの（TypeScript の dom の型にまだ無い）。 */
interface LongFrameScript {
  duration: number;
  invoker: string;
  invokerType: string;
  sourceURL: string;
  sourceFunctionName: string;
  sourceCharPosition: number;
  forcedStyleAndLayoutDuration: number;
}
interface LongFrame extends PerformanceEntry {
  blockingDuration: number;
  renderStart: number;
  styleAndLayoutStart: number;
  scripts: LongFrameScript[];
}

const ENTRY_TYPE = "long-animation-frame";

/** 長いコマの記録を始め、止める関数を返す。 */
export function observeLongFrames(): () => void {
  if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes.includes(ENTRY_TYPE)) {
    debugLog("frame", "このブラウザは長いコマを記録できません（Chrome だけが対応）");
    return () => {};
  }
  const observer = new PerformanceObserver((list) => {
    for (const frame of list.getEntries() as LongFrame[]) {
      const end = frame.startTime + frame.duration;
      const scripts = [...frame.scripts]
        .sort((a, b) => b.duration - a.duration)
        .slice(0, 5)
        .map((script) => ({
          ms: Math.round(script.duration),
          関数: script.sourceFunctionName || "(無名)",
          きっかけ: `${script.invokerType} ${script.invoker}`,
          場所: `${script.sourceURL.split("/").pop() ?? ""}:${script.sourceCharPosition}`,
          強制レイアウトms: Math.round(script.forcedStyleAndLayoutDuration),
        }));
      const scriptMs = Math.round(frame.scripts.reduce((sum, script) => sum + script.duration, 0));
      const renderMs = frame.renderStart > 0 ? Math.round(end - frame.renderStart) : 0;
      debugLog(
        "frame",
        `長いコマ ${Math.round(frame.duration)}ms（スクリプト ${scriptMs}ms・描画 ${renderMs}ms）`,
        scripts,
      );
    }
  });
  observer.observe({ type: ENTRY_TYPE, buffered: false });
  return () => observer.disconnect();
}
