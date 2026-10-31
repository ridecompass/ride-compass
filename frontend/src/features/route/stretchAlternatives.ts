/** 元の経路の区間ごとに、全候補の中から乗り換えられる道を集める。
 *
 * 区間を細かく割るときだけ座標（`geometry.coordinates`と`edge_point_offsets`）も読む
 * ——2本が交差・接触する地点はEdge idの一致では分からないため（`splitPairedStretch`）。
 */
import {
  pairedStretches,
  type PairedStretch,
  type RouteStretch,
  type SplicedRouteShape,
  type StretchAlternative,
} from "@/features/route/routeSplice";

/**
 * 1つの区間を、**元と相手が同じ地点を通る所**で細かく割る。
 *
 * 対応づけた区間はEdge idの一致だけで「同じ道」を判定するため、2本が同じノードで
 * 交差・接触していても、そこで同じEdgeを通っていなければ1本の長い区間になる。交差した
 * ノードは乗り換えられる地点なので、そこで割ると区間ごとに別の候補を選べる。
 *
 * 割る位置は両側ともEdgeの境界に限る（Edgeの途中で差し替えた列はbackendで連結が成立しない）。
 * `minLengthKm`より短い断片は作らない。同じ地点かはbackendが返すNode id（`node_ids`）で
 * 判定する——グラフが持つ同一性をそのまま使う。
 */
function splitPairedStretch(
  base: SplicedRouteShape,
  target: SplicedRouteShape,
  pair: PairedStretch,
  minLengthKm: number,
): PairedStretch[] {
  const sharedOnBase = new Map<string, number>();
  for (let index = pair.displayed.start + 1; index < pair.displayed.end; index += 1) {
    sharedOnBase.set(base.nodeIds[index], index);
  }
  if (sharedOnBase.size === 0) return [pair];

  const startKm = base.edgeKms[pair.displayed.start];
  const endKm = base.edgeKms[pair.displayed.end];

  const splits: PairedStretch[] = [];
  let lastBase = pair.displayed.start;
  let lastTarget = pair.target.start;
  let lastKm = startKm;
  for (let index = pair.target.start + 1; index < pair.target.end; index += 1) {
    const onBase = sharedOnBase.get(target.nodeIds[index]);
    if (onBase === undefined || onBase <= lastBase) continue;
    const splitKm = base.edgeKms[onBase];
    // 手前の断片と、残り全部の両方が下限を満たすときだけ割る（割った結果に下限未満を作らない）。
    if (splitKm - lastKm < minLengthKm || endKm - splitKm < minLengthKm) continue;
    splits.push({
      displayed: { start: lastBase, end: onBase },
      target: { start: lastTarget, end: index },
    });
    lastBase = onBase;
    lastTarget = index;
    lastKm = splitKm;
  }
  if (splits.length === 0) return [pair];
  splits.push({
    displayed: { start: lastBase, end: pair.displayed.end },
    target: { start: lastTarget, end: pair.target.end },
  });
  return splits;
}

/** 重なり合う代替をまとめた1つの選択単位。グループ内は排他、グループ間は独立。 */
interface StretchGroup {
  /** グループが覆う元ルート側の範囲（各代替の和）。 */
  stretch: RouteStretch;
  options: StretchAlternative[];
}

/**
 * この乗り換えを当てると、経路が同じ地点を2度通る形（折り返し）になるか。
 *
 * 乗り換えは共有地点でしか起きないため、差し替えた先の道が元の経路の**別の場所**へ触れると、
 * つながってはいるが一度通った地点へ戻る列ができる。backendは連結性しか見ないため
 * （そういう列も走れはするので「経路として成立しない」わけではない）、**選択肢として
 * 出さない側**で止める——この画面で折り返しを選びたい場面が無い。
 *
 * 見るのは差し替えで新しく入る内側のNodeだけ。両端は元と共有する地点で、差し替えで
 * 消える内側のNodeとぶつかっても折り返しにはならない。
 */
function createsRevisit(
  baseNodeIds: readonly string[],
  baseNodeSet: ReadonlySet<string>,
  targetNodeIds: readonly string[],
  stretch: RouteStretch,
  targetStretch: RouteStretch,
): boolean {
  const removed = new Set(baseNodeIds.slice(stretch.start + 1, stretch.end));
  const inserted = new Set<string>();
  for (let index = targetStretch.start + 1; index < targetStretch.end; index += 1) {
    const node = targetNodeIds[index];
    if (inserted.has(node)) return true;
    if (baseNodeSet.has(node) && !removed.has(node)) return true;
    inserted.add(node);
  }
  return false;
}

/**
 * 元ルートの区間ごとに、**全候補の中から**差し替えられる道を集める。
 *
 * 相手を1本選んでから区間を選ぶ形だと、どの相手が良い道を持つのかを総当たりで試すことに
 * なる。区間を主語にして、その区間の代替を候補横断で並べる。
 *
 * 元側の範囲が重なる代替は同じグループへ入れる——重なったまま両方を差し替えると経路が
 * 壊れるため、グループ内からは1つしか選べない。グループどうしは重ならないので、順に
 * 積み上げても互いに影響しない（`features/route/routeSplice.ts: buildSplicedShape`）。
 */
export function stretchAlternativeGroups(
  baseShape: SplicedRouteShape,
  candidates: readonly { id: string; shape: SplicedRouteShape }[],
  // 割る下限（km）は較正値なので既定を持たない（既定で動くと、較正したのとは別の切り方になる）。
  minSplitLengthKm: number,
): StretchGroup[] {
  const alternatives: StretchAlternative[] = [];
  const seen = new Set<string>();
  // 折り返しの判定に使う元ルートのNode集合。候補ごとに作り直さない。
  const baseNodeSet = new Set(baseShape.nodeIds);
  for (const candidate of candidates) {
    const pairs = (pairedStretches(baseShape.edgeIds, candidate.shape.edgeIds) ?? []).flatMap((pair) =>
      splitPairedStretch(baseShape, candidate.shape, pair, minSplitLengthKm),
    );
    for (const pair of pairs) {
      // 差し替え後に通るEdgeは相手側の範囲そのもの。両端の共有Edgeを目印に切り出す形には
      // できない——共有**地点**で割った区間は、両端に共有Edgeを持たない。
      const edgeIds = candidate.shape.edgeIds.slice(pair.target.start, pair.target.end);
      if (createsRevisit(baseShape.nodeIds, baseNodeSet, candidate.shape.nodeIds, pair.displayed, pair.target)) {
        continue;
      }
      // 同じ区間を同じ道へ差し替える代替は、候補が違っても選択肢としては同じもの。
      const key = `${pair.displayed.start}-${pair.displayed.end}:${edgeIds.join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      alternatives.push({
        candidateId: candidate.id,
        stretch: pair.displayed,
        targetStretch: pair.target,
        edgeIds,
      });
    }
  }

  const groups: StretchGroup[] = [];
  for (const alternative of [...alternatives].sort((a, b) => a.stretch.start - b.stretch.start)) {
    const last = groups.at(-1);
    if (last && alternative.stretch.start < last.stretch.end) {
      last.stretch = { start: last.stretch.start, end: Math.max(last.stretch.end, alternative.stretch.end) };
      last.options.push(alternative);
    } else {
      groups.push({ stretch: { ...alternative.stretch }, options: [alternative] });
    }
  }

  return groups;
}
