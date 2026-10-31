"use client";

import { Fragment, useLayoutEffect, useRef, type CSSProperties } from "react";

import { SHEET_FIT_END_ATTRIBUTE } from "@/components/BottomSheet/BottomSheet";
import { GuideText } from "@/components/ui/GuideText/GuideText";
import { RouteSpliceIcon } from "@/components/ui/icons/icons";
import { FastestRouteIcon } from "@/components/ui/icons/lucideIcons";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs/Tabs";
import { textVariants } from "@/components/ui/Text/Text";
import { useAxisCatalog } from "@/hooks/useAxisCatalog";
import { cn } from "@/lib/cn";
import { NO_DATA_LEGEND_BAND } from "@/lib/mapDisplay/mapColorLegend";
import { bandAt, DIFFICULTY_PAINT, formatDifficulty, valueBands } from "@/lib/mapDisplay/valueScale";
import RouteProfile from "@/features/route/RouteProfile/RouteProfile";
import type { ProfileLayerSelection } from "@/features/route/RouteProfile/useProfileLayers";
import RouteAxisProfile from "@/features/route/RouteAxisProfile/RouteAxisProfile";
import RouteSplicePanel from "@/features/route/RouteSplicePanel/RouteSplicePanel";
import { formatDurationShort } from "@/lib/duration";
import EditDifference from "@/features/route/EditDifference/EditDifference";
import WarningText from "@/features/route/WarningText/WarningText";
import {
  durationBaseline,
  durationDifferenceLabel,
  routeListEntries,
  type RouteListGroup,
} from "@/features/route/routeTabLabel";
import type { useRouteGeneration } from "@/features/route/useRouteGeneration";
import type { RouteResults } from "@/features/route/useRouteResults";
import type { SpliceSessionView } from "@/features/route/useSpliceSession";
import type { RouteCandidate, RoutePreferenceWeights } from "@/types/route";

const CANDIDATE_TAB_USAGE =
  "この候補を地図と内訳に出し、地図をその候補の全体へ収めます。稲妻の印は最も早く着く最速ルート、合成の印は区間を乗り換えて作った合成ルートで、番号だけのものは生成した候補です。上の段は距離、下の段は時間（最速ルート［無ければ最も早い候補］は所要時間、ほかはそれとの差で、速ければ−）と総合難易度で、下の帯は総合難易度を地図と同じ色で塗ります。";

/** 名前の列で群を見分ける印と、その意味（指を置いたときの吹き出しと読み上げの名前）。生成した候補は印を持たない。 */
const GROUP_MARKS: Partial<Record<RouteListGroup, { Icon: typeof FastestRouteIcon; meaning: string }>> = {
  fastest: { Icon: FastestRouteIcon, meaning: "最速ルート" },
  spliced: { Icon: RouteSpliceIcon, meaning: "合成ルート" },
};

/** 地図が総合難易度を塗る段。カードの下の帯は、地図のルートの線と同じ段の色で総合難易度を示す。 */
const DIFFICULTY_BANDS = valueBands(DIFFICULTY_PAINT);

function difficultyColor(route: RouteCandidate): string {
  return route.overall_difficulty === null
    ? NO_DATA_LEGEND_BAND.color
    : bandAt(DIFFICULTY_BANDS, route.overall_difficulty.average).color;
}

type RouteGeneration = ReturnType<typeof useRouteGeneration>;

interface RouteOutcomeProps {
  results: RouteResults;
  /** 生成の進み方・条件のずれ。 */
  generation: Pick<
    RouteGeneration,
    "running" | "progressLabel" | "conditionsDirty" | "weightsNotApplied" | "destinationCorrected"
  >;
  splice: Pick<SpliceSessionView, "panel">;
  /** 軸を「未使用」と分ける重み（`useRoutePlanner.ts: routeWeights`）。 */
  routeWeights: RoutePreferenceWeights;
  /** 道のりのグラフに重ねるレイヤの選択（走行中の図と共有する）。 */
  profileLayers: ProfileLayerSelection;
}

/**
 * 「ルート結果」の中身（デスクトップの区分・モバイルのシートの両方）: 生成前・生成中の案内、候補の一覧（横に並ぶカード）と
 * 選んだ候補の中身・地図で押した区間の詳細、編集中は区間の乗り換えの編集面。候補1本への操作は見出しの行が持つ
 * （`features/route/RouteCandidateActions/RouteCandidateActions.tsx`）。
 */
export default function RouteOutcome({ results, generation, splice, routeWeights, profileLayers }: RouteOutcomeProps) {
  const axisCatalog = useAxisCatalog();
  const { routes, selectedRouteId, selectedRouteSegment, reusedRouteId } = results;
  // 選んだカードを一覧の見える範囲へ送る（地図や「元を見る」で選び直したとき・乗り換えで作った経路と同じ道だったので
  // 選んだとき）。送るのは一覧の横だけで、シートやパネルを縦に動かさない（下の中身を読んでいる最中に上へ飛ばない）。
  const listRef = useRef<HTMLDivElement>(null);
  const selectedCardRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    const card = selectedCardRef.current;
    if (!list || !card) return;
    const listBox = list.getBoundingClientRect();
    const cardBox = card.getBoundingClientRect();
    // 右端は薄めた幅（一覧の右の余白）を除いた所までを見える範囲にする。
    const visibleRight = listBox.right - parseFloat(getComputedStyle(list).paddingRight || "0");
    if (cardBox.left < listBox.left) list.scrollLeft -= listBox.left - cardBox.left;
    else if (cardBox.right > visibleRight) list.scrollLeft += cardBox.right - visibleRight;
  }, [selectedRouteId, reusedRouteId]);

  // 候補が無い間（生成前・生成中）の案内。候補0件の理由と失敗は、ここでなく窓で知らせる。
  if (routes.length === 0) {
    return (
      <p className={textVariants({ variant: "hint" })}>
        {generation.running ? (
          (generation.progressLabel ?? "生成中...")
        ) : (
          <GuideText text="「ルート設定」の「ルート生成」を押すと候補がここに並びます" />
        )}
      </p>
    );
  }

  const entries = routeListEntries(results.generated, results.edits);
  const nameOf = (routeId: string) => entries.find((entry) => entry.route.id === routeId)?.name ?? "";
  // 編集中は同じ場所が編集面になる（「ルート編集」という別の置き場を持たない）。元は1本に固定で、相手を
  // 選び直しても変わらない。
  if (splice.panel) {
    const { sameRouteId, ...panel } = splice.panel;
    return <RouteSplicePanel {...panel} sameRouteName={sameRouteId === null ? null : nameOf(sameRouteId)} />;
  }

  // 編集で作ったルートの中身に、元との違いを出す。
  function renderEditDifference(route: RouteCandidate) {
    const edit = results.edits.find((item) => item.route.id === route.id);
    const origin = edit && routes.find((candidate) => candidate.id === edit.originId);
    if (!edit || !origin) return null;
    return (
      <EditDifference
        originName={nameOf(origin.id)}
        origin={origin}
        edited={route}
        onShowOrigin={() => results.showRoute(origin.id)}
      />
    );
  }

  // 候補ごとのタブの1段で、タブの切り替えが候補の切り替えを兼ねる。中身は上から、候補の一覧・道のりのグラフ・
  // 元との違い・内訳（区間を押している間は区間の詳細）の順で、狭い高さでも候補の切り替えとグラフが先に見える。
  const baseline = durationBaseline(routes);
  // 道のりのグラフの横軸の右端。候補どうしで同じ物差しにし、面積（負荷）を見比べられるようにする。
  const longestDistanceKm = Math.max(0, ...routes.map((route) => route.distance_km));
  const selectedValue = selectedRouteId ?? routes[0].id;

  return (
    <>
      {generation.conditionsDirty && <WarningText>生成条件が変更されています</WarningText>}
      {generation.weightsNotApplied && <WarningText>重み配分を反映できず、既定の配分で作りました。</WarningText>}
      {generation.destinationCorrected && (
        <WarningText>
          指定した地点は自転車で行けない場所だったため、近くのアクセス可能な地点へ補正しました。
        </WarningText>
      )}
      {reusedRouteId !== null && (
        <p className={cn(textVariants({ variant: "hint" }), "m-0")}>
          作った組み合わせは「{nameOf(reusedRouteId)}」と同じ道なので、「{nameOf(reusedRouteId)}」を選びました
        </p>
      )}
      <Tabs className="flex flex-col gap-2" value={selectedValue} onValueChange={results.selectRoute}>
        {/* 候補は1枚ずつのカードで横に並べ、幅に収まらない分は一覧の中だけを横へ送る。縦には動かないので、縦のなぞりは
            シート・パネルのスクロールへ渡る（縦に動く所を1つにする）。 */}
        <TabsList ref={listRef} variant="cards" aria-label="ルート結果">
          {entries.map(({ route, group, label }, index) => {
            const mark = GROUP_MARKS[group];
            return (
              <Fragment key={route.id}>
                {index > 0 && group !== entries[index - 1].group && (
                  <hr className="m-0 w-0 flex-none self-stretch border-0 border-l border-[var(--color-border)]" />
                )}
                {/* 段の中の空白は見た目には出ず、読み上げの名前でだけ項目を区切る。 */}
                <TabsTrigger
                  ref={route.id === selectedValue ? selectedCardRef : undefined}
                  value={route.id}
                  usage={CANDIDATE_TAB_USAGE}
                  // 選びはタブが（変わったときだけ）知らせ、押したら選んでいたカードでも全体へ収める。
                  onClick={results.focusRoute}
                >
                  <span className="flex items-baseline justify-between gap-1">
                    <span className="inline-flex items-center gap-0.5">
                      {mark && (
                        <span role="img" aria-label={mark.meaning} title={mark.meaning} className="inline-flex">
                          <mark.Icon size={12} />
                        </span>
                      )}
                      {label}
                    </span>{" "}
                    <span>
                      {route.distance_km.toFixed(1)}
                      <span className="text-[length:var(--font-size-xs)] font-normal">km</span>
                    </span>
                  </span>{" "}
                  <span className="flex items-baseline justify-between gap-1 font-normal text-[var(--color-muted-strong)]">
                    {/* 基準線の候補はその所要時間、他の候補はそれとの差（見比べる場所に置く）。 */}
                    <span>
                      {route.id === baseline?.id
                        ? formatDurationShort(baseline.seconds)
                        : durationDifferenceLabel(route, baseline?.seconds ?? null)}
                    </span>{" "}
                    {/* 算出できなかった候補は「—」（0と欠損を同じ見た目にしない）。 */}
                    <span>
                      <span className="sr-only">難易度</span>
                      {route.overall_difficulty === null ? "—" : formatDifficulty(route.overall_difficulty.average)}
                    </span>
                  </span>
                  <span
                    aria-hidden
                    className="-mx-1.5 mt-1 h-[3px]"
                    style={{ backgroundColor: difficultyColor(route) }}
                  />
                </TabsTrigger>
              </Fragment>
            );
          })}
        </TabsList>
        {routes.map((route) => (
          <TabsContent
            key={route.id}
            // 結果の中の道のりのグラフは、走行中の地図の下の図より高くして読みやすくする。
            className="flex flex-col gap-2 data-[state=inactive]:hidden"
            style={{ "--profile-chart-height": "5.5rem" } as CSSProperties}
            value={route.id}
          >
            {/* 道のりのグラフ。区間を選んでいる間も残す（動かして地点を選ぶ操作の置き場のため）。選んでいる間は、その地点の
                詳しくをグラフが自分の下に出す。シートは、高さを決めていなければ、開いたときにここの下端までの高さに合わせる。 */}
            {route.segments.length > 0 && (
              <div {...{ [SHEET_FIT_END_ATTRIBUTE]: "" }}>
                <RouteProfile
                  segments={route.segments}
                  overallDifficulty={route.overall_difficulty?.average ?? null}
                  axes={axisCatalog.axes}
                  axisColors={axisCatalog.axisColors}
                  scaleKm={longestDistanceKm}
                  waypointKms={route.waypoint_distances_km}
                  selected={selectedRouteSegment}
                  onSelect={results.selectSegment}
                  segmentOnMap={results.segmentOnMap}
                  layers={profileLayers}
                />
              </div>
            )}
            {renderEditDifference(route)}
            <RouteAxisProfile
              axes={axisCatalog.axes}
              weights={routeWeights}
              axisDifficulties={route.axis_difficulties}
              axisContributions={route.axis_contributions}
              axisRawValues={route.axis_raw_values}
              materialValues={route.material_values}
              materialCategoryShares={route.material_category_shares}
              distanceKm={route.distance_km}
              overallDifficulty={route.overall_difficulty}
              estimatedDurationSeconds={route.estimated_duration_seconds}
              windUnavailable={route.wind_unavailable}
              missingTravelDataShare={route.missing_travel_data_share}
              axisColors={axisCatalog.axisColors}
            />
          </TabsContent>
        ))}
      </Tabs>
    </>
  );
}
