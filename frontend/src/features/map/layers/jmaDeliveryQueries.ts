// 動的気象の配信元の時刻一覧と地物の取得を、表示中のソースから組む部品（取得はTanStack Queryの`useQueries`へ渡す）。
import type { UseQueryResult } from "@tanstack/react-query";
import { jmaFrameKey, jmaFramesOf, type JmaDelivery, type JmaFrame } from "@/features/map/layers/jmaDelivery";
import type { WeatherSource } from "@/features/map/layers/weatherSources";

/** 配信要素ごとの時刻一覧の読み取り結果。 */
export interface DeliveryResult {
  frames: readonly JmaFrame[];
  error: string | null;
}

/** 時刻一覧のファイル1つの取り方。間隔はそのファイルを読む表示中の要素のうち最も更新の速い系統に合わせる（遅い系統を
 * 早めに取り直すぶんには古い表示にならない）。失敗の文言に載る呼び名は最初に読む要素のもの（同じURLの同じ失敗を指す）。 */
export interface TargetTimesFile {
  path: string;
  label: string;
  refreshIntervalMs: number;
}

/** ファイルの読み取りの状態。行も失敗も無ければ、まだ一度も届いていない。取り直しに失敗している間は、前に届いた行を
 * 使わずに失敗として数える（時刻一覧は数分で更新され、古い一覧のコマは表示時刻から外れていく）。 */
export interface FileState {
  rows: readonly unknown[] | undefined;
  error: string | undefined;
}

const PENDING_FILE: FileState = { rows: undefined, error: undefined };

export function fileStatesOf(results: readonly UseQueryResult<unknown[]>[]): FileState[] {
  return results.map((result) => ({
    rows: result.status === "success" ? result.data : undefined,
    error: result.status === "error" ? result.error.message : undefined,
  }));
}

/** 地物の取得1つの状態。取れなかった地物は描かず、その失敗はチップの状態に数える（描かないだけにすると、落雷の
 * 地点が無いことと取れていないことを見分けられない）。 */
export interface GeojsonState {
  geojson: GeoJSON.FeatureCollection | undefined;
  pending: boolean;
  error: string | undefined;
}

export function geojsonStatesOf(results: readonly UseQueryResult<GeoJSON.FeatureCollection>[]): GeojsonState[] {
  return results.map((result) => ({
    geojson: result.data,
    pending: result.status === "pending",
    error: result.status === "error" ? result.error.message : undefined,
  }));
}

export function targetTimesFilesOf(deliveries: readonly { delivery: JmaDelivery; label: string }[]): TargetTimesFile[] {
  const byPath = new Map<string, TargetTimesFile>();
  for (const { delivery, label } of deliveries) {
    for (const path of delivery.targetTimesPaths) {
      const known = byPath.get(path);
      byPath.set(path, {
        path,
        label: known?.label ?? label,
        refreshIntervalMs: Math.min(known?.refreshIntervalMs ?? Infinity, delivery.refreshIntervalMs),
      });
    }
  }
  return [...byPath.values()];
}

/** ソースが読む配信要素（重複なし）と、取得の失敗を記録するときの呼び名（最初に読むソースの名前）。 */
export function deliveriesOf(sources: readonly WeatherSource[]): { delivery: JmaDelivery; label: string }[] {
  const byId = new Map<string, { delivery: JmaDelivery; label: string }>();
  for (const source of sources) {
    for (const stage of source.stages) {
      if (stage.origin === "jma" && !byId.has(stage.delivery.id)) {
        byId.set(stage.delivery.id, { delivery: stage.delivery, label: source.label });
      }
    }
  }
  return [...byId.values()];
}

/** 配信元の段の、選んだコマの地物を取る鍵（要素配下のURLと同じく、配信要素と時刻で決まる）。 */
export function geojsonKey(delivery: JmaDelivery, frame: JmaFrame): string {
  return `${delivery.id}/${jmaFrameKey(frame)}`;
}

/** 配信要素ごとの時刻一覧。読み込み中の配信要素（どれかのファイルがまだ一度も届いていない）は結果を持たない。 */
export function deliveryResultsOf(
  files: readonly TargetTimesFile[],
  fileStates: readonly FileState[],
  deliveries: readonly { delivery: JmaDelivery; label: string }[],
): Map<string, DeliveryResult> {
  const byPath = new Map(files.map((file, index) => [file.path, fileStates[index]]));
  const results = new Map<string, DeliveryResult>();
  for (const { delivery, label } of deliveries) {
    const states = delivery.targetTimesPaths.map((path) => byPath.get(path) ?? PENDING_FILE);
    if (states.some((state) => state.rows === undefined && state.error === undefined)) continue;
    // 一部のファイルだけ取れなくても残りで部分的な時系列を作り、全部取れなかったときだけ最初の失敗を出す。
    const loaded = states.filter((state) => state.rows !== undefined);
    results.set(
      delivery.id,
      loaded.length > 0
        ? {
            frames: jmaFramesOf(
              delivery,
              loaded.flatMap((state) => state.rows!),
            ),
            error: null,
          }
        : { frames: [], error: states.find((state) => state.error)?.error ?? `${label}の時刻一覧が宣言されていない` },
    );
  }
  return results;
}
