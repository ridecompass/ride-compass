"""`scripts/prose_copies.py`の backend の文の母集団（走査する層と、較正値の id・文の中で計算する値の拾い方）のテスト。

リポジトリの根を一時ディレクトリへ替え、そこに置いた小さな backend の文で確かめる。

ここで見ないもの: 生成物から名前を集める部分と frontend の行の (4) は、本物のリポジトリへ流して周期レビューで人が読む。
"""

import textwrap

import pytest
from script_module import load_script

pc = load_script("prose_copies")

TUNING = '''
def stop_seconds_parameter_id(kind):
    return f"stop.{kind}_seconds"

_CRR_ID = "speed.crr"
'''


@pytest.fixture
def backend(tmp_path, monkeypatch):
    monkeypatch.setattr(pc, "ROOT", tmp_path)

    def write(relative: str, source: str) -> None:
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(textwrap.dedent(source), encoding="utf-8")

    write("backend/app/domain/tuning.py", TUNING)
    return write


def test_services_and_api_phrases_are_candidates(backend):
    """応答の文は宣言の外の層でも利用者に届くので、宣言と同じく名前と寸法を見る。"""
    backend("backend/app/services/generator.py", '''
        def reason(distance_km):
            return f"起点から片道{distance_km / 2:.1f}km前後で折返し地点が見つかりませんでした。"
    ''')
    backend("backend/app/api/routes.py", '''
        DETAIL = "評価軸の名前が正しくありません。"
    ''')

    found = pc.backend_findings(["評価軸の名前"])

    assert [line.split("\t")[:2] for line in found["2"]] == [["backend/app/services/generator.py:3", "0km"]]
    assert [line.split("\t")[:2] for line in found["1"]] == [["backend/app/api/routes.py:2", "評価軸の名前"]]


def test_value_read_from_a_name_is_not_a_computed_number(backend):
    """宣言の値をそのまま差し込む文は宣言を引いているので、数字と単位に数えない。"""
    backend("backend/app/domain/notes.py", '''
        GAP_M = 15
        NOTE = f"逆向きの一方通行が{GAP_M:g}m以内を並走する道"
    ''')

    assert pc.backend_findings([])["2"] == []


@pytest.mark.parametrize(
    ("statement", "expected"),
    [
        ('"舗装（speed.crr）と砂利の中間に置く。"', ["speed.crr"]),
        ('"一時停止のぶん（stop.stop_seconds）とは別に足す。"', ["stop.stop_seconds"]),
        ('"一時停止のぶんはstop.stop_secondsで足す。"', ["stop.stop_seconds"]),
        ('f"舗装（{_CRR_ID}）と砂利の中間に置く。"', []),
        ('"地図はmaplibre.jsで描きます。"', []),
    ],
)
def test_tuning_id_written_in_a_phrase(backend, statement, expected):
    """名前空間は較正値の宣言の id と、id を組み立てる f 文字列の頭から取る。差し込みで引いた id は地の部分に残らない。"""
    backend("backend/app/domain/descriptions.py", f"TEXT = {statement}\n")

    found = pc.backend_findings([])["5"]

    assert [line.split("\t")[1] for line in found] == expected


def test_number_and_unit_in_a_screen_phrase(tmp_path, monkeypatch):
    """画面の定数の値を文に書いた形は数字が地に残る。定数を差し込んだ文とコメントの行は当たらない。"""
    monkeypatch.setattr(pc, "ROOT", tmp_path)
    monkeypatch.setattr(pc, "FRONTEND_SRC", tmp_path / "frontend" / "src")
    monkeypatch.setattr(pc, "FRONTEND_EXCLUDED", [])
    path = tmp_path / "frontend" / "src" / "Dial.tsx"
    path.parent.mkdir(parents=True)
    path.write_text(
        textwrap.dedent('''
            const copied = "走る向きは、地図の上の向きを8方位に丸めた向きです。";
            const read = `走る向きは、地図の上の向きを${STEP_DEG}°刻みに丸めた向きです。`;
            // 走る向きは10°刻みに丸める。
        '''),
        encoding="utf-8",
    )

    assert [line.split("\t")[:2] for line in pc.frontend_findings()["6"]] == [["frontend/src/Dial.tsx:2", "8方位"]]
