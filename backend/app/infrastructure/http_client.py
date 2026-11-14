import httpx

_client: httpx.AsyncClient | None = None


def get_http_client() -> httpx.AsyncClient:
    """外部APIへの共有のクライアント。待ちは httpx の既定に任せる。

    `httpx.AsyncClient`の生成はSSLコンテキスト構築（CA証明書バンドルの読み込み・パース）を伴い、
    リクエストごとに作るとその構築コストがイベントループを同期的にブロックするので、1つだけ作って使い回す。
    """
    global _client
    if _client is None:
        _client = httpx.AsyncClient()
    return _client


async def close_http_client() -> None:
    """共有のクライアントを閉じる。次の取得で作り直す。"""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


class UpstreamNotFound:
    """上流に、このパスで得るものが無いと確かめた事実（404）を表すセンチネル（取得の失敗は投げる）。

    空のタイルを200で返す配信元では、空と分かったタイルもこの事実として持つ（利用者から見れば同じ「無い」）。"""


UPSTREAM_NOT_FOUND = UpstreamNotFound()


async def fetch_upstream(http_client: httpx.AsyncClient, url: str, fields: dict) -> httpx.Response | UpstreamNotFound:
    """`log_external_call`の中で上流から1件取る。404は`UPSTREAM_NOT_FOUND`。ほかの失敗は`httpx`の例外のまま投げる
    （`log_external_call`が失敗として記録し、口は`api/failure_replies.py`が502にする）。"""
    response = await http_client.get(url)
    fields["status"] = response.status_code
    if response.status_code == 404:
        fields["result"] = "ok"
        return UPSTREAM_NOT_FOUND
    response.raise_for_status()
    fields["result"] = "ok"
    return response
