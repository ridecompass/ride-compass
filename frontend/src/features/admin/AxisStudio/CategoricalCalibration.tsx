"use client";

// 対応表の軸（categorical）の較正。種類ごとに、その種類の道が占める延長を見ながら点数を数で直し、地図の段の境界と
// 段ごとの延長を保存済みの定義と見比べる。どの種類に点数を付けるか（行を足す・消す）は軸の定義ファイルで決め、
// この画面では変えない。

import { useState } from "react";

import { NumberInput } from "@/components/ui/NumberInput/NumberInput";
import { textVariants } from "@/components/ui/Text/Text";
import { fetchCalibrationPreview } from "@/features/admin/adminApi";
import { useMaterialValueShares } from "@/features/admin/useMaterialValueShares";
import { useSettledDraftQuery } from "@/features/admin/useSettledDraftQuery";
import { bandAt, mapPaintDeclarationOf, valueBands } from "@/lib/mapDisplay/valueScale";
import type { AxisDefinitionPayload, AxisDefinitionResponse } from "@/types/route";
import {
  AutoBoundaryButton,
  BandShareComparison,
  BoundaryField,
  payloadOf,
  SaveControls,
  ShareRow,
  useBoundaryDraft,
} from "./calibrationParts";
import { categoryBandShares } from "./scoreDistribution";

export type CategoricalDefinition = AxisDefinitionResponse & {
  shape: { kind: "categorical"; material: string; mapping: Record<string, number> };
};

export function CategoricalCalibrationBody({
  saved,
  onSaved,
}: {
  saved: CategoricalDefinition;
  onSaved: () => Promise<void>;
}) {
  const savedMapping = saved.shape.mapping;
  const [mapping, setMapping] = useState(savedMapping);
  const boundary = useBoundaryDraft(saved);
  const valueShares = useMaterialValueShares(saved.shape.material);

  const draftPayload: AxisDefinitionPayload = {
    ...payloadOf(saved),
    shape: { ...saved.shape, mapping },
    ...boundary.overrides,
  };
  const savedPreview = useSettledDraftQuery(
    "calibration-preview",
    { definition: payloadOf(saved) },
    fetchCalibrationPreview,
  );
  const draftPreview = useSettledDraftQuery(
    "calibration-preview",
    savedPreview.data ? { definition: draftPayload } : null,
    fetchCalibrationPreview,
  );
  const changed = JSON.stringify(mapping) !== JSON.stringify(savedMapping) || boundary.changed;

  if (savedPreview.failed) {
    return <p className={textVariants({ variant: "error" })}>この軸の地図の段を求められませんでした。</p>;
  }
  if (!savedPreview.data) {
    return <p className={textVariants({ variant: "hint" })}>この軸の地図の段を読み込み中…</p>;
  }

  const draftBands = draftPreview.data ? valueBands(mapPaintDeclarationOf(draftPreview.data.map_paint)) : null;
  const savedBands = valueBands(mapPaintDeclarationOf(savedPreview.data.map_paint));
  const shares = valueShares.shares?.values ?? null;
  const shareOf = new Map((shares ?? []).map((s) => [s.value, s]));
  const unscoredShare = (shares ?? [])
    .filter((s) => !Object.hasOwn(mapping, s.value))
    .reduce((sum, s) => sum + s.share, 0);

  return (
    <div className="flex flex-col gap-2">
      <section aria-label="種類ごとの点数" className="flex flex-col gap-1">
        <p className={textVariants({ variant: "heading" })}>種類ごとの点数</p>
        <p className={textVariants({ variant: "hint" })}>
          割合は、取り込んだ範囲の道路から抽選した道のうち、この材料の値を持つ道の延長に占める、その種類の道の延長です。棒の色は下書きで塗る段の色です。
        </p>
        {Object.entries(mapping).map(([value, score]) => {
          const label = shareOf.get(value)?.label ?? value;
          return (
            <div key={value} className="grid grid-cols-[6rem_1fr] items-center gap-2">
              <NumberInput
                commitOn="input"
                step="any"
                aria-label={`${label}の点数`}
                value={score}
                onValueChange={(next) => setMapping((current) => ({ ...current, [value]: next }))}
              />
              {shares === null ? (
                <span className={textVariants({ variant: "hint" })}>{label}</span>
              ) : (
                <ShareRow
                  label={label}
                  share={shareOf.get(value)?.share ?? 0}
                  color={draftBands ? bandAt(draftBands, score).color : undefined}
                />
              )}
            </div>
          );
        })}
        {unscoredShare > 0 && <ShareRow label="対応表に無い値（評価しない）" share={unscoredShare} color={undefined} />}
        {valueShares.failed && (
          <p className={textVariants({ variant: "hint" })}>種類ごとの延長を取得できませんでした。</p>
        )}
      </section>
      <BoundaryField boundary={boundary} />
      <AutoBoundaryButton boundary={boundary} />
      {draftPreview.failed && (
        <p className={textVariants({ variant: "error" })}>
          この下書きの地図の段を求められませんでした。境界が小さい順に並んでいるか確かめてください。
        </p>
      )}
      {shares !== null && (
        <BandShareComparison
          draft={{
            bands: draftBands,
            shares: draftBands && categoryBandShares(shares, mapping, draftBands),
            failed: false,
          }}
          saved={{
            bands: savedBands,
            shares: categoryBandShares(shares, savedMapping, savedBands),
            failed: false,
          }}
          savedTitle={saved.is_published ? "公開中" : "保存済み"}
          note="対応表に無い値の道は塗らないので数えません。"
        />
      )}
      <SaveControls
        axisId={saved.axis_id}
        payload={draftPayload}
        changed={changed}
        valid={boundary.error === null}
        onRevert={() => {
          setMapping(savedMapping);
          boundary.revert();
        }}
        onSaved={onSaved}
      />
    </div>
  );
}
