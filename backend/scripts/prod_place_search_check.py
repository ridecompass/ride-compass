"""本番の地点の検索を代表の語ごとに公開の口で1回ずつ引き、上限の中で候補が返るかを見る
（`.github/workflows/prod-route-check.yml`が1日1回呼ぶ）。

    python backend/scripts/prod_place_search_check.py

地点の検索の遅さは本番の規模の表でしか出ず（テストのDBの小さな表では問い合わせの計画が変わる）、画面からは打ってから候補が
出るまでの待ちとしてしか気づけない。どれかの語が上限を超えたか・200で返らないか・候補が0件なら、語・時間・候補の数を出して
終了コード1で終わる。本番には書き込まない。何を見るか・上限の根拠は docs/architecture/tech-stack.md「本番の地点の検索の確かめ」。
"""

from __future__ import annotations

import json
import sys
import urllib.parse
from dataclasses import dataclass

from _timed_get import timed_get

#: 検索の中心（緯度, 経度）。銭湯の少ない所で、少ない群の語ほど近い順の上限までに遠くまでたどる。
CENTER = (35.7400, 139.7550)
#: 代表の語。施設の引き方ごとに1語——群の語（少ない群・多い群）・チェーンの語・名前の部分一致。
WORDS = ("銭湯", "コンビニ", "ファミリーマート", "自転車屋")
#: 1語を引き終えるまでの上限（秒）。超えたら失敗にする。
SEARCH_LIMIT_SECONDS = 3.0


@dataclass(frozen=True)
class Searched:
    word: str
    seconds: float
    #: HTTPの状態の番号。応答が無ければ、要求が失敗した理由の文。
    status: int | str
    candidates: int = 0

    def describe(self) -> str:
        return f"「{self.word}」{self.seconds:.2f}秒・候補{self.candidates}件"


def problems(results: list[Searched]) -> list[str]:
    """引いた語のうち、利用者に見える壊れ（返らない・候補が無い・上限より遅い）。"""
    found = []
    for result in results:
        reasons = []
        if result.status != 200:
            reasons.append(f"200で返らない（{result.status}）")
        elif result.candidates == 0:
            reasons.append("候補が無い")
        if result.seconds > SEARCH_LIMIT_SECONDS:
            reasons.append(f"{SEARCH_LIMIT_SECONDS:.0f}秒の上限を超えた")
        if reasons:
            found.append(f"{result.describe()}: {'・'.join(reasons)}")
    return found


def search(origin: str, word: str) -> Searched:
    latitude, longitude = CENTER
    query = urllib.parse.urlencode({"q": word, "latitude": latitude, "longitude": longitude})
    response = timed_get(f"{origin}/api/place-search?{query}")
    candidates = len(json.loads(response.body)["candidates"]) if response.status == 200 else 0
    return Searched(word, response.seconds, response.status, candidates)


def main() -> int:
    from _production_origins import production_origin

    backend = production_origin("backend")
    results = []
    for word in WORDS:
        result = search(backend, word)
        print(result.describe(), flush=True)
        results.append(result)
    found = problems(results)
    for line in found:
        print(f"失敗: {line}")
    if found:
        return 1
    print(f"通った: 語 {len(WORDS)} 個のどれも、{SEARCH_LIMIT_SECONDS:.0f}秒の中で候補が返る")
    return 0


if __name__ == "__main__":
    sys.exit(main())
