"use client";

// 軸スタジオの「点数の決め方」の節。**材料を選べば入力欄は決まる**——数値なら
// 「この値で0点・この値で100点」、はい/いいえなら該当時と非該当時のスコア、種類なら値ごとのスコア、
// ほかの軸なら係数を掛けた合計。形ごとの入力欄はそれぞれの部品が持つ（docs/modules/frontend/axis-studio.md参照）。

import type { AxisMaterialOption } from "@/lib/axisMaterialsCatalog";
import { MaterialInfoButton, RequiredCheckbox, SectionLabel } from "./AxisFormFields";
import type { Draft } from "./axisDraft";
import { CategoricalScoring } from "./CategoricalScoring";
import { NumericScoring } from "./NumericScoring";
import { materialOptionElements, patchTerm, ScoringTerms } from "./ScoringTerms";
import { Select } from "@/components/ui/Input/Input";
import { textVariants } from "@/components/ui/Text/Text";
import { calloutVariants } from "@/components/ui/Callout/Callout";
import { cn } from "@/lib/cn";
import { cardVariants } from "@/components/ui/Card/Card";

interface AxisScoringSectionProps {
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
  /** 材料カタログ（実行時取得）。 */
  materialOptions: readonly AxisMaterialOption[];
  /** 「ほかの軸」を材料として選ぶための候補（他の軸の一覧）。 */
  axisTermOptions: readonly AxisMaterialOption[];
}

/** 選んだもの（材料、または他の軸）の型に合わせて、点数の形と入力値をまとめて組み替える。 */
function draftForPrimary(d: Draft, id: string, isAxis: boolean, dtype: AxisMaterialOption["dtype"] | undefined): Draft {
  if (isAxis) {
    return {
      ...d,
      shapeKind: "recipe_then_breakpoint_linear",
      terms: [{ material: id, weight: 1.0, required: true }],
      preprocess: "identity",
      breakpoints: [
        [0, 0],
        [100, 100],
      ],
    };
  }
  if (dtype === "boolean" || dtype === "categorical") {
    return {
      ...d,
      shapeKind: "categorical",
      categoricalMaterial: id,
      categoricalRows:
        dtype === "categorical" && d.categoricalRows.length === 0 ? [{ value: "", score: 0 }] : d.categoricalRows,
    };
  }
  // 数値材料。既に数値で組んでいる場合は係数・折れ点を保ち、材料だけ入れ替える。
  if (d.shapeKind === "breakpoint_linear") return patchTerm(0, { material: id })(d);
  return {
    ...d,
    shapeKind: "breakpoint_linear",
    terms: [{ material: id, weight: 1.0, required: true }],
    breakpoints: [
      [0, 0],
      [10, 100],
    ],
  };
}

export function AxisScoringSection({ draft, setDraft, materialOptions, axisTermOptions }: AxisScoringSectionProps) {
  // 点数のもとになるもの（材料、または他の軸）。**これの型が点数のつけ方を決める**ため、
  // 利用者に「なめらか評価／ぴったり評価」のような呼び名を選ばせない。
  const primaryMaterialId =
    draft.shapeKind === "categorical" ? draft.categoricalMaterial : (draft.terms[0]?.material ?? "");

  function selectPrimaryMaterial(id: string) {
    const isAxis = axisTermOptions.some((option) => option.id === id);
    const dtype = materialOptions.find((m) => m.id === id)?.dtype;
    setDraft((d) => draftForPrimary(d, id, isAxis, dtype));
  }

  return (
    <>
      <SectionLabel
        label="何をもとに点数をつけるか"
        description={
          "点数のつけ方はここで選んだものの型が決めます——数値なら「この値で0点・この値で100点」、" +
          "はい/いいえなら2つのスコア、種類なら値ごとのスコア、ほかの軸なら係数を掛けた合計です。"
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <Select
          aria-label="点数のもとになるもの"
          value={primaryMaterialId}
          onChange={(e) => selectPrimaryMaterial(e.target.value)}
        >
          <optgroup label="数値">
            {materialOptionElements(materialOptions.filter((m) => m.dtype === "numeric"))}
          </optgroup>
          <optgroup label="はい・いいえ / 種類">
            {materialOptionElements(materialOptions.filter((m) => m.dtype === "boolean" || m.dtype === "categorical"))}
          </optgroup>
          {axisTermOptions.length > 0 && (
            <optgroup label="ほかの軸">{materialOptionElements(axisTermOptions)}</optgroup>
          )}
        </Select>
        <MaterialInfoButton option={[...materialOptions, ...axisTermOptions].find((m) => m.id === primaryMaterialId)} />
        {draft.shapeKind !== "categorical" && draft.terms.length === 1 && (
          <RequiredCheckbox
            checked={draft.terms[0]?.required ?? true}
            onCheckedChange={(next) => setDraft(patchTerm(0, { required: next }))}
          />
        )}
      </div>
      {/* 「0=走りやすい・100=走りにくい」をこの節の先頭で1回だけ伝える
            （折れ点・カテゴリのスコア・true/falseスコアの入力欄では繰り返さない）。 */}
      <p className={textVariants({ variant: "hint" })}>スコアは0(走りやすい)〜100(走りにくい)です。</p>

      <div className={cn(cardVariants({ variant: "muted" }), "flex flex-col gap-2")}>
        {draft.shapeKind === "breakpoint_linear" && (
          <NumericScoring
            draft={draft}
            setDraft={setDraft}
            materialOptions={materialOptions}
            axisTermOptions={axisTermOptions}
          />
        )}
        {draft.shapeKind === "recipe_then_breakpoint_linear" && (
          <AxisRecipeScoring
            draft={draft}
            setDraft={setDraft}
            materialOptions={materialOptions}
            axisTermOptions={axisTermOptions}
          />
        )}
        {draft.shapeKind === "categorical" && (
          <CategoricalScoring draft={draft} setDraft={setDraft} materialOptions={materialOptions} />
        )}
      </div>
    </>
  );
}

/** ほかの軸を組み合わせる形。純粋な重み付き結合に絞り、下ごしらえ・折れ点の編集UIを出さない
 * （保存時は既定値[そのまま・恒等クランプ0→0,100→100]のまま送信される、buildShape・draftForPrimaryの設定参照）。 */
function AxisRecipeScoring(props: AxisScoringSectionProps) {
  return (
    <>
      <SectionLabel
        label="組み合わせる軸"
        description="各軸のスコア(0〜100)に係数(n, m…)を掛けた合計が、そのままスコアになります（nX + mYのように軸同士を重み付きで足し合わせるだけの、純粋な結合です）。"
      />
      {props.axisTermOptions.length === 0 && (
        <p className={calloutVariants({ tone: "warning" })}>
          組み合わせられる他の軸がまだありません。先に材料から軸を1つ以上作成してから使えます。
        </p>
      )}
      <ScoringTerms {...props} />
    </>
  );
}
