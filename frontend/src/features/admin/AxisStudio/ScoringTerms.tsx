"use client";

// 「値×係数の合計」を組む形（数値の材料・ほかの軸）が共有する、項の行と「+ 足して合計する」。

import { materialOptionText, type AxisMaterialOption } from "@/lib/axisMaterialsCatalog";
import { MaterialInfoButton, RequiredCheckbox, SliderNumberField } from "./AxisFormFields";
import type { Draft, TermDraft } from "./axisDraft";
import { MaterialRangeHint } from "./MaterialRangeHint";
import { Button } from "@/components/ui/Button/Button";
import { Select } from "@/components/ui/Input/Input";

export function materialOptionElements(options: readonly AxisMaterialOption[]) {
  return options.map((m) => (
    <option key={m.id} value={m.id}>
      {materialOptionText(m)}
    </option>
  ));
}

/** `index`番目の項だけを`patch`で書き換える更新。 */
export function patchTerm(index: number, patch: Partial<TermDraft>) {
  return (d: Draft): Draft => ({ ...d, terms: d.terms.map((t, i) => (i === index ? { ...t, ...patch } : t)) });
}

interface ScoringTermsProps {
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
  materialOptions: readonly AxisMaterialOption[];
  axisTermOptions: readonly AxisMaterialOption[];
}

/** booleanの材料も選べる（該当時1・非該当時0として係数と掛け合わされる、
 * backend/app/domain/axis_definitions.py: _breakpoint_raw_total_array）。categoricalは非対応のまま（文字列材料と数値の
 * 掛け算はbackend側でエラーになる）。recipe_then_breakpoint_linearは、材料の代わりに他の軸(axisTermOptions)を候補にする。 */
export function ScoringTerms({ draft, setDraft, materialOptions, axisTermOptions }: ScoringTermsProps) {
  const axisRecipe = draft.shapeKind === "recipe_then_breakpoint_linear";
  const termOptions = axisRecipe
    ? axisTermOptions
    : materialOptions.filter((m) => m.dtype === "numeric" || m.dtype === "boolean");
  // 材料を1行ずつ並べる編集欄を出すか。単一の数値材料では係数は「0点/100点にする値」へ
  // 吸収されるため出さない。はい/いいえの材料を足し合わせる軸（街灯なし−50＋トンネル+50等）は
  // 係数そのものが点数の配分なので、1件でも出す。
  const first = draft.terms[0];
  const showTermRows =
    draft.terms.length > 1 ||
    (first?.weight ?? 1) !== 1 ||
    materialOptions.find((m) => m.id === first?.material)?.dtype === "boolean";

  return (
    <>
      {showTermRows &&
        draft.terms.map((term, i) => (
          <TermRow
            key={i}
            term={term}
            termOptions={termOptions}
            showRangeHint={!axisRecipe}
            removable={draft.terms.length > 1}
            onChange={(patch) => setDraft(patchTerm(i, patch))}
            onRemove={() => setDraft((d) => ({ ...d, terms: d.terms.filter((_, j) => j !== i) }))}
          />
        ))}
      <Button
        size="sm"
        className="self-start"
        disabled={axisRecipe && axisTermOptions.length === 0}
        onClick={() =>
          setDraft((d) => {
            // materialOptionsが空のとき無条件アクセスでクラッシュしないよう""へ。
            const fallback = termOptions[0]?.id ?? materialOptions[0]?.id ?? "";
            return { ...d, terms: [...d.terms, { material: fallback, weight: 1.0, required: false }] };
          })
        }
      >
        + {axisRecipe ? "軸を足して合計する" : "材料を足して合計する"}
      </Button>
    </>
  );
}

function TermRow({
  term,
  termOptions,
  showRangeHint,
  removable,
  onChange,
  onRemove,
}: {
  term: TermDraft;
  termOptions: readonly AxisMaterialOption[];
  /** 他の軸を組み合わせる行が持つのは軸idで、材料の分位は引けない。 */
  showRangeHint: boolean;
  removable: boolean;
  onChange: (patch: Partial<TermDraft>) => void;
  onRemove: () => void;
}) {
  const option = termOptions.find((m) => m.id === term.material);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={term.material} onChange={(e) => onChange({ material: e.target.value })}>
        {materialOptionElements(termOptions)}
      </Select>
      <MaterialInfoButton option={option} />
      {/* 典型的な係数の範囲（±10）に絞り、範囲外の値は数値欄から直接入力する想定にした。 */}
      <SliderNumberField
        label="係数"
        value={term.weight}
        onChange={(next) => onChange({ weight: next })}
        min={-10}
        max={10}
        step={0.1}
      />
      <RequiredCheckbox checked={term.required} onCheckedChange={(next) => onChange({ required: next })} />
      <Button size="sm" onClick={onRemove} disabled={!removable}>
        削除
      </Button>
      {/* 実データの分位は行の末尾で1行を占有させる（basis-full）。
            操作要素の間へ挟むと、狭幅の折り返しで説明文とスライダーが混ざる。 */}
      {showRangeHint && <MaterialRangeHint className="basis-full" materialId={term.material} unit={option?.unit} />}
    </div>
  );
}
