# 開発者機能（frontend）

## 責務

`/admin`（`app/admin/page.tsx`、Basic認証保護下。画面の題は「管理・開発者ツール」）にある管理の画面（材料・較正値・データ保守）と
開発者向け補助機能（ログ表示・システム状況）、その認証の境界と、一般公開ページ`page.tsx`（`/`、認証なし）のヘッダーメニューから直接操作
できる機能（デバッグログ表示）。

**対象ファイル**

| ファイル | 責務 | マウント先 |
|---|---|---|
| `app/admin/page.tsx` | `/admin`のタブ構成を束ねるコンポジションルート（開いたときは「材料」のタブ） | 独立URL |
| `proxy.ts`・`lib/adminBasicAuth.ts` | `/admin`のページと管理APIの転送の口（`/admin/api/**`）への到達をHTTP Basic認証で止めるNext.jsのルーティング境界（ファイル名はフレームワークの規約）と、その資格情報を環境変数から読む口（`lib/adminBasicAuth.ts: adminBasicAuthCredentials`。片方でも空なら認証を通さない）。転送先のbackendの管理APIは別にbackendが同じ方式で守る | `/admin`の手前 |
| `features/admin/adminApi.ts` | `/admin`の各パネルが叩く口の薄いラッパー（例: 材料の欠損割合・較正値の書き換え・直近のログ・死活）。管理APIは`lib/apiClient.ts: adminApiClient`、認証の要らない稼働状況の口は`lib/apiClient.ts: backendApi`を通る | `/admin`の各パネル |
| `features/admin/AdminPanels/MaterialCoveragePanel.tsx` | 材料ごとの欠損割合（backend `GET /api/admin/material-catalog/coverage`）を欠損の扱いごとに分けて欠損の高い順に並べる。欠損を取込側で推測して埋めず、実態を見せて「埋めるか」の判断を定義の側へ委ねる。母集団の名前と欠損の扱いの見出しは材料カタログの宣言が配り、宣言に無い扱いの材料は未分類の群が拾う | `/admin`「材料」タブ |
| `features/admin/AdminPanels/TuningPanel.tsx` | 走ってみて決める較正値（backendの`domain/tuning.py`の宣言）をデプロイなしに変える画面。並べる項目はbackendが宣言から導き、効き方ごとにまとめる（変えたのに効かない群を見分ける）。入力は「DBへ保存」でまとめて送る（値の正本はDBで、画面に既定は無い） | `/admin`「較正値」タブ |
| `features/admin/AdminPanels/DbStatusPanel.tsx` | 本番DBの土台（取込のrunの失敗・行の有無・プランナの統計・放置されたトランザクション）を、ほかのパネルと同じ1行の形で見せる | `/admin`「データ保守」タブ |
| `features/admin/AdminPanels/ReportCard.tsx`・`features/admin/AdminPanels/StatusRowList.tsx` | 「材料」「データ保守」の集計のカード（DB全体の走査を伴うので、開いたときには取らず「集計する」を押したときだけ取る。説明はⓘの奥）と、点検の行の一覧（名前の右に規模、開くと中身。手当ての要否を丸の色と読み上げの文の両方で持つ）。件数・時点の書き方（`features/admin/AdminPanels/ReportCard.tsx: formatCount`・`features/admin/AdminPanels/ReportCard.tsx: formatMoment`）も持つ | 上記のパネル |
| `components/HeaderMenu/HeaderMenu.tsx` | 頭のアプリの名前と版・使い方の説明の入口（「使い方を見る」。[ページ全体構成](page-composition.md)「使い方の説明」）・初回の案内を出し直す入口（[ページ全体構成](page-composition.md)「初回の案内」）・走行ログのページ（下記「走りの記録」）へのリンク・走行の記録のコピー（下記「走行の計測」。記録があるときだけ）・デバッグログ表示と、区切りの下の地図を描き直す（[地図: 静的レイヤー](static-map-layers.md)「まとめて戻す操作」）を1個のメニューアイコンへ集約したRadix Popover。頭の版は動いている版（コミットの頭8文字）で、確かめ待ちの変更が本番に出たかを利用者が画面から見分けられるようにする | `app/HomeHeader.tsx`（`/`のヘッダー） |
| `features/admin/DebugPanel/DebugPanel.tsx` | デバッグログ表示のON/OFFトグル | `/admin`「開発者」タブ |
| `components/DebugConsole/DebugConsole.tsx` | 地図イベント・外部API呼び出しの詳細ログを時系列表示するフローティングパネル。**表示中の行をそのままの形でコピーできる**（絞り込みを無視して全件にすると、絞って見つけた数行を渡したいときに関係ない行まで混ざる） | `app/HomeHeader.tsx`（`/`のヘッダーの下）、`HeaderMenu.tsx: HeaderMenu`から開閉 |
| `features/admin/SystemStatusPanel/SystemStatusPanel.tsx` | backend `/api/debug/stats`の集計・フロントバージョン・予報（MSM）の同期鮮度を表示するフローティングパネル | `/admin`「開発者」タブ |
| `features/admin/BackendStatus/BackendStatus.tsx` | バックエンドの死活確認の簡易表示 | `/admin`「開発者」タブ |
| `features/admin/BackendLogsPanel/BackendLogsPanel.tsx` | backend `GET /api/admin/debug/logs`の直近ログをレベル（DEBUG〜CRITICAL）・部分一致で絞り込んで表示するパネル。取得は「取得」ボタン押下時のみ（ポーリングなし） | `/admin`「開発者」タブ |
| `components/FloatingPanel/FloatingPanel.tsx` | `DebugConsole`/`SystemStatusPanel`が共有するドラッグ可能な浮動パネルの共通シェル（`react-rnd`ベース）。画面の大きさが変わったら（端末の回転等）画面の中へ寄せ直す。使い方の説明の案内（[ページ全体構成](page-composition.md)「使い方の説明」）も使う | 両パネルと使い方の説明の案内の実装基盤 |
| `hooks/useCopyToClipboard.ts` | クリップボードへの書き込みと結果表示（コピー済み・失敗）。Clipboard APIは[SecureContext]のため、httpのIPアクセス等では`navigator.clipboard`自体がundefinedになる——`.catch()`はPromiseの拒否しか捕まえず、プロパティアクセスの同期TypeErrorをtryで受けないとボタンが無反応のままになる。失敗は握り潰さず文言を返す | `DebugConsole`・`BackendLogsPanel` |
| `hooks/useDebugLog.ts`・`lib/debugLog.ts` | デバッグモードON/OFF状態・ログエントリのシングルストア（`useSyncExternalStore`） | |
| `lib/rideMetrics.ts` | 走行の計測: 走行モードの間、1分ごとの数をまとめた行を端末に残す（下記「走行の計測」） | 位置（`features/ride/rideRecording.ts`）・向き（`features/ride/useDeviceHeading.ts`）・地図（`features/map/MapView/useMapLifecycle.ts`）・ページ（`app/page.tsx`）が数える口を呼び、`HeaderMenu`の「走行の記録をコピー」で写す |
| `lib/rideMetricsObserve.ts` | 走行の計測のうち、標準の観測の口（通信・Long Tasks・Long Animation Frames・電池）を張って数えることと、地図が描き続けた理由の読み | `lib/rideMetrics.ts`が記録の間だけ張る |
| `lib/rideMetricsFormat.ts` | 走行の計測の記録を、写す形（1分1行の CSV。下記「走行の計測」）にする | `HeaderMenu`の「走行の記録をコピー」 |
| `lib/rideTrack.ts` | 走りの記録: 走行モードの間の位置と出来事・推したルート・生成の条件・見せた予報を走りごとに溜める（下記「走りの記録」） | 位置・出来事（`features/ride/rideRecording.ts`）・候補と条件と読み込み直し（`app/useRideGuidance.ts`）・予報（`features/conditions/useWeatherConditions.ts`）が記録の口を呼ぶ |
| `lib/rideTrackStore.ts` | 走りの記録の端末の置き場: 走りを一覧・見出し・変わったときだけ書くもの・点の区切りの鍵に分けて読み書きし、書けなければ古い走りを消して書き直し、走り終えたものを送る形で組み立てる | `lib/rideTrack.ts`が書き、`services/rideTrackApi.ts`が送るものを読んで送れたものを消し、`features/account/AccountGate/AccountGate.tsx`が同意する前に記録した走りを消し、`app/error.tsx`が鍵の頭で残す |
| `services/rideTrackApi.ts` | 走り終えて送っていない走りを、ログインの札（cookie）を付けて`POST /api/rides`へ古い順に送り、書けたものを端末で消し、全部を書けたかを返す。本文は本番の nginx の要求の大きさの上限（既定の 1MB）に長い走りも収めるため、gzip で縮めて送る | 案内を終えたとき（`features/ride/useRideKeep.ts`） |
| `services/accountApi.ts` | 自分の状態（ログイン・同意・ログインのボタンに使うクライアント ID）を読む・Google の ID トークンでログインする・ログアウトする・規約の版に同意する・同意をやめる口と、自分の走りの一覧・1件（走った線つき）を読む・1件を消す口。どれもログインの札（cookie）を付けて送る | `hooks/useAccountStatus.ts`・`features/account/AccountGate/AccountGate.tsx`・`features/ride/RideLog/RideLog.tsx` |
| `hooks/useAccountStatus.ts` | 自分の状態の取得と Google でのログインを、画面の取得のキャッシュの1つの鍵（`hooks/useAccountStatus.ts: ACCOUNT_KEY`）で持つ。ログインの応答をそのまま今の状態として置く | `features/account/AccountGate/AccountGate.tsx`・`features/ride/RideLog/RideLog.tsx` |
| `features/account/AccountGate/AccountGate.tsx` | 地図の画面の門: ログインして今の規約の版に同意するまで、地図の画面の上に最初の画面（アプリの説明・Google でログイン・規約へのリンク）を重ね、後ろの地図を触れなくし、地図には済んだかを渡す。ログインが同意を兼ね、同意のカードはログインのあとに規約の版が上がった人にだけ出す。同意を見せている間に版が上がっていた（409）なら今の版を読み直す（下記「走りの記録」） | `app/page.tsx`が地図の画面を包む |
| `features/ride/useRideKeep.ts` | 案内を終えた走りを、聞かずに送る（送っていない走りがあるときだけ）。送っている・送れた・送れなかったを結果のカードへ渡す（下記「走りの記録」） | 案内を終えたとき（`useRideMode.ts`の終えたときの知らせを`app/page.tsx`が渡す） |
| `features/ride/RideKeepCard/RideKeepCard.tsx` | 送った結果の地図の上のカード（残している・残した〔走行ログを「見る」〕・残せなかった） | `app/HomeMapPane.tsx`が、走行モードでない間に初回の案内と同じ所へ出す |
| `components/GoogleSignInButton/GoogleSignInButton.tsx` | Google Identity Services の公式のログインのボタン（スクリプトを1回だけ読み、初期化を1回だけ呼ぶ） | 最初の画面（`features/account/AccountGate/AccountGate.tsx`）と走行ログ（`features/ride/RideLog/RideLog.tsx`） |
| `app/ride-log/page.tsx`・`app/ride-log/RideLogWithMap.tsx`・`features/ride/RideLog/RideLog.tsx` | 走行ログのページ（下記「走りの記録」）: ログインした人の走りの一覧（始めた日時・距離・かかった時間）と、押した1件の走った線の地図と消す操作、記録をやめる・ログアウト。ログインしていなければ Google のログインのボタンを出す（地図の画面を通らずに直に開いたとき）。地図は機能をまたぐので、ページが走行ログの部品へ地図を描く関数を渡す | ヘッダーのメニュー（`components/HeaderMenu/HeaderMenu.tsx`）の「走行ログ」と、残したときのカードの「見る」が開く |
| `features/map/RideTrackMap/RideTrackMap.tsx`・`features/map/scene/groups/rideTrack.ts` | 走行ログで1件の走った線を描く地図（線の範囲へ寄せる）と、その場面の群（休むごとに分かれた線を、つながずに予定の線と違う色で描く） | `app/ride-log/RideLogWithMap.tsx` |
| `app/terms/page.tsx`・`app/privacy/page.tsx`・`components/LegalPage/LegalPage.tsx` | 利用規約とプライバシーポリシーのページと、その骨組み・運営者と問い合わせの節 | ログインしなくても開ける。最初の画面・同意のカードと規約のページどうしがリンクする |
| `components/AppPage/AppPage.tsx` | 地図の画面の外に開くページ（規約のページ・走行ログ）の骨組み: トップへ戻るリンクと見出し | `components/LegalPage/LegalPage.tsx`・`app/ride-log/page.tsx` |
| `app/api/version/route.ts`・`services/versionApi.ts` | フロントエンドの動いている版（コミット・起動時刻）を返すNext.js route handlerと、それを読む口（`SystemStatusPanel`と`HeaderMenu`の頭の版が読む） | |

## 開発の道具（`frontend/scripts/`）

画面に載らず、ビルド・検査・撮影・開発機で打つ道具。パスは`frontend/`から。

| ファイル | 責務 |
|---|---|
| `scripts/copy-maplibre-worker.mjs` | maplibre-glのWorkerを静的配信できる場所へ複製する（[静的レイヤー](static-map-layers.md)の`features/map/maplibreWorker.ts`の行）。複製物はリポジトリへ置かない |
| `scripts/prepare-standalone.mjs` | standalone構成のビルド成果物へ`.next/static`と`public`を写し、手元・CIのE2Eで本番と同じ入口を起こせるようにする |
| `scripts/image.mjs` | 本番のfrontendの像を作る（CIと、frontendのデプロイの手動の起動が呼ぶ）。像へ渡す環境変数の組は撮影の道具も同じものを使う |
| `scripts/capture.mjs`・`scripts/capture/` | 画面を、選んだ版と応答で開き、脚本で進めた状態を撮る（[デザイン基盤](frontend-design-system.md)「7. 実機確認の方法」） |
| `capture/` | 撮影の段（Playwright）の足場。`scripts/capture.mjs`が渡した脚本を流して撮る段と、脚本へ渡す道具（画面の操作・キーボードを重ねた画像・作業ツリーの backend への振り向け・画像の名前）と、脚本の例（`capture/examples/`）を持つ |
| `capture/ride-simulation.ts` | 模擬走行の脚本（`scripts/capture.mjs --script`で流す）。ルートを作って走行モードを始め、選んだルートの線に沿って毎秒1点ずつ位置と、Android の Chrome と同じ向きの出来事を届け、走行の記録（下記「走行の計測」）とページの CPU の時間を出力へ書く。直す前と後を同じ条件で比べるためのもので、地図を GPU を使わずに描くので時間の絶対値はスマホと合わない（回数で比べる）。打ち方は脚本の先頭 |
| `scripts/dev-prod-data.mjs` | 開発機の画面を本番のbackendのデータで開く開発サーバーを起こす（[setup.md](../../architecture/setup.md)「開発機の画面を本番のデータで開く」）。取り次ぎの向け先とAPIの宛先は`next.config.ts`が切り替えから決める |
| `scripts/structure-population.mjs`・`scripts/structure-population/` | 画面がbackendの宣言を持ち直している形の候補を構文木から列挙する（周期レビューの「構造の問い」のfrontendの母集団）。候補を出すだけで判じない。語彙（生成物の値・現象の語・軸名）の読み取りと、字句の置かれた文脈の判定は`scripts/structure-population/`の下に分けて持つ |
| `scripts/mutation/` | 変異テスト（Stryker）の設定と、書き換えるファイルを本に分ける・結果を比べる・報告する台本 |
| `src/structure/`（`*.test.ts`を除く） | 構造の検査（同じ場所の`*.test.ts`）が読む道具: 検査の母集団の根と木の歩き方（`src/structure/sourceTree.ts`）・テストの構文の読み取り・足場の境界と写しの判定・母集団が空のときに何も確かめずに通るループの判定等。画面には載らない |

## `/admin`とpage.tsx（`/`）の境界

```
app/admin/page.tsx（独立URL、Basic認証保護下）
  ├─ タブ「材料」（既定）: MaterialCoveragePanel（材料ごとの欠損割合）
  ├─ タブ「較正値」　　: TuningPanel（走ってみて決める値の編集）
  ├─ タブ「データ保守」: DbStatusPanel（本番DBの状態）
  │                     （タイルファイルキャッシュの全消去）
  └─ タブ「開発者」　　: DebugPanel + BackendStatus + SystemStatusPanel + BackendLogsPanel

app/page.tsx（メインページ、地図を持つ、認証なし）
  └─ header: HeaderMenu（頭のアプリの名前と版・使い方を見る・初回の案内・デバッグログ表示・地図を描き直す）
       └─ DebugConsole（debugEnabled時のみHeaderMenuに項目表示、開閉はheader直下で管理）
```

`DebugConsole`（デバッグログの表示自体）は`/`に残る——地図インスタンスに紐づく情報の
ため、地図を持たない`/admin`へ移すと記録先（`lib/debugLog.ts`のシングルトン）がタブ間で
共有されず実質機能しない。デバッグモードのON/OFF自体は`/admin`の`DebugPanel`で切り替え、
localStorage経由で`/`側へ共有される（`HeaderMenu`はデバッグログ**表示**ボタンのみを持ち、
デバッグモード自体のON/OFFは持たない）。

## デバッグモードとログ表示・パネル開閉の3段階

1. **デバッグモードのON/OFF**（`useDebugEnabled`/`setDebugEnabled`、localStorage
   `ridecompass:debug-enabled`）: ログの**記録自体**の有効/無効。`/admin`の
   `DebugPanel`で切り替える。
2. **記録**（`debugLog(category, message, detail, level)`、`lib/debugLog.ts`）:
   デバッグモードON中、`services/`配下のfetchラッパー・地図のイベント
   ハンドラ（`features/map/MapView/useMapLifecycle.ts`）から直接呼ばれるフレームワーク非依存のシングルトン（最大300件、
   `console.debug`/`warn`/`error`にも同時出力）。
3. **パネルの開閉**（`app/HomeHeader.tsx: debugConsoleOpen`）: `DebugConsole`自体の表示/非表示。
   デバッグモードONでも常時パネルを占有させない、記録の有効/無効とは独立したstate。

## 走行の計測

実走中は開発機の DevTools をつなげない（Android の Chrome は USB でつなぐ）ので、電池の減りの原因を切り分ける数を、走っている端末の中に残す。
開発者向けの機能ではなく、デバッグモードに依らない（一般の画面に開発者向けの切り替えを置かない）。走行モードを始めると記録を始め、止めると途中の1分も行にして止める。
休んでいる間も記録を続け、行に走行の状態を残す。残すのは数だけで、位置の座標は残さず、どこへも送らない。走り終えてから、ヘッダーのメニューの「走行の記録をコピー」で写す。写す形は1分1行の CSV（1行目に始まりと端末、2行目に列の名前）で、
項目の名前を行ごとに繰り返さず、長い走行でもチャットへ貼れる長さに収める（端末に残す形は JSON のまま）。
端末には直近の1回の走行だけを残し（`localStorage`の`ridecompass:ride-metrics`。行の上限は`lib/rideMetrics.ts: MAX_ROWS`）、次の走行を始めると前の記録を消す。
走っていない間は、数える口が最初の比べだけで戻る。

1分の行に残すもの: 電池の残量と充電中か・位置の数と誤差・届く間隔・速さ・向きの出来事の数と向きの変わった数・地図の描き直しと動きとタイルの読み込みの数・描いたコマを次のコマも描く理由ごとに数えた数（MapLibre が描き続ける判定の非公開の値を写す。
移り変わり中のタイルの溶け込みはソースの id を添える。どれにも当たらないコマは `end`）・
1分の終わりの倍率と層の数・ページの描き直しの数・通信の行き先ごとの数と転送の量・50ms 以上かかった処理（Long Tasks）・描き遅れたコマ（Long Animation Frames）と
その中で時間を使ったスクリプトの上位・JavaScript のメモリ・画面が隠れていた秒数。電池（`navigator.getBattery`）・メモリ（`performance.memory`）・Long Animation Frames は
Chrome にだけある口で、無い端末ではその項目を null・0 のまま残す。転送の量は、キャッシュから読んだ分と、量を明かさない別のオリジンの応答を0に数える。

## 走りの記録

推したルートと実走を開発機の較正の道具で照らすための記録で、利用者が走行ログで見返す走りにもなる。走行の計測（座標を残さない）と違って座標を残す。
走行モードを使ったどの端末でも端末の中には記録し、送るのは、Google でログインして今の規約の版に同意した人のものだけにする
（受ける口も、同意していない人の書き込みを断る）。走行モードを始めると走りを1つ始め、休んで続けても・読み込み直して戻しても
同じ走りを続け、案内を終えると終える。残すのは端末が出したまま・アプリが受けたままの値と出来事で、止まり・外れ等の解釈はしない。

| 残すもの | 中身 |
|---|---|
| 点 | 走り始めからの時刻・緯度経度・標高・位置と標高の誤差・端末の速さ・進む向き（送る形の整数のまま） |
| 出来事 | 始めた・休んだ・続けた・読み込み直した・候補を替えた（替えた先）・終えた |
| 推したルート | 走行中に出た候補を受けたまま（推したときの見込み・道路網の世代を含む）。候補の id は1回の生成の中でしか見分けられないので、道の並びで見分けて記録の中の鍵を振る |
| 生成の条件 | 候補を作った生成で backend が返した、実際に使った条件。生成した候補だけ（乗り換えで作った・読み込み直して戻した候補には無い） |
| 見せた予報 | 今の位置の1時間ごとの予報と、ルート沿いの注意報級の見込みを、受けた時刻と受けたままの中身で。始めたときに見せていたものと、走る間に中身が変わったもの |

- 位置が届くたびに走り全体を書き直すと、点の数に比例して重くなるので、点は区切りごとの鍵へ足す（区切りの点の数・1回の走りの点の上限・
  溜める走りの数は`lib/rideTrack.ts`の定数）。書けなかったら（容量の上限等）、送っていない古い走りを古い順に消して書き直し、消せる走りが
  無いのに書けなければ、案内を止めずにその走りの記録だけをやめる。
- アプリを使うこと＝走りを送る同意で、地図の画面はログインして今の規約の版に同意した人にだけ使える。ほかの人には地図の画面の上に最初の画面を
  重ね（後ろの地図は触れず、現在地も取りに行かず、初回の案内も出さない）、Google でのログインで同意も残して地図を使えるようにする（ログインの
  ボタンに使うクライアント ID は、backend が Google のトークンを確かめるのと同じ値を自分の状態が配る。最初の画面は、ログインが同意になる
  ことをボタンの前に書く）。ログインせずに使うボタンや、同意せずに使うボタンは置かない。ログインのあとに規約の版が上がった人には、同意のカードで聞き直す。止めるのは画面だけで、backend の口はログインを求めない（走りを受ける口だけが、もとからログインして同意した人の走りに限って受ける）。
  最初の画面は読み込み中もアプリの説明とプライバシーポリシーへのリンクを出す（ログインしなくても見えるホームページに置く、Google のブランドの確認の条件）。
  同意したとき、同意する前に記録して端末に置いたままの走りは送らずに消す。
- 案内を終えると聞かずに送り、地図の上のカードに「走行ログに残しました」と走行ログを開く「見る」を出す。
- 送るのは案内を終えたときで、溜まっている走りを古い順に全部送る。送れなかった走りは（どの断りでも）端末に残し、後ろの走りは
  続けて送り、次に案内を終えたときに一緒に送る（断りの理由で消すと、frontend と backend の版がずれる間の断りで、あとなら受けられた走りも
  失う）。送るまで消さないので、溜まりきったら一番古い走りを捨てて新しい走りを記録する。終える前に閉じた走りは、次に（読み込み直しの戻しでなく）始めたときに
  終えたものにして、次に案内を終えたときに送る。
- 位置ごとに書き直す走りの見出しは小さく保ち、ルートの線・生成の条件・予報は別の鍵に、変わったときだけ書く。
- 画面のエラーの境目の「端末に保存した値を消して再試行」は、走りの記録（鍵の頭`lib/rideTrackStore.ts: RIDE_TRACK_KEY_PREFIX`）を消さない。
  記録の読みは、読めない値を無いものとして扱って画面を落とさず、送るまでほかに写しが無いため。
- 残した走りは、ヘッダーのメニューの「走行ログ」から開く走行ログのページで見返し、1件ずつ消せる（消すと戻せないので、確かめてから消す）。
  同意をやめる（記録をやめる）のもこのページで、やめても残した走りは消えず、地図の画面を開くと最初の画面に戻って同意を聞き直す。
- 受けた走りは backend が GPX にして表に残す（[横断的なインフラ](../backend/cross-cutting-infrastructure.md)の`ride_tracks`の行）。

## 暗黙の前提

- `SystemStatusPanel`・`DebugConsole`はポーリングをせず、開いたとき（`open`が`true`に
  なった瞬間）と明示的な「更新」ボタン押下時にのみ`fetchAll`/エントリ取得を行う
  （プロセス内カウンタ・モジュール評価時刻のスナップショットという性質のため）。
