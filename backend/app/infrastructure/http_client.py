import httpx

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
