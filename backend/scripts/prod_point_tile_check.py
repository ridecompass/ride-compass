"""本番の点の密な所の点のタイルを、点の層ごと・倍率ごとに公開の口で取り、上限の中で空でなく返るかを見る
（`.github/workflows/deploy-backend.yml`がデプロイのあとに、`.github/workflows/prod-route-check.yml`が1日1回呼ぶ）。

    python backend/scripts/prod_point_tile_check.py

タイルを作る問い合わせがDBの上限を超えると、backendは空のタイルを返す。空のタイルは点の無い所と同じ見た目で、画面からは
気づけない。どれかのタイルが空か・上限を超えたか・200で返らなければ、層・倍率・時間・大きさを出して終了コード1で終わる。
本番には書き込まない。何を見るか・上限の根拠は docs/architecture/tech-stack.md「本番の点のタイルの確かめ」。
"""

from __future__ import annotations

import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.domain.region import ROAD_TILE_MAX_ZOOM, ROAD_TILE_MIN_ZOOM, tile_position
from app.infrastructure.point_tile_layers import POINT_TILE_LAYERS
from app.infrastructure.vector_tile import encode_empty_tile

#: 点の密な所（緯度, 経度）。新宿駅の真ん中で、都心の駅前のためどの点の層も点が密に入る。
DENSE_POINT = (35.6896, 139.7006)
#: 配る倍率の全部。点を束ねる手間は1枚に入る点の多い引いた側ほど大きい。
ZOOMS = range(ROAD_TILE_MIN_ZOOM, ROAD_TILE_MAX_ZOOM + 1)
#: 1枚を取り終えるまでの上限（秒）。超えたら失敗にする。
TILE_LIMIT_SECONDS = 10.0
#: 1回の要求の上限（秒）。DBの上限で空へ倒れたタイルを、空のタイルとして受け取れる長さにする。
REQUEST_TIMEOUT_SECONDS = 30


@dataclass(frozen=True)
class FetchedTile:
    layer: str
    z: int
    x: int
    y: int
    seconds: float
    #: HTTPの状態の番号。応答が無ければ、要求が失敗した理由の文。
    status: int | str
    body: bytes = b""

    def describe(self) -> str:
        return f"{self.layer} z{self.z}（{self.x}/{self.y}）{self.seconds:.1f}秒・{len(self.body)}バイト"


def tile_targets() -> list[tuple[str, int, int, int]]:
    """見るタイル（層の名前, z, x, y）。点の層ごと・倍率ごとに、点の密な所を含む1枚。"""
    latitude, longitude = DENSE_POINT
    targets = []
    for layer in POINT_TILE_LAYERS:
        for z in ZOOMS:
            x, y = tile_position(longitude, latitude, z)
            targets.append((layer, z, int(x), int(y)))
    return targets


def problems(tiles: list[FetchedTile]) -> list[str]:
    """取ったタイルのうち、利用者に見える壊れ（返らない・空・上限より遅い）。"""
    found = []
    for tile in tiles:
        reasons = []
        if tile.status != 200:
            reasons.append(f"200で返らない（{tile.status}）")
        elif tile.body == encode_empty_tile(POINT_TILE_LAYERS[tile.layer].source_layer):
            reasons.append("点の密な所が空のタイル")
        if tile.seconds > TILE_LIMIT_SECONDS:
            reasons.append(f"{TILE_LIMIT_SECONDS:.0f}秒の上限を超えた")
        if reasons:
            found.append(f"{tile.describe()}: {'・'.join(reasons)}")
    return found


def fetch(origin: str, layer: str, z: int, x: int, y: int) -> FetchedTile:
    started = time.monotonic()
    url = f"{origin}/api/region/point-tiles/{layer}/{z}/{x}/{y}.pbf"
    try:
        with urllib.request.urlopen(url, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            body = response.read()
            status: int | str = response.status
    except urllib.error.HTTPError as error:
        body, status = b"", error.code
    except OSError as error:
        body, status = b"", repr(error)
    return FetchedTile(layer, z, x, y, time.monotonic() - started, status, body)


def main() -> int:
    from _production_origins import production_origin

    backend = production_origin("backend")
    tiles = []
    for target in tile_targets():
        tile = fetch(backend, *target)
        print(tile.describe(), flush=True)
        tiles.append(tile)
    found = problems(tiles)
    for line in found:
        print(f"失敗: {line}")
    if found:
        return 1
    print(f"通った: 点の層 {len(POINT_TILE_LAYERS)} 本・倍率 z{ZOOMS[0]}〜{ZOOMS[-1]} のタイル {len(tiles)} 枚のどれも、"
          f"{TILE_LIMIT_SECONDS:.0f}秒の中で空でなく返る")
    return 0


if __name__ == "__main__":
    sys.exit(main())
