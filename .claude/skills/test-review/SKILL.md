---
name: test-review
description: "テストを3つの層（backend・frontend の単体テストと e2e）で見直す（層ごとに候補を出す・候補ごとに壊れるものを書く・ユーザーに決めてもらう・決めたとおりに消す／足す／直すタスクにする・記録する）。テストの定期の見直しをするとき・テストの見直しを頼まれたときに使う。"
---

## テストの見直しを回す

導く原則: 1・4・5。

3つの層（backend の単体テスト・frontend の単体テスト・e2e）のテストを、同じ物差し（.claude/rules/testing.md「そのテストは要るか
（3問を順に）」と効き）で見直す1回の手順。開発機の対話のセッションが、この手順だけで始めから終わりまで進める。流れはどの層も同じで、
候補を出す（2〜3 と、待つ間の e2e）→ 候補ごとに「落ちると利用者に何が壊れるか」を書く（4）→ ユーザーに決めてもらう（5）→ 決めたとおりに消す・足す・
直す（6）。層ごとに違うのは候補を出す所だけ。何を候補にし、どう消すかの決まりは .claude/rules/testing-review.md「テストを変異テストで
見直す」（単体テスト）と「e2e を3問で見直す」が持ち、ここには書かない。

| 層 | 候補の出し方 | 回すもの | 見直しの成果物 |
|---|---|---|---|
| backend の単体テスト | 変異テストの全部の測り | `.github/workflows/mutation.yml`（台本 `backend/scripts/mutation/`） | `mutation-review` |
| frontend の単体テスト | 変異テストの全部の測り | `.github/workflows/mutation-frontend.yml`（台本 `frontend/scripts/mutation/`） | `mutation-frontend-review` |
| e2e | 1本ずつ読んで3問を当てる | 無し（手で読む） | 記録する issue の表 |

どちらのワークフローも、先頭のコメントに段の中身と持ち時間がある。

### 1. 始める

1. **記録する issue を決める**: 頼まれたときに issue の番号があればそれ。無ければ .claude/skills/file-issue/SKILL.md「issue の形」の
   とおり、種類は保守、題名「テストの定期の見直し（<日付>）」で起こす（やること: この節の 2〜7、完了の条件: 7 の記録と、5 で
   決めたものを 6 で子・タスクにしたこと、と `- 確かめる: ユーザー` を付けた見直しの結果の行。子があるうちは閉じない親にするため）。
2. **持つ**: .claude/skills/dev-session/SKILL.md「開発機の対話のセッション」の「持つ」で持つ。
3. **計画を伝える**（CLAUDE.md「作業の進め方」）: 何をどの順で、どれくらいかかるか。2つの測りを続けて起こし、待つ間に e2e を読む。
   どちらの測りの本も記録する issue のレーンへ載るので、同じレーンで順に待ち、実時間は2つの和に近い（2つを続けた実時間は未計測）。
   - backend: 2026-10-18 の測り（15本、実行 39099279906）で、shard 1本あたり1時間28分〜2時間38分（変異の生成 約4分・変異と基準
     61〜87分・当て直し 21〜72分）。本は issue のレーンへ3本ずつ載るので3巡して実時間で約7時間25分、review 1分未満。
   - frontend: 2026-10-12 の試し（16本を同時に、レーンの無い版で）で、1本27分〜1時間20分。レーンへ載せてからの実時間は未計測。
   - どちらにも、ランナーの空き待ち（2026-10-10 の試しで、段ごとに最長16分）が足される。

### 2. 単体テストの測りを起こす

    gh workflow run mutation.yml -R ridecompass/ride-compass --ref master -f ref=master -f issue=<記録する issue の番号>
    gh workflow run mutation-frontend.yml -R ridecompass/ride-compass --ref master -f ref=master -f issue=<記録する issue の番号>

- `--ref` はワークフローの定義を読む版、`-f ref=` は測る版（台本も同じ版から読む）。ふだんはどちらも master。`-f issue=` は 1 で決めた
  issue で、測りはその issue のレーンで動く（docs/architecture/tech-stack.md「CIの実行枠」）。frontend の `mutate`・`compare` は
  空のままにする（`mutate` で範囲を絞った測りは、次の見直しの前回に残らない）。
- 起こした実行の id は、`gh run list -R ridecompass/ride-compass --workflow <ワークフロー> -L 1 --json databaseId,createdAt,status` で
  取り、`createdAt` が起こした時刻のあとであることを見る。
- 同じワークフローが動いていれば、終わるまで待ってから始まる（ワークフローごとの `concurrency`）。
- 測りの本は issue のレーン（担当のレーンのほか）に載り、レーンより多い本は前の本が終わるまで待つ。その間、同じ issue の
  Pull Request の CI も同じレーンで待つ。ほかの issue の担当・CI とは、組織で同時に動かせるジョブの枠を分け合う。担当や CI が
  多く動いているとき（`gh run list -R ridecompass/ride-compass --status in_progress`）は、測りの空き待ちが延びる。起こす前に
  動いている数を見て、7 の記録に書く。

### 3. 待つ

段（shard の各本・review）が終わるたびに知らせる。黙って待たない（CLAUDE.md「長い待ちで黙って待たない」）。待ち方は、
実行ごとに Monitor で次を回す（ジョブが終わるたびに1行出し、実行が終われば抜ける）。

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
（backend の DB を用意する手順は普段1分弱、変異の生成と記録は約9分）、下の「落ちたとき」に当たるかを見る。

落ちたとき:

- **shard の1本が「The runner has received a shutdown signal」で止まった**（変異がランナーのメモリを使い切った）:
  `gh run rerun <id> -R ridecompass/ride-compass --failed` で落ちた本と、それに続く段だけをやり直す。同じ本が続けて止まるなら、
  その本の記録（`gh run view <id> --job <ジョブの id> --log`）の最後の「始め <変異>」の行の変異が原因なので、7 の記録に書いて止める
  （台本の直しは、その回の外のタスクにする。.claude/skills/file-issue/SKILL.md「改善を起票する」）。
- **backend の shard の1本が、DB を用意する手順（`./.github/actions/postgis`）の10分の上限で落ちた**（apt の取得が詰まった）:
  同じく `gh run rerun <id> -R ridecompass/ride-compass --failed` で1回やり直す。続けて落ちるなら、次の「それ以外」と同じに扱う。
- **1つの手順が上限の無いまま、見込みより長く止まっている**: 起こしたのは自分なので、`gh run cancel <id> -R ridecompass/ride-compass`
  で止め、止まったのを見てから `gh run rerun <id> -R ridecompass/ride-compass --failed` で、止めた本と続く段をやり直す（止まった本は
  ランナーの枠を使い続け、担当や CI の待ちを延ばす）。担当や CI の実行は止めない。
- **それ以外で落ちた**: `gh run view <id> -R ridecompass/ride-compass --log-failed` で読む。台本・ワークフローの誤りなら、その回の
  中で直さず、起票して 7 の記録に書いて止める（直したあとの回で測り直す）。
- **review の段の要約に、変異を回し終えていないと出た**: その層の候補は欠けるので、その回の見直しに使えない。持ち時間を延ばすか
  本数を増やすかを起票し、7 に書いて、その層を止める（ほかの層は進めてよい）。

結果は、終わった実行ごとに取る。

    gh run download <id> -R ridecompass/ride-compass -n <見直しの成果物> -D <作業ツリーの外の使い捨ての場所>

- `summary.md`: 実行の要約と同じ表（層ごとの変異スコア・テストの区分ごとの数・観点ごとの候補の数と行数・判断できずに残したテストの
  理由・テストのファイルごとの数）。前の回の `summary.md` と比べると、効きの動きが分かる。
- `candidates.md`: 候補を観点ごとに1件1行で並べた表。「落ちると利用者に何が壊れるか」の欄は空で出る（4 で書く）。
- `review.json` には次の欄がある。`measured`（測った版）・`previous`（比べた前回の版。無ければ null）・`complete`・`mutants`（結果ごとの
  変異の数）・`candidates`・`kept_reasons`。`candidates` は観点ごとの一覧で、`effect`（効き。生き残りと、どのテストも通らない変異）・
  `overlap`（重なり。テスト関数ごとに `hash`・`lines`・`height`・消したあとの確かめに使う `mutant` と、それを見つける残すテスト
  `kept_test`・前回も候補で中身が同じなら真の `previous`）・`isolation`（隔離）・`writing`（書き方。`form` が形）。`isolation` の
  ほかは、1件ごとに空の `breaks`（落ちると利用者に何が壊れるか）を持つ。frontend の表は基準を回さないので、`isolation` は空。
- `report.json`: 測りの結果の表（層や道具に依らない Stryker の結果の JSON の形。読み方は `backend/scripts/mutation/report.py` の先頭）。
  `overlap` の `mutant` は、この表の `files.<ファイル>.mutants[].id`（ファイル・場所・書き換えを引ける）。

### 待つ間に: e2e の候補を出す

測りを待つ間に、e2e のテストを1本ずつ読む。

1. 一覧を機械で出す: `npx --prefix frontend playwright test --list --project=chromium`（全状態の走査は Chromium だけで回り、
   WebKit は同じテストの残りを回すので、Chromium の一覧で全部が出る）。
2. 1本ずつ、testing-review.md「e2e を3問で見直す」の3問を当て、当たったものを候補の表にする: テスト（ファイル:行 › 名前）・
   見ている観点（冒頭のコメントから。言えなければ「言えない」）・当たった問い・行き先（消す・vitest へ移す・コメントを直す）・根拠
   （1問目なら同じ観点を見る走査の検査、3問目なら同じものを見る別のテスト）・落ちると利用者に何が壊れるか（4 で書く）。
3. 当たらなかったテストの数も 7 の記録に書く（見直した母集団が分かるように）。

### 4. 候補ごとに「落ちると利用者に何が壊れるか」を書く

testing.md の2問目（その答えはモジュールの外——利用者の画面・他モジュール・配信される値・保存されるデータ——について）で書く。
言えない候補は、言えないと書く（重なり・e2e の候補なら消す側を支える材料、効きの候補なら足さない材料になる）。

- **重なり**: `candidates.md` の重なりの表の欄を埋め、その壊れを `kept_test` が守るかも書く。
- **効き**: 生き残りの書き換えが入ると何が壊れるかを書く。同じ関数の生き残りで壊れが同じものは1行にまとめてよい。件数が多ければ、
  層・ファイルごとの数を先にユーザーへ見せ、どこから書くかを問う（.claude/skills/ask/SKILL.md「問い」）。
- **書き方**: そのテストが落ちるとき何が壊れるかを書く。書けば、そのテストを1本ずつ3問へ通した答えになる。
- **e2e**: 待つ間に作った表の欄を埋める。
- **隔離**: 書かない（汚した側を探して直すもので、壊れるものでは決めない）。

### 5. ユーザーに決めてもらう

4 で書いた表を、層ごと・観点ごとに記録する issue へ載せ、候補ごとに消す・足す・直す・残すを問う（.claude/skills/ask/SKILL.md「問い」）。
表には、重なりなら前回も候補だったか（`previous`）、e2e なら根拠の走査の検査・別のテストを添える。隔離は問わない（6 で直すタスクにする）。

### 6. 決めたとおりに子・タスクにする

起こすタスクは、記録する issue へ前後関係を張らず、本文に「<記録する issue> の見直し（実行 <id>）から」と書く。起こす前に、
同じ直す場所の開いたタスクがあれば、新しく起こさずそこへコメントで足す（.claude/skills/file-issue/SKILL.md「改善を起票する」の重ねない）。

| 決めたもの | 行き先 |
|---|---|
| 消す（重なり・書き方・e2e） | 記録する issue を親にして、消す子を作る（下の「消す子」） |
| 足す（効き） | 記録する issue を親にして、足す子を作る。やることに、生き残りの書き換え（ファイル・行・書き換え）と 4 で書いた壊れを並べ、足したテストがその書き換えで落ちることを見る（testing.md「挙動を変えたら、入口で確かめる」）。子の分け方は消す子と同じ |
| 直す（書き方・e2e のコメント・vitest へ移す） | 1つのタスクに並べて起こす。やることは testing-review.md の書き方（型として決まったものを「消すべきテストの型」と構造の検査に足す）か、e2e の移す・直す |
| 隔離（問わない） | あれば、1つのタスクに並べて起こす。やることは .claude/skills/run-checks/SKILL.md「実行順をばらす」の汚した側の探し方 |

**消す子**（.claude/skills/file-issue/SKILL.md「分ける」の「機能ごとに子に分ける」）:

- 層ごとに、テストのファイルの並びで、子1つあたり消すテストの行（`lines` の和。e2e は読んだ行数）が約600行までに分ける。
- 子ごとに「<テストのファイルの範囲> の、見直しで消すと決めたテストを消した」の行を、その子の本文の完了の条件に置く（記録する issue には置かない）。
- 子の本文のやることに、消すテストの表（テスト・行数・高さ・`mutant`・`kept_test`・問いに書いた壊れ。e2e は根拠）と、次の確かめを書く。
  1. 表のテストを消す。
  2. 残す側が落ちるかを見る（testing-review.md「重なり」の4と「消す・まとめる前に、残す側が落ちるかを見る」）。
     - backend: 表の `mutant` を1行ずつ `only.txt`（置き場は `backend/scripts/mutation/`）に書いて作業ブランチへ push し、
       `gh workflow run mutation.yml -R ridecompass/ride-compass --ref <作業ブランチ> -f ref=<作業ブランチ> -f issue=<子の番号>` で回す
       （一覧だけを回し、当て直しと review は走らない）。成果物 `mutation-*` の `results.jsonl` で表の変異が全部 `killed` で、
       `kills/` にその行の `kept_test` があることを見る。`only.txt` は消してから Pull Request を出す（残すと
       `backend/tests/structure/test_mutation_lists_absent.py` が CI で落とす）。
     - frontend: 表の `mutant` の書き換え（見直しの `report.json` で引いたファイル・場所・書き換え）のファイルを `-f mutate=<frontend
       からのパス,...>` に渡し、`gh workflow run mutation-frontend.yml -R ridecompass/ride-compass --ref master -f ref=<作業ブランチ>
       -f issue=<子の番号> -f mutate=<…>` で回す（名指したファイルだけを1本で回す）。成果物 `mutation-frontend-shard-0` の
       `mutation.json` で、同じ場所・同じ書き換えの変異が `Killed` で、`killedBy` にその行の `kept_test` があることを見る。
     - e2e: 消すテストが落ちる壊れ方を1つ書き、実装の行を一時に変えて、根拠の spec だけを
       `npx --prefix frontend playwright test <spec>` で回して落ちることを見てから戻す。
  3. テスト全体が通ることは Pull Request の CI が見る。CI で落ちたテストがあれば、消したテストを戻して隠さず、testing-review.md の
     隔離のとおり汚した側を直す（直すまで、そのテストは消さない）。
  4. Pull Request の本文の検証に、testing-review.md「消す・まとめる前に、残す側が落ちるかを見る」の4を、2 の壊れ方と結果で書く。

### 7. 記録して終える

1. 記録する issue へコメントする: 層ごとに、実行の id と URL・測った版・比べた前回の版・`summary.md` の表（e2e は見直したテストの数と
   候補の表）・6 で起こした（コメントを足した）子・タスクの番号・3 で止めたならその理由。成果物の見直しは90日で消えるので、数は
   コメントに残す。
2. 片付け: 取ってきた場所を消す。作業ツリーを作ったなら消す。
3. 記録する issue の完了の条件の済んだ行にチェックを付ける（全部済めばゲートが閉じる）。
   子の行は記録する issue に無い（子の本文にある）。ユーザーが確かめる行は残り、子が全部閉じるとゲートがユーザーに確かめを問う。終えたら持ちを手放す（dev-session「持つ」）。
4. ユーザーへ報告する: 層ごと・観点ごとの数・決めたもの・起こした子とタスク・止めたならその理由。
