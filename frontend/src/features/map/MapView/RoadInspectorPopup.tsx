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
import { RetryIcon } from "@/components/ui/icons/lucideIcons";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/ToggleGroup/ToggleGroup";
import PenaltyBreakdown from "@/components/MapPopup/PenaltyBreakdown";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";
import { useCostAxisCatalog } from "@/hooks/useCostAxisCatalog";
import { factText, penaltyRows } from "@/lib/routePenalty";

interface RoadInspectorPopupProps {
  properties: RoadSurfacePopupProperties;
  /** 押した道の線が入る凡例の行（上の帯の線の見本の色）。引けなければnull。 */
  track: RoadTrackRow | null;
  /** 地図が今指定している走行の条件＋押した点のタイル。レンズの値はこの条件で求める。 */
  conditions: RoadInspectorConditions;
  /** 利用者のつまみと倍率（ルート生成へ送るのと同じもの）。費用のレンズの値をこの値で求める。 */
  costPreference: CostPreference;
}

const hintClass = cn(textVariants({ variant: "hint" }), "m-0");

// 地図の道をクリックしたときの中身。答えるのは「この道は何者で、どれだけの負担か」。開いたら負担を取りに行く。
// 開いたときに見せるのは上の帯（名前・路面など）と負担だけで、属性は畳む（地図の上の小さな枠に収めるため）。
export default function RoadInspectorPopup({ properties, track, conditions, costPreference }: RoadInspectorPopupProps) {
  // 負担は道・走行の条件・利用者の値ごとに持つ（値を変えたら取り直す）。条件は開いたときのものに留める——出発時刻は「今」へ
  // 5分刻みで進むので、今の条件で引き直すと開いている間に負担が消える。
  const [opened] = useState(conditions);
  const name = roadDisplayName(properties);
  const summary = roadFactSummary(properties);
  const wayId = roadWayId(properties);
  const featureKey = roadFeatureKey(properties);
  const inspectable = wayId != null && featureKey != null;
  const inspector = useQuery(
    {
      queryKey: ["road-inspector", wayId, featureKey, opened, costPreference],
      queryFn: async () => {
        const value = await fetchRoadInspection(wayId!, featureKey!, opened, costPreference);
        if (value === null) throw new Error("負担が返りませんでした");
        return value;
      },
      enabled: inspectable,
      // 同じ道を同じ条件・利用者の値で開き直したときは、前に取った負担を出す。
      staleTime: Infinity,
    },
    getQueryClient(),
  );
  const result: RoadInspection | null = inspector.data ?? null;

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
      {inspectable && inspector.isPending && <p className={hintClass}>負担を読み込んでいます</p>}
      {inspector.isError && (
        <p className={cn(hintClass, "flex items-center gap-1.5")}>
          負担を取得できませんでした。
          <Button
            usage="取得できなかったこの道の負担を、もう一度取得します。"
            variant="ghost"
            size="panelIcon"
            aria-label="再試行"
            onClick={() => void inspector.refetch()}
          >
            <RetryIcon />
          </Button>
        </p>
      )}
      {result !== null && <LensValues lens={result.lens} />}
      <RoadAttributeRows properties={properties} result={result} />
      {isDebugEnabled() && wayId != null && <p className={hintClass}>OSM way id: {wayId}</p>}
    </div>
  );
}

type LensInspection = RoadInspection["lens"];

/** 区間の代償の秒を「+52秒」の形にする（道1本の区間は分に丸めると0ばかりになる）。 */
function sectionSeconds(seconds: number): string {
  return `+${Math.round(seconds)}秒`;
}

/** 押したフィーチャーの、地図が塗っている向きの区間の代償の秒（総合と軸ごと）。「換算前」に切り替えると、軸ごとに秒の元の事実を
 * 出す（求められない事実の軸は出さない）。直角に近くて向きが決まらない道は、辿れる向きのうち道の向きを先に出す。 */
function LensValues({ lens }: { lens: LensInspection }) {
  const costCatalog = useCostAxisCatalog();
  const [view, setView] = useState("seconds");
  const slot = lens.painted ?? (lens.along !== null ? "along" : "against");
  const values = lens[slot];
  if (values === null) return <p className={hintClass}>この向きには走れません。</p>;
  const rows = penaltyRows(Object.fromEntries(values.axes.map((axis) => [axis.axis_id, axis.seconds])), costCatalog);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <p className={hintClass}>
          {slot === "along" ? "道の向き" : "逆向き"}
          {lens.painted === null ? "[地図の向きに直角に近い道]" : ""}
        </p>
        <ToggleGroup
          value={view}
          onValueChange={setView}
          aria-label="負担の出し方"
          usage="軸ごとの負担を、秒で出すか、秒にする前の事実[登り・止まる回数等]で出すかを切り替えます。"
          className="ml-auto"
        >
          <ToggleGroupItem value="seconds" className="py-0.5">
            秒
          </ToggleGroupItem>
          <ToggleGroupItem value="facts" className="py-0.5">
            換算前
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {/* 事実の名前と単位は backend が付ける（ルートの一覧と同じ作り方）。 */}
      {view === "seconds" ? (
        <PenaltyBreakdown
          total={sectionSeconds(values.total_seconds)}
          items={rows.flatMap((row) =>
            Math.round(row.seconds) === 0 ? [] : [{ row, text: sectionSeconds(row.seconds) }],
          )}
        />
      ) : (
        <PenaltyBreakdown
          total={null}
          items={rows.flatMap((row) => {
            const fact = values.facts[row.id];
            return fact === undefined ? [] : [{ row, text: factText(fact, row.label) }];
          })}
        />
      )}
    </div>
  );
}

/** 「項目: 値」の行の並び（項目の名前は重ならない）。 */
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
