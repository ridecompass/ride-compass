"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PopupHeader } from "@/components/MapPopup/MapPopupParts";
import { isDebugEnabled } from "@/lib/debugLog";
import { getQueryClient } from "@/lib/queryClient";
import { fetchRoadInspection, type RoadInspection, type RoadInspectorConditions } from "@/features/map/regionApi";
import type { CostPreference } from "@/types/route";
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
import { useCostAxisCatalog } from "@/hooks/useCostAxisCatalog";
import { formatLensNumber, LENS_SECONDS_UNIT } from "@/lib/mapDisplay/costLensPaint";
import { costAxisLabel, factValueText } from "@/lib/routePenalty";

interface RoadInspectorPopupProps {
  properties: RoadSurfacePopupProperties;
  /** 押した道の線が入る凡例の行（地図の道の色と道の種類の名前）。引けなければnull。 */
  track: RoadTrackRow | null;
  /** 地図が今指定している走行の条件＋押した点のタイル。レンズの値はこの条件で求める。 */
  conditions: RoadInspectorConditions;
  /** 利用者のつまみと倍率（ルート生成へ送るのと同じもの）。費用のレンズの値をこの値で求める。 */
  costPreference: CostPreference;
}

const hintClass = cn(textVariants({ variant: "hint" }), "m-0");

// 地図の道をクリックしたときの中身。答えるのは「この道は何者で、どれだけの負担か」。
// 負担は押したときだけ取りに行く（クリックのたびに引くとレート制限に当たる）。
// 開いたときに見せるのは上の帯（道の種類・名前・路面など）と負担だけで、属性は畳む（地図の上の小さな枠に収めるため）。
export default function RoadInspectorPopup({
  properties,
  track,
  conditions,
  costPreference,
}: RoadInspectorPopupProps) {
  // 負担は道・走行の条件・利用者の値ごとに持つ。値を変えたら、古い値の負担を見せずに取り直しへ戻す。条件は押したときの
  // ものに留める——出発時刻は「今」へ5分刻みで進むので、今の条件で引き直すと開いている間に負担が消える。
  const preferenceKey = JSON.stringify(costPreference);
  const [pressed, setPressed] = useState<{ preferenceKey: string; conditions: RoadInspectorConditions } | null>(null);
  const pinned = pressed !== null && pressed.preferenceKey === preferenceKey ? pressed : null;
  const name = roadDisplayName(properties) ?? track?.label ?? null;
  const summary = roadFactSummary(properties);
  const wayId = roadWayId(properties);
  const featureKey = roadFeatureKey(properties);
  const inspector = useQuery(
    {
      queryKey: ["road-inspector", wayId, featureKey, JSON.stringify(pinned?.conditions ?? conditions), preferenceKey],
      // 取りに行くのは押したあと（`pinned`がある間）だけ。
      queryFn: async () => {
        const value = await fetchRoadInspection(wayId!, featureKey!, pinned!.conditions, costPreference);
        if (value === null) throw new Error("負担が返りませんでした");
        return value;
      },
      enabled: pinned !== null && wayId != null && featureKey != null,
      // 同じ道を同じ条件・利用者の値で開き直したときは、前に取った負担を出す（押すたびに引くとレート制限に当たる）。
      staleTime: Infinity,
    },
    getQueryClient(),
  );
  const result: RoadInspection | null = inspector.data ?? null;

  const load = () => {
    if (pinned !== null) void inspector.refetch();
    else setPressed({ preferenceKey, conditions });
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
          aria-label="この道の負担を見る"
          usage="この道の負担を、いまの走る条件と負担の強さ・倍率で取りに行きます。"
        >
          <InspectRoadIcon />
        </Button>
      )}
      {inspector.isError && <p className={hintClass}>負担を取得できませんでした。</p>}
      {result !== null && <LensValues lens={result.lens} />}
      <RoadAttributeRows properties={properties} result={result} />
      {isDebugEnabled() && wayId != null && <p className={hintClass}>OSM way id: {wayId}</p>}
    </div>
  );
}

type LensInspection = RoadInspection["lens"];

/** 押したフィーチャーの、地図のレンズと同じ1kmあたりの代償の秒（総合と軸ごと）と、その元の事実。地図が塗っている向きの
 * 値を出す（直角に近くて向きが決まらない道は、辿れる向きのうち道の向きを先に）。 */
function LensValues({ lens }: { lens: LensInspection }) {
  const costCatalog = useCostAxisCatalog();
  const slot = lens.painted ?? (lens.along !== null ? "along" : "against");
  const values = lens[slot];
  if (values === null) return <p className={hintClass}>この向きには走れません。</p>;
  // 事実の名前と単位は backend が付ける（ルートの内訳・凡例の目安と同じ事実は同じ名前）。
  const facts: RoadFactRow[] = [
    ...values.facts.map((fact) => ({ label: fact.label, value: factValueText(fact) })),
    ...(lens.surface !== null ? [{ label: "路面", value: lens.surface }] : []),
  ];
  return (
    <div className="flex flex-col gap-1">
      <p className="m-0">
        <span className="font-semibold">
          {costCatalog.lenses?.totalLens.label ?? "負担"} {formatLensNumber(values.total_seconds_per_km)}
          {LENS_SECONDS_UNIT}
        </span>
        <span className={cn(hintClass, "ml-1.5")}>
          {slot === "along" ? "道の向き" : "逆向き"}
          {lens.painted === null ? "（地図の向きに直角に近い道）" : ""}
        </span>
      </p>
      <FactList
        rows={values.axes.map((axis) => ({
          label: costAxisLabel(costCatalog, axis.axis_id),
          value: `${formatLensNumber(axis.seconds_per_km)}${LENS_SECONDS_UNIT}`,
        }))}
      />
      {facts.length > 0 && <FactList rows={facts} />}
    </div>
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

/** この道の属性。地図のタイルから分かる事実に、負担を取ったときに届くタグを足し、**同じ項目は1度だけ**出す（タイルとタグの
 * 両方が持つ項目がある）。中は日本語で読める値だけにし、英語の生の値・登録外のタグ（`name`・`ref`等、OSM編集者が自由に
 * 書ける）は、数が読めないため、さらに畳んだ「その他のタグ」に置く。畳んでおく——走行中に読むものではなく、開いたままだと
 * 地図の上の枠からはみ出す。 */
function RoadAttributeRows({
  properties,
  result,
}: {
  properties: RoadSurfacePopupProperties;
  result: RoadInspection | null;
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
