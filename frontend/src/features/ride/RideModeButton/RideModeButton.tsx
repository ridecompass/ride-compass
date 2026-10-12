"use client";

import { Button } from "@/components/ui/Button/Button";
import { cardVariants } from "@/components/ui/Card/Card";
import { RideModeIcon } from "@/components/ui/icons/icons";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";

import type { RideStatus } from "../useRideMode";
import type { ScreenWakeLockStatus } from "../useScreenWakeLock";

/** 押したときに何が起きるか（吹き出しの名前）。名前（`aria-label`）は「走行モード」のまま、入切は`aria-pressed`で示す。 */
const NEXT_ACTION: Record<RideStatus, string> = {
  off: "走行モードを始める",
  waiting: "走行モードを止める",
  following: "走行モードを止める",
  paused: "地図を現在地へ戻す",
};

interface RideModeButtonProps {
  status: RideStatus;
  error: string | null;
  screenWakeLock: ScreenWakeLockStatus;
  onPress: () => void;
}

/** 地図の右の列の走行モードのボタン。始められなかった理由と、画面を点けたままにできない端末であることを、ボタンの横に出す。 */
export default function RideModeButton({ status, error, screenWakeLock, onPress }: RideModeButtonProps) {
  const notice =
    error ??
    (screenWakeLock === "unavailable"
      ? "この端末では画面を点けたままにできません。画面が消えると現在地も届かなくなるので、自動ロックの設定を確かめてください。"
      : null);
  return (
    <div className="relative flex">
      <Button
        variant="mapCtrl"
        size="mapCtrl"
        onClick={onPress}
        aria-label="走行モード"
        aria-pressed={status !== "off"}
        title={NEXT_ACTION[status]}
        usage="押すと走行モードを始め、現在地を追って地図を動かし続けます（画面も点けたままにします）。地図を指で動かすと追うのを休み、もう一度押すと現在地へ戻ります。追っている間に押すと止めます。走行モードの間は、方位のボタンで北が上と進む向きが上を切り替えます。"
        className={cn(
          status === "following" && "text-[var(--color-accent)]",
          status === "waiting" && "animate-pulse text-[var(--color-accent)] motion-reduce:animate-none",
          status === "paused" && "text-[var(--color-muted-strong)]",
        )}
      >
        <RideModeIcon />
      </Button>
      {notice !== null && (
        <p
          className={cn(
            cardVariants({ variant: "float" }),
            textVariants({ variant: error !== null ? "error" : "hint" }),
            "pointer-events-none absolute top-0 right-full mr-2 w-max max-w-55 border-0 px-2.5 py-1.5",
          )}
        >
          {notice}
        </p>
      )}
    </div>
  );
}
