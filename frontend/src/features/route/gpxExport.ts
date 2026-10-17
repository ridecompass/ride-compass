import { METERS_PER_DEGREE, closestPointOnSegment, longitudeScale, type PlanePoint } from "@/lib/localPlane";
import type { RouteCandidate } from "@/types/route";

// Suuntoアプリは1000点を超えるGPXの取り込みで問題が起きることがある
// （長い周回・目的地ルートのOSM道なり形状は数千点になりうる）。GarminはGarmin Connect側で
// 取り込み時に自動間引きするため直接の上限は無いが、経路の視覚的な形状はある程度の間引きで
// 実用上損なわれない密度（数十m間隔）を持つため、両方に安全な同じ閾値で揃える。
export const MAX_GPX_TRACK_POINTS = 1000;

// 間引きで元の折れ線からずれてよい距離（m）。読み込んだ側のナビが描く線として、この程度の
// ずれは道の形として見分けられない。上限点数に収まらない場合はこの値を倍にして数え直す。
const SIMPLIFY_TOLERANCE_M = 3;

/** 緯度経度を、座標列の中央緯度を基準にした局所平面（m）へ落とす。緯度経度のまま測ると、東西の曲がりだけが残りやすくなる。 */
function toLocalPlane(coordinates: readonly GeoJSON.Position[]): PlanePoint[] {
  const lonScale = longitudeScale(coordinates[Math.floor(coordinates.length / 2)][1]);
  return coordinates.map(([lon, lat]) => ({
    x: lon * METERS_PER_DEGREE * lonScale,
    y: lat * METERS_PER_DEGREE,
  }));
}

/** 点`p`と線分`a`-`b`の距離の二乗（m²）。`a`と`b`が同じ点なら点どうしの距離の二乗。区間の点ごとに呼ぶので、重い
 * `Math.hypot`を通さず二乗で比べる。 */
function squaredDistanceToSegment(p: PlanePoint, a: PlanePoint, b: PlanePoint): number {
  const closest = closestPointOnSegment(p, a, b);
  const dx = p.x - closest.x;
  const dy = p.y - closest.y;
  return dx * dx + dy * dy;
}

/** Ramer–Douglas–Peucker。両端を結んだ線分から最も離れる点で区間を割り、同じ判定を繰り返す。点ごとに、許容するずれが
 * いくつ未満ならその点が残るか（m）を返す: 割った点は自分のずれと、自分を割り出した点の値の小さいほう、両端は`Infinity`、
 * `minToleranceM`以下のずれしか無い区間の中の点は0。区間を割る点は許容によらず、許容は割るかどうかだけを決めるので、
 * 許容`t`（`minToleranceM`以上）のRDPが残す点は、この値が`t`より大きい点に一致し、それらを結べば元の折れ線との差は
 * `t`以内に収まる。許容ごとに割り直すと、細かく揺れる区間では1回ごとに点数の2乗の距離計算になるため、1回だけ割る。
 * 深い再帰を避けるため明示的なスタックで回す。 */
function toleranceKeepingEachPoint(points: readonly PlanePoint[], minToleranceM: number): number[] {
  const keptBelow = new Array<number>(points.length).fill(0);
  keptBelow[0] = Infinity;
  keptBelow[points.length - 1] = Infinity;
  const pending: Array<[number, number, number]> = [[0, points.length - 1, Infinity]];
  while (pending.length > 0) {
    const [first, last, parentKeptBelow] = pending.pop()!;
    let farthest = -1;
    let maxSquared = minToleranceM * minToleranceM;
    for (let i = first + 1; i < last; i += 1) {
      const squared = squaredDistanceToSegment(points[i], points[first], points[last]);
      if (squared > maxSquared) {
        maxSquared = squared;
        farthest = i;
      }
    }
    if (farthest < 0) continue;
    keptBelow[farthest] = Math.min(Math.sqrt(maxSquared), parentKeptBelow);
    pending.push([first, farthest, keptBelow[farthest]], [farthest, last, keptBelow[farthest]]);
  }
  return keptBelow;
}

/** 座標列を`MAX_GPX_TRACK_POINTS`以下へ間引く。残す点は折れ線の形から選ぶ（両端を結んだ線分からのずれが
 * 大きい点を残す）ため、残る点の間隔より短い区間に収まった曲がりも直線へ潰れない。
 * `MAX_GPX_TRACK_POINTS`以下ならそのまま返す。 */
function simplifyCoordinates(coordinates: readonly GeoJSON.Position[]): GeoJSON.Position[] {
  if (coordinates.length <= MAX_GPX_TRACK_POINTS) return [...coordinates];
  const keptBelow = toleranceKeepingEachPoint(toLocalPlane(coordinates), SIMPLIFY_TOLERANCE_M);
  // 両端は常に残るため、許容するずれを増やし続ければ2点まで減らせる（＝必ず収まる）。
  for (let tolerance = SIMPLIFY_TOLERANCE_M; ; tolerance *= 2) {
    if (keptBelow.filter((value) => value > tolerance).length <= MAX_GPX_TRACK_POINTS) {
      return coordinates.filter((_, index) => keptBelow[index] > tolerance);
    }
  }
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Garminは`<rte>`（ルート点）を「コース」としてのみ取り込め、`<trk>`（トラック点）は
 * 「コース」「アクティビティ」の両方に取り込める。Suuntoアプリは`<trk>`以外
 * （`<rte>`・単独の`<wpt>`）を取り込めない。両対応のため`<trk>`固定にする。標高・時刻は
 * RouteCandidateが点単位で持たないため含めない（候補全体の集約値のみ）。 */
function buildGpxDocument(candidate: RouteCandidate): string {
  const coordinates = simplifyCoordinates(candidate.geometry.coordinates);
  const name = escapeXmlText(`RideCompass ${candidate.direction_label} ${candidate.distance_km.toFixed(1)}km`);
  const trackPoints = coordinates.map(([lon, lat]) => `      <trkpt lat="${lat}" lon="${lon}"/>`).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="RideCompass" xmlns="http://www.topografix.com/GPX/1/1">',
    "  <trk>",
    `    <name>${name}</name>`,
    "    <trkseg>",
    trackPoints,
    "    </trkseg>",
    "  </trk>",
    "</gpx>",
    "",
  ].join("\n");
}

/** ブラウザへGPXファイルのダウンロードを発火する（Blob + Object URL、リポジトリ初のクライアント
 * サイドファイルダウンロード）。 */
export function downloadGpx(candidate: RouteCandidate): void {
  const xml = buildGpxDocument(candidate);
  const blob = new Blob([xml], { type: "application/gpx+xml" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `ridecompass-${candidate.id}.gpx`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
