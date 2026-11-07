"""定期の測りの見直し（review.py が書いた場所）から、重なりの候補を消すタスクの本文を書く（.claude/skills/test-review/SKILL.md
「定期の測りから起きた消すタスク」）。重なりの候補があれば本文を書き、起票のスクリプトに渡す規模を出す。無ければ何も書かず、
何も出さない。

引数: 層の名前（backend か frontend） 見直しの場所（review.json と report.json がある所） 測りの実行の URL 書き出す本文のファイル
"""
import json
import os
import sys

from _shared import score

LAYER, REVIEW, RUN_URL, OUT = sys.argv[1:5]
# 規模の札の境目（変更行。.claude/skills/file-issue/SKILL.md「ラベルと種類と欄」の規模の札）。消すテストの行を変更行に数える。
SIZES = ((200, "S"), (1000, "M"))

review = json.load(open(os.path.join(REVIEW, "review.json"), encoding="utf-8"))
overlap = review["candidates"]["overlap"]
if overlap:
    lines = sum(c["lines"] for c in overlap)
    again = [c for c in overlap if c["previous"]]
    detected, ran = score(json.load(open(os.path.join(REVIEW, "report.json"), encoding="utf-8")))
    run_id = RUN_URL.rstrip("/").rpartition("/")[2]
    artifact = "mutation-review" if LAYER == "backend" else "mutation-frontend-review"
    size = next((s for limit, s in SIZES if lines <= limit), "L")
    body = f"""{LAYER} の単体テストの変異テストの定期の測り（実行 {run_id}）で、重なりの基準に当たる候補が {len(overlap)} 本（{lines} 行）出た。.claude/skills/test-review/SKILL.md「定期の測りから起きた消すタスク」のとおり、1本ずつ読んで消し、消したあとを確かめて Pull Request にする。

<details><summary>保守: 背景</summary>

- 測り: {RUN_URL}（測った版 `{review["measured"]}`・前回 `{review["previous"] or "無し"}`）。見直しの成果物は `{artifact}`（90日で消える）。
- 検知率（全体の変異スコア）: {detected / ran:.1%}（{detected}/{ran}）。
- 重なりの候補: {len(overlap)} 本・{lines} 行。そのうち前回も候補で中身が同じもの {len(again)} 本・{sum(c["lines"] for c in again)} 行。

</details>

<details><summary>やること</summary>

1. .claude/skills/test-review/SKILL.md「定期の測りから起きた消すタスク」のとおり、候補を1本ずつ読んで消し、残す側が落ちることを確かめる。
   - 行き先: 完了の条件「重なりの候補を1本ずつ読み」

</details>

<details><summary>完了の条件</summary>

- [ ] 重なりの候補を1本ずつ読み、基準に当たるものを消し、残す側が落ちることを確かめた変更が master にある
- [ ] 消したテストの行数と、消す前と消したあとの検知率を、ユーザーが見た
  - 確かめる: ユーザー
  - 見る所と要点: Pull Request の本文の検証。消したテスト関数の数と行数、`backend/scripts/mutation/score.py` が出した検知率の前後

</details>

<details><summary>規模と優先度の根拠</summary>

- 規模: 消す候補の行の和 {lines} 行を変更行に数えた。
- 優先度: 重なったテストは、利用者に届く壊れを見逃させない（ほかの残すテストが同じ壊れ方を見つける）。整理なので低。

</details>
"""
    open(OUT, "w", encoding="utf-8").write(body)
    print(size)
