"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { fetchTimeFrames, type TimeFrame, type TimeFrames } from "@/features/map/regionApi";
import { getQueryClient } from "@/lib/queryClient";

/** コマの一覧を読み直す間隔の上限。予報が届くとレンズのコマの印が変わるので、今のコマが終わる前でもこの間隔で読み直す。 */
const TIME_FRAMES_REFRESH_MS = 5 * 60 * 1000;

/** 出発時刻を含むコマの印。一覧がまだ届いていなければundefined、届いた一覧にその時刻のコマが無ければnull。 */
export type FrameChoice = string | null | undefined;

/** 時刻`at`を含むコマの印（`frames`がまだ無ければundefined、含むコマが無ければnull）。 */
export function frameAt(frames: readonly TimeFrame[] | undefined, at: Date): FrameChoice {
  if (frames === undefined) return undefined;
  const time = at.getTime();
  return frames.find((frame) => Date.parse(frame.start) <= time && time < Date.parse(frame.end))?.key ?? null;
}

/** 今のコマが終わるまでの時間（上限は`TIME_FRAMES_REFRESH_MS`）。終わると一覧の始まりが進む。 */
function untilCurrentFramesEnd(frames: TimeFrames | undefined, now: number): number {
  const ends = [frames?.road_surface, frames?.lens].flatMap((list) =>
    (list ?? []).filter((frame) => Date.parse(frame.start) <= now).map((frame) => Date.parse(frame.end) - now),
  );
  return Math.max(1000, Math.min(TIME_FRAMES_REFRESH_MS, ...ends.filter((ms) => ms > 0)));
}

/**
 * 時刻で変わる値（路面タイル・風に依るレンズと道の窓）のコマの一覧（`GET /api/region/time-frames`）から、出発時刻`at`を含む
 * コマの印を値の種類ごとに選ぶ。要求には時刻そのものではなくこの印を載せ、コマが変わったときだけ取り直す（コマが何で変わるかは
 * backendが決め、画面は知らない）。一覧は今のコマが終わったときと一定の間隔で読み直す。
 */
export function useTimeFrames(at: Date): { roadSurface: FrameChoice; lens: FrameChoice } {
  const { data } = useQuery(
    {
      queryKey: ["time-frames"],
      queryFn: fetchTimeFrames,
      refetchInterval: (query) => untilCurrentFramesEnd(query.state.data, Date.now()),
    },
    getQueryClient(),
  );
  return useMemo(() => ({ roadSurface: frameAt(data?.road_surface, at), lens: frameAt(data?.lens, at) }), [data, at]);
}
