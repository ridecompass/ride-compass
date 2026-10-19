"""OSM の派生データベースの配布。

`GET /api/derived-database`は、置き場にある最新の書き出し（ODbL の表示を付けた ZIP）を、認証なしで返す。地図・ルートが
公に使う派生データベースを、受け取った人が無償で取れるようにする口で、画面の出典表記からリンクする。書き出しがまだ
1つも無ければ404。
"""

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.infrastructure import derived_database_export

router = APIRouter()


@router.get(
    "/api/derived-database",
    response_class=FileResponse,
    responses={200: {"content": {"application/zip": {}}}, 404: {"description": "書き出しがまだ無い"}},
)
async def get_derived_database() -> FileResponse:
    path = derived_database_export.latest()
    if path is None:
        raise HTTPException(status_code=404, detail="派生データベースの書き出しがまだありません")
    return FileResponse(path, media_type="application/zip", filename=path.name)
