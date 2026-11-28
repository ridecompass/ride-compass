"use client";

import { Button, buttonVariants } from "@/components/ui/Button/Button";
import { cardVariants } from "@/components/ui/Card/Card";
import { StreetViewIcon } from "@/components/ui/icons/lucideIcons";
import { cn } from "@/lib/cn";
import { onAndroid, streetViewUrl, type StreetViewAim } from "@/lib/streetViewUrl";

/** 地図の右の列の、Street View の矢印を出す・しまうボタン。 */
export function StreetViewAimButton({
  aiming,
  disabled,
  onToggle,
}: {
  aiming: boolean;
  /** 地図の見えている所がまだ分からない間。 */
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      variant="mapCtrl"
      size="mapCtrl"
      aria-label="ストリートビューの地点と向きを決める"
      aria-pressed={aiming}
      usage="地図の真ん中に矢印を出します。点をつまんで地点を、輪の白い丸を回して向きを決め、その地点と向きでストリートビューを開けます。もう一度押すとしまいます。"
      className={cn(aiming && "shadow-[inset_0_0_0_2px_var(--color-accent)]")}
      disabled={disabled}
      onClick={onToggle}
    >
      <StreetViewIcon />
    </Button>
  );
}

/** 矢印を出している間の帯: 決め方の文と、やめる・開く。 */
export function StreetViewAimBar({ aim, onEnd }: { aim: StreetViewAim; onEnd: () => void }) {
  return (
    <div
      role="group"
      aria-label="ストリートビューの地点と向き"
      className={cn(
        cardVariants({ variant: "float" }),
        "pointer-events-auto flex w-[min(20rem,calc(100cqw-1.5rem-var(--map-ctrl-margin)-var(--map-ctrl-column-width)))] flex-col gap-2 rounded-lg p-3 text-[length:var(--font-size-sm)]",
      )}
    >
      <p>青い点をつまんで地点を、輪の白い丸を回して向きを決めます。</p>
      <div className="flex justify-between gap-2">
        <Button variant="secondary" size="sm" usage="矢印をしまいます。" onClick={onEnd}>
          やめる
        </Button>
        {/* 押す前に決まったリンクにする（押してから開くと、iPhone の Safari が新しい窓を止め、Android の Chrome がアプリを開かない）。 */}
        <a
          href={streetViewUrl(aim, onAndroid())}
          target="_blank"
          rel="noopener noreferrer"
          data-usage="矢印の地点と向きの Street View を、別のタブ（スマホでは Google マップのアプリ）で開きます。"
          className={buttonVariants({ variant: "primary", size: "sm" })}
        >
          ストリートビューを開く
        </a>
      </div>
    </div>
  );
}
