"use client";

import { useState } from "react";

import { Button } from "@/components/ui/Button/Button";
import { cardVariants } from "@/components/ui/Card/Card";
import { dotVariants } from "@/components/ui/Dot/Dot";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/Popover/Popover";
import { RideModeIcon } from "@/components/ui/icons/lucideIcons";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";

import type { RideStatus } from "../useRideMode";
import type { ScreenWakeLockStatus } from "../useScreenWakeLock";

const WAKE_LOCK_UNAVAILABLE =
  "この端末では画面を点けたままにできません。画面が消えると現在地も届かなくなるので、自動ロックの設定を確かめてください。";

const HEADING_NEEDS_GESTURE = "現在地の印にスマホの向きを出すには、向きを読む許しが要ります。";

const NOTICE_CARD = "absolute top-0 right-full mr-2 w-max max-w-55 border-0 px-2.5 py-1.5";

interface RideModeButtonProps {
  status: RideStatus;
  error: string | null;
  screenWakeLock: ScreenWakeLockStatus;
  /** スマホの向きを読む許しを求め直す。求め直しが要る間だけ値がある。 */
  onRequestHeading: (() => void) | null;
  /** 止まっていれば始め、走行モードの間は案内を終える。 */
  onPress: () => void;
  /** 休む（位置を受けるのをやめ、ルートと進み具合は残す）。 */
  onRest: () => void;
  /** 休んでいれば、続きから走る。 */
  onResume: () => void;
}

/** 地図の右の列の走行モードのボタン。走行モードの間に押すと、案内を終えるか、休む（休んでいれば続きから走る）かを選ばせる。始められなかった理由と、
 * スマホの向きを読む許しを求め直すボタンと、画面を点けたままにできない端末であることを、ボタンの横に出す。最後のものは走っている間ずっと地図を覆わないよう閉じられ、
 * 閉じたあとはボタンの角の印と読み上げの説明に残す。 */
export default function RideModeButton({
  status,
  error,
  screenWakeLock,
  onRequestHeading,
  onPress,
  onRest,
  onResume,
}: RideModeButtonProps) {
  const [wakeNoticeClosed, setWakeNoticeClosed] = useState(false);
  const [choosing, setChoosing] = useState(false);
  // 止めたら、次に始めたときにまた知らせる。
  if (status === "off" && wakeNoticeClosed) setWakeNoticeClosed(false);
  if (status === "off" && choosing) setChoosing(false);
  const wakeLockUnavailable = screenWakeLock === "unavailable";
  const resting = status === "resting";

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
            usage="押すと走行モードを始め、現在地を追って地図を動かし続けます（画面も点けたままにします）。走行モードの間に押すと、案内を終えるか休むかを選べます。休むと現在地を受けるのも画面を点けたままにするのもやめ、ルートと進み具合を残します。地図の下の「続きから走る」で、休む前の進み具合から続けます。地図を指で動かすと追うのだけを休み、地図の下の「現在地へ戻る」で追い直します。走行モードの間は、方位のボタンで北が上と進む向きが上を切り替えます。"
            data-ride={status}
            className={cn(
              "relative",
              "data-[ride=following]:bg-[var(--color-accent)] data-[ride=following]:text-white",
              "data-[ride=waiting]:animate-pulse data-[ride=waiting]:bg-[var(--color-accent)] data-[ride=waiting]:text-white motion-reduce:animate-none",
              "data-[ride=paused]:text-[var(--color-accent)] data-[ride=paused]:shadow-[0_0_0_2px_var(--color-accent)]",
              "data-[ride=resting]:text-[var(--color-accent)] data-[ride=resting]:shadow-[0_0_0_2px_var(--color-accent)]",
            )}
          >
            <RideModeIcon />
            {wakeLockUnavailable && (
              <span aria-hidden="true" className={cn(dotVariants({ tone: "warning" }), "absolute top-0.5 right-0.5")} />
            )}
          </Button>
        </PopoverAnchor>
        <PopoverContent side="left" align="end" aria-label="走行モードの続け方" className="flex flex-col gap-1.5">
          {resting ? (
            <Button
              variant="primary"
              size="md"
              onClick={() => {
                setChoosing(false);
                onResume();
              }}
              usage="現在地を受け直し、休む前の進み具合から案内を続けます。"
            >
              続きから走る
            </Button>
          ) : (
            <Button
              variant="primary"
              size="md"
              onClick={() => {
                setChoosing(false);
                onRest();
              }}
              usage="現在地を受けるのと画面を点けたままにするのをやめ、電池を守ります。ルートと進み具合は残り、読み込み直しても休んだまま戻ります。地図の下の「続きから走る」で続きから走れます。"
            >
              休む
            </Button>
          )}
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
      ) : onRequestHeading !== null ? (
        <div
          className={cn(
            cardVariants({ variant: "float" }),
            "pointer-events-auto flex flex-col items-start gap-1.5",
            NOTICE_CARD,
          )}
        >
          <p className={textVariants({ variant: "hint" })}>{HEADING_NEEDS_GESTURE}</p>
          <Button
            variant="primary"
            size="sm"
            onClick={onRequestHeading}
            usage="スマホの向きを読む許しを求めます。許すと、現在地の印にスマホが向いている方角が出ます。"
          >
            向きを出す
          </Button>
        </div>
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
