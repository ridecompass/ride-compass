# 開発者機能（frontend）

## 責務

`/admin`（`app/admin/page.tsx`、Basic認証保護下）にある開発者向け補助機能（ログ表示・
システム状況）と、一般公開ページ`page.tsx`（`/`、認証なし）のヘッダーメニューから直接操作
できる機能（デバッグログ表示）。

**対象ファイル**

| ファイル | 責務 | マウント先 |
|---|---|---|
| `app/admin/page.tsx` | `/admin`のタブ構成を束ねるコンポジションルート（開いたときは軸スタジオのタブ） | 独立URL |
| `components/HeaderMenu/HeaderMenu.tsx` | 使い方の説明の入口（「使い方を見る」。[ページ全体構成](page-composition.md)「使い方の説明」）・地図の表示を再描画（[地図: 静的レイヤー](static-map-layers.md)「まとめて戻す操作」）・デバッグログ表示・バージョン表示を1個のメニューアイコンへ集約したRadix Popover。バージョン表示は、動いている版（コミットの頭8文字）を窓に出し、確かめ待ちの変更が本番に出たかを利用者が画面から見分けられるようにする | `app/HomeHeader.tsx`（`/`のヘッダー） |
| `features/admin/DebugPanel/DebugPanel.tsx` | デバッグログ表示のON/OFFトグル | `/admin`「開発者」タブ |
| `components/DebugConsole/DebugConsole.tsx` | 地図イベント・外部API呼び出しの詳細ログを時系列表示するフローティングパネル。**表示中の行をそのままの形でコピーできる**（絞り込みを無視して全件にすると、絞って見つけた数行を渡したいときに関係ない行まで混ざる） | `app/HomeHeader.tsx`（`/`のヘッダーの下）、`HeaderMenu.tsx: HeaderMenu`から開閉 |
| `features/admin/SystemStatusPanel/SystemStatusPanel.tsx` | backend `/api/debug/stats`の集計・フロントバージョン・予報（MSM）の同期鮮度を表示するフローティングパネル | `/admin`「開発者」タブ |
| `features/admin/BackendStatus/BackendStatus.tsx` | バックエンドの死活確認の簡易表示 | `/admin`「開発者」タブ |
| `features/admin/BackendLogsPanel/BackendLogsPanel.tsx` | backend `GET /api/admin/debug/logs`の直近ログをレベル（DEBUG〜CRITICAL）・部分一致で絞り込んで表示するパネル。取得は「取得」ボタン押下時のみ（ポーリングなし） | `/admin`「開発者」タブ |
| `components/FloatingPanel/FloatingPanel.tsx` | `DebugConsole`/`SystemStatusPanel`が共有するドラッグ可能な浮動パネルの共通シェル（`react-rnd`ベース）。画面の大きさが変わったら（端末の回転等）画面の中へ寄せ直す。使い方の説明の案内（[ページ全体構成](page-composition.md)「使い方の説明」）も使う | 両パネルと使い方の説明の案内の実装基盤 |
| `hooks/useCopyToClipboard.ts` | クリップボードへの書き込みと結果表示（コピー済み・失敗）。Clipboard APIは[SecureContext]のため、httpのIPアクセス等では`navigator.clipboard`自体がundefinedになる——`.catch()`はPromiseの拒否しか捕まえず、プロパティアクセスの同期TypeErrorをtryで受けないとボタンが無反応のままになる。失敗は握り潰さず文言を返す | `DebugConsole`・`BackendLogsPanel` |
| `hooks/useDebugLog.ts`・`lib/debugLog.ts` | デバッグモードON/OFF状態・ログエントリのシングルストア（`useSyncExternalStore`） | |
| `lib/rideMetrics.ts` | 走行の計測: デバッグモードの間に走行モードを始めると、1分ごとの数をまとめた行を端末に残す（下記「走行の計測」） | 位置（`features/ride/useRideMode.ts`）・向き（`features/ride/useDeviceHeading.ts`）・地図（`features/map/MapView/useMapLifecycle.ts`）・ページ（`app/page.tsx`）が数える口を呼び、`DebugConsole`の「走行」で写す |
| `app/api/version/route.ts`・`services/versionApi.ts` | フロントエンドの動いている版（コミット・起動時刻）を返すNext.js route handlerと、それを読む口（`SystemStatusPanel`と`HeaderMenu`のバージョン表示が読む） | |

## 開発の道具（`frontend/scripts/`）

画面に載らず、ビルド・検査・撮影・開発機で打つ道具。パスは`frontend/`から。

| ファイル | 責務 |
|---|---|
| `scripts/copy-maplibre-worker.mjs` | maplibre-glのWorkerを静的配信できる場所へ複製する（[静的レイヤー](static-map-layers.md)の`features/map/maplibreWorker.ts`の行）。複製物はリポジトリへ置かない |
| `scripts/prepare-standalone.mjs` | standalone構成のビルド成果物へ`.next/static`と`public`を写し、手元・CIのE2Eで本番と同じ入口を起こせるようにする |
| `scripts/image.mjs` | 本番のfrontendの像を作る（CIと、frontendのデプロイの手動の起動が呼ぶ）。像へ渡す環境変数の組は撮影の道具も同じものを使う |
| `scripts/capture.mjs`・`scripts/capture/` | 画面を、選んだ版と応答で開き、脚本で進めた状態を撮る（[デザイン基盤](frontend-design-system.md)「7. 実機確認の方法」） |
| `scripts/dev-prod-data.mjs` | 開発機の画面を本番のbackendのデータで開く開発サーバーを起こす（[setup.md](../../architecture/setup.md)「開発機の画面を本番のデータで開く」）。取り次ぎの向け先とAPIの宛先は`next.config.ts`が切り替えから決める |
| `scripts/audit-test-rewrite.mjs` | 実装から起こし直したテストを外から測る（`.claude/rules/testing-rewrite.md`の手順） |
| `scripts/structure-population.mjs`・`scripts/structure-population/` | 画面がbackendの宣言を持ち直している形の候補を構文木から列挙する（周期レビューの「構造の問い」のfrontendの母集団）。候補を出すだけで判じない。語彙（生成物の値・現象の語・軸名）の読み取りと、字句の置かれた文脈の判定は`scripts/structure-population/`の下に分けて持つ |
| `scripts/mutation/` | 変異テスト（Stryker）の設定と、書き換えるファイルを本に分ける・結果を比べる・報告する台本 |

## `/admin`とpage.tsx（`/`）の境界

```
app/admin/page.tsx（独立URL、Basic認証保護下）
  ├─ タブ「軸スタジオ」: AxisStudio（本モジュール対象外）
  ├─ タブ「材料」　　　: MaterialCoveragePanel（材料ごとの欠損割合、本モジュール対象外）
  ├─ タブ「較正値」　　: TuningPanel（走ってみて決める値の編集、本モジュール対象外）
  ├─ タブ「データ保守」: DerivedDataFreshnessPanel（派生データの鮮度台帳）+ DbStatusPanel
  │                     （本番DBの状態）+ TileCachePanel（タイルファイルキャッシュの全消去、
  │                     いずれも本モジュール対象外）
  └─ タブ「開発者」　　: DebugPanel + BackendStatus + SystemStatusPanel + BackendLogsPanel

app/page.tsx（メインページ、地図を持つ、認証なし）
  └─ header: HeaderMenu（使い方を見る・地図の表示を再描画・デバッグログ表示・バージョン表示ボタン）
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
デバッグモードの間に走行モードを始めると記録を始め、止めると途中の1分も行にして止める。休んでいる間も記録を続け、行に走行の状態を残す。
端末には直近の1回の走行だけを残し（`localStorage`の`ridecompass:ride-metrics`。行の上限は`lib/rideMetrics.ts: MAX_ROWS`）、次の走行を始めると前の記録を消す。
デバッグモードでない間と走っていない間は、数える口が最初の比べだけで戻る。

1分の行に残すもの: 電池の残量と充電中か・位置の数と誤差・届く間隔・速さ・向きの出来事の数と向きの変わった数・地図の描き直しと動きとタイルの読み込みの数・
1分の終わりの倍率と層の数・ページの描き直しの数・通信の行き先ごとの数と転送の量・50ms 以上かかった処理（Long Tasks）・描き遅れたコマ（Long Animation Frames）と
その中で時間を使ったスクリプトの上位・JavaScript のメモリ・画面が隠れていた秒数。電池（`navigator.getBattery`）・メモリ（`performance.memory`）・Long Animation Frames は
Chrome にだけある口で、無い端末ではその項目を null・0 のまま残す。転送の量は、キャッシュから読んだ分と、量を明かさない別のオリジンの応答を0に数える。

## 暗黙の前提

- `useAxisCatalog()`（`GET /api/axis-catalog`）の共有・取り直しの規則は
  [ルート設定・結果パネル](route-settings-and-results.md)「暗黙の前提」が持つ。`/admin`と`/`を別タブで
  開くと、タブごとに別のキャッシュで取る。
- `SystemStatusPanel`・`DebugConsole`はポーリングをせず、開いたとき（`open`が`true`に
  なった瞬間）と明示的な「更新」ボタン押下時にのみ`fetchAll`/エントリ取得を行う
  （プロセス内カウンタ・モジュール評価時刻のスナップショットという性質のため）。
