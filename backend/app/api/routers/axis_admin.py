"""評価軸定義のCRUD管理API（ADR: docs/records/decisions/t221-axis-registry.md）。

`domain/axis_definitions.py: AXIS_DEFINITIONS`をDBの内容と同期させる書き込み口。
ルート生成の振る舞いを直接変えられるため、他のエンドポイントと異なり認可を要求する
（require_admin_basic_auth）。軸の定義ファイルを入れる`backend/scripts/axis_apply.py`と、軸スタジオの較正の画面
（frontend `/admin`）は、このAPIを通して軸を足す・直す・公開/非公開を変える・消す。
"""

from collections.abc import Mapping
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import Field, model_validator

from app.api.admin_auth import require_admin_basic_auth
from app.api.dependencies import (
    get_axis_preview_service,
    get_axis_registry_admin_service,
    get_draft_way_value_lens_builder,
)
from app.api.routers._tile_http import check_tile_rate_limit, region_tile_semaphore
from app.domain.value_distribution import ValueDistribution
from app.services.axis_preview_service import AxisPreviewService
from app.services.dedicated_way_values import DraftWayValueLensBuilder
from app.domain.dynamic_way_values import MissingConditions, WayValueQuery
from app.domain.geo import BearingDeg
from app.domain.region import RoadTileZoom, TileIndex, check_tile_index
from app.domain.route_request import AssumedSpeedKmh
from app.domain.axis_definitions import (
    AXIS_DEFINITIONS,
    AxisDefinition,
    AxisShape,
    BreakpointLinearShape,
    averages_density,
    check_axis_definition,
    weight_share_when_published,
)
from app.domain.map_paint import MapPaint, map_paint
from app.services.axis_registry_service import AxisRegistryAdminService
from app.domain.strict_model import StrictModel

router = APIRouter(
    prefix="/api/admin/axis-definitions", tags=["axis-admin"], dependencies=[Depends(require_admin_basic_auth)]
)


def _axis_not_found() -> HTTPException:
    """指された軸が無い。画面から届くのは、開いている間にほかで消された軸なので、読み直しを促す。"""
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="この軸はもうありません（ほかの画面で削除された可能性があります）。一覧を読み直してください。",
    )


def _conflict(exc: ValueError) -> HTTPException:
    """登録・更新・削除がほかの軸との不変条件で断られた。例外の文をそのまま返す。"""
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


class AxisDefinitionPayload(AxisDefinition):
    """作成・更新リクエストボディ。

    フィールドと、軸そのものの不変条件（重みの非負・折れ点のx昇順・段の境界の昇順・
    段ラベルの件数など）は`AxisDefinition`が持ち、DBの行から組み立てる経路にも同じように
    効く。軸の外（材料カタログ・既存の軸）に照らす値の不変条件は`check_axis_definition`が持ち、
    起動時・復元時の読み込みも同じものを通す。
    """

    @model_validator(mode="after")
    def _check_against_the_catalog_and_the_other_axes(self) -> "AxisDefinitionPayload":
        check_axis_definition(self, AXIS_DEFINITIONS)
        return self

    def to_definition(self) -> AxisDefinition:
        """派生クラスのまま先へ渡すと、Pydanticの等価判定がクラスまで見るため
        `is_update_allowed_while_published`の突き合わせが常に不一致になる。基底の型へ戻す。"""
        return AxisDefinition(**self.model_dump())


class AxisDefinitionResponse(AxisDefinition):
    """一覧・単体取得のレスポンスボディ。DB由来の既存データをそのまま返すため、
    `AxisDefinitionPayload`の検証（`check_axis_definition`）は継承せず`AxisDefinition`から派生する
    ——通らなくなった行も見せて直させる。"""

    #: この軸を（保存した既定の重みで）公開したとき、公開軸の既定の重みの合計に占める割合（0〜1）。公開済みの軸は
    #: 今の割合。合計が0ならNone。総合難易度が重みの合計で割るのと同じ分母（`difficulty.weight_share`）で、
    #: 画面は計算し直さない。
    weight_share_when_published: float | None


def _to_response(definition: AxisDefinition, definitions: Mapping[str, AxisDefinition]) -> AxisDefinitionResponse:
    """`AxisDefinitionResponse`は`AxisDefinition`へ`weight_share_when_published`を足すだけなので、
    フィールドを手書き列挙せずmodel_dump()経由で展開する。`definitions`は割合の分母を作る全軸。"""
    return AxisDefinitionResponse(
        **definition.model_dump(),
        weight_share_when_published=weight_share_when_published(definition, definitions),
    )


@router.get("")
async def list_axis_definitions(
    service: AxisRegistryAdminService = Depends(get_axis_registry_admin_service),
) -> list[AxisDefinitionResponse]:
    definitions = await service.list_all()
    return [_to_response(definition, definitions) for definition in definitions.values()]


@router.get("/{axis_id}")
async def get_axis_definition(
    axis_id: str, service: AxisRegistryAdminService = Depends(get_axis_registry_admin_service)
) -> AxisDefinitionResponse:
    definitions = await service.list_all()
    if axis_id not in definitions:
        raise _axis_not_found()
    return _to_response(definitions[axis_id], definitions)


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_axis_definition(
    payload: AxisDefinitionPayload, service: AxisRegistryAdminService = Depends(get_axis_registry_admin_service)
) -> AxisDefinitionResponse:
    definition = payload.to_definition()
    try:
        definitions = await service.create(definition)
    except ValueError as exc:
        raise _conflict(exc) from exc
    return _to_response(definition, definitions)


@router.put("/{axis_id}")
async def update_axis_definition(
    axis_id: str,
    payload: AxisDefinitionPayload,
    service: AxisRegistryAdminService = Depends(get_axis_registry_admin_service),
) -> AxisDefinitionResponse:
    if payload.axis_id != axis_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="axis_idはURLとボディで一致させてください"
        )
    definition = payload.to_definition()
    try:
        definitions = await service.update(axis_id, definition)
    except KeyError as exc:
        raise _axis_not_found() from exc
    except ValueError as exc:
        # 公開済み軸の更新拒否（AxisPublishedImmutableError）と材料の
        # 排他チェック（AxisMaterialConflictError）の両方がここを通る。
        raise _conflict(exc) from exc
    return _to_response(definition, definitions)


@router.delete("/{axis_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_axis_definition(
    axis_id: str, service: AxisRegistryAdminService = Depends(get_axis_registry_admin_service)
) -> None:
    try:
        await service.delete(axis_id)
    except KeyError as exc:
        raise _axis_not_found() from exc
    except ValueError as exc:
        raise _conflict(exc) from exc


@router.post("/{axis_id}/unpublish")
async def unpublish_axis_definition(
    axis_id: str, service: AxisRegistryAdminService = Depends(get_axis_registry_admin_service)
) -> AxisDefinitionResponse:
    """公開済み軸を下書きへ戻す。`update()`と異なり公開済み軸に対しても
    成功する——これが`update()`ではなく専用エンドポイントである理由（is_published以外の
    フィールドは一切変更しない、「公開済みは編集不可」原則を保ったまま公開フラグの
    反転だけに穴を開ける）。下書きへ戻った軸は通常のPUTで再編集・再公開できる。"""
    try:
        definitions = await service.unpublish(axis_id)
    except KeyError as exc:
        raise _axis_not_found() from exc
    return _to_response(definitions[axis_id], definitions)


class AxisPreviewRequest(StrictModel):
    """分布プレビューの入力。軸全体ではなく`shape`だけを受け取る——プレビューは
    保存前の編集中に呼ぶもので、ラベル等の書き込み用フィールドが揃っている必要はない。"""

    shape: AxisShape


@router.post("/preview-distribution")
async def preview_axis_distribution(
    payload: AxisPreviewRequest,
    preview: AxisPreviewService = Depends(get_axis_preview_service),
) -> ValueDistribution:
    """編集中の`shape`で、実データの生値（折れ点を通す前）がどう分布するかを返す。

    軸スタジオは数値の入力欄を並べるだけでは折れ点の妥当性を判断できず、公開して地図と
    ルートを見るまで結果が分からない。この分布に折れ点を当てはめれば、「延長の何%が
    満点に張り付くか」が編集中に分かる。
    """
    return await preview.raw_value_distribution(payload.shape)


class ScoresPreviewRequest(StrictModel):
    """折れ点の下書きで、値がそれぞれ何点になるかの問い合わせ。点数は評価と同じ計算で出す。"""

    shape: BreakpointLinearShape
    #: 折れ点の横軸の値（項の合成・前処理の後）。分布の階級の代表値など。
    xs: list[float] = Field(default_factory=list)


class ScoresPreviewResponse(StrictModel):
    #: `xs`の順の点数。
    scores: list[float]


@router.post("/preview-scores")
async def preview_scores(payload: ScoresPreviewRequest) -> ScoresPreviewResponse:
    """編集中の折れ点で、値がそれぞれ何点になるかを返す。DBを読まない。

    軸スタジオは折れ点を動かすたびにこれを問い合わせ、分布の段の割合を出す。点数の計算を
    画面で作り直すと、評価と画面で同じ折れ点に別の点数が付きうる（同じxの点が並ぶところ等）。
    """
    return ScoresPreviewResponse(scores=payload.shape.scores_at(payload.xs))


class CalibrationPreviewRequest(StrictModel):
    """較正の画面で動かしている下書きの定義。保存の前なので、ほかの軸に照らす検証（`check_axis_definition`）は通さない。"""

    definition: AxisDefinition


class CalibrationPreviewResponse(StrictModel):
    #: 下書きの定義で地図が塗るもの。段の境界は、上書きが無ければ下書きの形から導いたもの。
    map_paint: MapPaint
    #: 密度の軸か（`averages_density`）。密度の軸の折れ線は(0, 0)ともう1点に限るので、決められるのはもう1点だけ。
    averages_density: bool


@router.post("/preview-calibration")
async def preview_calibration(payload: CalibrationPreviewRequest) -> CalibrationPreviewResponse:
    """下書きの定義で、地図の段と密度の軸かを返す。DBを読まない。

    段の境界は上書きが無ければ折れ線から導くので、折れ点を動かすと変わる。画面で導き直すと地図と食い違う。
    """
    definition = payload.definition
    return CalibrationPreviewResponse(map_paint=map_paint(definition), averages_density=averages_density(definition))


class WayValuesPreviewRequest(StrictModel):
    """折れ点の下書きで、タイルの道がそれぞれ何点になるかの問い合わせ。"""

    axis_id: str
    #: `axis_id`の軸の`shape`をこれへ差し替えて評価する。ほかの欄は保存されている軸のまま。
    shape: BreakpointLinearShape
    z: RoadTileZoom
    x: TileIndex
    y: TileIndex
    #: 条件で変わる材料を読む軸の条件。要る欄は、軸の葉の材料を配るサービスが受け取る条件の型が決める（省くと422）。
    bearing_deg: BearingDeg | None = None
    at: datetime | None = None
    speed_kmh: AssumedSpeedKmh | None = None

    @model_validator(mode="after")
    def _check_tile_index(self) -> "WayValuesPreviewRequest":
        check_tile_index(self.z, self.x, self.y)
        return self


@router.post("/preview-way-values")
async def preview_way_values(
    payload: WayValuesPreviewRequest,
    request: Request,
    build_lens: DraftWayValueLensBuilder = Depends(get_draft_way_value_lens_builder),
) -> dict[str, float | None]:
    """編集中の折れ点で、タイルのフィーチャーごとに地図が塗る値を返す。保存していない下書きの`shape`で、軸スタジオの
    較正の地図が塗る。

    鍵と値の意味は、地図が道ごとの材料（`/api/region/way-materials`）を軸の木（`way_value_formula`）で評価した値と同じで、
    同じ材料・同じ評価から`shape`だけを差し替えて求める（`services/dedicated_way_values.py: draft_axis_way_value_lens`）。
    保存されている折れ点を渡せば、地図が塗る値と同じになる。
    下書きの値は持たず、配信の値・材料のキャッシュは変わらない。公開していない軸も求める。

    条件で変わる材料（向きで符号の変わる勾配・風・雨）を読む軸も扱い、条件の欄（`bearing_deg`・`at`・`speed_kmh`）は
    配信と同じ型の検証・要る欄の判定（欠けると422）・省いたときの扱いに従う。無い軸は404、保存できない下書き
    （参照先の無い材料・輪になる組み合わせ等）はその理由の文で422。レート制限の上限・座標の検証・DB接続プールの
    semaphore（`_tile_http.py: region_tile_semaphore`）は配信と同じものを使う。
    """
    try:
        lens = build_lens(payload.axis_id, payload.shape)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    if lens is None:
        raise _axis_not_found()
    check_tile_rate_limit(request, "axis-preview-way-values")
    query = WayValueQuery(at=payload.at, bearing_deg=payload.bearing_deg, speed_kmh=payload.speed_kmh)
    async with region_tile_semaphore:
        values = await lens.values(payload.z, payload.x, payload.y, query)
    if isinstance(values, MissingConditions):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"この軸には{'・'.join(values.names)}が必須です。")
    return values
