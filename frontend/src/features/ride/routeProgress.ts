// 現在地を、ルートの上のどこ（始点からの距離）と見るか。
//
// 最も近い点を取るが、往復のように同じ道を2度通るルートでは、行きと帰りのどちらの点もほぼ同じ近さになる。そこで
// 最も近い点と余裕の内で並ぶ点のうち、前の位置から続くものを選ぶ。折り返しの近くでは行きと帰りの点が前の位置から
// 同じだけ離れるので、後ろへ戻る側の隔たりを重く数えて、前へ進んだ側を取る。

import type { TrackProjection } from "@/lib/routeDistance";

/**
 * 最も近い点からの隔たりの差がこれより小さい点は、同じ近さとして前の位置から続く側を選ぶ（m）。端末の位置の誤差と、
 * 往復で上下線を分けて走る道の行きと帰りの間隔より大きくする。大きくするほど、別の所を通る点まで続く側の候補に残り、
 * ルートを外れて別の所へ移ったときに最も近い点へ移るのが遅れる。
 */
export const ROUTE_MATCH_SLACK_M = 30;

// 隣の辺との隔たりの差がこれより小さければ同じ近さと見る（m）。往復の折り返しでは行きと帰りの辺が隣り合い、同じ形でも
// 計算の端数だけ隔たりが違うので、差を見ずに比べると片側が谷から落ちる。
const SAME_OFFSET_M = 0.01;

// 前の位置から後ろへ戻る点の隔たりを、前へ進む点の何倍に数えるか。1より大きければよい。
const BACKWARD_WEIGHT = 2;

/**
 * 現在地の、ルートの上の距離（km）。`projected`は現在地をルートの辺へ射影したもの（`projectOnTrack`）。`previousKm`は
 * 前に見た位置で、無ければ始点に近い側を選ぶ。ルートの形が無ければnull。
 */
export function locateOnRoute(projected: readonly TrackProjection[], previousKm: number | null): number | null {
  if (projected.length === 0) return null;
  const nearest = Math.min(...projected.map(({ offsetM }) => offsetM));
  const reference = previousKm ?? 0;
  // ルートに沿って近づいて離れる谷（前後の辺より近い辺）のうち、最も近い点と余裕の内で並ぶものから選ぶ。
  const cost = (km: number) => (km >= reference ? km - reference : (reference - km) * BACKWARD_WEIGHT);
  let best: number | null = null;
  projected.forEach(({ km, offsetM }, i) => {
    if (offsetM > nearest + ROUTE_MATCH_SLACK_M) return;
    const neighbors = [projected[i - 1], projected[i + 1]];
    if (neighbors.some((neighbor) => neighbor !== undefined && offsetM > neighbor.offsetM + SAME_OFFSET_M)) return;
    if (best === null || cost(km) < cost(best)) best = km;
  });
  return best;
}

/**
 * 現在地が、ルートから外れているか。`projected`は現在地をルートの辺へ射影したもの（`projectOnTrack`）。端末が位置と一緒に返す誤差`accuracyM`（m）を超えてルートから離れていれば
 * 外れている。誤差は測った位置がどれだけ確かかという端末の事実で、外れの境目をこちらで決めた数字にしない。誤差が
 * 分からなければ、外れていないとみなす。
 */
export function offRoute(projected: readonly TrackProjection[], accuracyM: number | null): boolean {
  if (accuracyM === null || projected.length === 0) return false;
  return Math.min(...projected.map(({ offsetM }) => offsetM)) > accuracyM;
}
