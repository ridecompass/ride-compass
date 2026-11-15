"""この作業ツリーのbackendを、起動の段（DBの定義の読み込み・定期ジョブ）を外して起こす。

本体（`app/main.py: app`）の起動の段はDBの定義を読み、読めなければ起動しない。DBが空か今のコードに追いついていない所で
起こすために、起動の段だけを替え、ルーターとミドルウェアは本体のまま使う。定義を読まないので、定義に依る口（管理API等）と
DBを読む口は失敗する。

    python backend/scripts/serve_without_db.py <ポート>
"""

import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.infrastructure.process_resources import close_process_resources
from app.main import app


@asynccontextmanager
async def without_db(_app: FastAPI) -> AsyncIterator[None]:
    yield
    await close_process_resources()


def serve(host: str, port: int) -> None:
    """本体の起動の段を`without_db`に替えて起こす。替えるのは起こすときだけで、読み込んだだけでは本体を変えない。"""
    app.router.lifespan_context = without_db
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    serve("127.0.0.1", int(sys.argv[1]))
