# 軸スタジオ管理画面（frontend）

## 責務

管理者向け（Basic認証保護下）の評価軸の画面。軸の一覧と、公開したまま折れ点・地図の段の境界を直す較正の画面を持ち、
[軸スタジオ・評価軸定義（backend）](../backend/axis-studio.md)のAPIをそのまま呼ぶ。軸を足す・材料や表示名を変える・
非公開に戻す・消すのは、軸の定義ファイルを管理APIへ入れる`backend/scripts/axis_apply.py`
（[backend](../backend/axis-studio.md)「軸の定義をファイルから本番へ入れる（`scripts/axis_apply.py`）」）が持ち、この画面には置かない。
同じ`/admin`の「材料」タブ（材料ごとの欠損割合の表示、
[評価・スコアリング（backend）](../backend/evaluation-scoring.md)「材料の欠損割合」節の
APIを呼ぶ）・「データ保守」タブ（派生データ鮮度台帳の表示、
[静的道路属性・タイル配信（backend）](../backend/static-road-attributes.md)
「派生データ鮮度台帳」節のAPIを呼ぶ）・「較正値」タブ（走ってみて決める値の編集、
[ルーティングエンジン（backend）](../backend/routing-engine.md)「較正値」節のAPIを呼ぶ）も
本モジュールが持つ。

**対象ファイル**

| ファイル | 責務 |
|---|---|
| `features/admin/AxisStudio/AxisStudio.tsx` | トップレベル。軸の一覧（下書き・公開済みのタブ）を取り、押した行の下にその軸の較正を開く。開くのは1つだけで、閉じた軸の較正は描かず、分布・地図の段・地図を取りに行かない |
| `features/admin/AxisStudio/AxisCalibration.tsx` | 1つの軸の較正（一覧の行を開いたところに出る）。数値の軸は0点・100点にする値（密度の軸は100点にする値だけ）を実データの分布を重ねた大きなグラフか数の入力で決め、対応表の軸は`CategoricalCalibration.tsx`へ渡す。数値の軸は下書きの点数で塗った地図を見ながら決める。地図は地図の機能の部品（`features/map/DraftWayValuesMap/DraftWayValuesMap.tsx`）で、機能どうしは互いを読まないため、組み立てるページ（`app/admin/page.tsx`）が`AxisStudio.tsx: AxisStudio`へ差し込む（`AxisStudio/AxisCalibration.tsx: CalibrationMapSlot`） |
| `features/admin/AxisStudio/CategoricalCalibration.tsx` | 較正の画面の対応表の軸。種類ごとに点数の入力とその種類の道の延長の割合を並べ、点数を数で直す |
| `features/admin/AxisStudio/calibrationParts.tsx` | 較正の画面で数値の軸と対応表の軸が共に使う部品。地図の段の境界の下書きと入力欄、段ごとの延長の下書きと保存済みの比べ、公開の状態のまま差し替える保存 |
| `features/admin/AxisStudio/BreakpointCurveEditor.tsx` | 較正の画面の折れ点のSVGの曲線。動かせるのは0点・100点の端だけで、横（入力値）にだけ動く。背景へ実データの分布、前へ保存済みの線と動かせる段の境界を重ねる |
| `features/admin/AxisStudio/curveDistributionOverlay.ts` | 曲線エディタの背景へ分布を重ねるための純粋関数（DOM非依存。階級のクリップ・按分、分位線、表示範囲外の割合） |
| `features/admin/AxisStudio/scoreDistribution.ts` | 分布の階級の代表値（`features/admin/AxisStudio/scoreDistribution.ts: binMidpoints`）と、地図の段ごとの延長割合（数値の軸は`features/admin/AxisStudio/scoreDistribution.ts: mapBandShares`、対応表の軸は`features/admin/AxisStudio/scoreDistribution.ts: categoryBandShares`）を求める純粋関数（DOM非依存） |
| `features/admin/AxisStudio/thresholdList.ts` | 地図の段の境界のまとめ入力の読み書きと、段の名前の上書きを段の数へ合わせる純粋関数（DOM非依存、`calibrationParts.tsx`が使う） |
| `features/admin/adminApi.ts` | 管理画面のAPIクライアントをまとめたもの。管理API（backend `/api/admin/**`）は`lib/apiClient.ts: adminApiClient`で同一オリジンの口`/admin/api/**`へ投げ、backendのパスの`/api/admin`より後をそのまま使う（例: backend `GET /api/admin/db-status`は`/admin/api/db-status`）。パス・本文・応答の型は管理APIの宣言から決まり、宣言に無いパスは型検査で落ちる（[ページ全体構成](page-composition.md)）。待ち時間は呼び出しごとに決める（全表走査の集計は`lib/apiTimeouts.ts: API_TIMEOUT_MS`の`heavyAdmin`、分布は`lib/apiTimeouts.ts: API_TIMEOUT_MS`の`distribution`）。稼働状況の口（`/health`・`/api/debug/stats`）も同じファイルに置く（フロント自身の版の口`/api/version`は、一般の画面のメニューも読むので`services/versionApi.ts`） |
| `app/admin/api/[...path]/route.ts` | 管理APIの転送の口。`/admin/api/<X>`への要求を、サーバーの環境変数から組み立てたBasic認証を付けてbackendの`/api/admin/<X>`へ、メソッド・クエリ・本文・応答の状態と本文ごとそのまま渡す。転送の待ち時間はどのクライアントよりも長く取り（`apiTimeouts.ts: ADMIN_PROXY_TIMEOUT_MS`）、打ち切りはクライアントに任せる |
| `proxy.ts` | `/admin`配下（画面と管理APIへの転送の口）の手前のBasic認証。ファイル名と`proxy.ts: config.matcher`はNext.jsの規約で、`proxy.ts: matcher`が認証を求める道を決める。資格情報が未設定なら、どの要求も拒む |
| `lib/adminBasicAuth.ts` | Basic認証の資格情報を環境変数から読む口。片方でも空なら未設定（`null`）とし、`proxy.ts`と転送の口が同じ結果を見る |
| `features/admin/useSettledDraftQuery.ts` | 下書きから組んだ問い合わせの骨格（入力をJSONにして取得の鍵にし、落ち着いてから問い合わせ、今の入力と違う答えは出さない）。答えと一緒に、今の入力の問い合わせが失敗したかを返す（届く前と失敗はどちらも答えが無いため、呼ぶ側が分けて出せるように）。backendが判定・計算を持ち、画面は下書きを送るだけの取得（例: `useScoresPreview`）が使う |
| `features/admin/useScoresPreview.ts` | 下書きの折れ点で、分布の階級の代表値がそれぞれ何点になるかを取得する（下書きが落ち着いてから問い合わせる。入力を変えた直後・失敗時は点数なしで、失敗したことも返す） |
| `features/admin/useAxisValueDistribution.ts` | 下書きのshapeの生値分布を取得。取得キーに折れ点を含めないため、折れ点のドラッグ中は通信しない。取り直している間は前の分布を出したまま読み込み中にする |
| `features/admin/useMaterialValueShares.ts` | 種類・はい/いいえの材料1件の、値ごとの道の延長の割合を取得（較正の画面）。画面を開いている間に取りに行くのは1回で、失敗したことも返す |
| `features/admin/AxisStudio/breakpointTools.ts` | 3つの入力から折れ点を作ること・いまの折れ点から3つの入力を戻すこと・ドラッグの刻み幅（DOM非依存の純粋関数、較正の画面が使う） |
| `features/admin/AxisStudio/MaterialCoveragePanel.tsx` | 「材料」タブ本体。材料ごとの欠損割合を「欠損時の扱い」でグループに分けた表（各グループ内は欠損割合降順）と集計対象外材料の理由一覧。グループの見出し・説明と母集団の名前はbackendの宣言（`domain/material_coverage_spec.py: MISSING_SEMANTICS_DISPLAY`・`domain/material_coverage_spec.py: POPULATION_LABELS`）が生成物`vocabulary.ts`で配る |
| `features/admin/AxisStudio/DerivedDataFreshnessPanel.tsx` | 「データ保守」タブ本体。ソースごとの鮮度（成功した最新の取込と作り直しに使った取込）と、派生テーブルごとの列の比較（作ったときの列と今の宣言の列。値の列ごとの値なしの件数は参考）を、それぞれ1行へまとめて表示。対象の表・列はbackendが宣言から導く（表の印を持つ表が派生データ）。作り直しが要るかもbackendが決め（`features/admin/AxisStudio/DerivedDataFreshnessPanel.tsx: needs_rebuild`）、画面は理由を問わずそれで数える |
| `features/admin/AxisStudio/DbStatusPanel.tsx` | 「データ保守」タブ・本番DBの状態。取込runの最終実行・テーブルの実数と容量・統計とVACUUMの鮮度・接続を1件1行で出す |
| `features/admin/AxisStudio/StatusRowList.tsx` | 上記2パネルが共有する点検の行の一覧（状態の丸・名前・規模、開くと項目と値）と、結果の一言（手当てが要れば目立たせる） |
| `features/admin/AxisStudio/ReportCard.tsx` | 集計のパネル（材料の欠損割合・派生データ鮮度台帳・本番DBの状態）が共有するカード。見出しとⓘ・「集計する」ボタン・集計中と失敗の表示・集計の時刻（日本時間）を持ち、中身の描画は各パネルが渡す。件数と時点の書式（`features/admin/AxisStudio/ReportCard.tsx: formatCount`・`features/admin/AxisStudio/ReportCard.tsx: formatMoment`）もここに置く |
| `features/admin/AxisStudio/TileCachePanel.tsx` | 「データ保守」タブの2枚目。サーバー側のタイルファイルキャッシュ（基礎地図・路面と点のタイルが共有）を全消去する操作パネル。全利用者へ影響するため入口はここだけに持つ |
| `features/admin/AxisStudio/TuningPanel.tsx` | 「較正値」タブ本体。走ってみて決める値をデプロイなしで編集する。**並べる項目はbackendが宣言から導く**ため画面側に一覧を持たず、効き方（`features/admin/AxisStudio/TuningPanel.tsx: effect`）ごとに見出しを分けて「変えたのに効かない」群がそれと分かるようにする。1件=1行で、説明と既定値・範囲は(i)の奥（他の管理パネルと同じ省スペースの作り）。入力は打っただけでは送らず「DBへ保存」でまとめて書き、既定と同じ値にして保存した行は上書きを消す（DBへ残るのは動かしたぶんだけ）。保存を待つ間に打ち直した値は、未保存として残す |
| `lib/axisMaterialsCatalog.ts` | 材料の一覧（`lib/axisMaterialsCatalog.ts: MATERIAL_CATALOG`。生成物`material-catalog.json`から作る）と、材料idを表示へ変える関数（`materialCatalogLabel`: 論理名 - 物理名） |
| `components/ui/icons/axisIconPalette.tsx` | 軸のアイコンの固定パレット（`icon_id`→アイコンコンポーネント） |

## AxisStudio.tsx（一覧）

```
listAxisDefinitions() ──→ definitions（全軸）
                              │
              ┌───────────────┴────────────────┐
              ▼                                ▼
      下書きタブ（is_published=false）   公開済みタブ（is_published=true）
```

- 下書きタブが既定表示。行は表示名と、id・分類・既定重み・使うものを出すだけで、操作のボタンを持たない。
- 一覧の行（`renderRow`）は各軸が使う材料id/軸idの両方を`labelForMaterialOrAxis`で
  人間向けラベルへ解決する。まずこの軸一覧内に該当する軸id（内部軸階層、他axis_idを
  材料として参照するケース）が無いか探し、あればその`label`を優先する。無ければ
  `axisMaterialsCatalog.ts: materialCatalogLabel`（材料の一覧`MATERIAL_CATALOG`を
  引く）へフォールバックし、それにも無ければ生のidをそのまま出す。
- `/admin`ページ自体が既にBasic認証（`frontend/src/proxy.ts`）で保護されているため、
  この画面はユーザー名/パスワード入力欄を持たない。管理APIは同一オリジンの口（`app/admin/api/[...path]`）
  経由で、ブラウザの認証キャッシュがそのまま使われる。backend宛の資格情報はサーバー側の口がサーバー環境変数から
  組み立てるため、ブラウザには一切露出しない。読み取りと「片方だけ設定された状態は未設定として扱う」判断は
  `lib/adminBasicAuth.ts`が1箇所で持ち、`proxy.ts`（画面の保護）と転送の口の双方が同じ結果を見る。
  **口はbackendの管理APIごとに作らない**——backendのパスの`/api/admin`を`/admin/api`へ読み替えるだけなので、
  管理APIを1つ足してもfrontendの口は増えない。

### 較正の画面（`AxisCalibration.tsx`）

数値の軸の線は「0点にする値・100点にする値・効き方」の3つだけで決める。
**密度の軸**（backendの`preview-calibration`が`averages_density`で返す）は、0のとき0点の直線に限られる（backendが
保存で断る）ため、100点にする値だけを出し、グラフで動かせるのも100点の端だけにする。折れ点を1つずつ動かす・足す口は
この画面に置かない——3つの入力で作れない線は、実データを見ても何を直せばよいか読めない。

- 保存済みの線が3つの入力で作れない形（折れ点を手で動かした線）なら、灰色の破線で重ね、保存すると作った線に
  置き換わることを注意の色で出す。効き方「一定」の2点の直線は、作った6点の直線と同じ線として扱う。
- 段の境界は、上書きがあればそれ、無ければbackendが下書きから導いた境界を出す。グラフに重ねるのは得点で塗る軸だけで、
  材料の値で塗る軸（符号付きの材料）は目盛りが違うので重ねず、そう断る。動かした境界は隣の境界の内側に収める（backendは
  昇順で重ならない境界だけを受け付ける）。入力欄を空にすると上書きを外す。
- 段ごとの延長は、分布の階級の代表値の点数（`preview-scores`）を地図と同じ段の判定（`lib/mapDisplay/valueScale.ts: bandAt`）で
  まとめ、下書きと保存済みを、それぞれの段で並べる（境界を変えると段の数も変わりうる）。
- 地図は大きく置き、見ている範囲の道を、下書きの線で求めた道の点数（`preview-way-values`。保存済みの線を渡せば配信と同じ値）と、
  画面で動かしている段の境界で塗る。道の線の塗り・段の色・凡例は一般の地図と同じもの（場面の組み立て）を通し、公開していない軸も
  塗れる。点数は、線か見ている範囲が落ち着いてから取り直し（タイルごとに1回）、取り直す間は前の点数で塗る。取得の鍵に段の境界を
  含めないので、境界だけを動かしたときは点数を取り直さずに色だけを塗り直す。向きで変わる軸は北へ走る向き、時刻で変わる軸は画面を
  開いた時刻、速さで変わる軸は既定の速さで求める。求められなければbackendの文を出す。
- 保存は`PUT`で、公開の状態を変えない（公開中の軸は、折れ点と表示の項目だけの差分を公開したまま保存できる）。
  断られたらbackendの文をそのまま出す。保存できたら一覧を取り直し、取り直した定義で下書きを作り直す。

**対応表の軸**は、対応表に載っている種類ごとに点数を数で直す（どの種類に点数を付けるかは軸の定義ファイルが決める）。
各行の割合は、抽選した道のうち材料の値を持つ道の延長に占める、その種類の道の延長（backendの`value-shares`）で、
対応表に無い値の道の割合も1行で出す。段の境界の入力と保存は数値の軸と同じ部品を使う。

- 段ごとの延長は、種類の点数を地図と同じ`bandAt`で段へ振り分け、**点数の付く道の延長**で割る（対応表に無い値の道は
  評価が欠損にし、地図に塗られない）。

**赤（誤りの色）は、保存・取得が失敗したときだけに使う。** 失敗ではない知らせ（例: 保存済みの線が3つの入力で作れない）は、
注意の色（`ui/Callout`の`warning`）で出す——赤で出すと、操作が通ったのに失敗したと読める。

### 分布と点数の取り方

分布の取得と点数の計算は役割を分ける。分布の口（`preview-distribution`）は**折れ点を通す前の生値**の
ヒストグラムを返す。DBから抽選して集計する重い問い合わせなので、取得のキー（`useAxisValueDistribution`の
`termsKey`）に折れ点を含めず、折れ点を動かしても取り直さない。各階級の代表値（中央、`binMidpoints`）の
点数は、DBを読まない軽い口（`preview-scores`）へ折れ点が落ち着くたびに問い合わせる（`useScoresPreview`）。
点数の計算は評価と同じ1か所（`domain/axis_definitions.py: BreakpointLinearShape.score_at`）で、画面は届いた点数を段へまとめる
（`scoreDistribution.ts: mapBandShares`）だけ——画面で計算し直すと、同じ折れ点に評価と画面で別の点数が付きうる。
点数がまだ届いていない・階級と数が合わない間は段ごとの延長を出さない（前の折れ点の点数を今の分布へ当てない）。

同じ分布を**曲線の背景へも重ねる**（`curveDistributionOverlay.ts`）。段ごとの延長は「結果がどう散らばるか」を答えるが、
「**曲線のどの部分が効いているか**」は答えない——値が集中する帯の外側で端を動かしても結果は変わらず、集中する
帯の中で動かすと大きく変わる。曲線の横軸は折れ点を通す前の生値で、backendが返す階級・分位と同じ量のため、そのまま重ねられる。
横軸の範囲は保存済みの線と実データの大半が入るように決めて固定し、端を動かしても目盛りが動かないようにする。

- 階級が表示範囲をまたぐときは**幅に比例して按分**する。丸ごと入れる／落とすと範囲の端で
  割合が跳ねる。
- 分位線は`p10`/`p50`/`p90`の3本に絞る（全分位を出すと線だらけになる）。
- **表示範囲の外にある延長は割合として画面に残す**。黙って切ると「分布は全部見えている」と
  読めてしまい、線が実データの範囲と合っていないこと自体——この重ね描きが一番伝えたい
  こと——が画面から消える。ごく僅か（`OFF_RANGE_NOTICE_THRESHOLD`未満）のときは出さない。

### 線を作る3つの入力（`breakpointTools.ts`）

- `generateBreakpoints(zeroValue, hundredValue, shape)`: 「0点にする値」「100点にする値」
  「形」（一定/後半で急/前半で急/S字）の3入力から6点の折れ点を生成する。
  `zeroValue > hundredValue`（値が大きいほど走りやすい軸）でも常にx昇順で返す。
- `generatorSettingsFrom(breakpoints)`: 上の逆。いまの折れ点から3入力を復元する。
  **3入力は使い捨ての入力欄ではない**——固定の初期値を持たせると、軸を開いたときに
  その軸と無関係な範囲が表示され、どれか1つに触れた瞬間に較正済みの端点が黙って消える。
  生成物と総当たりで突き合わせて一致すれば効き方まで復元し、手で動かした
  折れ点なら端点だけを点数の低い側/高い側から復元する。
- `niceStep`/`snapToStep`: ドラッグ中の横の刻み幅（表示範囲に対して「きりのいい」1/2/5×10^nを選ぶ）。
  矢印キーでも同じ刻みで動かし、Shiftを押すと10倍にする。

### 地図の段の境界のまとめ入力

境界値は1つの入力欄へまとめて書く（`thresholdList.ts: parseThresholdList`が区切りを問わず解釈する）。
**入力欄の文字列は境界の下書きとは別に持ち、読めたときだけ下書きへ反映する**——読めない途中の状態で下書きを
書き換えると直前の並びが消える。段の名前の上書きがある軸は、境界の数に合わせて段の名前を詰めて送る
（`thresholdList.ts: resizeBandLabels`。backendは段の名前の数が段の数と合わない上書きを断る）。

**入力した値は地図がそのまま段にする。** backendは上書きを塗る値の目盛り（得点。符号付き材料の軸はその材料の値）で
そのまま使う（[backend](../backend/axis-studio.md)「地図が塗るもの」）。

## MaterialCoveragePanel.tsx（「材料」タブ）

backend `GET /api/admin/material-catalog/coverage`の
レスポンス（`MaterialCoverageResponse`、生成型）をそのまま表にする。

- 「欠損時の扱い」（`missing_semantics`）でグループに分けて表示する。見出し・説明・並びは
  backendの宣言（`domain/material_coverage_spec.py: MISSING_SEMANTICS_DISPLAY`、生成物`vocabulary.ts`）。例:
  「評価に影響する欠損」（欠損区間ではその材料を使う軸が評価対象外）と「タグ不在を確定値として
  評価する材料（参考）」（欠損は「該当なし」を意味し評価に穴は開かない）。欠損割合の数字が同じでも
  意味が正反対のため同じ表へ並べない。各グループは`<section aria-label>`で、見出し＋1行の説明＋表。
  行は欠損割合の降順（`sortByMissingRatioDesc`）。宣言が「評価に効かない」とする扱いの行は
  `data-affects-evaluation`属性でバーの色を落とす（画面は扱いの値そのものを持たない）。
- 表の列は材料（論理名 - 物理名）・母集団（Way/Edge）・欠損割合の3列。欠損割合セルは
  数値＋バーの下に「欠損 / 総数」を小さく重ねる（材料名が2行に折り返す高さを使い、
  スマホ幅でも横スクロールなしで収める）。欠損の判定根拠（`source`）は材料セルの名前の下に小さく出す
  （`title`はスマホで出ない）。
- 母集団の定義・件数ベースであること・判定根拠の見方といった補足は、見出し脇の(i)
  （`components/ui/InfoPopover`）へ畳み、常時表示の説明文は各グループ1行だけにする。
- 集計対象外の材料（`kind: "excluded"`。件数を持たず理由だけを持つ）は表に含めず、`<details>`の折りたたみ一覧へ
  理由つきで出す。
- 集計のカードは`ReportCard`（下記「集計のカード」）。母数としてWay・Edgeの総数を集計の時刻の前に出す。

## 集計のカード（`ReportCard.tsx`）

材料の欠損割合・派生データ鮮度台帳・本番DBの状態は、どれもDB全体の走査を伴う集計なので、タブを開いたとき
自動では実行せず「集計する」ボタン押下時のみ実行する。その骨格（見出し・ⓘ・ボタン・集計中と失敗の表示・集計の
時刻）を`ReportCard`が1つで持ち、各パネルは取得の関数と中身の描画だけを渡す。認証情報の入力欄は持たない
（`/admin`のBasic認証セッションを転送の口経由で再利用する）。時点は日本時間で出す（`lib/time.ts`）。

**画面の説明はⓘ（`InfoPopover`）の奥に置き、ベタ書きしない**（design-principles.md
「冗長なものは削る」。読むのは1度きりなのに場所は常に取り続ける）。集計前はボタンだけを出す
——押すまで一覧は無いため、そこに無いものの説明を先に読ませない。

## DerivedDataFreshnessPanel.tsx（「データ保守」タブ）

backend `GET /api/admin/derived-data/freshness`の
レスポンス（`DerivedDataFreshnessResponse`、生成型）をそのまま一覧にする。
`MaterialCoveragePanel`（完成度、値がNULL/未取得か）とは別の切り口——派生を作った生データの取込が、
ソースごとに成功した最新の取込より古いままではないか、派生の表を作ったときの列が今の宣言の列と違わないか、
という鮮度を見る。

- 集計後の先頭に**作り直しが要る件数と、作り直しの手順の在り処**（`.claude/skills/production-data/SKILL.md`
  「派生データの作り直し」）を置く。**行ごとにバッチ名を散らさない**——古い理由がどれであっても利用者が
  打つのは同じ1コマンドのため。本番で打つ形（本番VMのパス・コンテナ名）は運用の知識なので画面に持たない。
- 一覧はソースの鮮度（取込の世代比較）と、表の列の比較を**同じ見た目の1行**へ揃え、「取込」と「派生の表」の
  2つのまとまりに並べる（`sourceRows`がソースごとの`sources`を、`tableRows`が表ごとの`tables`を
  `StatusRowList.tsx: StatusRow`へ写す）。読み手が知りたいのは「作り直しが要るか」で
  あり、判定方式の違いは開いた先に書けばよい。run番号・足した／消した列・判定の但し書きは
  `<details>`の中で、タップしたときだけ出す。列ごとの値なしの件数も開いた先に参考として出し、判定には
  使わない（作り直した後の値なしは作り直しでは埋まらない。[静的道路属性](../backend/static-road-attributes.md)「派生データ鮮度台帳」）。
- **表（`<table>`）を使わない。** 列を横に並べるとモバイルでは横スクロールの中へ数字が隠れ、
  「比較対象」の列だけが見える状態になる。ラベルと値を縦に積み、値だけが折り返す形にする。
- 対象の表と列はbackendがORMの宣言から導き（`infrastructure/derived_data_freshness.py:
  derived_tables`）、frontendは返ってきた行を並べるだけで対象を手書きしない。
- 描画は`FreshnessReportView`（レポートを受け取る）として取得と分けてある。認証の要る画面を
  通さずに見え方を確かめられるようにするため。

## DbStatusPanel.tsx（「データ保守」タブ・本番DBの状態）

`GET /api/admin/db-status`を呼び、取込runの最終実行・テーブルの実数と容量・統計とVACUUMの
鮮度・接続の状態を出す。`DerivedDataFreshnessPanel`と同じ形（集計のカード`ReportCard`、1件1行の
`StatusRowList`、数字は開いた先）にする。

- 判定の種類（取込・接続・テーブル）が違っても行の見た目は揃える。読み手が知りたいのは
  「注意が要るか」で同じだから。**揃えたぶん、何と何が並んでいるのかは群の見出しが引き受ける**
  （`groupsFromStatus`が群を組み立てる）。並び順に根拠がある群は、その根拠も見出しへ書く。
- **ヘッダーへ母数**（テーブルの数・行数の合計・DB全体の容量）を出す。畳んだ行の「Nテーブル」
  が何分のNなのかは、全体の数が同じ画面に無いと読めない。
- **テーブルは注意のあるものだけを行にし、残りは1行へ畳む**（本番では20件超あり、全部並べると
  注意すべき行が埋もれる）。畳んだ側も開けば一覧が見える。**畳んだ行は分けた基準（注意の
  有無）を自分で名乗る**——「その他」では、隠れた側が重要でないのか見るべきものが埋もれて
  いるのかが読めない。
- 描画は`StatusRows`として取得と分けてある（認証の要る画面を通さず見え方を確かめるため）。

## TileCachePanel.tsx（「データ保守」タブの2枚目）

backend `POST /api/admin/basemap/refresh`を呼び、
サーバーが持つタイルのファイルキャッシュ（`tile_cache`。基礎地図のプロキシ結果と
路面・事故・POIのベクタタイルが同じ場所を共有する）を全消去する。
`DerivedDataFreshnessPanel`が「古いかどうかを見る」のに対し、こちらは「古いものを捨てる」
操作側のため同じタブに並べる。

影響は押した人だけでなく**全利用者**に及ぶ（次のタイル要求で作り直されるまで、外部
サービスへの実問い合わせやタイル生成が走る）。この操作が管理API認可境界の内側にしか
入口を持たないことが、`/`側の「地図の表示を再描画」ボタン（押した人の地図インスタンス
だけを組み直す純粋なクライアント操作）と分かれている理由。押しても管理者自身の画面は
変わらない（この画面は地図を持たない）ため、消したこと自体と、各利用者へ反映されるのが
既存タイルの`Cache-Control`が切れた後であることを結果表示で伝える（基礎地図の時間は生成物`refresh-intervals.json`の
`basemap_browser_cache_seconds`。backendの`api/cache_policy.py: BASEMAP`から出る）。

## axisIconPalette.tsx（軸のアイコン）

`icon_id`（`AxisDefinition.icon_id`、軸自身のデータ）→アイコンコンポーネントのフラットな
辞書（`AXIS_ICON_PALETTE`）。未知/未設定の`icon_id`は`AxisRampIcon`（汎用フォールバック）
に倒れるため、パレットに無い値でも動作は壊れない。新しいアイコン形状の追加はこのファイルへの
1件追加＋コード変更を要する（GUIからの任意SVG登録は、スタイル一貫性・XSSサニタイズの
コストが高いため見送り済みの設計判断）。

## backend側との対応

frontendのこの画面は、backendの[軸スタジオ・評価軸定義（backend）](../backend/axis-studio.md)が
定義する`AxisDefinitionPayload`のバリデーション規則（display_thresholds_overrideの
昇順・shape.breakpointsのx昇順・材料/軸参照の既知性等）を写さない。backendは検証の文を利用者が読める
日本語で返し（`axis_definitions.py: axis_error`。`ValueError`だと「Value error, 」の前置きが付く）、
画面は保存の誤りとしてそのまま出す。写すと、backendの条件を変えたとき画面だけが古い条件で止める。
