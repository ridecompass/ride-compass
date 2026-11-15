"""この作業ツリーのbackendを、DBを読まずに起動する（撮影の道具`frontend/scripts/capture.mjs`の`--backend`が打つ）。

本体（`app/main.py: app`）の起動の段はDBの軸定義を読み、読めなければ起動しない。担当のランナーのDBは空なので、起動の段だけを
HTTPの接続を閉じるだけのものに替え、ルーターとミドルウェアは本体のまま使う（起動の段の定期ジョブも動かない）。DBを読む経路は
失敗するので、撮影の道具は選んだパスの頭（DBを読まないタイルの中継等）だけをここへ向け、残りは`--api`のbackendへ向ける。

    python backend/scripts/serve_capture.py <ポート>
"""

import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.infrastructure.http_client import close_http_client
from app.main import app


@asynccontextmanager
async def without_db(_app: FastAPI) -> AsyncIterator[None]:
    """DBを読まない起動の段。閉じるときにHTTPの接続だけを閉じる。"""
    yield
    await close_http_client()


def serve(host: str, port: int) -> None:
    """本体の起動の段を`without_db`に替えて起こす。替えるのは起こすときだけで、読み込んだだけでは本体を変えない。"""
    app.router.lifespan_context = without_db
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    serve("127.0.0.1", int(sys.argv[1]))
