"""Pull Request の変異の結果を知らせる。backend の下で、runner.py のあとに打つ。

引数: 比べる版（diff_scope.py に渡したもの）
読むもの（環境変数 MUT_OUT の場所）: results.jsonl・kills/（runner.py が書く）・rows.json（plan.py が書く）・scope.json（pr_plan.py が
書く）。mutants/ の mutmut-stats.json（gen.py が書かせる）。
- 生き残り・気づいたの分け方は、全部の測りの表と同じ判断（`_shared.py: judge`。変異を入れない版で同じ組み合わせを2回回した、
  その関数の基準で落ちたテストは数えない）。
- 生き残りのうち、書き換えた行が Pull Request で変わった行に当たるものを、その行への注記（GitHub Actions の
  `::warning file=…,line=…::…`）として出す。同じ行には1つだけ、全体で MUT_PR_MAX_NOTES 件まで（既定の10は、Actions が1つの段で
  出せる warning の注記の上限。それを超えた分は黙って捨てられる。REST の Checks の文書「Update a check run」）。
- 全部の生き残りと、変わったのにどのテストも通らない関数は、実行の要約（GITHUB_STEP_SUMMARY があればそこ、無ければ標準出力）へ書く。
"""
import collections
import json
import os
import sys

from _shared import baseline_failures, baseline_of, cell, expand, fn_of, judge, read_kills, read_results, read_stats
from diff_scope import changed_lines

OUT = os.environ["MUT_OUT"]
MAX_NOTES = int(os.environ.get("MUT_PR_MAX_NOTES", "10"))
base = sys.argv[1]
scope = json.load(open(os.path.join(OUT, "scope.json"), encoding="utf-8"))
where = {m: (path, line, old, new) for path, m, _n, _secs, line, old, new in
         json.load(open(os.path.join(OUT, "rows.json"), encoding="utf-8"))}
results = read_results(os.path.join(OUT, "results.jsonl"))
kills = read_kills(OUT)
tbf, _duration = read_stats("mutants")
baseline_failed = baseline_failures(results, kills, tbf)

counts: collections.Counter[str] = collections.Counter()
survivors = []
for name, r in results.items():
    if baseline_of(name):
        continue
    fn = fn_of(name)
    status = judge(r, expand(kills.get(name, set()), fn, tbf), baseline_failed.get(fn, set()))[0]
    counts[status] += 1
    if status == "Survived":
        survivors.append(name)
detected = counts["Killed"] + counts["Timeout"]
others = counts.total() - detected - len(survivors)


def escape(s):
    return s.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


diff = changed_lines(base)
rows, notes, noted_lines = [], 0, set()
for m in sorted(survivors):
    path, line, old, new = where[m]
    if line is None:
        rows.append((path, "", fn_of(m), "（書き換えた行を読めなかった）", False))
        continue
    on_diff = line in diff.get(path, set())
    rows.append((path, line, fn_of(m), f"`{old}` → `{new}`", on_diff))
    if on_diff and (path, line) not in noted_lines and notes < MAX_NOTES:
        noted_lines.add((path, line))
        notes += 1
        print(f"::warning file=backend/{path},line={line},title=テストが気づかない書き換え::"
              + escape(f"この行を「{new}」に書き換えても、この関数を通るテストが全部通った（元: {old}）"))

lines = ["## 変えた関数の変異テスト", "",
         f"変えた関数 {len(scope['funcs'])}・回した変異 {counts.total()}・気づいた {detected}・生き残り {len(survivors)}"
         f"{f'・ほか {others}' if others else ''}"
         f"（変えた行への注記 {notes}、上限 {MAX_NOTES}）", ""]
if scope["untested"]:
    lines += ["### 変わったのに、どのテストも通らない関数", ""] + [f"- `{f}`" for f in scope["untested"]] + [""]
if rows:
    lines += ["### 生き残り", "", "| ファイル | 行 | 関数 | 書き換え | 変えた行 |", "|---|---:|---|---|---|"]
    lines += [f"| `{f}` | {ln} | `{fn.rsplit('.', 1)[1]}` | {cell(d)} | {'◯' if od else ''} |"
              for f, ln, fn, d, od in rows]
text = "\n".join(lines) + "\n"
summary = os.environ.get("GITHUB_STEP_SUMMARY")
if summary:
    open(summary, "a", encoding="utf-8").write(text)
else:
    sys.stdout.write(text)
