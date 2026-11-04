"""材料カタログの管理画面向けAPI（いずれもHTTP Basic認可要）。

材料の一覧そのものはAPIで配らない。コードが宣言した材料（`domain/material_catalog.py: MATERIAL_CATALOG`）は
再デプロイでしか変わらず、ビルド時の生成物（`material-catalog.json`）が持つ。
道の区分から作る材料（`class:<分け方>`）は管理DBの区分から実行時に決まり、生成物に載らない。
ここに置くのは、実データを読まないと答えられないものだけ。

`GET /api/admin/material-catalog/coverage`は、材料ごとの欠損割合
（元データ[タグ・派生テーブル行]が無いWay/Edgeの割合）を全材料ぶん返す。
"""

from fastapi import APIRouter, Depends

from app.api.admin_auth import require_admin_basic_auth
from app.api.dependencies import get_material_coverage_service
from app.services.material_coverage_service import MaterialCoverageReport, MaterialCoverageService

router = APIRouter(dependencies=[Depends(require_admin_basic_auth)])


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
