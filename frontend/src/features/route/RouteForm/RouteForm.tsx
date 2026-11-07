"use client";

import type { ComponentProps } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs/Tabs";
import type { PinRole, PlaceCandidate } from "@/types/route";
import { waypointsFull, type GenerationConditionsState } from "@/features/route/useGenerationConditions";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";
import { DISTANCE_STEP_KM } from "@/features/route/savedConditions";
import SavedPlacesPanel from "@/features/route/SavedPlacesPanel/SavedPlacesPanel";
import RoutePoints from "./RoutePoints";
import { Button } from "@/components/ui/Button/Button";
import { DistanceTargetIcon } from "@/components/ui/icons/lucideIcons";
import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";
import Ruler, { type RulerFrame } from "@/components/ui/Ruler/Ruler";
import { textVariants } from "@/components/ui/Text/Text";
import { panelIconToggleClass, Toggle } from "@/components/ui/Toggle/Toggle";
import { useClientConfig } from "@/hooks/useClientConfig";
import { costAxisNamesNote, useCostAxisCatalog } from "@/hooks/useCostAxisCatalog";
import { CLIENT_TUNING_IDS, clientTuningValue } from "@/lib/clientConfig";
import { cn } from "@/lib/cn";
import CostLevelPicker from "@/features/route/RouteSettingsPanel/CostLevelPicker";
import { COST_STRENGTH_LEVELS } from "@/features/route/costPreference";

/** 「ルート設定」区分のタブ。タブ列（`SettingsTabsList.tsx`）と選択状態は外が持ち（見出し行に置くため）、
 * ここは各タブの中身だけを描く。 */
export type SettingsTab = "generate" | "weights" | "exclusions" | "saved";

type RoutePointsProps = ComponentProps<typeof RoutePoints>;

interface RouteFormProps extends Omit<RoutePointsProps, "conditions"> {
  /** 生成の条件と、それを変える操作。距離・候補数は入力のままの文字列で受け取り、文字列で上げる。 */
  conditions: RoutePointsProps["conditions"] &
    Pick<
      GenerationConditionsState,
      | "distanceInput"
      | "setDistanceInput"
      | "maxRoutesInput"
      | "setMaxRoutesInput"
      | "distanceTargeted"
      | "setDistanceTargeted"
      | "costPreference"
      | "setCostPreference"
    >;
  /** 保存した候補を、その役割の地点として置き、置いた地点の詳しくを見せる（経由地は足す）。 */
  onPlaceFound: (role: PinRole, candidate: PlaceCandidate, waypointIndex: number | null) => void;
  /** 「負担」タブの中身。 */
  weightsPanel: React.ReactNode;
  /** 「回避」タブの中身。 */
  exclusionsPanel: React.ReactNode;
  /** 「条件」タブの、いまの設定を保存するアイコン（保存するものは各タブに及ぶが、条件を詰める所で保存する）。 */
  saveConditionsButton: React.ReactNode;
  /** 「保存済み」タブの「プリセット」の中身（保存した設定の一覧）。 */
  savedConditionsPanel: React.ReactNode;
}

const MAX_DISTANCE_KM = routeGenerateConfig.max_distance_km;
/** 全長の目標のルーラーのコマ。止まる刻みごとに1コマで（下限は1刻み分）、10kmごとに太い目盛りと数を付ける。 */
const DISTANCE_FRAMES: RulerFrame[] = Array.from({ length: Math.floor(MAX_DISTANCE_KM / DISTANCE_STEP_KM) }, (_, i) => {
  const km = (i + 1) * DISTANCE_STEP_KM;
  const major = km % 10 === 0;
  return { label: `${km}km`, major, tickLabel: major ? String(km) : undefined };
});
const MIN_ROUTES = routeGenerateConfig.min_routes;
const MAX_ROUTES = routeGenerateConfig.max_routes;

// forceMount+data-stateでの表示切替。
// 候補数等は`features/route/useGenerationConditions.ts`の制御stateのため非表示中も値は失われないが、
// 「条件」タブの地点の編集・場所の検索と、「保存済み」タブの名前の下書きはローカルstateで持つため、
// タブ切替のたびにアンマウントすると失われる。
function KeptTabContent({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <TabsContent value={value} forceMount className="data-[state=inactive]:hidden">
      {children}
    </TabsContent>
  );
}

// 割合も長さも小数1桁へ丸める（0.15×100は15.000000000000002になる）。
function toleranceSentence(ratio: number, distanceInput: string): string {
  const percent = Math.round(ratio * 1000) / 10;
  const km = Math.round(Number(distanceInput) * ratio * 10) / 10;
  return `作る候補は、この長さの±${percent}%（${distanceInput}kmなら±${km}km）に入るものだけです。`;
}

export default function RouteForm({
  conditions,
  onPlaceFound,
  weightsPanel,
  exclusionsPanel,
  saveConditionsButton,
  savedConditionsPanel,
  ...points
}: RouteFormProps) {
  const {
    distanceTargeted,
    setDistanceTargeted,
    distanceInput,
    setDistanceInput,
    maxRoutesInput,
    setMaxRoutesInput,
    costPreference,
    setCostPreference,
  } = conditions;
  const distanceToggleName = distanceTargeted ? "全長の目標をやめる" : "全長の目標を決める";
  // 許容差は管理画面の較正値（目標の距離に対する割合）。引けない間は幅の文を出さない（較正したのとは別の数を出さない）。
  const distanceToleranceRatio = clientTuningValue(useClientConfig(), CLIENT_TUNING_IDS.distanceToleranceRatio);
  const costCatalog = useCostAxisCatalog();

  // 範囲の端ではボタンを押せなくするので、足した値は範囲を出ない。
  function stepMaxRoutes(delta: number) {
    setMaxRoutesInput(String(Number(maxRoutesInput) + delta));
  }

  return (
    <div>
      <KeptTabContent value="generate">
        {/* 全長の目標と候補数といまの設定の保存を1行に並べ、パネルの縦幅を詰める。ルーラーは残りの幅を取り、狭い幅では長い距離の側を
            見えない所へ置く（滑らせると出る）。全長の目標を外している間もルーラーと値は出したまま薄くする（入れ直すと
            前の値に戻ることが見える）。部品の間は詰めて、いちばん狭い幅でもルーラーに押せる幅（24px四方）を残す。 */}
        <div className="mb-2 flex items-center gap-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <Toggle
              variant="plain"
              className={panelIconToggleClass}
              pressed={distanceTargeted}
              aria-label={distanceToggleName}
              onClick={() => setDistanceTargeted(!distanceTargeted)}
              usage="オンにすると、ルート全体の長さを目標に合わせます。"
            >
              <DistanceTargetIcon />
            </Toggle>
            <Ruler
              frames={DISTANCE_FRAMES}
              index={Number(distanceInput) / DISTANCE_STEP_KM - 1}
              onIndexChange={(i) => setDistanceInput(String((i + 1) * DISTANCE_STEP_KM))}
              ariaLabel="全長の目標"
              disabled={!distanceTargeted}
              className="min-w-0 flex-1 touch-pan-y"
              usage="ルート全体の長さの目標を、目盛りを横に滑らせて決めます。"
            />
            <span
              className={cn(
                // 文字の大きさは地点の並びの札の名前とそろえる（`PointStrip.tsx: chipName`）。
                "min-w-[3.25em] flex-shrink-0 text-right text-[length:var(--font-size-md)] tabular-nums",
                !distanceTargeted && "opacity-40",
              )}
            >
              {distanceInput}km
            </span>
            <InfoPopover triggerAriaLabel="全長の目標の説明" triggerClassName="flex-none">
              {[
                "ルート全体の長さの目標です。",
                distanceToleranceRatio === undefined ? "" : toleranceSentence(distanceToleranceRatio, distanceInput),
                "外すと長さを決めず、目的地（周回なら経由地を回って出発地）へ、所要時間と負担の和が小さい道で向かいます。",
                `${routeGenerateConfig.busy_safe_distance_km}kmより長い目標は、混み合っているときに作れないことがあります。`,
              ].join("")}
            </InfoPopover>
          </div>
          <div className="flex flex-none items-center gap-1">
            <span className={cn(textVariants({ variant: "hint" }), "flex-shrink-0")}>候補数</span>
            <div className="inline-flex items-center">
              <Button
                variant="stepper"
                size="sm"
                onClick={() => stepMaxRoutes(-1)}
                disabled={Number(maxRoutesInput) <= MIN_ROUTES}
                aria-label="候補数を減らす"
                usage="一度に作る候補の数を減らします。"
              >
                ‹
              </Button>
              <span className="min-w-[2.25em] text-center text-[length:var(--font-size-md)] tabular-nums">{`${maxRoutesInput}件`}</span>
              <Button
                variant="stepper"
                size="sm"
                onClick={() => stepMaxRoutes(1)}
                disabled={Number(maxRoutesInput) >= MAX_ROUTES}
                aria-label="候補数を増やす"
                usage="一度に作る候補の数を増やします。"
              >
                ›
              </Button>
            </div>
          </div>
          <div className="flex-none">{saveConditionsButton}</div>
        </div>

        {/* 全体のつまみ。軸ごとの倍率は「負担」タブが持つ。 */}
        <div className="mb-2 flex items-center gap-1.5">
          <span className={cn(textVariants({ variant: "hint" }), "flex-shrink-0")}>負担の強さ</span>
          <CostLevelPicker
            aria-label="負担の強さ"
            usage="所要時間に足す負担に掛ける倍率を選びます。"
            levels={COST_STRENGTH_LEVELS}
            value={costPreference.strength}
            onChange={(strength) => setCostPreference((prev) => ({ ...prev, strength }))}
          />
          <InfoPopover triggerAriaLabel="負担の強さの説明" triggerClassName="flex-none">
            {/* JSXの改行は半角スペースになるので、文字列として繋ぐ。 */}
            {"所要時間に足す負担に掛ける倍率です。" +
              `負担は、平地を走るより余分にかかるもの${costAxisNamesNote(costCatalog)}を、時間に換算したものです。` +
              "道は、所要時間とこの倍率を掛けた負担の和が小さくなるように選びます。×1 が標準です。" +
              "×2 は負担を2倍にして足すので、所要時間が延びても負担の小さい道を選びやすくなります。" +
              "×0 は負担を足さず、所要時間だけで選びます。負担の種類ごとの倍率は「負担」タブで選べます。"}
          </InfoPopover>
        </div>

        <RoutePoints conditions={conditions} {...points} />
      </KeptTabContent>

      <KeptTabContent value="weights">{weightsPanel}</KeptTabContent>

      <KeptTabContent value="exclusions">{exclusionsPanel}</KeptTabContent>

      <KeptTabContent value="saved">
        {/* 保存したものは地点とプリセットの2つで、呼び出すと変わるものが違う（地点は選んだ1地点を置き、プリセットは各タブの値を入れ替える）。 */}
        <Tabs defaultValue="places">
          <TabsList className="mb-2" aria-label="保存したもの">
            <TabsTrigger
              value="places"
              usage="条件タブで名前を付けて保存した地点の一覧です。呼び出すと、出発地・経由地・目的地に置きます。"
            >
              地点
            </TabsTrigger>
            <TabsTrigger
              value="conditions"
              usage="条件タブで名前を付けて保存した設定（プリセット）の一覧です。呼び出すと、各タブの値を入れ替えます。"
            >
              プリセット
            </TabsTrigger>
          </TabsList>
          <KeptTabContent value="places">
            <SavedPlacesPanel
              places={points.savedPlaces.places}
              waypointsFull={waypointsFull(conditions.waypoints)}
              loop={conditions.loop}
              onRecall={(role, place) => onPlaceFound(role, place, null)}
              onRemove={points.savedPlaces.remove}
            />
          </KeptTabContent>
          <KeptTabContent value="conditions">{savedConditionsPanel}</KeptTabContent>
        </Tabs>
      </KeptTabContent>
    </div>
  );
}
