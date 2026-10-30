---
name: task-work
description: "タスクを実装担当・検証担当として進める手順（作業ブランチ・依存・issue を読む・コミット・下書きの Pull Request・画面の撮影・確かめ・差し戻し・マージ・競合・範囲の外の気づき・終え方）。タスクに着手するとき・Pull Request を出すとき・確かめてマージするときに使う。"
---

実装担当・検証担当は、担当のワークフローが取り出した作業ツリーの中だけで作業し、ステータスは書かない（ゲートが事実から決める。
`docs/conventions/flow.md`「ステータスと割り当て」）。どの終わり方でも、push と issue への報告をして終える。
担当は、この冒頭と自分の担当の節（と末尾の「競合を解く」）だけを読んで進めるので、片方の担当の節から他方の担当の節を指さない。

- **終え方**: 最後の発言は、その回の要約にする（後始末が終わりのコメントへ写す）。終わり方（PR を出した・問うた・分けた・
  マージした・下書きへ戻した等）と、作ったもの・書いたもの（Pull Request・コミット・問い・issue）を番号かコミットの ID で名指す。
  手順の中で当たった流れの摩擦は .claude/skills/file-issue/SKILL.md「流れの摩擦を記録する」のとおり書く。
- **範囲の外の気づき**（今のタスクの外の製品の誤りや残骸と、範囲の外として入れなかった案。`/simplify` 等が見送った設計の手直しも）: 今の差分で直せるものは直す。ほかは1件ずつ、直す場所が同じ開いた issue へ
  コメントで寄せるか（探し方は .claude/skills/file-issue/SKILL.md「前後関係と組」）、無ければ起票するか（保守は起こさずに「保守の候補:」の行を書く。
  .claude/skills/file-issue/SKILL.md「起票する」）、直さない理由を書き、どれをしたかを
  Pull Request の本文の「課題」（無ければ報告）に書く。「周期レビューの材料」「要るなら別に起こす」は行き先に数えない。
  寄せたあと、寄せ先がまだ開いているかを `--json state` で見て、閉じていれば起票する（探してから書くまでに閉じると、コメントは誰にも読まれない）。
- **作業ブランチ**: `git fetch origin`。作業ブランチ `orch/tasks-<番号>` が GitHub にあれば `git checkout -B orch/tasks-<番号> origin/orch/tasks-<番号>` のあと
  `git merge origin/master`（競合したら「競合を解く」）。無ければ `git checkout -B orch/tasks-<番号> origin/master`。前の担当の残り
  （`wip/tasks-<番号>-*` の枝）があれば要るものを取り込み、枝を消す。
- **依存**: 依存とテスト用の DB は担当のワークフローが master の版で入れてある。`git diff --name-only origin/master -- backend/requirements*.txt frontend/package-lock.json`
  で違いが出たら、backend は `python -m pip install -q -r backend/requirements-batch.txt -r backend/requirements-dev.txt`、frontend は
  `npm ci --prefix frontend` と `npx --prefix frontend playwright install chromium` で入れ直す（Chromium は `@playwright/test` の版ごとに別のものが要る。
  作業の途中で依存のファイルを変えたときも同じ）。
- **GitHub の側の失敗**（push・gh の書き込みが `Internal Server Error`・`Something went wrong while executing your query` 等の 5xx で落ちた）: 2分おいて
  同じコマンドを1つで打ち直す（`sleep 120; <落ちたコマンド>`。Bash の `timeout` は 600000）。gh の書き込みは、打ち直す前に書けていないかを読む
  （落ちたと出ても書けていることがあり、打ち直すと二重になる）。打ち直しは10回まで（間を含めて20分強）で、使い切ったらpush していない変更とコミットの ID・落ちたコマンドと最後の文言を
  報告に書いて終える（push していない変更は後始末が `wip/` の枝へ残す）。GitHub の公式の文書は打ち直しの間と回数を決めていないので、この手順が持つ。
- **置き場の issue**（`ridecompass/ride-compass-tasks`）を gh で読む・書くときは `GH_TOKEN=$FLOW_BOT_TOKEN` を付ける（担当の既定の鍵は置き場を読めず、`gh issue view` が「見つからない」と返す）。
- **完了の条件のチェック**は `node .claude/skills/task-work/scripts/check.mjs <番号> <条件の文の頭> [...]` で付ける（本文を手で書き換えない）。

**実装担当**
1. 作業ブランチを取る（冒頭の「作業ブランチ」）。
2. 依存を揃える（冒頭の「依存」）。
3. issue の本文とコメントを読む（`GH_TOKEN=$FLOW_BOT_TOKEN gh issue view <番号> -R ridecompass/ride-compass-tasks --json title,body,comments --jq '.title, .body, (.comments[] | "--- \(.author.login) \(.createdAt)", .body)'`。
   `--comments` は本文を出さない）。下書きへ戻されたタスクなら、Pull Request のコメントも読む。CLAUDE.md と規約のとおりに作る。
   - ユーザーが書いた文（答えの文・コメント）のうち、前の担当の終わりの「読み始め」より後のものを読む。直してほしいこと・同じ要望の足し分なら
     完了の条件に行を足して作り、別の要望なら切り出し（.claude/skills/file-issue/SKILL.md「分ける」）、問いなら答える。
   - 作る前に、答えの無い判断（方針・目的の読み・見た目の案・本番への書き込み・長く残る形。長く残る形は
     .claude/skills/file-issue/SKILL.md「issue の形」の「長く残る形は、作る前に合意する」の設計の項を書いてから）が残っていれば、問いに要る分だけ調べて、作らずに問う
     （.claude/skills/ask/SKILL.md「問い」）。issue の本文が「この issue で決める」としているものも、ここに当たる。
   - 自分の直す場所で開いた issue を探し、前後関係と組を張る（.claude/skills/file-issue/SKILL.md「前後関係と組」）。
   - 開発機にしか無いもので確かめる完了の条件は、同じことをテスト DB・CI で確かめる形へ書き換え、経緯に理由を書く。確かめる範囲が
     狭まるなら書き換えず、`docs/conventions/flow.md`「担当」の「開発機でしかできない作業」のとおり返す。
   - 1つの Pull Request に収まらないと分かったら、.claude/skills/file-issue/SKILL.md「分ける」のとおり約束の行を移管して終える（約束が動いたので、
     ゲートは絞った残りを次の実装担当へ渡す。docs/conventions/flow.md「issue のライフサイクル」の実行の終わり）。
   - マージのコミットの master の CI が落ちて戻ってきたら、マージのコミットとそれより後の master の実行の落ちたジョブ（`gh run list -R ridecompass/ride-compass --branch master`）を
     読む。打ち直さない: ゲートは、マージのコミットの実行より後に作られた master の実行のどれかが通れば本番に出たと読む（`tools/flow-gate/src/facts.js: shippedChecks`）
     ので、一時の失敗は後の実行が通れば覆い、打ち直すと待っている後の実行が取り消されうる。この変更の誤りで落ちたなら、直す Pull Request を出す。
     この変更の誤りでない理由で落ち続ける（後の実行も同じ理由で落ちる）なら、原因を持つ issue（無ければ .claude/skills/file-issue/SKILL.md「起票する」のとおり起こす）を
     前提に張り（`GH_TOKEN=$FLOW_BOT_TOKEN gh issue edit <番号> -R ridecompass/ride-compass-tasks --add-blocked-by <原因の番号>`）、落ちたジョブと張った理由を経緯に書いて
     手放す（ゲートは前提が開いている間は待機にし、閉じたらまた決め直す）。どれもせずに手放すと、ゲートがイレギュラーを問う。
   - マージのあとの残りは、済ませて完了の条件にチェックを付ける。時間を待つものだけが残るなら、欄「着手可能日時」に済ませられる
     日本時間を入れ（.claude/skills/file-issue/SKILL.md「ラベルと種類と欄」）、何をその日に済ませるかをコメントに書いて終える。その日に
     振り出されたら、済ませて欄を消す。確かめの行だけが残るなら何もしない（ゲートが本番に出てから確かめを問う）。
   - 子の作業なら、子の本文の完了の条件（親から移管された機能の行）を満たす。親の本文は背景として読む。
   - 子に分けた親が振り出されたら（子が全部閉じ、Claude が確かめる行が親に残っている）、その条件を確かめてチェックを付ける。
     作る変更が要る条件は、親で作らず、その行を移管した子を足して終える（.claude/skills/file-issue/SKILL.md「分ける」）。
   - コードを変えないタスク（調査・計測）は、結果を本文に書く。結果を見てほしいなら、先に `- 確かめる: ユーザー` と `- 見る所と要点:` を
     付けた条件を足し（.claude/skills/file-issue/SKILL.md「ユーザーが確かめる条件」）、そのあとで自分の分の条件にチェックを付ける
     （条件が全部済むと、ゲートがその場で閉じる）。
   - 閉じない。条件に全部チェックが付き、本文の「やること」の項目が全部行き先を名指せば、ゲートが完成で閉じる。
   - 「やること」の項目の行き先（.claude/skills/file-issue/SKILL.md「issue の形」の「やることの行き先」）は、自分の分の最後の条件にチェックを
     付ける前に書く。ゲートが「行き先を名指していない」と知らせて戻したら、名指された項目に書く。手を付けていない項目は、同じ要望なら子か
     切り出しへ移してその番号を、続けるかをユーザーが決めるなら問うてその答えを行き先にする（見送りを自分で決めない）。
4. `tasks#<番号>:` の件名でコミットし、`git push origin orch/tasks-<番号>` を、ほかのコマンドとつながずに1つで打つ（拒否の一覧の
   `Bash(git push *master*)` はつないだ全文に当たる）。手元で回す検査と整形は .claude/skills/run-checks/SKILL.md「手元の検査の回し方」だけが決め、
   全体は CI に任せる。作業ブランチの強制 push は断られるので、直しは足すコミットにする。
5. マージの前に済ませる本番への書き込みが要るなら、出さずに `docs/conventions/flow.md`「担当」の「自動で進めないもの」のとおり返す。
   **下書きの** Pull Request を出す（`gh pr create --draft --base master --head orch/tasks-<番号> --title <題名> --body-file <本文>`。gh の既定の
   名義のまま）。前の Pull Request が開いていれば、新しく出さずに push する。**CI は待たずに手放す**（ゲートが検査にし、合格すれば
   レビュー可能にして検証担当へ渡し、落ちたら実装担当へ戻す）。
   ただし手放す前に、CI が始まったこと（push した版の検査が GitHub に出たこと）を `gh pr checks <番号> -R ridecompass/ride-compass` で確かめる
   （CI が始まる形で push するのは実装担当の責務。検査が1つも無いまま手放すと、ゲートがイレギュラーを問う）。行が出るまで打ち直し、2分出なければ
   `gh pr view <番号> -R ridecompass/ride-compass --json mergeable` で master とぶつかっていないかを見て、ぶつかっていれば作業ブランチへ
   `git merge origin/master` で取り込み（「競合を解く」）、push し直す。それでも出なければ、出ないことを報告して終える。CI の結果は待たない。
   戻ってきたら、落ちた検査（`gh pr checks <番号> -R ridecompass/ride-compass`）と Pull Request のコメントを読んで直す。
   直し方は .claude/rules/testing.md「テストが落ちたときの直し方」。
   - **本文**: 題名と本文はそのまま master のコミットになる（`docs/conventions/flow.md`「コミット」）。`.github/pull_request_template.md` を
     作業ツリーの外へ写して `<…>` を埋め、`node scripts/pr-body.js <本文>` で形を照らしてから渡す。直すときは
     `gh issue edit <番号> -R ridecompass/ride-compass --body-file <本文>`。本番の宛先の値は書かず、tech-stack.md「本番の宛先」の名で書く。
   - **画面に届く変更**: 変えたコードを使う・見せる画面と状態を漏らさず、前後を `node frontend/scripts/capture.mjs --script <脚本>` で撮り
     （口と使い方はスクリプトの先頭、例は `frontend/capture/examples/`）、Pull Request のコメントに1枚ずつ貼る
     （`gh pr comment <番号> -R ridecompass/ride-compass --body <見出し> --attach '<画像>#<見出し>'`。見出しに画面・幅を書き、画像はコミットしない）。
     前は本番（`--app production`）、後は作業ツリーの版を本番の backend へ向けて（`--api <本番の backend>`）同じ脚本で撮る。DB を読まない
     backend の経路が変わるなら `--backend <パスの頭>`、DB を読む経路は脚本の `patch` で応答を差し替える。本番で開けない画面は e2e の
     モックで、前は `--app origin/master` で撮る。本番の版と合流点の間で撮る画面の frontend が変わっていたら、前は `--app <合流点>` で撮る。
     脚本の全文と打った引数は、撮ったあとのコメントに `<details>` で畳んで貼る。画面に出ない変更は、確かめ方と根拠を検証に書く。
6. issue の本文（経緯。ユーザーが確かめる条件の `- 見る所と要点:` を、見る先へのリンクと何が作られ・何が分かったかで埋める）を直し、
   Pull Request へのリンクを報告する。Pull Request を出したタスクでは、完了の条件にチェックを付けない（付けるのは検証担当の5。ゲートは約束が
   全部果たされたら Pull Request に関係なく閉じるので、ここで付けると検証担当が振り出されず、Pull Request がマージされないまま残る）。

**検証担当**（検査が合格したタスク。作った担当とは別）
1. 作業ブランチと依存を取り（冒頭の「作業ブランチ」「依存」）、Pull Request（`gh pr view <番号> -R ridecompass/ride-compass --json title,body,comments,reviews`）・差分・
   issue の完了の条件・変更が届く範囲を、実装担当の報告を写さずに自分で見る。完了の条件と、利用者に見える結果（画面・API の応答・
   テストが見る振る舞い）を先に見る。画面は実装担当と同じ道具・脚本で後を撮り、前は貼られた画像（コメントの添付の URL を
   `curl -sSL -o <作業ツリーの外> <URL>` で取って Read で見る）と比べる。`lost_constraints.py` も回し、「消えた」制約に本文の処置が無ければ満たしていない。
   ゲート（`tools/flow-gate/`）の変更は、事実を `tools/flow-gate/src/decide.js: decide` へ渡して出る値で見る（本物の GitHub へは書かない）。
2. 結果を、満たしていてもいなくても issue にコメントで書く（見出し「確かめた結果」。条件ごとに、何をどう見て何が出たか）。
3. 利用者から見える振る舞い・モジュールの設計が変わるなら、完了の条件（子の作業なら親の完了の条件。ユーザーが確かめるのは要望の結果なので）に `- 確かめる: ユーザー` と `- 見る所と要点:` を付けた条件を足して理由を書く（マージは待たない。テスト・CI で合否が決まることは足さない。
   .claude/skills/file-issue/SKILL.md「ユーザーが確かめる条件」）。
   issue の答えがマージの前のユーザーの確認を求めていて答えがまだなら、マージせずに問う。実装担当の着手より後に届いた依頼
   （コメント）と、範囲の中で master に残る直し漏れは、完了の条件にチェックの無い行として足す（戻す理由にしない。マージのあとの残りになる）。
   開発機にしか無いもので確かめる行だけが残るなら、マージの前に対話作業の issue を起こして前提に張る（.claude/skills/file-issue/SKILL.md「分ける」）。
4. 満たしていなければ、足りないことを Pull Request のコメントに書き、下書きへ戻す（`gh pr ready <番号> -R ridecompass/ride-compass --undo`。
   `gh pr view --json isDraft` が `true` になるまで打ち直す）。ゲートが実装担当へ戻す。
5. 満たしていれば、完了の条件に本番での前後の比べがあり、今の本番の前の値が issue に無ければ、本番を読むだけの口
   （`backend/scripts/prod_route_check.py` と同じ口）で取って書いてからマージする。読むだけの口で取れないなら、4 のとおり戻し、前の値を取る
   対話作業の issue を起こして前提に張る。
   `gh pr merge <番号> -R ridecompass/ride-compass --squash` でマージし、`MERGED` になるまで打ち直す。マージのコミットの
   master の CI が始まったことを `gh run list -R ridecompass/ride-compass --commit <マージのコミット>` で確かめる（行が1つ以上出るまで打ち直す。
   2分出なければ、出ないことを報告する。検査が1つも無ければ合格していないので、ゲートが実装担当へ渡す）。CI の結果は待たない。
   マージのあとの残り（マージのあとの条件・ユーザーの確かめ）で issue が開いたまま残るなら、この issue を前提にしている後の issue
   （`--json blocking`）を1件ずつ見て、後が依っていた中身（後に書かれた張った理由）がこの Pull Request で master に入り、残りに依らなければ
   前提を外し（`GH_TOKEN=$FLOW_BOT_TOKEN gh issue edit <後> -R ridecompass/ride-compass-tasks --remove-blocked-by <番号>`）、外した理由を後の issue に書く
   （外さないと、後は残りが済んで閉じるまで待機のまま）。
   最後に、確かめた条件に `check.mjs`（冒頭の「完了の条件のチェック」）でチェックを付けて終える（確かめの行・マージのあとの条件・3 で足した行は
   付けない。子の作業も同じく、子の本文の行に付ける）。ゲートは条件が全部済むとその場で issue を閉じて動いている実行を取り消すので、
   チェックはマージのあとの最後の手にする（先に付けると、マージの前に取り消されうる）。
6. master と競合してマージできなければ、`git fetch origin` で今の master を取ってから（1 で取った master の上では競合しないことがある）
   `git -c merge.conflictStyle=diff3 merge origin/master` で取り込み、塊ごとに、合流点の行を片側だけが
   変えていれば変えた側を採り、両側が別の行を変えただけなら両方をそのまま残す。合流点の同じ行を両側が変えた塊が1つでもあれば
   `git merge --abort` で戻し、重なった所を書いて 4 のとおり戻す。解けたら push して終える（ゲートが CI を待ってまた渡す）。

**競合を解く**: `<<<<<<<`・`|||||||`・`=======`・`>>>>>>>` の印と残さない行を編集で消し、`git add <ファイル>` と `git commit --no-edit`。`--ours`・`--theirs` は使わない（判定役に断られる）。
