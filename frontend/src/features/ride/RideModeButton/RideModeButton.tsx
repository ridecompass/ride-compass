"use client";

import { useState } from "react";

import { Button } from "@/components/ui/Button/Button";
import { cardVariants } from "@/components/ui/Card/Card";
import { dotVariants } from "@/components/ui/Dot/Dot";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/Popover/Popover";
import { RideModeIcon } from "@/components/ui/icons/icons";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";

import type { RideStatus } from "../useRideMode";
import type { ScreenWakeLockStatus } from "../useScreenWakeLock";

const WAKE_LOCK_UNAVAILABLE =
  "この端末では画面を点けたままにできません。画面が消えると現在地も届かなくなるので、自動ロックの設定を確かめてください。";

const NOTICE_CARD = "absolute top-0 right-full mr-2 w-max max-w-55 border-0 px-2.5 py-1.5";

interface RideModeButtonProps {
  status: RideStatus;
  error: string | null;
  screenWakeLock: ScreenWakeLockStatus;
  /** 止まっていれば始め、走行モードの間は案内を終える。 */
  onPress: () => void;
  /** 追うのを休む（ルートと進み具合は残す）。 */
  onRest: () => void;
}

/** 地図の右の列の走行モードのボタン。走行モードの間に押すと、案内を終えるか休むかを選ばせる。始められなかった理由と、
 * 画面を点けたままにできない端末であることを、ボタンの横に出す。後者は走っている間ずっと地図を覆わないよう閉じられ、
 * 閉じたあとはボタンの角の印と読み上げの説明に残す。 */
export default function RideModeButton({ status, error, screenWakeLock, onPress, onRest }: RideModeButtonProps) {
  const [wakeNoticeClosed, setWakeNoticeClosed] = useState(false);
  const [choosing, setChoosing] = useState(false);
  // 止めたら、次に始めたときにまた知らせる。
  if (status === "off" && wakeNoticeClosed) setWakeNoticeClosed(false);
  if (status === "off" && choosing) setChoosing(false);
  const wakeLockUnavailable = screenWakeLock === "unavailable";

  return (
    <div className="relative flex">
      <Popover open={choosing} onOpenChange={setChoosing}>
        <PopoverAnchor asChild>
          <Button
            variant="mapCtrl"
            size="mapCtrl"
            onClick={() => (status === "off" ? onPress() : setChoosing((open) => !open))}
            aria-label="走行モード"
            aria-pressed={status !== "off"}
            aria-haspopup={status === "off" ? undefined : "dialog"}
            aria-expanded={status === "off" ? undefined : choosing}
            aria-description={wakeLockUnavailable ? WAKE_LOCK_UNAVAILABLE : undefined}
            usage="押すと走行モードを始め、現在地を追って地図を動かし続けます（画面も点けたままにします）。走行モードの間に押すと、案内を終えるか休むかを選べます。休む・地図を指で動かすと追うのを休み、ルートと進み具合を残したまま地図を自由に動かせます。地図の下の「現在地へ戻る」で続きから追い直します。走行モードの間は、方位のボタンで北が上と進む向きが上を切り替えます。"
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
        </PopoverAnchor>
        <PopoverContent side="left" align="end" aria-label="走行モードを止める" className="flex flex-col gap-1.5">
          <Button
            variant="primary"
            size="md"
            onClick={() => {
              setChoosing(false);
              onRest();
            }}
            usage="現在地を追うのを休み、地図を自由に動かせるようにします。ルートと進み具合は残り、地図の下の「現在地へ戻る」で続きから走れます。"
          >
            {status === "paused" ? "休みを続ける" : "休む"}
          </Button>
          <Button
            size="md"
            onClick={() => {
              setChoosing(false);
              onPress();
            }}
            usage="走行モードを止めて、走る前の画面に戻します。進み具合は消え、続きからは走れません。"
          >
            案内を終える
          </Button>
        </PopoverContent>
      </Popover>
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
