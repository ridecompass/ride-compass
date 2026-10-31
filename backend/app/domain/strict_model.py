"""未知のフィールドを黙って捨てないPydanticモデルの基底。

Pydanticの`extra`の既定は`ignore`で、モデルが知らないフィールドは例外にならず捨てられる。
値は消えてアサーションだけが残るため、**フィールドを消した・改名したときの取り残しが
どこにも現れない**。APIリクエストのモデルでは、typoした
フィールドが黙って無視され「指定したのに効かない」という形で利用者に出る。
外部のペイロードを直接このモデルで検証するなら、そのモデルで`extra="ignore"`を上書きし、理由をその場に書く。

**自前で書いた過去のデータは、このモデルで読まれる。** 軸定義とその`shape_params`（DBのJSONB）は
`infrastructure/axis_definition_repository.py`が**過去のコードが書いた形**を今のモデルで
読む。`forbid`のもとでフィールドを消す・改名すると、既存の行が読めずアプリが起動に失敗する
（fail-fast）。**そういう変更は本番DBの移行を先に済ませてからmasterへマージする**
（.claude/rules/deployment-sync.md「コミットと同時に揃えるもの」）。
"""

from pydantic import BaseModel, ConfigDict


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)
