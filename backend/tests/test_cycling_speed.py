"""`domain/cycling_speed.py`——平地・無風の巡航速度から出力を逆算し、勾配・風・路面から区間ごとの速度を解く走行モデル。

入口は`RiderProfile`・`wheel_power_w`・`climb_power_w`・`top_speed_kmh`・`SegmentSpeedModel`（`speed_ms`）・`crr_for_surface`。
期待値は走行方程式（公開の物理）と、モデルが約束する性質（平地・無風なら巡航速度に戻る・向かい風で遅くなる・上下限で止まる）から書く。

ここで見ないもの:
- 区間の勾配・路面・停止の待ちを走行モデルへ渡し、所要時間を合成すること → `test_leg_costs.py`
- 風を進行方向の成分と横成分へ分けること → `test_wind.py`
"""

from unittest.mock import patch

import numpy as np
import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.domain import cycling_speed
from app.domain.attributes import CategoricalColumn
from app.domain.cycling_speed import RiderProfile, SegmentSpeedModel
from app.domain.tuning import TUNING_VALUES
from app.domain.route_request import MAX_ASSUMED_SPEED_KMH, MIN_ASSUMED_SPEED_KMH
from tests.road_class_fixture import classification, replaced_road_classes, road_classes

# 二分法が詰める幅（下限〜上限を12回半分にした幅）より広く、速度の違いとして意味のある差より狭い許容。
SOLVE_TOLERANCE_MS = 0.005


def _kmh(name: str) -> float:
    return cycling_speed.tuning_value(name) / 3.6


def _rider(cruise_speed_kmh: float, **standard: float) -> RiderProfile:
    """標準値（`cda_m2`・`crr`・`mass_kg`）を、管理画面から変えるのと同じ較正値で変えて作る。"""
    with patch.dict(TUNING_VALUES, {f"speed.{name}": value for name, value in standard.items()}):
        return RiderProfile(cruise_speed_kmh=cruise_speed_kmh)


def _speed(profile: RiderProfile, grade: float = 0.0, headwind: float = 0.0, crosswind: float = 0.0,
           crr: float | None = None) -> float:
    model = SegmentSpeedModel(profile, np.array([grade]), np.array([profile.crr if crr is None else crr]))
    return float(model.speed_ms(np.array([headwind]), np.array([crosswind]))[0])


def test_the_power_of_a_rider_cruising_at_20kmh_is_that_of_an_easy_ride():
    """CdA 0.32m²・Crr 0.005・総質量80kgで20km/hを保つ出力は、走行方程式で約55W（趣味の自転車のゆっくりした巡航）。"""
    profile = _rider(20.0, cda_m2=0.32, crr=0.005, mass_kg=80.0)

    assert cycling_speed.wheel_power_w(profile) == pytest.approx(55.4, abs=0.5)


def test_the_standard_values_follow_the_values_changed_from_the_admin_screen(monkeypatch):
    """標準値は作るたびに読む。管理画面から変えた値が、プロセスを入れ替えずに次の生成から効く。"""
    monkeypatch.setitem(TUNING_VALUES, "speed.cda_m2", 0.5)
    monkeypatch.setitem(TUNING_VALUES, "speed.crr", 0.02)
    monkeypatch.setitem(TUNING_VALUES, "speed.mass_kg", 100.0)

    profile = RiderProfile(cruise_speed_kmh=20.0)

    assert (profile.cda_m2, profile.crr, profile.mass_kg) == (0.5, 0.02, 100.0)


profiles = st.builds(
    _rider,
    # ルート生成の要求が受け付ける巡航速度の全範囲（下りの上限より速い巡航を含む）。
    cruise_speed_kmh=st.floats(min_value=MIN_ASSUMED_SPEED_KMH, max_value=MAX_ASSUMED_SPEED_KMH),
    cda_m2=st.floats(min_value=0.2, max_value=0.6),
    crr=st.floats(min_value=0.002, max_value=0.02),
    mass_kg=st.floats(min_value=50.0, max_value=150.0),
)
grades = st.floats(min_value=-0.3, max_value=0.3)
winds = st.floats(min_value=-20.0, max_value=20.0)


@given(profile=profiles)
def test_on_the_flat_without_wind_the_rider_rides_at_the_cruise_speed(profile):
    """出力は平地・無風の巡航速度から逆算したものなので、同じ条件へ戻せば巡航速度で走る。"""
    assert _speed(profile) == pytest.approx(profile.cruise_speed_ms, abs=SOLVE_TOLERANCE_MS)


@given(profile=profiles, grade=grades, headwind=winds, crosswind=winds)
def test_the_speed_stays_between_walking_and_the_top_speed(profile, grade, headwind, crosswind):
    """急な登りや強い向かい風でも押して歩く速度より遅くならず、急な下りでも上限を超えない（所要時間が発散しない）。
    探索の所要時間の下界（`domain/route_search.py: heuristic_seconds`）も、この上限で割る。"""
    speed = _speed(profile, grade, headwind, crosswind)
    top_ms = cycling_speed.top_speed_kmh(profile.cruise_speed_kmh) / 3.6

    assert _kmh("speed.walking_kmh") - SOLVE_TOLERANCE_MS <= speed <= top_ms + SOLVE_TOLERANCE_MS


RIDER = RiderProfile(cruise_speed_kmh=20.0)


def test_the_same_headwind_takes_a_larger_share_from_a_slower_rider():
    """向かい風5m/sで、巡航20km/hの人は42%、30km/hの人は33%落ちる（向かい風への強さの差は巡航速度の差として式から出る）。"""
    for cruise_kmh, share in ((20.0, 0.42), (30.0, 0.33)):
        rider = _rider(cruise_kmh, cda_m2=0.32, crr=0.005, mass_kg=80.0)

        assert 1 - _speed(rider, headwind=5.0) / rider.cruise_speed_ms == pytest.approx(share, abs=0.01)


def test_a_crosswind_slows_the_rider_less_than_a_headwind_of_the_same_strength():
    """横風は相対風速の大きさにだけ効く。"""
    calm = _speed(RIDER)
    crosswind = _speed(RIDER, crosswind=5.0)
    headwind = _speed(RIDER, headwind=5.0)

    assert headwind < crosswind < calm


def test_a_climb_adds_the_declared_watts_per_percent_whatever_the_flat_power():
    """管理画面の「登りの出力の増え方」（W/%）のとおり、勾配2%なら値の2倍のWを足す。平地の出力に比例させると、
    巡航が速い人ほど坂で平地並みの速度を保ち、所要時間が短く出る。"""
    flat_power_w = 60.0
    power = cycling_speed.climb_power_w(flat_power_w, np.array([0.02]))

    assert power[0] - flat_power_w == pytest.approx(2 * cycling_speed.tuning_value("speed.climb_power_per_grade"))


@pytest.mark.parametrize(
    ("grade", "limit"),
    [
        (-0.3, "speed.max_descent_kmh"),  # 急な下りは上限で止まる
        (0.3, "speed.walking_kmh"),  # 急な登りは押して歩く
    ],
)
def test_the_limits_follow_the_values_changed_from_the_admin_screen(monkeypatch, grade, limit):
    """上下限は値をそのまま読み返せないので、頭打ちになる入力を通して、変えた値で止まることを見る。"""
    changed = TUNING_VALUES[limit] * 0.8
    monkeypatch.setitem(TUNING_VALUES, limit, changed)

    assert _speed(RIDER, grade=grade) == pytest.approx(changed / 3.6, abs=SOLVE_TOLERANCE_MS)


@pytest.mark.parametrize(
    "call",
    [
        lambda: SegmentSpeedModel(RIDER, np.zeros(3), np.zeros(1)),
        lambda: SegmentSpeedModel(RIDER, np.zeros(3), np.zeros(3)).speed_ms(np.zeros(1), np.zeros(3)),
    ],
)
def test_arrays_of_different_lengths_are_refused_instead_of_spread_over_every_segment(call):
    """長さの違う配列は区間の番号で読み違える。1区間の値が別の区間に効く前に断る。"""
    with pytest.raises(ValueError):
        call()


def test_the_rolling_resistance_of_a_road_follows_the_value_of_its_class_and_the_base_value_elsewhere(monkeypatch):
    """管理画面で変えた区分の値が所要時間に効く。区分の外の道・表に無い区分・宣言に無い較正値は、走れないとせず
    基準の転がり抵抗で走る（区分を足し替えるたびに経路が作れなくなると困る）。"""
    monkeypatch.setitem(TUNING_VALUES, "speed.crr_gravel", 0.0421)
    definitions = road_classes(
        {"surface": classification({"rough": [], "smooth": [], "unknown_id": []})},
        rolling_resistance_classification="surface",
        rolling_resistance_classes={"surface": {"rough": "speed.crr_gravel", "unknown_id": "no_such_tuning"}},
    )
    base = TUNING_VALUES[cycling_speed.BASE_CRR_ID]

    with replaced_road_classes(definitions):
        crr = cycling_speed.crr_for_surface(CategoricalColumn.encode(["rough", "smooth", "unknown_id", None]))

    assert crr.tolist() == [0.0421, base, base, base]
