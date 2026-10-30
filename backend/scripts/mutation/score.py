"""見直しの表（report.json）の、テストを消す前と消したあとの全体の変異スコア（検知率）を出す。消す前は表のまま、消したあとは
消したテスト関数が見つけていた変異のうち、残すテストがどれも見つけないものを生き残りに数える（_shared.py: score）。
定期の測りから起きた消すタスクが、消した行数と並べて見せる（.claude/skills/test-review/SKILL.md「定期の測りから起きた消すタスク」）。

引数: 表のファイル 消したテスト関数の一覧のファイル（1行に1つ。review.json の overlap の test の綴り）
"""
import json
import sys

from _shared import read_lines, score

REPORT, REMOVED = sys.argv[1], sys.argv[2]
report = json.load(open(REPORT, encoding="utf-8"))
removed = set(read_lines(REMOVED))
before, ran = score(report)
after, _ = score(report, removed)
print(f"検知率: 消す前 {before / ran:.1%}（{before}/{ran}）→ 消したあと {after / ran:.1%}（{after}/{ran}）。消したテスト関数 {len(removed)} 本")
