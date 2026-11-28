"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/Button/Button";
import { GuideText } from "@/components/ui/GuideText/GuideText";
import { cardVariants } from "@/components/ui/Card/Card";
import { dotVariants } from "@/components/ui/Dot/Dot";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/Popover/Popover";
import { RideModeIcon } from "@/components/ui/icons/lucideIcons";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";

import type { RideStatus } from "../useRideMode";
import type { ScreenWakeLockStatus } from "../useScreenWakeLock";

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
  /** 知らせを置く所。null ならボタンの左に置く。 */
  noticeHost: HTMLElement | null;
}

/** 地図の右の列の走行モードのボタン。走行モードの間に押すと、案内を終えるか、休む（休んでいれば続きから走る）かを選ばせる。始められなかった理由と、
 * スマホの向きを読む許しを求め直すボタンと、画面を点けたままにできない端末であることを、ボタンの横（`noticeHost`があればその中）に出す。最後のものは走っている間ずっと地図を覆わないよう閉じられ、
 * 閉じたあとはボタンの角の印と読み上げの説明に残す。 */
export default function RideModeButton({
  status,
  error,
  screenWakeLock,
  onRequestHeading,
  onPress,
  onRest,
  onResume,
  noticeHost,
}: RideModeButtonProps) {
  const t = useTranslations();
  const [wakeNoticeClosed, setWakeNoticeClosed] = useState(false);
  const [choosing, setChoosing] = useState(false);
  // 止めたら、次に始めたときにまた知らせる。
  if (status === "off" && wakeNoticeClosed) setWakeNoticeClosed(false);
  if (status === "off" && choosing) setChoosing(false);
  const wakeLockUnavailable = screenWakeLock === "unavailable";
  const resting = status === "resting";
  const choose = (action: () => void) => () => {
    setChoosing(false);
    action();
  };

  const noticePlace = cn(
    "w-max max-w-55 border-0 px-2.5 py-1.5",
    noticeHost === null && "absolute top-0 right-full mr-2",
  );
  const notice =
    error !== null ? (
      <p
        className={cn(
          cardVariants({ variant: "float" }),
          textVariants({ variant: "error" }),
          "pointer-events-none",
          noticePlace,
        )}
      >
        <GuideText text={error} />
      </p>
    ) : onRequestHeading !== null ? (
      <div
        className={cn(
          cardVariants({ variant: "float" }),
          "pointer-events-auto flex flex-col items-start gap-1.5",
          noticePlace,
        )}
      >
        <p className={textVariants({ variant: "hint" })}>{t("ride.mode.headingNeedsGesture")}</p>
        <Button variant="primary" size="sm" onClick={onRequestHeading} usage={t("ride.mode.requestHeadingUsage")}>
          {t("ride.mode.requestHeading")}
        </Button>
      </div>
    ) : (
      wakeLockUnavailable &&
      !wakeNoticeClosed && (
        <div
          className={cn(cardVariants({ variant: "float" }), "pointer-events-auto flex items-start gap-1", noticePlace)}
        >
          <p role="status" className={textVariants({ variant: "hint" })}>
            <GuideText text={t("ride.mode.wakeLockUnavailable")} />
          </p>
          <Button
            usage={t("ride.mode.closeNoticeUsage")}
            variant="ghost"
            size="close"
            onClick={() => setWakeNoticeClosed(true)}
            aria-label={t("common.close")}
            className="flex-none"
          >
            ✕
          </Button>
        </div>
      )
    );

  return (
    <div className="relative flex">
      <Popover open={choosing} onOpenChange={setChoosing}>
        <PopoverAnchor asChild>
          <Button
            variant="mapCtrl"
            size="mapCtrl"
            onClick={() => (status === "off" ? onPress() : setChoosing((open) => !open))}
            aria-label={t("ride.mode.label")}
            aria-pressed={status !== "off"}
            aria-haspopup={status === "off" ? undefined : "dialog"}
            aria-expanded={status === "off" ? undefined : choosing}
            aria-description={wakeLockUnavailable ? t("ride.mode.wakeLockUnavailable") : undefined}
            usage={t("ride.mode.usage", {
              end: t("ride.mode.end"),
              rest: t("ride.mode.rest"),
              resume: t("ride.resume"),
              followAgain: t("ride.followAgain"),
            })}
            data-ride={status}
            className={cn(
              "relative",
              "data-[ride=following]:bg-[var(--color-accent)] data-[ride=following]:text-white",
              "data-[ride=waiting]:animate-pulse data-[ride=waiting]:bg-[var(--color-accent)] data-[ride=waiting]:text-white motion-reduce:animate-none",
              "data-[ride=paused]:text-[var(--color-accent-text)] data-[ride=paused]:shadow-[0_0_0_2px_var(--color-accent)]",
              "data-[ride=resting]:text-[var(--color-accent-text)] data-[ride=resting]:shadow-[0_0_0_2px_var(--color-accent)]",
            )}
          >
            <RideModeIcon />
            {wakeLockUnavailable && (
              <span aria-hidden="true" className={cn(dotVariants({ tone: "warning" }), "absolute top-0.5 right-0.5")} />
            )}
          </Button>
        </PopoverAnchor>
        <PopoverContent side="left" align="end" aria-label={t("ride.mode.choice")} className="flex flex-col gap-1.5">
          {resting ? (
            <Button variant="primary" size="md" onClick={choose(onResume)} usage={t("ride.mode.resumeUsage")}>
              {t("ride.resume")}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="md"
              onClick={choose(onRest)}
              usage={t("ride.mode.restUsage", { resume: t("ride.resume") })}
            >
              {t("ride.mode.rest")}
            </Button>
          )}
          <Button size="md" onClick={choose(onPress)} usage={t("ride.mode.endUsage")}>
            {t("ride.mode.end")}
          </Button>
        </PopoverContent>
      </Popover>
      {noticeHost === null ? notice : createPortal(notice, noticeHost)}
    </div>
  );
}
