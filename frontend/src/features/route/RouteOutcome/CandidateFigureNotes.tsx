"use client";

import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";
import WarningText from "@/features/route/WarningText/WarningText";
import { costAxisNamesNote, useCostAxisCatalog } from "@/hooks/useCostAxisCatalog";
import { ROAD_SETTINGS_TAB_NAME } from "@/lib/screenNames";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

/** 候補のカードの名前の列の印の意味。 */
export const CANDIDATE_MARKS_WORDING =
  "稲妻の印は最速ルート、合成の印は区間を乗り換えた合成ルート、番号だけは生成した候補です。";

/** カードの数字と印の説明（カードの並びの先頭の見本の(i)）。負担は、避けたいもの（費用の軸）を通る代償を秒にしたもので、
 * 種類ごとの内訳と事実は道のりのグラフの右上の一覧が出す。 */
export function CandidateFiguresInfo() {
  const costAxes = useCostAxisCatalog();
  const turnKickoffNote = costAxes.turnKickoffWording ? `[${costAxes.turnKickoffWording}]` : "";
  return (
    <InfoPopover triggerAriaLabel="所要時間と負担の説明">
      <p>{`上の段は距離、下の段は所要時間と負担です。${CANDIDATE_MARKS_WORDING}`}</p>
      <p>{`所要時間: ${routeGenerateConfig.duration_estimate_wording}実際の信号のタイミングや走り方で変わります。`}</p>
      <p>
        {`負担: 避けたいもの${costAxisNamesNote(costAxes)}を通る分を時間に直し、所要時間に上乗せしたものです。` +
          `候補は、最速の候補を比べる基準として先頭に置き、残りを${routeGenerateConfig.candidate_order_wording}に並べます。` +
          `グラフの右上の一覧は、負担を種類ごとに分けたものです${turnKickoffNote}。` +
          `${ROAD_SETTINGS_TAB_NAME}のタブで好むとした道を通って減った分[−]と、避けるとした道を通って増えた分も、` +
          "この負担に入ります。その区間は、地図のルートの線の両脇の線で示します。" +
          `${routeGenerateConfig.turn_penalty_wording}。`}
      </p>
    </InfoPopover>
  );
}

/** 選んだ候補の所要時間の前提が崩れていることの注意（黙って短い所要時間を見せない）。`share`は、勾配か停止要因の値が無く全体の平均で
 * 出した区間の距離の割合（0〜1、RouteCandidate.missing_travel_data_share）。丸めて1%以上のときだけ出す——0%を並べても判断の材料にならない。 */
export function MissingTravelDataNotice({ share }: { share: number | null }) {
  const missingPct = share == null ? 0 : Math.round(share * 100);
  if (missingPct < 1) return null;
  return (
    <WarningText>
      {`${missingPct}%の道のりはデータが欠けていて、平均の値で計算しています`}
      <InfoPopover triggerAriaLabel="平均で計算した道のりの説明">
        <p>{routeGenerateConfig.missing_travel_data_wording}</p>
      </InfoPopover>
    </WarningText>
  );
}
