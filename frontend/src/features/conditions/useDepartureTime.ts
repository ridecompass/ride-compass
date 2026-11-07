"use client";

import { useCallback, useEffect, useState } from "react";

import { floorToDepartureStep } from "@/features/conditions/rideConditions";
import { SECOND_MS } from "@/lib/duration";

// 「今」は出発時刻として選べる値の刻みで進め、刻みの中では同じ値を保つ（時刻を鍵に持つ読み手を無駄に取り直させない）。
// 刻みの境界を跨いだかを見に行く間隔。刻みそのものより短くないと境界を跨ぎ越す。
const NOW_POLL_INTERVAL_MS = 30 * SECOND_MS;

function steppedNow(): Date {
  return new Date(floorToDepartureStep(Date.now()));
}

interface DepartureTime {
  /** 出発時刻。 */
  at: Date;
  /** 刻みへ丸めた現在時刻。 */
  now: Date;
  /** 利用者が選んだ時刻か。falseの間の`at`は「今」に張り付いて進み、利用者が決めた条件ではない。 */
  pinned: boolean;
  setAt: (time: Date) => void;
  /** 「今」への追従へ戻す。 */
  followNow: () => void;
}

/** 出発時刻（走行条件の1つ）。選ぶまでは「今」へ追従する——止まったままだと、実況由来の
 * 気象フレーム列は先頭が前進するのに時刻だけが取り残され、降水・雷等が範囲外で黙って消える。
 * 選んだ時刻は勝手に動かさない（利用者が意図して決めた値）。 */
export function useDepartureTime(): DepartureTime {
  const [now, setNow] = useState(steppedNow);
  const [pinnedAt, setPinnedAt] = useState<Date | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow((previous) => {
        const next = steppedNow();
        return next.getTime() === previous.getTime() ? previous : next;
      });
    }, NOW_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  const followNow = useCallback(() => {
    setNow(steppedNow());
    setPinnedAt(null);
  }, []);

  return { at: pinnedAt ?? now, now, pinned: pinnedAt !== null, setAt: setPinnedAt, followNow };
}
