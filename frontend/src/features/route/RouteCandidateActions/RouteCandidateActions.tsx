"use client";

import { Button } from "@/components/ui/Button/Button";
import { RouteSpliceIcon } from "@/components/ui/icons/icons";
import { DownloadIcon, RideModeIcon } from "@/components/ui/icons/lucideIcons";
import { downloadGpx, MAX_GPX_TRACK_POINTS } from "@/features/route/gpxExport";
import type { SpliceSessionView } from "@/features/route/useSpliceSession";
import type { RouteCandidate } from "@/types/route";

interface RouteCandidateActionsProps {
  /** 操作の相手（「ルート結果」で選んでいる候補）。 */
  route: RouteCandidate;
  splice: Pick<SpliceSessionView, "canStart" | "start">;
  /** 地図で押した区間の選択を外す。 */
  onClearSegment: () => void;
  /** 「このルートで走る」を押した（その候補で走行モードを始める）。無ければボタンを出さない（もう走っている間）。 */
  onRide?: (routeId: string) => void;
}

/** 選んでいる候補1本への操作（走る・合成・GPX出力）。「ルート結果」の見出しの行に、全消去の手前に並べる。 */
export default function RouteCandidateActions({ route, splice, onClearSegment, onRide }: RouteCandidateActionsProps) {
  return (
    <div className="flex items-center gap-1.5">
      {onRide && (
        <Button
          variant="primary"
          size="panelIcon"
          onClick={() => onRide(route.id)}
          aria-label="このルートで走る"
          usage="選んでいる候補で走行モードを始め、現在地を追って地図を動かし続けます。地図の右の走行モードのボタンでも始められます。"
        >
          <RideModeIcon size={18} />
        </Button>
      )}
      {/* 合成（区間の乗り換え）の入口。乗り換える相手が無い（候補1件）間は出さない。 */}
      {splice.canStart && (
        <Button
          size="panelIcon"
          onClick={() => {
            splice.start(route.id);
            // 区間の詳細の置き場は編集面に置き換わるため、選択を外す（地図に印だけが残らない）。
            onClearSegment();
          }}
          aria-label="ルートを合成"
          usage="選んでいる候補の一部の区間を、ほかの候補が通る道へ乗り換えて新しいルートを作ります。押すと、乗り換えられる道が地図に破線で出ます。"
        >
          <RouteSpliceIcon size={18} />
        </Button>
      )}
      <Button
        size="panelIcon"
        onClick={() => downloadGpx(route)}
        aria-label="GPX出力"
        usage={`選んでいる候補をGPXファイルで書き出します。サイクルコンピューターやほかの地図アプリに読み込めます。点の数は${MAX_GPX_TRACK_POINTS}点に収まるように間引きます。`}
      >
        <DownloadIcon size={18} />
      </Button>
    </div>
  );
}
