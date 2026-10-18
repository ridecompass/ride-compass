"use client";

// 軸の較正。地図の段の境界と、段ごとの延長が保存済みの定義からどう変わるかを見比べてから、公開の状態のまま保存する。
// 数値の軸（breakpoint_linear）は実データの分布の上に今の線を大きく描き、0点・100点の端を動かす。線は「0点にする値・
// 100点にする値・効き方」の3つだけで決め（密度の軸は100点にする値だけ）、折れ点を1つずつ動かす口は編集のフォーム
// （NumericScoring.tsx）にだけ置く。対応表の軸（categorical）は種類ごとの点数を数で直す（CategoricalCalibration.tsx）。

import { useMemo, useState, type ReactNode } from "react";

import { Callout } from "@/components/ui/Callout/Callout";
import { cardVariants } from "@/components/ui/Card/Card";
import { Select } from "@/components/ui/Input/Input";
import { textVariants } from "@/components/ui/Text/Text";
import { useAxisValueDistribution } from "@/features/admin/useAxisValueDistribution";
import { useScoresPreview } from "@/features/admin/useScoresPreview";
import { useSettledDraftQuery } from "@/features/admin/useSettledDraftQuery";
import {
  fetchCalibrationPreview,
  fetchWayValuesPreview,
  type CalibrationPreview,
  type ScoresPreviewRequest,
  type WayValuesDraft,
  type WayValuesPreviewRequest,
} from "@/features/admin/adminApi";
import { cn } from "@/lib/cn";
import {
  bandColorsFor,
  mapPaintDeclarationOf,
  valueBands,
  type MapPaintDeclaration,
} from "@/lib/mapDisplay/valueScale";
import type { AxisDefinitionPayload, AxisDefinitionResponse } from "@/types/route";
import { BreakpointCurveEditor, type CurveHandle } from "./BreakpointCurveEditor";
import { generateBreakpoints, generatorSettingsFrom } from "./breakpointTools";
import {
  AutoBoundaryButton,
  BandShareComparison,
  BoundaryField,
  payloadOf,
  SaveControls,
  useBoundaryDraft,
} from "./calibrationParts";
import { CategoricalCalibrationBody, type CategoricalDefinition } from "./CategoricalCalibration";
import { ScoreTargetFields, type GeneratorSettings } from "./NumericScoring";
import { binMidpoints, mapBandShares, type ValueDistribution } from "./scoreDistribution";

type Breakpoints = [number, number][];
type MapPaint = CalibrationPreview["map_paint"];
type NumericDefinition = AxisDefinitionResponse & { shape: { kind: "breakpoint_linear" } };

function isNumeric(def: AxisDefinitionResponse): def is NumericDefinition {
  return def.shape.kind === "breakpoint_linear";
}

/** 下書きの点数の地図を描く。地図は別の機能が持つので、組み立てるページが渡す。 */
export type CalibrationMapSlot = (props: {
  axisId: string;
  label: string;
  /** 線が無効な間はnull。 */
  draft: WayValuesDraft | null;
  fetchTile: (
    draft: WayValuesDraft,
    tile: Omit<WayValuesPreviewRequest, keyof WayValuesDraft>,
  ) => ReturnType<typeof fetchWayValuesPreview>;
  paint: MapPaintDeclaration;
}) => ReactNode;

export function AxisCalibration({
  definitions,
  onSaved,
  calibrationMap,
}: {
  definitions: readonly AxisDefinitionResponse[];
  onSaved: () => Promise<void>;
  calibrationMap: CalibrationMapSlot;
}) {
  const [axisId, setAxisId] = useState("");
  const selected = definitions.find((def) => def.axis_id === axisId) ?? null;

  return (
    <section className={cn(cardVariants({ variant: "outline" }), "flex flex-col gap-2")} aria-label="較正">
      <p className={textVariants({ variant: "heading" })}>較正</p>
      <p className={textVariants({ variant: "hint" })}>
        数値の軸の0点・100点にする値、対応表の軸の種類ごとの点数と、地図の段の境界を、実データの分布と段ごとの延長を見ながら決めます。公開中の軸は公開したまま保存されます。
      </p>
      <Select aria-label="較正する軸" value={axisId} onChange={(e) => setAxisId(e.target.value)}>
        <option value="">軸を選ぶ</option>
        {definitions.map((def) => (
          <option key={def.axis_id} value={def.axis_id}>
            {`${def.label}（${def.is_published ? "公開中" : "下書き"}）`}
          </option>
        ))}
      </Select>
      {/* 保存し直した定義が届いたら作り直し、下書きを保存済みの値から始め直す。 */}
      {selected &&
        (isNumeric(selected) ? (
          <NumericCalibrationBody
            key={JSON.stringify(selected)}
            saved={selected}
            onSaved={onSaved}
            calibrationMap={calibrationMap}
          />
        ) : (
          <CategoricalCalibrationBody
            key={JSON.stringify(selected)}
            saved={selected as CategoricalDefinition}
            onSaved={onSaved}
          />
        ))}
    </section>
  );
}

function NumericCalibrationBody({
  saved,
  onSaved,
  calibrationMap,
}: {
  saved: NumericDefinition;
  onSaved: () => Promise<void>;
  calibrationMap: CalibrationMapSlot;
}) {
  const savedBreakpoints = saved.shape.breakpoints as Breakpoints;
  const [initialGenerator] = useState(() => generatorSettingsFrom(savedBreakpoints));
  const [generator, setGenerator] = useState(initialGenerator);
  const boundary = useBoundaryDraft(saved);
  const thresholds = boundary.thresholds;

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
  const draftPayload: AxisDefinitionPayload = {
    ...payloadOf(saved),
    shape: { ...saved.shape, breakpoints: draftBreakpoints },
    ...boundary.overrides,
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
  const changed = lineChanged || boundary.changed;

  // 下書きの段の応答は入力が落ち着くまで消えるので、地図は最後に届いた段を土台に塗る。
  const [lastDraftPaint, setLastDraftPaint] = useState<MapPaint | null>(null);
  const draftPaint = draftPreview.data?.map_paint ?? null;
  if (draftPaint !== null && draftPaint !== lastDraftPaint) setLastDraftPaint(draftPaint);
  const receivedPaint = draftPaint ?? lastDraftPaint ?? savedPreview.data?.map_paint ?? null;
  const mapPaint = useMemo(
    () => receivedPaint && calibrationMapPaint(receivedPaint, thresholds, boundary.bandLabels),
    [receivedPaint, thresholds, boundary.bandLabels],
  );

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

  function moveBoundary(index: number, value: number) {
    if (!shownThresholds) return;
    // 境界は昇順で重ならない（backendの検証）ので、隣の境界の内側に収める。
    const lower = index === 0 ? 0 : shownThresholds[index - 1] + 1;
    const upper = index === shownThresholds.length - 1 ? 100 : shownThresholds[index + 1] - 1;
    boundary.setList(shownThresholds.map((v, i) => (i === index ? Math.min(upper, Math.max(lower, value)) : v)));
  }

  function revert() {
    setGenerator(initialGenerator);
    boundary.revert();
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
      <BoundaryField boundary={boundary} />
      {kind === "signed_material" && (
        <p className={textVariants({ variant: "hint" })}>
          この軸は地図を材料の値で塗るため、段の境界は材料の値です（グラフの縦軸の点数とは目盛りが違うので、グラフには重ねません）。
        </p>
      )}
      <AutoBoundaryButton boundary={boundary} />
      {draftPreview.failed && (
        <p className={textVariants({ variant: "error" })}>
          この下書きの地図の段を求められませんでした。境界が小さい順に並んでいるか確かめてください。
        </p>
      )}
      {mapPaint &&
        calibrationMap({
          axisId: saved.axis_id,
          label: saved.label,
          draft: lineValid
            ? {
                axis_id: saved.axis_id,
                shape: { ...saved.shape, breakpoints: draftBreakpoints } as WayValuesDraft["shape"],
              }
            : null,
          fetchTile: (draft, tile) => fetchWayValuesPreview({ ...draft, ...tile }),
          paint: mapPaint,
        })}
      {kind === "difficulty" && distribution && (
        <NumericBandShares
          distribution={distribution}
          draftBreakpoints={lineValid ? draftBreakpoints : null}
          draftPreview={draftPreview.data ?? null}
          saved={saved}
          savedPreview={savedPreview.data}
        />
      )}
      <SaveControls
        axisId={saved.axis_id}
        payload={draftPayload}
        changed={changed}
        valid={lineValid && boundary.error === null}
        onRevert={revert}
        onSaved={onSaved}
      />
    </div>
  );
}

/** 較正の地図を塗る段。境界は画面で動かしている値（自動の間は応答の境界）で、応答がその境界に対するものなら応答の
 * 凡例（量で書けるものは量）を使う。境界だけを動かして応答が届く前は、境界をそのまま書いた凡例で塗り直す。 */
function calibrationMapPaint(
  received: MapPaint,
  thresholds: number[] | null,
  bandLabels: readonly string[] | null,
): MapPaintDeclaration {
  const declared = mapPaintDeclarationOf(received);
  if (thresholds === null || JSON.stringify(received.thresholds) === JSON.stringify(thresholds)) return declared;
  return {
    kind: declared.kind,
    boundaries: thresholds,
    // 難易度の軸の境界は得点の目盛り、符号付きの材料の軸の境界は材料の値。
    legend: { boundaries: thresholds, unit: declared.kind === "difficulty" ? null : declared.legend.unit },
    bandLabels,
  };
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

function NumericBandShares({
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
  const draftBands = draftPreview && valueBands(mapPaintDeclarationOf(draftPreview.map_paint));
  const savedBands = valueBands(mapPaintDeclarationOf(savedPreview.map_paint));
  return (
    <BandShareComparison
      draft={{
        bands: draftBands,
        shares: draftBands && mapBandShares(distribution, draftScores.preview?.scores ?? null, draftBands),
        failed: draftScores.failed,
      }}
      saved={{
        bands: savedBands,
        shares: mapBandShares(distribution, savedScores.preview?.scores ?? null, savedBands),
        failed: savedScores.failed,
      }}
      savedTitle={saved.is_published ? "公開中" : "保存済み"}
    />
  );
}
