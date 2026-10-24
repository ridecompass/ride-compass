"use client";

import { useCallback, useMemo, useState } from "react";

import { sidePointGroups, type SidePointGroup } from "@/features/route/SegmentSidePoints/sidePointGroups";
import { sidePointAlong, type SidePointOnMap } from "@/lib/mapDisplay/sidePoints";
import { findSameSegment } from "@/lib/routeDistance";
import type { RouteCandidate, SelectedRouteSegment } from "@/types/route";

/** 選んだ区間の近くの施設。地図が読み込んだ点のタイルから組み、種類・区分ごとに持ち、利用者が地図から消した区分を持つ。 */
export type SegmentSidePoints = {
  /** 点のタイルを読まないズームのとき・地図がまだ読んでいないときはnull。 */
  groups: readonly SidePointGroup[] | null;
  /** 地図から消した区分のid（`SidePointKind`の`id`）。 */
  hidden: ReadonlySet<string>;
  onToggle: (kindId: string) => void;
  /** 押した地点を区間の道なりに当てた道のり（km。施設の`km`と同じ、候補の始点からの道のり）。 */
  pickedKm: number;
};

const NOTHING_HIDDEN: ReadonlySet<string> = new Set();

/** 選んだ区間の近くの施設と、地図が読んだ点を受ける口（`onSidePointsChange`）。区間は候補の区間から引き直す（地図で押した区間は
 * 形を持たない写し）。区間を選んでいない・候補に無い区間なら`sidePoints`はnull。区間を選び直すたびに、消した区分を全部出し直す。 */
export function useSegmentSidePoints(candidate: RouteCandidate | null, selection: SelectedRouteSegment | null) {
  const section =
    candidate === null || selection === null
      ? undefined
      : findSameSegment(candidate.segments, selection.segment, (item) => item);
  // 地図が読んだ点は、読んだときの区間と組で持つ（別の区間を選んだ直後に前の区間の点を出さない）。地図は区間の線が変わったときだけ
  // 読み直すので、同じ区間を押し直したときは前に読んだ点を使う。
  const [onMap, setOnMap] = useState<{ section: typeof section; points: readonly SidePointOnMap[] | null }>({
    section: undefined,
    points: null,
  });
  const onSidePointsChange = useCallback(
    (points: readonly SidePointOnMap[] | null) => setOnMap({ section, points }),
    [section],
  );
  const [hiding, setHiding] = useState({ selection, hidden: NOTHING_HIDDEN });
  const hidden = hiding.selection === selection ? hiding.hidden : NOTHING_HIDDEN;
  const onToggle = useCallback(
    (kindId: string) =>
      setHiding((current) => {
        const next = new Set(current.selection === selection ? current.hidden : NOTHING_HIDDEN);
        if (!next.delete(kindId)) next.add(kindId);
        return { selection, hidden: next };
      }),
    [selection],
  );
  const points = onMap.section === section ? onMap.points : null;
  const groups = useMemo(
    () => (points === null || section === undefined ? null : sidePointGroups(points, section)),
    [points, section],
  );
  const sidePoints: SegmentSidePoints | null =
    section === undefined || selection === null
      ? null
      : {
          groups,
          hidden,
          onToggle,
          pickedKm: sidePointAlong(section, [selection.longitude, selection.latitude]).km,
        };
  return { sidePoints, onSidePointsChange };
}
