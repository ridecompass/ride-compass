"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { GuideText } from "@/components/ui/GuideText/GuideText";
import { cardVariants } from "@/components/ui/Card/Card";
import { textVariants } from "@/components/ui/Text/Text";
import { MenuIcon } from "@/components/ui/icons/lucideIcons";
import { originMarkColor, PIN_MARK_BACKGROUND, PinMark } from "@/components/PinMark/PinMark";
import { useStoredState } from "@/hooks/useStoredState";
import { useIsomorphicLayoutEffect } from "@/hooks/useIsomorphicLayoutEffect";
import { cn } from "@/lib/cn";

const FIRST_VISIT_INTRO_STORAGE_KEY = "ridecompass:first-visit-intro-closed";

interface FirstVisitIntroProps {
  /** 最初の位置の取得が決着して、位置が分からないと分かったか。真の間は出発地の印が灰色の仮の地点なので、
   * 地図をタップして置く手順を案内する（決着するまでは「はじめは現在地」のまま）。 */
  locationUnknown: boolean;
}

/**
 * 初めて開いたときだけ地図の上に出す案内。閉じるとこの端末では次から出ない。
 * 保存値の復元はマウント後なので、マウントするまで出さない（出すとSSRのHTMLに載り、閉じた人にも一瞬見える）。
 */
export default function FirstVisitIntro({ locationUnknown }: FirstVisitIntroProps) {
  const [closed, setClosed] = useStoredState(FIRST_VISIT_INTRO_STORAGE_KEY, "初回の案内を閉じたか", false);
  const [mounted, setMounted] = useState(false);
  const titleId = useId();
  useIsomorphicLayoutEffect(() => setMounted(true), []);

  if (!mounted || closed) return null;

  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        cardVariants({ variant: "float" }),
        "absolute top-16 left-1/2 z-[var(--z-map-detail)] flex w-[min(24rem,calc(100%-2*var(--space-3)))] -translate-x-1/2 flex-col gap-2 p-3",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <h2 id={titleId} className={cn(textVariants({ variant: "heading" }), "m-0")}>
          RideCompass
        </h2>
        <Button
          usage="案内を閉じます。"
          variant="ghost"
          size="bare"
          className="px-1"
          aria-label="案内を閉じる"
          onClick={() => setClosed(true)}
        >
          ✕
        </Button>
      </div>
      <p className={cn(textVariants({ variant: "body" }), "m-0")}>走りやすい周回ルートを作ります。</p>
      <ol className={cn(textVariants({ variant: "body" }), "m-0 flex list-decimal flex-col gap-1.5 pl-5")}>
        <li>
          <span
            className="mr-1 inline-flex rounded-full p-0.5 align-[-3px] shadow-sm"
            style={{ background: PIN_MARK_BACKGROUND }}
          >
            <PinMark role="origin" size={14} originColor={originMarkColor(!locationUnknown)} />
          </span>
          {locationUnknown ? "地図をタップして出発地を置く" : "出発地を決める[はじめは現在地。つかんで動かせます]"}
        </li>
        <li>
          <GuideText text="「ルート設定」で距離を決めて「ルート生成」" />
        </li>
        <li>
          分からない所は
          <span role="img" aria-label="メニュー" className="mx-0.5 inline-flex align-[-2px]">
            <MenuIcon size={13} />
          </span>
          の「使い方を見る」
        </li>
      </ol>
      <Button
        usage="案内を閉じて、地図を使い始めます。"
        variant="primary"
        size="sm"
        className="self-end"
        onClick={() => setClosed(true)}
      >
        はじめる
      </Button>
    </section>
  );
}
