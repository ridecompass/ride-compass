"use client";

import { useMemo } from "react";
import { lensTileUrl, type LensTileQuery, type RideConditions } from "@/features/map/regionApi";
import { MAP_FETCH_DEBOUNCE_MS, useDebouncedValue } from "@/hooks/useDebouncedValue";
import { lensPreferenceQuery } from "@/lib/costPreference";
import type { MapLens } from "@/lib/mapDisplay/mapLens";
import type { CostPreference } from "@/types/route";

/** レンズ`lens`のタイルのURL。要求へ載せる走る条件は、レンズが宣言した名前（`materialConditions`。出発時刻のコマの印と想定速度）
 * だけ——宣言に無い条件は、変えても値が変わらないので載せない（変えてもタイルを取り直さない）。利用者の値`preference`（生成の
 * 要求と同じつまみと倍率）も載せ、総合のレンズ`totalLensId`だけが全部の軸の倍率を載せる。時刻に依るレンズは、コマの一覧が届くまで
 * undefined、届いた一覧に出発の時刻のコマが無ければ（予報の範囲の外）null。 */
export function lensTileUrlOf(
  lens: MapLens,
  conditions: Pick<RideConditions, "lensFrame" | "speedKmh">,
  preference: CostPreference,
  totalLensId: string | null,
): string | null | undefined {
  const names = lens.materialConditions;
  const frame = names.includes("at") ? conditions.lensFrame : "";
  if (frame === undefined || frame === null) return frame;
  const query: LensTileQuery = {
    ...(frame ? { frame } : {}),
    ...(names.includes("speed_kmh") ? { speed_kmh: conditions.speedKmh } : {}),
    ...lensPreferenceQuery(preference, lens.lensId, lens.lensId === totalLensId),
  };
  return lensTileUrl(lens.lensId, query);
}

/** 塗っているレンズ`lens`（塗っていなければundefined）のタイルのURL（`lensTileUrlOf`）。条件と利用者の値は、続けて変えても
 * 変えるたびに見えている全部のタイルを取り直さないよう、少し待ってから載せる（利用者の値は中身で比べる——送る形は描くたびに作り直される）。 */
export function useLensTileUrl(
  lens: MapLens | undefined,
  conditions: Pick<RideConditions, "lensFrame" | "speedKmh">,
  preference: CostPreference,
  totalLensId: string | null,
): string | null | undefined {
  const frame = useDebouncedValue(conditions.lensFrame, MAP_FETCH_DEBOUNCE_MS);
  const speedKmh = useDebouncedValue(conditions.speedKmh, MAP_FETCH_DEBOUNCE_MS);
  const preferenceKey = useDebouncedValue(JSON.stringify(preference), MAP_FETCH_DEBOUNCE_MS);
  return useMemo(
    () =>
      lens &&
      lensTileUrlOf(lens, { lensFrame: frame, speedKmh }, JSON.parse(preferenceKey) as CostPreference, totalLensId),
    [lens, frame, speedKmh, preferenceKey, totalLensId],
  );
}
