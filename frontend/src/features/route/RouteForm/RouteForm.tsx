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
import { Checkbox } from "@/components/ui/Checkbox/Checkbox";
import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";
import Ruler, { type RulerFrame } from "@/components/ui/Ruler/Ruler";
import { textVariants } from "@/components/ui/Text/Text";
import { useClientConfig } from "@/hooks/useClientConfig";
import { CLIENT_TUNING_IDS, clientTuningValue } from "@/lib/clientConfig";
import { cn } from "@/lib/cn";

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
    >;
  /** 保存した候補を、その役割の地点として置き、置いた地点の詳しくを見せる（経由地は足す）。 */
  onPlaceFound: (role: PinRole, candidate: PlaceCandidate, waypointIndex: number | null) => void;
  /** 「負担」タブの中身。 */
  weightsPanel: React.ReactNode;
  /** 「道路」タブの中身。 */
  exclusionsPanel: React.ReactNode;
  /** 「条件」タブの、いまの設定を保存するアイコン（保存するものは各タブに及ぶが、条件を詰める所で保存する）。 */
  saveConditionsButton: React.ReactNode;
  /** 「保存済み」タブの「設定」の中身（保存した設定の一覧）。 */
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
        {/* 全長の目標は、決めるかを文字で示し、ルーラーに数の付いた目盛りが並ぶ幅を取るため、1行を占める。外している間も
            ルーラーと値は出したまま薄くする（入れ直すと前の値に戻ることが見える）。 */}
        <div className="mb-1 flex items-center gap-1.5">
          <label
            className="flex flex-none cursor-pointer items-center gap-1 text-[length:var(--font-size-sm)]"
            data-usage="印を付けると、ルート全体の長さを目標に合わせます。外すと長さを決めません。"
          >
            <Checkbox checked={distanceTargeted} onCheckedChange={setDistanceTargeted} />
            全長を決める
          </label>
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
              "印を外すと長さを決めず、所要時間と負担の和が小さい道で目的地へ向かいます[周回なら、経由地を回って出発地へ]。",
              `${routeGenerateConfig.busy_safe_distance_km}kmより長い目標は、混み合っているときに作れないことがあります。`,
            ].join("")}
          </InfoPopover>
        </div>
        <div className="mb-2 flex items-center justify-end gap-1.5">
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

        <RoutePoints conditions={conditions} {...points} />
      </KeptTabContent>

      <KeptTabContent value="weights">{weightsPanel}</KeptTabContent>

      <KeptTabContent value="exclusions">{exclusionsPanel}</KeptTabContent>

      <KeptTabContent value="saved">
        {/* 保存したものは地点と設定の2つで、呼び出すと変わるものが違う（地点は選んだ1地点を置き、設定は各タブの値を入れ替える）。 */}
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
              usage="条件タブで名前を付けて保存した設定の一覧です。呼び出すと、各タブの値を入れ替えます。"
            >
              設定
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
