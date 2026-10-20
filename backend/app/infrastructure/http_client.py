import httpx

from app.infrastructure.debug_log import mark_failed, mark_status_error

# httpx.AsyncClientの生成はSSLコンテキスト構築（CA証明書バンドルの読み込み・パース）を
# 伴い、リクエストごとに作るとその構築コストがイベントループを同期的にブロックする。
# timeoutの値ごとに1つだけ生成して使い回す。
_clients: dict[tuple[float | None, ...], httpx.AsyncClient] = {}

#: 気象庁のJSON（警報・アメダス）のタイムアウト。
JMA_JSON_TIMEOUT = httpx.Timeout(connect=3.0, read=5.0, write=5.0, pool=5.0)
#: WBGT・洪水予報のJSON・CSVのタイムアウト。
SLOW_JSON_TIMEOUT = httpx.Timeout(connect=3.0, read=8.0, write=5.0, pool=5.0)
#: 地図のタイルを中継する外部（ベースマップ・JMA・GSI）のタイムアウト（秒）。
TILE_PROXY_TIMEOUT = 15.0


def get_http_client(timeout: float | httpx.Timeout) -> httpx.AsyncClient:
    """待ち時間はクライアントが持つ。使う側は要求ごとに`timeout`を渡さない（渡すとここで選んだ値が効かない）。"""
    timeout = httpx.Timeout(timeout)
    key = tuple(timeout.as_dict().values())
    if key not in _clients:
        _clients[key] = httpx.AsyncClient(timeout=timeout)
    return _clients[key]


async def close_all_http_clients() -> None:
    """プロセス終了時に`process_resources.py: close_process_resources`から呼ぶ。"""
    for client in _clients.values():
        await client.aclose()
    _clients.clear()


class UpstreamNotFound:
    """上流に、このパスで得るものが無いと確かめた事実（404）を表すセンチネル。取得の失敗（None）と分ける。

    空のタイルを200で返す配信元では、空と分かったタイルもこの事実として持つ（利用者から見れば同じ「無い」）。"""


UPSTREAM_NOT_FOUND = UpstreamNotFound()


async def fetch_upstream(
    http_client: httpx.AsyncClient, url: str, fields: dict
) -> httpx.Response | UpstreamNotFound | None:
    """`log_external_call`の中で上流から1件取る。404は`UPSTREAM_NOT_FOUND`、ほかの失敗はNone。

    取れたとき・404のときは`fields`へ成功として、ほかの失敗は失敗として記録する。"""
    try:
        response = await http_client.get(url)
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        return UPSTREAM_NOT_FOUND if mark_status_error(fields, exc) else None
    except httpx.HTTPError as exc:
        mark_failed(fields, exc)
        return None
    fields["result"] = "ok"
    fields["status"] = response.status_code
    return response
