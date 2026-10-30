"""`services/tuning_service.py`——較正値の上書きの取引の区切りと、書いた値をプロセスへ反映するところ。

ここで見ないもの:
- 既定から動かしたidの一覧（上書きの鍵を集合へ詰め替えるだけで、判断を持たない）
- 上書きの行の読み書き・範囲の外や数値でない値の判定・プロセス内の値の組み立て → `test_tuning_overrides.py`
- HTTPの受け口（404・422への写し替え・一覧の並び） → `test_tuning_admin_routes.py`

上書きの行の読み書き（`infrastructure/tuning_overrides.py: TuningOverrideStore`）とセッションは、呼ばれた順を
1本の記録へ残す代役を渡す。読み書きの代役は本物の署名へ当てる（`bound`）。プロセスへ反映したかは、プロセス内の`TUNING_VALUES`で見る。
"""

import pytest

from app.domain.tuning import TUNING_PARAMETERS, TUNING_VALUES
from app.infrastructure.tuning_overrides import TuningOverrideStore
from app.services.tuning_service import TuningService
from tests.bound_fake import bound

_PARAM = "speed.crr"
#: 書いた後の上書きの行（`read_overrides`の代役が返す）と、それを宣言の既定へ重ねた値。宣言の既定から1つだけ動かした値。
OVERRIDES = {_PARAM: 0.006}
LOADED = {**{parameter.id: parameter.default for parameter in TUNING_PARAMETERS}, **OVERRIDES}


class Session:
    """取引の区切りを記録するセッションの代役。"""

    def __init__(self, events: list):
        self.events = events

    async def commit(self):
        # 確定の時点のプロセスの値も残す（差し替えは確定の後）。
        self.events.append(("commit", TUNING_VALUES[_PARAM]))


class Overrides:
    """上書きの行の読み書きの代役。呼ばれた順をセッションと同じ記録へ残す。"""

    def __init__(self, events: list):
        self.events = events

    async def _set(self, param_id, value):
        self.events.append(("set_override", param_id, value))

    async def _clear(self, param_id):
        self.events.append(("clear_override", param_id))

    async def _read(self):
        self.events.append(("read_overrides",))
        return OVERRIDES

    set_override = bound(TuningOverrideStore.set_override, _set)
    clear_override = bound(TuningOverrideStore.clear_override, _clear)
    read_overrides = bound(TuningOverrideStore.read_overrides, _read)


@pytest.fixture
def events(monkeypatch):
    """セッションと上書きの読み書きの代役が残す、呼ばれた順の記録。

    プロセス内の`TUNING_VALUES`は、テストの後に元の値へ戻す。
    """
    for param_id, value in TUNING_VALUES.items():
        monkeypatch.setitem(TUNING_VALUES, param_id, value)
    return []


@pytest.mark.parametrize(
    ("value", "write"),
    [
        (0.006, ("set_override", "speed.crr", 0.006)),
        # 値が無ければ既定へ戻す（行を外す）
        (None, ("clear_override", "speed.crr")),
    ],
)
async def test_saving_loads_the_values_before_commit_and_only_swaps_them_in_after(events, value, write):
    before = TUNING_VALUES[_PARAM]

    await TuningService(Session(events), Overrides(events)).save_override(_PARAM, value)

    # 読んで検算するのは確定の前（失敗すれば書き込みごと取り消せる）。確定の後は、その値への
    # 差し替えだけ——DBを読み直さず、DBに無い値がプロセスだけで効くこともない
    assert events == [write, ("read_overrides",), ("commit", before)]
    assert TUNING_VALUES == LOADED
