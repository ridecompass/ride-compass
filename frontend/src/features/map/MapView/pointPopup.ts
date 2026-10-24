// 点（事故・POI・立ち寄り先）と地点のピンを押したときのポップアップの本文。
// 値はOSMタグ由来で第三者が編集できるため、HTML文字列を経由せずテキストノードで組む
// （`Popup.setHTML()`はサニタイズしない）。
import { pointCategoryOf, pointPlaceName, type PointAxis } from "@/lib/mapDisplay/pointLayers";
import { pinMarkName } from "@/components/PinMark/PinMark";
import type { PointTarget } from "@/types/route";

// 行間はサイドバーの他のカードに近い密度に合わせる。
const POPUP_BODY_STYLE = "font-size:var(--font-size-md); line-height:1.4;";

function popupBody(lines: readonly string[]): HTMLDivElement {
  const body = document.createElement("div");
  body.style.cssText = POPUP_BODY_STYLE;
  lines.forEach((line, i) => {
    if (i > 0) body.appendChild(document.createElement("br"));
    body.appendChild(document.createTextNode(line));
  });
  return body;
}

/** 名前と位置で地点を探す外の地図（Google マップの検索。公式の文書「Maps URLs」の`search`）。位置を添えるのは、
 * 名前だけでは見ている人の今いる所の近くで探すため。 */
function externalMapSearchUrl(name: string, lngLat: { lng: number; lat: number }): string {
  const query = `${name} ${lngLat.lat.toFixed(6)},${lngLat.lng.toFixed(6)}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

type PointPopupLayer = {
  label: string;
  display_axes: readonly PointAxis[];
  point_facts: readonly { property: string; label: string }[];
  point_name_property: string | null;
};

/** 区分の名前を軸の並びで「・」でつなぐ。引けない値は「不明」。 */
function categoryNames(layer: PointPopupLayer, properties: Record<string, unknown>): string {
  return layer.display_axes.map((axis) => pointCategoryOf(axis, properties)?.label ?? "不明").join(" ・ ");
}

/** 名前のある点（`point_name_property`の値がある）は、1行目に名前を出し、最後に名前と位置で外の地図を開く導線を添える
 * ——閉店にデータが追いついていないことがあるので、営業を外で確かめられるようにする。続く行は「<点の名前>: <区分の名前>」
 * （区分の軸が複数なら「・」で並べる）。区分の名前は凡例と同じ宣言から引き、引けない値は「不明」にする（値は分類器が付ける
 * 内部名で、そのまま画面へ出さない）。区間の近くの点なら、道からの距離（m）を「道から<距離>m」で続ける。続けて、宣言が点に添える
 * 事実を「<名前>: <値>」で1行ずつ出す（値の無い事実は出さない）。 */
export function buildPointPopupContent(
  layer: PointPopupLayer,
  properties: Record<string, unknown>,
  lngLat: { lng: number; lat: number },
  offsetM?: number,
): HTMLDivElement {
  const placeName = pointPlaceName(layer, properties);
  const lines = [...(placeName !== null ? [placeName] : []), `${layer.label}: ${categoryNames(layer, properties)}`];
  if (offsetM !== undefined) lines.push(`道から${offsetM}m`);
  for (const fact of layer.point_facts) {
    const value = properties[fact.property];
    if (value != null) lines.push(`${fact.label}: ${String(value)}`);
  }
  const body = popupBody(lines);
  if (placeName !== null) {
    const link = document.createElement("a");
    link.href = externalMapSearchUrl(placeName, lngLat);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Googleマップで営業を確かめる";
    body.appendChild(document.createElement("br"));
    body.appendChild(link);
  }
  return body;
}

/** 束ねた区間の近くの点を押したときの本文: 1行目に「<点の名前>: <行の名前> <件数>件」、続けて中の点ごとに「<名前（無ければ区分の
 * 名前）> 道から<距離>m」を道に近い順で。 */
export function buildPointClusterPopupContent(
  layer: PointPopupLayer,
  rowLabel: string,
  members: readonly { properties: Record<string, unknown>; offsetM: number }[],
): HTMLDivElement {
  const lines = [...members]
    .sort((a, b) => a.offsetM - b.offsetM)
    .map(
      (member) =>
        `${pointPlaceName(layer, member.properties) ?? categoryNames(layer, member.properties)} 道から${member.offsetM}m`,
    );
  return popupBody([`${layer.label}: ${rowLabel} ${members.length}件`, ...lines]);
}

/** 地点のピンの名前（見るだけの間にピンを押すと、小窓に呼び名と並べて出す）。 */
export interface PinNames {
  origin: string;
  waypoints: readonly string[];
  destination: string;
}

/** 地点のピンを押したときのポップアップの本文:「<ピンの呼び名>: <名前>」。 */
export function buildPinPopupContent(target: PointTarget, pinNames: PinNames): HTMLParagraphElement {
  const index = target.role === "waypoint" ? (target.index ?? 0) : 0;
  const name =
    target.role === "origin"
      ? pinNames.origin
      : target.role === "destination"
        ? pinNames.destination
        : pinNames.waypoints[index];
  const content = document.createElement("p");
  content.textContent = `${pinMarkName(target.role, target.role === "waypoint" ? String(index + 1) : undefined)}: ${name}`;
  return content;
}
