"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import AxisDetail from "@/components/AxisContributionBar/AxisDetail";
import { DifficultyBlock, PopupHeader } from "@/components/MapPopup/MapPopupParts";
import { legendChipBodyClass, legendChipClass } from "@/components/ui/AxisLegend/axisLegend";
import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";
import type { CatalogAxis } from "@/lib/catalogAxis";
import { isDebugEnabled } from "@/lib/debugLog";
import { getQueryClient } from "@/lib/queryClient";
import { fetchAxisInspector, type AxisInspectorConditions, type AxisInspectorResult } from "@/features/map/regionApi";
import type { RoutePreferenceWeights } from "@/types/route";
import { LANDCOVER_CLASSES } from "@/lib/mapDisplay/landcoverClasses";
import { LEGEND_SWATCH_RING_CLASS, legendSwatchBackground } from "@/lib/mapDisplay/legendFilter";
import type { RoadTrackRow } from "@/lib/mapDisplay/roadTracks";
import {
  roadDisplayName,
  roadFactRows,
  roadFactSummary,
  roadFeatureKey,
  roadTagRows,
  roadWayId,
  type RoadFactRow,
  type RoadSurfacePopupProperties,
} from "./roadFacts";
import { Button } from "@/components/ui/Button/Button";
import { InspectRoadIcon } from "@/components/ui/icons/lucideIcons";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";

interface RoadInspectorPopupProps {
  properties: RoadSurfacePopupProperties;
  /** 押した道の線が入る凡例の行（地図の道の色と道の種類の名前）。引けなければnull。 */
  track: RoadTrackRow | null;
  /** 公開軸すべて（順序・ラベルの正本）。ルート結果と同じ並びで内訳を出すために渡す。 */
  axes: readonly CatalogAxis[];
  /** 軸id→色（ルート結果の寄与度バー・凡例チップと同じ配色）。 */
  axisColors: Record<string, string>;
  /** 地図が今指定している走行の条件＋押した点のタイル。走る条件を使う軸は、この条件で値を求める。 */
  conditions: AxisInspectorConditions;
  /** 利用者がいま設定している重み（ルート生成へ送るのと同じもの）。nullなら既定の重み。 */
  routePreference: RoutePreferenceWeights | null;
}

const hintClass = cn(textVariants({ variant: "hint" }), "m-0");

// 地図の道をクリックしたときの中身。答えるのは「この道は何者で、なぜこの評価なのか」。
//
// **ルート結果と同じ部品・同じ配色で評価を出す**（`AxisContributionBar`・`AxisDetail`）——同じ「軸ごとの
// 効き方」を別の見た目で見せると、利用者は2つの読み方を覚えることになる。
// 評価は押したときだけ取りに行く（クリックのたびに引くとレート制限に当たる）。
// 開いたときに見せるのは上の帯（道の種類・名前・路面など）と評価だけで、属性は畳む（地図の上の小さな枠に収めるため）。
export default function RoadInspectorPopup({
  properties,
  track,
  axes,
  axisColors,
  conditions,
  routePreference,
}: RoadInspectorPopupProps) {
  // 評価は道・走行の条件・重みごとに持つ。重みを変えたら、古い重みの評価を見せずに取り直しへ戻す。条件は押したときの
  // ものに留める——出発時刻は「今」へ5分刻みで進むので、今の条件で引き直すと開いている間に評価が消える。
  const weightsKey = JSON.stringify(routePreference);
  const [pressed, setPressed] = useState<{ weightsKey: string; conditions: AxisInspectorConditions } | null>(null);
  const pinned = pressed !== null && pressed.weightsKey === weightsKey ? pressed : null;
  const name = roadDisplayName(properties) ?? track?.label ?? null;
  const summary = roadFactSummary(properties);
  const wayId = roadWayId(properties);
  const featureKey = roadFeatureKey(properties);
  const inspector = useQuery(
    {
      queryKey: ["axis-inspector", wayId, featureKey, JSON.stringify(pinned?.conditions ?? conditions), weightsKey],
      // 取りに行くのは押したあと（`pinned`がある間）だけ。
      queryFn: async () => {
        const value = await fetchAxisInspector(wayId!, featureKey!, pinned!.conditions, routePreference);
        if (value === null) throw new Error("評価が返りませんでした");
        return value;
      },
      enabled: pinned !== null && wayId != null && featureKey != null,
      // 同じ道を同じ条件・重みで開き直したときは、前に取った評価を出す（押すたびに引くとレート制限に当たる）。
      staleTime: Infinity,
    },
    getQueryClient(),
  );
  const result: AxisInspectorResult | null = inspector.data ?? null;

  const load = () => {
    if (pinned !== null) void inspector.refetch();
    else setPressed({ weightsKey, conditions });
  };

  return (
    <div className="flex max-w-68 flex-col gap-1.5">
      <PopupHeader label="道の小窓の上の帯">
        {track !== null && (
          <span
            aria-hidden="true"
            className={cn("inline-block h-1.5 w-4 flex-none rounded-[1px]", LEGEND_SWATCH_RING_CLASS)}
            style={{ background: legendSwatchBackground(track) }}
          />
        )}
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {name !== null && <span className="font-semibold">{name}</span>}
          {summary.length > 0 && <span className={cn(hintClass, "ml-1.5")}>{summary.join("・")}</span>}
        </span>
      </PopupHeader>
      {wayId != null && featureKey != null && result === null && (
        <Button
          size="panelIcon"
          className="self-start disabled:cursor-progress"
          onClick={load}
          disabled={inspector.isFetching}
          aria-busy={inspector.isFetching}
          aria-label="この道の評価を見る"
          usage="この道を、いまの条件と重みで評価した値を取りに行きます。"
        >
          <InspectRoadIcon />
        </Button>
      )}
      {inspector.isError && <p className={hintClass}>評価を取得できませんでした。</p>}
      {result !== null && <FeatureValues values={result.values} axes={axes} axisColors={axisColors} />}
      <RoadAttributeRows properties={properties} result={result} />
      {isDebugEnabled() && wayId != null && <p className={hintClass}>OSM way id: {wayId}</p>}
    </div>
  );
}

type InspectorValues = AxisInspectorResult["values"];

/** 押したフィーチャー（その倍率で地図が塗る区間か道1本）の評価の塊: 難易度・軸ごとの効き方と、周囲の土地被覆のチップ。 */
function FeatureValues({
  values,
  axes,
  axisColors,
}: {
  values: InspectorValues;
  axes: readonly CatalogAxis[];
  axisColors: Record<string, string>;
}) {
  // 寄与度はbackendが返す（軸ごとの重み付き寄与、合計が合成スコアと一致する）。
  // フロントで重みを掛け直さない——ルート結果側と同じ規約。
  const contributions: Record<string, number> = {};
  for (const axis of values.axes) {
    if (axis.contribution != null) contributions[axis.axis_id] = axis.contribution;
  }

  // 合成に使えた軸の重みの割合（%）。出すのと同じ丸めで100%に届かないときだけ、一部の軸だけの値だと添える。
  const coveredWeightPercent =
    values.composite_difficulty != null ? Math.round(values.composite_difficulty.covered_weight_fraction * 100) : null;

  return (
    <DifficultyBlock
      difficulty={values.composite_difficulty?.value ?? null}
      note={
        coveredWeightPercent !== null && coveredWeightPercent < 100
          ? `重みの約${coveredWeightPercent}%ぶんの評価軸だけ（残りはこの走る条件で値が出せません）`
          : undefined
      }
      axes={axes}
      contributions={contributions}
      axisColors={axisColors}
      renderDetail={(axis) => {
        const found = values.axes.find((a) => a.axis_id === axis.axisId);
        if (found === undefined || found.difficulty === null) return null;
        return <AxisDetail axis={axis} difficulty={found.difficulty} />;
      }}
      extraChips={values.landcover === null ? undefined : <LandcoverChip landcover={values.landcover} />}
    />
  );
}

/** 「項目: 値」の行の並び。項目の名前は並びの中で重ならない。 */
function FactList({ rows }: { rows: readonly RoadFactRow[] }) {
  return (
    <dl className="m-0 grid gap-0.5">
      {rows.map((row) => (
        <div key={row.label} className="grid grid-cols-[5.5rem_1fr] gap-1.5">
          <dt className={hintClass}>{row.label}</dt>
          <dd className="m-0 [overflow-wrap:anywhere]">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 道路の周りの帯の土地被覆のチップ。最も多いクラスだけを見せ、押すと割合の大きい順に開く（0%のクラスは出さない。
 * 割合は合計100%）。 */
function LandcoverChip({ landcover }: { landcover: NonNullable<InspectorValues["landcover"]> }) {
  const rows = LANDCOVER_CLASSES.map((cls) => ({
    label: cls.label,
    value: landcover[cls.percentField as keyof typeof landcover] as number,
  }))
    .filter((row) => row.value >= 0.5)
    .sort((a, b) => b.value - a.value);
  if (rows.length === 0) return null;
  const top = `${rows[0].label} ${Math.round(rows[0].value)}%`;
  return (
    <li className={legendChipClass}>
      <InfoPopover
        triggerClassName={cn(legendChipBodyClass, "cursor-pointer")}
        triggerAriaLabel={`周囲の土地被覆（${top}）の内訳`}
        triggerContent={top}
      >
        <p className="font-medium">周囲の土地被覆</p>
        <FactList rows={rows.map((row) => ({ label: row.label, value: `${Math.round(row.value)}%` }))} />
      </InfoPopover>
    </li>
  );
}

/** この道の属性。地図のタイルから分かる事実に、評価を取ったときに届くタグを足し、**同じ項目は1度だけ**出す（タイルとタグの
 * 両方が持つ項目がある）。中は日本語で読める値だけにし、英語の生の値・登録外のタグ（`name`・`ref`等、OSM編集者が自由に
 * 書ける）は、数が読めないため、さらに畳んだ「その他のタグ」に置く。畳んでおく——走行中に読むものではなく、開いたままだと
 * 地図の上の枠からはみ出す。 */
function RoadAttributeRows({
  properties,
  result,
}: {
  properties: RoadSurfacePopupProperties;
  result: AxisInspectorResult | null;
}) {
  const rows = [...roadFactRows(properties)];
  const tagged = result === null ? { rows: [], raw: [] } : roadTagRows({ highway: result.highway, ...result.tags });
  for (const row of tagged.rows) if (!rows.some((shown) => shown.label === row.label)) rows.push(row);
  return (
    <details className="border-t border-[var(--color-border)] pt-1 [&_summary]:cursor-pointer">
      <summary className={hintClass} data-usage="この道の属性の一覧を開きます。">
        この道の属性
      </summary>
      <FactList rows={rows} />
      {tagged.raw.length > 0 && (
        <details>
          <summary className={hintClass} data-usage="上に並べていない、この道のタグを開きます。">
            その他のタグ
          </summary>
          <FactList rows={tagged.raw} />
        </details>
      )}
    </details>
  );
}
