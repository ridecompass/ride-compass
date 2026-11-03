"""`domain/cycling_speed.py`——平地・無風の巡航速度から出力を逆算し、勾配・風・路面から区間ごとの速度を解く走行モデル。

入口は`RiderProfile`・`wheel_power_w`・`pushed_power_w`・`top_speed_kmh`・`SegmentSpeedModel`（`ride`・`speed_ms`）・`crr_for_surface`。
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
    """向かい風5m/sで、巡航20km/hの人は25%、30km/hの人は23.5%落ちる（増えた空気抵抗のぶん踏み増したうえで、向かい風への
    強さの差は巡航速度の差として式から出る）。"""
    for cruise_kmh, share in ((20.0, 0.247), (30.0, 0.235)):
        rider = _rider(cruise_kmh, cda_m2=0.32, crr=0.005, mass_kg=80.0)

        assert 1 - _speed(rider, headwind=5.0) / rider.cruise_speed_ms == pytest.approx(share, abs=0.01)


def test_a_crosswind_slows_the_rider_less_than_a_headwind_of_the_same_strength():
    """横風は相対風速の大きさにだけ効く。"""
    calm = _speed(RIDER)
    crosswind = _speed(RIDER, crosswind=5.0)
    headwind = _speed(RIDER, headwind=5.0)

    assert headwind < crosswind < calm


def test_more_resistance_adds_the_declared_watts_per_newton_whatever_the_flat_power():
    """管理画面の「抵抗が増えたときの踏み増し」（W/N）のとおり、増えた抵抗に比例してWを足し、上限倍率で止まる。平地の出力に
    比例させると、巡航が速い人ほど坂で平地並みの速度を保ち、所要時間が短く出る。平地より楽なら平地の出力のまま。"""
    flat_power_w = 60.0
    per_newton = cycling_speed.tuning_value("speed.extra_power_per_force")
    ceiling = flat_power_w * cycling_speed.tuning_value("speed.max_climb_power_ratio")

    desired, power = cycling_speed.pushed_power_w(flat_power_w, np.array([10.0, 1000.0, -10.0]))

    assert desired.tolist() == pytest.approx([flat_power_w + 10 * per_newton, flat_power_w + 1000 * per_newton, flat_power_w])
    assert power.tolist() == pytest.approx([flat_power_w + 10 * per_newton, ceiling, flat_power_w])


def _ride(profile: RiderProfile, grade: float = 0.0, headwind: float = 0.0, crr: float | None = None):
    model = SegmentSpeedModel(profile, np.array([grade]), np.array([profile.crr if crr is None else crr]))
    return model.ride(np.array([headwind]), np.array([0.0]))


@pytest.mark.parametrize(
    ("conditions", "pushing"),
    [
        ({"grade": 0.03}, "gravity_extra_w"),
        ({"headwind": 4.0}, "air_extra_w"),
        ({"crr": 0.015}, "rolling_extra_w"),
    ],
    ids=["坂", "向かい風", "路面"],
)
def test_the_rider_pushes_harder_by_the_same_rule_whatever_resistance_grows(conditions, pushing):
    """坂・向かい風・路面のどれで抵抗が増えても、同じ決まりで踏み増し、越えて踏んだ出力はその抵抗の費目に入る。"""
    ride = _ride(RIDER, **conditions)
    parts = {name: float(getattr(ride, name)[0]) for name in ("gravity_extra_w", "air_extra_w", "rolling_extra_w")}

    assert parts[pushing] > 0
    assert all(value == 0 for name, value in parts.items() if name != pushing)
    assert float(ride.desired_ratio[0]) > 1


def test_the_pushed_watts_are_shared_by_the_resistances_that_grew_and_add_up_to_the_whole():
    """坂と向かい風が重なったら、越えて踏んだ出力を増えた抵抗の比で配り、和が実際に踏んだ出力と平地の出力の差になる。"""
    flat_power_w = cycling_speed.wheel_power_w(RIDER)
    ride = _ride(RIDER, grade=0.02, headwind=3.0)
    gravity, air = float(ride.gravity_extra_w[0]), float(ride.air_extra_w[0])
    weight_n = RIDER.mass_kg * 9.80665

    _, power = cycling_speed.pushed_power_w(flat_power_w, np.array([weight_n * 0.02 + air / gravity * weight_n * 0.02]))
    assert gravity + air == pytest.approx(float(power[0]) - flat_power_w)
    assert gravity > 0 and air > 0


def test_a_tailwind_takes_from_the_push_on_a_climb():
    """抵抗の増減は符号つきで足す。追い風の登りは、無風の登りより踏み増しが小さい。"""
    calm = _ride(RIDER, grade=0.03)
    tailwind = _ride(RIDER, grade=0.03, headwind=-3.0)

    assert float(tailwind.gravity_extra_w[0]) < float(calm.gravity_extra_w[0])
    assert float(tailwind.air_extra_w[0]) == 0


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
