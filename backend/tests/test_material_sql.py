"""`domain/material_sql.py`のうち、SQLでなく説明の文を作る部品。

ここで見ないもの:
- SQLの部品が入力に対して返す値 → `test_material_values.py`
"""

from app.domain import material_sql


def test_a_description_names_a_tag_condition_as_the_tag_and_its_values():
    assert material_sql.tag_note("tag_a", "value_a", "value_b") == "tag_a=value_a・value_b"
