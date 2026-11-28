"""画面が読む費用の軸の一覧（軸ごとの見せ方・レンズの段と、地図がその軸のレンズで道を塗る決まり）と、総合のレンズ。

プロセス内の定義（`domain/model_settings.py: current_model_settings`）の1つの写しから組むので、軸の並び・段・塗る決まりが
同じ版の定義から出る。
"""

from app.domain.cost_axes import CostAxisCatalogEntry, LensBands, cost_axis_catalog
from app.domain.lens_equivalents import lens_bands
from app.domain.lens_total import TOTAL_LENS_ID
from app.domain.lens_values import MapLens, lens_conditions, map_lens
from app.domain.model_settings import current_model_settings
from app.domain.strict_model import StrictModel


class CostAxisCatalogItem(CostAxisCatalogEntry):
    """費用の軸1本の見せ方と、地図がその軸のレンズ（`lens_id`は軸id）で道を塗る決まり。"""

    map_lens: MapLens


class TotalLens(StrictModel):
    """総合のレンズ（軸ごとの代償の秒の和）。軸ではないので倍率を持たない。"""

    lens_id: str
    label: str
    description: str
    icon_id: str
    lens: LensBands
    map_lens: MapLens


class CostAxisCatalogResponse(StrictModel):
    axes: list[CostAxisCatalogItem]
    total_lens: TotalLens


def current_cost_axis_catalog() -> CostAxisCatalogResponse:
    """いま効いている定義の費用の軸の一覧と総合のレンズ。段は合成の道で走行の模型を解くので、イベントループの外で呼ぶ。"""
    settings = current_model_settings()
    definitions = settings.cost_axes
    conditions = lens_conditions(definitions)
    bands = lens_bands(settings)
    total = definitions.total_lens
    return CostAxisCatalogResponse(
        axes=[CostAxisCatalogItem(**entry.model_dump(), map_lens=map_lens(conditions[entry.axis_id], settings.tuning))
              for entry in cost_axis_catalog(definitions, bands)],
        total_lens=TotalLens(lens_id=TOTAL_LENS_ID, label=total.label, description=total.description,
                             icon_id=total.icon_id, lens=bands[TOTAL_LENS_ID],
                             map_lens=map_lens(conditions[TOTAL_LENS_ID], settings.tuning)),
    )
