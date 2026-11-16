"""走りの記録（端末が走行モードの間に溜め、走り終えに送るもの）を GPX 1.1 に直す処理。

端末は欄の名前を毎点くり返さない詰めた形で送り、ここで GPX に直す。GPX の書き方を知るのはこのモジュールだけにする。
点の値は端末が出したままで、止まり・外れ等の解釈は足さない（解釈は、取り出した GPX を読む側がする）。ただし標高の標準の欄は、
走った地点の地形の標高（道の標高と同じ地理院の製品の並び。呼び出し元が引いて渡す）にする——端末の GPS の高さは誤差が大きく、
地図と道の標高と食い違う。地形の標高が無い点（取り込んだ範囲の外）は端末の高さにし、端末の高さはどの点も自前の欄に残す。

GPX の置き場:
- 時刻・緯度経度・標高（地形の標高）は GPX 1.1 の標準の欄（`http://www.topografix.com/GPX/1/1`）。
- 端末の速さ（m/s）と進む向き（真北からの度）は Garmin の `TrackPointExtension` v2 の `speed`・`course`。
- 端末の高さ・位置と標高の誤差（m）・走りの出来事・画面とサーバーの版・端末の名前は GPX にも Garmin の拡張にも置き場が無いので、自前の名前空間
  （`RIDE_NAMESPACE`）に入れる。
- 走りを休む（`rest`）と点が途切れるので、休むごとに `trkseg` を分ける。
"""

from bisect import bisect_right
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone
from xml.etree import ElementTree as ET

from app.domain.ride_track import RideUpload

GPX_NAMESPACE = "http://www.topografix.com/GPX/1/1"
TRACK_POINT_EXTENSION_NAMESPACE = "http://www.garmin.com/xmlschemas/TrackPointExtension/v2"
RIDE_NAMESPACE = "urn:ridecompass:gpx:ride:1"

# 書き出す GPX の接頭辞（`ElementTree`はプロセスに1つの表で持つ）。
ET.register_namespace("", GPX_NAMESPACE)
ET.register_namespace("gpxtpx", TRACK_POINT_EXTENSION_NAMESPACE)
ET.register_namespace("rc", RIDE_NAMESPACE)


def _q(namespace: str, name: str) -> str:
    return f"{{{namespace}}}{name}"


def _time(at: datetime) -> str:
    text = at.isoformat(timespec="milliseconds" if at.microsecond else "seconds")
    return text.replace("+00:00", "Z")


def _scaled(value: int, digits: int) -> str:
    """端末が`10**digits`倍の整数で送った値を、送った桁のまま小数で書く（有効桁で丸めると緯度経度の下の桁が落ちる）。"""
    return f"{value / 10**digits:.{digits}f}"


def ride_gpx(upload: RideUpload, *, server_commit: str | None, ground_elevation_m: Sequence[float | None]) -> str:
    """走り1回を GPX 1.1 の文字にする。受けたサーバーの版（`server_commit`）を先頭の情報に添える（道路網の世代は推したルートの候補が持つ）。
    `ground_elevation_m`は点ごとの地形の標高（m。`upload.points`と同じ並びで、無い点はNone）。"""
    start = upload.started_at.astimezone(timezone.utc)

    root = ET.Element(_q(GPX_NAMESPACE, "gpx"), {"version": "1.1", "creator": "RideCompass"})
    metadata = ET.SubElement(root, _q(GPX_NAMESPACE, "metadata"))
    ET.SubElement(metadata, _q(GPX_NAMESPACE, "time")).text = _time(start)
    extensions = ET.SubElement(metadata, _q(GPX_NAMESPACE, "extensions"))
    versions = {"app": upload.app_version, "server": server_commit}
    app = {name: value for name, value in versions.items() if value is not None}
    ET.SubElement(extensions, _q(RIDE_NAMESPACE, "versions"), app)
    ET.SubElement(extensions, _q(RIDE_NAMESPACE, "device")).text = upload.device
    events = ET.SubElement(extensions, _q(RIDE_NAMESPACE, "events"))
    for at_ms, kind, route_key in upload.events:
        attributes = {"time": _time(start + timedelta(milliseconds=at_ms)), "type": kind}
        if route_key is not None:
            attributes["route"] = route_key
        ET.SubElement(events, _q(RIDE_NAMESPACE, "event"), attributes)

    rests = sorted(at_ms for at_ms, kind, _route in upload.events if kind == "rest")
    track = ET.SubElement(root, _q(GPX_NAMESPACE, "trk"))
    segment = None
    segment_rests = -1
    for (at_ms, lat, lon, ele, accuracy, speed, course, ele_accuracy), ground_m in zip(
            upload.points, ground_elevation_m, strict=True):
        rests_before = bisect_right(rests, at_ms)
        if segment is None or rests_before != segment_rests:
            segment = ET.SubElement(track, _q(GPX_NAMESPACE, "trkseg"))
            segment_rests = rests_before
        point = ET.SubElement(segment, _q(GPX_NAMESPACE, "trkpt"), {"lat": _scaled(lat, 6), "lon": _scaled(lon, 6)})
        if ground_m is not None:
            ET.SubElement(point, _q(GPX_NAMESPACE, "ele")).text = f"{ground_m:.1f}"
        elif ele is not None:
            ET.SubElement(point, _q(GPX_NAMESPACE, "ele")).text = _scaled(ele, 1)
        ET.SubElement(point, _q(GPX_NAMESPACE, "time")).text = _time(start + timedelta(milliseconds=at_ms))
        if speed is None and course is None and accuracy is None and ele_accuracy is None and ele is None:
            continue
        point_extensions = ET.SubElement(point, _q(GPX_NAMESPACE, "extensions"))
        if speed is not None or course is not None:
            garmin = ET.SubElement(point_extensions, _q(TRACK_POINT_EXTENSION_NAMESPACE, "TrackPointExtension"))
            if speed is not None:
                ET.SubElement(garmin, _q(TRACK_POINT_EXTENSION_NAMESPACE, "speed")).text = _scaled(speed, 2)
            if course is not None:
                ET.SubElement(garmin, _q(TRACK_POINT_EXTENSION_NAMESPACE, "course")).text = str(course)
        if accuracy is not None:
            ET.SubElement(point_extensions, _q(RIDE_NAMESPACE, "accuracy")).text = _scaled(accuracy, 1)
        if ele is not None:
            ET.SubElement(point_extensions, _q(RIDE_NAMESPACE, "deviceAltitude")).text = _scaled(ele, 1)
        if ele_accuracy is not None:
            ET.SubElement(point_extensions, _q(RIDE_NAMESPACE, "altitudeAccuracy")).text = _scaled(ele_accuracy, 1)
    return ET.tostring(root, encoding="unicode", xml_declaration=True)
