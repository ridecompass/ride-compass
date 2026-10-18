"use client";

// 数値の軸（breakpoint_linear）の較正。実データの分布の上に今の線を大きく描き、0点・100点の端と地図の段の境界を
// 動かして、段ごとの延長が保存済みの線からどう変わるかを見比べてから保存する。線は「0点にする値・100点にする値・
// 効き方」の3つだけで決め（密度の軸は100点にする値だけ）、折れ点を1つずつ動かす口は編集のフォーム（NumericScoring.tsx）にだけ置く。

import { useState } from "react";

import { Button } from "@/components/ui/Button/Button";
import { Callout } from "@/components/ui/Callout/Callout";
import { cardVariants } from "@/components/ui/Card/Card";
import { Select } from "@/components/ui/Input/Input";
import { textVariants } from "@/components/ui/Text/Text";
import { useAxisValueDistribution } from "@/features/admin/useAxisValueDistribution";
import { useScoresPreview } from "@/features/admin/useScoresPreview";
import { useSettledDraftQuery } from "@/features/admin/useSettledDraftQuery";
import {
  fetchCalibrationPreview,
  updateAxisDefinition,
  type CalibrationPreview,
  type ScoresPreviewRequest,
} from "@/features/admin/adminApi";
import { errorMessage } from "@/lib/apiError";
import { cn } from "@/lib/cn";
import { bandColorsFor, mapPaintDeclarationOf, valueBands, type ValueBand } from "@/lib/mapDisplay/valueScale";
import type { AxisDefinitionPayload, AxisDefinitionResponse } from "@/types/route";
import { formatThresholdList, parseThresholdList, resizeBandLabels } from "./axisDraft";
import { BreakpointCurveEditor, type CurveHandle } from "./BreakpointCurveEditor";
import { generateBreakpoints, generatorSettingsFrom } from "./breakpointTools";
import { ScoreTargetFields, type GeneratorSettings } from "./NumericScoring";
import { binMidpoints, mapBandShares, type ValueDistribution } from "./scoreDistribution";

type Breakpoints = [number, number][];
type NumericDefinition = AxisDefinitionResponse & { shape: { kind: "breakpoint_linear" } };

function isNumeric(def: AxisDefinitionResponse): def is NumericDefinition {
  return def.shape.kind === "breakpoint_linear";
}

/** 保存し直す本文。応答だけが持つ欄（公開中の重みの割合）を外す。 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function payloadOf({ weight_share_when_published: _share, ...payload }: AxisDefinitionResponse): AxisDefinitionPayload {
  return payload;
}

export function AxisCalibration({
  definitions,
  onSaved,
}: {
  definitions: readonly AxisDefinitionResponse[];
  onSaved: () => Promise<void>;
}) {
  const [axisId, setAxisId] = useState("");
  const numericDefs = definitions.filter(isNumeric);
  const selected = numericDefs.find((def) => def.axis_id === axisId) ?? null;

  return (
    <section className={cn(cardVariants({ variant: "outline" }), "flex flex-col gap-2")} aria-label="較正">
      <p className={textVariants({ variant: "heading" })}>較正</p>
      <p className={textVariants({ variant: "hint" })}>
        数値の軸の0点・100点にする値と地図の段の境界を、実データの分布と段ごとの延長を見ながら決めます。公開中の軸は公開したまま保存されます。
      </p>
      <Select aria-label="較正する軸" value={axisId} onChange={(e) => setAxisId(e.target.value)}>
        <option value="">軸を選ぶ</option>
        {numericDefs.map((def) => (
          <option key={def.axis_id} value={def.axis_id}>
            {`${def.label}（${def.is_published ? "公開中" : "下書き"}）`}
          </option>
        ))}
      </Select>
      {/* 保存し直した定義が届いたら作り直し、下書きを保存済みの値から始め直す。 */}
      {selected && <CalibrationBody key={JSON.stringify(selected)} saved={selected} onSaved={onSaved} />}
    </section>
  );
}

function CalibrationBody({ saved, onSaved }: { saved: NumericDefinition; onSaved: () => Promise<void> }) {
  const savedBreakpoints = saved.shape.breakpoints as Breakpoints;
  const savedThresholds = saved.display_thresholds_override ?? null;
  const [initialGenerator] = useState(() => generatorSettingsFrom(savedBreakpoints));
  const [generator, setGenerator] = useState(initialGenerator);
  const [thresholds, setThresholds] = useState<number[] | null>(savedThresholds);
  const [thresholdText, setThresholdText] = useState(formatThresholdList(savedThresholds ?? []));
  const [thresholdError, setThresholdError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const savedPreview = useSettledDraftQuery(
    "calibration-preview",
    { definition: payloadOf(saved) },
    fetchCalibrationPreview,
  );
  const densityLine = savedPreview.data?.averages_density ?? false;

  const distributionKey = JSON.stringify([saved.shape.preprocess, saved.shape.terms]);
  const valueDistribution = useAxisValueDistribution(distributionKey, () => saved.shape);
  const distribution = valueDistribution.distribution;

  const lineValid = densityLine ? generator.hundredValue > 0 : generator.zeroValue !== generator.hundredValue;
  const draftBreakpoints: Breakpoints = densityLine
    ? [
        [0, 0],
        [generator.hundredValue, 100],
      ]
    : generateBreakpoints(generator.zeroValue, generator.hundredValue, generator.shape);
  const bandLabels =
    thresholds === null || !saved.display_band_labels_override
      ? null
      : resizeBandLabels(saved.display_band_labels_override, thresholds.length + 1);
  const draftPayload: AxisDefinitionPayload = {
    ...payloadOf(saved),
    shape: { ...saved.shape, breakpoints: draftBreakpoints },
    display_thresholds_override: thresholds,
    display_band_labels_override: bandLabels,
  };
  const draftPreview = useSettledDraftQuery(
    "calibration-preview",
    lineValid && savedPreview.data ? { definition: draftPayload } : null,
    fetchCalibrationPreview,
  );

  // 3つの入力から作り直せない線（折れ点を手で動かした線）は、保存すると作り直した線に置き換わる。
  const savedReproducible =
    densityLine ||
    JSON.stringify(
      generateBreakpoints(initialGenerator.zeroValue, initialGenerator.hundredValue, initialGenerator.shape),
    ) === JSON.stringify([...savedBreakpoints].sort((a, b) => a[0] - b[0])) ||
    isStraightLine(savedBreakpoints, initialGenerator);
  const generatorChanged = JSON.stringify(generator) !== JSON.stringify(initialGenerator);
  const lineChanged = !savedReproducible || generatorChanged;
  const changed = lineChanged || JSON.stringify(thresholds) !== JSON.stringify(savedThresholds);

  const kind = savedPreview.data?.map_paint.value.kind;
  const shownThresholds = thresholds ?? draftPreview.data?.map_paint.thresholds ?? null;
  const boundaryColors = kind && shownThresholds ? bandColorsFor(kind, shownThresholds) : [];
  const boundaries =
    kind === "difficulty" && shownThresholds
      ? shownThresholds.map((value, i) => ({ value, color: boundaryColors[i + 1] }))
      : [];

  const handles: CurveHandle[] = draftBreakpoints.flatMap(([, score], index) => {
    if (score === 0 && !densityLine) {
      return [{ index, label: "0点の端" }];
    }
    if (score === 100) return [{ index, label: "100点の端" }];
    return [];
  });

  function updateGenerator(patch: Partial<GeneratorSettings>) {
    setGenerator((current) => ({ ...current, ...patch }));
  }

  function moveHandle(index: number, pos: 0 | 1, value: number) {
    if (pos !== 0) return;
    updateGenerator(draftBreakpoints[index][1] === 0 ? { zeroValue: value } : { hundredValue: value });
  }

  function setBoundaryList(next: number[] | null) {
    setThresholds(next);
    setThresholdText(formatThresholdList(next ?? []));
    setThresholdError(null);
  }

  function moveBoundary(index: number, value: number) {
    if (!shownThresholds) return;
    // 境界は昇順で重ならない（backendの検証）ので、隣の境界の内側に収める。
    const lower = index === 0 ? 0 : shownThresholds[index - 1] + 1;
    const upper = index === shownThresholds.length - 1 ? 100 : shownThresholds[index + 1] - 1;
    setBoundaryList(shownThresholds.map((v, i) => (i === index ? Math.min(upper, Math.max(lower, value)) : v)));
  }

  function editThresholdText(text: string) {
    setThresholdText(text);
    const parsed = parseThresholdList(text);
    setThresholdError(parsed.error);
    if (parsed.error === null) setThresholds(parsed.values.length === 0 ? null : parsed.values);
  }

  function revert() {
    setGenerator(initialGenerator);
    setBoundaryList(savedThresholds);
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      await updateAxisDefinition(saved.axis_id, draftPayload);
      await onSaved();
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (savedPreview.failed) {
    return <p className={textVariants({ variant: "error" })}>この軸の地図の段を求められませんでした。</p>;
  }
  if (!savedPreview.data) {
    return <p className={textVariants({ variant: "hint" })}>この軸の地図の段を読み込み中…</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <ScoreTargetFields
        generator={generator}
        onChange={updateGenerator}
        hasReferencePoints={false}
        referencePoints={[]}
        unit=""
        densityLine={densityLine}
      />
      {!lineValid && (
        <p className={textVariants({ variant: "error" })}>
          {densityLine
            ? "100点にする値は0より大きくしてください。"
            : "0点にする値と100点にする値を別の値にしてください。"}
        </p>
      )}
      {!savedReproducible && (
        <Callout tone="warning">
          保存済みの線は折れ点を手で動かした形で、0点・100点にする値と効き方では作り直せません（灰色の破線）。保存すると、上の値で作った線に置き換わります。
        </Callout>
      )}
      <BreakpointCurveEditor
        size="large"
        breakpoints={draftBreakpoints}
        onChangePoint={moveHandle}
        referenceRange={referenceRangeOf(savedBreakpoints, distribution)}
        distribution={distribution}
        handles={handles}
        referenceLine={lineChanged ? savedBreakpoints : null}
        boundaries={boundaries}
        onChangeBoundary={moveBoundary}
      />
      {valueDistribution.error && <p className={textVariants({ variant: "hint" })}>{valueDistribution.error}</p>}
      <label className="flex flex-col gap-1 text-[length:var(--font-size-sm)]">
        地図の段の境界（空なら自動）
        <input
          className="rounded-sm border border-[var(--color-border)] bg-[var(--background)] px-2 py-1"
          aria-label="段の境界"
          value={thresholdText}
          onChange={(e) => editThresholdText(e.target.value)}
        />
      </label>
      {thresholdError && <p className={textVariants({ variant: "error" })}>{thresholdError}</p>}
      {kind === "signed_material" && (
        <p className={textVariants({ variant: "hint" })}>
          この軸は地図を材料の値で塗るため、段の境界は材料の値です（グラフの縦軸の点数とは目盛りが違うので、グラフには重ねません）。
        </p>
      )}
      {thresholds !== null && (
        <Button size="sm" className="self-start" onClick={() => setBoundaryList(null)}>
          境界を自動に戻す
        </Button>
      )}
      {draftPreview.failed && (
        <p className={textVariants({ variant: "error" })}>
          この下書きの地図の段を求められませんでした。境界が小さい順に並んでいるか確かめてください。
        </p>
      )}
      {kind === "difficulty" && distribution && (
        <BandShareComparison
          distribution={distribution}
          draftBreakpoints={lineValid ? draftBreakpoints : null}
          draftPreview={draftPreview.data ?? null}
          saved={saved}
          savedPreview={savedPreview.data}
        />
      )}
      {saveError && <p className={textVariants({ variant: "error" })}>{saveError}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={save} disabled={!changed || !lineValid || thresholdError !== null || saving}>
          {saving ? "保存中…" : "保存する"}
        </Button>
        <Button size="sm" onClick={revert} disabled={!changed || saving}>
          元に戻す
        </Button>
      </div>
    </div>
  );
}

/** 保存済みの線が、効き方「一定」の2点の直線か（3つの入力の作る6点の直線と同じ線になる）。 */
function isStraightLine(breakpoints: Breakpoints, settings: GeneratorSettings): boolean {
  if (breakpoints.length !== 2 || settings.shape !== "flat") return false;
  const scoreAt = new Map(breakpoints.map(([x, score]) => [x, score]));
  return scoreAt.get(settings.zeroValue) === 0 && scoreAt.get(settings.hundredValue) === 100;
}

/** 横軸の範囲。保存済みの線と、実データの大半（最初の階級から99%点まで）が入るようにし、端を動かしても目盛りが動かない。 */
function referenceRangeOf(saved: Breakpoints, distribution: ValueDistribution | null): { min: number; max: number } {
  const xs = saved.map(([x]) => x);
  const bins = distribution?.bins ?? [];
  if (bins.length > 0) {
    xs.push(bins[0][0], distribution?.quantiles.p99 ?? bins[bins.length - 1][1]);
  }
  return { min: Math.min(...xs), max: Math.max(...xs) };
}

function BandShareComparison({
  distribution,
  draftBreakpoints,
  draftPreview,
  saved,
  savedPreview,
}: {
  distribution: ValueDistribution;
  draftBreakpoints: Breakpoints | null;
  draftPreview: CalibrationPreview | null;
  saved: NumericDefinition;
  savedPreview: CalibrationPreview;
}) {
  const xs = binMidpoints(distribution);
  const draftScores = useScoresPreview(
    draftBreakpoints && {
      shape: { ...saved.shape, breakpoints: draftBreakpoints } as ScoresPreviewRequest["shape"],
      xs,
      material_values: [],
    },
  );
  const savedScores = useScoresPreview({
    shape: saved.shape as ScoresPreviewRequest["shape"],
    xs,
    material_values: [],
  });
  return (
    <section aria-label="段ごとの延長" className="flex flex-col gap-1">
      <p className={textVariants({ variant: "heading" })}>段ごとの延長</p>
      <p className={textVariants({ variant: "hint" })}>
        取り込んだ範囲の道路から抽選した道を、地図のどの段で塗るかの割合です（走る距離で重み付け）。
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <BandShareList
          title="下書き"
          bands={draftPreview && valueBands(mapPaintDeclarationOf(draftPreview.map_paint))}
          shares={
            draftPreview &&
            mapBandShares(
              distribution,
              draftScores.preview?.scores ?? null,
              valueBands(mapPaintDeclarationOf(draftPreview.map_paint)),
            )
          }
          failed={draftScores.failed}
        />
        <BandShareList
          title={saved.is_published ? "公開中" : "保存済み"}
          bands={valueBands(mapPaintDeclarationOf(savedPreview.map_paint))}
          shares={mapBandShares(
            distribution,
            savedScores.preview?.scores ?? null,
            valueBands(mapPaintDeclarationOf(savedPreview.map_paint)),
          )}
          failed={savedScores.failed}
        />
      </div>
    </section>
  );
}

function BandShareList({
  title,
  bands,
  shares,
  failed,
}: {
  title: string;
  bands: readonly ValueBand[] | null;
  shares: readonly number[] | null;
  failed: boolean;
}) {
  return (
    <div role="group" aria-label={title} className="flex flex-col gap-0.5">
      <span className={cn(textVariants({ variant: "hint" }), "font-bold")}>{title}</span>
      {bands === null || shares === null ? (
        <span className={textVariants({ variant: "hint" })}>{failed ? "点数を取得できませんでした。" : "計算中…"}</span>
      ) : (
        bands.map((band, i) => (
          <div
            key={band.key}
            className={cn(textVariants({ variant: "hint" }), "grid grid-cols-[1fr_6rem_3.5rem] items-center gap-2")}
          >
            <span>{band.label}</span>
            <span className="h-2.5 overflow-hidden rounded-sm bg-[var(--color-surface)]">
              <span className="block h-full" style={{ width: `${shares[i] * 100}%`, backgroundColor: band.color }} />
            </span>
            <span className="text-right tabular-nums">{(shares[i] * 100).toFixed(1)}%</span>
          </div>
        ))
      )}
    </div>
  );
}
