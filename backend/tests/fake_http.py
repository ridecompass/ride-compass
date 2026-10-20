"""外部HTTPの代役。応答はrespxの経路（`respx.Router`）で決め、実装へは本物の`httpx.AsyncClient`を渡す。

経路は`httpx.MockTransport`へ差すので網へは出ず、既定の送り先（証明書の読み込みを伴い、
1つ作るのに開発機で0.5秒かかる）も作らない。応答は本物の`httpx.Response`なので、
`raise_for_status`・`json`・`text`・ヘッダの読み方は実装と同じものを通る。経路に無いURLを
引くとrespxが落とす（引くはずの無いURLを黙って通さない）。

応答の前に一度ほかのタスクへ順を譲る（網の上の要求と同じく、応答を待つ間に別の要求が進む）。同時に来た要求が
上流への取得を重ねるかどうかは、これが無いと確かめられない——譲らない代役では、先の要求が応答まで一気に進んでしまう。

要求を見るときは経路の記録（`router.calls`・`route.calls`）を読む。クエリはURLに載った形
（`request.url.params`、値は文字列）で見る。
"""

import asyncio

import httpx
import respx


def client_for(router: respx.Router) -> httpx.AsyncClient:
    async def handler(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(0)
        return router.handler(request)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def answering(*args, **kwargs) -> httpx.AsyncClient:
    """どのURLへも同じ応答を返すクライアント。引数は`respx.Route.respond`のもの（例: `json=...`・`text=...`・`500`）。"""
    router = respx.Router()
    router.route().respond(*args, **kwargs)
    return client_for(router)
