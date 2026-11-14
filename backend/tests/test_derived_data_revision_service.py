"""DBの派生データと生データの世代を読み直す経路（`services/derived_data_revision_service.py`）。

TTLが切れるまでDBを読み直さないことと、DBが読めないとき前回の値のまま配ること。

ここで見ないもの:
- 世代の文字列の組み立て → `test_cache_identity.py`
- タイルを配る経路が世代を読み、世代付きの鍵でディスクへ残すこと → `test_region_service.py`
- 取込が実際に世代を進め、配信するタイルの世代がそれを持つこと → `test_derived_data_meta.py`（本物の取込で見る）
"""

import pytest

from app.infrastructure.derived_data_meta import DataRevisions
from app.services import derived_data_revision_service

pytestmark = pytest.mark.asyncio


class FakeRepository:
    """世代を返すだけのリポジトリ。サービスはフラットなリポジトリ契約にのみ依存する。"""

    def __init__(self, revision: int, imported: int = 3):
        self.revision = revision
        self.imported = imported
        self.error: Exception | None = None

    async def get_data_revisions(self) -> DataRevisions:
        if self.error is not None:
            raise self.error
        return DataRevisions(derived=self.revision, imported=self.imported)


async def test_second_call_within_ttl_does_not_read_db():
    # TTL内は問い合わせない。ここが効かないと、タイルの世代を配るたびにDB往復が1回増える。
    repository = FakeRepository(7)
    await derived_data_revision_service.current_revisions(repository)

    repository.revision = 8

    assert await derived_data_revision_service.current_revisions(repository) == DataRevisions(derived=7, imported=3)


