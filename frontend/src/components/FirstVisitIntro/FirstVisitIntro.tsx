"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { GuideText } from "@/components/ui/GuideText/GuideText";
import { cardVariants } from "@/components/ui/Card/Card";
import { textVariants } from "@/components/ui/Text/Text";
import { MenuIcon } from "@/components/ui/icons/lucideIcons";
import PointMark from "@/components/PinMark/PointMark";
import { HOW_TO_PLACE_ORIGIN } from "@/hooks/useLocation";
import { useStoredState } from "@/hooks/useStoredState";
import { useIsomorphicLayoutEffect } from "@/hooks/useIsomorphicLayoutEffect";
import { cn } from "@/lib/cn";
import { APP_NAME } from "@/lib/screenNames";

const FIRST_VISIT_INTRO_STORAGE_KEY = "ridecompass:first-visit-intro-closed";

/** 初回の案内を出しているか（閉じたことをこの端末に覚える）と、閉じる・もう一度出す操作。案内と、ヘッダーのメニューの入口が分かち合う。 */
export function useFirstVisitIntro() {
  const [closed, setClosed] = useStoredState(FIRST_VISIT_INTRO_STORAGE_KEY, "初回の案内を閉じたか", false);
  return { shown: !closed, close: () => setClosed(true), reopen: () => setClosed(false) };
}

/** 地図の上の中ほどに浮かべるカードの置き方（初回の案内と、案内を終えた走りを残すかのカードが同じ所に出る）。 */
export const MAP_TOP_CARD_CLASS = cn(
  cardVariants({ variant: "float" }),
  "absolute top-16 left-1/2 z-[var(--z-map-detail)] flex w-[min(24rem,calc(100%-2*var(--space-3)))] -translate-x-1/2 flex-col gap-2 p-3",
);

interface FirstVisitIntroProps {
  /** 案内を出しているか（`useFirstVisitIntro`の`shown`）。 */
  shown: boolean;
  onClose: () => void;
  /** 最初の位置の取得が決着して、位置が分からないと分かったか。真の間は出発地の印が灰色の仮の地点なので、
   * 地図をタップして置く手順を案内する（決着するまでは「はじめは現在地」のまま）。 */
  originLocateFailed: boolean;
}

/**
 * 初めて開いたときに地図の上に出す案内。閉じるとこの端末では次から出ず、ヘッダーのメニューからもう一度出せる。
 * 保存値の復元はマウント後なので、マウントするまで出さない（出すとSSRのHTMLに載り、閉じた人にも一瞬見える）。
 */
export default function FirstVisitIntro({ shown, onClose, originLocateFailed }: FirstVisitIntroProps) {
  const [mounted, setMounted] = useState(false);
  const titleId = useId();
  useIsomorphicLayoutEffect(() => setMounted(true), []);

  if (!mounted || !shown) return null;

  return (
    <section aria-labelledby={titleId} className={MAP_TOP_CARD_CLASS}>
      <div className="flex items-start justify-between gap-2">
        <h2 id={titleId} className={cn(textVariants({ variant: "heading" }), "m-0")}>
          {APP_NAME}
        </h2>
        <Button
          usage="案内を閉じます。"
          variant="ghost"
          size="close"
          className="flex-none"
          aria-label="案内を閉じる"
          onClick={onClose}
        >
          ✕
        </Button>
      </div>
      <p className={cn(textVariants({ variant: "body" }), "m-0")}>ロードバイクで走りやすいルートを作ります。</p>
      <ol className={cn(textVariants({ variant: "body" }), "m-0 flex list-decimal flex-col gap-1.5 pl-5")}>
        <li>
          <PointMark role="origin" originLocated={!originLocateFailed} className="mr-1 align-[-4px]" />
          {originLocateFailed ? HOW_TO_PLACE_ORIGIN : "出発地を決める[はじめは現在地。つかんで動かせます]"}
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
        onClick={onClose}
      >
        はじめる
      </Button>
    </section>
  );
}
