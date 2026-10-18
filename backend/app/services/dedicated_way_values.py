"""地図の配信: 公開軸の値を、タイルのフィーチャーごとに探索と同じ評価から求める材料を配る。

値はタイルの材料（`services/feature_materials.py: FeatureMaterialService`）と、軸の葉の材料のうちタイルへ焼けない材料
（時々刻々変わる・向きに依る）を配るサービスの道ごとの材料から、`domain/dynamic_way_values.py: axis_way_values`で求める。
地図へは、要求の条件に依らない道ごとの材料（`domain/dynamic_way_values.py: axis_way_materials`）と、条件から値を求める
式の木（`domain/dynamic_way_values.py: axis_way_value_formula`）を配る。

**軸を名指ししない**——各サービスは自分が返す材料（`material_id`）だけを宣言し、軸との対応は軸の葉の材料から都度引く。
軸はDBの行で増減する（公開済みの軸は複製で改良する）ため、実装が軸の名前を持つと複製した軸が配信されない。
サービスごとにコンストラクタ依存が違うため、生成は`build`の統一シグネチャ越しに行う。
"""

from dataclasses import dataclass, fields
from datetime import datetime
from typing import Callable, Iterable, Mapping, Protocol, Sequence, cast

import numpy as np

from app.domain.axis_definitions import AxisDefinition, BreakpointLinearShape, copy_axis_definitions
from app.domain.dynamic_way_values import (
    FeatureMaterials,
    FeatureSegments,
    MissingConditions,
    ServedMaterialFormula,
    TileWayInputs,
    WayValueConditionName,
    WayValueQuery,
    assemble_conditions,
    axis_way_materials,
    axis_way_value_formula,
    axis_way_values,
    axis_with_dependencies,
    folds_segments,
    leaf_materials,
)
from app.domain.material_catalog import MATERIAL_CATALOG, segment_material_ids
from app.domain.region import EDGE_UNIT_MIN_ZOOM
from app.domain.way_value_formula import FALSE, WayValueFormula, feature_names
from app.infrastructure.road_graph_repository import RoadGraphRepository
from app.services.axis_registry_service import check_loadable_after_write
from app.services.gradient_way_service import GradientWayService
from app.services.rain_way_service import RainWayService
from app.services.weather_service import WeatherService
from app.services.wind_way_service import WindWayService


class DedicatedWayValueService(Protocol):
    """タイルへ焼けない材料の、道ごとの材料をフィーチャーごとに配る実装が満たす形（地図のレンズと区間インスペクタが使う）。

    道ごとの材料は要求の走行方位・想定速度に依らない。材料の値は、道ごとの材料と要求の条件からクラスの
    `material_formula`の木で求める。
    """

    material_id: str

    async def get_way_materials(self, z: int, x: int, y: int, at: datetime | None) -> Mapping[str, Mapping[str, float]]:
        """道ごとの材料の名前→`{フィーチャーの鍵: 値}`（値の無い道は鍵ごと除く）。`at`は時刻に依る材料の時刻（省略すると今）。"""
        ...


class SegmentMaterialService(Protocol):
    """区間ごとに値が違いうる材料（`domain/material_catalog.py: segment_material_ids`）を配る実装が、`DedicatedWayValueService`に
    加えて満たす形。道1本のフィーチャーの値を区間から畳むとき（`paint_folded_feature_values`）に、区間ごとの材料を配る。"""

    def segment_materials(self, segments: FeatureSegments) -> Mapping[str, np.ndarray]:
        """道ごとの材料の名前→`segments`の区間ごとの値（区間と同じ並び。値が無い区間はNaN）。"""
        ...


class DedicatedWayValueServiceType(Protocol):
    """配信の実装のクラスが満たす形。担当する材料・受け取る条件の型・材料の木・組み立てを持つ。"""

    @property
    def material_ids(self) -> tuple[str, ...]: ...

    @property
    def conditions_type(self) -> type: ...

    def material_formula(self, material_id: str) -> ServedMaterialFormula: ...

    def build(
        self, repository: RoadGraphRepository, weather_service: WeatherService, material_id: str
    ) -> DedicatedWayValueService: ...


# 各サービスは担当する材料を`material_ids`で宣言し、`build`は組み立てる材料を`material_id`で受け取る
# （1つの実装が同じ計算の材料群——雨の窓の長さ違い等——をまとめて担当できる）。
DEDICATED_WAY_VALUE_SERVICES: tuple[DedicatedWayValueServiceType, ...] = (
    WindWayService,
    GradientWayService,
    RainWayService,
)


def _leaf_names(formula: ServedMaterialFormula) -> set[str]:
    return feature_names(formula.formula.value) | feature_names(formula.formula.undetermined)


def services_by_material(
    services: Iterable[DedicatedWayValueServiceType],
) -> dict[str, DedicatedWayValueServiceType]:
    """材料id→担当するサービス。1つの材料を2つのサービスが担当していたら起動時に落とす
    ——どちらを選ぶかを黙って決めない。"""
    by_material: dict[str, DedicatedWayValueServiceType] = {}
    for service in services:
        for material_id in service.material_ids:
            if material_id in by_material:
                raise RuntimeError(
                    f"material '{material_id}' is served by more than one dedicated way value service"
                )
            by_material[material_id] = service
    # 区間ごとに値が違いうる材料を配るのに区間の材料の口が無いと、道1本の値を区間から畳む軸の配信が要求のたびに落ちる。
    lacking = sorted(material_id for material_id, service in by_material.items()
                     if material_id in segment_material_ids() and not hasattr(service, "segment_materials"))
    if lacking:
        raise RuntimeError(f"materials {lacking} vary by segment but their service has no segment_materials")
    # 道ごとの材料は名前で1つの列に集まる。別の材料の葉と同じ名前・自分のでない材料idと同じ名前だと、別の値を読む。
    owner: dict[str, str] = {}
    for material_id, service in by_material.items():
        for name in _leaf_names(service.material_formula(material_id)):
            if (name in MATERIAL_CATALOG and name != material_id) or owner.setdefault(name, material_id) != material_id:
                raise RuntimeError(f"way material '{name}' of '{material_id}' collides with another material")
    return by_material


_SERVICES_BY_MATERIAL = services_by_material(DEDICATED_WAY_VALUE_SERVICES)


def served_materials(axis_id: str, definitions: Mapping[str, AxisDefinition]) -> list[str]:
    """軸が内部軸まで辿って読む材料のうち、配信のサービスが値を配る材料（材料idの順）。"""
    leaves = leaf_materials(axis_with_dependencies(axis_id, definitions))
    return sorted(material for material in leaves if material in _SERVICES_BY_MATERIAL)


def _served_formulas(axis_id: str, definitions: Mapping[str, AxisDefinition]) -> dict[str, ServedMaterialFormula]:
    return {material: _SERVICES_BY_MATERIAL[material].material_formula(material)
            for material in served_materials(axis_id, definitions)}


def _condition_names(kinds: Iterable[type]) -> list[WayValueConditionName]:
    """条件の型の欄の名前を、型の並び・欄の並びで重ねずに並べる。"""
    names = (cast(WayValueConditionName, field.name) for kind in kinds for field in fields(kind))
    return list(dict.fromkeys(names))


def _build_service(
    material: str, repository: RoadGraphRepository, weather_service: WeatherService
) -> DedicatedWayValueService:
    return _SERVICES_BY_MATERIAL[material].build(repository, weather_service, material)


#: 材料id→その材料の配信サービス。
MaterialServiceBuilder = Callable[[str], DedicatedWayValueService]


def material_service_builder(repository: RoadGraphRepository, weather_service: WeatherService) -> MaterialServiceBuilder:
    """材料ごとの配信サービスを、同じリポジトリ・気象サービスで組み立てる。"""
    return lambda material: _build_service(material, repository, weather_service)


class FeatureMaterialSource(Protocol):
    """タイルのフィーチャーごとの材料を読む口（`services/feature_materials.py: FeatureMaterialService`）。"""

    async def materials(self, z: int, x: int, y: int) -> FeatureMaterials | None: ...

    async def segments(self, z: int, x: int, y: int) -> FeatureSegments | None: ...


def _leaf_columns(
    feature_keys: Sequence[str], materials: Iterable[Mapping[str, Mapping[str, float]]]
) -> dict[str, np.ndarray]:
    return {name: np.array([values.get(key, np.nan) for key in feature_keys], dtype=float)
            for way_materials in materials for name, values in way_materials.items()}


async def _tile_way_inputs(
    axis_ids: Sequence[str],
    definitions: Mapping[str, AxisDefinition],
    feature_materials: FeatureMaterialSource,
    build_service: MaterialServiceBuilder,
    z: int,
    x: int,
    y: int,
    at: datetime | None,
    feature_key: str | None,
) -> dict[str, TileWayInputs | None]:
    """軸ごとに、タイル`(z, x, y)`で軸の値を求めるのに読むもの。材料とサービスの道ごとの材料は軸をまたいで1回だけ引く。
    値の無い軸（取込範囲外・DB障害）はNone。

    葉の材料がどれも配信のサービスの材料の軸は、タイルの材料を読まずにサービスが材料を返したフィーチャーだけを塗る。
    道1本を1つのフィーチャーにするズームで、区間から畳む軸（`folds_segments`）は、フィーチャーごとの区間の材料も読む。
    `feature_key`を渡すと、そのフィーチャーだけを読む。
    """
    served_ids = {axis_id: served_materials(axis_id, definitions) for axis_id in axis_ids}
    services = {material: build_service(material)
                for material in dict.fromkeys(material for ids in served_ids.values() for material in ids)}
    way_materials = {material: await service.get_way_materials(z, x, y, at) for material, service in services.items()}
    only_served = {axis_id: leaf_materials(axis_with_dependencies(axis_id, definitions)) <= set(served_ids[axis_id])
                   for axis_id in axis_ids}
    read = None
    if not all(only_served.values()):
        read = await feature_materials.materials(z, x, y)
        if read is not None and feature_key is not None:
            read = read.of_feature(feature_key)
    folds = {axis_id: z < EDGE_UNIT_MIN_ZOOM and folds_segments(axis_id, definitions) for axis_id in axis_ids}
    segments: FeatureSegments | None = None
    segment_leaves: dict[str, np.ndarray] = {}
    if any(folds[axis_id] and (only_served[axis_id] or read is not None) for axis_id in axis_ids):
        segments = await feature_materials.segments(z, x, y)
        if segments is not None and feature_key is not None:
            segments = segments.of_feature(feature_key)
        if segments is not None:
            for material, service in services.items():
                if material in segment_material_ids():
                    segment_leaves.update(cast(SegmentMaterialService, service).segment_materials(segments))
    out: dict[str, TileWayInputs | None] = {}
    for axis_id in axis_ids:
        axis_way_materials_ = [way_materials[material] for material in served_ids[axis_id]]
        if only_served[axis_id]:
            feature_keys: Sequence[str] = [key for key in dict.fromkeys(
                key for materials in axis_way_materials_ for values in materials.values() for key in values)
                if feature_key in (None, key)]
            columns = {}
        elif read is None:
            out[axis_id] = None
            continue
        else:
            feature_keys, columns = read.feature_keys, read.columns
        if folds[axis_id] and segments is None:
            out[axis_id] = None
            continue
        out[axis_id] = TileWayInputs(
            feature_keys=feature_keys,
            materials=columns,
            leaves=_leaf_columns(feature_keys, axis_way_materials_),
            segments=segments if folds[axis_id] else None,
            segment_leaves=segment_leaves if folds[axis_id] else None,
        )
    return out


def _formula_conditions(query: WayValueQuery) -> dict[str, float]:
    return {name: value for name, value in (("bearing_deg", query.bearing_deg), ("speed_kmh", query.speed_kmh))
            if value is not None}


async def tile_axis_values(
    axis_ids: Sequence[str],
    definitions: Mapping[str, AxisDefinition],
    feature_materials: FeatureMaterialSource,
    build_service: MaterialServiceBuilder,
    z: int,
    x: int,
    y: int,
    query: WayValueQuery,
    *,
    feature_key: str | None = None,
    as_difficulty: bool = False,
) -> dict[str, dict[str, float | None] | MissingConditions]:
    """タイル`(z, x, y)`のフィーチャーごとに、軸ごとの地図が塗る値（`axis_way_values`）。

    要る条件が欠けた軸は、何も読まずに欠けた条件を返す。要る条件は、軸の葉の材料を配るサービスが受け取る条件の型を
    合わせたもの。読むものは`_tile_way_inputs`、`as_difficulty`は`paint_feature_values`と同じ。
    """
    out: dict[str, dict[str, float | None] | MissingConditions] = {}
    ready: list[str] = []
    for axis_id in axis_ids:
        missing = [names for material in served_materials(axis_id, definitions)
                   if isinstance(names := assemble_conditions(_SERVICES_BY_MATERIAL[material].conditions_type, query),
                                 MissingConditions)]
        if missing:
            out[axis_id] = MissingConditions(tuple(dict.fromkeys(name for names in missing for name in names.names)))
        else:
            ready.append(axis_id)
    inputs = await _tile_way_inputs(
        ready, definitions, feature_materials, build_service, z, x, y, query.at, feature_key)
    conditions = _formula_conditions(query)
    for axis_id in ready:
        axis_inputs = inputs[axis_id]
        out[axis_id] = {} if axis_inputs is None else axis_way_values(
            axis_id, definitions, _served_formulas(axis_id, definitions), axis_inputs, conditions,
            as_difficulty=as_difficulty)
    return out


#: フィーチャーの鍵→道ごとの材料の名前→値。値の無い材料は載せない。
TileAxisWayMaterials = dict[str, dict[str, float]]


async def tile_axis_way_materials(
    axis_id: str,
    definitions: Mapping[str, AxisDefinition],
    feature_materials: FeatureMaterialSource,
    build_service: MaterialServiceBuilder,
    z: int,
    x: int,
    y: int,
    at: datetime | None,
) -> TileAxisWayMaterials | None:
    """タイル`(z, x, y)`のフィーチャーごとに、軸の木（`axis_way_value_formula`、地図が塗る値の木）が読む道ごとの材料。
    要求の条件に依らない。木の無い軸はNone。"""
    served = _served_formulas(axis_id, definitions)
    if axis_way_value_formula(axis_id, definitions, served, as_difficulty=False) is None:
        return None
    inputs = (await _tile_way_inputs(
        [axis_id], definitions, feature_materials, build_service, z, x, y, at, None))[axis_id]
    if inputs is None:
        return {}
    columns = axis_way_materials(axis_id, definitions, served, inputs, as_difficulty=False)
    out: TileAxisWayMaterials = {}
    for row, key in enumerate(inputs.feature_keys):
        values = {name: float(column[row]) for name, column in columns.items() if not np.isnan(column[row])}
        if values:
            out[key] = values
    return out


class AxisWayValueLens:
    """地図のレンズが塗る1つの軸の、値を求める道ごとの材料と、それを軸の木で評価した値（フィーチャーの鍵→値）。

    材料もサービスの道ごとの材料も軸に依らずに引き（キャッシュも材料のまま持つ）、道ごとの材料へは軸定義から都度求めるため、
    軸スタジオで折れ点を変えてもキャッシュを捨てずに即座に効く。
    """

    def __init__(
        self,
        axis_id: str,
        definitions: Mapping[str, AxisDefinition],
        feature_materials: FeatureMaterialSource,
        build_service: MaterialServiceBuilder,
    ):
        self._axis_id = axis_id
        self._definitions = definitions
        self._feature_materials = feature_materials
        self._build_service = build_service

    async def values(self, z: int, x: int, y: int, query: WayValueQuery) -> dict[str, float | None] | MissingConditions:
        """要る条件が欠けていれば、何も読まずに欠けた条件を返す（`tile_axis_values`）。"""
        values = await tile_axis_values(
            [self._axis_id], self._definitions, self._feature_materials, self._build_service, z, x, y, query)
        return values[self._axis_id]

    async def way_materials(self, z: int, x: int, y: int, at: datetime | None) -> TileAxisWayMaterials | None:
        """`tile_axis_way_materials`。"""
        return await tile_axis_way_materials(
            self._axis_id, self._definitions, self._feature_materials, self._build_service, z, x, y, at)


def axis_way_value_lens(
    axis_id: str, feature_materials: FeatureMaterialSource, build_service: MaterialServiceBuilder
) -> AxisWayValueLens | None:
    """公開軸のレンズを組み立てる。軸は組み立てた時点の軸の集合で評価する。公開軸でなければNone。"""
    definitions = copy_axis_definitions()
    definition = definitions.get(axis_id)
    if definition is None or not definition.is_published:
        return None
    return AxisWayValueLens(axis_id, definitions, feature_materials, build_service)


#: 軸id・下書きの形→`draft_axis_way_value_lens`のレンズ。
DraftWayValueLensBuilder = Callable[[str, BreakpointLinearShape], AxisWayValueLens | None]


def draft_axis_way_value_lens(
    axis_id: str, shape: BreakpointLinearShape, feature_materials: FeatureMaterialSource,
    build_service: MaterialServiceBuilder,
) -> AxisWayValueLens | None:
    """軸の`shape`だけを`shape`へ差し替えた軸の集合で、軸の値を求めるレンズ（軸スタジオの較正の地図）。公開していない軸も
    組み立てる。軸が無ければNone。

    差し替えは組み立てた写しの中だけで、`AXIS_DEFINITIONS`と、ほかの要求のレンズの値は変わらない。差し替えた集合が
    保存の判定（`services/axis_registry_service.py: check_loadable_after_write`）を通らなければ、その文の`ValueError`
    ——保存できない下書きは、評価の途中で落ちる（参照先の無い材料・輪になる組み合わせ）。
    """
    definitions = copy_axis_definitions()
    definition = definitions.get(axis_id)
    if definition is None:
        return None
    definitions[axis_id] = definition.model_copy(update={"shape": shape})
    check_loadable_after_write(definitions, axis_id)
    return AxisWayValueLens(axis_id, definitions, feature_materials, build_service)


@dataclass(frozen=True)
class DedicatedWayValueLayer:
    """地図が軸の道ごとの材料を要求し、値を求めるときに要るもの。"""

    #: 値に効く条件の名前。軸の葉の材料を配るサービスが受け取る条件の型の欄すべて——既定値のある欄（風の時刻）も含む。
    #: 時刻は道ごとの材料の要求へ載せ、走行方位・想定速度は木（`formula`）へ入れる。葉の材料にサービスの材料が無ければ空。
    conditions: list[WayValueConditionName]
    #: 地図が塗る値を、道ごとの材料（`tile_axis_way_materials`）と要求の条件から求める木。木にできない軸はNone。
    formula: WayValueFormula | None
    #: 走行方位しだいで値の決まらない道がありうるか（木の`undetermined`が恒に偽でない）。
    undetermined_by_bearing: bool


def dedicated_way_value_layers() -> dict[str, DedicatedWayValueLayer]:
    """軸id → 地図が道ごとの材料を要求し、値を求めるときに要るもの。今の`AXIS_DEFINITIONS`の全軸を持つ。"""
    definitions = copy_axis_definitions()
    out: dict[str, DedicatedWayValueLayer] = {}
    for axis_id in definitions:
        served = _served_formulas(axis_id, definitions)
        formula = axis_way_value_formula(axis_id, definitions, served, as_difficulty=False)
        out[axis_id] = DedicatedWayValueLayer(
            conditions=_condition_names(_SERVICES_BY_MATERIAL[material].conditions_type for material in served),
            formula=formula,
            undetermined_by_bearing=any(
                material.formula.undetermined != FALSE for material in served.values()),
        )
    return out
