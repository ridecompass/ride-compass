"""DB障害を、どの口でも503で返すアプリ単位の例外の扱い。

DB障害は途中の層で空やフォールバック値へ倒さず投げ、ここが口の1か所で503にする（空で返すと「無い」と見え、管理画面では
フォールバック値を直して書いたときにDBの実データを上書きする）。捕まえるのはDB障害として扱う例外（`DB_UNAVAILABLE_ERRORS`）だけで、
実装の誤り（`TypeError`等）は500のまま表へ出す。
"""

from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse

from app.infrastructure.database import DB_UNAVAILABLE_ERRORS


async def db_unavailable_handler(request: Request, exc: Exception) -> JSONResponse:
    del request, exc
    return JSONResponse(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        content={"detail": "DBへのアクセスに失敗しました（DB接続と、テーブルが作られているかを確認してください）"},
    )


def install_db_unavailable_handler(app: FastAPI) -> None:
    for error_type in DB_UNAVAILABLE_ERRORS:
        app.add_exception_handler(error_type, db_unavailable_handler)
