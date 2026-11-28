"use client";

import Link from "next/link";
import { useId } from "react";

import { Button, buttonVariants } from "@/components/ui/Button/Button";
import { MAP_TOP_CARD_CLASS } from "@/components/FirstVisitIntro/FirstVisitIntro";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";

import type { RideKeep } from "../useRideKeep";
import GoogleSignInButton from "./GoogleSignInButton";

const TITLE = {
  ask: "この走りを残しますか",
  signIn: "Google でログイン",
  consent: "走りの記録への同意",
  sending: "走行ログに残しています",
  kept: "走行ログに残しました",
  failed: "走りを残せませんでした",
} as const;

/** 案内を終えた走りを残すかを聞き、ログインと同意を経て送る、地図の上のカード。 */
export default function RideKeepCard({ rideKeep }: { rideKeep: RideKeep }) {
  const { step } = rideKeep;
  const titleId = useId();
  if (step.kind === "hidden") return null;
  const message = step.kind === "signIn" || step.kind === "consent" ? step.message : null;

  return (
    <section aria-labelledby={titleId} className={MAP_TOP_CARD_CLASS}>
      <div className="flex items-start justify-between gap-2">
        <h2 id={titleId} className={cn(textVariants({ variant: "heading" }), "m-0")}>
          {TITLE[step.kind]}
        </h2>
        {step.kind !== "sending" && (
          <Button
            usage="カードを閉じます。走りは端末に置いたままで、次に案内を終えたときにもう一度聞きます。"
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

      {step.kind === "ask" && (
        <>
          <p className={cn(textVariants({ variant: "body" }), "m-0")}>
            残すと、Google でログインして同意したあとに走行ログへ送ります。残さなければ、この端末から消します。
          </p>
          <div className="flex justify-end gap-2">
            <Button usage="この走りを端末から消します。" variant="ghost" size="sm" onClick={rideKeep.discard}>
              残さない
            </Button>
            <Button
              usage="Google でログインして、この走りを走行ログに残します。"
              variant="primary"
              size="sm"
              onClick={rideKeep.keep}
            >
              この走りを残す
            </Button>
          </div>
        </>
      )}

      {step.kind === "signIn" &&
        (step.clientId === null ? (
          <p className={cn(textVariants({ variant: "hint" }), "m-0")}>この環境ではログインできません。</p>
        ) : (
          <GoogleSignInButton
            clientId={step.clientId}
            onCredential={(credential) => void rideKeep.signIn(credential)}
          />
        ))}

      {step.kind === "consent" && (
        <>
          <ul className={cn(textVariants({ variant: "body" }), "m-0 flex list-disc flex-col gap-1 pl-5")}>
            <li>走りの位置と時刻・推したルート・生成の条件・見せた予報・端末とブラウザの名前を残します。</li>
            <li>あなたが走行ログで見返すことと、ルート生成の精度を上げる分析に使います。</li>
            <li>名前・メール・IP は持たず、あなたの走りを外へ出しません。</li>
          </ul>
          {/* 規約のページは別のタブで開く（この画面を離れると、聞いている途中の段が消える）。 */}
          <p className={cn(textVariants({ variant: "hint" }), "m-0")}>
            詳しくは
            <Link href="/terms" target="_blank" rel="noopener" className="underline">
              利用規約
            </Link>
            と
            <Link href="/privacy" target="_blank" rel="noopener" className="underline">
              プライバシーポリシー
            </Link>
            を読んでください。
          </p>
          <Button
            usage="規約に同意して、この走りを走行ログに残します。"
            variant="primary"
            size="sm"
            className="self-end"
            onClick={() => void rideKeep.consent(step.termsVersion)}
          >
            同意して残す
          </Button>
        </>
      )}

      {step.kind === "kept" && (
        <Link
          href="/ride-log"
          className={cn(buttonVariants({ variant: "primary", size: "sm" }), "self-end")}
          data-usage="残した走りを、走行ログのページで見返します。"
        >
          見る
        </Link>
      )}

      {step.kind === "failed" && <p className={cn(textVariants({ variant: "body" }), "m-0")}>{step.message}</p>}

      {message !== null && (
        <p role="alert" className={cn(textVariants({ variant: "error" }), "m-0")}>
          {message}
        </p>
      )}
    </section>
  );
}
