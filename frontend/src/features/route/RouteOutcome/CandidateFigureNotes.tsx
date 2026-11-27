"use client";

import { GuideText } from "@/components/ui/GuideText/GuideText";
import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";
import WarningText from "@/features/route/WarningText/WarningText";
import { costAxisNamesNote, useCostAxisCatalog } from "@/hooks/useCostAxisCatalog";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

/** 候補のカードの名前の列の印の意味（`GuideText`の箇条書きの行）。 */
export const CANDIDATE_MARKS_WORDING =
  "・稲妻の印: 最速ルート\n・合成の印: 区間を乗り換えた合成ルート\n・番号だけ: 生成した候補";

/** カードの数字と印の説明（カードの並びの先頭の見本の(i)）。読み方だけを、項目ごとに箇条書きの1行か1文で言う。 */
export function CandidateFiguresInfo() {
  const costAxes = useCostAxisCatalog();
  return (
    <InfoPopover triggerAriaLabel="所要時間と負担の説明">
      <p>
        <GuideText text={`・上の段: 距離\n・下の段: 所要時間と負担\n${CANDIDATE_MARKS_WORDING}`} />
      </p>
      <p>{`所要時間: ${routeGenerateConfig.duration_estimate_wording}`}</p>
      <p>{`負担: 避けたいもの${costAxisNamesNote(costAxes)}を通る分を時間に直したものです。`}</p>
      <p>{`並び: 先頭は最速、残りは${routeGenerateConfig.candidate_order_wording}です。`}</p>
    </InfoPopover>
  );
}

/** 選んだ候補の所要時間の前提が崩れていることの注意（黙って短い所要時間を見せない）。`share`は、値が欠けて代わりの値で
 * 出した道のりの割合（0〜1、RouteCandidate.missing_travel_data_share）。丸めて1%以上のときだけ出す——0%を並べても判断の材料にならない。 */
export function MissingTravelDataNotice({ share }: { share: number | null }) {
  const missingPct = share == null ? 0 : Math.round(share * 100);
  if (missingPct < 1) return null;
  return (
    <WarningText>
      {`${missingPct}%の${routeGenerateConfig.missing_travel_data_heading}`}
      <InfoPopover triggerAriaLabel="データが欠けた道のりの説明">
        <p>
          <GuideText text={routeGenerateConfig.missing_travel_data_wording} />
        </p>
      </InfoPopover>
    </WarningText>
  );
}
