"use client";

import { useState } from "react";

import { Button } from "@/components/ui/Button/Button";
import { cardVariants } from "@/components/ui/Card/Card";
import { dotVariants } from "@/components/ui/Dot/Dot";
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

const WAKE_LOCK_UNAVAILABLE =
  "この端末では画面を点けたままにできません。画面が消えると現在地も届かなくなるので、自動ロックの設定を確かめてください。";

const NOTICE_CARD = "absolute top-0 right-full mr-2 w-max max-w-55 border-0 px-2.5 py-1.5";

interface RideModeButtonProps {
  status: RideStatus;
  error: string | null;
  screenWakeLock: ScreenWakeLockStatus;
  onPress: () => void;
}

/** 地図の右の列の走行モードのボタン。始められなかった理由と、画面を点けたままにできない端末であることを、ボタンの横に出す。
 * 後者は走っている間ずっと地図を覆わないよう閉じられ、閉じたあとはボタンの角の印と読み上げの説明に残す。 */
export default function RideModeButton({ status, error, screenWakeLock, onPress }: RideModeButtonProps) {
  const [wakeNoticeClosed, setWakeNoticeClosed] = useState(false);
  // 止めたら、次に始めたときにまた知らせる。
  if (status === "off" && wakeNoticeClosed) setWakeNoticeClosed(false);
  const wakeLockUnavailable = screenWakeLock === "unavailable";

  return (
    <div className="relative flex">
      <Button
        variant="mapCtrl"
        size="mapCtrl"
        onClick={onPress}
        aria-label="走行モード"
        aria-pressed={status !== "off"}
        aria-description={wakeLockUnavailable ? WAKE_LOCK_UNAVAILABLE : undefined}
        title={NEXT_ACTION[status]}
        usage="押すと走行モードを始め、現在地を追って地図を動かし続けます（画面も点けたままにします）。地図を指で動かすと追うのを休み、もう一度押すと現在地へ戻ります。追っている間に押すと止めます。走行モードの間は、方位のボタンで北が上と進む向きが上を切り替えます。"
        data-ride={status}
        className={cn(
          "relative",
          "data-[ride=following]:bg-[var(--color-accent)] data-[ride=following]:text-white",
          "data-[ride=waiting]:animate-pulse data-[ride=waiting]:bg-[var(--color-accent)] data-[ride=waiting]:text-white motion-reduce:animate-none",
          "data-[ride=paused]:text-[var(--color-accent)] data-[ride=paused]:shadow-[0_0_0_2px_var(--color-accent)]",
        )}
      >
        <RideModeIcon />
        {wakeLockUnavailable && (
          <span aria-hidden="true" className={cn(dotVariants({ tone: "warning" }), "absolute top-0.5 right-0.5")} />
        )}
      </Button>
      {error !== null ? (
        <p
          className={cn(
            cardVariants({ variant: "float" }),
            textVariants({ variant: "error" }),
            "pointer-events-none",
            NOTICE_CARD,
          )}
        >
          {error}
        </p>
      ) : (
        wakeLockUnavailable &&
        !wakeNoticeClosed && (
          <div
            className={cn(
              cardVariants({ variant: "float" }),
              "pointer-events-auto flex items-start gap-1",
              NOTICE_CARD,
            )}
          >
            <p className={textVariants({ variant: "hint" })}>{WAKE_LOCK_UNAVAILABLE}</p>
            <Button
              variant="ghost"
              size="iconRound"
              onClick={() => setWakeNoticeClosed(true)}
              aria-label="閉じる"
              className="flex-none text-[var(--foreground)]"
            >
              ✕
            </Button>
          </div>
        )
      )}
    </div>
  );
}
