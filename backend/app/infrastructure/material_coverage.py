"""材料ごとの欠損割合（カバレッジ）を集計クエリで求める読み取り専用リポジトリ。

材料ごとに元データの置き場所が異なる（道の生データのタグ・区間の材料の列・道路網の配列）ため、「どの母集団の、どの条件が成り立てば
欠損か」を材料ごとの宣言（`MaterialSpec.coverage`）から受け取り、まとめて数える（Edge/Way単位のPythonループは回さない）。

母集団は3種類:

- 道の生データ全行（`WayMaterialCoverageSpec`。`WAYS_SOURCE_SQL`、OSMタグ由来の材料）。全材料が同じ行のタグを見るため、
  材料ごとの`count(*) FILTER`を並べた1回の走査にまとめる。欠損判定式は`domain/material_sql.py`の共有SQL断片を使う。
- `road_edges`全行（`EdgeMaterialCoverageSpec`。Edge単位の材料）。区間の値（別名`em`）の表を区間へ結ばずに走査して値のある
  区間を数え、総数は`road_edges`の件数とする。判定式が読む表は宣言から引き（`material_joins.py: edge_material_table`）、
  way側と同じく材料ごとの`count(*) FILTER`を並べて表ごとに1回の走査にまとめる。
- 道路網の配列の区間（`NetworkMaterialCoverageSpec`。配列を作るときに求める材料）。区間ごとに一番若い行の値が無い区間を数える。

「欠損」はあくまで元データ（タグ・行）の不在を指す。その不在がデータの欠けか、タグ不在=非該当の
ような確定値を意味するかは材料ごとに異なるため、`missing_semantics`として併記する。
"""


import asyncio
from collections.abc import Callable
from dataclasses import dataclass

import numpy as np

from app.domain.material_catalog import material_coverage_exclusions, material_coverage_specs
from app.domain.material_coverage_spec import EdgeMaterialCoverageSpec, NetworkMaterialCoverageSpec, WayMaterialCoverageSpec
from app.domain.road_network import RoadNetwork
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.material_joins import edge_material_table
from app.infrastructure.source_models import WAYS_SOURCE_SQL

MATERIAL_COVERAGE_SPECS = material_coverage_specs()
MATERIAL_COVERAGE_EXCLUSIONS = material_coverage_exclusions()


@dataclass(frozen=True)
class MaterialCoverageCounts:
    """集計の生の結果。`missing_by_material`は`MATERIAL_COVERAGE_SPECS`の全キーを持つ。`network_edge_total`は道路網の配列の区間の数。"""

    way_total: int
    edge_total: int
    network_edge_total: int
    missing_by_material: dict[str, int]


_WAY_SPECS = {
    material_id: spec
    for material_id, spec in MATERIAL_COVERAGE_SPECS.items()
    if isinstance(spec, WayMaterialCoverageSpec)
}
_EDGE_SPECS = {
    material_id: spec
    for material_id, spec in MATERIAL_COVERAGE_SPECS.items()
    if isinstance(spec, EdgeMaterialCoverageSpec)
}
_NETWORK_SPECS = {
    material_id: spec
    for material_id, spec in MATERIAL_COVERAGE_SPECS.items()
    if isinstance(spec, NetworkMaterialCoverageSpec)
}


def _way_coverage_sql():
    """way母集団の全材料を1回の走査で数えるSELECT文（`count(*) FILTER`列を材料ごとに並べる）。
    列別名は材料id（内部定数のみ、外部入力を連結しない）。"""
    columns = ", ".join(
        f"count(*) FILTER (WHERE {spec.missing_condition}) AS {material_id}"
        for material_id, spec in _WAY_SPECS.items()
    )
    sql = (  # 固定の内部辞書のみ使用
        f"SELECT count(*) AS total{', ' + columns if columns else ''} FROM {WAYS_SOURCE_SQL} AS w"
    )
    return text(sql)


def _edge_coverage_sql():
    """edge母集団の全材料の「値ありEdge数」を数えるSELECT文。区間の値の表ごとに1回の走査。列別名は材料id。"""
    columns_by_table: dict[str, list[str]] = {}
    for material_id, spec in _EDGE_SPECS.items():
        columns_by_table.setdefault(edge_material_table(spec.present_condition), []).append(
            f"count(*) FILTER (WHERE {spec.present_condition}) AS {material_id}")
    # 区間へ結ばずに値の表だけを走査する（区間の全件へ結ぶと、値の表の全件のハッシュがwork_memから溢れる）。
    # 判定式が`re.`（区間の形）を読むようになったら、この形では組めないので区間へ結ぶ形に戻す。
    scans = [f"(SELECT {', '.join(columns)} FROM {table} em) t_{table}"
             for table, columns in columns_by_table.items()]
    sql = (  # 固定の内部辞書のみ使用
        "SELECT (SELECT count(*) FROM road_edges) AS total"
        + (", * FROM " + " CROSS JOIN ".join(scans) if scans else "")
    )
    return text(sql)


class MaterialCoverageQuery:
    """読み取り専用でcommit対象の書き込みは無い。全表走査を伴うため管理API専用
    （`api/dependencies.py: get_material_coverage_service`がルート生成と同じプールのセッションを渡す）。"""

    def __init__(self, session: AsyncSession):
        self._session = session

    async def get_material_coverage_counts(self, read_network: Callable[[], RoadNetwork]) -> MaterialCoverageCounts:
        """道の生データと区間の表をDBで数え、配列を作るときに求める材料は`read_network`で読んだ道路網の値で数える（DBを先に
        読むので、DBに届かない失敗はDBの失敗として出る）。"""
        missing_by_material: dict[str, int] = {}

        way_row = (await self._session.execute(_way_coverage_sql())).mappings().one()
        way_total = int(way_row["total"])
        for material_id in _WAY_SPECS:
            missing_by_material[material_id] = int(way_row[material_id])

        edge_row = (await self._session.execute(_edge_coverage_sql())).mappings().one()
        edge_total = int(edge_row["total"])
        for material_id in _EDGE_SPECS:
            missing_by_material[material_id] = edge_total - int(edge_row[material_id])

        # 道路網を読むのは、イベントループの外で行う。
        network = await asyncio.to_thread(read_network)
        first = network.edge_first_rows
        for material_id in _NETWORK_SPECS:
            # 配列に無い材料（テストの道路網）は、値の無い列として数える。
            missing_by_material[material_id] = (
                int(np.isnan(network.numeric_values[first, network.numeric_ids.index(material_id)]).sum())
                if material_id in network.numeric_ids else len(first))

        return MaterialCoverageCounts(
            way_total=way_total, edge_total=edge_total, network_edge_total=len(first),
            missing_by_material=missing_by_material,
        )
