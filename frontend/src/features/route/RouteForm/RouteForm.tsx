"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs/Tabs";
import type { Coordinates, PinRole, PlaceCandidate } from "@/types/route";
import { waypointsFull, type GenerationConditionsState } from "@/features/route/useGenerationConditions";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";
import { DISTANCE_STEP_KM } from "@/features/route/savedConditions";
import SavedPlacesPanel from "@/features/route/SavedPlacesPanel/SavedPlacesPanel";
import type { SavedPlacesState } from "@/features/route/useSavedPlaces";
import RoutePoints from "./RoutePoints";
import { Button } from "@/components/ui/Button/Button";
import { DistanceTargetIcon } from "@/components/ui/icons/lucideIcons";
import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";
import Ruler, { type RulerFrame } from "@/components/ui/Ruler/Ruler";
import { textVariants } from "@/components/ui/Text/Text";
import { panelIconToggleClass, Toggle } from "@/components/ui/Toggle/Toggle";
import { useAxisCatalog } from "@/hooks/useAxisCatalog";
import { CLIENT_TUNING_IDS, clientTuningValue } from "@/lib/axisCatalog";
import { cn } from "@/lib/cn";

/** 「ルート設定」区分のタブ。タブ列（`SettingsTabsList.tsx`）と選択状態は外が持ち（見出し行に置くため）、
 * ここは各タブの中身だけを描く。 */
export type SettingsTab = "generate" | "weights" | "exclusions" | "saved";

/** 「条件」タブが読む生成の条件（`features/route/useGenerationConditions.ts`の返り値をそのまま渡す）。距離・候補数は
 * 文字列のまま持つ——生成条件のdirty判定（`features/route/useRouteGeneration.ts`）に使うため。 */
type RouteFormConditions = Pick<
  GenerationConditionsState,
  | "distanceInput"
  | "setDistanceInput"
  | "maxRoutesInput"
  | "setMaxRoutesInput"
  | "loop"
  | "setLoop"
  | "distanceTargeted"
  | "setDistanceTargeted"
  | "waypoints"
  | "removeWaypoint"
  | "destination"
  | "clearDestination"
  | "clearPoints"
  | "selectedPoint"
  | "selectPoint"
  | "foundAt"
>;

interface RouteFormProps {
  /** 生成の条件と、それを変える操作。 */
  conditions: RouteFormConditions;
  /** 出発地の位置（現在地か、地図で置いた地点）。 */
  origin: Coordinates;
  /** 出発地を地図で置き直してあるか（falseなら現在地のまま）。 */
  originManual: boolean;
  /** 出発地が実際の位置か（現在地を取れたか、地図で置いたか）。falseの間は地図のピンと同じく印を灰色にし、
   * 名前も「現在地」と出さない（位置が仮の地点のままであることを、パネルと地図で示す）。 */
  originLocated: boolean;
  /** 出発地が、最後に取れた現在地にあるか（真なら「出発地を現在地に戻す」を押せなくする）。 */
  originAtHere: boolean;
  /** 出発地を現在地へ戻す（現在地の取得もこの操作が兼ねる）。 */
  onOriginReset: () => void;
  /** 出発地が、探して置いたときの位置のままなら、その候補（名前を出す）。 */
  originFound: PlaceCandidate | null;
  /** 地図でいま見ている所の真ん中。探す施設の候補は、ここから近い順に並ぶ。 */
  mapCenter: Coordinates;
  /** 探して選んだ候補を、その役割の地点として置く（経由地は`waypointIndex`番目を置き直し、無ければ足す）。 */
  onPlaceFound: (role: PinRole, candidate: PlaceCandidate, waypointIndex: number | null) => void;
  /** 保存した地点（地点の詳しくで保存して打つ欄の候補に出し、「保存済み」タブの「地点」に並べて呼び出す）。 */
  savedPlaces: SavedPlacesState;
  /** 「条件」タブへ移る（「保存済み」タブの「地点」から呼び出した地点を見せる）。 */
  onPointsShow: () => void;
  /** 地図をタップすると選んでいる地点を置くか（ルート設定が地図で効いている間）。 */
  placing: boolean;
  /** 「重み」タブの中身。タブの列と「ルート生成」ボタンは見出しの行、検証は`useRouteFormSubmit`が持つ。 */
  weightsPanel: React.ReactNode;
  /** 「除外」タブの中身。 */
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

// forceMount+data-stateでの表示切替（ルート結果のタブと同じ方式）。
// 候補数等は`features/route/useGenerationConditions.ts`の制御stateのため非表示中も値は失われないが、
// 重みタブ（RouteSettingsPanel）はドラッグ中の帯グラフ・チェックOFF前の
// 重み記憶をローカルstateで持つため、タブ切替のたびにアンマウントすると失われる。
function KeptTabContent({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <TabsContent value={value} forceMount className="data-[state=inactive]:hidden">
      {children}
    </TabsContent>
  );
}

export default function RouteForm({
  conditions,
  origin,
  originManual,
  originLocated,
  originAtHere,
  onOriginReset,
  originFound,
  mapCenter,
  onPlaceFound,
  savedPlaces,
  onPointsShow,
  placing,
  weightsPanel,
  exclusionsPanel,
  saveConditionsButton,
  savedConditionsPanel,
}: RouteFormProps) {
  const { distanceTargeted, setDistanceTargeted, distanceInput, setDistanceInput, maxRoutesInput, setMaxRoutesInput } =
    conditions;
  const distanceToggleName = distanceTargeted ? "全長の目標をやめる" : "全長の目標を決める";
  // 許容差は管理画面の較正値。引けない間は幅の文を出さない（較正したのとは別の数を出さない）。
  const distanceToleranceKm = clientTuningValue(useAxisCatalog(), CLIENT_TUNING_IDS.distanceToleranceKm);

  // 保存した地点を呼び出したら「条件」タブへ移り、置いた地点を選んで詳しくを出す（足した経由地は`onPlaceFound`が選ぶ）。
  function recallSavedPlace(role: PinRole, place: PlaceCandidate) {
    onPlaceFound(role, place, null);
    if (role !== "waypoint") conditions.selectPoint({ role });
    onPointsShow();
  }

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
              className={cn(panelIconToggleClass, "flex-none")}
              pressed={distanceTargeted}
              aria-label={distanceToggleName}
              onClick={() => setDistanceTargeted(!distanceTargeted)}
              usage="押している間は、ルート全体の長さを目標に合わせます。"
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
                // 文字の大きさは地点の並びの札の名前とそろえる（`RoutePoints.tsx: chipName`）。
                "min-w-[3.25em] flex-shrink-0 text-right text-[length:var(--font-size-md)] tabular-nums",
                !distanceTargeted && "opacity-40",
              )}
            >
              {distanceInput}km
            </span>
            <InfoPopover triggerAriaLabel="全長の目標の説明" triggerClassName="flex-none">
              {[
                "ルート全体の長さの目標です。",
                distanceToleranceKm === undefined
                  ? ""
                  : `作る候補は、この長さの±${distanceToleranceKm}kmに入るものだけです。`,
                "外すと長さを決めず、目的地（周回なら経由地を回って出発地）へ良い道で向かいます。",
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

        <RoutePoints
          conditions={conditions}
          origin={origin}
          originManual={originManual}
          originLocated={originLocated}
          originAtHere={originAtHere}
          onOriginReset={onOriginReset}
          originFound={originFound}
          mapCenter={mapCenter}
          onPlaceFound={onPlaceFound}
          savedPlaces={savedPlaces}
          placing={placing}
        />
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
              places={savedPlaces.places}
              waypointsFull={waypointsFull(conditions.waypoints)}
              loop={conditions.loop}
              onRecall={recallSavedPlace}
              onRemove={savedPlaces.remove}
            />
          </KeptTabContent>
          <KeptTabContent value="conditions">{savedConditionsPanel}</KeptTabContent>
        </Tabs>
      </KeptTabContent>
    </div>
  );
}
