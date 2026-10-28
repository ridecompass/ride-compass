"""`backend/scripts/prod_point_tile_check.py`のテスト（本番・ネットワークには触れない）。

取ったタイルの結果ごとに、壊れとして知らせるかを見る。
ここで見ないもの: 本番へ要求を送る口（`fetch`・`main`）とワークフローから呼ぶ所の結線。
"""

import pytest

from app.infrastructure.point_tile_layers import POINT_TILE_LAYERS
from app.infrastructure.vector_tile import encode_empty_tile
from scripts import prod_point_tile_check as check

LAYER = next(iter(POINT_TILE_LAYERS.values()))
EMPTY = encode_empty_tile(LAYER.source_layer)
FILLED = EMPTY + b"\x00"
LIMIT = check.TILE_LIMIT_SECONDS
OVER = f"{LIMIT:.0f}秒の上限を超えた"


@pytest.mark.parametrize(
    ("seconds", "status", "body", "reasons"),
    [
        (LIMIT, 200, FILLED, None),
        (LIMIT + 0.1, 200, FILLED, OVER),
        # DBの上限で空へ倒れたタイルは、点の無い所と同じ見た目で画面からは気づけない。
        (1.0, 200, EMPTY, "点の密な所が空のタイル"),
        (1.0, 503, b"", "200で返らない（503）"),
        (30.0, "TimeoutError('timed out')", b"", f"200で返らない（TimeoutError('timed out')）・{OVER}"),
    ],
)
def test_reports_tiles_that_users_would_see_broken(seconds, status, body, reasons):
    tile = check.FetchedTile(LAYER.name, 12, 3637, 1612, seconds, status, body)

    expected = [] if reasons is None else [f"{tile.describe()}: {reasons}"]
    assert check.problems([tile]) == expected
