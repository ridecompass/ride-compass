"use client";

import ErrorText from "@/features/route/ErrorText/ErrorText";
import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";
import { NewRouteIcon, RouteDiffIcon, UndoAllIcon, UndoIcon } from "@/components/ui/icons/icons";
import type { CatalogAxis } from "@/lib/catalogAxis";
import { formatDelta } from "@/features/route/routeEditDiff";
import SpliceDeltaBar, { type AxisDelta } from "@/features/route/RouteSplicePanel/SpliceDeltaBar";
import SpliceMetricGrid from "@/features/route/RouteSplicePanel/SpliceMetricGrid";
import { DIFFICULTY_DECIMALS } from "@/lib/mapDisplay/valueScale";
import type { RouteCandidate } from "@/types/route";
import { Button } from "@/components/ui/Button/Button";
import { GuideText } from "@/components/ui/GuideText/GuideText";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";
import { cardVariants } from "@/components/ui/Card/Card";

interface RouteSplicePanelProps {
  /** 編集の元。1本に固定で、地図で他候補を押しても変わらない。 */
  displayed: RouteCandidate;
  /** 適用済みの乗り換えの数。 */
  appliedCount: number;
  /** 次に選べる乗り換えがあるか（無ければ「他の候補と別の道を通る区間がありません」）。 */
  hasAlternatives: boolean;
  /** 直前の1手を戻す。 */
  onUndo: () => void;
  /** 乗り換えをすべて取り消して元のルートへ戻す。 */
  onReset: () => void;
  /** 「差分を見る」で評価した、いまの組み合わせの候補。まだ見ていなければnull。 */
  preview: RouteCandidate | null;
  /** 評価した組み合わせと同じ道を通る、一覧の候補の名前。無ければnull（あれば作成の操作は、新しく足さずにこの候補を選ぶ切り替えになる）。 */
  sameRouteName: string | null;
  /** 差分の評価を待っている間はtrue。 */
  previewing: boolean;
  /** いまの組み合わせを評価して結果を出す。 */
  onPreview: () => void;
  onApply: () => void;
  /** 合成した経路の評価を待っている間はtrue。 */
  applying: boolean;
  /** 合成に失敗した理由。押した場所から見えないと「押しても何も起きない」になる。 */
  error: string | null;
  /** 編集をやめて候補の一覧へ戻る。 */
  onCancel: () => void;
  /** 公開軸すべて（差分バーのラベルの正本）。 */
  axes: readonly CatalogAxis[];
  /** 軸id→色（ルート設定パネルの軸チップと同じ色）。`axes`の全軸を持つ。 */
  axisColors: Record<string, string>;
}

/** 寄与度の差がこれ未満の軸は差分バーへ出さない（1pxの破片が並ぶと読めない）。 */
const MIN_CONTRIBUTION_DELTA = 0.1;
/** 差分バーの下へ数値を書く軸の数。大きい順。 */
const LABELLED_DELTA_COUNT = 2;

/** 元→編集後で寄与度が動いた軸（大きい順）。減った軸は負、増えた軸は正。 */
function contributionDeltas(
  base: Record<string, number>,
  after: Record<string, number>,
  axes: readonly CatalogAxis[],
): AxisDelta[] {
  return axes
    .map((axis) => ({
      axisId: axis.axisId,
      label: axis.label,
      delta: (after[axis.axisId] ?? 0) - (base[axis.axisId] ?? 0),
    }))
    .filter((item) => Math.abs(item.delta) >= MIN_CONTRIBUTION_DELTA)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

export default function RouteSplicePanel({
  displayed,
  appliedCount,
  hasAlternatives,
  onUndo,
  onReset,
  preview,
  sameRouteName,
  previewing,
  onPreview,
  onApply,
  applying,
  error,
  onCancel,
  axes,
  axisColors,
}: RouteSplicePanelProps) {
  // `edge_ids`が空の候補では区間を出せない。
  const unavailable = displayed.edge_ids.length === 0;
  const busy = previewing || applying;
  const deltas = preview ? contributionDeltas(displayed.axis_contributions, preview.axis_contributions, axes) : [];

  return (
    <section
      className={cn(
        cardVariants({ variant: "outline" }),
        "flex flex-col gap-1.5 rounded-lg border-[var(--color-border)] bg-[var(--color-surface-2)]",
      )}
      aria-labelledby="splice-heading"
    >
      {/* 狭いスマホの幅では、右の操作をまとめて次の行の右端へ折り返す。 */}
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5">
        <Button
          usage="区間の乗り換えの編集をやめて、候補へ戻ります。"
          variant="ghost"
          size="bare"
          className="-ml-2 px-0.5 text-[15px]"
          aria-label="編集をやめて候補へ戻る"
          onClick={onCancel}
        >
          ‹
        </Button>
        <h3 className={cn(textVariants({ variant: "heading" }), "font-semibold whitespace-nowrap")} id="splice-heading">
          区間の乗り換え
        </h3>
        {/* 使い方は画面へ書かずここへ置く（設計原則「冗長なものは削る」）。 */}
        {/* 押す所（24px四方）の余りを両脇の間に重ね、デスクトップのパネルの幅に1行で収める。「‹」は余りをカードの余白へ寄せる。 */}
        <InfoPopover triggerAriaLabel="区間の乗り換えの説明" triggerClassName="-mx-1">
          地図の破線が、いまの道から乗り換えられる先です。タップするとそこへ乗り換わり、その先に
          分かれ道があれば次の破線が出ます。太い線が、いま作っているルートです。評価軸の棒は中央が0で、左[−]へ
          伸びた評価軸ほど難易度が下がり、右[＋]へ伸びた評価軸ほど上がっています。
        </InfoPopover>
        {appliedCount > 0 && (
          <span className={cn(textVariants({ variant: "hint" }), "ml-1 whitespace-nowrap")}>{appliedCount}回</span>
        )}
        {!unavailable && (
          <div className="ml-auto flex items-center gap-1.5">
            {appliedCount > 0 && (
              <>
                <Button
                  size="panelIcon"
                  onClick={onUndo}
                  disabled={busy}
                  aria-label="1つ戻す"
                  usage="直前の乗り換えを1つ取り消します。"
                >
                  <UndoIcon size={18} />
                </Button>
                <Button
                  size="panelIcon"
                  onClick={onReset}
                  disabled={busy}
                  aria-label="全部戻す"
                  usage="乗り換えをすべて取り消して、元の候補に戻します。"
                >
                  <UndoAllIcon size={18} />
                </Button>
              </>
            )}
            <Button
              size="panelIcon"
              onClick={onPreview}
              disabled={appliedCount === 0 || busy}
              aria-busy={previewing}
              aria-label="差分を見る"
              usage="いまの乗り換えで、距離・所要時間・難易度が元の候補からどう変わるかを出します。"
            >
              <RouteDiffIcon size={18} />
            </Button>
            {/* 同じ道なら押しても新しく足さずにその候補を選ぶので、作成を出さず、知らせの行の切り替えに替える。 */}
            {sameRouteName === null && (
              <Button
                size="panelIcon"
                onClick={onApply}
                disabled={appliedCount === 0 || busy}
                aria-busy={applying}
                aria-label="新しいルートを作成"
                usage="いまの乗り換えで作ったルートを、合成ルートに加えます。元のルートは残ります。"
              >
                <NewRouteIcon size={18} />
              </Button>
            )}
          </div>
        )}
      </div>

      {unavailable ? (
        <p className={textVariants({ variant: "hint" })}>この候補は通る道の並びを持たないため、区間を出せません。</p>
      ) : (
        <>
          <SpliceMetricGrid displayed={displayed} preview={preview} />

          {/* 軸別は元・編集後の2本を並べず、差だけの1本にする。中央が0で、左が楽になった側。 */}
          {deltas.length > 0 && <SpliceDeltaBar deltas={deltas} axisColors={axisColors} />}

          {sameRouteName !== null && (
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
              <p className={textVariants({ variant: "hint" })}>この組み合わせは「{sameRouteName}」と同じ道です</p>
              <Button
                size="sm"
                onClick={onApply}
                disabled={busy}
                aria-busy={applying}
                usage="編集を閉じて、この組み合わせと同じ道の候補を選びます。"
              >
                「{sameRouteName}」に切り替える
              </Button>
            </div>
          )}

          {error && <ErrorText>{error}</ErrorText>}

          <p className={textVariants({ variant: "hint" })}>
            {deltas.length > 0 ? (
              deltas.slice(0, LABELLED_DELTA_COUNT).map((item) => (
                <span className="mr-2.5" key={item.axisId}>
                  {item.label} {formatDelta(item.delta, DIFFICULTY_DECIMALS)}
                </span>
              ))
            ) : preview ? (
              // 評価済みで棒が空なのは、どの軸の差も棒に出す下限に届かないとき。押す案内を残すと押しても変わらない。
              "どの評価軸も、元とほぼ変わりません"
            ) : appliedCount > 0 ? (
              <GuideText text="「差分を見る」を押すと、乗り換えた結果が出ます" />
            ) : hasAlternatives ? (
              "地図の破線をタップして乗り換えます"
            ) : (
              "他の候補と別の道を通る区間がありません。"
            )}
          </p>
        </>
      )}
    </section>
  );
}
