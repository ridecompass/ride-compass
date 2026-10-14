"use client";

// はい/いいえ・種類の材料の点数（categorical）。材料のdtypeで表示を切り替える
// （boolean→2択、categorical→値ごとのスコア行）。

import type { AxisMaterialOption } from "@/lib/axisMaterialsCatalog";
import { useMaterialValues } from "@/features/admin/useMaterialValues";
import { SectionLabel, SliderNumberField } from "./AxisFormFields";
import type { CategoricalRowDraft, Draft } from "./axisDraft";
import { Button } from "@/components/ui/Button/Button";
import { fieldClass, Input, Select } from "@/components/ui/Input/Input";

type MaterialValue = ReturnType<typeof useMaterialValues>["values"][number];

interface CategoricalScoringProps {
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
  materialOptions: readonly AxisMaterialOption[];
}

export function CategoricalScoring({ draft, setDraft, materialOptions }: CategoricalScoringProps) {
  const valuePerRow = materialOptions.find((m) => m.id === draft.categoricalMaterial)?.dtype === "categorical";
  return (
    <>
      <Button
        size="sm"
        className="self-start"
        onClick={() =>
          // 真偽材料を複数足して合計したい軸（街灯なし＋トンネル等）は、値ごとの
          // スコアではなく「値×係数の合計」の形になる。ここが唯一の移り口。
          setDraft((d) => ({
            ...d,
            shapeKind: "breakpoint_linear",
            terms: [{ material: d.categoricalMaterial, weight: 1.0, required: true }],
            breakpoints: [
              [0, 0],
              [1, 100],
            ],
          }))
        }
      >
        + 材料を足して合計する
      </Button>
      {valuePerRow ? (
        <CategoricalValueRows draft={draft} setDraft={setDraft} />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <label className={fieldClass}>
            該当時(true)のスコア
            <SliderNumberField
              label="はいのときのスコア"
              value={draft.trueScore}
              onChange={(next) => setDraft((d) => ({ ...d, trueScore: next }))}
              min={-100}
              max={100}
              step={1}
            />
          </label>
          <label className={fieldClass}>
            非該当時(false)のスコア
            <SliderNumberField
              label="いいえのときのスコア"
              value={draft.falseScore}
              onChange={(next) => setDraft((d) => ({ ...d, falseScore: next }))}
              min={-100}
              max={100}
              step={1}
            />
          </label>
        </div>
      )}
    </>
  );
}

function CategoricalValueRows({
  draft,
  setDraft,
}: {
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
}) {
  const { values, unavailable } = useMaterialValues(draft.categoricalMaterial);

  function updateRow(index: number, patch: Partial<CategoricalRowDraft>) {
    setDraft((d) => ({
      ...d,
      categoricalRows: d.categoricalRows.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    }));
  }

  return (
    <>
      <SectionLabel
        label="値ごとのスコア"
        description={
          (values.length > 0
            ? "値は下の候補（実データに含まれる値）から選びます。"
            : unavailable
              ? "候補を取得できませんでした（DBへ接続できないか、集計が時間内に終わりませんでした）。値は元データのタグ値と完全に一致する文字列で入力します。"
              : "値は元データのタグ値と完全に一致する文字列で入力します。") +
          "ここに設定していない値の区間は評価対象外（データなし扱い）になります。"
        }
      />
      {draft.categoricalRows.map((row, i) => (
        <CategoricalValueRow
          key={i}
          row={row}
          candidates={values}
          removable={draft.categoricalRows.length > 1}
          onChange={(patch) => updateRow(i, patch)}
          onRemove={() => setDraft((d) => ({ ...d, categoricalRows: d.categoricalRows.filter((_, j) => j !== i) }))}
        />
      ))}
      <Button
        size="sm"
        className="self-start"
        onClick={() => setDraft((d) => ({ ...d, categoricalRows: [...d.categoricalRows, { value: "", score: 0 }] }))}
      >
        + 値を追加
      </Button>
    </>
  );
}

function CategoricalValueRow({
  row,
  candidates,
  removable,
  onChange,
  onRemove,
}: {
  row: CategoricalRowDraft;
  candidates: readonly MaterialValue[];
  removable: boolean;
  onChange: (patch: Partial<CategoricalRowDraft>) => void;
  onRemove: () => void;
}) {
  // 候補一覧がある材料は、候補セレクトでの選択のみを許可し、値は常にラベルの読み取り専用表示にする
  // （生のタグ値は画面に出さない——material_catalogに無い値を書く実運用上の必要性は基本無く、直接入力を残すと
  // タイプミスがそのまま「静かに一致しない行」として残る落とし穴になる）。候補一覧が無い材料（動的値一覧に
  // 対応していない）だけ、自由テキスト入力のままにする（選ぶ元となる候補自体が存在しないため）。
  const hasDynamicCandidates = candidates.length > 0;
  // 選択中の値のラベルは、取得済みの候補一覧（MaterialSpec.value_labels由来）から引く。候補一覧に無い値（編集を
  // 開いた時点で既存軸が保持していたが、実データが変わり現在は候補から外れた値等）は生のタグ値そのままにする。
  const label = candidates.find((v) => v.value === row.value)?.label ?? row.value;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {hasDynamicCandidates && (
        <Select
          aria-label="値の候補"
          value=""
          onChange={(e) => {
            if (e.target.value) onChange({ value: e.target.value });
          }}
        >
          <option value="">候補から選ぶ...</option>
          {candidates.map((v) => (
            <option key={v.value} value={v.value}>
              {v.label}
            </option>
          ))}
        </Select>
      )}
      {hasDynamicCandidates ? (
        // 実体は読み取り専用のinputにする（素のspanではなくinput[type=text]にすることで、globals.cssの
        // 共通スタイルがそのまま当たり見た目が他のinputと揃う）。値は候補セレクトからのみ設定する。
        <Input type="text" value={label} readOnly aria-label="値" placeholder="候補から選択してください" />
      ) : (
        <Input
          type="text"
          value={row.value}
          aria-label="値"
          placeholder="例: separated"
          onChange={(e) => onChange({ value: e.target.value })}
        />
      )}
      <SliderNumberField
        label="スコア"
        value={row.score}
        onChange={(next) => onChange({ score: next })}
        min={-100}
        max={100}
        step={1}
      />
      <Button size="sm" onClick={onRemove} disabled={!removable}>
        削除
      </Button>
    </div>
  );
}
