"""`app/domain/search_kernels.py`——探索のJITをイメージの組み立てで焼く。

見るもの: 焼いた後の探索がコンパイルしないことと、生成の経路がPythonから呼ぶJITが焼いたものに限られること。
"""
import sys
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest
from numba.core import event
from numba.core.registry import CPUDispatcher

from app.domain import routing, search_kernels
from app.domain.msm import MsmBlock, MsmGrid
from app.domain.wind import WeatherForecastSeries
from tests.route_world import (
    BASE_LAT,
    BASE_LON,
    CENTER,
    NO_POINTS,
    NORTH_EAST,
    SOUTH_WEST,
    at,
    generator_for,
    grid_network,
)
from tests.search_graph_world import build_all, make_grid, out_states


@pytest.mark.jit
def test_searches_compile_nothing_after_baking_whatever_arrays_the_caller_passes():
    """イメージの組み立てで焼いたコンパイル結果（`compile_search_kernels`）は、型の同じ呼び出しにしか効かない。
    探索の入口が型を揃えるため、呼び出し側の配列のdtype・並び・読み取り専用かに依らず、焼いた後の探索は
    コンパイルしない——本番の最初のルート生成がコンパイルを払わない。

    コンパイルはnumbaの出来事（`numba:compile`）で数える。ディスクのキャッシュから読んだ型は出来事を出さないが、
    キャッシュはJITを定義したファイルを書き換えると無効になるため、型を揃え損ねた変更は最初の実行でここに出る。"""
    search_kernels.compile_search_kernels()
    lazy, statics, structure = build_all(make_grid(3))
    state_count = structure.state_count
    read_only = np.ones((2, state_count))
    read_only.flags.writeable = False
    costs = [
        np.ones(state_count, dtype=np.float32),
        np.ones((state_count, 2)).T,  # C順でない
        read_only,
    ]
    origin_states = out_states(lazy, "n0_0").astype(np.int32)
    with event.install_recorder("numba:compile") as compiled:
        for cost in costs:
            routing.build_turn_expanded_tree(
                structure, cost, statics.edge_length_m.astype(np.float32), origin_states, lazy.node_count,
                edge_seconds=cost, bin_seconds=3600.0, transition_cost=structure.turn_seconds
            )
            routing.turn_expanded_shortest_path(
                structure, cost, np.zeros(lazy.node_count, dtype=np.float32), origin_states,
                lazy.node_id_to_index["n2_2"], edge_seconds=cost, bin_seconds=3600.0, transition_cost=structure.turn_seconds
            )
        routing.build_turn_expanded_tree(
            structure, costs[0], statics.edge_length_m, origin_states, lazy.node_count,
            reverse=True, edge_seconds=costs[0], transition_cost=structure.turn_seconds
        )

    assert compiled.buffer == []


@pytest.mark.jit
async def test_route_generation_calls_from_python_only_the_jit_that_the_image_bakes(monkeypatch, road_network_root):
    """イメージに焼くのは`compile_search_kernels`がPythonから呼ぶJITだけ。生成の経路がPythonからそれ以外のJIT
    （探索の中へ展開する部品等）を呼ぶと、コンテナの最初の生成がそのコンパイルを払う。

    `app`の全モジュールが持つJITの関数を、Pythonからの呼び出しを記録する包みへ差し替えて数える。探索の中から
    の呼び出しはコンパイル済みの本体どうしで結ばれ、包みを通らない。"""
    search_kernels.compile_search_kernels()  # 包む前に本体を用意する（包んだ後にコンパイルすると、部品の代わりに包みを読む）
    network = grid_network()  # 道路網を組むのは派生の作り直しで、生成の経路ではないので、数える前に組む
    called: set[str] = set()

    def recording(name, dispatcher):
        def call(*args, **kwargs):
            called.add(name)
            return dispatcher(*args, **kwargs)
        return call

    for module in [m for name, m in sys.modules.items() if name == "app" or name.startswith("app.")]:
        for attr, value in list(vars(module).items()):
            if isinstance(value, CPUDispatcher):
                monkeypatch.setattr(module, attr, recording(value.py_func.__qualname__, value))
    search_kernels.compile_search_kernels()
    baked, called = called, set()

    times = [datetime(2026, 9, 22, h) for h in range(24)]
    speed = np.full((4, len(times)), 3.0)
    wind = WeatherForecastSeries(
        times=times, speed_ms=speed, direction_deg=np.zeros_like(speed), temperature_c=np.full_like(speed, 15.0),
        lattice=MsmBlock(
            grid=MsmGrid(lat_min=BASE_LAT, lon_min=BASE_LON, d_lat=0.018, d_lon=0.022, n_lat=2, n_lon=2), row0=0, col0=0, rows=2, cols=2,
        ),
        latest_run_end=times[-1] + timedelta(hours=1),
    )
    generator = generator_for(road_network_root, network, wind)
    departure = datetime(2026, 9, 22, 8, tzinfo=timezone(timedelta(hours=9)))
    assert (await generator.generate_loops(
            at(CENTER), 4.0, 1.5, points=NO_POINTS, max_routes=3, start_time=departure)).candidates
    assert (await generator.generate_via_waypoints(
        at(SOUTH_WEST), [], destination=at(NORTH_EAST), max_routes=3, start_time=departure)).candidates

    assert called and called <= baked
