"""軸スタジオが実データを見て設定を決めるための読み出し（分布プレビュー・材料の値ごとの延長）。

折れ点や重みを編集している最中に、**その設定で実データがどう分布するか**を返す。
軸スタジオは数値の入力欄を並べるだけでは折れ点の妥当性を判断できず、公開して地図と
ルートを見るまで結果が分からない。

返すのは**折れ点を通す前の生値**（`terms`の重み付き和）の分布で、折れ点そのものは
フロント側が局所的に当てはめる——折れ点を1つ動かすたびに通信すると編集の手応えが
失われるうえ、折れ点は区分線形の写像でしかなく、生値のヒストグラムがあれば
クライアントで正確に求まる。

母集団はWay単位（道の生データの抽選サンプル）。
"""

import logging

from cachetools import TTLCache

from app.domain.axis_definitions import AxisShape
from app.domain.material_catalog import material_dtype
from app.domain.region import BoundingBox
from app.domain.value_distribution import (
    ValueDistribution,
    ValueShares,
    raw_value_distribution,
    weighted_value_shares,
)
from app.infrastructure.road_graph_repository import RoadGraphRepository

logger = logging.getLogger("ridecompass.axis_preview")

# 抽選の広さ。ページ単位の抽選（TABLESAMPLE SYSTEM）のため、狭すぎると地理的に偏る。
SAMPLE_PERCENT = 2.0
SAMPLE_LIMIT = 20_000

# サンプルの保持時間。編集中は同じサンプルを使い回して即応させ、取込・集計バッチの後は
# 自然に入れ替わる程度の長さにする。
_SAMPLE_TTL_SECONDS = 15 * 60


def new_sample_cache() -> TTLCache:
    """`AxisPreviewService`へ渡す標本の置き場。リクエストをまたいで持つのは組み立てる側（`api/dependencies.py`）。"""
    return TTLCache(maxsize=1, ttl=_SAMPLE_TTL_SECONDS)


async def load_way_sample(
    repository: RoadGraphRepository,
    sample_percent: float,
    limit: int,
    bbox: BoundingBox | None = None,
) -> list[tuple[float, dict[str, object]]]:
    """way標本を`(延長m, 材料値)`の並びで返す。`bbox`を渡すとその範囲内だけを対象にする。

    分布プレビューと飽和度の実測スクリプト（`backend/scripts/measure_axis_saturation.py`）が
    同じ標本の作り方を共有するための口。
    """
    accident_years = await repository.get_accident_years_covered()
    return await repository.sample_way_material_values(
        accident_years, sample_percent, limit, bbox
    )


async def _load_sample(
    repository: RoadGraphRepository, sample_cache: TTLCache
) -> list[tuple[float, dict[str, object]]]:
    cached = sample_cache.get("sample")
    if cached is not None:
        return cached
    sample = await load_way_sample(repository, SAMPLE_PERCENT, SAMPLE_LIMIT)
    sample_cache["sample"] = sample
    logger.info("軸プレビューのサンプルを取得 ways=%d", len(sample))
    return sample


class AxisPreviewService:
    """軸スタジオが設定を決めるための実データの読み出し。

    `repository`はルート生成用の長い`command_timeout`のセッションで渡す（`api/dependencies.py:
    get_axis_preview_service`）——標本の抽選は全表走査寄りで、タイル配信の短い方だと最後まで走らない。
    """

    def __init__(self, repository: RoadGraphRepository, sample_cache: TTLCache):
        self._repository = repository
        self._sample_cache = sample_cache

    async def raw_value_distribution(self, shape: AxisShape) -> ValueDistribution:
        """候補の`shape`の生値（折れ点を通す前）の分布。"""
        return raw_value_distribution(shape, await _load_sample(self._repository, self._sample_cache))

    async def material_value_shares(self, material_id: str) -> ValueShares | None:
        """種類・はい/いいえの材料の値ごとの延長の割合。数値材料はNone（値ごとに数えても意味が無い）。"""
        if material_dtype(material_id) == "numeric":
            return None
        sample = await _load_sample(self._repository, self._sample_cache)
        return weighted_value_shares(
            [(length_m, materials[material_id]) for length_m, materials in sample if materials.get(material_id) is not None]
        )
