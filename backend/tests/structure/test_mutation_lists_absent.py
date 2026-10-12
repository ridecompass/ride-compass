"""変異テストの一覧の口（`backend/scripts/mutation/_shared.py: LISTS`）がチェックアウトに無いことの検査。

一覧の口は、作業ブランチを測る版に渡してその一覧だけを回すためのもの。masterへ入ると、以後の定期の測りが一覧の分しか回らず、
当て直しと見直しの段も走らない。変異テストの台本は`tests/structure`を外してテストを回す（`backend/scripts/mutation/setup.cfg`）ので、
測りの中で台本が一覧を書いても、この検査は変異の判定に混ざらない。
"""

from pathlib import Path

import pytest

from scripts.mutation._shared import LISTS


@pytest.mark.parametrize("path", LISTS, ids=lambda path: Path(path).name)
def test_no_mutation_list_is_checked_in(path):
    assert not Path(path).exists(), (
        f"backend/scripts/mutation/{Path(path).name} が残っている。一覧の口は測りに渡す作業ブランチでだけ置き、Pull Request の前に消す"
    )
