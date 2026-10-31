/** 候補ルートの区間の乗り換え。
 *
 * 2つの候補が別々の道を通る区間を、経路のEdge id列（`RouteCandidate.edge_ids`）の
 * 集合演算で求める。**経路の同一性の判定だけを行い、軸の計算式は持たない**
 * （docs/architecture/design-principles.md 構造仕様1）——差し替えた経路の評価はbackendが
 * 既存候補と同じ経路で行う。
 *
 * `edge_ids`を持つ候補は、`edge_point_offsets`・`node_ids`もEdgeの数より1件多く持つ前提で、欠けを見ない。
 */
import { routeEdgeKms } from "@/lib/routeDistance";
import type { RouteCandidate } from "@/types/route";

/** 表示中の候補が、比較相手と別の道を通る区間。`edge_ids`における`[start, end)`。 */
export interface RouteStretch {
  start: number;
  end: number;
}

/**
 * `displayed`のうち`target`が通らないEdgeの連続した区間を、起点に近い順に返す。
 *
 * 2本は共有ノードで必ず合流するため、この区間1つを`target`側の道へ差し替えても経路は
 * 成立する。候補はすべて同じ前向き木・後ろ向き木から作られるので、軸に沿った候補どうしなら
 * 区間は1つになる（最短経路だけは別の木から作られるため複数になりうる）。
 */
function differingStretches(displayed: readonly string[], target: readonly string[]): RouteStretch[] {
  const onTarget = new Set(target);
  const stretches: RouteStretch[] = [];
  let start: number | null = null;
  displayed.forEach((edgeId, index) => {
    if (!onTarget.has(edgeId)) {
      if (start === null) start = index;
    } else if (start !== null) {
      stretches.push({ start, end: index });
      start = null;
    }
  });
  if (start !== null) stretches.push({ start, end: displayed.length });
  return stretches;
}

/**
 * `edge_ids`の`[start, end)`が`geometry.coordinates`のどこにあたるかを返す。
 *
 * 隣接Edgeの境界点は重複させずに連結されるため、この対応はbackendが
 * `edge_point_offsets`として返すものだけが持つ（座標列からは復元できない）。
 */
export function stretchCoordinateRange(
  edgePointOffsets: readonly number[],
  stretch: RouteStretch,
): { start: number; end: number } {
  return { start: edgePointOffsets[stretch.start], end: edgePointOffsets[stretch.end] };
}

/** 表示中の候補の区間と、それに対応する相手側の区間の組。 */
export interface PairedStretch {
  displayed: RouteStretch;
  target: RouteStretch;
}

/**
 * 2本が別々の道を通る区間を、表示中の側と相手側で対応づけて返す。
 *
 * 表示中の候補が共有ノードXで分かれてYで戻るなら、相手もXからYまでを別の道で進む——
 * その間の相手のEdgeは定義上どれも表示中の候補に無いため、区間は同じ本数・同じ順で
 * 現れる。本数が食い違ったら対応づけを諦めてnullを返す（片側だけ描くと、地図上の帯と実際に
 * 差し替わる道がずれる）。空の並びは「別の道を通る区間が無い」で、諦めたのとは別。
 */
export function pairedStretches(displayed: readonly string[], target: readonly string[]): PairedStretch[] | null {
  const onDisplayed = differingStretches(displayed, target);
  const onTarget = differingStretches(target, displayed);
  if (onDisplayed.length !== onTarget.length) return null;
  return onDisplayed.map((stretch, index) => ({ displayed: stretch, target: onTarget[index] }));
}

/** 経路の形。元ルート・乗り換え先・乗り換えを適用した後の経路が同じ形を持ち、次に選べる区間の計算と地図の描画が
 * 同じものを見る。 */
export interface SplicedRouteShape {
  edgeIds: string[];
  coordinates: readonly GeoJSON.Position[];
  /** Edge iの始点が`coordinates`の何番目か（末尾に終点を持つ）。backendの`edge_point_offsets`。 */
  edgePointOffsets: readonly number[];
  /** Edge iの始点のNode id（末尾に終点を持つ）。backendの`node_ids`。 */
  nodeIds: readonly string[];
  /** Edge iの始点のルートの上の距離（km。末尾に全体）。道のりのグラフと同じ物差しで区間から求める。 */
  edgeKms: readonly number[];
}

export const routeShape = (
  route: Pick<RouteCandidate, "edge_ids" | "geometry" | "edge_point_offsets" | "node_ids" | "segments">,
): SplicedRouteShape => ({
  edgeIds: route.edge_ids,
  coordinates: route.geometry.coordinates,
  edgePointOffsets: route.edge_point_offsets,
  nodeIds: route.node_ids,
  edgeKms: routeEdgeKms(route.segments, route.edge_point_offsets),
});

/** ある区間を、どの候補のどの道へ差し替えられるか。 */
export interface StretchAlternative {
  /** 差し替え後の道を持つ候補。 */
  candidateId: string;
  /** 元ルート側の範囲（`edge_ids`の`[start, end)`）。 */
  stretch: RouteStretch;
  /** 相手側の範囲（地図へ相手の道を描くために要る）。 */
  targetStretch: RouteStretch;
  /** 差し替え後に通るEdge id列。 */
  edgeIds: string[];
}

/**
 * 元ルートへ、選んだ乗り換えを順に適用した経路の**形**（Edge id列＋座標＋Edge境界）を組む。
 *
 * 次に選べる区間は「いまの組み合わせ」との差として求めるため、合成の途中でも元ルートと同じ
 * 形の材料が要る。backendへ問い合わせずに組めるのは、各候補の座標とEdge境界が手元にあり、
 * 乗り換えが共有地点でしか起きないため——継ぎ目の座標は両者で同じ点になる。
 *
 * `applied`は適用した順に渡す。各要素の範囲は**その時点の形**に対する位置のため、順に
 * 積み上げる（後から前の要素だけを外すことはできない。UIは直前の1手だけ戻せる）。
 */
export function buildSplicedShape(
  base: SplicedRouteShape,
  applied: readonly StretchAlternative[],
  shapeOf: (candidateId: string) => SplicedRouteShape | undefined,
): SplicedRouteShape {
  let current = base;
  for (const { candidateId, stretch, targetStretch, edgeIds: inserted } of applied) {
    const target = shapeOf(candidateId);
    if (!target) continue;
    const { start: from, end: to } = stretchCoordinateRange(target.edgePointOffsets, targetStretch);
    const { start: head, end: tail } = stretchCoordinateRange(current.edgePointOffsets, stretch);
    // Edge・Node・距離は同じ位置で継ぐ。継ぎ目のNodeは両者で同じ（共有地点でしか乗り換えないため）なので、
    // 相手側は差し替える区間の始点だけを取り、終点はこちら側の続きが持つ。後ろ側は伸び縮みした分だけずらす。
    const pointShift = to - from - (tail - head);
    const kmShift =
      target.edgeKms[targetStretch.end] -
      target.edgeKms[targetStretch.start] -
      (current.edgeKms[stretch.end] - current.edgeKms[stretch.start]);
    const splice = <T>(own: readonly T[], theirs: readonly T[], shiftTail = (value: T) => value) => [
      ...own.slice(0, stretch.start),
      ...theirs,
      ...own.slice(stretch.end).map(shiftTail),
    ];
    const targetSlice = <T>(values: readonly T[]) => values.slice(targetStretch.start, targetStretch.end);
    current = {
      edgeIds: splice(current.edgeIds, inserted),
      nodeIds: splice(current.nodeIds, targetSlice(target.nodeIds)),
      // 両端の継ぎ目の点は相手側のものだけを残し、重複させない。
      coordinates: [
        ...current.coordinates.slice(0, head),
        ...target.coordinates.slice(from, to + 1),
        ...current.coordinates.slice(tail + 1),
      ],
      edgePointOffsets: splice(
        current.edgePointOffsets,
        targetSlice(target.edgePointOffsets).map((offset) => offset - from + head),
        (offset) => offset + pointShift,
      ),
      edgeKms: splice(
        current.edgeKms,
        targetSlice(target.edgeKms).map(
          (km) => km - target.edgeKms[targetStretch.start] + current.edgeKms[stretch.start],
        ),
        (km) => km + kmShift,
      ),
    };
  }
  return current;
}
