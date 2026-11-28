"use client";

import Link from "next/link";
import { useId } from "react";

import { Button, buttonVariants } from "@/components/ui/Button/Button";
import { MAP_TOP_CARD_CLASS } from "@/components/FirstVisitIntro/FirstVisitIntro";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";

import type { RideKeep } from "../useRideKeep";

const TITLE = {
  sending: "走行ログに残しています",
  kept: "走行ログに残しました",
  failed: "走りを残せませんでした",
} as const;

/** 案内を終えた走りを送った結果を出す、地図の上のカード。 */
export default function RideKeepCard({ rideKeep }: { rideKeep: RideKeep }) {
  const { step } = rideKeep;
  const titleId = useId();
  if (step === "hidden") return null;

  return (
    <section aria-labelledby={titleId} className={MAP_TOP_CARD_CLASS}>
      <div className="flex items-start justify-between gap-2">
        <h2 id={titleId} className={cn(textVariants({ variant: "heading" }), "m-0")}>
          {TITLE[step]}
        </h2>
        {step !== "sending" && (
          <Button
            usage="カードを閉じます。"
            variant="ghost"
            size="close"
            className="flex-none"
            aria-label="閉じる"
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
          data-usage="残した走りを、走行ログのページで見返します。"
        >
          見る
        </Link>
      )}

      {step === "failed" && (
        <p className={cn(textVariants({ variant: "body" }), "m-0")}>
          走りは端末に置き、次に案内を終えたときに送り直します。
        </p>
      )}
    </section>
  );
}
