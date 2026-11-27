"""費用の軸の公開読み取りAPI。

画面（設定の軸ごとの倍率・結果の代償の内訳・地図のレンズと凡例）が、軸の名前・説明・アイコン・レンズの段と、軸の帳簿（体力か
道のストレスか）を読む。プロセス内の定義（`domain/model_settings.py: current_model_settings`）から返すので、管理APIで書いた定義は
再デプロイなしにここへ出る。
"""

import asyncio
from typing import Annotated

from fastapi import APIRouter, Query
from fastapi.exceptions import RequestValidationError
from pydantic import AfterValidator, Field, PrivateAttr, TypeAdapter, ValidationError, ValidationInfo, model_validator

from app.domain.axis_catalog import CostAxisCatalogResponse, current_cost_axis_catalog
from app.domain.cost_preference import STANDARD_COST_FACTOR, CostPreference
from app.domain.model_settings import ModelSettings, current_model_settings
from app.domain.strict_model import StrictModel

router = APIRouter()


@router.get("/api/cost-axes", response_model=CostAxisCatalogResponse)
async def get_cost_axis_catalog() -> CostAxisCatalogResponse:
    return await asyncio.to_thread(current_cost_axis_catalog)


def _check_cost_axis_ids(preference: CostPreference, info: ValidationInfo) -> CostPreference:
    assert isinstance(info.context, ModelSettings)
    return preference.check_cost_axis_ids(info.context.cost_axes)


class _CheckedField(StrictModel):
    """`cost_preference`を、検証の文脈に渡した写し（`ModelSettings`）の軸の定義で検める入れ物（断りの位置（`loc`）を欄にする）。"""

    cost_preference: Annotated[CostPreference, AfterValidator(_check_cost_axis_ids)]


class CostPreferenceRequest(StrictModel):
    """利用者の値（`cost_preference`）を持つ要求。受け取るときに較正値・区分・軸の定義の写しを1回だけ取り、その写しで軸のidを
    検め、同じ写しを`settings`で計算へ渡す（検めたあとに管理APIが軸を書き換えても、受け付けた軸と計算する軸がずれない）。"""

    # 代償の全体に掛けるつまみと、費用の軸ごとの倍率（書いていない軸は標準）。省略は標準。
    cost_preference: CostPreference = Field(default_factory=CostPreference)
    _settings: ModelSettings = PrivateAttr()

    @model_validator(mode="after")
    def _check_cost_preference(self) -> "CostPreferenceRequest":
        self._settings = current_model_settings()
        # 送られた欄だけを検め直す（断りの`input`を送られた値のままにする）。
        self.cost_preference = _CheckedField.model_validate(
            {"cost_preference": self.cost_preference.model_dump(exclude_unset=True)}, context=self._settings,
        ).cost_preference
        return self

    @property
    def settings(self) -> ModelSettings:
        """要求を検めた写し。"""
        return self._settings


_MULTIPLIERS: TypeAdapter[dict[str, float]] = TypeAdapter(dict[str, float])
_AXIS_IDS: TypeAdapter[list[str]] = TypeAdapter(list[str])


def cost_preference_query(
    strength: float = STANDARD_COST_FACTOR,
    multipliers: Annotated[str | None, Query(description="軸id→倍率のJSONの object（書いていない軸は標準）")] = None,
    disabled_axes: Annotated[str | None, Query(description="数えない（無効にした）軸idのJSONの array")] = None,
) -> CostPreferenceRequest:
    """地図のレンズ（タイル）の要求の利用者の値（ルート生成の`cost_preference`と同じ型・同じ検証。範囲と軸idは型が
    検め、誤りは型の検査と同じ形の422）。URL がそのまま応答のキャッシュの鍵になるので、クエリで受ける。"""
    try:
        parsed = {} if multipliers is None else _MULTIPLIERS.validate_json(multipliers)
        disabled = [] if disabled_axes is None else _AXIS_IDS.validate_json(disabled_axes)
    except ValidationError as error:
        raise RequestValidationError(error.errors()) from error
    try:
        return CostPreferenceRequest.model_validate(
            {"cost_preference": {"strength": strength, "multipliers": parsed, "disabled_axes": disabled}})
    except ValidationError as error:
        # クエリの値は本文の`cost_preference`の下に無いので、断りの位置からその欄を外す。
        raise RequestValidationError([{**detail, "loc": detail["loc"][1:]} for detail in error.errors()]) from error
