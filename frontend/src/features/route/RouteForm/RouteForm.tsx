"use client";

import type { ComponentProps } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs/Tabs";
import type { PinRole, PlaceCandidate } from "@/types/route";
import { waypointsFull, type GenerationConditionsState } from "@/features/route/useGenerationConditions";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";
import { DISTANCE_STEP_KM } from "@/features/route/savedConditions";
import SavedPlacesPanel from "@/features/route/SavedPlacesPanel/SavedPlacesPanel";
import PointList from "./PointList";
import { Button } from "@/components/ui/Button/Button";
import { GoalFlagIcon, LoopRouteIcon } from "@/components/ui/icons/icons";
import { RulerIcon } from "@/components/ui/icons/lucideIcons";
import { Toggle } from "@/components/ui/Toggle/Toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/ToggleGroup/ToggleGroup";
import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";
import Ruler, { type RulerFrame } from "@/components/ui/Ruler/Ruler";
import { textVariants } from "@/components/ui/Text/Text";
import { useClientConfig } from "@/hooks/useClientConfig";
import { CLIENT_TUNING_IDS, clientTuningValue } from "@/lib/clientConfig";
import { cn } from "@/lib/cn";

/** 「ルート設定」区分のタブ。タブ列（`SettingsTabsList.tsx`）と選択状態は外が持ち（見出し行に置くため）、
 * ここは各タブの中身だけを描く。 */
export type SettingsTab = "generate" | "weights" | "exclusions" | "saved";

type PointListProps = ComponentProps<typeof PointList>;

interface RouteFormProps extends Omit<PointListProps, "conditions"> {
  /** 生成の条件と、それを変える操作。距離・候補数は入力のままの文字列で受け取り、文字列で上げる。 */
  conditions: PointListProps["conditions"] &
    Pick<
      GenerationConditionsState,
      | "distanceInput"
      | "setDistanceInput"
      | "maxRoutesInput"
      | "setMaxRoutesInput"
      | "distanceTargeted"
      | "setDistanceTargeted"
      | "setLoop"
    >;
  /** 保存した候補を、その役割の地点として置き、置いた地点の詳しくを見せる（経由地は足す）。 */
  onPlaceFound: (role: PinRole, candidate: PlaceCandidate, waypointIndex: number | null) => void;
  /** 「負担」タブの中身。 */
  weightsPanel: React.ReactNode;
  /** 「道路」タブの中身。 */
  exclusionsPanel: React.ReactNode;
  /** 「保存済み」タブの「設定」の頭に置く、いまの設定を保存するボタン。 */
  saveConditionsButton: React.ReactNode;
  /** 「保存済み」タブの「設定」の中身（保存した設定の一覧）。 */
  savedConditionsPanel: React.ReactNode;
}

const MAX_DISTANCE_KM = routeGenerateConfig.max_distance_km;
/** 距離の目標のルーラーのコマ。止まる刻みごとに1コマで（下限は1刻み分）、10kmごとに太い目盛りと数を付ける。 */
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
  return `候補は、この長さの±${percent}%[${distanceInput}kmなら±${km}km]に収まるものだけを作ります。`;
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
  const { distanceTargeted, setDistanceTargeted, distanceInput, setDistanceInput, maxRoutesInput, setMaxRoutesInput } =
    conditions;
  // 許容差は管理画面の較正値（目標の距離に対する割合）。引けない間は幅の文を出さない（較正したのとは別の数を出さない）。
  const distanceToleranceRatio = clientTuningValue(useClientConfig(), CLIENT_TUNING_IDS.distanceToleranceRatio);

  // 範囲の端ではボタンを押せなくするので、足した値は範囲を出ない。
  function stepMaxRoutes(delta: number) {
    setMaxRoutesInput(String(Number(maxRoutesInput) + delta));
  }

  return (
    <div>
      <KeptTabContent value="generate">
        {/* 上から「何を作るか（形と候補の数）」→「距離の縛り」→「地点」の順に並べる。 */}
        <div className="mb-2 flex items-center justify-between gap-1.5">
          <ToggleGroup
            value={conditions.loop ? "loop" : "destination"}
            onValueChange={(value) => value !== "" && conditions.setLoop(value === "loop")}
            aria-label="作るルートの形"
            usage="周回は出発地へ戻るルートを、目的地へは目的地へ向かうルートを作ります。"
          >
            <ToggleGroupItem value="loop">
              <span className="inline-flex items-center gap-1 text-[length:var(--font-size-sm)]">
                <LoopRouteIcon size={14} />
                周回
              </span>
            </ToggleGroupItem>
            <ToggleGroupItem value="destination">
              <span className="inline-flex items-center gap-1 text-[length:var(--font-size-sm)]">
                <GoalFlagIcon size={14} />
                目的地へ
              </span>
            </ToggleGroupItem>
          </ToggleGroup>
          <div className="flex flex-none items-center gap-1">
            <span className={cn(textVariants({ variant: "hint" }), "flex-shrink-0")}>候補</span>
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
        </div>
        {/* 距離の縛りは、押して切り替えるボタン・ルーラー・値を1行に置く。外している間もルーラーは出したまま薄くする（入れ直すと
            前の値に戻ることが見える）。 */}
        <div className="mb-2 flex items-center gap-1.5">
          <Toggle
            variant="plain"
            className="min-h-8 flex-none gap-1 rounded-full border border-[var(--color-accent)] px-2.5 text-[length:var(--font-size-sm)] text-[var(--color-accent-strong)] data-[state=on]:bg-[var(--color-accent-bg)]"
            pressed={distanceTargeted}
            onClick={() => setDistanceTargeted(!distanceTargeted)}
            aria-label="距離を決める"
            title="距離を決める"
            usage="オンにすると、ルート全体の距離を目標に合わせます。オフにすると距離を決めません。"
          >
            <RulerIcon size={14} />
            距離
          </Toggle>
          <Ruler
            frames={DISTANCE_FRAMES}
            index={Number(distanceInput) / DISTANCE_STEP_KM - 1}
            onIndexChange={(i) => setDistanceInput(String((i + 1) * DISTANCE_STEP_KM))}
            ariaLabel="距離の目標"
            disabled={!distanceTargeted}
            className="min-w-0 flex-1 touch-pan-y"
            usage="ルート全体の距離の目標を、目盛りを横に滑らせて決めます。"
          />
          <span
            className={cn(
              "min-w-[3.5em] flex-shrink-0 text-right text-[length:var(--font-size-md)] tabular-nums",
              !distanceTargeted && "text-[length:var(--font-size-sm)] text-[var(--color-muted)]",
            )}
          >
            {distanceTargeted ? `${distanceInput}km` : "指定なし"}
          </span>
          <InfoPopover triggerAriaLabel="距離の目標の説明" triggerClassName="flex-none">
            {[
              "ルート全体の距離の目標です。",
              distanceToleranceRatio === undefined ? "" : toleranceSentence(distanceToleranceRatio, distanceInput),
              "「距離」を外すと距離を決めず、所要時間と負担の和が小さい道で目的地へ向かいます[周回なら、経由地を回って出発地へ]。",
              `${routeGenerateConfig.busy_safe_distance_km}kmより長い目標は、混み合っているときに作れないことがあります。`,
            ].join("")}
          </InfoPopover>
        </div>

        <PointList conditions={conditions} {...points} />
      </KeptTabContent>

      <KeptTabContent value="weights">{weightsPanel}</KeptTabContent>

      <KeptTabContent value="exclusions">{exclusionsPanel}</KeptTabContent>

      <KeptTabContent value="saved">
        {/* 保存したものは地点と設定の2つで、呼び出すと変わるものが違う（地点は選んだ1地点を置き、設定は各タブの値を入れ替える）。 */}
        <Tabs defaultValue="places">
          <div className="mb-2 flex items-center justify-between gap-2">
          <TabsList aria-label="保存したもの">
            <TabsTrigger
              value="places"
              usage="条件タブで名前を付けて保存した地点の一覧です。呼び出すと、出発地・経由地・目的地に置きます。"
            >
              地点
            </TabsTrigger>
            <TabsTrigger
              value="conditions"
              usage="条件タブで名前を付けて保存した設定の一覧です。呼び出すと、各タブの値を入れ替えます。"
            >
              設定
            </TabsTrigger>
          </TabsList>
          {saveConditionsButton}
          </div>
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
