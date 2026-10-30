"use client";

import { useEffect, useEffectEvent, useMemo, useRef } from "react";
import useEmblaCarousel from "embla-carousel-react";
import { WheelGesturesPlugin } from "embla-carousel-wheel-gestures";
import { cn } from "@/lib/cn";

/** ルーラーの1コマ。`label`は読み上げと選んだ値の文。`major`は目盛りを太く、コマを広くする。
 * `tickLabel`は目盛りの下の短い文字（重ならないよう呼ぶ側が間引く）。 */
export interface RulerFrame {
  label: string;
  major?: boolean;
  tickLabel?: string;
}

// 目盛りの間隔（px）。大きい目盛りのコマは広げる。
const TICK_SPACING_PX = 18;
const TICK_SPACING_MAJOR_PX = 28;
// 選んだコマを合わせる左端の目印の位置（px）。コマの幅によらない。
const INDICATOR_OFFSET_PX = TICK_SPACING_PX / 2;

function frameWidth(frame: RulerFrame): number {
  return frame.major ? TICK_SPACING_MAJOR_PX : TICK_SPACING_PX;
}

interface RulerProps {
  frames: readonly RulerFrame[];
  /** framesの添字（framesは1コマ以上）。 */
  index: number;
  onIndexChange: (index: number) => void;
  ariaLabel: string;
  /** 押せない間は動かせず、薄く出す（選んでいるコマは見せたまま）。 */
  disabled?: boolean;
  /** 置き場の並べ方（幅・`touch-action`等）。 */
  className?: string;
  /** 長押しで出す使い方の説明。 */
  usage: string | null;
}

// 可変幅のコマ・ホイールの横スクロール・離した位置への吸着はEmblaが持ち、コマの中心を左端の目印へ合わせる。
// 目印より右に見えるコマだけを出し、残りは滑らせて出す。キーボード操作とsliderのARIAはEmblaに無いので自前で持つ。
const baseEmblaOptions = {
  align: (viewSize: number, snapSize: number) => INDICATOR_OFFSET_PX - snapSize / 2,
  containScroll: false as const,
};

/** ドラッグ・横スクロールでコマを選ぶルーラー。コマの意味は知らない（並びは呼ぶ側が作る）。 */
export default function Ruler({
  frames,
  index,
  onIndexChange,
  ariaLabel,
  disabled = false,
  className,
  usage,
}: RulerProps) {
  const emblaOptions = useMemo(() => ({ ...baseEmblaOptions, active: !disabled }), [disabled]);
  const [emblaRef, emblaApi] = useEmblaCarousel(emblaOptions, [WheelGesturesPlugin({ forceWheelAxis: "x" })]);
  // 最後に自分が報告した（または反映済みの）添字。外から変わったときだけスクロールし直す（自分のドラッグの報告で
  // 変わるたびにスクロールすると、ループになる）。
  const syncedIndexRef = useRef(index);
  // 初回はアニメーションさせずに合わせる。
  const hasMountedRef = useRef(false);

  useEffect(() => {
    if (!emblaApi) return;
    const alreadySynced = index === syncedIndexRef.current;
    if (hasMountedRef.current && alreadySynced) return;
    syncedIndexRef.current = index;
    const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    emblaApi.scrollTo(index, !hasMountedRef.current || prefersReducedMotion);
    hasMountedRef.current = true;
  }, [emblaApi, index]);

  // 選んだコマが変わるたびに報告する。`settle`は速いドラッグの後に来ないことがあるので、コマをまたいだときだけ
  // 来る`select`を使う。
  const reportSelected = useEffectEvent((next: number) => {
    if (next !== syncedIndexRef.current) {
      syncedIndexRef.current = next;
      onIndexChange(next);
    }
  });
  useEffect(() => {
    if (!emblaApi) return;
    const listener = () => reportSelected(emblaApi.selectedScrollSnap());
    emblaApi.on("select", listener);
    return () => {
      emblaApi.off("select", listener);
    };
  }, [emblaApi]);

  // スクロールの追従は外からの変化としてuseEffectが受ける。
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = Math.min(frames.length - 1, index + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, index - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = frames.length - 1;
    if (next !== null && next !== index) {
      e.preventDefault();
      onIndexChange(next);
    }
  };

  return (
    <div
      ref={emblaRef}
      className={cn(
        "relative h-8 cursor-grab overflow-x-auto overflow-y-hidden select-none [-webkit-tap-highlight-color:transparent] [-webkit-user-drag:none] [scrollbar-width:none] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] aria-disabled:cursor-default aria-disabled:opacity-40 [&::-webkit-scrollbar]:hidden",
        className,
      )}
      onKeyDown={handleKeyDown}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={frames.length - 1}
      aria-valuenow={index}
      aria-valuetext={frames[index].label}
      data-usage={usage ?? undefined}
    >
      <div className="flex h-full">
        {frames.map((f, i) => (
          <div
            key={i}
            className="group flex flex-shrink-0 flex-col items-center justify-start pt-2"
            data-major={f.major}
            style={{ width: frameWidth(f) }}
          >
            <span
              className="h-2 w-px bg-[var(--color-border-strong)] group-data-[major=true]:h-3.5 group-data-[major=true]:w-0.5 group-data-[major=true]:bg-[var(--color-muted-strong)]"
              aria-hidden="true"
            />
            {/* 文字の無いコマも高さを確保する（縦の位置が揃うように）。 */}
            <span className="mt-1 block h-3 max-w-9 truncate text-[0.55rem] leading-3 text-[var(--color-muted)] tabular-nums">
              {f.tickLabel ?? ""}
            </span>
          </div>
        ))}
      </div>
      <div
        className="pointer-events-none absolute top-0.5 h-6 w-0.5 -translate-x-1/2 rounded-full bg-[var(--color-accent)]"
        style={{ left: INDICATOR_OFFSET_PX }}
        aria-hidden="true"
      />
    </div>
  );
}
