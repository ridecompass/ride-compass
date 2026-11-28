"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId } from "react";

import { Button, buttonVariants } from "@/components/ui/Button/Button";
import { MAP_TOP_CARD_CLASS } from "@/components/FirstVisitIntro/FirstVisitIntro";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";

import type { RideKeep } from "../useRideKeep";

/** 案内を終えた走りを送った結果を出す、地図の上のカード。 */
export default function RideKeepCard({ rideKeep }: { rideKeep: RideKeep }) {
  const t = useTranslations();
  const { step } = rideKeep;
  const titleId = useId();
  if (step === "hidden") return null;

  return (
    <section aria-labelledby={titleId} className={MAP_TOP_CARD_CLASS}>
      <div className="flex items-start justify-between gap-2">
        <h2 id={titleId} className={cn(textVariants({ variant: "heading" }), "m-0")}>
          {t(`ride.keepCard.title.${step}`)}
        </h2>
        {step !== "sending" && (
          <Button
            usage={t("ride.keepCard.closeUsage")}
            variant="ghost"
            size="close"
            className="flex-none"
            aria-label={t("common.close")}
            onClick={rideKeep.close}
          >
            ✕
          </Button>
        )}
      </div>

      {step === "kept" && (
        <Link
          href="/ride-log"
          className={cn(buttonVariants({ variant: "primary", size: "sm" }), "self-end")}
          data-usage={t("ride.keepCard.viewUsage")}
        >
          {t("ride.keepCard.view")}
        </Link>
      )}

      {step === "failed" && (
        <p className={cn(textVariants({ variant: "body" }), "m-0")}>{t("ride.keepCard.retryLater")}</p>
      )}
    </section>
  );
}
