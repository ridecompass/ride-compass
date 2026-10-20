"""`services/jma_tile_prewarm_service.py`——気象庁の動的タイルを定期的に温め、在否インデックスを残す。

確かめるのは公開の入口`prewarm_jma_tiles`から見える振る舞いだけ: 配信元へ何を取りに行くか（時刻一覧と
タイルのパス）と、保存する在否インデックス、取れなかったときの警告。温める要素・ズームは本物の宣言
（動的気象の要素・配信元仕様）をそのまま通す。範囲は呼び出し元が渡す入力なので、テストが渡す。

差し替えるのは、注入される配信元のクライアント（`JmaTileClient.get`の1メソッド。本物の署名に当てる）と、
インデックスの書き込み先（Redis。fakeredis）だけ。

ここで見ないもの:
- タイルの取得・キャッシュ・空タイルの扱い・読めない時刻一覧の形 → `test_jma_tile_client.py`・`test_jma_tile_redis_cache.py`
- 空かどうかの判定（取得の結果が空なら`UPSTREAM_NOT_FOUND`になる） → `test_jma_tile_content.py`・`test_jma_tile_client.py`
- 配信元仕様（ズームの偶奇・時刻一覧のファイル）・時刻一覧の読み方（別の要素の行・最新の実況・最新の行・
  メンバーごとの最新の完全なラン）・タイルのパスと拡張子 → `test_jma_tile_specs.py`
- 段をつないだときの各段の最初のコマ（前の段の後ろに続く・前の段に覆われた段は描かない・前の段が空なら最初から描く） → `test_weather_elements.py`

配信元の仕様の事実として、要素はどれも偶数ズーム（4・6・8・10、雷と竜巻は8まで）だけが実データを持ち、
奇数ズームは親から補う。
"""

import json
import logging

from PIL import Image

from app.domain.region import BoundingBox
from app.infrastructure.http_client import UPSTREAM_NOT_FOUND
from app.infrastructure.jma_tile_client import JmaTileClient
from app.infrastructure.jma_tile_index import get_index
from app.services import jma_tile_prewarm_service as prewarm
from tests.bound_fake import bound
from tests.tile_images import encode

N1 = "bosai/jmatile/data/nowc/targetTimes_N1.json"
N2 = "bosai/jmatile/data/nowc/targetTimes_N2.json"
N3 = "bosai/jmatile/data/nowc/targetTimes_N3.json"
RASRF = "bosai/jmatile/data/rasrf/targetTimes.json"
RISK = "bosai/jmatile/data/risk/targetTimes.json"
TARGET_TIMES = {N1, N2, N3, RASRF, RISK}
RISK_ELEMENTS = ["rain_mesh", "land", "inund", "flood"]


def _row(basetime, validtime, *elements, **extra):
    return {"basetime": basetime, "validtime": validtime, "elements": list(elements), **extra}


def _target_times():
    return {
        # 降水の1段目（実況＋予測）。1段目の最後のvalidtimeは01:00。
        N1: [_row("20260922001000", "20260922001000", "hrpns"), _row("20260922001000", "20260922003000", "hrpns")],
        # 別の要素の行は、1段目の境目にも2段目の選び方にも入れない（入れると境目が02:30へずれる）。
        N2: [_row("20260922001000", "20260922010000", "hrpns"), _row("20260922001000", "20260922023000", "other")],
        # 雷・竜巻。より新しい行が別の要素だけを載せている（その要素のタイルは無い）。
        N3: [
            _row("20260922000000", "20260922000000", "thns", "trns"),
            _row("20260922000500", "20260922000500", "thns", "trns"),
            _row("20260922002000", "20260922002000", "other"),
        ],
        RASRF: [
            # 線状降水帯予測は予測フレームしか持たない。
            _row("20260921230000", "20260922010000", "sjfcstmap"),
            _row("20260922000000", "20260922020000", "sjfcstmap"),
            # 降水の2段目。最新の完全な予報ラン（00:00、validtimeが複数）の、01:00より後の最初のフレームを描く。
            _row("20260922000000", "20260922003000", "rasrf", member="m1"),
            _row("20260922000000", "20260922030000", "rasrf", member="m1"),
            _row("20260922000000", "20260922020000", "rasrf", member="m1"),
            # 同じランの別の要素の行（入れると01:30を選んでしまう）。
            _row("20260922000000", "20260922013000", "other", member="m1"),
            # 単発の中間ラン（validtime==basetime、1件だけ）は画面が描かない。
            _row("20260922003000", "20260922030000", "rasrf", member="m1"),
            # 古い完全なラン。
            _row("20260921230000", "20260922013000", "rasrf", member="m1"),
            _row("20260921230000", "20260922023000", "rasrf", member="m1"),
        ],
        RISK: [
            _row("20260921235000", "20260921235000", *RISK_ELEMENTS),
            _row("20260922000000", "20260922000000", *RISK_ELEMENTS),
            _row("20260922000000", "20260922010000", *RISK_ELEMENTS),
        ],
    }


OPAQUE = encode(Image.new("RGBA", (2, 2), (255, 0, 0, 255)))


class Source:
    """配信元の代役。時刻一覧はJSON（Noneなら取れない）で、タイルは`tiles`（パスの一部→返す値）の最初に当たるもの、無ければ空タイル。"""

    def __init__(self, target_times=None, tiles=None):
        self.target_times = _target_times() if target_times is None else target_times
        self.tiles = tiles or {}
        self.requests: list[str] = []

    async def get(self, path):
        self.requests.append(path)
        if path in TARGET_TIMES:
            value = self.target_times.get(path)
            if value is None:
                return None
            return json.dumps(value).encode(), "application/json"
        for fragment, value in self.tiles.items():
            if fragment in path:
                return value
        return UPSTREAM_NOT_FOUND

    get = bound(JmaTileClient.get, get)

    def tile_requests(self, element):
        return [p for p in self.requests if f"/surf/{element}/" in p]


def _tile_parts(path):
    """`.../{group}/{basetime}/{member}/{validtime}/surf/{element}/{z}/{x}/{y}.{ext}`を分ける。"""
    group, basetime, member, validtime, _surf, element, z, x, rest = path.split("/")[3:]
    y, ext = rest.split(".")
    return {"group": group, "basetime": basetime, "member": member, "validtime": validtime,
            "element": element, "z": int(z), "x": int(x), "y": int(y), "ext": ext}


async def _stored() -> dict:
    """Redisへ書かれたインデックスを、保存された形（JSON）から読み戻す。"""
    index = await get_index()
    assert index is not None
    return index.model_dump()


AREA = BoundingBox(min_latitude=35.5, min_longitude=139.5, max_latitude=36.0, max_longitude=140.0)


async def _run(source):
    await prewarm.prewarm_jma_tiles(source, AREA)


# --- 取りに行くもの ---


async def test_tiles_are_fetched_at_the_zooms_the_source_has_data_for(fake_redis):
    source = Source()

    await _run(source)

    assert {_tile_parts(p)["z"] for p in source.tile_requests("rain_mesh")} == {4, 6, 8, 10}


# --- 在否インデックス ---


async def test_the_index_lists_the_tiles_that_have_something_to_draw(fake_redis):
    """中身のあるタイルだけを載せる。空タイル・取れなかったタイルは載せない。"""
    source = Source(tiles={
        "/surf/rain_mesh/4/": (OPAQUE, "image/png"),
        "/surf/rain_mesh/6/": UPSTREAM_NOT_FOUND,
        "/surf/flood/4/": UPSTREAM_NOT_FOUND,
        "/surf/land/4/": None,
    })

    await _run(source)

    payload = await _stored()
    rain_mesh = payload["elements"]["rain_mesh"]
    parts = [_tile_parts(p) for p in source.tile_requests("rain_mesh")]
    z4 = sorted([part["x"], part["y"]] for part in parts if part["z"] == 4)
    assert sorted(rain_mesh["zooms"]["4"]) == z4
    assert "6" not in rain_mesh["zooms"]
    assert payload["elements"]["flood"]["zooms"] == {}
    assert payload["elements"]["land"]["zooms"] == {}


async def test_a_zoom_filled_from_its_parent_is_listed_wherever_the_parent_has_something(fake_redis):
    """補間で埋めるズームを載せないと、クライアントはそこを空と見なして取りに来ず、補間が一度も動かない。"""
    source = Source(tiles={"/surf/rain_mesh/4/": (OPAQUE, "image/png")})

    await _run(source)

    zooms = (await _stored())["elements"]["rain_mesh"]["zooms"]
    assert zooms["4"] == [[14, 6]]
    assert sorted(zooms["5"]) == [[28, 12], [28, 13], [29, 12], [29, 13]]
    assert "7" not in zooms  # 親の6に中身が無い


async def test_the_index_says_which_frame_and_which_area_it_describes(fake_redis):
    """クライアントは自分が描くフレームと一致する要素だけを信用し、範囲の外は従来どおり取りに行く。"""
    await _run(Source())

    payload = await _stored()
    assert payload["elements"]["rasrf"] | {"zooms": None} == {
        "basetime": "20260922000000", "validtime": "20260922020000", "member": "m1", "zooms": None,
    }
    assert BoundingBox(**payload["coverage"]) == AREA


# --- 時刻一覧が取れないとき ---


async def test_elements_whose_time_list_cannot_be_read_are_skipped_with_a_warning(fake_redis, caplog):
    target_times = _target_times()
    target_times[RISK] = None
    source = Source(target_times=target_times)

    with caplog.at_level(logging.WARNING, logger="ridecompass.jma_tile_prewarm_service"):
        await _run(source)

    assert not any(source.tile_requests(element) for element in RISK_ELEMENTS)
    assert set((await _stored())["elements"]).isdisjoint(RISK_ELEMENTS)
    assert source.tile_requests("thns")
    warning = next(r.getMessage() for r in caplog.records if r.levelno == logging.WARNING)
    assert all(element in warning for element in RISK_ELEMENTS)
