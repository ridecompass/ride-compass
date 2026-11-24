"""時刻で変わる交通規制を、探索の範囲の区間へ時間帯ごとに当てる（ルート生成のレグの判定）。

規制が当たった区間について、時間帯（レグの見込みの時間帯を前後に較正値`regulation.margin_minutes`広げた間）に効く組から区分の材料
`pedestrian_road`の値を決め直し、その区間だけ区分の列・地図の線の層の値・避け方（探索から除くか・費用の倍率）を作り直す。時間帯の
どこかで一度でも効く組は、その時間帯の間ずっと効くとみなす（規制が効く側に倒す）。同じ区間で、普通自転車も対象の規制と除外の
規制が両方効くときは、2つの値のそれぞれで避け方を求め、倍率の大きい側を採る。
"""

from collections.abc import Mapping
from dataclasses import dataclass, replace
from datetime import datetime

import numpy as np

from app.domain.attributes import CategoricalColumn, MaterialColumn
from app.domain.material_catalog import PEDESTRIAN_ROAD
from app.domain.road_avoidance import AvoidanceLevel, RoadAvoidanceMasks, road_avoidance_masks
from app.domain.road_classes import RoadClassDefinitions, class_columns, fact_keys, layer_columns
from app.domain.road_network import RoadNetwork
from app.domain.traffic_regulation import (
    BICYCLE_EXCEPTED,
    BICYCLE_PROHIBITED,
    PEDESTRIAN_ROAD_LABELS,
    active_kinds,
    active_slots,
)

_VOCAB = (None, *PEDESTRIAN_ROAD_LABELS)
_PROHIBITED, _EXCEPTED = _VOCAB.index(BICYCLE_PROHIBITED), _VOCAB.index(BICYCLE_EXCEPTED)


@dataclass(frozen=True)
class RegulationJudgement:
    """時間帯1つの規制の判定。`key`は効いている組の集まりで、同じ鍵の判定は同じ避け方になる（レグの使い回しの鍵に入る）。
    `masks`は探索の範囲の全区間の避け方。`layers`は規制の当たった区間（切り出した区間の順の行`rows`）の、地図の線の層の値。"""

    key: bytes
    masks: RoadAvoidanceMasks
    rows: np.ndarray
    layers: dict[str, CategoricalColumn]

    def layer_values_at(self, row: int) -> dict[str, str | None] | None:
        """切り出した区間の順の行`row`の地図の線の層の値。規制の当たらない区間はNone（道路網の値のまま）。"""
        position = int(np.searchsorted(self.rows, row))
        if position >= len(self.rows) or self.rows[position] != row:
            return None
        return {key: column.value_at(position) for key, column in self.layers.items()}


class TimedRegulations:
    """探索の範囲（切り出した区間の順）のうち、規制が当たった区間の判定を時間帯ごとに作る。"""

    def __init__(self, network: RoadNetwork, network_rows: np.ndarray, facts: Mapping[str, MaterialColumn],
                 base_masks: RoadAvoidanceMasks, hard_filtered: np.ndarray, definitions: RoadClassDefinitions,
                 levels: Mapping[str, AvoidanceLevel], multipliers: Mapping[AvoidanceLevel, float]) -> None:
        """`network_rows`は切り出した区間の道路網の行、`facts`は材料の列（切り出した区間の順。区分の条件が読む事実だけを引く）。"""
        self._network = network
        counts = np.asarray(network.edge_regulation_count, dtype=np.int64)[np.asarray(network_rows, dtype=np.int64)]
        self.rows = np.flatnonzero(counts > 0)
        self._network_rows = np.asarray(network_rows, dtype=np.int64)[self.rows]
        self._facts = {key: column.take(self.rows) if isinstance(column := facts[key], CategoricalColumn)
                       else np.asarray(column)[self.rows] for key in fact_keys(definitions)}
        self._base_masks = base_masks
        self._hard_filtered = np.asarray(hard_filtered, dtype=bool)[self.rows]
        self._definitions = definitions
        self._levels = levels
        self._multipliers = multipliers
        self._cache: dict[bytes, RegulationJudgement] = {}

    def judge(self, start: datetime, end: datetime) -> RegulationJudgement | None:
        """`start`〜`end`（広げる幅を足したあとの時間帯）の判定。規制の当たった区間が無ければNone。"""
        if len(self.rows) == 0:
            return None
        active = active_slots(self._network.regulation_slot_values, start, end)
        key = np.packbits(active).tobytes()
        cached = self._cache.get(key)
        if cached is None:
            cached = self._cache[key] = self._judge(key, active)
        return cached

    def _judge(self, key: bytes, active: np.ndarray) -> RegulationJudgement:
        network = self._network
        bicycle, excepted = active_kinds(
            self._network_rows, network.edge_regulation_start, network.edge_regulation_count, network.regulation_index,
            network.regulation_slot_start, network.regulation_slot_count, network.regulation_slot_values, active)
        n = len(self.rows)
        variants = []
        # 両方効く区間は、変種ごとに片方の値を採る。片方だけ効く区間は、どちらの変種も同じ値になる。
        for codes in (np.where(bicycle, _PROHIBITED, np.where(excepted, _EXCEPTED, 0)),
                      np.where(excepted, _EXCEPTED, np.where(bicycle, _PROHIBITED, 0))):
            facts = {**self._facts, PEDESTRIAN_ROAD: CategoricalColumn(codes.astype(np.int16), _VOCAB)}
            classes = class_columns(self._definitions, facts, n)
            variants.append((facts, classes, road_avoidance_masks(classes, self._levels, self._multipliers, n)))
        (facts, classes, strict), (_, _, other) = variants
        # 倍率の大きい側を採る（通らないは無限大で、どちらかが通らないなら通らない）。
        take_other = ~strict.excluded & (other.excluded | (other.cost_scale > strict.cost_scale))
        excluded = strict.excluded | other.excluded
        base = self._base_masks
        full_excluded, full_scale, full_deciding = base.excluded.copy(), base.cost_scale.copy(), base.deciding_row.copy()
        full_excluded[self.rows] = excluded | self._hard_filtered
        full_scale[self.rows] = np.where(excluded, 1.0, np.where(take_other, other.cost_scale, strict.cost_scale))
        full_deciding[self.rows] = np.where(take_other, other.deciding_row, strict.deciding_row)
        return RegulationJudgement(
            key=key, masks=replace(base, excluded=full_excluded, cost_scale=full_scale, deciding_row=full_deciding),
            rows=self.rows, layers=layer_columns(self._definitions, {**facts, **classes}, n))


#: 最後に求めた道路網と、その規制の当たった行。道路網は入れ替えのたびに別のオブジェクトになるので、同じオブジェクトなら求め直さない。
_regulated: tuple[RoadNetwork, np.ndarray] | None = None


def _regulated_rows(network: RoadNetwork) -> np.ndarray:
    global _regulated
    cached = _regulated
    if cached is not None and cached[0] is network:
        return cached[1]
    rows = np.flatnonzero(np.asarray(network.edge_regulation_count) > 0)
    _regulated = (network, rows)
    return rows


def regulated_rows_within(network: RoadNetwork, min_lon: float, min_lat: float, max_lon: float, max_lat: float) -> np.ndarray:
    """外接矩形が範囲に交わる、規制の当たった区間の道の、規制の当たった全部の区間の行（昇順）。道1本の値は、範囲の外の区間の
    規制にも依る。"""
    rows = _regulated_rows(network)
    overlaps = ((np.asarray(network.edge_min_lon)[rows] <= max_lon) & (np.asarray(network.edge_max_lon)[rows] >= min_lon)
                & (np.asarray(network.edge_min_lat)[rows] <= max_lat) & (np.asarray(network.edge_max_lat)[rows] >= min_lat))
    ways = np.asarray(network.edge_way_id)[rows]
    return rows[np.isin(ways, ways[overlaps])]


def regulation_variant(network: RoadNetwork, rows: np.ndarray, at: datetime) -> str:
    """区間の行`rows`に当たった規制の組のうち、時刻`at`に効いているものの印（同じ印なら、`rows`の区分は同じ）。行が無ければ空。"""
    if len(rows) == 0:
        return ""
    counts = np.asarray(network.edge_regulation_count, dtype=np.int64)[rows]
    starts = np.asarray(network.edge_regulation_start, dtype=np.int64)[rows]
    positions = np.repeat(starts, counts) + (np.arange(int(counts.sum())) - np.repeat(np.cumsum(counts) - counts, counts))
    regulations = np.unique(np.asarray(network.regulation_index, dtype=np.int64)[positions])
    slot_count = np.asarray(network.regulation_slot_count, dtype=np.int64)[regulations]
    slot_start = np.asarray(network.regulation_slot_start, dtype=np.int64)[regulations]
    slots = np.repeat(slot_start, slot_count) + (np.arange(int(slot_count.sum()))
                                                - np.repeat(np.cumsum(slot_count) - slot_count, slot_count))
    active = active_slots(np.asarray(network.regulation_slot_values)[slots], at, at)
    return np.packbits(active).tobytes().hex() or "0"


def pedestrian_road_codes_at(network: RoadNetwork, rows: np.ndarray, at: datetime) -> np.ndarray:
    """道路網の行`rows`の、時刻`at`の材料`pedestrian_road`の番号（`PEDESTRIAN_ROAD_LABELS`の並びの語彙）。地図は避け方の段を
    持たないので、自転車も対象の規制と除外の規制が両方効く区間は、自転車も禁止にする。"""
    network_rows = np.asarray(rows, dtype=np.int64)
    active = active_slots(network.regulation_slot_values, at, at)
    bicycle, excepted = active_kinds(
        network_rows, network.edge_regulation_start, network.edge_regulation_count, network.regulation_index,
        network.regulation_slot_start, network.regulation_slot_count, network.regulation_slot_values, active)
    return np.where(bicycle, _PROHIBITED, np.where(excepted, _EXCEPTED, 0)).astype(np.int16)
