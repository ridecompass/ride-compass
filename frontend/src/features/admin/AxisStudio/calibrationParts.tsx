"use client";

// 較正の画面で、数値の軸と対応表の軸が共に使う部品（地図の段の境界の下書き・保存・段ごとの延長の比べ）。

import { useState } from "react";

import { Button } from "@/components/ui/Button/Button";
import { textVariants } from "@/components/ui/Text/Text";
import { updateAxisDefinition } from "@/features/admin/adminApi";
import { errorMessage } from "@/lib/apiError";
import { cn } from "@/lib/cn";
import type { ValueBand } from "@/lib/mapDisplay/valueScale";
import type { AxisDefinitionPayload, AxisDefinitionResponse } from "@/types/route";
import { formatThresholdList, parseThresholdList, resizeBandLabels } from "./thresholdList";

/** 保存し直す本文。応答だけが持つ欄（公開中の重みの割合）を外す。 */
export function payloadOf({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  weight_share_when_published: _share,
  ...payload
}: AxisDefinitionResponse): AxisDefinitionPayload {
  return payload;
}

/** 地図の段の境界の下書き。nullは自動（形から導く）。 */
export function useBoundaryDraft(saved: AxisDefinitionResponse) {
  const savedThresholds = saved.display_thresholds_override ?? null;
  const [thresholds, setThresholds] = useState<number[] | null>(savedThresholds);
  const [text, setText] = useState(formatThresholdList(savedThresholds ?? []));
  const [error, setError] = useState<string | null>(null);

  function setList(next: number[] | null) {
    setThresholds(next);
    setText(formatThresholdList(next ?? []));
    setError(null);
  }

  function editText(next: string) {
    setText(next);
    const parsed = parseThresholdList(next);
    setError(parsed.error);
    if (parsed.error === null) setThresholds(parsed.values.length === 0 ? null : parsed.values);
  }

  const bandLabels =
    thresholds === null || !saved.display_band_labels_override
      ? null
      : resizeBandLabels(saved.display_band_labels_override, thresholds.length + 1);

  return {
    thresholds,
    text,
    error,
    changed: JSON.stringify(thresholds) !== JSON.stringify(savedThresholds),
    /** 下書きの本文へ重ねる表示の欄。段の名前の上書きは、境界の数に合わせて詰める。 */
    overrides: { display_thresholds_override: thresholds, display_band_labels_override: bandLabels },
    setList,
    editText,
    revert: () => setList(savedThresholds),
  };
}

export type BoundaryDraft = ReturnType<typeof useBoundaryDraft>;

export function BoundaryField({ boundary }: { boundary: BoundaryDraft }) {
  return (
    <>
      <label className="flex flex-col gap-1 text-[length:var(--font-size-sm)]">
        地図の段の境界（空なら自動）
        <input
          className="rounded-sm border border-[var(--color-border)] bg-[var(--background)] px-2 py-1"
          aria-label="段の境界"
          value={boundary.text}
          onChange={(e) => boundary.editText(e.target.value)}
        />
      </label>
      {boundary.error && <p className={textVariants({ variant: "error" })}>{boundary.error}</p>}
    </>
  );
}

export function AutoBoundaryButton({ boundary }: { boundary: BoundaryDraft }) {
  if (boundary.thresholds === null) return null;
  return (
    <Button size="sm" className="self-start" onClick={() => boundary.setList(null)}>
      境界を自動に戻す
    </Button>
  );
}

/** 公開の状態のまま定義を差し替える保存と、「保存する」「元に戻す」のボタン。 */
export function SaveControls({
  axisId,
  payload,
  changed,
  valid,
  onRevert,
  onSaved,
}: {
  axisId: string;
  payload: AxisDefinitionPayload;
  changed: boolean;
  valid: boolean;
  onRevert: () => void;
  onSaved: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      await updateAxisDefinition(axisId, payload);
      await onSaved();
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {saveError && <p className={textVariants({ variant: "error" })}>{saveError}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={save} disabled={!changed || !valid || saving}>
          {saving ? "保存中…" : "保存する"}
        </Button>
        <Button size="sm" onClick={onRevert} disabled={!changed || saving}>
          元に戻す
        </Button>
      </div>
    </>
  );
}

/** 1つの定義で、地図の段（低い段から）ごとの延長の割合。段・割合が揃う前はnull。 */
export interface BandShares {
  bands: readonly ValueBand[] | null;
  shares: readonly number[] | null;
  failed: boolean;
}

export function BandShareComparison({
  draft,
  saved,
  savedTitle,
  note,
}: {
  draft: BandShares;
  saved: BandShares;
  savedTitle: string;
  note?: string;
}) {
  return (
    <section aria-label="段ごとの延長" className="flex flex-col gap-1">
      <p className={textVariants({ variant: "heading" })}>段ごとの延長</p>
      <p className={textVariants({ variant: "hint" })}>
        取り込んだ範囲の道路から抽選した道を、地図のどの段で塗るかの割合です（走る距離で重み付け）。{note}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <BandShareList title="下書き" {...draft} />
        <BandShareList title={savedTitle} {...saved} />
      </div>
    </section>
  );
}

function BandShareList({ title, bands, shares, failed }: BandShares & { title: string }) {
  return (
    <div role="group" aria-label={title} className="flex flex-col gap-0.5">
      <span className={cn(textVariants({ variant: "hint" }), "font-bold")}>{title}</span>
      {bands === null || shares === null ? (
        <span className={textVariants({ variant: "hint" })}>{failed ? "点数を取得できませんでした。" : "計算中…"}</span>
      ) : (
        bands.map((band, i) => <ShareRow key={band.key} label={band.label} share={shares[i]} color={band.color} />)
      )}
    </div>
  );
}

/** 名前・延長の割合の棒・割合の1行。 */
export function ShareRow({ label, share, color }: { label: string; share: number; color: string | undefined }) {
  return (
    <div className={cn(textVariants({ variant: "hint" }), "grid grid-cols-[1fr_6rem_3.5rem] items-center gap-2")}>
      <span>{label}</span>
      <span className="h-2.5 overflow-hidden rounded-sm bg-[var(--color-surface)]">
        <span className="block h-full" style={{ width: `${share * 100}%`, backgroundColor: color }} />
      </span>
      <span className="text-right tabular-nums">{(share * 100).toFixed(1)}%</span>
    </div>
  );
}
