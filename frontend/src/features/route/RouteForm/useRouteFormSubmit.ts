import { useCallback, useState } from "react";

interface UseRouteFormSubmitOptions {
  /** 周回か（終点を出発地にする）。 */
  loop: boolean;
  /** 全長の目標を決めているか。 */
  distanceTargeted: boolean;
  waypointCount: number;
  /** 目的地を置いてあるか（周回の間は数えない）。 */
  destinationSet: boolean;
  /** 出発地が実際の位置か（現在地を取れたか、地図で置いたか）。偽の間の出発地は決まった仮の地点で、そこから
   * 作ったルートは利用者のいる場所と関係が無い。 */
  originKnown: boolean;
}

interface UseRouteFormSubmitResult {
  /** 生成できない理由（出発地が分からない・周回で全長の目標も経由地も無く作るものが無い・周回を外して目的地が無い）。生成結果の
   * 失敗と同じ窓で出す——押した場所とは別のどこかに出ると見落とすため。 */
  error: string | null;
  /** 検証し、通ったかを返す。通らなければ理由を`error`に置く。 */
  check: () => boolean;
  clear: () => void;
}

/** 「ルート生成」ボタン（「ルート設定」見出し行の`GenerateRouteActions.tsx`）から呼ぶ検証。距離・候補数は確かめない——
 * 入力がスライダー・ステッパーで、保存値も読むときに範囲の外を捨てる（`features/route/useGenerationConditions.ts`）ので、
 * 範囲の外の値は作れない。 */
export function useRouteFormSubmit({
  loop,
  distanceTargeted,
  waypointCount,
  destinationSet,
  originKnown,
}: UseRouteFormSubmitOptions): UseRouteFormSubmitResult {
  const [error, setError] = useState<string | null>(null);

  function check() {
    if (!originKnown) {
      setError("現在地が分かりません。位置情報を許可するか、地図をタップして出発地を置いてください。");
      return false;
    }
    if (loop && !distanceTargeted && waypointCount === 0) {
      setError("「全長の目標を決める」を押すか、経由地を置いてください。");
      return false;
    }
    if (!loop && !destinationSet) {
      setError("目的地を置いてください（出発地へ戻るなら「周回」を押してください）。");
      return false;
    }
    setError(null);
    return true;
  }

  const clear = useCallback(() => setError(null), []);

  return { error, check, clear };
}
