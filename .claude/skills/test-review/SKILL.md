---
name: test-review
description: "backend のテストを、変異テストの全部の測りで見直す（測りを起こす・待つ・結果を読む・消す／直すタスクにする・記録する・片付ける）。テストの定期の見直しをするとき・テストの見直しを頼まれたときに使う。"
---

## テストの見直しを回す

導く原則: 1・4・5。

backend のテストを、.claude/rules/testing-review.md「テストを変異テストで見直す」の4つの観点（効き・重なり・隔離・書き方）で見直す1回の
手順。開発機の対話のセッションが、この手順だけで始めから終わりまで進める。測りは GitHub Actions のワークフロー
`.github/workflows/mutation.yml`（先頭に2段の中身と持ち時間）が回し、台本は `backend/scripts/mutation/`（各ファイルの先頭に使い方）。
測りの結果から何を消す・直すかの決まりは testing-review.md が持ち、ここには書かない。

### 1. 始める

1. **記録する issue を決める**: 頼まれたときに issue の番号があればそれ。無ければ .claude/skills/file-issue/SKILL.md「issue の形」の
   とおり、種類は保守、題名「テストの定期の見直し（<日付>）」で起こす（やること: この節の 2〜6、完了の条件: 6 の記録と、5 で
   起こしたタスクの番号があること）。
2. **持つ**: .claude/skills/dev-session/SKILL.md「開発機の対話のセッション」の「持つ」で持つ。
3. **計画を伝える**（CLAUDE.md「作業の進め方」）: 何をどの順で、どれくらいかかるか。見込みは 2026-10-09 の同じ形の測りで、
   実時間で約1時間40分（shard 1本あたり、変異の生成と記録 約9分・変異 約1時間・当て直し 約26分、review 数分）に、
   ランナーの空き待ち（2026-10-10 の試しで、段ごとに最長16分）が足される。

### 2. 測りを起こす

    gh workflow run mutation.yml -R ridecompass/ride-compass --ref master -f ref=master

- `--ref` はワークフローの定義を読む版、`-f ref=` は測る版（台本も同じ版から読む）。ふだんはどちらも master。
- 起こした実行の id は、`gh run list -R ridecompass/ride-compass --workflow mutation.yml -L 1 --json databaseId,createdAt,status` で
  取り、`createdAt` が起こした時刻のあとであることを見る。
- 同じワークフローが動いていれば、終わるまで待ってから始まる（`concurrency: mutation`）。
- 測りは8本のランナーを約1時間半使い、アカウントで同時に動かせるジョブの枠を担当（Claude Task）・CI と分け合う。担当や CI が
  多く動いているとき（`gh run list -R ridecompass/ride-compass --status in_progress`）は、測りの空き待ちが延び、そのあいだ担当と
  CI の待ちも延びる。起こす前に動いている数を見て、6 の記録に書く。

### 3. 待つ

段（shard の各本・review）が終わるたびに知らせる。黙って待たない（CLAUDE.md「長い待ちで黙って待たない」）。待ち方は、
Monitor で次を回す（ジョブが終わるたびに1行出し、実行が終われば抜ける）。

    id=<id>; prev=""; while true; do
      cur=$(gh run view $id -R ridecompass/ride-compass --json jobs -q '.jobs[] | select(.status=="completed") | "\(.name): \(.conclusion)"' 2>/dev/null | sort) || { sleep 60; continue; }
      comm -13 <(echo "$prev") <(echo "$cur"); prev=$cur
      st=$(gh run view $id -R ridecompass/ride-compass --json status,conclusion -q '"\(.status) \(.conclusion)"')
      case $st in completed*) echo "実行: ${st#completed }"; break;; esac
      sleep 300
    done

（開発機に jq は無いので、`gh` の `-q` で読む。Monitor の持ち時間は最長30分なので、切れたら同じコマンドで張り直す。）

終わった本の記録は、実行全体が終わる前でも
`gh api --allow-escape-sequences repos/ridecompass/ride-compass/actions/jobs/<ジョブの id>/logs` で読める（`gh run view --log` は
実行全体が終わるまで読めない。ジョブの id は `gh run view <id> --json jobs`）。本の中の手順ごとの始まりと終わりは
`gh api repos/ridecompass/ride-compass/actions/jobs/<ジョブの id>` の `steps` で見られ、1つの手順が見込みより長く止まっていれば
（DB を用意する手順は普段1分弱、変異の生成と記録は約9分）、下の「落ちたとき」に当たるかを見る。

落ちたとき:

- **shard の1本が「The runner has received a shutdown signal」で止まった**（変異がランナーのメモリを使い切った）:
  `gh run rerun <id> -R ridecompass/ride-compass --failed` で落ちた本と、それに続く段だけをやり直す。同じ本が続けて止まるなら、
  その本の記録（`gh run view <id> --job <ジョブの id> --log`）の最後の「始め <変異>」の変異が原因なので、6 の記録に書いて止める
  （台本の直しは、その回の外のタスクにする。.claude/skills/file-issue/SKILL.md「改善を起票する」）。
- **shard の1本が、DB を用意する手順（`./.github/actions/postgis`）の10分の上限で落ちた**（apt の取得が詰まった）:
  同じく `gh run rerun <id> -R ridecompass/ride-compass --failed` で1回やり直す。続けて落ちるなら、次の「それ以外」と同じに扱う。
- **1つの手順が上限の無いまま、見込みより長く止まっている**: 起こしたのは自分なので、`gh run cancel <id> -R ridecompass/ride-compass`
  で止め、止まったのを見てから `gh run rerun <id> -R ridecompass/ride-compass --failed` で、止めた本と続く段をやり直す（止まった本は
  ランナーの枠を使い続け、担当や CI の待ちを延ばす）。担当や CI の実行は止めない。
- **それ以外で落ちた**: `gh run view <id> -R ridecompass/ride-compass --log-failed` で読む。台本・ワークフローの誤りなら、その回の
  中で直さず、起票して 6 の記録に書いて止める（直したあとの回で測り直す）。
- **review の段の要約に「変異を回し終えていない」と出た**（stop_after で抜けた本がある）: その回の見直しは比べに使えない。
  持ち時間を延ばす（`-f stop_after=`）か本数を増やすかを起票し、6 に書いて止める。

### 4. 結果を読む

    gh run download <id> -R ridecompass/ride-compass -n mutation-review -D <作業ツリーの外の使い捨ての場所>

- `summary.md`: 実行の要約と同じ表（層ごとの変異スコア・テストの区分ごとの数・観点ごとの候補の数と行数・判断できずに残したテストの
  理由・テストのファイルごとの数）。前の回の `summary.md` と比べると、効きの動きが分かる。
- `candidates.md`: 候補を観点ごとに1件1行で並べた表。「落ちると利用者に何が壊れるか」の欄は空で出る（5 で書く）。
- `review.json` には次の欄がある。`measured`（測った版）・`previous`（比べた前回の版。無ければ null）・`complete`・`mutants`（結果ごとの
  変異の数）・`candidates`・`kept_reasons`。`candidates` は観点ごとの一覧で、`effect`（効き。生き残りと、どのテストも通らない変異）・
  `overlap`（重なり。テスト関数ごとに `hash`・`lines`・`height`・消したあとの確かめに使う `mutant` と、それを見つける残すテスト
  `kept_test`・前回も候補で中身が同じなら真の `previous`）・`isolation`（隔離）・`writing`（書き方。`form` が形）。`isolation` の
  ほかは、1件ごとに空の `breaks`（落ちると利用者に何が壊れるか）を持つ。
- `report.json`: 測りの結果の表（層や道具に依らない Stryker の結果の JSON の形。読み方は `backend/scripts/mutation/report.py` の先頭）。

### 5. 観点ごとに行き先を決める

決まりは testing-review.md「テストを変異テストで見直す」。ここでは、出た一覧をどこへ渡すかだけを決める。起こすタスクは、記録する
issue へ前後関係を張らず、本文に「<記録する issue> の見直し（実行 <id>）から」と書く。

| 観点 | 一覧 | 行き先 |
|---|---|---|
| 効き | `summary.md` の変異スコア・`candidates.effect` | タスクにしない（変えた所は Pull Request ごとの Mutation PR が見る）。6 に数を書く |
| 重なり | `candidates.overlap` のうち `previous` が真のもの | 空なら何もしない（前回が無い・2回続けて候補になったものが無い）。あれば、1件ずつ `breaks`（落ちると利用者に何が壊れるか）と、それを `kept_test` が守るかを書いた表を記録する issue に載せ、消すかをユーザーに問う（.claude/skills/ask/SKILL.md「問い」）。消すと決まったもので、記録する issue を親にして、消す子を作る（下の「消す子」） |
| 隔離 | `candidates.isolation` | あれば、1つのタスクに並べて起こす。やることは run-checks/SKILL.md「実行順をばらす」の汚した側の探し方 |
| 書き方 | `candidates.writing` | あれば、1つのタスクに並べて起こす。やることは testing-review.md の書き方（1本ずつ3問へ通し、型として決まったものを「消すべきテストの型」と構造の検査に足す） |

起こす前に、同じ直す場所の開いたタスクがあれば、新しく起こさずそこへコメントで足す（.claude/skills/file-issue/SKILL.md「改善を起票する」の重ねない）。

**消す子**（.claude/skills/file-issue/SKILL.md「分ける」の「機能ごとに子に分ける」）:

- テストのファイルの並びで、子1つあたりテスト関数の行（`lines` の和）が約600行までに分ける。
- 子ごとに「<テストのファイルの範囲> の重なったテストを消した」の行を、その子の本文の完了の条件に置く（記録する issue には置かない）。
- 子の本文のやることに、消すテスト関数の表（テスト関数・行数・高さ・`mutant`・`kept_test`・問いに書いた `breaks`）と、次の確かめを書く。
  1. 表のテスト関数を消す。
  2. 表の `mutant` を1行ずつ `only.txt`（置き場は `backend/scripts/mutation/`）に書いて作業ブランチへ push し、
     `gh workflow run mutation.yml -R ridecompass/ride-compass --ref <作業ブランチ> -f ref=<作業ブランチ>` で回す（一覧だけを回し、
     当て直しと review は走らない）。成果物 `mutation-*` の `results.jsonl` で表の変異が全部 `killed` で、`kills/` にその行の
     `kept_test` があることを見る。
  3. `only.txt` を消してから Pull Request を出す（残すと `backend/tests/structure/test_mutation_lists_absent.py` が CI で落とす）。テスト全体が通ることは Pull Request の CI が見る。CI で
     落ちたテストがあれば、消したテストを戻して隠さず、testing-review.md の隔離のとおり汚した側を直す（直すまで、そのテストは消さない）。
  4. Pull Request の本文の検証に、testing-review.md「消す・まとめる前に、残す側が落ちるかを見る」の4の表を、2 の変異と結果で書く。

### 6. 記録して終える

1. 記録する issue へコメントする: 実行の id と URL・測った版・比べた前回の版・`summary.md` の表・5 で起こした（コメントを
   足した）タスクの番号・3 で止めたならその理由。成果物 mutation-review は90日で消えるので、数はコメントに残す。
2. 片付け: 4 で取ってきた場所を消す。作業ツリーを作ったなら消す。
3. 記録する issue の完了の条件の済んだ行にチェックを付ける（全部済めばゲートが閉じる）。
   消す子の行は付けない（子が閉じたときにゲートが付ける）。終えたら持ちを手放す（dev-session「持つ」）。
4. ユーザーへ報告する: 観点ごとの数・起こしたタスク・止めたならその理由。

## 厳選まで仮置き

原則の見直しで消えた記載を、厳選まで元の節ごとに仮に置く。**今の決まりと食い違えば今の決まりを取る。**

### 元: .claude/skills/test-review の SKILL.md

#### 2. 測りを起こす

- 測りは8本のランナーを約1時間半使い、アカウントで同時に動かせるジョブの枠を担当（Claude Task）・CI と分け合う。担当や CI が
  多く動いているとき（`gh run list -R hidakagit/ride-compass --status in_progress`）は、測りの空き待ちが延び、そのあいだ担当と
  CI の待ちも延びる。起こす前に動いている数を見て、6 の記録に書く。

#### 3. 待つ

終わった本の記録は、実行全体が終わる前でも
`gh api --allow-escape-sequences repos/hidakagit/ride-compass/actions/jobs/<ジョブの id>/logs` で読める（`gh run view --log` は
実行全体が終わるまで読めない。ジョブの id は `gh run view <id> --json jobs`）。本の中の手順ごとの始まりと終わりは
`gh api repos/hidakagit/ride-compass/actions/jobs/<ジョブの id>` の `steps` で見られ、1つの手順が見込みより長く止まっていれば
（DB を用意する手順は普段1分弱、変異の生成と記録は約9分）、下の「落ちたとき」に当たるかを見る。

- **shard の1本が「The runner has received a shutdown signal」で止まった**（変異がランナーのメモリを使い切った）:
  `gh run rerun <id> -R hidakagit/ride-compass --failed` で落ちた本と、それに続く段だけをやり直す。同じ本が続けて止まるなら、
  その本の記録（`gh run view <id> --job <ジョブの id> --log`）の最後の「始め <変異>」の変異が原因なので、6 の記録に書いて止める
  （台本の直しは、その回の外のタスクにする。.claude/skills/file-issue/SKILL.md「改善を起票する」）。

- **それ以外で落ちた**: `gh run view <id> -R hidakagit/ride-compass --log-failed` で読む。台本・ワークフローの誤りなら、その回の
  中で直さず、起票して 6 の記録に書いて止める（直したあとの回で測り直す）。

#### 5. 観点ごとに行き先を決める

2. 表の `mutant` を1行ずつ `only.txt`（置き場は `backend/scripts/mutation/`）に書いて作業ブランチへ push し、
   `gh workflow run mutation.yml -R hidakagit/ride-compass --ref <作業ブランチ> -f ref=<作業ブランチ>` で回す（一覧だけを回し、
   当て直しと review は走らない）。成果物 `mutation-*` の `results.jsonl` で表の変異が全部 `killed` で、`kills/` にその行の
   `kept_test` があることを見る。

3. `only.txt` を消してから Pull Request を出す（master へ入れない）。テスト全体が通ることは Pull Request の CI が見る。CI で
   落ちたテストがあれば、消したテストを戻して隠さず、testing-review.md の隔離のとおり汚した側を直す（直すまで、そのテストは消さない）。

#### 6. 記録して終える

3. 消す段階を作らなかったら、記録する issue の完了の条件を確かめて閉じる（`GH_TOKEN=$FLOW_BOT_TOKEN gh issue close <番号> -R ridecompass/ride-compass-tasks --reason completed`）。
   作ったら閉じない（`stage.js` が段階を親の前提に張り、段階が全部閉じたあとで担当が親を閉じる。file-issue「段階に分ける」）。
   どちらも、終えたら持ちを手放す（dev-session「持つ」）。
