"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { sidePointGroups, type SidePointGroup } from "@/features/route/SegmentSidePoints/sidePointGroups";
import { getRouteSidePoints } from "@/features/route/routeApi";
import { getQueryClient } from "@/lib/queryClient";
import { findSameSegment } from "@/lib/routeDistance";
import type { RouteCandidate, RoutePoint, SelectedRouteSegment } from "@/types/route";

/** 選んだ区間の近くの点の引き具合。まだ探していなければ探す口を持ち、引けたら、地図に描ける点を種類ごとに持ち、利用者が
 * 地図から消した種類を持つ。 */
export type SegmentSidePoints =
  | { status: "idle"; onSearch: () => void }
  | { status: "loading" }
  | { status: "failed" }
  | {
      status: "done";
      groups: readonly SidePointGroup[];
      /** 地図から消した種類のid。 */
      hidden: ReadonlySet<string>;
      onToggle: (groupId: string) => void;
      /** 地図に出す点（消した種類を除いたもの）。 */
      shown: readonly RoutePoint[];
    };

const NOTHING_HIDDEN: ReadonlySet<string> = new Set();

/** 選んだ区間の近くの点を、探す口（`onSearch`）を呼んだときだけ引く（要らないときは地図に印も出さず、要求も送らない）。
 * 最後に探した区間を覚え、同じ区間の中で地点を選び直しても引いた点を出し続ける。区間は候補の区間から引き直す（地図で
 * 押した区間は鍵の範囲を持たない写し）。区間を選んでいない・候補に無い区間ならnull。区間を選び直すたびに、消した種類を
 * 全部出し直す。 */
export function useSegmentSidePoints(
  candidate: RouteCandidate | null,
  selection: SelectedRouteSegment | null,
): SegmentSidePoints | null {
  const segment =
    candidate === null || selection === null
      ? undefined
      : findSameSegment(candidate.segments, selection.segment, (item) => item);
  const edgeIds =
    candidate === null || segment === undefined ? [] : candidate.edge_ids.slice(segment.edge_start, segment.edge_end);
  const startKm = segment?.cumulative_distance_km ?? 0;
  const segmentKey = `${edgeIds.join(",")}@${startKm}`;
  const [searchedKey, setSearchedKey] = useState<string | null>(null);
  const searched = edgeIds.length > 0 && searchedKey === segmentKey;
  const onSearch = useCallback(() => setSearchedKey(segmentKey), [segmentKey]);
  const query = useQuery(
    {
      queryKey: ["route-side-points", edgeIds.join(","), startKm],
      queryFn: () => getRouteSidePoints(edgeIds, startKm),
      enabled: searched,
      // 同じ区間の点は画面を開いている間は変わらないので、選び直しても引き直さない。
      staleTime: Infinity,
      gcTime: Infinity,
    },
    getQueryClient(),
  );
  const [hiding, setHiding] = useState({ selection, hidden: NOTHING_HIDDEN });
  const hidden = hiding.selection === selection ? hiding.hidden : NOTHING_HIDDEN;
  const onToggle = useCallback(
    (groupId: string) =>
      setHiding((current) => {
        const next = new Set(current.selection === selection ? current.hidden : NOTHING_HIDDEN);
        if (!next.delete(groupId)) next.add(groupId);
        return { selection, hidden: next };
      }),
    [selection],
  );
  const groups = useMemo(() => (query.data === undefined ? [] : sidePointGroups(query.data)), [query.data]);
  const shown = useMemo(
    () => groups.filter((group) => !hidden.has(group.id)).flatMap((group) => group.points),
    [groups, hidden],
  );
  if (edgeIds.length === 0) return null;
  if (!searched) return { status: "idle", onSearch };
  if (query.isError) return { status: "failed" };
  if (query.data === undefined) return { status: "loading" };
  return { status: "done", groups, hidden, onToggle, shown };
}
