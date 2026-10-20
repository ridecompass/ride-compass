"use client";

import { useState } from "react";

import { Button } from "@/components/ui/Button/Button";
import { ConfirmDialog } from "@/components/ui/Dialog/Dialog";
import { ClearRoutesIcon } from "@/components/ui/icons/lucideIcons";
import RouteCandidateActions from "@/features/route/RouteCandidateActions/RouteCandidateActions";
import type { useRoutePlanner } from "@/features/route/useRoutePlanner";

interface RouteOutcomeHeaderActionsProps {
  planner: Pick<ReturnType<typeof useRoutePlanner>, "results" | "splice" | "clear">;
  /** 「このルートで走る」を押した。無ければボタンを出さない（もう走っている間）。 */
  onRide?: (routeId: string) => void;
}

/**
 * 「ルート結果」の見出しの操作。選んでいる候補1本への操作（走る・合成・GPX）を、候補すべてに効く全消去の手前に並べる
 * （中身の中に置くと、狭い高さで候補の切り替えとグラフの場所を取る）。候補1本への操作は、編集の間は出さない（中身が編集面に
 * なり、相手の候補が選べない）。候補がある間だけ描く。
 */
export default function RouteOutcomeHeaderActions({ planner, onRide }: RouteOutcomeHeaderActionsProps) {
  const { results, splice } = planner;
  // 「候補を全消去」を押したか。確認の窓で「消す」を押すまで消さない。
  const [confirmingClear, setConfirmingClear] = useState(false);
  const target = results.selectedCandidate ?? results.routes[0];
  return (
    <>
      {!splice.panel && target && (
        <RouteCandidateActions
          route={target}
          splice={splice}
          onClearSegment={() => results.selectSegment(null)}
          onRide={onRide}
        />
      )}
      <Button
        size="panelIcon"
        onClick={() => setConfirmingClear(true)}
        aria-label="候補を全消去"
        aria-haspopup="dialog"
        aria-expanded={confirmingClear}
        usage="作った候補をすべて消します。地図に置いた地点は残ります。"
      >
        <ClearRoutesIcon size={18} />
      </Button>
      <ConfirmDialog
        open={confirmingClear}
        title="候補をすべて消します"
        confirmLabel="消す"
        onCancel={() => setConfirmingClear(false)}
        onConfirm={() => {
          setConfirmingClear(false);
          planner.clear();
        }}
      >
        消した候補は元に戻せません。地図に置いた地点は残ります。
      </ConfirmDialog>
    </>
  );
}
