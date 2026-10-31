"""材料カタログの管理画面向けAPI（いずれもHTTP Basic認可要）。

材料の一覧そのものはAPIで配らない。コードが宣言した材料（`domain/material_catalog.py: MATERIAL_CATALOG`）は
再デプロイでしか変わらず、ビルド時の生成物（`material-catalog.json`）が持つ。
道の区分から作る材料（`class:<分け方>`）は管理DBの区分から実行時に決まり、生成物に載らない。
ここに置くのは、実データを読まないと答えられないものだけ。

`GET /api/admin/material-catalog/{material_id}/value-shares`は、種類・はい/いいえの材料の値ごとの道の延長の割合を、
軸スタジオの分布と同じ道の標本から返す。

`GET /api/admin/material-catalog/coverage`は、材料ごとの欠損割合
（元データ[タグ・派生テーブル行]が無いWay/Edgeの割合）を全材料ぶん返す。
"""

from fastapi import APIRouter, Depends, HTTPException

from app.api.admin_auth import require_admin_basic_auth
from app.api.dependencies import get_axis_preview_service, get_material_coverage_service
from app.domain.material_catalog import is_known_material, known_material_spec
from app.services.axis_preview_service import AxisPreviewService
from app.services.material_coverage_service import MaterialCoverageReport, MaterialCoverageService
from app.domain.strict_model import StrictModel

router = APIRouter(dependencies=[Depends(require_admin_basic_auth)])


class MaterialValueShareEntry(StrictModel):
    #: 対応表（`CategoricalShape.mapping`）のキーと同じ綴り（真偽の材料は"true"/"false"）。
    value: str
    #: 「論理名 - 物理名」形式（`MaterialSpec.value_label`）。
    label: str
    share: float


class MaterialValueSharesResponse(StrictModel):
    """値ごとの延長の割合（割合の大きい順）。`available=false`は数値材料で、値を並べない。"""

    available: bool
    sample_ways: int
    total_km: float
    values: list[MaterialValueShareEntry]


def _require_known_material(material_id: str) -> None:
    if not is_known_material(material_id):
        raise HTTPException(status_code=404, detail=f"unknown material '{material_id}'")


@router.get("/api/admin/material-catalog/{material_id}/value-shares")
async def get_material_value_shares(
    material_id: str,
    preview: AxisPreviewService = Depends(get_axis_preview_service),
) -> MaterialValueSharesResponse:
    """種類・はい/いいえの材料の値ごとに、その値を持つ道の延長の割合を返す（軸スタジオの較正の画面）。

    対応表の軸の点数は、値ごとにどれだけの道が当たるかを知らないと、地図とルートへの効き方を決められない。
    """
    _require_known_material(material_id)
    shares = await preview.material_value_shares(material_id)
    if shares is None:
        return MaterialValueSharesResponse(available=False, sample_ways=0, total_km=0.0, values=[])
    spec = known_material_spec(material_id)
    return MaterialValueSharesResponse(
        available=True,
        sample_ways=shares.sample_ways,
        total_km=shares.total_km,
        values=[
            MaterialValueShareEntry(value=s.value, label=spec.value_label(s.value), share=s.share)
            for s in shares.shares
        ],
    )


@router.get("/api/admin/material-catalog/coverage", response_model=MaterialCoverageReport)
async def get_material_coverage(
    service: MaterialCoverageService = Depends(get_material_coverage_service),
) -> MaterialCoverageReport:
    """全材料の欠損割合（`MATERIAL_CATALOG`の登録順、集計対象外の材料は理由付き）を返す。

    読み取り専用のAPIだがBasic認証を要求する:
    道の生データと区間の材料の全表走査を伴う重いクエリで、認可なしに公開すると
    繰り返し呼ばれるだけでDBを圧迫できてしまう。
    """
    return await service.get_material_coverage()
