"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/Button/Button";
import { cardVariants } from "@/components/ui/Card/Card";
import { LocateIcon } from "@/components/ui/icons/icons";
import { RideModeIcon } from "@/components/ui/icons/lucideIcons";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";
import { mapOverlayEdge } from "@/lib/mapOverlayEdges";
import type { RideStatus } from "@/features/ride/useRideMode";

interface RideBottomProps {
  status: RideStatus;
  /** 現在地が選んだ候補のルートを外れているか。 */
  offRoute: boolean;
  onResume: () => void;
  /** 選んだ候補の道のりのグラフ。候補が無ければ null。 */
  profile: ReactNode;
  /** 左下に添える俯瞰図。出さない間は null。 */
  overview: ReactNode;
}

/**
 * 走行モードの間、地図の下に選んだ候補の道のりのグラフを出し、そのすぐ上に続きから走るための操作を1か所で出す: 休んでいる間は
 * 「続きから走る」、地図を指で動かして追うのを休んでいる間は「現在地へ戻る」、追っている間にルートを外れたら、
 * 戻れば続きから案内すること。俯瞰図は、それらの上の左に積む。
 */
export default function RideBottom({ status, offRoute, onResume, profile, overview }: RideBottomProps) {
  const t = useTranslations("ride");
  const awayNotice = status === "following" && offRoute;
  const resumable = status === "paused" || status === "resting";
  if (profile === null && overview === null && !resumable && !awayNotice) return null;
  return (
    <div
      {...mapOverlayEdge("bottom")}
      className="pointer-events-none absolute inset-x-2 bottom-2 z-[var(--z-map-control)] flex flex-col items-center gap-2"
    >
      {overview !== null && <div className="self-start">{overview}</div>}
      {status === "resting" && (
        <Button
          variant="primary"
          size="md"
          className="pointer-events-auto gap-1.5 shadow-md"
          onClick={onResume}
          usage={t("bottom.resumeUsage")}
        >
          <RideModeIcon />
          {t("resume")}
        </Button>
      )}
      {status === "paused" && (
        <Button
          variant="primary"
          size="md"
          className="pointer-events-auto gap-1.5 shadow-md"
          onClick={onResume}
          usage={t("bottom.followAgainUsage")}
        >
          <LocateIcon />
          {t("followAgain")}
        </Button>
      )}
      {awayNotice && (
        <p
          className={cn(
            cardVariants({ variant: "float" }),
            textVariants({ variant: "hint" }),
            "pointer-events-auto rounded-md px-2.5 py-1.5",
          )}
        >
          {t("bottom.offRouteNotice")}
        </p>
      )}
      {profile !== null && (
        <section
          aria-label={t("bottom.profile")}
          className={cn(cardVariants({ variant: "float" }), "pointer-events-auto w-full rounded-md px-2 py-1.5")}
        >
          {profile}
        </section>
      )}
    </div>
  );
}
