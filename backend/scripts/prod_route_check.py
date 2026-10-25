"""本番のbackendでルートを1本作り、レンズで塗る値がルートの区間に載っているかを見る
（`.github/workflows/deploy-backend.yml`がデプロイのあとに、`.github/workflows/prod-route-check.yml`が1日1回呼ぶ）。

    python backend/scripts/prod_route_check.py

利用者の画面と同じAPIを外から通す: 軸カタログを1回 → 画面の既定の条件で生成を1回 → 終わるまで結果を聞く →
候補どうしを乗り換えた経路の評価を1回 → 終わるまで結果を聞く。
候補が0件か、カタログのどれかの軸について、候補1のどの区間もその軸のレンズが塗る値を持たないか、乗り換えた経路の評価が
返らなければ、理由を出して終了コード1で終わる。本番には書き込まない（生成の結果はbackendのメモリに置かれ、期限が来ると消える）。
何を見るか・上限の根拠は docs/architecture/tech-stack.md「本番でルートを作る確かめ」。
"""

from __future__ import annotations

import json
import sys
import time
import urllib.request
from datetime import datetime
from itertools import permutations
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pydantic import TypeAdapter

from app.domain.map_paint import MapValue
from app.domain.route import RouteSegmentDetail
from app.domain.route_request import ASSUMED_SPEED_KMH, DEFAULT_MAX_ROUTES
from app.domain.time_zone import JST

#: 起点（緯度, 経度）。取込範囲の中の決まった地点で、毎回同じ所を作る。
START_POINT = (35.7597, 139.7387)
DISTANCE_KM = 15.0
#: 最初の生成を頼んでから、乗り換えた経路の評価の結果が出るまで待つ上限（秒）。超えたら失敗にする。
GENERATION_LIMIT_SECONDS = 120
POLL_INTERVAL_SECONDS = 1.0
#: 1回の要求の上限（秒）。backendが応答しないまま止まったときに、待ちの上限を越えて待たない。
REQUEST_TIMEOUT_SECONDS = 30


def generation_request(now: datetime) -> dict:
    """画面の既定の条件（候補数・巡航速度）の生成の要求。既定はbackendの宣言が持ち、画面へは生成物で
    配られる。重み・道の避け方・許容幅は送らず、backendの既定で作らせる。"""
    return {
        "latitude": START_POINT[0],
        "longitude": START_POINT[1],
        "distance_km": DISTANCE_KM,
        "road_avoidance": {},
        "max_routes": DEFAULT_MAX_ROUTES,
        "assumed_speed_kmh": ASSUMED_SPEED_KMH,
        "start_time": now.astimezone(JST).isoformat(timespec="seconds"),
    }


def splice_request(now: datetime, edge_ids: list[str]) -> dict:
    """候補を乗り換えて組んだ経路の評価の要求。画面と同じく、生成の要求に組んだ区間の列を足す。"""
    return {**generation_request(now), "spliced_edge_ids": edge_ids}


def spliced_edge_ids(routes: list[dict]) -> list[str] | None:
    """2本の候補が共に通る途中の地点で、片方の前半ともう片方の後半をつないだ区間の列。どちらの候補とも違う経路になる
    組が無ければNone。前半も後半も出発地を端に持つので、出発地から出て戻る列になる。"""
    for first, second in permutations(routes, 2):
        position_in_second: dict[str, int] = {}
        for index, node in enumerate(second["node_ids"][1:-1], start=1):
            position_in_second.setdefault(node, index)
        for index, node in enumerate(first["node_ids"][1:-1], start=1):
            other = position_in_second.get(node)
            if other is None:
                continue
            head, tail = first["edge_ids"][:index], second["edge_ids"][other:]
            if head != second["edge_ids"][:other] and tail != first["edge_ids"][index:]:
                return head + tail
    return None


def splice_problems(result: dict) -> list[str]:
    """乗り換えた経路の評価のうち、利用者に見える壊れ（評価が返らない）。"""
    if result["routes"]:
        return []
    return [f"乗り換えた経路を評価できない（理由: {result.get('no_candidates_reason')}）"]


_MAP_VALUE: TypeAdapter[MapValue] = TypeAdapter(MapValue)


def problems(catalog: dict, result: dict) -> list[str]:
    """生成の結果のうち、利用者に見える壊れ（候補が無い・レンズで塗ると全区間が「データなし」になる軸）。"""
    routes = result["routes"]
    if not routes:
        return [f"候補が0件（理由: {result.get('no_candidates_reason')}）"]
    segments = [RouteSegmentDetail.model_validate(segment) for segment in routes[0]["segments"]]
    axes = catalog["axes"]
    if not axes:
        return ["軸カタログに軸が無い"]
    found = []
    for axis in axes:
        painted = _MAP_VALUE.validate_python(axis["map_paint"]["value"])
        if all(painted.segment_value(axis["axis_id"], segment) is None for segment in segments):
            found.append(f"「{axis['label']}」（{axis['axis_id']}）: 候補1の区間 {len(segments)} 件のどれにも、レンズが塗る値が無い")
    return found


def _request(method: str, url: str, body: dict | None = None) -> dict:
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
        return json.load(response)


def generate(origin: str, body: dict, deadline: float) -> dict:
    """生成を頼み、終わるまで結果を聞く。失敗・締め切り（`time.monotonic`の値）超えは例外にする。"""
    started = time.monotonic()
    job = _request("POST", f"{origin}/api/routes/generate", body)
    polls = 0
    while True:
        if time.monotonic() > deadline:
            raise RuntimeError(f"生成と乗り換えの評価が{GENERATION_LIMIT_SECONDS}秒で終わらない（この要求の結果を聞いた回数 {polls}）")
        time.sleep(POLL_INTERVAL_SECONDS)
        state = _request("GET", f"{origin}/api/routes/generate/{job['job_id']}")
        polls += 1
        if state["status"] == "done":
            print(f"生成 {time.monotonic() - started:.1f}秒（結果を聞いた回数 {polls}）")
            return state["result"]
        if state["status"] == "failed":
            raise RuntimeError(f"生成が失敗した: {state['error']}")


def main() -> int:
    from _production_origins import production_origin

    backend = production_origin("backend")
    catalog = _request("GET", f"{backend}/api/axis-catalog")
    now = datetime.now(JST)
    deadline = time.monotonic() + GENERATION_LIMIT_SECONDS
    try:
        result = generate(backend, generation_request(now), deadline)
        found = problems(catalog, result)
        edge_ids = spliced_edge_ids(result["routes"])
        if edge_ids is None:
            found.append(f"乗り換えを試せる候補の組が無い（候補 {len(result['routes'])} 件）")
        else:
            found += splice_problems(generate(backend, splice_request(now, edge_ids), deadline))
    except RuntimeError as error:
        found = [str(error)]
    for line in found:
        print(f"失敗: {line}")
    if found:
        return 1
    print(f"通った: 候補 {len(result['routes'])} 件・軸 {len(catalog['axes'])} 本のどれも、候補1の区間に塗る値があり、"
          f"乗り換えた経路（区間 {len(edge_ids)} 本）も評価が返る")
    return 0


if __name__ == "__main__":
    sys.exit(main())
