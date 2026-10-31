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

/** 点`p`と線分`a`-`b`の距離の二乗（m²）。`a`と`b`が同じ点なら点どうしの距離の二乗。 */
function squaredDistanceToSegment(p: PlanePoint, a: PlanePoint, b: PlanePoint): number {
  const closest = closestPointOnSegment(p, a, b);
  const dx = p.x - closest.x;
  const dy = p.y - closest.y;
  return dx * dx + dy * dy;
}

/** Ramer–Douglas–Peucker。両端を結んだ線分から許容より離れる点を残し、その点で区間を割って同じ判定を
 * 繰り返す。残った点だけを結べば元の折れ線との差は許容以内に収まる。区間で最も遠い点は許容によらないため、
 * `minToleranceM`で1回だけ割り、点ごとに「許容がこの値（m）未満なら残る」値を返す（両端は`Infinity`、
 * `minToleranceM`でも落ちる点は0）。値は自分の距離と、自分の区間を作った点の値の小さいほう（その点が
 * 落ちる許容では区間ごと割られない）。深い再帰を避けるため明示的なスタックで回す。 */
function keepingTolerances(points: readonly PlanePoint[], minToleranceM: number): number[] {
  const tolerances = new Array<number>(points.length).fill(0);
  tolerances[0] = Infinity;
  tolerances[points.length - 1] = Infinity;
  // [区間の始め, 区間の終わり, 区間を作った点の値]
  const pending: Array<[number, number, number]> = [[0, points.length - 1, Infinity]];
  while (pending.length > 0) {
    const [first, last, parentTolerance] = pending.pop()!;
    let farthest = -1;
    let maxSquaredDistance = minToleranceM * minToleranceM;
    for (let i = first + 1; i < last; i += 1) {
      const squaredDistance = squaredDistanceToSegment(points[i], points[first], points[last]);
      if (squaredDistance > maxSquaredDistance) {
        maxSquaredDistance = squaredDistance;
        farthest = i;
      }
    }
    if (farthest < 0) continue;
    const tolerance = Math.min(Math.sqrt(maxSquaredDistance), parentTolerance);
    tolerances[farthest] = tolerance;
    pending.push([first, farthest, tolerance], [farthest, last, tolerance]);
  }
  return tolerances;
}

/** 座標列を`MAX_GPX_TRACK_POINTS`以下へ間引く。残す点は折れ線の形から選ぶ（両端を結んだ線分からのずれが
 * 大きい点を残す）ため、残る点の間隔より短い区間に収まった曲がりも直線へ潰れない。
 * `MAX_GPX_TRACK_POINTS`以下ならそのまま返す。 */
function simplifyCoordinates(coordinates: readonly GeoJSON.Position[]): GeoJSON.Position[] {
  if (coordinates.length <= MAX_GPX_TRACK_POINTS) return [...coordinates];
  const tolerances = keepingTolerances(toLocalPlane(coordinates), SIMPLIFY_TOLERANCE_M);
  // 両端は常に残るため、許容するずれを増やし続ければ2点まで減らせる（＝必ず収まる）。
  for (let tolerance = SIMPLIFY_TOLERANCE_M; ; tolerance *= 2) {
    const kept = tolerances.map((keptBelow) => keptBelow > tolerance);
    if (kept.filter(Boolean).length <= MAX_GPX_TRACK_POINTS) return coordinates.filter((_, index) => kept[index]);
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

/** ブラウザへGPXファイルのダウンロードを発火する。 */
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
