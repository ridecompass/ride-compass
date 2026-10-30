# 地図: 静的レイヤー・道路表示（frontend）

## 責務

タイル焼き込み済みの静的道路属性（路面・道路種別・農道・林道の等級・トンネル・一方通行・自転車レーン・停止
要因POI・補給休憩POI・事故・立ち寄り先）と評価軸の汎用色分けレイヤーを地図上に表示し、地図の左上の「表示」の
ボタンから開く一覧（`MapOverlayControls`）から表示/絞り込みを操作する。

「表示」の一覧の末尾（下記「まとめて戻す操作」）は「まとめて元に戻す」操作を
並べる。**レイヤーのON/OFFと凡例の絞り込みは別の状態のため、戻す操作も別々に要る**
——同じバツ印で並べると区別できないので、対象を形で示すアイコン（重なり＋×／漏斗＋×、
`components/ui/icons/icons.tsx`）を使い分ける。対象を表さない汎用のバツ印アイコンは置かない。

**対象ファイル**

| ファイル | 責務 |
|---|---|
| `lib/mapDisplay/roadTracks.ts` | 道の線の層（軸カタログが配る`road_classes.map_layers`）の凡例の行（区分・その他／該当なし・データなし）と、道の区分が入る行（`lib/mapDisplay/roadTracks.ts: roadTrackRowOf`）。地図の線・地図の凡例・道のりのグラフの帯が同じ行を読むので、同じ道が地図と帯で同じ色・呼び名になる |
| `features/map/scene/groups/roadLines.ts` | 道路の線（例: 路面の種類・トンネル・自転車レーン）を、backendの配る層の値（feature-state）と`roadTracks.ts`の行から式へ組んだ配色と、詳細を見ている1本の強調。**線レイヤーで分類を運ぶのは色だけで、太さは情報を持たず、線種が運ぶのは値が無いこと（タグが無い道＝「データなし」の破線）だけ**——1本の線へ複数の分類を載せると、色の意味が他方のON/OFFで入れ替わる。同時表示は横へ平行に割り付けて分ける |
| `features/map/useRoadClasses.ts` | 道路の線を塗る道ごとの層の値を、表示中のタイルを1枚ずつ問い合わせて取り（[評価軸の色分け](map-axis-coloring.md)の`features/map/tileQueries.ts`）、取得中・失敗とともに返す（道の線の層が1つも出ていない間は取らない） |
| `lib/mapDisplay/pointLayers.ts` | 点で描く属性（`lib/mapDisplay/pointLayers.ts: POINT_LAYERS`）と、点の値が入る行（`lib/mapDisplay/pointLayers.ts: pointCategoryOf`）・大きさの軸と行の半径・点の名前（`lib/mapDisplay/pointLayers.ts: pointPlaceName`）・束ねた代表点の中の名前のある点（`lib/mapDisplay/pointLayers.ts: pointMembers`）。地図の点・地図の凡例・点のポップアップ・道のりのグラフの印が同じ宣言を読むので、同じ点が地図とグラフで同じ色・呼び名になる |
| `features/map/scene/groups/points.ts` | 停止要因POI・補給休憩POI・事故・立ち寄り先の分類・配色・点の絵と枠・描き始める縮尺と積む順・束ねた点の数の文字と、同じタイルを分け合う条件 |
| `features/map/scene/groups/sidePoints.ts` | 選んだ区間の近くの点を、点の層のタイルから点の層と同じ色・絵記号で描く印と、近いかの絞り込み（下記「選んだ区間の近くの点」） |
| `lib/mapDisplay/sidePoints.ts` | 近くの点の距離の上限（backendの`domain/map_display.py: SEGMENT_NEARBY_POINT_MAX_DISTANCE_M`を生成物から読む）・区間の小窓に並べる点の層（補給・立ち寄り先）・地図に出す・消すの区分の鍵と、点の位置を区間に当てた道のりと道からの距離 |
| `features/map/layers/pointIcon.ts` | 絵記号で描く点の、地図へ登録する画素。形は見本（`components/PointIconSwatch/PointIconSwatch.tsx`）の宣言を読む。**単体テストは持たない**（`sdfIcon.ts`と同じく、テスト環境のcanvasは2D描画を実装せず、形は座標の宣言そのもの） |
| `components/PointIconSwatch/PointIconSwatch.tsx` | 地図の点の見本。点の絵の形（行の色の枠——押せる点は角丸四角、押せない点は丸——に載せる白い線の絵記号と、枠を持たない標識の絵）の宣言と、
それを描く部品の列（`components/PointIconSwatch/PointIconSwatch.tsx: pointIconParts`）を持ち、地図へ登録する画素（`pointIcon.ts`）と見本（`PointIconSwatch`）が同じ列を描く。地図の凡例と区間の近くの施設のチップ（ルートの機能）が出すので共有の層に置く。絵記号の名前は源泉の行が持ち、描き方の無い名前は型検査が落とす |
| `features/map/scene/groups/areaRasters.ts` | 面（色別標高図・土地被覆・起伏の陰影） |
| `features/map/scene/legends.ts` | 上の宣言から凡例の行を作る（色と分類の正本はグループにしかない）。災害チップの要素ごとの表示切替の行も、源泉の要素の宣言（backend `domain/weather_elements.py: WEATHER_ELEMENTS`の`features/map/scene/legends.ts: label`、色見本は塗る段`level_scale`）から作る |
| `features/map/scene/mapSceneGroups.ts` | 家族（面・道路の線・点・評価軸・ルート・気象）を「いまの状態から、載っているべきレイヤーの並びを返す」1つの形で宣言する型と、それらを1つのsceneへ畳む`features/map/scene/mapSceneGroups.ts: composeScene`（同じソースを名乗る家族を1本へまとめる） |
| `features/map/scene/sceneBuilders.ts` | sceneを組み立てる道具のうち、どの家族でも同じ形になるもの（ソース名・レイヤーidを作る唯一の口。型で縛り、手で文字列を組み立てられないようにする） |
| `features/map/scene/buildScene.ts` | 地図に載るもの全部を1つのsceneへ組み立てる唯一の口（`features/map/scene/buildScene.ts: buildMapScene`）。受け取るのは実行時にしか決まらない値だけで、見た目の値は各グループが持つ。家族を1つ足すのはここの並びへ1行足すこと |
| `features/map/scene/applyToMap.ts` | 画面の状態を地図へ当てる唯一の入口（状態→各家族の入力`features/map/scene/applyToMap.ts: sceneInputsFrom`→`buildMapScene`→`features/map/scene/applyToMap.ts: applyMapScene`）。作り直しも同じ道を通り、空から当て直すだけが違う。**再描画で失われる表示状態（filter・feature-state・visibility）を持つ描画は、ここから辿れる位置へ置く**——辿れないものは`setStyle()`後に作り直されない。**入力の型はsceneの側で宣言する**（`MapView`のpropsから借りると、sceneと`MapView`が互いをimportし合う） |
| `features/map/maplibreWorker.ts` | MapLibreのWorkerの場所を、ビルド前に静的配信へ複製したもの（`scripts/copy-maplibre-worker.mjs`）へ向ける。地図を作る前に呼ばないと、Workerがバンドラの解決できないURLを読みに行き、スタイル処理とタイル取得が止まる |
| `lib/mapDisplay/tileVersionGated.ts` | タイルの世代が届くまで要求できない情報源の集合（`lib/mapDisplay/tileVersionGated.ts: TILE_VERSION_GATED_SOURCES`）と、それを読むレイヤーを持つチップのグループの名前（`lib/mapDisplay/tileVersionGated.ts: tileVersionGatedGroupLabels`）。地図のレイヤーと、軸一覧を取れないことを告げる文（`hooks/useAxisCatalog.ts`）が同じ集合を読む |
| `lib/mapDisplay/legendFilter.ts` | 凡例の行の型（`lib/mapDisplay/legendFilter.ts: LegendEntry`）と、凡例で隠した行を落とす絞り込み式の組み立て（ルート線のモードが使う） |
| `lib/mapDisplay/landcoverClasses.ts` | 土地被覆のクラス（表示名・色・割合列・地図に塗るか）。backendのレジストリ由来の生成物（`landcover-classes.json`）を読むだけの薄い層で、凡例（レイヤーの記述子）・区間インスペクタ（`RoadInspectorPopup.tsx`）・道のりのグラフの「緑と水」の帯が共有する。色は地図タイルの塗りと同じ値のため、凡例と地図がずれない。**凡例は塗るクラスだけ**（`LANDCOVER_PAINTED_CLASSES`）——塗らないクラスを並べると色見本があるのに地図のどこにも無い表になる。区間インスペクタは数値なので全クラスを出す |
| `features/map/layers/primaryAttributes.ts` | 一次属性のカタログと、二次軸→一次属性の導出（軸増減時の観測データ連動表示に使用） |
| `features/map/layers/mapLayers.ts` | レイヤーカタログ本体（`MapLayerDescriptor[]`）・地図上チップの最上位グループ（`features/map/layers/mapLayers.ts: MAP_OVERLAY_GROUP_ORDER`が正本。現在は道路/環境/スポット）判定・軸スタジオ由来レイヤーの除外判定（軸スタジオ由来のレイヤーはチップに出ないので、名前・アイコン・説明を持たず、idと源泉の宣言だけを持つ`features/map/layers/mapLayers.ts: AxisStudioLayerDescriptor`）・`features/map/layers/mapLayers.ts: deriveFetchLayerStatus`（MapLibreのソースイベントを経由しないレイヤーのデータ状態判定）。静的なレイヤーは源泉の宣言（生成物`mapDisplay.ts: mapDisplay.layers`）の並びを列挙して組み、足すのはアイコン（`components/ui/icons/mapLayerIcons.ts: MAP_LAYER_ICONS`）と表示専用の凡例（`features/map/layers/readOnlyLegends.ts: READ_ONLY_LEGENDS`）だけ。名前・略名・説明・(i)の文は源泉が持ち、説明の差し込み口だけを軸カタログの値で埋める（下記「説明文に評価の名前を書き込まない」）。**`layers/`は`scene/`を読まない**（`scene/`が`layers/`を読む一方向） |
| `features/map/layers/readOnlyLegends.ts` | 絞り込めない表示専用の凡例（`features/map/layers/readOnlyLegends.ts: READ_ONLY_LEGENDS`。土地被覆・降水ナウキャスト・風の矢印・災害）。災害の凡例は、同じ段で塗る要素の名前を見出しにして段を並べる |
| `features/map/layers/layerText.ts` | チップの説明の文の差し込み口を埋める（`features/map/layers/layerText.ts: fillLayerText`。値が空の口は前後の文ごと出さない）と、事故の収録年の言い方（`features/map/layers/layerText.ts: coverageYearsLabel`） |
| `features/map/scene/mapScene.ts` | 地図に載っているべきものの宣言の型（ソース・レイヤー・feature-state）と、重なりの段（`features/map/scene/mapScene.ts: MAP_SCENE_TIERS`）・押せるレイヤーの引き方 |
| `features/map/scene/applyMapScene.ts` | 宣言を地図へ当てる唯一の実装（`features/map/scene/applyMapScene.ts: addImage`/`features/map/scene/applyMapScene.ts: addSource`/`features/map/scene/applyMapScene.ts: addLayer`/`features/map/scene/applyMapScene.ts: setPaintProperty`/`features/map/scene/applyMapScene.ts: setFilter`/`features/map/scene/applyMapScene.ts: setFeatureState`）。前回の宣言との差分だけを当て、段の順に差し込む |
| `features/map/MapView/MapView.tsx`（静的レイヤーの箇所のみ） | 画面の状態をsceneの入力へ渡し、組んだ宣言を地図へ当てる配線。レイヤーの描画コードは持たない |
| `features/map/MapView/useMapScene.ts` | 地図に載るもの全部の入力から scene を組む唯一の口と、そこから押せるレイヤーを引く |
| `features/map/MapView/mapTaps.ts` | 地図を押す・なぞる操作。押した所で一番上の地物を、そのレイヤーが宣言した当たり判定の対象（`hitTargets`）のうち、地図を押したときの意味（`features/map/MapView/mapTaps.ts: MapTapMode`）が開ける対象で開く手続きへ振り分け、長押しで開ける物が無ければ押した所に近い道を backend に問う。地図の出来事（MapLibre の型が約束するものだけ）を判断の部品へ渡し、決まった操作を開く手続きへ渡す |
| `features/map/MapView/mapGestures.ts` | 地図に触れた操作が、タップか長押しか地図を動かす操作かの判断（下記「地図を押したときと地図の小窓」の「押したとき」）。地図にもブラウザにも触れず、出来事を時刻と一緒に受けて、判断の時が来たら返す |
| `features/map/MapView/useMapPopups.tsx` | 地図の小窓（点・道・区間）の状態と開閉と置き方。**小窓はいつも1つ**で、点と道は押して開き、区間は選んでいる区間から導く（押して開いた中身が無ければ区間の中身。区間の選びが変わると、その区間に属さない中身を閉じる）。MapLibreのPopupを1つ器にしてportalで描き、どの小窓も指す地点と間の幅だけで置く（決まりは下記「地図を押したときと地図の小窓」）。選択の持ち主が変わると押して開いた中身を閉じ、閉じる（×・何も無い所を押す）と区間の選びも外す |
| `features/map/MapView/popupPlacement.ts` | 小窓を見えている所の内側へ押し込めたときの左上（画面のpx）。見えている所が無い地図（描く前・隠れている間）では動かさない |
| `features/map/MapView/layerDataSources.ts` | レイヤーのデータ取得状態の算出元（`features/map/MapView/layerDataSources.ts: buildLayerDataSources`）。レイヤーカタログの情報源の名前を、取得を見るMapLibreのソースへ引く |
| `features/map/baseMap.ts` | 基礎地図のスタイル・出典の表記・MapLibreの部品の日本語の文言で地図を作る（`features/map/baseMap.ts: createBaseMap`）。一般の地図（`MapView.tsx`）と下書きの点数の地図が使い、載せるものはどちらも場面で当てる。俯瞰図（`features/map/MapOverview/MapOverview.tsx`）は`inset`で、操作を受けず出典の表記を持たない地図として作る（出典は同じ画面の本体の地図が出す）。基礎地図の文字は薄れさせずに出し入れする（MapLibre の`fadeDuration`を0にする）——薄れる間は地図全体を描き直し続けるので、ずらすたびに操作が重くなる |
| `features/map/DraftWayValuesMap/DraftWayValuesMap.tsx` | 下書きの点数の地図（管理画面の較正の画面が置く。[軸スタジオ](axis-studio.md)「較正の画面」）。下書きで求めた道の点数を、一般の地図と同じ場面の組み立て・道の線の塗り・凡例で塗る。点数は backend が走る条件を入れて求め終えた値なので、道ごとの材料1つとして載せ、それをそのまま道の値にする木（`scene/wayValueFormula.ts: featureValueFormula`）で塗る。下書きの中身と点数の求め方は知らず、置く側が渡す |
| `features/map/layers/mapStyleOps.ts` | 地図インスタンスへの低水準操作（スタイル読み込み後の実行・面レイヤーの差し込み位置・基礎地図の細い道の縁取りの描き替え・ズーム依存のicon-size式）。このアプリのどのレイヤーかを知らないものだけを置く |
| `features/map/layers/routeArrowIcon.ts`・`components/ui/icons/icons.tsx`・`components/ui/icons/layerIcons.tsx`・`components/ui/icons/lucideIcons.tsx`・`components/ui/icons/mapLayerIcons.ts` | ルート矢印・アイコン集（下記「本モジュールとの関係」参照）。`icons.tsx`はアイコンの土台（大きさの受け口・線の様式）と、操作・地点の自前の形、`layerIcons.tsx`は地図のレイヤーと評価軸の自前の形、`lucideIcons.tsx`はlucideの形の包み、`mapLayerIcons.ts`は源泉が宣言するレイヤーごとのアイコンの表（地図の「表示」の一覧と、区間の小窓の層の値のチップが同じ表を引く。レイヤーを足すと型が書き忘れを止める） |
| `features/map/layers/sdfIcon.ts` | 地図の記号に使う単色シルエット（例: ルート矢印・落雷の記号）の描画の土台。白で塗った絵を`sdf: true`で登録し、色はicon-colorで付ける。canvasの2D描画が使えなければ投げる——空の絵を黙って返すと記号が地図から消えるだけで誰も気づけない。**単体テストは持たない**（テスト環境のcanvasは2D描画を実装しない。絵の中身は座標の宣言そのもので、写してもなにも守らない） |
| `components/MapPopup/MapPopupParts.tsx` | 地図の小窓（点・道・区間）を組む部品。どの小窓も「上の帯」（`components/MapPopup/MapPopupParts.tsx: PopupHeader`）と塊——難易度の塊（`components/MapPopup/MapPopupParts.tsx: DifficultyBlock`。難易度・寄与の帯・軸のチップに、同じ塊で読むチップ（風・土地被覆）を並べる）と施設の行（`components/MapPopup/MapPopupParts.tsx: FacilityRows`）——だけで組む。小窓ごとに別の組み方をすると、同じ値が小窓によって違う形に見える。上の帯は右端を寄せるアイコンと×の幅だけ空ける——×はMapLibreが本文の器の右上に置き、どの中身でも幅32px・高さ44pxの押す所を持つ（`app/globals.css`） |
| `components/MapPopup/facilityRows.ts` | 点データ（事故・POI・立ち寄り先）を1施設1行で見せる行の中身（`components/MapPopup/facilityRows.ts: facilityOf`）。区分の名前を凡例と同じ点の宣言（`POINT_LAYERS`の`display_axes`）から引き、宣言（`point_facts`）が点に添える事実（事故の発生年等）を値のあるものだけ並べる。宣言（`point_name_property`）が名前のプロパティを持ち、その点に名前があれば（立ち寄り先と補給のコンビニ）、名前を外の地図（Google マップの検索）を別の画面で開くリンクにする——閉店にデータが追いついていないことがあるので、営業を外で確かめられるようにする。リンクは名前と座標を1つの検索語にした検索で開く（理由と形は`components/MapPopup/facilityRows.ts: externalMapSearchUrl`）。行の位置は、ルートの始点からの道のりでなく、基準の地点から見た前後（「300m先」「100m手前」。走行中は現在地からの「あと1.2km」）で出す（`components/MapPopup/facilityRows.ts: facilityPosition`）。基準の地点は、見るだけの間は区間で押した地点を区間の道なりに当てた所、走行中は現在地で、ページ（`app/HomeMapPane.tsx`）が1つ決めて地図の点の小窓と区分の一覧へ渡す。名前は`lib/mapDisplay/pointLayers.ts: pointPlaceName`が引き、地点を置く意味の間に名前のある点を押して地点を置くとき（`features/map/MapView/mapTaps.ts`）も同じ名前を使う。同じ場所に重なった同じ施設は1行にし、道のりの順（同じ位置なら道に近い順）に並べる（`components/MapPopup/facilityRows.ts: distinctFacilities`） |
| `features/map/MapView/RoadInspectorPopup.tsx` | 道をクリックしたときの詳細（**Reactで描き、MapLibreのPopupへportalで差し込む**）。上の帯に、道の層を出していればその先頭の層の線と同じ見本（`features/map/scene/groups/roadLines.ts: shownRoadTrackOf`）・名前（名前の無い道は道の色の凡例の名前）・事実の要約（路面等）を出し、属性（タイルの事実と、評価を取ったときに届くタグ。**同じ項目は1度だけ**で、日本語の値だけを出し、英語の生の値と登録外のタグはその中の「その他のタグ」にさらに畳む）は畳む——地図の上の小さな枠に収めるため。中身の高さには上限を付けて中でスクロールさせ、中身が伸び縮みしたら置く向きを決め直す（MapLibreのPopupは地図が動いたときにしか決め直さず、開いた後に伸びた中身が画面の外へはみ出す）。評価は押したときだけ取りに行き（backend `POST /api/region/axis-inspector`、[静的道路属性・タイル配信](../backend/static-road-attributes.md)参照。押した地物の鍵と押したタイルを送る）、応答の押した物（その倍率で地図が塗る区間か道1本）の値を、難易度の塊（周囲の土地被覆は最も多いクラスのチップにし、押すと内訳を開く）1つとして出し（地図の線の色と窓の値が同じになる）、**利用者がいま設定している重み**（ルート生成へ送るのと同じ`routePreferenceToSend`の値）で計算させる——既定の重みで見せると、重みを0にした軸まで効いて見える。重みを変えたら、前の重みの評価を見せずに取り直しへ戻す。走行の条件は押したときのものに留める——出発時刻は「今」へ
5分刻みで進むので、今の条件で引き直すと開いている間に評価が消える。評価は道・条件・重みをキーにキャッシュへ残り、
同じ道を同じ条件・重みで開き直したときは押さずに前の評価を出す。軸ごとの効き方は**ルート結果と同じ`AxisContributionBar`**で、チップから開く軸の詳細も同じ`AxisDetail`で出す——同じものを別の見た目で見せると読み方を2つ覚えることになる。寄与度はbackendが返す値をそのまま使い、フロントで重みを掛け直さない。**デバッグログONのときだけ`osm_way_id`を出す**——値がおかしい道を見つけたとき、地図で押した1本をそのままbackendの調査へ渡せるようにする。一般の利用者には読めない値のため常時は出さない |
| `features/map/MapView/roadFacts.ts` | クリックした道の「事実」（例: 道路名・路面の種類・農道・林道の等級・トンネル）をタイルのプロパティから組み立てる純関数。項目名と値の呼び名、タイルのどの属性を読むか（`features/map/MapView/roadFacts.ts: tile_property`）は材料カタログ（生成物`material-catalog.json`）から引く。材料の外の列（識別子・道路名）の名前は生成物`region-tile-config.json`の`region-tile-config.json: road_surface.properties`から引き、押した道のway_id・フィーチャーの鍵もここの関数（`roadWayId`・`roadFeatureKey`）で読む。該当しない項目は行ごと出さない（「なし」が並ぶと該当する項目が埋もれる）。路面の種類（材料`surface`。区分ではなくタグの値の呼び名）だけは値が無くても「不明」として出す——どの道でも最初に見たい項目で、行ごと消すと「舗装されていない」と読める |
| `features/map/regionApi.ts`（`features/map/regionApi.ts: roadSurfaceTileUrl`/`features/map/regionApi.ts: pointTileUrl`とタイル世代の判定） | ベクタタイルのURLテンプレート（`features/map/regionApi.ts: fetchWayMaterials`は[地図: 軸・ルート色分け](map-axis-coloring.md)の管轄）。点のレイヤーはどれも1つの配信（backend `GET /api/region/point-tiles/{layer}/...`）で、URLはレイヤー名（生成物`region-tile-config.json`の`region-tile-config.json: point_layers`の鍵。タイルの世代の系統の名前でもある）で組み、source-layer名も同じ一覧から読む。世代はbackendから実行時に届き、**全系統が揃ったもの（`completeTileVersions`だけが作る`TileVersions`）でしかURLを組み立てない** |
| `features/map/mapAxisCatalog.ts`・`useMapAxisCatalog.ts` | 軸カタログの応答のうち、地図が読むもの（公開中の軸・地図が塗る軸・推定指標のチップ・ルートの色分けモード・事故の収録年・タイルの世代と、それらから組んだレイヤーの一覧`layers`。一覧を組むのは応答1つにつき1回で、地図と`useMapView`は同じものを読む）を導く純関数と、共有の軸カタログと同じ取得（`hooks/useAxisCatalog.ts: useAxisCatalogSelect`）から引くフック。地図がソースを作れるかの判定と、チップの縮退表示は、どちらもここのタイルの世代1つを見る |
| `lib/tileBaseUrl.ts` | タイル配信元オリジンの決定（既定はフロント自身のオリジン＝rewrites経由、`lib/tileBaseUrl.ts: NEXT_PUBLIC_TILE_BASE_URL`設定時はbackend直接）。路面/POI/事故タイル・基礎地図スタイル（`features/map/regionApi.ts: mapStyleUrl`）・国土地理院色別標高図・JMA動的タイル（[動的気象レイヤー](dynamic-weather-layers.md)）が共通に使う |
| `features/map/MapOverlayControls/MapOverlayControls.tsx` | 地図の左上の「表示」のボタンと、押すと開く地図に出す情報の一覧（下記「最上位グルーピング」）。群への束ね方と並びはレイヤーカタログ（`features/map/MapOverlayControls/MapOverlayControls.tsx: mapOverlayGroupFor`・`mapLayers.ts: MAP_OVERLAY_GROUP_ORDER`）から導く。群の見出しで中身をたため、群ごとに一覧に並べる項目を選べる。末尾にまとめて戻す操作（下記「まとめて戻す操作」）を並べる |
| `features/map/MapOverlayControls/OverlayLayerRow.tsx` | 一覧の1行（`features/map/MapOverlayControls/OverlayLayerRow.tsx: OverlayLayerChip`）。行のチェックでON/OFFし、ⓘで説明を、▶で凡例の内訳か案内・取得状態を行のすぐ下に開く。絞り込みの合図（漏斗の印と`features/map/MapOverlayControls/OverlayLayerRow.tsx: isLegendFiltered`）も持つ |
| `features/map/MapOverlayControls/LegendDetails.tsx` | ▶の中の凡例の内訳（`features/map/MapOverlayControls/LegendDetails.tsx: LegendFilterSummaryAxis`）と、地図と同じ形の色見本。`features/map/MapOverlayControls/LegendDetails.tsx: axisId`を持つ軸はその場で絞り込める |
| `features/map/MapOverlayControls/ItemChooser.tsx`・`useOverlayGroupChoices.ts` | 群ごとに一覧へ並べる項目を選ぶ一覧と、群のたたみ・外した項目の保存（下記「最上位グルーピング」の保存の鍵） |
| `lib/backendRewrites.ts` | rewritesの向け先の組み立て（タイル類と地図の下地は`BACKEND_INTERNAL_URL`へ）と、開発機の画面を本番のデータで開く切り替えの判断（切り替えが入った開発サーバーのときだけ、タイルとAPIの`/prod/…`を本番のbackendへ向ける）・同じ Wi-Fi の端末から開くときの開発機の LAN の住所 |
| `next.config.ts`（`frontend/`直下） | フロント自身のオリジンへ来たタイル類（基礎地図・路面・POI・事故等）の要求をbackendへ転送するrewrites（向け先は`lib/backendRewrites.ts`）と、その転送を打ち切るまでの時間（`experimental.proxyTimeout`）。開発機の画面を本番のデータで開く切り替え（[setup.md](../../architecture/setup.md)「開発機の画面を本番のデータで開く」）も読む。e2eのビルドで型の検査を外す設定（`typescript`）も持つ（[run-checks/SKILL.md](../../../.claude/skills/run-checks/SKILL.md)「E2E・画面の撮影の走らせ方」） |
| `components/ui/InfoPopover/InfoPopover.tsx` | 見出し脇の(i)アイコン→ポップオーバーという外枠の共通部品（開閉state・開閉に追随するアクセシブル名「◯◯を表示/隠す」・任意の見出し文言を含む）。中身はchildrenで呼び出し側が渡す。(i)→Popoverを出す箇所（例: `RouteSettingsPanel`・軸スタジオの集計のカード）はこれを使い、組み立てを自前で持たない |
| `features/map/LegendCheckboxList/LegendCheckboxList.tsx` | 凡例のチェックボックス一覧（チェックボックス+色スウォッチ+ラベル）の共通部品。リスト/行の見た目（class名）は呼び出し側が指定する（`LensControl`・`MapOverlayControls`の▶の内訳で共用） |
| `features/map/LegendCheckboxList/LegendRow.tsx` | 凡例の1行と、行の右端の（i）から行のすぐ下に開く説明（`legendFilter.ts: LegendEntry.description`）。絞り込める凡例（`LegendCheckboxList`）と表示専用の凡例（▶の内訳）が同じ部品を通る。浮きパネルにしないのは、凡例が浮きパネル（「表示」の一覧・「評価で塗る」の一覧）の中にあるため |

## タイルの配信元（`lib/tileBaseUrl.ts`）

ベクタタイルはMapLibreがWeb Worker内でfetchするため、URLは常に絶対URLでなければならない
（相対パスはWorkerのベースURLで解決できない）。`tileBaseUrl()`が返すオリジンは、
`NEXT_PUBLIC_TILE_BASE_URL`が設定されていればその値（backendへ直接取りに行く。フロントの
ホスティング経由の往復を省く）、未設定ならフロント自身のオリジン（`next.config.ts`の
rewritesでbackendへプロキシ）。`window`をSSR時に参照しないよう、モジュール定数ではなく
呼び出し時に評価する関数になっている。適用範囲は路面/POI/事故のベクタタイルに限らず、
基礎地図のスタイルJSON（`features/map/regionApi.ts: mapStyleUrl`）・国土地理院色別標高図
（URLは源泉が配る。`region-tile-config.json: gsi`）・土地被覆ラスタ（`regionApi.ts: landcoverTileUrl`）・JMA動的タイル
（`jmaDelivery.ts`のURLテンプレート）も同じ関数でオリジンを決める。JMAの`targetTimes`
JSONや落雷の地点のGeoJSONのようにアプリのfetch()で読む小さなデータも同じオリジンを使う
（タイルのURLは時刻一覧が返るまで決まらないため、ここでフロントのホスティングを経由すると
往復1つぶんが初回表示へ直列に乗る。[動的気象レイヤー](dynamic-weather-layers.md)「暗黙の前提」）。

**暗黙の前提（基礎地図）**: スタイルJSON内のタイル・スプライト・グリフのURLはbackendが
`basemap_public_base_url`で書き込む（[横断基盤ではなく気象・動的レイヤー側の
`basemap_client.py`](../backend/weather-dynamic-layers.md)）。backend直接配信にする場合は
backend側の`BASEMAP_PUBLIC_BASE_URL`も同じbackendオリジンへ揃えないと、スタイルだけ
backendから取り、タイル本体はrewrites経由に戻る。

**暗黙の前提**: backend直接にすると、API呼び出し（`lib/apiBaseUrl.ts`）と同じオリジンに
タイル要求が載る。backend前段がHTTP/1.1のままだとブラウザのオリジン単位の同時接続数上限
（6本程度）をタイル要求が埋め、API呼び出しが詰まるため、HTTP/2以上（多重化）で応答できる
構成でのみ設定する。

## 表示状態の渡し方（レイヤー専用のpropを持たない）

`MapView`が受け取る静的レイヤーの表示状態は`look.layerVisibility`
（`MapLayerId`→boolean）1つで、**レイヤーを足してもこのpropは変わらない**。軸スタジオ由来の
レイヤーの表示は塗っている軸（`look.paintedAxisId`）1つで決まり、軸ごとのpropを持たない
（[design-principles.md](../../architecture/design-principles.md)構造仕様3）。

レイヤー専用のpropを増やす形だと、型宣言・分割代入・再描画対象の列挙・依存配列・可視状態の
対応表へ同じ名前を書き足すことになり、**1箇所でも忘れるとチップはONで凡例も出るのに地図には
何も出ない**（タイル要求すら飛ばないためネットワークを見ても気づけない）。

同じ形は動的気象レイヤーのフック（`features/map/useDynamicWeatherLayers.ts`）の境界にも効いていて、
そちらも`MapLayerVisibility`1つを受け取る。

既定でONにするかは源泉の宣言（backendの`domain/map_display.py`、記述子の`defaultOn`へ入る）で決め、
`buildDefaultLayerVisibility()`が初期値を導く。既定はOFF——「明示的にONにして初めて出る」
が地図レイヤーの原則で、既定ONの根拠は防災級の情報・探索の結果そのものという**性質**だけになる。

## レイヤーを1枚足すときに触る場所

源泉（backendの`domain/map_display.py: _LAYER_SPECS`）へ描き方以外の宣言（種別・情報源・性質・既定表示・名前・説明・(i)の文・最初に隠す行。
一次属性を描くレイヤーの名前は属性の名前で、書かない）を1件、
アイコンの表（`components/ui/icons/mapLayerIcons.ts: MAP_LAYER_ICONS`）へ1行足し（表示専用の凡例があれば`readOnlyLegends.ts`の`READ_ONLY_LEGENDS`へも）、そのレイヤーの描き方を
家族の宣言（`features/map/scene/groups/*.ts`。道路の線なら`roadLines.ts`、点なら`points.ts`、
面なら`areaRasters.ts`）へ足す。描き方の分類・色が源泉（backendの一次属性カタログ）の行で
決まる家族では、源泉へ1行足せば宣言が導かれる。新しい家族そのものを足すときだけ、
`buildScene.ts`の家族の並びへ1行足す。アイコン・表示専用の凡例は`mapLayers.ts`、情報源・説明は源泉の宣言、
重なりの段は家族の宣言が持ち、**描画側に
レイヤーidの対応表を持たない**——対応表に書き足す形だと、忘れても汎用の既定値で描けて
しまい「他のレイヤーと見分けが付かないアイコン」「状態ドットが永久に出ない」「初回描画だけ
重なりがずれる」という、画面を細かく見ないと気づけない壊れ方になる。アイコンの表はレイヤーの名前を
全部持つ型（`Record`）のため、書き忘れは型検査が落とす。源泉の宣言の過不足と説明の書き忘れは生成の時点で落ちる
（`map_display.py: MAP_LAYERS`）。

**描き方の宣言の書き忘れだけは機械が検知しない**。記述子だけ足すと、一覧の行はONになり凡例も
出るのに地図には何も出ない。

## 説明文に評価の名前を書き込まない

レイヤーの説明（`description`・`panelHint`）は源泉（`domain/map_display.py: MapLayerSpec`）が文として持ち、軸カタログ（実行時の
応答）から来る値だけを差し込み口（`LayerTextSlot`。評価の名前・事故の収録年・ルートの色分けで選べるもの）にする
（[設計原則](../../architecture/design-principles.md)「1つの値の中で混ざるときは、部分ごとに問う」）。口を埋めるのは画面（`mapLayers.ts: buildMapLayers`）で、値が空の口は前後の文ごと出さない。
評価に触れるときは、評価の名前を文に直書きせず、軸カタログから
**そのレイヤーの元データを材料に持つ公開中の評価**を引いて差し込む。引き方は
軸の`primaryAttributeIds`（一次属性を描くレイヤーは名前が属性idと同じ）で、backendが軸の材料から導く。
当てはまる評価が無ければ評価に触れる一文ごと出さない。評価は軸スタジオで公開・改名・撤去されるため、
直書きした名前は運用で黙って嘘になる。ルートの説明が並べる色分けも、レンズの選択肢と同じ公開中の評価と総合難易度から作る。

コードの宣言にある事実（凡例の行の名前・順序の色の両端の呼び名・点の大きさ・予測が届く先）も文に写さず、源泉が文を組むときに
宣言から引く（`map_display.py: size_text`・`_row_label`、`weather_elements.py: forecast_reach`）。道の線の層の説明と行の説明は、
管理DBの区分の名前と条件から組む（`domain/road_class_catalog.py: road_class_catalog`）。点の凡例の行の説明の元のタグは、
タグ→種別の表（`domain/traffic.py: TAG_KIND_RULES`）と信号の読み替え（`kinds_shown_as`）から組む（`primary_attributes.py: _kind_row`）。凡例の見本が示す見た目（色の灰・破線）と、画面の部品の名前・位置は文に書かない。

## 表示専用の凡例（`MapLayerDescriptor.readOnlyLegend`）

配信元が色を焼き込み済みでカテゴリ単位に選べないレイヤー（土地被覆・降水ナウキャスト等）は、▶パネルに出す凡例を`readOnlyLegends.ts: READ_ONLY_LEGENDS`が宣言する。絞り込める凡例は`hiddenKeys`と保存先の
`axisId`を持ち、`scene/legends.ts`が出す——**型の上で分けてあるので、ここへ絞り込める
つもりの凡例を書いても黙って読み取り専用にはならない**。

画面の状態からしか作れない凡例（選択中の候補とレンズで変わるルート線の段）だけは
`features/map/view/useMapView.ts`が組み立てる。災害の要素ごとの表示切替は絞り込める凡例と
同じく`scene/legends.ts`が宣言から作る。

## 凡例の行の説明（（i））

凡例の行が「何がこの行に入るか」の説明を持つと、行の右端に（i）が出て、押すと行のすぐ下に説明が開く。
**説明は行を宣言している所が持ち、画面は説明の文を持たない**——道・点の行は一次属性の表示の行
（backend `domain/registry.py: DisplayCategorySpec.description`。路面は区分のタグの呼び名から組む）、
土地被覆はクラスの宣言（`domain/landcover.py: LandcoverClass.description`）、災害の要素は要素の宣言
（`domain/weather_elements.py: WeatherElement.description`）、受け皿の行（その他・該当なし・データなし）は
名前ごと`domain/map_display.py: LEGEND_SHARED_ROWS`が持ち、生成物で画面へ届く。受け皿の行は評価軸・ルートの凡例の
「データなし」も同じ行なので、レンズの凡例にも（i）が出る。数の範囲の段（降水・風・評価の段）と、名前が説明そのものの
行（災害の段と、要素の説明を行の名前に出す線状降水帯）は（i）を出さない。説明が空でないことは、道と点の分類の行では源泉の型
（`DisplayCategorySpec.description`の`min_length=1`）が、受け皿の行では`LEGEND_SHARED_ROWS`の宣言が保証する。
源泉で説明を省ける災害の要素の行（`WeatherElement.description`は`str | None`）は`domain/map_display.py: _disaster_by_frame_rule`が、
土地被覆の凡例の全行は`domain/landcover.py: check_landcover_classes`が、読み込みの時点で断る。

## 表示層の実装（`scene/applyMapScene.ts`）

このモジュールが扱う静的レイヤーの実際のMapLibre実装（`addSource`/`addLayer`/
`setPaintProperty`/`setFilter`呼び出し）はすべて`scene/applyMapScene.ts`にある。
`scene/groups/*.ts`は色分け式・分類の**宣言**のみを持ち、
DOM/MapLibreを一切知らない。`MapView.tsx`は画面の状態をsceneの入力へ渡すだけで、
レイヤーを直接は触らない。

**記号の絵もsceneが宣言し、地図に同じidの絵が無いときだけ足す。** 記号のレイヤーが名指す絵は、そのレイヤーを
宣言するグループがsceneの`images`として返し、`applyMapScene`が記号のレイヤーより先に足す。足すかは前回の宣言ではなく
地図に有るか（`hasImage`）で決める——スタイルを差分で差し替えても絵は地図に残り、同じidを足し直すとMapLibreは
投げずに誤りの出来事を出す（`maplibre-gl/src/style/style.ts`の`addImage`）。宣言から外れた絵も地図から消さない。

**前回の宣言との差分は自前で取り、依存に既にある`@maplibre/maplibre-gl-style-spec`の`diff()`は使わない。**
`diff()`はスタイル全体どうしを比べて地図への操作の列を返すもので、このアプリの当て方と次の点で合わない
（`diff.ts`・`util/deep_equal.ts`、版は`frontend/package.json`）:

- **feature-stateを扱わない**。返す操作にfeature-stateの設定・解除が無い（スタイルの一部ではない）ため、
  配信値で塗る線の差分は結局別に取ることになる。
- **比べる相手がスタイル全体**。基礎地図のレイヤーまで含めた完成形を毎回組み、その中でこのアプリの面を
  道路網の手前へ挿す位置も組む側が決める必要があり、差し込み位置の判断（下記`areaLayerAnchor`）は残る。
- **タイルのURLが変わるとソースを作り直す**。GeoJSON以外のソースの変更は、ソースとそれを使うレイヤーを
  消して足し直す操作になる。`setTiles`で入れ替えれば残る取得済みのタイルを捨てることになる
  （`scene/sceneBuilders.ts: tilesContent`）。
- **比較が参照の一致を先に見ない**。`deepEqual`は同じオブジェクトどうしでも中身を全部たどるので、変わって
  いない大きなGeoJSON（ルートの形等）を状態が変わるたびに走査する。自前の比較は同じ参照なら
  そこで終える。

**面で塗るレイヤーは基礎地図の道路網より下に入る**（`mapStyleOps.ts`）。段が面なら
`areaLayerAnchor`の返す位置を`beforeId`にする——判断は`applyMapScene`1箇所にあり、
レイヤーごとに持たない。そのため下記の並び順が効くのは
**面どうし・線どうしの相対順**であって、面と線の間ではない（面をどれだけ濃くしても、
基礎地図の道路・地名とこのアプリの線レイヤーはその上に残る）。

差し込み位置は**基礎地図が道路網を描き始める最初のレイヤー**として導く。道路網は
`source-layer`が`transportation`のレイヤー群（OpenMapTilesスキーマの語彙で、基礎地図は
このスキーマのタイルを配る）で、**並び順やレイヤーidからは導かない**——スタイルの配色や
見せ方が変わってもスキーマの名前は変わらないのに対し、並び順は相関でしかない。

導出を並び順に頼ると2通りに外れる。「最後に面を描いたレイヤーの次」では、基礎地図が道路より
後ろにも面を置く（建物）ため位置が道路の後ろまで下がり、面が道路を覆ったまま残る。
「線が最も長く連なる区間の先頭」では、トンネル（`tunnel_*`）と地上の道路（`road_*`）の
境目に入り、道路網がトンネル区間だけ面の下に沈んで**道が途切れて見える**。

道路網より後ろに残る面（歩行者areaの塗り・建物）は`prepareBasemap`が道路網の
手前へ動かす。動かさないと、道路の下へ潜らせた面が建物の不透明な塗りに穴を開けられる。

位置は`applyScene`がsceneを当てる直前に`prepareBasemap`がスタイルごとに1度だけ
決める。呼ぶ時機に縛りは無い——このアプリのレイヤーは`transportation`を名乗らないため、既に
載っていても位置は変わらず、道路網より後ろに積まれていたこのアプリの面も一緒に手前へ入る。
スタイルを取り直すときは`reloadStyle`で取り直し、新しいスタイルの`style.load`で解決済みの記録を落としてから
作り直しの`applyScene`を呼ぶ。記録を落とすのは読み込まれたあと——`map.setStyle()`は既定で今のスタイルとの差分を当て、
差分が届くまで`getStyle()`は今の（このアプリの層を足し、店・施設を隠した）スタイルを返すので、その間に決め直すと
隠した後の絞りを配信元の絞りとして記録する（`maplibre-gl`の`Map.setStyle`は、`diff: false`を渡さなければ取ったスタイルを今のスタイルとの差分として当てる）。
スタイルを取れなかったときは`style.load`が来ず今のスタイルが残るので、当て直さずに取り直しを終える（MapLibreはその失敗を、
取りに行ったURLを持つ`error`の出来事でだけ知らせる）。そのとき地図の読み込みの失敗の案内を出し、押し直せば取り直して、取れたら
案内を消す。取り直しの間のタイル1枚の失敗では案内を出さない（今のスタイルは残っている）。

**暗黙の前提**: 建物を道路の手前へ動かすと、面レイヤーを1枚も出していないときの基礎地図も
「建物の上に道路」へ変わる。この地図はpitchを持たないため影響は小さい。

**基礎地図の細い道の縁取りは、面の有無に関わらずいつも濃い灰で描く**（`palette.json: semantic.basemap_minor_road_casing`。
`prepareBasemap`がスタイルごとに1度、`mapStyleOps.ts: MINOR_ROAD_CASING_LAYER_ID`に当たる層の`line-color`を描き替える）。libertyは
引いた縮尺（z13.5より手前）の細い道を白い線を描かずに縁取りの線だけで描き、配信元の縁取りの薄い灰は、雨・色別標高図の面を
重ねた地とほぼ同じ明るさになる（面は道路網の下に入るので、縁取りは面を重ねた地に載る）。描き替えた色は、面なしの地と雨の各段を
重ねた地に対して線が見えるコントラスト比を割らないことを`tests/test_display_palette.py`が測る。色別標高図はタイルの画素ごとに
色が違うので、そこでは測らない。層はidで名指す——縁取りかどうかはスキーマの語彙（`class`）では分からず、配信元のスタイルの
層の並びにしか無い。スタイルが層を改名すると黙って当たらなくなる。

同じ`prepareBasemap`が、基礎地図の店・施設（`source-layer`が`poi`のレイヤー全部。libertyでは`poi_r1`・`poi_r7`・
`poi_r20`・`poi_transit`）の配信元の絞りを記録する。**このアプリの点の層の行が出ている間だけ、同じ種類の基礎地図の印を隠す**
（`applyScene`が scene を当てるたびに`mapStyleOps.ts: hideBasemapPois`へ、出ているレイヤーが名指した種類の和を渡す。
`scene/mapScene.ts: hiddenBasemapPois`）。立ち寄り先・補給休憩のチップを出していないとき・凡例でその群を隠したときは、基礎地図の
印と名前をそのまま出す。点の層の行（立ち寄り先の飲食店・自転車・景色・名所・宿と寺社、補給休憩のコンビニ）はOpenStreetMapでない
出どころから出すので、同じ種類を基礎地図（OpenStreetMap）と同時に出すとODbLの共有の義務がかかる（[データソース](../../architecture/data-sources.md)）。
出している間だけ隠す形は、OpenStreetMap財団の指針（Horizontal Map Layers Guideline）が共有の要らない例に名指した形（基礎地図から
同じ種類を除く）ではなく、同時に出さないので要らないと読んだ推測に立つ（法の専門家の判断ではない）。
行ごとに隠す種類は点の層の宣言の隣（`groups/points.ts: BASEMAP_POIS_BY_ROW`。鍵は源泉の点の属性と行の鍵で型を縛る）が持ち、
`mapStyleOps.ts`は種類を知らない。値はOpenMapTilesのスキーマの値で、種類はスキーマが束ねた`class`（束ねる先の無い値は
`subclass`と同じ値）で名指し、`class`が粗すぎる種類だけ`subclass`（元のOSMのタグの値）で名指す（コンビニは店全体の`class=shop`に入る）。
銭湯・温泉はスキーマに値が無いので隠さない。病院・銀行・郵便局・学校と駅・バス・空港はどの行も名指さない。基礎地図の絞りが
式の形であること（libertyはそう書いている）を前提にする——旧い形の絞りと式は1つの`all`に混ぜられない。

重なり順は**宣言だけ**が決める（段の並びは`scene/mapScene.ts: MAP_SCENE_TIERS`）。
宣言が自分の段を持ち、`applyMapScene`が段の順に並べて当てる——**作る側の配列の並びは順序に関係せず、レイヤーを
足す人が挿す位置を選ばない**。同じ段の中はカタログに現れる順を保つ。

段は背面から順に、面で塗るもの・観測した事実の線・レンズの線・点データ・
ルート。この並びは「後から追加される側が先の側を塗り潰さない」ために決めてあり、たとえば
レンズの線は観測した事実の線より前面に来る。

**作る順に関わらず段の順になる**。`applyMapScene`は1枚足すたびに「段の順で自分より前面に
あり、かつ既に載っている最初のレイヤーの直下」へ差し込むため、宣言をどの順で並べても
結果は変わる余地が無い（初回描画だけ重なりがずれて再描画で直る、という形の不具合が
構造的に起きない）。段が決めるのはこのアプリが足したレイヤーどうしの前後だけで、
基礎地図に対する位置は`areaLayerAnchor`が決める（上記）。


「道路情報」の各層（軸カタログの`road_classes.map_layers`。分け方1つが層1つ）は**それぞれ独立した線レイヤー**で、同じベクタソースを
共有する。道ごとの層の値（区分の鍵か「データなし」）はbackendが決め、`/api/region/road-classes`でタイルごとに配る（ルートの区間の帯も
同じ値を持つ）。地図は値を feature-state で受けて塗るだけで、区分の条件を当てない。`scene/groups/roadLines.ts`は層ごとに色式・
不透明度式を宣言する——**どちらの色の意味も、もう一方のON/OFFでは変わらない**。太さは全レイヤー共通で源泉が配る値
（`mapDisplay.road.lineWidthPx`）を使い、線種は「データなし」の破線にだけ使う。feature-state は絞り込みからも`line-dasharray`からも
読めないので、凡例で隠した行は透明で落とし、データなしの道は破線だけの線を重ねて濃さで出し入れする。区分の外の道は値を
持たないので、値を取っている間は値の無い道をどれも取得中の色（`palette.semantic.loading`）で描く。取得中・失敗は、出ている道の線の
層のチップの状態ドットに出る。両方ONのときは下記の並列トラックが横へ分ける。

区分に当てはまらない道は2種類を分ける。**事実の無い道は「データなし」**（値が無い。薄い灰の破線、刻みは`mapDisplay.noDataDash`）、
**事実はあるが区分の外の道は「その他」**（値はある。薄い灰の実線）。分けるかは層が決め（`has_no_data`）、分けない層は「データなし」の
行も破線も持たず、区分の外の行を「該当なし」と呼ぶ。

**値のある道が少ない層は、値の無い道の行を最初は凡例で隠して始める**（層の`hide_missing_rows`）。郊外では路面のタグが無い道が
8〜10割あり、自転車レーンは当てはまる道が数％しか無いので、値の無い道の線が値のある道を埋もれさせる。隠す行の鍵は`scene/legends.ts: initiallyHiddenLegendKeys`が
層から決め（データなしを分ける層ならデータなし、分けない層なら該当なし）、隠した行の保存先の既定にする。保存先は利用者が
触った軸だけを空の並びも含めて覚え、触っていない軸（あとから足した層も）は最初に隠す行のまま読む
（`view/legendFilters.ts: deserializeHiddenLegendKeys`）——空にした軸を保存先から消すと、出した行が次の訪問でまた隠れる。

## 出典表記（`domain/map_display.py: ALWAYS_SHOWN_ATTRIBUTIONS`）

MapLibreはソースへ渡した`attribution`を**そのソースが地図に載っている間だけ**出す。評価軸・
ルートの計算・常設の表示（ヘッダーの天気・警戒度バッジ）へ常時使っているデータ（道路網・標高・事故・土地被覆・
気象庁の観測と警報・風のMSM・暑さ指数・地点の検索で引く住所の区画等）の出典をソース側へ付けると、
そのレイヤーを消した瞬間に出典も消える。常時使うデータの出典はbackendが一覧として宣言し（生成物`mapDisplay.ts: alwaysShownAttributions`）、`features/map/baseMap.ts: createBaseMap`が
AttributionControlの`customAttribution`へ渡して、どのレイヤーを出しているかと関係なく出す。データ源を足す人は
backendの同じ場所で出典も足す。ソース側の`attribution`に
残すのは、そのレイヤーを表示している間だけ関係する外部データ（色別標高図等）。気象レイヤーはソース側に出典を
持たない——描くデータの提供元（気象庁・MSMを配るOpen-Meteo）は常設の表示でも常に使っており、常時表記が既に出している。

地理院・警察庁・気象庁の公共データ利用規約（PDL1.0）は、出典とは別に**加工した旨**の記載を求める。
MSMを配るOpen-MeteoのCC BY 4.0も、リンク付きのクレジット・ライセンスへのリンク・変更した旨を求める。
立ち寄り先（Overture Mapsの地点）の出典も同じ一覧に置く。出どころごとの表示が要り、FoursquareのApache 2.0が求める
ライセンスの写しとNOTICEの全文は、`frontend/public/licenses/`に置いたファイル（`/licenses/…`で配られる）へ行からリンクする。
標高タイルからは勾配を、事故点からは区間ごとの件数を、アメダスの観測からは累計の雨量・雨が止んでからの時間
（雨の材料）を、アメダスの観測と推計気象分布からは常設ヘッダーの天気を導き、警報の区域の境界は簡略化し、気象庁の配信タイルは欠けたズームを隣のズームから
補い、降水のタイルは色をアプリの段の色へ塗り替え、MSMの格子は地点・時刻へ補間しているため、常時表記はこの文言を含む。暑さ指数は最寄りの地点の予測値と
提供元のサイトが掲げる指針の段階で出す（値を変えない）ので、出典だけを書く。規約が示す書き方は記載例で、
書式（括弧・語順）は定めていない（警察庁ウェブサイト利用規約の「出典記載例」。2026-09-27に確認）ので、表記の括弧は
画面の文言の決まり（半角の`[]`）に従う。

基礎地図（OpenFreeMap / OpenMapTiles）は常時表記へ書かない——配信元のTileJSONが`attribution`を
持っており、MapLibreが同じ場所へ出す。書くと同じ出典が2回並ぶ。

表記は既定で折り畳まれている（ⓘのみ）。展開の状態は`styledata`/`sourcedata`のたびに畳み直す
（`features/map/baseMap.ts: createBaseMap`。一般の地図と下書きの点数の地図の両方）。展開している間だけ、右下の出典の置き場を地図の下端の操作（元に戻すボタンの列・現在地ボタン）より
前に出す（`globals.css`）——出典は数行に折り返し、そのままでは操作の下に隠れて読めない。

## 面の濃さ（`scene/groups/areaRasters.ts: AREA_OPACITY`）

**濃さは上下から挟まれている。** 下げると薄い階級が基礎地図の背景と区別できなくなり、
上げると面の下にある土地の塗りが潰れる。片側だけを見て動かさない。

**下限の決め方**: 最も薄い階級が、基礎地図の背景に対して**ΔE（CIE76）で15以上**離れること。
値を動かすときはこの尺度で測り直す——「見た感じ薄い」で下げると、背景色の違う地域や
ダークモードで区別できない階級が出る。

## 起伏（陰影）の濃さ（`scene/groups/areaRasters.ts`）

陰影は「傾きのある所だけ塗る」ため、面レイヤの規則をそのまま満たす。ただし**MapLibreの
既定のままでは、この国の平野部では出ていても気づけない**。

- 計算方法は`igor`。既定の`standard`は傾きのsinに比例して塗るため、関東平野の傾き（数度）
  では影の実効の不透明度が0.03を下回る。`igor`は傾きのarctanに比例し、同じ傾きで倍以上になる。
- **`basic`・`multidirectional`は使えない**。平坦な画素にも光を塗るため、「値のある所だけ
  塗る」を満たさない。
- 標高は`raster-dem`のcustom encodingの係数で垂直方向へ強調して読む。**タイルの値は実際の
  標高のまま**で、読み方だけを変える（mapbox encodingの係数を倍率倍したものを渡す）。倍率を
  上げるほど緩い斜面が読めるが、上げすぎると急斜面との差が潰れる。

**暗黙の前提**: 陰影の濃さはズームにも依る（MapLibreは1画素あたりの標高差から傾きを求める
ため、拡大するほど同じ斜面の濃淡が薄くなる）。倍率は広域で見るときを基準に決めている。

## スタイル取り直し後の作り直し（`applyScene`の`reset`）

「地図の表示を再描画」は`map.setStyle()`でスタイル全体を差し替えるため、このアプリが
足したsource/layerは一度すべて消える。`MapView`は`style.load`を待って（`features/map/MapView/useMapLifecycle.ts`）、いまの宣言
（`latest.current.scene`）を`applyScene(map, scene, { reset: true })`で空から当て直す——画面の状態が
変わるたびに通る経路と同じ宣言・同じ適用で、前回との差分を取らないことだけが違う。

**暗黙の前提**: 宣言から辿れない描画は作り直されず、そのレイヤーは押した人の地図から
消えたまま戻らない（次にそのpropが変わるまで復旧しない）。**対象はsource/layerの追加に
限らず、filter・feature-state・visibilityで持つ表示状態も同じ**——たとえば詳細を見ている
道の強調（`scene/groups/roadLines.ts: inspected`）はレイヤーのfilterとvisibilityだけで表され、ポップアップは
開いたままなので、復元しないと「どの線の話か」だけが失われる。そのため
詳細を見ている道（コンポーネントのstate由来）も宣言の入力に含める。**再描画で失われる
副作用を持つもの**（source/layerの追加・filter・feature-state・visibilityの設定）は、
宣言の一部として書く——宣言の外で当てたものは、スタイル切替後に再追加されず消える。
カメラはここでは動かさない——表示範囲は利用者の操作に属し、フィットは候補一覧が
変わったときだけ行う。

## ソース名とレイヤーidの決め方

**ソースはデータの識別子、レイヤーidはそこから機械的に伸ばす。**

- **ソース名**は宣言する側が付ける。`sceneSourceId`が唯一の作り口で、**型で縛ってある**
  ——手で文字列を組み立てると型検査が落ちる。組み立てが散ると、レイヤーidとの対応が
  「たまたま合っている」状態になり、規則を変えたときに片方だけが動く（動くので気づけない）
- **レイヤーid**は`sceneLayerId(ソース名, 役割)`。どのレイヤーがどのデータを描いているかが
  idから読める
- **グループの接頭辞はidに出ない。** グループは束ねるための内部の単位で、データの名前ではない

**ソースはグループをまたいで共有される。** 評価軸の線は道路の線と同じタイルを名乗り、
`composeScene`が1本へ畳む（ソースは地図に1本しか作れない）。だからソース名を「宣言した
グループの名前」から決めてはいけない——別のグループが同じデータを名乗れなくなる。

**1ソースに何枚重ねるかは自由。** 道路の線は1つのタイルに分類ぶんのレイヤーを重ね、ルートは
1つの線に縁取り・当たり判定・矢印を重ねる。**どこか1つのグループだけ「1ソース1レイヤー」に
縛らない**——縛ると、そこだけ2枚目が要る日に規則が崩れる。

**綴りを手で書かない。** 家族の外でidが要るとき（押されたレイヤーの判定・テスト）は、
その家族が出すソース名と役割を`sceneLayerId`へ渡して作る。

## 地図を押したときと地図の小窓（`MapView/mapTaps.ts`・`MapView/useMapPopups.tsx`）

地図を押したときの動きと地図の小窓は、この節の決まりだけで決まる。場合を足すときは、この節の決まりを書き換えてから足す（決まりの外に場合分けを重ねない）。

**押したとき。** 押すことが別の操作になっている間（「ルート設定」を開いている間は押した所に地点を置き、ピンを押すとその地点を選ぶ。乗り換えを選んでいる間は乗り換え先の帯を選ぶ）を除き、どの画面の状態（パネルを閉じている間・「ルート結果」の間・走行中）でも同じに、押した物の小窓を開く。重なっていれば一番上に描かれた物を開き、何も無い所を押すと小窓を閉じる。候補の線を押すと、小窓は開かずにそのルートを選ぶ。
「押す」はタップ（地点を置く・点・区間・候補の線・乗り換えの帯）と長押し（道。PC は右クリック）の2つで、**地図を動かす操作は、どれも押したことにしない**
——都市部ではどこを触っても点か道に重なるので、地図を動かすために触っただけで小窓が開くと、動かすたびに小窓が出る。タップとみなすのは、1本の指で、
離すまでに地図をずらす幅（`features/map/MapView/mapGestures.ts: TAP_TOLERANCE_PX`。地図を作るときに MapLibre の`clickTolerance`へも渡す）より動かさず、押し始めに地図が利用者の操作で流れておらず（流れている地図を止めた触れではなく）、
長押しにもならなかった押し。押せる物（地点を置く間は名前のある地点、ほかの間は上の押して受ける物）に当たったタップは、離したときにすぐ受ける。
何も無い所のタップは、ダブルタップの1回目でないと確かめる間（`features/map/MapView/mapGestures.ts: TAP_CONFIRM_MS`。MapLibre がダブルタップとみなす間）だけ
待ってから受け、その間に次の押しが来るか地図が動き出したら受けない——押せる物に当たったタップまで待つと、その分だけ小窓が遅れて開く。ダブルタップ・ダブルクリックの
拡大は MapLibre の標準の扱い（地図の設定`doubleClickZoom`）で、押せる物の上のダブルタップは、小窓を開いたうえで拡大する。長押しは、指1本を動かさずに置き続けた押し（`features/map/MapView/mapGestures.ts: LONG_PRESS_MS`）と、
マウスの右ボタン（MapLibre の`contextmenu`。型の文書が約束するのは右ボタンとメニューのキーだけなので、指で押している間に来たものは受けない）で、
押した物の小窓を開き、開ける物が無ければ下の道を開く。走行中に地図への触れを受け付けないロックをしている間は、何を押しても開かず閉じない（[ページ構成](page-composition.md)「走行モード」の「ロック」）。

**押せる物は、情報を足す物だけ。** 名前のある点（「表示」の層の点と、区間の付近に描いた点。どちらも同じ点）・道・選んでいるルートの区間・候補の線。
道だけは地図の線で当たりを取らない: 長押しした所にほかの押せる物が無ければ、押した所に近い道を backend に問い（`POST /api/region/roads-at`）、
近い順の先頭の道の小窓を開く。道の層を出していなくても、凡例で隠した行の道でも押せ、道のタイルを読まない。拾う幅は指の幅（`features/map/MapView/mapTaps.ts: ROAD_REACH_PX`）を
押した所の緯度と倍率で地面の m に直したもので、道のタイルの無い引いた縮尺（`features/map/regionApi.ts: ROAD_TILE_MIN_ZOOM`より前）では問わない。
小窓は押した直後に閉じ、道が返ってから開く（問うている間に押し直したら、前の答えは捨てる）。押した道の強調は、返った道の線の形で描く——
区間で塗る倍率では区間、引いた倍率では道1本が光り、小窓の値と同じ単位になる。名前の無い点と地点のピンは、位置と凡例（印の形と色）以上の情報を持たないので、押せる物に数えない——上を押すと、下にある物がそのまま開く。押せる点と押せない点は、印の枠の形で見分けられるようにする（下記「点で示すもの」の「点の形も源泉が決める」）。

**小窓はいつも1つで、作りと置き方は同じ。** 最後に押した物の中身を出す。どの小窓も上の帯と塊で組み、右上に地図を寄せるアイコンと×（幅32px・高さ44px。間を詰めて上の帯のつまめる所を広く残す）を置く。どの小窓も押した所を指し、向き（地点の上・下・左・右のどちらに出すか）は MapLibre の Popup が地図の枠に収まる側を選ぶ（`anchor`を指定しない）。押した物に小窓がかぶったら、利用者が上の帯をつまんでずらす（`components/MapPopup/MapPopupParts.tsx: PopupHeader`。どの小窓も同じ）。ずらした小窓は、閉じるまで指す地点からのずれを保ち、地図を動かすと一緒に動き、押した所を指さないので矢印を出さず、四隅を同じに丸める。ずらす前は、見えている所からはみ出す分を内側へ押し込める（`MapView/popupPlacement.ts: popupInsideVisible`）——Popup は向きを選ぶだけで中へはずらさないので、上にも下にも収まらない背の高い小窓や、端の近くで開いた小窓が画面の外へ出る。ずらした後は、上の帯の一部（`MapView/useMapPopups.tsx: DRAGGED_POPUP_KEEP_PX`）が見えている所に残る分だけ押し込め、左・右・下へは外へ出てよい——全体を押し込めると、地図の幅いっぱいの小窓は横へずらせない。地図が動き終えたときと中身の大きさが変わったときに置き直す。幅を中身に合わせること（`maxWidth`）と、地図の上に重ねた部品を避けること（`padding`）は Popup の標準の設定で済ませる。名前は折り返さず、小窓の幅を中身に合わせて広げ、地図の幅を超えるときだけ空白で折る。高さには上限があり、あふれたら中でスクロールする。×・何も無い所を押す・パネルを切り替えると閉じる。区間の小窓を出している間に点を押すと、区間の選びを残し、点の小窓の上の帯に「‹ 区間」を置いて戻れるようにする。点のほかの物を押すと、区間の選びを外す。

**小窓の中身。**

- 点: 押した所に描かれている名前のある点を1施設1行で並べる。束ねた代表点は、中の名前のある点を全部並べる（`lib/mapDisplay/pointLayers.ts: pointMembers`。印は中の点ごとの位置に置く）。見本・名前（Googleマップを開くリンク）・道からの距離、区間を選んでいる間はその地点から見た前後。
- 道: 上の帯に線の見本・名前・事実の要約、評価の塊（押すと取る）・土地被覆・畳んだ属性。
- 区間: 地図の区間の線は、区間の番号（`features/map/scene/groups/routeSources.ts: ROUTE_SEGMENT_INDEX_PROPERTY`）と線を塗る値（色分けのモードの式と凡例の絞り込みが読む値）だけを持ち、押すと選んでいる候補の同じ番号の区間を引く（押したときにしか使わない詳しさを地物に載せない。[データモデル](../../architecture/data-model.md)）。中身は道のりのグラフの表示の断面。上の帯に何km地点・到達予想、グラフで選んでいる層のその地点の値（線の層の値と勾配・帯の層の区分）、難易度と軸ごとの寄与。風は難易度の内訳に入っているので、値を別に出さない。

**区間を選んだとき。** 区間は地図で押しても、道のりのグラフで選んでも（押す・なぞる）同じに選ばれ、押した区間を強調し、押した所に印を置き、区間の小窓を出し、線から`lib/mapDisplay/sidePoints.ts: SIDE_POINT_MAX_DISTANCE_M`以内の点の層の点を、「表示」で出しているかに関わらず描く（下の「選んだ区間の近くの点」）。地図は動かさない。グラフの下には地点の詳しくを出さず、区間の中身は地図の区間の小窓だけが出す。選んだ地点が地図の見えている所の外にあれば、グラフの右上の寄せるボタンを色で目立たせて知らせる。

**地図を寄せる。** 地図は押しただけでは動かず、寄せる操作のときだけ動く。小窓の寄せるアイコンは、点ならその点へ、区間ならその区間の形へ、道なら押した道の線へ寄せる。グラフの右上の寄せるボタンは、選んだ区間の形へ寄せる。ルート結果のカードを押すと、選び直しでも今選んでいるカードでも、そのルート全体へ収める（生成直後と同じ）。走行中に現在地を追っている間は、寄せるアイコンと寄せるボタンは追うのを休んで寄せ、休ませた後に小窓が閉じると（区間なら選びを外すと）追い直す。カードは収めない。寄せるのはどの小窓も同じ1つの手続き（`features/map/MapView/useSectionFocus.ts: useSectionFocus`）で、点は点へ寄せ、線は線を収める。

## 選んだ区間の近くの点（`groups/sidePoints.ts`）

区間を選んでいる間だけ、点の層のタイル（停止要因・補給・立ち寄り先・事故）のうち区間の線から`lib/mapDisplay/sidePoints.ts: SIDE_POINT_MAX_DISTANCE_M`以内の点を、点の層と同じ見た目（行の色の丸か、行の色に絵記号を載せた絵）で、「表示」で点の層を出しているかに関わらず描く。近いかは MapLibre の`distance`式で決める（backendへは問い合わせない）。描いた点は「表示」の点と同じ点で、押したときは上の「地図を押したときと地図の小窓」の決まりに従う。点の層の行（先頭の軸の行）に当たらない値の点は描かない。点の層と同じく、束ねた点には数を出す。点のタイルは路面のタイルと同じズーム（`features/map/regionApi.ts: ROAD_TILE_MIN_ZOOM`）から読むので、それより引いた地図では近くの点を描かない。

## 重なりの段（`scene/mapScene.ts: MAP_SCENE_TIERS`）

**レイヤーは前後を個別に指定せず、段を選ぶ。** 隣り合う2枚の前後を宣言で決める形にすると、
3枚目を足したときに既存の2枚の関係だけでは位置が決まらない。並びの正本は
`MAP_SCENE_TIERS`で、面 → 観測した事実の線 → レンズの線 → 気象の格子の印 → 点 → ルート → 選んだ区間の近くの点の順。
選んだ区間の近くの点は、その区間の縁取りと点の層の上に描く（区間の近くの何を見ているかを隠さない）。
記号は前面のレイヤーから場所を取り、ぶつかる後の記号は描かれないので、段の順は重なった記号のどれを残すかも決める。気象の格子の印
（風の矢印等）を点の下の段に置くのは、重なると点の印を残すため。

**面は基礎地図の道路網より下へ入る**（`under`）。面を道路の上に置くと、
どの道の話なのかが読めなくなる。
ほかの線・点・ルートは基礎地図より前面。段の順が効くのは、基礎地図の同じ位置へ入る段どうしの前後だけ。

**段を足すのは、上下関係が既存のどれとも違うときだけ。** 「この2枚だけ入れ替えたい」は
段ではなく、同じ段の中の並びで解く。

## 並列トラック分離（`scene/groups/roadLines.ts`）

同じ道路ジオメトリへ複数の線を重ねると、後から描いた方が前を覆い隠す。`line-offset`で
道路と平行な複数トラックへ横並びに分離する——**出ている本数から対称に割り付ける**ので、
どれかをOFFにすると残りが自動で中央（実際の道路の位置）へ寄り直す。間隔は線の太さより
狭くして隣どうしをわずかに重ねる（離すと1本の道が複数に見える）。

## 二次軸の下敷き表現（`scene/groups/axisLines.ts: underlay`）

評価軸の線は「その材料（対応する一次属性の表示レイヤー）が1つでも同時に表示されて
いるとき」だけ太く半透明な下敷きになる。材料が1つも表示されていなければ通常の太さ・
不透明度で表示する——常に下敷きにすると、道路網が密な都市部では下敷きの重なりだけで地図
全体がぼやける。「どの一次属性がどの軸の材料か」の解決はsceneの入口
（`scene/applyToMap.ts`）が、地図の軸カタログの`dedicatedAxes`の`primaryAttributeIds`とレイヤーの
ON/OFFから行う（画面の側は下敷きの有無を知らない）。

**見た目の値は、すべて宣言そのものが持つ**。下敷きの太さ・不透明度も、絞り込みも、
グループが返す宣言の一部として出す。宣言の外から`setPaintProperty`や`setFilter`で
足す形を取らないため、**「当てた後に誰かが巻き戻す」という経路が無い**（当てるのは
`applyMapScene`だけで、前回の宣言との差分しか触らない）。この性質は
`scene/scene.allLayers.contract.test.ts`の「スタイルを差し替えても、同じ状態を伝え直せば元へ戻る」で固定してある。

## 初期表示の覆い（`initialTilesLoading`）

最初の数秒はタイルが揃わず地図がほぼ白紙のため、`MapView`が「地図を読み込み中…」の
覆いを重ねる。外すのは基礎地図が描けた時点で、MapLibreの`load`で取る——`load`は載っている
すべてのタイルが揃った最初の描画で来るが、アプリのソースは`load`の後に足す（`runWhenStyleReady`）
ので、その時点で描けているのは基礎地図だけ。`idle`は表示中のすべての取得が落ち着くまで来ないので、
使うと遅い外部データが1つあるだけで描けた地図を覆ったままになる。基礎地図のタイルが止まって
`load`が来ないときの保険に、`INITIAL_TILES_OVERLAY_MAX_MS`（6秒）でも外す。

## レイヤーのデータ取得状態（地図上チップの状態ドット）

`MapOverlayControls`の一覧の行は、`mapLayers.ts: LayerDataStatus`を受け取り、
「表示ON かつ dataStatus が設定されている」間だけ行の名前の右へ小さな状態ドット（`ui/Dot`。`tone`が
`LayerDataStatus`の値そのもの）を描画する（`on`/`active`がfalseの間は出さない）。

ドットの意味（`mapLayers.ts: LAYER_DATA_STATUS_LABELS`）は、待ち以外の間▶パネルの
凡例の上へ文として出す。凡例を持たないチップも、待ち以外の間は▶を出す——`title`だけでは
スマホで読めない（規約は[ページ全体構成](page-composition.md)「失敗・空・待ちの伝え方」）。
待ち（loading）は文にしない（`layerDataStatusNotice`）——凡例の絞り込みやON/OFFのたびに
タイルが取り直され、開いたパネルの先頭に文が一瞬出ては消えて凡例が上下に揺れるため。
案内文（ズーム不足・配信情報なし）があるときは案内文だけを出し、状態の文は重ねない。
タイル取得の失敗は原因（429・通信エラー・5xx）を区別せず同じ文言で出す（同節の規約4）。

凡例の絞り込みで一部を隠しているONの行には、漏斗形の小さな印を添える
（`title`にも「絞り込み中」を添える）。絞り込みは保存されるため、次に開いたとき欠けた地図を
「データが無い」と読ませないための合図で、隠していない間は見た目を変えない。群を
たたんでいる間は行が見えないため、群の見出しが同じ印で行の絞り込みを示す。「表示」のボタンも、どれかの行が絞り込んでいれば同じ印を持つ。

チップの取得状態（`features/map/view/overlayChips.ts`へ渡す値）は、
出所の異なる2つの`Partial<Record<MapLayerId, LayerDataStatus>>`をマージしたもので、
内訳は次の2系統:

- **`useMapView.ts: mapLayerStatus`**（`features/map/MapView/layerDataSources.ts: buildLayerDataSources`）:
  road/POI/事故/標高等、MapLibreが自身のタイル取得として実行するレイヤー。ソースイベント
  （`sourcedata`/`sourcedataloading`/`error`）から算出する。
- **`dynamicWeatherDataStatus`**（[動的気象レイヤー](dynamic-weather-layers.md)
  「データ取得状態」節参照）: 降水ナウキャスト・風・災害（雷・竜巻・落雷・キキクル4種を
  1チップへまとめたグループ）。
  実際の外部フェッチがアプリ自身の取得（TanStack Queryの定期取得等）で行われ、結果を
  `map.getSource(id).setData(...)`等で流し込むだけのため、MapLibreのソースイベントは
  フェッチの待ち時間・失敗を観測できない。`buildLayerDataSources`の対象外とし、代わりに
  各要素のフェッチ自身のloading/errorから直接算出する。

両者はキーが重ならない（`buildLayerDataSources`は動的気象レイヤーを含まない）ため、
マージの優先順位を気にする必要はない。

## 「ズームインすると表示されます」の案内

ベクタタイルは配信元が決めた最小ズーム未満では要求されないため、そのズームでは
ONにしても何も塗られない。「データが無い地域」と区別できるよう案内を出す。

対象は**最小ズームを持つ情報源を読むレイヤー**で、閾値は情報源の側で源泉が宣言する
（backendの`domain/map_display.py: MAP_LAYER_DATA_SOURCES`）
——レイヤーごとに書くと、同じタイルを読むレイヤーの1つだけ書き忘れても型が通り、そのチップ
だけ案内が出ない。配信より寄ってから描く層（停止要因・事故。下記「点の形も源泉が決める」）は、描き始める縮尺も同じ案内に数える
（`domain/map_display.py: MapLayerSpec.draw_min_zoom`。記述子の`minZoom`は配信の縮尺と描き始める縮尺の寄った方）。`features/map/view/useMapView.ts`が、地図から届く表示範囲（パン・ズームが確定する
たびに届く）の`zoom`で`mapLayers.ts: tileZoomTooWideLayerIds(zoom)`を引き、そのチップへ
`TILE_ZOOM_TOO_WIDE_NOTICE`を出す——ズームは表示範囲の通知に含まれているため、地図から別の
通知として上げない。▶の中身は**案内文があれば案内文、無ければ凡例**
の順で決まるため、呼ぶ側が凡例を空へ揃える必要はない（揃える形だと、揃え忘れたレイヤーで
案内が黙って落ちる）。

表示ON/OFFでは出し分けない。ONにする前に「いまの縮尺では出ない」と分かる方が、ONにして
から何も起きない理由を探すより早い。

**同じ判定を複数の出し先へ出すときは、判定を1か所で行い、結果を配る。** チップの案内文と
状態ドットは、ズームと世代の判定を`overlayChips.ts`の1か所で行い、どちらもそこから作る——
出し先ごとに判定すると、片方だけ抑制し忘れて「ドットは出ているのに理由の文が無い」食い違いが
生まれる。

## 「配信情報を取得できず表示できません」の案内

タイルの世代は`GET /api/axis-catalog`が運び、地図は共有の軸カタログと同じ取得の応答から世代を導く
（`useMapAxisCatalog.ts`）。**届くまでソースを作らない**——先に作ると
世代の違う中身がブラウザのキャッシュへ載って以後ずっと残る。したがってカタログの取得が
失敗した間、道路・POI・事故は地図から**丸ごと消える**。これ自体は正しい挙動で、直すべきは
「消えた理由が画面のどこにも無い」ことだけである（利用者からは「この地域にデータが無い」と
見える）。

ズーム不足と同じ仕組みに乗せる。対象は**記述子が宣言した情報源が世代を要るレイヤー**で、
`mapLayers.ts: tileVersionGatedLayerIds`が引く。`overlayChips.ts`がそのチップへ状態ドットを
付ける——まだ取得中なら`loading`、取得が終わったのに世代が無ければ`error`。
`TILE_VERSIONS_MISSING_NOTICE`は**取得が終わってから**出す——取得中に「取得できず」と出すと、
待てば出るものを壊れていると読ませる。

**暗黙の前提**: 「世代が揃ったか」を軸カタログの取得完了で代用しない。世代を返さない版の
backendが200で応答する窓では、カタログは取得済みなのに世代は無く、そこでURLを組み立てた側が
例外になる。判定は`regionApi.ts: completeTileVersions`だけが答え、揃うまで地図の軸カタログの世代は`null`のまま。

宣言は源泉に1つ。タイルで配る情報源は**世代を配るタイルの系統の名前**を名乗る（backendの
`map_display.py`が一次属性の`tile_kind`から導く）ので、世代を要る情報源は系統の一覧
（生成物`region-tile-config.json`の`tile_version_kinds`。`lib/mapDisplay/tileVersionGated.ts`が読む）そのものになる。どのレイヤーがその
情報源を読むかも源泉の宣言で、レイヤーごとに「世代を要るか」は持たない——2つ持たせると
ずれたときに「描けていないのにチップが黙る」。

同じ失敗の再試行導線は常設ヘッダーの「未取得」の印（[ページ全体構成](page-composition.md)「失敗・空・待ちの
伝え方」）と[ルート設定・結果パネル](route-settings-and-results.md)の重みタブにある（軸一覧の取得失敗として
告知する。描けないものの名前は、世代を要るレイヤーを持つチップのグループの名前から作る）。地図側は理由を出すだけで、再試行ボタンは置かない。

**暗黙の前提**: 軸スタジオ由来のレイヤー（評価軸の線）も同じ路面タイルを
共有するため同じズームで消えるが、地図上チップを持たないため案内の出し先が無い。
レンズだけを選んだ状態でも、同じタイルを読む道路のチップ側に案内が出る。

## 最上位グルーピング（道路/環境/スポット）

`mapLayers.ts: mapOverlayGroupFor(layer)`がチップを`category`からグループへ分類する。
**どのレイヤーがどの`category`かは源泉が宣言する**（`domain/map_display.py`。`category`→
グループの対応と同じ場所）——画面が持つのは描画の都合だけで、束ね方の所属はそこに入らない。
軸スタジオ由来のレイヤー（`isAxisStudioLayer`: 評価軸の線。記述子の`axisStudioLayer`が立つ）は
一覧の行の組み立て（`features/map/view/overlayChips.ts: overlayChips`）が
**束ねる前に1か所で**除く（一覧のどこにも出さない。表示はレンズが持つ）。

**暗黙の前提**: `mapOverlayGroupFor`は`category`しか見ないので、軸スタジオ由来のレイヤーは中分類を
持たない（源泉の`axisLayers`の宣言が中分類を空にする）ことでどのグループにも入らない。チップの一覧を通さずに
レイヤーを束ねる場所を作るなら、同じ除外を先に通す。

グループは表示上のまとまりだけを表し、**どのレイヤーも複数同時にONにできる**。重なって
読みにくくなった場合は、各行の▶パネルで要素・カテゴリ単位に絞り込む（下記「凡例
カテゴリの絞り込み」節）。道路グループの線同士は`line-offset`による並行トラック
（`scene/groups/roadLines.ts`の横位置の割り付け）で重ならずに並ぶ。

**ある行をONにしたことにつられて、別の行をONにしない**（推定指標をONにしても、その
材料の観測レイヤーは連動しない）。裏からONにされると、一覧を開くまで出した覚えの無いものが地図に出続ける。

**レイヤーは地図の上に並べず、どの幅でも1つの「表示」のボタンから開く一覧に畳む**（ボタンは地図の左上、
「評価で塗る」（`LensControl`）は地図の上端の検索の欄の下の段の中央で、右の縦の列とも「表示」のボタンとも重ねない——「表示」のボタンはアイコンだけの、列と同じ幅にし（名前「表示」は説明に出す）、「表示」の横に収まらないほど地図が狭い間は、ピルを「表示」の下の段へ下げる。置き場は`app/HomeMapPane.tsx`が決める）。地図の上に群ごとの
チップを縦に並べると、スマホでは開いた群のチップが地図の左を縦に半分以上覆い、ルートを収めるときの左の余白にもなった。
畳むと出し入れは「表示」→行の2回押しになるが、地図の上に残るのはボタン1つになる。ボタンには地図に出している件数と、
どれかの行が凡例を絞り込んでいる合図（漏斗）を付ける——閉じている間も、何かが出ている・欠けていることが分かる。
一覧は群の見出し（群の色）の下に行を並べる。行の名前は略さない
（一覧には幅があり、略名を持つ理由が無い）。並べ方をレイヤーカタログ側（`mapLayers.ts`）が決めるのは、一覧の中身が
そこから導かれるため。選択中のルートにひもづくレイヤー（`kind`が`dynamic`。今はルートの線だけ）は群の行に並べず、
一覧の先頭（群の外）のルートの行で出し入れする（候補を選ぶまで押せない）——ルートの線はレイヤーカタログの群に属さない、
作った結果の線なので、群の並びの外に置く。線の色と、その凡例の絞り込みは「評価で塗る」（`LensControl`）が持つ。
群の行から除くのは軸スタジオ由来のレイヤーと同じ`overlayChips`の1か所。

行のⓘ（説明）と▶（凡例の内訳）は、行のすぐ下に開いて一覧の中で送る。一覧の上へ別の浮きパネルを重ねると、スマホの幅では
一覧の右に出す余地が無く、重ねた窓が行そのものを覆い、下端で切れる。一覧は下部シート・タブバーより上に重ねる（`ui/Popover`の既定の層）
——画面の下端まで伸びた一覧がその下へ潜ると、潜った行を押せない。

群の見出しを押すと中身をたため、見出しの脇の「表示する項目を選ぶ」で、その群の一覧に並べる項目を選べる（外した項目は
たたみを開いても並べず、地図に出していればOFFにする。並べ直してもONにはしない）。項目の先頭の「すべて」で、群の項目を
まとめて選ぶ（全部並んでいれば全部外し、1つでも外れていれば全部並べる。凡例の軸の見出しのチェックと同じ）。たたんだ群と外した項目は次の訪問でも保つ
（`useOverlayGroupChoices.ts`の保存の鍵。外した項目は`<群>:<レイヤーid>`の並び）。ⓘ・▶の開閉は一時の確かめなので保たない。

軸スタジオ由来のレイヤー（`isAxisStudioLayer`、評価軸の線）は一覧に
現れず、`layerVisibility`の対象外——表示ON/OFFはレンズ（`LensControl`）が
単独で持ち、常に1つだけが選ばれる。これらは同じ道路の同じ位置をそれぞれの評価で塗り分ける
ため、重ねると後から描画した色が前の色を完全に覆い、並行トラックのように並べて見ることも
できない。

## 凡例カテゴリの絞り込み（サイドバーと地図上チップで同じ状態を共有）

`LegendFilterSummaryAxis.axisId`（`features/map/MapOverlayControls/LegendDetails.tsx`）を持つ軸だけがユーザー操作で
絞り込める。`axisId`は隠した行の保存先（`features/map/view/useMapView.ts`が持つ1つの表）の
鍵を指す。書き換える場所は▶パネル（`MapOverlayControls`）だけではない——レンズの凡例
（`LensControl`）も同じキーの状態を書き換える（保存先が1つなので、片方で隠した段は
もう片方でも隠れたままになる。[地図: 軸・ルート色分け](map-axis-coloring.md)参照）。
描画にはどちらも`LegendCheckboxList`を使う。軸の名前を持たない凡例（ルートの線）の、全段階をまとめて切り替える行の名前は、
レンズの凡例と同じ「凡例」にする（同じ状態を操作する行が、置き場ごとに違う名前にならないように）。

`axisId`を持たない軸は読み取り専用の凡例として描画される。配信元が色を焼き込み済みの
ラスタタイル（降水ナウキャスト・風・災害の危険度凡例）がこれにあたり、カテゴリ単位で
地物を選り分けること自体ができない。

**保存された非表示キーの長さを、そのまま「絞り込み中か」の判定に使わない。** この保存先は
ルート確定の前後・`LensControl`・地図上チップのどこから操作しても同じ1つで、段の綴りが
変わった版で保存された値や、段数が変わった軸の値は相手側の凡例に存在しない。数えるなら
いま描いている凡例に実在するキーだけを見ること——見ないと、隠れている段は1つも無いのに
「一部非表示」だけが出る。

レンズに選んだ軸の凡例も、**最後の1段どころか全段まで隠せる**。「急な坂だけを見る」のように
段で絞って見る使い方があり、全段を隠した状態は、チェックが全部外れていること自体が理由を示す。

例外として、災害チップの「表示する情報」だけは`axisId`を持ちながら地物の絞り込みではなく
**レイヤーソースの表示切替**に使う（`useDynamicWeatherLayers`が非表示キーを見て各ソースの
`visible`を決める、[動的気象レイヤー](dynamic-weather-layers.md)参照）。UIとしては
他の絞り込みと同じチェックボックス行で、反映先だけが異なる。

## まとめて戻す操作

毎回使う操作ではないので地図の上に常に浮かせず、次の3つを名前の文字つきで置く。レイヤーと凡例の2つは「表示」の一覧の末尾
（`MapOverlayControls`。状態と操作は`features/map/view/useMapView.ts: overlayControls`）、再描画は画面の右上のメニュー
（`components/HeaderMenu/HeaderMenu.tsx`。操作は`useMapView.ts: redrawMap`）に置く。

- **表示中のレイヤーをすべて非表示**: 群の行を全部OFFにする（既定へ戻すのではない。先頭のルートの行は消さない）。
  ONの行が1つも無い間は押せない。
- **絞り込みをすべて解除**: この一覧の凡例で隠した行を全部戻す（「評価で塗る」の凡例は、そちらの同じ名前のボタンが戻す）。
  出しているレイヤーの凡例で隠している行が無い間は押せない（数えるのは、いま描いている凡例に実在する行だけ。上記「凡例カテゴリの絞り込み」。
  出していないレイヤーの最初に隠す行を数えると、地図に何も欠けていないのに最初から押せる）。
- **地図の表示を再描画**: 押した人の地図インスタンスだけを、スタイルから取り直して組み直す。
  ページの再読み込みと違い、生成済みのルート候補は消えない。サーバー側のタイルキャッシュには
  触れない（そちらは全利用者へ影響するため管理画面にある）。

## 道路の線に出す分類（`lib/mapDisplay/roadTracks.ts`）

タイルには区分へ束ねる前の事実の値が焼き込まれている（例: `surface`［路面の種類］・`highway`［道路種別］）。線の層・区分・
色・呼び名は管理DBの道の区分が持ち、軸カタログの`road_classes.map_layers`で配られる。画面は区分の条件をタイルの値へ当てて
線を塗り、層をグループへ入れる鍵（中分類）とアイコンの鍵も配られた値から引く——知らない中分類の層はどのグループにも入れず、
知らないアイコンの鍵には道路の絵を出す。区分を取れるまでは道の線の層を出さない。

**線で描く分類を足すときは、「他の分類と独立して決まる事実」であること。** 粒度違い・合成の
再掲（路面の区分を2値へ粗く束ねたもの、区分と等級を合成したもの）は足さない——「路面の種類=砂利」
かつ「舗装/未舗装=未舗装」のような組み合わせは常に矛盾するか冗長になり、絞り込みとして
情報を増やさない。路面の種類（surfaceタグ）と農道・林道の等級（tracktypeタグ）は別のタグで、
片方だけが付いた道が多いため、別々の線として並べる。

**ユーザーが色分け軸を選ぶUIは持たない。** 絞り込みと色の選択を同じ画面へ同居させると、
絞り込んだ結果1色しか出ない軸を選べてしまう（情報量ゼロの表示になる）。

**分類は、OSMタグを網羅する体系ではなく「走りやすさの違いが出る単位」へ束ねたもの。**
凡例が一目で読める数に抑え、稀な値は分類を持たない側（薄い表示）へ落とす。**値が一覧に
無いのは見落としではなく、束ねないと決めた結果である。**束ね方は管理DBの区分そのもので、地図の行は区分を1行ずつ塗る。

**線の束ね方から、生のタグの値の呼び名を導出しない。** 線の行は複数の生タグ値を1行へ
束ねる（多対一。自転車レーンの行は複数のタグの組み合わせ）のに対し、軸スタジオは1値につき1ラベルを要る。粒度が違うので、値ラベルは
`domain/material_catalog.py: MaterialSpec.value_labels`（生成物`material-catalog.json`）から引く。
区分は材料に持たないので、行の名前は区分が、材料の値の呼び名は材料カタログが持つ。

## 地図全体で共有する配色の読み方

**1次（観測された事実の分類）は中立色、2次（評価軸）は緑〜赤。** 1次に評価配色
（緑・アンバー・オレンジ・赤の系統）を使うと、地図の上で「観測された事実」と「推定された
評価」が混同される。順序を持つ分類（道路種別の幹線→細街路）は、明度で順序を示し、色相も並びに沿って
動かす（明度だけの濃淡は、下の明度の上限の中では隣どうしが近く、どれも暗い灰に見える）。色相は評価配色の
系統を避けた範囲（赤紫→水色）に限る。

**1次に評価配色を使う例外は無い。** その分類が評価へ寄与していても（事故の当事者区分は
事故密度の材料になる）、寄与するかどうかと重みは軸定義が持ち運用で入れ替わる。色に
「良し悪し」を持たせると、軸を編集した瞬間に地図の色の読み方が定義と食い違う。

**色は宣言しない。** 軸が決めるのは「どのパレットか」と、順序を持たない列挙なら「色相の
起点」と「明度の段」だけで、色そのものはbackendの`domain/display_palette.py`が1箇所で作る。順序のある
分類は並びから明度と色相を、順序を持たない列挙は**起点から色相環を行数で等分**する——連番で
隣の色相を配ると、同じ軸の行どうしが最も見分けにくい色になる。明度は軸の中で1つにそろえるため、
軸の途中で系統が変わって見えることも無い。**起点は軸をまたいで重複させない**——同じ起点
だと、1行しか持たない軸どうし（トンネルと一方通行）が必ず同じ色になる。

**同時に出る点のレイヤーどうしは、明度と彩度の段を変えて離す。** 点のレイヤー（停止要因・補給・事故・立ち寄り先）は
どれも同時にONにでき、同じ画面に並ぶ。行を色相環へ等分して配る以上、起点を変えてもレイヤーをまたいで
近い色相が残るので、停止要因は暗い段、補給と事故は明るい段、立ち寄り先は鮮やかな段（明度は標準のまま彩度を上げる）に置く。
明度は上を地色とのコントラストが、下を絵記号の白との見分けが決めるので、明度の段だけでは4つ目のレイヤーを離せない。色だけでは、レイヤーをまたいだ色の
離れ具合は軸の中の基準（下記のΔE 20）まで届かない（最も近い組でΔE 14前後。補給と事故はどちらも明るい段で、
色相の近い行どうしが残る）。そのため形でも分ける: どの点のレイヤーも行ごとの絵記号で描き（下記「点で示すもの」）、事故の点は大きさと薄さもほかの点と違う。線のレイヤーは明度の段を
持たず標準の明度で塗り、線のレイヤーどうしの色は離さない（道路の種類と農道・林道の等級のように、同時に出る線どうしで
同じ色が並ぶものがある）。同時に出る線は「並列トラック分離」節のとおり道の上の位置が分かれ、点のように同じ場所で重ならないため、
どちらの線かはトラックの並びと凡例で読み分ける。

**分類色は基礎地図の地色から浮く明るさまでに限る。** 分類色は地図の上では常に基礎地図の
背景（`palette.json: semantic.basemap_ground`）に載る。これに対してコントラスト比3:1を
割る明るさは「薄い＝対象外」（下記）と見分けられないため使わない。同じ制約の下で、軸の
中の色は互いに離す（CIE76のΔEで、列挙はどの2行も20以上、順序は隣どうしを10以上——順序は明度でも示すので、
隣どうしの差は小さくてよい）。点のレイヤーどうしも、どの2色もΔE 10以上離す。値は
`tests/test_display_palette.py`が色を持つ軸すべてに対して測る。

**色を持つのは先頭の軸だけ。** 事故のように1つの点へ2つの見方があるとき、地図は先頭の軸
（当事者）で塗り、重大度は点の大きさだけで示す。2本目以降の軸に色を配ると、地図のどこにも
塗られない色が凡例にだけ並ぶ。点の大きさは、行に半径（`radius_px`）を宣言した軸が決め、半径を宣言できるのは
点の軸のうち1本だけ（backendの`test_registry.py`が確かめる）。凡例の重大度の行は、地図の点と同じ絵の外形（事故は星形）を色を持たない灰で塗り、地図の点と同じ
大きさで並べる（大きさは地図と同じ関数`lib/mapDisplay/pointLayers.ts: pointIconScales`から取る）。

**凡例の色見本は、パネルへ直に、地図と同じ形で置く**（道の線の行は線、点の行は点、絵記号で描く点の行は同じ絵記号）。線の行は線の形のまま
地図の線より太く出す（凡例の行の`line`）——地図と同じ太さでは、見本を囲む輪（下）に挟まれて色の部分が細く残り読めない。点の見本は
色が読める大きさにする。明るい地色の台に載せる形は取らない——ダークモードの暗いパネルの上では台の白が色より
目立ち、明るい色（弱い雨の水色等）が台に溶ける。**暗黙の前提**: 地図は明るいままで分類色はその明るい地から
浮くように作ってあるため、濃い色（道路の種類の幹線等）はダークモードのパネルでは地図より沈んで見える。
**見本は文字の色の細い輪で囲む**（`legendFilter.ts: LEGEND_SWATCH_RING_CLASS`。チップの▶・レンズの凡例・ピルの帯・
レンズの選択肢の丸が同じ値を使う）。見本の色は地図と同じ値なので、面に溶ける色が面ごとに必ず残る——ダークの暗い面
では濃い色が、▶の内訳（半透明の面に明るい地図が透けて中間の灰になる）では中間の明るさの色が、ライトの白い面では
白に近い色が溶ける。見本の色だけをダーク用に差し替えると凡例と地図の色が食い違うので、色は変えずに輪で場所と形を示す。
値が無い行（凡例の行の`isFallback`。どの凡例でも`mapColorLegend.ts: NO_DATA_LEGEND_BAND`の「データなし」）は、地図の破線と同じく途切れた見本にする
（`legendFilter.ts: legendSwatchBackground`。チップの▶・レンズの凡例とピルが同じ関数を通る）。

**色だけでなく、描くときの寸法も宣言しない。** 線の太さ・点の半径・面の濃さ・不透明度・
アイコンの拡大率・標高の強調倍率は、backendの`domain/map_display.py`等が宣言し、生成物
（`types/generated/`）として届く。どの生成物が何を持つかはそのディレクトリが正本で、
ここに一覧を置かない。**フロントが持つのは「どの値を使うか」だけ**——同じ値を両側が持つと、
片方を直してももう片方が古い値で描き続け、画面を細かく見ないと気づけない。

新しい表示値はbackend側へ宣言する。フロントに残る数値は描き方の側のもので、表示値ではない:
見えない当たり判定の太さ（指の接地面）、記号の絵を描くキャンバスの画素と形（画面での大きさは宣言の倍率が決める）、
地図の上に置くDOMの部品（地点のピン等）の見た目（画面の部品の見た目としてfrontendが持つ）。

**「薄い＝対象外、濃い＝分類あり」を地図全体で統一する。** 分類を持たない地物（タグ欠損・
未分類）は消さずに不透明度を下げる。1次のレイヤーを複数同時にONにしても、分類情報を
持つ区間だけが浮かび上がる。**薄い側も地図の上で見える濃さに留める**——灰の線が基礎地図の地色に対して
コントラスト比1.5を割ると、道があるのに線が無いように見え、「データなし」とも読めない（値はbackendの
`map_display.py`、測るのは`tests/test_display_palette.py`）。評価軸の下敷きの薄さはこれとは別の値で、
材料の線より手前に重なるため、材料の線の色を隠さない薄さにする。**「対象外」へ評価配色の緑は割り当てない**——対象外は「安全と
確認済み」ではなく「材料が無い」であり、緑が持つ「良い」という含意とは別物のため、
中立グレーで薄く出す。

**分類を運ぶのは色だけで、太さ・線種は分類を持たない。** 同じ道へ複数の線が重なるときは、
色を掛け合わせず横へ平行に割り付ける（1本の線へ2つの意味を載せると、色の意味がもう一方の
ON/OFFで入れ替わる）。

**太さ・線種が運んでよいのは「操作の状態」と「値が無いこと」だけ**——選んでいるかどうかは、色では表せない
（色は分類に使い切っている）。乗り換え帯が未選択で破線・選択で実線かつ太いのはこれに当たる
（[ルート設定と結果](route-settings-and-results.md)）。値が無いこと（道・評価軸・ルートの
「データなし」）は分類ではなく、どの属性・軸でも同じ意味なので、線を重ねても混ざらない——これは
細かい刻みの破線（`mapDisplay.noDataDash`、`sceneBuilders.ts: noDataDashExpression`）で示し、乗り換え帯の
破線（`mapDisplay.route.spliceDash`）と刻みで見分ける。取得中（まだ値が来ていない）は値が無いと決まって
いないので破線にしない。配信値（feature-state）で塗る評価軸も破線にできない（[地図: 軸・ルート色分け](map-axis-coloring.md)）。
分類を線種で表し始めたら、この区別が崩れている。

## MapLibreの式を組むときの前提

**スタイル式の誤りは例外にならない。** `addLayer`や`setPaintProperty`が式を受け付けなくても
JSの例外は飛ばず、`map.on("error")`にしか出ない。画面上は**そのレイヤーだけが黙って
描かれない**。記録用の代役地図は式を検証しないため、`scene/scene.allLayers.contract.test.ts`が
出せるものを全部出した状態の宣言（凡例の絞り込みを含む）をMapLibreと同じ版のstyle検証
（`@maplibre/maplibre-gl-style-spec: validateStyleMin`）へ通す。実際のアプリの配線（カタログ・
タイル世代・保存されたレイヤーのON/OFFから組まれたもの）が本物の地図の`addLayer`を通ることは、
E2Eの`e2e/map-runtime.spec.ts`「宣言された地図レイヤーを全部ONにしても、スタイル検証のエラーが
出ない」が見る（取得の失敗以外の地図のエラーが0件）。タイルの中身を読む評価時の誤り（下の
欠損値の比較等）は、E2Eのタイルが空なので、どちらでも捕まらない。

**式の中へ配列を渡すときは`["literal", [...]]`で包む。** 包まないとMapLibreが先頭要素を
演算子名として読み、`Expression name must be a string`でそのレイヤーの追加が失敗する。

**タイルのプロパティを比較・補間・`step`へ渡す前に、欠損を落とす。** `["has", prop]`で
分岐するか`coalesce`で既定値へ倒す。欠損値と数値の比較は評価時エラーになり、上と同じく
そのレイヤーだけが描かれなくなる。

**`addLayer`へ渡す`beforeId`は、今のスタイルに在るものだけ。** 無いidを渡すと例外を投げる。
記録しておいた差し込み位置が消えていたら`beforeId`を省いて最前面へ積む。

**`filter`は、値が無いならキーごと省く。** `filter: undefined`を持たせたまま渡すと
「filterには配列が必要」で弾かれる——MapLibreはキーの有無ではなく値の型で判定する。

## 点で示すもの（`features/map/scene/groups/points.ts`）

トンネル・一方通行・停止要因POI・補給休憩POI・事故は、backendが既に1つの分類値
（`kind`=列挙文字列、`tunnel`/`oneway`/`involves_bicycle`/`fatal`=真偽値）へ変換済みの
プロパティを読む。道路の線の分類のように複数の生タグ値を束ねる必要はない。

分類値の一覧はbackendが正で、フロントは色とラベルを与えるだけ。**backendが種別を1つ足した
のにフロントが古いままだと、その地物は`baseFilter`に弾かれて地図から完全に消える**（凡例にも
出ないため「データが無い」としか見えない）ため、分ける条件は源泉の表示の行（生成物
`types/generated/primaryAttributes.ts: display_axes`の値）から導き、行と種別の一覧が一致することはbackendが
読み込みの時点に全種別で確かめる（`domain/primary_attributes.py: check_point_rows`）。凡例の行は種別と1対1ではない——利用者から見て区別する意味の無い種別（車道用の踏切と
歩道・自転車道用の踏切）は1行へまとめる。色分け式には各種別がそのまま載るため、地図の
見た目とポップアップの語彙は種別ごとに正しく出る。

**点の形も源泉が決める。** 点は先頭の軸の行が持つ絵記号の名前（`domain/registry.py: DisplayCategorySpec.glyph`。点の先頭の軸の行の全部が持つ）で描く。
名前のプロパティを持つレイヤー（補給・休憩等）は、行の色の枠に白い線の絵記号を載せる（例: コンビニ＝袋・トイレ＝WC）。
**枠の形は押せるかを示す**: 名前のある点（押せる点。上記「地図を押したときと地図の小窓」）は角丸四角、名前の無い点は丸い枠で少し薄く描く
（`scene/groups/points.ts: iconImageExpression`。名前の有無は点ごとに式で決める）。名前のプロパティを持たないレイヤー（停止要因・事故）は
点が全部押せないので、枠を持たない、日本の道路標識に似せた絵で描く（例: 一時停止＝赤い逆三角に「止」、踏切＝黄色のひし形に電車。
絵の形は`components/PointIconSwatch/PointIconSwatch.tsx: POINT_GLYPHS`が持ち、色は`domain/display_palette.py: SEMANTIC_COLORS`の標識の色を読む）。
この層は、宣言した描き始める縮尺（`domain/registry.py: PrimaryAttributeSpec.point_min_zoom`）より引いた縮尺では描かない——道に沿って並ぶ
信号や事故を引いた縮尺で描くと、地図が絵で埋まる。区間の近くの点も同じ縮尺から描く。
事故の重大度は絵の大きさで示し（`lib/mapDisplay/pointLayers.ts: pointIconScales`。凡例の見本も同じ倍率を読む）、凡例の見本も地図と同じ絵で出す。
絵は行ごとにsceneの絵として宣言し（`scene/groups/points.ts: POINT_IMAGES`）、記号は行の値から絵の名前を引く——丸のレイヤー（`circle`）は
MapLibre の重なりの判定に加わらないので、点はどれも絵の印で描く。
近い点はタイルの側で凡例の行ごとに代表点へ束ねて届く（[静的道路属性](../backend/static-road-attributes.md)「点のタイル」）。
**重なる印は地図が省く**: 点の層は MapLibre の重なりの既定（ほかの記号とぶつかる印は描かない）を上書きしない（`scene/groups/points.ts: pointLook`）。
束ねは層ごと・凡例の行ごとなので、層をいくつも出すと1つの升に行の数だけ代表点が重なるが、地図はそのうち先に置いた印だけを描く。
省いた点は寄せて重ならなくなると出て、押せるのは描かれた点だけである。印は上に積んだ層から置かれるので、宣言の残す順
（`domain/registry.py: PrimaryAttributeSpec.point_priority`）の大きい層を上に積む（`scene/groups/points.ts: STACKED_POINT_LAYERS`。区間の近くの点も同じ）。
層どうしは停止要因 → 補給 → 立ち寄り先 → 事故の順に残す（走る前に知りたいのは、どこで止まるか）。
同じ層の中は、残す順の鍵（`symbol-sort-key`。小さい鍵の印から置かれる）で決める。宣言した軸（`domain/registry.py: PrimaryAttributeSpec.point_priority_axes`）が
あればその行の順（事故は死亡事故を先、その中で自転車の事故を先）、軸で決まらなければ束ねた点の数の多い印を先に残す（`scene/groups/points.ts: sortKeyExpression`）。
鍵が式なので、地図は層のタイルをまたいで鍵の順に置く（MapLibre の `src/style/pauseable_placement.ts` が、鍵が定数でない層のタイルの印をまとめて並べる）。
点は基礎地図の文字とも重なりを判定し、基礎地図より前面に積まれるので、点の印を残す。
2点以上を束ねた代表点には点の右へ数を出す（同じ印の文字なので、印が省かれれば数も出ない。数は押せない）。絵記号は点の先頭の軸の行の全部に、行ごとに違う絵で付ける——絵の無い行は描けず、一部の行だけ形が違うと、形が分類の意味を
持ってしまう（backendの`test_registry.py`が確かめる）。地図が行の値ごとに見本と同じ色・同じ絵記号の絵を引くことは
`scene/legends.test.ts`が確かめる。

**点の不透明度はレイヤーごとに源泉が宣言する**（一次属性の行の`point_opacity`、無ければ既定。`domain/map_display.py: POINT_OPACITY_BY_ATTR`。生成物`mapDisplay.point.opacityByLayer`）。
画面は自分の名前で引くだけで、点の種類の名前で分岐しない。点のレイヤーを足して宣言に無ければ、生成物の型で型検査が落ちる。

**重大度は円の大きさでも示すが、絞り込みの軸としても独立に持つ。** 大きさは「死亡事故だけを
残す」操作にはならない。当事者の軸とANDで効く。

路面ポップアップ（`features/map/MapView/roadFacts.ts`）の`smoothness`の値→表示名も
同じ考え方で、正本はbackendの`domain/material_catalog.py: MaterialSpec.value_labels`。生成物
（`material-catalog.json`）から引く（手書きで持つと、同じ値を地図のポップアップと
軸スタジオで別の呼び方をすることになる）。

道路名（OSMの`name`/`ref`）は**対訳表を持たない固有名詞**のため、この経路には乗らない。
テキストとして先頭行へ出す（`roadFacts.ts`が取り出し、`RoadInspectorPopup.tsx`がReactで描く。どの道かを決める情報で、路面・属性はその道の性質）。
片方だけ持つwayが多いため、両方あるときだけ1行へ畳む。

| レイヤー | ソース | 独立/共有 |
|---|---|---|
| 道路の線（例: 路面の種類・道路の種類・トンネル） | `ROAD_LINE_SOURCE_ID`（同じソースを分け合う） | 独立レイヤー（並列トラック対象） |
| 点（例: 停止要因POI・補給休憩POI・事故） | 自分の`tile_kind`が指す点のタイルのソース（`points.ts: POINT_TILE_SOURCES`。生成物`region-tile-config.json`の`region-tile-config.json: point_layers`から1タイルに1つ作り、source-layerも同じ一覧から引く） | 同じタイルを2つ以上のレイヤーが分け合うとき（例: 停止要因と補給）は、先頭の軸の値の集合で分ける（`baseFilter`）。1つしか読まないタイル（例: 事故）は独立 |

停止要因POIは**バックエンドで交差点単位にまとめられた点**が届く（[静的道路属性](../backend/static-road-attributes.md)）。
1つの交差点に立つ複数の信号ノードは1点で、位置は交差点の真ん中になる。届く`kind`は取込時の
値だが、横断歩道位置に立つ信号（`crossing`＋`crossing=*signals*`）は信号として届くため、
凡例の「横断歩道」に残るのは信号を伴わない横断歩道だけである。まとめる単位は凡例の行で、
凡例で同じ行に入る近くの点（車道用と歩道・自転車道用の踏切）は1点で届く。補給休憩POIは交差点ではまとめない。
どちらも、そのあとタイルの升目で凡例の行ごとに束ねて届く（上記）。

自販機は「飲料自販機」と「自販機(中身不明)」の2つに分かれて届く。前者は`vending`タグで
飲食物と分かるもの、後者はタグが無く判断できないもので、口に入らないものを売る機械は
そもそも配られない（[静的道路属性](../backend/static-road-attributes.md)）。2つを別の行に
分けるのは、同じ確からしさに見せないため。

補給休憩の説明文（`domain/map_display.py`の`panel_hint`）は、コンビニがOverture Mapsの地点のうちチェーンの店から、
ほかがOSMから出ることと、どれも閉店・撤去にデータが追いついていないことがあると書く。OSMの自販機・トイレ・給水・駐輪場は、
関東全域の抽出（2026-08）で5年以上編集されていないものが58〜59%あった（実地の確認日のタグ`check_date`・`survey:date`は
2〜11%にしか付かないので、最終編集日時で見た）。Overtureの地点は営業中かの情報をほぼ持たない。

点の色も上の「地図全体で共有する配色の読み方」に従う。事故の当事者区分のように評価へ寄与する
分類も、評価配色（緑〜赤）ではなく中立の色相で分ける。

各レイヤーの凡例の行は`scene/legends.ts`が宣言から出し、地図の絞り込み式は同じ宣言から
各グループ（`scene/groups/*.ts`）が組み立てる。同じタイルを分け合う点（停止要因・補給）は、
凡例で何も隠していない間も自分の種別だけを通す条件を常に持つ（`points.ts: baseFilter`）。
**凡例に出す行はどれも、チェックを外すとその行の地物だけが消える**（受け皿の「その他」「データなし」も含む）。
消せない行や隣の行まで巻き込む行があると凡例のチェックが地図と食い違うため、道の線と点の凡例の全行に対して
`scene/legends.test.ts`がMapLibreと同じ評価器で確かめる（評価軸の段は実行時のカタログから来るので、段の組み立てを
`view/lens.test.ts`と`groups/axisLines.test.ts`が見る）。
評価軸の線は地図の軸カタログの`dedicatedAxes`（実行時フェッチ、軸スタジオの公開軸を含む）
から関数的に組み立てる——ビルド時静的リストの手書き列挙ではない。

## 面で出せるもの・出せないもの

**面（空間フィールド）として出せるのは、道と無関係にその場所の値が決まるものだけ。**
気象（降水・風・気温）は道が無い所にも値があるため面になる。一方、勾配・路面・道路種別は
**道（way）そのものの属性**で、「道から独立した勾配の面」という概念が存在しない。
道の属性を無理に格子へ均すと、1つのセルに登りと下りが同居して0付近へ潰れ、
値があるのに何も無いように見える。

## 交差点密度は地図上の独立可視化レイヤーとして提供しない

交差点のノードは地図に出ない。点のタイルが焼き込むのは分類器が種別（`node_kinds.kind`）を
付けた点だけで、ただの交差点はどの種別にも当たらない（材料`intersection_count_per_km`としては軸スタジオから
引き続き選べるが、現在この材料を使う公開軸は無い）。

## ポップアップへOSMタグの生値を出すときはHTMLとして解釈させない

ポップアップの値はOSMの道・点のタグ由来＝**第三者が編集できるデータ**で、
対訳表に載らない値は生のまま出る（`roadFacts.ts: valueLabel`の`?? value`）。停止要因/補給POIの
`kind`はOSMの生値ではなくbackendの分類器が付ける内部名なので、対訳が無ければ生値ではなく
「不明」を出す（[design-principles.md](../../architecture/design-principles.md)UI仕様「内部名を画面に出さない」）。
小窓の中身はどれもReactで描き（`useMapPopups.tsx`がPopupの器へportalで差し込む）、**値をテキストとして入れる**。

**`Popup.setHTML()`は使わない**。MapLibreの`setHTML()`は受け取った文字列をサニタイズせず
そのまま`innerHTML`へ入れる（APIの文書に「信頼できる内容にだけ使うこと」と明記され、
実装も同じ）。ライブラリの`DOM.sanitize()`が走るのは帰属表示（`AttributionControl`）だけで、
ポップアップの安全はこちらが持つ。

判断の基準は**行き先ではなく出所**にする。固定の文言（対訳表・定数）だけで組む文字列なら
HTMLでもよい。第三者が書ける値——`?? 生値`の
フォールバック・OSMタグのキーと値・軸スタジオ経由でDBに入る軸ラベルと軸id——が1つでも
混ざるなら、HTML文字列を組まずにテキストノード（React・`textContent`・`createTextNode`）で
入れる。「この経路はサニタイザを通るから要らない」と経路ごとに判断すると、サニタイザを
通らない経路が後から増えたときにそこだけ素通しで残る。

## 本モジュールとの関係が薄いファイル

- `routeArrowIcon.ts`（周回ルートの順回り/逆回り矢印、選択中ルートにのみ描画）は
  「選択中ルート」に紐づく動的データを扱う。対象ファイル表に含まれているが、責務としては
  [ページ構成](page-composition.md)・[地図: 軸・ルート色分け](map-axis-coloring.md)に近い。
  区間クリック時の詳細表示（地点・到達予想時刻・軸別内訳）はボトムシート側
  （[ルート設定・結果パネル](route-settings-and-results.md)のRouteAxisProfile）が持ち、
  地図上は、押された区間を`features/map/MapView/mapTaps.ts: openRouteSegment`が選んだ区間として渡し、
  `useMapMarkers.tsx: applySelectedSegmentMarker`が地点の印を立て、`scene/groups/routes.ts`が区間の範囲を縁取るのみで
  テキストポップアップを持たない。押された区間から読み戻す`feature.properties`は、軸別内訳等の
  入れ子のオブジェクトもオブジェクトのまま届く（MapLibre v6は内部表現へ移すときに印付きのJSON文字列へ
  直し、読み戻すときに自分で戻す。`maplibre-gl/src/util/vectortile_to_geojson.ts`）ので、読む側で戻さない。
- アイコン集（`components/ui/icons/`）はこのモジュール（`MapOverlayControls`のアイコン辞書）専用ではなく、
  [動的気象レイヤー](dynamic-weather-layers.md)の`WeatherPanel`からも
  使われる、地図関連UI全体で共有するアイコン集である。天気・警告・操作のような意味の決まった
  汎用の形はlucide-reactの形を同じ呼び方（`size`だけ・既定16px）と同じ線の太さの比へ包んで書き出し、
  軸・レイヤー・区間の乗り換えのようなこのアプリ固有の概念の形だけを自前のSVGで持つ。組になって
  見分け方を決めている形（「戻す」と「全部戻す」、一括操作の「重なり＋×」と「漏斗＋×」等）は、
  片方だけをlucideへ替えると組の意匠が崩れるので、組ごと自前に置く。
