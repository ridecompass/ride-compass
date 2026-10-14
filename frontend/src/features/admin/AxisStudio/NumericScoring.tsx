"use client";

// 数値の材料の点数（breakpoint_linear）。入力欄は「この値で0点・この値で100点」と効き方で、
// 折れ点の並びは保存形式なので、直接いじる口は詳細設定に畳む。

import { useScoresPreview } from "@/features/admin/useScoresPreview";
import type { ScoresPreviewRequest } from "@/features/admin/adminApi";
import { binMidpoints, type ValueDistribution } from "./scoreDistribution";
import { useState } from "react";
import {
  BREAKPOINT_SHAPE_OPTIONS,
  generateBreakpoints,
  insertBreakpointAtLargestGap,
  generatorSettingsFrom,
  type BreakpointShape,
} from "./breakpointTools";
import type { AxisMaterialOption } from "@/lib/axisMaterialsCatalog";
import { useAxisValueDistribution } from "@/features/admin/useAxisValueDistribution";
import { Checkbox } from "@/components/ui/Checkbox/Checkbox";
import { InfoPopoverButton, SectionLabel } from "./AxisFormFields";
import { buildShape, type Draft } from "./axisDraft";
import { BreakpointCurveEditor } from "./BreakpointCurveEditor";
import { DistributionPreview } from "./DistributionPreview";
import { ScoringTerms } from "./ScoringTerms";
import { Button } from "@/components/ui/Button/Button";
import { NumberInput } from "@/components/ui/NumberInput/NumberInput";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table/Table";
import { Select } from "@/components/ui/Input/Input";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";

type GeneratorSettings = ReturnType<typeof generatorSettingsFrom>;

interface ReferencePoint {
  label: string;
  value: number;
  x: number;
  score: number;
}

interface NumericScoringProps {
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
  materialOptions: readonly AxisMaterialOption[];
  axisTermOptions: readonly AxisMaterialOption[];
}

export function NumericScoring({ draft, setDraft, materialOptions, axisTermOptions }: NumericScoringProps) {
  // 折れ点の自動生成フォーム（範囲＋形の3入力）。**入力のたびにdraft.breakpointsを
  // 作り直す**ため、初期値はいまの折れ点から復元する（breakpointTools.ts:
  // generatorSettingsFrom）。固定値にすると、既存の軸を開いて効き方だけを変えたときに
  // 無関係な範囲で折れ点が作り直され、較正済みの端点が黙って消える。
  // このコンポーネントは軸ごと（AxisStudio.tsxがAxisComposerへkeyを渡す）と、数値の材料を選び直すたびに
  // 作り直されるため、初期化関数だけで足りる。
  const [generator, setGenerator] = useState(() => generatorSettingsFrom(draft.breakpoints));
  // 単一材料のtermを1つだけ持つ場合にのみ、その材料の参考点（reference_points）を「効き目プレビュー」
  // 「自動生成の値の目安」「曲線エディタの横軸固定」に使う。複数termの組み合わせは参考点の対応が取れないため対象外。
  const primaryMaterial =
    draft.terms.length === 1 ? materialOptions.find((m) => m.id === draft.terms[0].material) : undefined;
  const primaryMaterialReferencePoints = primaryMaterial?.referencePoints ?? [];
  // 分布は「材料・重み・前処理」で決まり、折れ点では変わらない。折れ点を含めない
  // キーで取得することで、折れ点のドラッグ中に通信が走らない。
  const distributionTermsKey = JSON.stringify([
    draft.preprocess,
    draft.terms.map((t) => [t.material, t.weight, t.required]),
  ]);
  const valueDistribution = useAxisValueDistribution(distributionTermsKey, () => buildShape(draft, materialOptions));
  // 分布の階級と参考点の点数・参考点の横軸の値は、backendが評価と同じ計算で返す（折れ点を動かすたびに、
  // 落ち着いたら問い合わせる）。届くまでは効き目の表と参考点のボタンを出さない。
  const { preview: scoresPreview, failed: scoresFailed } = useScoresPreview(
    draft.terms.length > 0 && draft.breakpoints.length > 0
      ? {
          shape: buildShape(draft, materialOptions) as ScoresPreviewRequest["shape"],
          xs: binMidpoints(valueDistribution.distribution),
          material_values: primaryMaterialReferencePoints.map((p) => p.value),
        }
      : null,
  );
  // 評価できない参考点（null）は出さない。
  const referencePoints: ReferencePoint[] =
    scoresPreview && scoresPreview.material_points.length === primaryMaterialReferencePoints.length
      ? primaryMaterialReferencePoints.flatMap((p, i) => {
          const point = scoresPreview.material_points[i];
          return point ? [{ ...p, ...point }] : [];
        })
      : [];
  const unit = primaryMaterial?.unit ?? "";

  /** 「0点にする値」「100点にする値」「効き方」のどれかを変え、材料の値→スコアの変換を作り直す。
   * 折れ点の並びそのものは保存形式であって入力欄ではない——実在する軸の大半は2点の直線で、
   * 曲線は実データを見て決めるもの（較正）。直接いじる口は下の詳細設定に残してある。 */
  function updateGenerator(patch: Partial<GeneratorSettings>) {
    const next = { ...generator, ...patch };
    setGenerator(next);
    if (next.zeroValue === next.hundredValue) return;
    setDraft((d) => ({ ...d, breakpoints: generateBreakpoints(next.zeroValue, next.hundredValue, next.shape) }));
  }

  return (
    <>
      <SectionLabel
        label="材料"
        description="はい/いいえの材料も選べます（該当時は1、非該当時は0として係数と掛け合わされます。街灯なし・トンネルなど、複数の危険要素の有無を数えて減点・加点したい場合もここに追加してください）。複数の材料を追加すると、それぞれの「値×係数」の合計が下の折れ点でスコアへ変換されます。"
      />
      <ScoringTerms
        draft={draft}
        setDraft={setDraft}
        materialOptions={materialOptions}
        axisTermOptions={axisTermOptions}
      />
      <label className="inline-flex items-center gap-1 text-[length:var(--font-size-sm)]">
        <Checkbox
          checked={draft.preprocess === "abs"}
          onCheckedChange={(next) => setDraft((d) => ({ ...d, preprocess: next ? "abs" : "identity" }))}
          aria-label="マイナス側も同じ強さとして扱う"
        />
        マイナス側も同じ強さとして扱う
        <InfoPopoverButton
          ariaLabel="「マイナス側も同じ強さとして扱う」の説明"
          description={
            "材料の値×係数の合計がマイナスでも、プラスと同じ大きさとして点数にします" +
            "（例: 勾配は上りが+・下りが−の符号付きですが、これを付けると上り・下りのどちらでも急なほど走りにくい軸になります）。" +
            "軸の形によっては、地図の塗りも符号つきの生値に変わります。"
          }
        />
      </label>
      <ScoreTargetFields
        generator={generator}
        onChange={updateGenerator}
        hasReferencePoints={primaryMaterialReferencePoints.length > 0}
        referencePoints={referencePoints}
        unit={unit}
      />
      <DistributionPreview
        distribution={valueDistribution.distribution}
        binScores={scoresPreview?.scores ?? null}
        scoresFailed={scoresFailed}
        loading={valueDistribution.loading}
        error={valueDistribution.error}
      />
      <DirectBreakpointEditor
        breakpoints={draft.breakpoints}
        setDraft={setDraft}
        referencePoints={referencePoints}
        distribution={valueDistribution.distribution}
      />
      {referencePoints.length > 0 && <ReferencePointTable points={referencePoints} unit={unit} />}
    </>
  );
}

function ScoreTargetFields({
  generator,
  onChange,
  hasReferencePoints,
  referencePoints,
  unit,
}: {
  generator: GeneratorSettings;
  onChange: (patch: Partial<GeneratorSettings>) => void;
  /** 材料が参考点を持つか（届く前から説明文を決めるため、`referencePoints`とは別に受ける）。 */
  hasReferencePoints: boolean;
  referencePoints: readonly ReferencePoint[];
  unit: string;
}) {
  return (
    <>
      <SectionLabel
        label="何点にするか"
        description={
          "この2つの値と効き方から、材料の値→スコアの変換を作ります。値の大小はどちら向きでも構いません" +
          "（0点にする値の方が大きくてもよい）。細かい形は実データを見ながら決めるもので、ここでは大枠だけ決めます。" +
          (hasReferencePoints
            ? "下のボタンは材料の参考点（目安）です。押すとその点に当たる値を「0点」へ入れます。"
            : "")
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ["0点", "zeroValue"],
            ["100点", "hundredValue"],
          ] as const
        ).map(([caption, key]) => (
          <span key={key} className="inline-flex items-center gap-2 [&_input[type=number]]:w-18">
            <span className={cn(textVariants({ variant: "hint" }), "whitespace-nowrap")}>{caption}</span>
            <NumberInput
              commitOn="input"
              step="any"
              value={generator[key]}
              aria-label={`${caption}にする値`}
              onValueChange={(next) => onChange({ [key]: next })}
            />
          </span>
        ))}
        <Select
          aria-label="効き方"
          value={generator.shape}
          onChange={(e) => onChange({ shape: e.target.value as BreakpointShape })}
        >
          {BREAKPOINT_SHAPE_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </Select>
      </div>
      {referencePoints.length > 0 && (
        <div className="flex flex-wrap gap-1" role="group" aria-label="参考点から値を選ぶ">
          {referencePoints.map((p) => (
            <Button
              size="xs"
              key={p.label}
              onClick={() => onChange({ zeroValue: p.x })}
              onDoubleClick={() => onChange({ hundredValue: p.x })}
            >
              {`${p.label}（${p.value}${unit}）`}
            </Button>
          ))}
        </div>
      )}
    </>
  );
}

function DirectBreakpointEditor({
  breakpoints,
  setDraft,
  referencePoints,
  distribution,
}: {
  breakpoints: Draft["breakpoints"];
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
  referencePoints: readonly ReferencePoint[];
  distribution: ValueDistribution | null;
}) {
  // 参考点の値域（曲線エディタの横軸固定に使う）。参考点が無い・届いていなければundefinedのままで、
  // 曲線エディタはbreakpoints自体から自動スケールする。
  const referenceRange =
    referencePoints.length > 0
      ? {
          min: Math.min(...referencePoints.map((p) => p.x)),
          max: Math.max(...referencePoints.map((p) => p.x)),
        }
      : undefined;

  function updateBreakpoint(index: number, pos: 0 | 1, value: number) {
    setDraft((d) => ({
      ...d,
      breakpoints: d.breakpoints.map((bp, i) =>
        i === index ? ([pos === 0 ? value : bp[0], pos === 1 ? value : bp[1]] as [number, number]) : bp,
      ),
    }));
  }

  return (
    <details className="[&>summary]:cursor-pointer [&>summary]:py-1 [&>summary]:text-[length:var(--font-size-sm)] [&>summary]:text-[var(--color-muted)] open:[&>summary]:text-[var(--foreground)]">
      <summary>折れ点を直接いじる</summary>
      <SectionLabel
        label="折れ点"
        description="値が大きいほど走りにくくしたければ右肩上がりに、走りやすくしたければ右肩下がりに設定してください。図はドラッグ・矢印キーでも調整できます。"
      />
      <BreakpointCurveEditor
        breakpoints={breakpoints}
        onChangePoint={updateBreakpoint}
        referenceRange={referenceRange}
        distribution={distribution}
      />
      {breakpoints.map((bp, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 [&_input]:w-20">
          <NumberInput
            commitOn="input"
            step="any"
            value={bp[0]}
            aria-label="入力値"
            onValueChange={(next) => updateBreakpoint(i, 0, next)}
          />
          <span>→</span>
          <NumberInput
            commitOn="input"
            step="any"
            value={bp[1]}
            aria-label="スコア"
            onValueChange={(next) => updateBreakpoint(i, 1, next)}
          />
          <Button
            size="sm"
            onClick={() => setDraft((d) => ({ ...d, breakpoints: d.breakpoints.filter((_, j) => j !== i) }))}
            disabled={breakpoints.length <= 2}
          >
            削除
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        className="self-start"
        onClick={() => setDraft((d) => ({ ...d, breakpoints: insertBreakpointAtLargestGap(d.breakpoints) }))}
      >
        + 折れ点を追加
      </Button>
    </details>
  );
}

function ReferencePointTable({ points, unit }: { points: readonly ReferencePoint[]; unit: string }) {
  return (
    <div className="flex flex-col gap-1">
      <SectionLabel label="効き目プレビュー" description="今の折れ点で、材料の参考点それぞれが何点になるかです。" />
      <Table>
        <TableHead>
          <TableRow>
            <TableHeader>参考点</TableHeader>
            <TableHeader>値</TableHeader>
            <TableHeader>スコア</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {points.map((p) => (
            <TableRow key={p.label}>
              <TableCell>{p.label}</TableCell>
              <TableCell>
                {p.value}
                {unit}
              </TableCell>
              <TableCell>{p.score}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
