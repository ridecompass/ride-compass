"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { fetchTimeFrames, type TimeFrame, type TimeFrames } from "@/features/map/regionApi";
import { ApiHttpError } from "@/lib/apiClient";
import { getQueryClient } from "@/lib/queryClient";

const TIME_FRAMES_QUERY_KEY = ["time-frames"];
/** backend が古い印（終わったコマ・版の変わる前のコマ）を断るときの HTTP の状態。 */
const STALE_FRAME_STATUS = 409;

/** コマの一覧を読み直す間隔の上限。予報が届くとレンズのコマの印が変わるので、今のコマが終わる前でもこの間隔で読み直す。 */
const TIME_FRAMES_REFRESH_MS = 5 * 60 * 1000;

/** 出発時刻を含むコマの印。一覧がまだ届いていなければundefined、届いた一覧にその時刻のコマが無ければnull。 */
export type FrameChoice = string | null | undefined;

/** 時刻`at`を含むコマ（`frames`がまだ無ければundefined、含むコマが無ければnull）。 */
function frameContaining<F extends TimeFrame>(frames: readonly F[] | undefined, at: Date): F | null | undefined {
  if (frames === undefined) return undefined;
  const time = at.getTime();
  return frames.find((frame) => Date.parse(frame.start) <= time && time < Date.parse(frame.end)) ?? null;
}

/** 時刻`at`を含むコマの印（`frames`がまだ無ければundefined、含むコマが無ければnull）。 */
export function frameAt(frames: readonly TimeFrame[] | undefined, at: Date): FrameChoice {
  const frame = frameContaining(frames, at);
  return frame === undefined || frame === null ? frame : frame.key;
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
export function useTimeFrames(at: Date): {
  roadSurface: FrameChoice;
  lens: FrameChoice;
  /** レンズのコマの風が前に出た予報のものなら、その最新のrunの終わり（`wind_previous_run_from`）。 */
  lensWindPreviousRunFrom: string | null;
} {
  const { data } = useQuery(
    {
      queryKey: TIME_FRAMES_QUERY_KEY,
      queryFn: fetchTimeFrames,
      refetchInterval: (query) => untilCurrentFramesEnd(query.state.data, Date.now()),
    },
    getQueryClient(),
  );
  return useMemo(
    () => ({
      roadSurface: frameAt(data?.road_surface, at),
      lens: frameAt(data?.lens, at),
      lensWindPreviousRunFrom: frameContaining(data?.lens, at)?.wind_previous_run_from ?? null,
    }),
    [data, at],
  );
}

/** コマの一覧を読み直す（古い印で断られたとき。読み直した一覧の新しい印で、載せた要求が取り直す）。 */
function refreshTimeFrames(): void {
  void getQueryClient().invalidateQueries({ queryKey: TIME_FRAMES_QUERY_KEY });
}

/** HTTP の状態`status`が古い印で断られたものなら、コマの一覧を読み直す。 */
export function refreshTimeFramesIfStale(status: number | undefined): void {
  if (status === STALE_FRAME_STATUS) refreshTimeFrames();
}

/** `request`が古い印で断られたら、コマの一覧を読み直してから失敗を返す。 */
export async function withFreshFrames<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (error) {
    refreshTimeFramesIfStale(error instanceof ApiHttpError ? error.status : undefined);
    throw error;
  }
}
