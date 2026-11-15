"""`domain/ride_track.py`——端末が送った走りを GPX 1.1 に直す。

開発機の較正の道具は、この GPX を GPX 1.1 の標準の欄（時刻・緯度経度・標高）と Garmin の `TrackPointExtension` で読む。
ここでは、出した GPX を XML として読み戻し、端末の詰めた値が単位どおりの値で標準と拡張の欄に入ることと、標準の標高の欄が
地形の標高（無い点は端末の高さ）になり、端末の高さが自前の欄に残ることを見る。

ここで見ないもの: 受ける口の鍵と、表に1行書くこと・地形の標高を DB から引くこと → `test_ride_track_routes.py`
"""

from uuid import uuid4
from xml.etree import ElementTree as ET

from app.domain.ride_track import (
    GPX_NAMESPACE,
    RIDE_NAMESPACE,
    TRACK_POINT_EXTENSION_NAMESPACE,
    RideUpload,
    ride_gpx,
)

NS = {"g": GPX_NAMESPACE, "tpx": TRACK_POINT_EXTENSION_NAMESPACE, "rc": RIDE_NAMESPACE}


def _upload(**overrides) -> RideUpload:
    values = {
        "id": uuid4(),
        "started_at": "2026-11-16T09:12:03+09:00",
        "app_version": "c4325cc",
        "device": "iPhone / Safari <26>",
        "points": [
            [1000, 35681234, 139767124, 124, 43, 555, 87, 52],
            [2500, 35681270, 139767180, None, None, None, None, None],
            [4089000, 35690000, 139770000, 130, 50, 610, 90, None],
        ],
        "events": [
            [0, "start", None],
            [3217000, "rest", None],
            [4088000, "resume", None],
            [4677000, "route", "b"],
            [10252000, "end", None],
        ],
        "routes": {},
        "conditions": {},
        "forecasts": [],
    }
    return RideUpload.model_validate(values | overrides)


#: `_upload`の点ごとの地形の標高。1つ目は地形の標高がある点、2つ目・3つ目は無い点。
GROUND = [21.04, None, None]


def test_points_land_in_the_standard_and_garmin_fields_split_at_each_rest():
    """点は走り始めからの時刻を UTC の時刻に直し、緯度経度・標高・速さ・向き・誤差を単位どおりの値で書く。
    標準の標高の欄は地形の標高で、無い点は端末の高さ。端末の高さは自前の欄に残す。端末が出さなかった値の欄は書かない。
    休むごとに区切り（`trkseg`）を分ける。"""
    root = ET.fromstring(ride_gpx(_upload(), server_commit="abc1234", ground_elevation_m=GROUND))

    segments = root.findall("g:trk/g:trkseg", NS)
    assert [len(segment.findall("g:trkpt", NS)) for segment in segments] == [2, 1]
    first, bare = segments[0].findall("g:trkpt", NS)
    assert (first.get("lat"), first.get("lon")) == ("35.681234", "139.767124")
    assert first.findtext("g:ele", namespaces=NS) == "21.0"
    assert first.findtext("g:extensions/rc:deviceAltitude", namespaces=NS) == "12.4"
    assert first.findtext("g:time", namespaces=NS) == "2026-11-16T00:12:04Z"
    assert first.findtext("g:extensions/tpx:TrackPointExtension/tpx:speed", namespaces=NS) == "5.55"
    assert first.findtext("g:extensions/tpx:TrackPointExtension/tpx:course", namespaces=NS) == "87"
    assert first.findtext("g:extensions/rc:accuracy", namespaces=NS) == "4.3"
    assert first.findtext("g:extensions/rc:altitudeAccuracy", namespaces=NS) == "5.2"
    assert bare.findtext("g:time", namespaces=NS) == "2026-11-16T00:12:05.500Z"
    assert bare.find("g:ele", NS) is None and bare.find("g:extensions", NS) is None
    (later,) = segments[1].findall("g:trkpt", NS)
    assert later.findtext("g:ele", namespaces=NS) == "13.0"


def test_the_head_carries_the_events_versions_and_device():
    """先頭の情報に、走りの出来事（時刻と種類、替えた先のルート）・画面とサーバーの版・端末の名前を書く。"""
    root = ET.fromstring(ride_gpx(_upload(), server_commit="abc1234", ground_elevation_m=GROUND))
    head = root.find("g:metadata", NS)

    assert head.findtext("g:time", namespaces=NS) == "2026-11-16T00:12:03Z"
    assert head.find("g:extensions/rc:versions", NS).attrib == {"app": "c4325cc", "server": "abc1234"}
    assert head.findtext("g:extensions/rc:device", namespaces=NS) == "iPhone / Safari <26>"
    events = [event.attrib for event in head.findall("g:extensions/rc:events/rc:event", NS)]
    assert events[0] == {"time": "2026-11-16T00:12:03Z", "type": "start"}
    assert events[3] == {"time": "2026-11-16T01:30:00Z", "type": "route", "route": "b"}
    assert [event["type"] for event in events] == ["start", "rest", "resume", "route", "end"]
