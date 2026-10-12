"""PostGIS統合テストのDBが載るサーバーと、DBの名前。

テストの足場（`tests/conftest.py`）と、残ったDBを片付ける道具（`scripts/drop_orphan_test_databases.py`）が読む。
クラウドの開発環境の準備（`scripts/remote_dev/lib.sh`）は、`SHARED_TEST_DATABASE`の行を文字として読む。
"""

from app.config import LOCAL_DATABASE_SERVER

#: 開発機で稼働中の実DB（ridecompass、backend/.envのDATABASE_URLが指す先）と同じサーバーの、別のDBを使う
#: （取り込んだ実データに触れないため）。
TEST_DATABASE_SERVER = LOCAL_DATABASE_SERVER
#: 作業ツリー専用のDBを作れない環境（ロールにCREATEDBが無い等）での退避先。
#: **分離できないことより、PostGISテストが丸ごと走らなくなる方が害が大きい。**
SHARED_TEST_DATABASE = "ridecompass_test"
#: テストの足場が作るDBの名前の頭（作業ツリー専用のDBと複製元）。
TEST_DATABASE_PREFIX = f"{SHARED_TEST_DATABASE}_"
#: 複製元。`CREATE EXTENSION postgis`はsuperuserを要求する（postgisはtrusted拡張ではない）
#: ため、空のDBを作っても拡張を入れられない。**拡張を持つDBを複製する**ことで、
#: superuserなしで使えるDBを増やせる。
TEMPLATE_TEST_DATABASE = f"{TEST_DATABASE_PREFIX}template"
