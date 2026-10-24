# ルート設定・結果パネル（frontend）

## 責務

一般ユーザー向けのルート生成条件入力（距離・重み・除外道路と、名前を付けて保存した地点・条件の呼び出し）と、生成結果の表示・比較
（軸別内訳・候補一覧）を担う。

**対象ファイル**

| ファイル | 責務 |
|---|---|
| `features/route/RouteForm/RouteForm.tsx` | 全長の目標（入り切りとルーラー）と候補数ステッパーを並べた1行（どの幅でも折り返さない）・地点（出発地・経由地・目的地）の置き場。「ルート設定」区分の各タブの中身を`Tabs.Content`として並べる（タブ列と選択状態は外、下記参照） |
| `features/route/RouteForm/SettingsTabsList.tsx` | 「ルート設定」のタブ列（条件・重み・除外・保存済み）。見出し行に置き、選ぶ状態は囲む`Tabs.Root`から読む |
| `features/route/RouteForm/RouteSettingsForm.tsx` | `RouteForm`へ、重み・除外・条件の保存・保存した条件の一覧の4つのタブの中身を、生成の条件と保存した条件から組んで渡す |
| `features/route/GenerateRouteActions/GenerateRouteActions.tsx` | 「ルート設定」の見出し行の右端: 条件が変わった印と「ルート生成」のボタン（下記参照） |
| `features/route/RouteForm/RoutePoints.tsx` | 左端の周回の切り替えと、地点の並び（`PointStrip.tsx`）と、その右の並びに出ている地点を全部消す操作。押した地点の詳しく（`PointDetail.tsx`）を地点の役割ごとに組んで下に出す（下記「地点の指定」） |
| `features/route/RouteForm/PointStrip.tsx` | 地点の並び（出発地 › 経由地の番号の丸・足す › 終点［周回の間は出発地、外せば目的地］）と、押した地点の選び。並びに名前が入りきるかを測って両端の札の名前を出し分ける（下記「地点の指定」） |
| `features/route/RouteForm/PointDetail.tsx` | 押した地点の詳しく: 呼び名・名前・出どころ・辺りと、住所や施設の名前を打つ欄（`PointSearch.tsx`）・消す／現在地に戻す・置いた地点の保存（どれもアイコンだけの形。下記「地点の指定」「保存した地点」） |
| `features/route/RouteForm/PointSearch.tsx` | 住所や施設の名前を打つ欄（候補は欄の下。狭い画面では欄を押してから選ぶ・閉じるまで、欄と候補を画面の上側に出す。欄を押すと保存した地点も出す）と、地図で置く間の欄の案内（下記「住所・施設で探す」「保存した地点」） |
| `components/PinMark/PointMark.tsx` | 並びの札・詳しく・地図の点の小窓の置く操作に出す、地図のピンと同じ図形の丸（`components/PinMark/PinMark.tsx`の中身に背景色を付けたもの。ルートの機能と地図の機能の両方が描くので共有の層に置く） |
| `features/route/RouteForm/useRouteFormSubmit.ts` | 上記の検証（`{error, check}`。`features/route/RouteForm/useRouteFormSubmit.ts: check`は通ったかを返す）。「ルート生成」ボタン自体は`RouteForm`の外（`GenerateRouteActions.tsx`。見出し行）にあるため分離している（下記参照） |
| `features/route/RouteSettingsPanel/RouteSettingsPanel.tsx` | 一般向け軸重み設定（「重み」タブの中身。地図の色分けはここになく`LensControl`のみが持つ、下記参照） |
| `features/route/RouteSettingsPanel/HardFilterPanel.tsx` | 「除外」タブの中身。地図の道のレイヤの凡例の行ごとの避け方を1つの並びに出し、自転車が通れない道の行は「通らない」に固定して鍵を付ける（下記「除外」）。選べる行の鍵・名前・既定の段と行をまとめる節は軸カタログの`road_classes.avoidance`が、固定の行の名前と説明は生成物`route-generate-config.json`の`route-generate-config.json: hard_filters`が正で、名前をフロントに持たない——キーと名前を別々に持つと、足した行に名前が無く内部名が出る。軸カタログが届くまでは選べる行を出さない |
| `features/route/roadAvoidance.ts` | 保存した避け方のうち段として読める鍵を残し（`features/route/roadAvoidance.ts: readRoadAvoidance`。今の行に無い鍵も前の鍵として読まれうるので残す）、画面に出す行の段を決める（`features/route/roadAvoidance.ts: avoidanceLevelOf`）。今の鍵の段が無ければ前の鍵（行の`former_keys`）の段のうち強い方を、どちらも無ければ既定の段を取る。経路の段はbackendが要求を今の行へ揃えて決めるので、画面の段がそれと食い違わないことを生成物`road-avoidance-expectations.json`の表で確かめる（`roadAvoidance.test.ts`）。要求には選んだ段をそのまま送り、行の増減はbackendが揃える。保存値は軸カタログが届いたら今の行の鍵へ書き直す（`features/route/roadAvoidance.ts: withCurrentRoadKeys`。前の鍵に選んだ段を画面に出す段のまま今の鍵へ移し、前の鍵を落とす。前の鍵を外したあとも、その間に開いた端末で段が残る） |
| `features/route/SavedPlacesPanel/SavedPlacesPanel.tsx` | 「保存済み」タブの「地点」の中身: 保存した地点の一覧（行は名前・辺りと、アイコンの「呼び出す」「消す」。呼び出すはメニューで出発地・経由地・目的地のどれに置くかを選び（周回の間は目的地を使わないので「目的地にする」を押せない）、消すは確認の窓で「消す」を押すと消す）。無ければ無いと出し、保存の仕方は(i)の奥（下記「保存した地点」） |
| `features/route/SavedList/SavedList.tsx` | 「保存済み」タブの一覧（地点・プリセット）の形: 空の案内と保存の仕方の(i)・行の枠・消す操作と確認の窓。行の名前の欄と行ごとの操作（「呼び出す」）は使う側が渡す |
| `features/route/useSavedPlaces.ts` | 保存した地点の一覧（この端末の`localStorage`）と、保存・削除 |
| `features/route/savedPlaces.ts` | 保存した地点の形（探した候補と同じ形）と、保存値の読み方（今の画面が受け付けない件だけを捨てる）・同じ名前と同じ位置の置き換え・打った文字での絞り込み |
| `features/route/SavedConditionsPanel/SavedConditionsPanel.tsx` | 「条件」タブの1行目に置くアイコンの「いまの設定を保存」（`features/route/SavedConditionsPanel/SavedConditionsPanel.tsx: SaveConditionsButton`。窓に保存する条件・出発地の扱いの切り替え・重み・除外と、名前の欄・保存のボタン）と、「保存済み」タブの「プリセット」の中身の保存した設定の一覧（行は名前と、アイコンの「呼び出す」「消す」。呼び出すは窓で中身を見せて「反映する」で呼び出し、消すは確認の窓で「消す」を押すと消す。無ければ無いと出し、保存の仕方は(i)の奥。下記「保存した条件」） |
| `features/route/useSavedConditions.ts` | 保存した条件の一覧（この端末の`localStorage`）と、いまの条件（`useGenerationConditions.ts: snapshot`）の保存（出発地を固定するかを受け取る）・呼び出し・削除。呼び出すと`useGenerationConditions.ts: restore`で条件を入れ替え、出発地は位置の持ち主（`hooks/useLocation.ts`）へ渡す。軸カタログが届いたら、各件の避け方を今の行の鍵へ書き直して書き戻す（`features/route/savedConditions.ts: savedWithCurrentRoadKeys`） |
| `features/route/savedConditions.ts` | 生成の条件の形（`features/route/savedConditions.ts: GenerationConditionsSnapshot`。いまの条件・保存・呼び出しが同じ形を使い、保存の1件はそれに名前と出発地を足す）と、保存値の読み方（項目ごとの読み方の表で読み、今の画面が受け付けない件だけを捨てる）・仮の名前・何が保存されるかの説明（`features/route/savedConditions.ts: describeConditions`。重みは軸ごとの割合）・同じ名前の上書き。距離・候補数として受け付ける範囲（`features/route/savedConditions.ts: acceptedDistanceInput`・`features/route/savedConditions.ts: acceptedMaxRoutesInput`）もここが持ち、`useGenerationConditions.ts`の保存値の読み直しと共有する。距離の刻み（`DISTANCE_STEP_KM`。5km刻みで、下限も1刻み分）は画面だけの値で、`RouteForm`のルーラーのコマも読み、保存値は刻みの近い方へ寄せて読む。候補数の下限・上限は生成物`route-generate-config.json`から読む |
| `features/route/routeWeightShare.ts` | 重み配分の純関数（帯グラフの境界ドラッグ`features/route/routeWeightShare.ts: clampBoundaryDrag`・合計の1%の刻み`features/route/routeWeightShare.ts: weightStep`と下限） |
| `lib/cardinalLabel.ts` | 角度を方位の呼び名へ（区間の風・天気欄等が使う）と、気象の風向（吹いてくる向き）を矢印が指す吹いていく向きへ（`lib/cardinalLabel.ts: downwindDeg`。区間の風の矢印が使う）と、それを回った地図の上の向きへ（`lib/cardinalLabel.ts: downwindOnMapDeg`。走りの帯と天気欄の矢印が使う）。呼び名の並びはbackend（`domain/geo.py: COMPASS_LABELS`）が配り、丸めは画面が持つ。区分の境界を含む角度でbackendと同じ呼び名になることは、backendが出す表（生成物`geo-expectations.json`）をテストが通して確かめる |
| `features/route/RouteAxisProfile/RouteAxisProfile.tsx` | 候補ごとのタブの中身（公開軸すべての軸別難易度一覧＋「重み付き寄与度」内訳）。地図の色分けを選ぶ操作はここには無い（`LensControl`）。候補一覧のタブ自体は`RouteOutcome.tsx`が組み立てる |
| `features/route/routeTabLabel.ts` | 候補タブの時間の列の基準線と差を組み立てる純関数（`features/route/routeTabLabel.ts: durationBaseline`・`features/route/routeTabLabel.ts: durationDifferenceLabel`）、生成した候補の並び（最速の印の1本が先頭、残りは所要時間の短い順、`features/route/routeTabLabel.ts: orderGenerated`）、一覧の並び・群・名前（`features/route/routeTabLabel.ts: routeListEntries`。最速ルート・生成した候補・合成ルートの分け方は[ページ全体構成・状態管理](page-composition.md)「ルート結果の中身」）。種類と最速の印はbackendが付ける値（`route_generator.py: _label`）を読むだけで、idの文字列や要求の形から決め直さない。タブ列自体は`RouteOutcome.tsx`が組み立てる |
| `features/route/routeEditDiff.ts` | 編集で作ったルートの元との差（距離・所要・総合難易度・負荷と、変えた区間の元の位置・長さの差）と、差の表記（`features/route/routeEditDiff.ts: formatDelta`）。指標は1つの表から作り（`features/route/routeEditDiff.ts: metricDifferences`。名前・桁・単位と元・編集後・差）、編集面（`RouteSplicePanel`）と「元との違い」（`features/route/routeEditDiff.ts: EditDifference`）が同じ表を読む——別々に持つと、片方だけ指標や桁が変わる。変えた区間は適用した乗り換えの手順からではなく、できた2本のEdge id列の差（`routeSplice.ts: pairedStretches`）から求める——乗り換えの範囲は適用した時点の経路に対する位置で、元の位置へ戻すには手順の全部が要る。区間の位置と長さは、道のりのグラフと同じ物差し（`lib/routeDistance.ts: routeEdgeKms`）で読む |
| `features/route/EditDifference/EditDifference.tsx` | 編集で作ったルートの中身の先頭に出す「元との違い」。元の名前と距離・変えた区間の数（元と編集後で区間を対応づけられなければ、数と区間の並びを出さずに「変えた区間を対応づけられない」と言う——「0区間」と出すと変えていないように読める）、指標の差、変えた区間ごとの長さの差を並べ、アイコンの「元を見る」で元のルートへ切り替える |
| `features/route/gpxExport.ts` | 候補1本をGPXとして書き出す（`features/route/gpxExport.ts: downloadGpx`。押す口は`RouteCandidateActions`の「GPX出力」）。点数を上限（`features/route/gpxExport.ts: MAX_GPX_TRACK_POINTS`）へ収めるとき、残す点を折れ線の形から選ぶ（下記「GPX書き出しの間引き」） |
| `features/route/RouteAxisProfile/axisRawValue.ts` | 軸の生値（折れ点を通す前）を単位付きの表示文へ整える純関数（`features/route/RouteAxisProfile/axisRawValue.ts: formatAxisRawValue`）。走行距離を掛けた総量を添えるのは、軸カタログが`raw_value_units.total_unit`を返した軸だけ——総量が読み手の判断を変えるかの判断はbackendが持ち、フロントは単位の綴りから決めない。単位が定まらない軸の内訳1件を整える`features/route/RouteAxisProfile/axisRawValue.ts: formatMaterialBreakdown`（numeric/boolean）・`features/route/RouteAxisProfile/axisRawValue.ts: formatCategoryBreakdown`（categorical、最も延長の長い値）も持つ |
| `components/AxisContributionBar/AxisContributionBar.tsx` | 「重み付き寄与度」内訳の表示部品（積み上げ1本バー＋凡例）。ルート全体の内訳（RouteAxisProfile）・区間の詳細（地図の小窓の`SegmentDetail.tsx`と、道のりのグラフの地点の詳しく`ProfilePointDetail.tsx`）・道の詳細（`RoadInspectorPopup.tsx`）が共用する |
| `components/AxisContributionBar/AxisDetail.tsx` | 内訳のチップを押して開く軸の詳細の形（名前・軸別難易度［値が無ければ「データなし」］・説明）。ルート全体の内訳（`RouteAxisProfile`。生値・材料の内訳を間へ足す）・区間の詳細（`SegmentDetail.tsx`・`ProfilePointDetail.tsx`）・道の詳細（`RoadInspectorPopup.tsx`）が同じこの形で出す |
| `components/PinMark/PinMark.tsx` | 地点（出発地・経由地・目的地）の印の中身と背景色。行頭の印と地図のピンが共用する（下記「地点の指定」） |
| `features/map/MapView/useMapMarkers.tsx` | 地図の地点の印（出発地・経由地・目的地）と選んでいる区間の印の作成・位置の更新・ドラッグ・後始末を1か所に持つフック。`MapView`は地図を作ったあとに呼ぶだけ（下記「地点の指定」「区間クリック詳細」） |
| `features/route/PlaceSearch/usePlaceLookup.ts` | 住所・施設の名前を打つ欄の中身と引き方（打ちかけで間を置いて引く・変換中は引かない・引いたときの地図の真ん中を添える）。地点の打つ欄（`RouteForm/PointSearch.tsx`）が使う（下記「住所・施設で探す」） |
| `features/route/PlaceSearch/PlaceCandidates.tsx` | 引いた候補の一覧（表示名・施設の辺り・引いたときの地図の真ん中からの直線距離・種類・当たった段）と、引いている間・引けない・当たらないときの文。候補を押したときの形は使う側（地点の詳しく）が持つ。置いた地点が当たった範囲の代表の位置にすぎないか（`features/route/PlaceSearch/PlaceCandidates.tsx: isRepresentative`）もここが決める |
| `features/route/placeSearchApi.ts` | 地点の検索の口（`GET /api/place-search`）と置いた位置の辺りの口（`GET /api/place-area`）を叩く薄いラッパー（[地点の検索（backend）](../backend/place-search.md)） |
| `hooks/useAxisCatalog.ts` | `GET /api/axis-catalog`の取得。機能をまたいで読むカタログ（軸一覧・既定重み・軸ラベル・識別色・較正値）を`hooks/useAxisCatalog.ts: useAxisCatalog`が返す。1つの機能だけが読む形は、その機能が同じ取得の応答から`hooks/useAxisCatalog.ts: useAxisCatalogSelect`で導く（地図の表示の軸・タイルの世代は[地図: 静的レイヤー・道路表示](static-map-layers.md)の`features/map/useMapAxisCatalog.ts`）——共有のカタログへ相乗りさせると、読み手が1機能だけの知識を共有の層が運ぶ |
| `lib/axisCatalog.ts` | 上記フックが返すカタログを、応答から導く純関数（`lib/axisCatalog.ts: axisCatalogFromResponse`）と、画面が読む較正値（`lib/axisCatalog.ts: CLIENT_TUNING_IDS`・`lib/axisCatalog.ts: clientTuningValue`。並べるidは生成物`route-generate-config.json`に在るものだけを型が通す）。フックが持つのは「いつ取りに行き、誰と共有するか」だけ |
| `services/axisCatalogApi.ts` | 上記フックが叩くbackend APIの薄いラッパー |
| `lib/catalogAxis.ts` | 軸カタログの1行を画面が読む形へ移す型（`lib/catalogAxis.ts: CatalogAxis`）と唯一の変換（`lib/catalogAxis.ts: catalogAxisFromEntry`）。重み一覧の1行はこの型そのもので、地図が塗る軸・地図のチップの軸はこれに用途の項目を足した型。文へ評価の名前を差し込む形（「A」「B」。`lib/catalogAxis.ts: axisNamesInText`・走る条件で値の変わる軸に絞る`lib/catalogAxis.ts: axisNamesUsing`）もここが持つ |
| `features/route/RouteProfile/RouteProfile.tsx` | 候補の中身の先頭と走行中の地図の下に出す道のりのグラフ。「評価で塗る」（既定）と「表示」のタブを持つ（名前は地図の2つの入口と同じ`lib/screenNames.ts`から引き、絵も地図の「表示」のボタンと「評価で塗る」のピルと同じ`DisplayItemsIcon`・`EvaluationPaintIcon`を付ける。出す情報のボタンは`ChooseItemsIcon`）。タブの切り替えは、結果も走行中も文字の無い小さい絵だけにし（名前は読み上げに残す）、(i)・出す情報のボタンと並べて図の右上に重ねる。距離の目盛り（0・全長）は図の中の下の角に重ね、図の上下に段を取らない（スマホの低い高さで図を大きく見せる。図の左上は値の目盛りに空けておく）。走りながら遠目に読むので、走行中は距離の目盛り・図の下の文字を結果の図より大きくし（`features/route/ProfileChart/profileScale.ts: profileTextClass`）、「表示」の図には最初の折れ線の最高と最低の高さに単位つきの目盛り（「標高 32m」「12m」）を出す。結果も走行中もなぞって地点を選び（地図に印が出る）、地点を選んでいる間は、その地点の詳しく（`features/route/RouteProfile/ProfilePointDetail.tsx`）を図の下に出す。「評価で塗る」は難易度のグラフ（`DifficultyProfile`）で、(i) はこのルートで塗った区間のある軸の色と名前・値の無い区間の色・グラフの意味を出す。「表示」は、チップで選んだ情報（地図の「表示」とは別の選択）を同じ横軸に重ねた図（`features/route/RouteProfile/LayerProfile.tsx`）で、地点の選び方は「評価で塗る」と同じ。どちらのタブも、置いた経由地を通る距離（応答の`waypoint_distances_km`）に縦の線と地図のピンと同じ番号の印を出す |
| `features/route/RouteProfile/LayerProfile.tsx` | 道のりのグラフの「表示」の図。選んだ情報を同じ横軸に重ね、各情報の最高・最低を1行で図の下に出す（結果では地点を選んでいる間も地点の詳しくの上に残す。走行中は図の中の目盛りが最高・最低を持つので、地点を選んでいる間は詳しくだけを出す）。道の区分の情報（道路の種類・路面の種類・トンネル・緑と水等）は折れ線の下に1本ずつ帯で並べる。現在地の印は最初の折れ線のその地点の値の高さに置く |
| `features/route/RouteProfile/ProfileLayerPicker.tsx` | 「表示」の図に重ねる情報を選ぶ一覧（図の右上の出す情報のボタンから開く）。ボタンに今重ねている数を出し、帯の情報の行には、帯に現れた行の凡例を添える |
| `features/route/RouteProfile/ProfilePointDetail.tsx` | 道のりのグラフで選んだ地点の詳しく。結果も走行中も同じ3行で出す（下記「区間クリック詳細」）。1行目は折れ線の値とその道の勾配・何km地点・到達予想・閉じる（「勾配」「km地点」「到達予想」の語は絵に替え、読み上げに残す）。2行目はチップの列で、その地点で当たる道の区分（グラフに出す情報の選択によらない。どの分類にも入らない行〔`lib/mapDisplay/roadTracks.ts: isUnclassifiedRow`〕は出さない）を、地図の「表示」と同じアイコン・行の凡例の色の印・行の名前で出し、風のチップ（`SegmentWindChip`）を並べる。チップの地は画面の色のままにし、凡例の色は印で示す（凡例の色は明るいものも暗いものもあり、地に塗ると文字の色を色ごとに選ぶことになる）。チップは押せる風のチップに合わせて押す所の下限（24px）の高さを持つ。3行目は区間の総合難易度と、寄与の帯・軸ごとの寄与の小さい並び（`AxisContributionBar`の`inline`。押すと`AxisDetail`）。近くの施設は出さない（走っていて図の下が縦に長くなる。探すのは地図の区間の小窓）。地図で押した区間は、地図が自分の地物から組み直した区間で図の区間と同じものでないので、図は区間の始まりの距離で区間を探し（`lib/routeDistance.ts: findSameSegment`）、押した所を区間の道なりの形に当てた地点に線を引いて、その地点の詳しくを出す。図に無い区間の選択だけは、標高と区分のチップを出さない |
| `features/route/RouteProfile/profileLayers.ts` | 道のりのグラフに重ねられるレイヤの宣言（`features/route/RouteProfile/profileLayers.ts: profileLayers`）。レイヤごとに名前・描き方・区間の応答から値を引く所を1か所に持ち、レイヤを足すときはここへ1行足す。描き方は2つで、折れ線は区間の中の道ごとの両端の値（応答の`features/route/RouteProfile/profileLayers.ts: elevations`）を、道の距離の比で区間の長さへ割り振ってつなぎ、値の無い道・道の無い区間で線を切る。地点の勾配は、その地点の道の両端の差を道の長さで割る（`features/route/RouteProfile/profileLayers.ts: layerGradeAtKm`）。帯は区間の中の区分の値（応答の`features/route/RouteProfile/profileLayers.ts: road_classes`）を距離の比で並べ、隣どうしで同じ行になる部分をつなぐ。帯にできるのは軸カタログが配る道の線の層（`features/route/RouteProfile/profileLayers.ts: profileLayers`が受け取る）と「緑と水」で、行の色・呼び名・「該当なし」「データなし」の分け方は地図の凡例と同じ行（`lib/mapDisplay/roadTracks.ts: roadTrackRows`）から引き、アイコンは地図の「表示」の一覧と同じ引き方（`components/ui/icons/mapLayerIcons.ts: roadLayerIcon`・`mapLayerIcons.ts: MAP_LAYER_ICONS`）で引く。 |
| `features/route/RouteProfile/useProfileLayers.ts` | グラフに出す情報（コードの名前はレイヤ）の選択。端末に覚え（既定は標高）、宣言から消えたレイヤは読むときに捨てる。ページが1つ持ち、結果と走行中の図が同じ選択を読む |
| `features/route/ProfileChart/ProfileChart.tsx` | 道のりのグラフの枠（横軸の尺・横になぞる・押して地点を選ぶ・走行中の現在地・経由地の線と番号の印）。難易度のグラフとレイヤのグラフが中身だけを差し込む。押せる図は縦のなぞりをシート・パネルのスクロールへ渡し（`touch-action: pan-y`）、縦に動き出した操作では地点を選ばない。走行中は、現在地の距離に縦の線（折れ線の青と見分ける文字の色）と地図の現在地と同じ青の丸い印（高さは中身が渡す）を出し、走り終えた所は中身の色を抜いて地図の走り終えた線と同じ濃さへ薄め、残りは元の色のまま描く。走り終えた経由地の線と番号の印も同じ濃さまで薄める。中身が渡す値の目盛り（`features/route/ProfileChart/ProfileChart.tsx: valueTicks`）を図の左の端に重ねる。高さは置き場が CSS の変数`--profile-chart-height`で決め、無ければ走行中の地図の下に出す図の高さになる |
| `features/route/ProfileChart/profileScale.ts` | 道のりのグラフの横軸の尺（`features/route/ProfileChart/profileScale.ts: useProfileScale`。右端は渡された距離とルートの長さの長い方）と描画の座標の大きさ、図の文字の大きさ（`features/route/ProfileChart/profileScale.ts: profileTextClass`）。枠と中身の両方が読む |
| `features/route/ProfileChart/useProfileGesture.ts` | 道のりのグラフの上で地点を選ぶ指（マウス）の操作。1本の指で横になぞるか押して離したときだけ選び、押しただけ・2本目の指が加わった操作（図の外に触れた指も、画面全体の指を窓の捕捉の段で数えて含める）・縦に動き出した操作では選ばない |
| `features/route/ProfileChart/ProfileMarks.tsx` | 道のりのグラフの上に重ねる印と文字（経由地の番号・現在地の丸・値の目盛り・距離の目盛り）。図の絵は横へ伸ばして描くので、形の崩れる印と文字は図の上に重ねた要素で出す |
| `features/route/DifficultyProfile/DifficultyProfile.tsx`・`profileGeometry.ts` | 道のりのグラフの「評価で塗る」に出す、道のりに沿った難易度のグラフ。横が始点からの距離、縦が区間ごとの難易度で、区間ごとの階段を軸の寄与で色分けして下から積む。区間はbackendがEdgeを約500mのビンへ畳んだもの（`aggregate_segments_into_bins`）で、Edge 1本ずつではない。**塗った面積がルートの負荷にほぼ一致する**——値の無い区間はルートの総合難易度の高さで灰色に描く（負荷は「値のある区間の距離加重平均×全長」で、値の無い区間を平均として数えるため）。ほぼなのは、ビンの中で値の無いEdgeがそのビンの平均で数えられるためと、1kmあたりの回数で測る評価軸はルート全体の回数の平均から点数にし直すため（backend: `domain/route.py: merge_difficulty`）。横軸の右端は**一覧の中で最も長い候補の距離**で、候補どうしで面積を見比べられる。押したまま動かす（キーボードは矢印・Home・End）と、その距離の区間と、区間の道なりの形の上で距離の割合ぶん進んだ地点を選ぶ——選択は地図で区間を押したときと同じ`selectedRouteSegment`で、地図に地点の印と区間の縁取りが出て下に区間の詳細が出る。グラフ自体は区間を選んでいる間も残る。選ぶ受け口を渡さなければ、押せない見るだけの図になる。走行モードでは現在地の距離を受け取り、枠へ渡す（距離の決め方はpage-composition.md「走行モード」）。現在地の印はその距離の柱の上端に置く |
| `features/route/ErrorText/ErrorText.tsx` | 操作した箇所の直下に出すエラー文言（`role=alert`）。ルート結果と区間の乗り換えの面が使う |
| `features/route/WarningText/WarningText.tsx` | 表示中の結果について注意を促す1行（条件のずれ・目的地の補正・所要時間の前提の崩れ）。ルート結果と候補の中身が使う |
| `features/route/GenerationNotice/GenerationNotice.tsx` | 押した「生成」が候補を出せなかった理由（入力の誤りか失敗・候補0件の理由）を知らせる窓。`app/page.tsx`がデスクトップとモバイルの両方に1つ置き、閉じると案内を消す |
| `features/route/routePreferenceSync.ts` | 重みのキー集合を軸カタログの公開軸へ揃える関数（`useGenerationConditions.ts`が読むときに1回だけ通す）と、生成リクエストへ重みを載せるかの判定 |
| `features/route/SegmentDetail/SegmentDetail.tsx` | 押した区間の中身（地点・到達予想・風・総合難易度・軸ごとの内訳・近くの施設）。パネルを閉じているときの地図の小窓が出す（閉じる操作は小窓が持つ）。総合難易度の出し方（`features/route/SegmentDetail/SegmentDetail.tsx: SegmentDifficulty`。全部0のときの文を含む）と到達予想の書き方（`features/route/SegmentDetail/SegmentDetail.tsx: formatSegmentArrivalTime`）は、道のりのグラフの地点の詳しくも使う（下記「区間クリック詳細」） |
| `features/route/pointNames.ts` | 地点の名前（探して置いた候補の名前・「地図で選んだ地点」・「現在地」・「未設定」）。地点の並びと、地図のピンを押したときの小窓が同じ名前を出す（下記「地点の指定」） |
| `features/route/SegmentSidePoints/SegmentSidePoints.tsx`・`sidePointGroups.ts` | 選んだ区間の近くの施設（下記「区間クリック詳細」の「近くの施設」）。まだ探していなければ「探す」を出し、引いたら点は地図に描き、ここは種類ごとの件数のチップを並べ、押すとその種類を地図に出す・消す。種類の並び・呼び名は地図の「表示」の点のレイヤの順と宣言（`lib/mapDisplay/pointLayers.ts: POINT_LAYERS`）から引き、地図に描けない点（先頭の軸の区分に当たらない値）は数えない（`sidePointGroups.ts`） |
| `features/route/SegmentWind/SegmentWind.tsx` | 区間の評価に使った風。地図の小窓には使った時刻・風向風速・延長の印・(i)の1行（`features/route/SegmentWind/SegmentWind.tsx: SegmentWind`）、道のりのグラフの地点の詳しくには風が吹いていく向きの矢印と風向風速のチップ（`features/route/SegmentWind/SegmentWind.tsx: SegmentWindChip`。押すと使った時刻・延長の印・説明を開く）を出し、時刻の書き方と説明の文は両方で1つを使う（下記「区間クリック詳細」） |
| `features/route/RouteSplicePanel/RouteSplicePanel.tsx` | 区間の乗り換えの結果面（「ルート結果」が編集モードのときの中身）。**選ぶのは地図、パネルは結果だけ**——地図の破線が「いまの道から乗り換えられる先」・太い実線が「いま作っているルート」で、タップすると乗り換わり、その先の分かれ道が次の破線になる（次に選べる区間は`features/route/routeSplice.ts: buildSplicedShape`が組む「いまの組み合わせ」との差として求めるため、乗り換え先の道の上の分岐もそのまま現れる。候補どうしが同じ地点を通るかはbackendが返すNode id［`node_ids`］で判定し、**当てると一度通った地点へ戻る代替は選択肢に出さない**——backendは連結性しか見ず、折り返しも走れはするため落とさない）。パネルは元と編集後の指標の表（`SpliceMetricGrid.tsx`）と、軸別の寄与度の差の棒（`SpliceDeltaBar.tsx`）を出す。棒に出すのは差が下限に届いた軸だけで、差の大きい順に並べる。戻すのは見出し行の「1つ戻す」「全部戻す」で、巻き戻せるのは直前の1手ずつ（適用済みの範囲はその時点の経路に対する位置のため、途中だけは外せない）。評価した組み合わせが既にある候補と同じ道なら、その候補の一覧での名前で同じ道だと出し、見出し行の作成を外してその行に「「◯」に切り替える」を置く（押しても新しく足さずにその候補を選ぶので、押す前にそれと分かるようにする。押すと作成と同じく編集を閉じてその候補を選ぶ）。差分を見たのにどの軸の差も棒に出す下限に届かなければ、「差分を見る」を押す案内を残さず、どの軸もほぼ変わらないと出す（押しても何も変わらない案内にしない）。`edge_ids`が空の候補では「差が無い」と「そもそも出せない」を区別して伝える。使い方は画面へ書かず見出し脇の(i)の奥に置き、見出し行の操作（1つ戻す・全部戻す・差分を見る・作成）はパネルの他の操作と同じアイコンだけの形 |
| `features/route/RouteSplicePanel/SpliceMetricGrid.tsx` | 編集面の指標の表。ルート結果と同じ指標（`features/route/routeEditDiff.ts: metricDifferences`。距離・所要・総合難易度・負荷）で元と編集後を**2列×2行**に並べる（1セルに「元→編集後 差」を収め、列見出しを持たない） |
| `features/route/RouteSplicePanel/SpliceDeltaBar.tsx` | 編集面の軸別の寄与度の差（`features/route/RouteSplicePanel/SpliceDeltaBar.tsx: AxisDelta`）。軸別は2本並べず**差だけの1本**（中央が0・左が楽になった側・長さが変化量・色は軸チップと同じ） |
| `features/route/useSegmentSidePoints.ts` | 選んだ区間の近くの施設を引くフック。選んでいる候補の同じ区間（`lib/routeDistance.ts: findSameSegment`）の`edge_start`〜`edge_end`の`edge_ids`と始まりの道のりを`POST /api/routes/side-points`（`features/route/routeApi.ts: getRouteSidePoints`）へ送り、読み込み中・失敗・種類ごとの点と、地図から消した種類・地図に出す点を返す。探す口を呼ぶまでは引かず（最後に探した区間を覚え、同じ区間の中で地点を選び直しても引いた点を出し続ける）、区間を選び直すたびに消した種類を全部出し直す。同じ区間の答えは取っておき、選び直しても引き直さない |
| `features/route/useRouteResults.ts` | 「ルート結果」の状態: 生成した候補・編集で作ったルート（作った順の番号と元にしたルートのid）・選んだ候補・地図で押した区間・生成に使われた重み。生成の結果で入れ替えると先頭を選び、編集で作ったルート・押した区間を外す。編集で作ったルートは元を上書きせず別の1本として足して選ぶ（編集で作ったルートをさらに編集したものも、元はその編集）。そのidは作った順の番号で画面が振る（backendは合成のルートへ毎回同じidを返すため、同じ生成へ何本も足すと重なる）。タブを選び替えると押した区間を外す。乗り換えで作った経路が既にある候補と同じ道だったときは、その候補を「同じ道だったので選んだ」と分かる形で選ぶ（`features/route/useRouteResults.ts: reusedRouteId`）——選択と1つの状態に持ち、どの操作で選び直しても外れる |
| `features/route/RouteOutcome/RouteOutcome.tsx` | 「ルート結果」の中身: 生成前・生成中・候補0件・失敗の案内、候補の一覧（横に並ぶカード。群の印と区切りの線・名前・距離・時間・総合難易度と、総合難易度を地図と同じ段の色で塗る下端の帯）、選んだ候補の中身（道のりのグラフ［シートが開いたときに合わせる高さの下端の印を持つ］・編集で作ったルートなら`EditDifference`・`RouteAxisProfile.tsx: RouteAxisProfile`）と地図で押した区間の詳細、編集中は`RouteSplicePanel.tsx: RouteSplicePanel`（[ページ全体構成・状態管理](page-composition.md)「ルート結果の中身」）。乗り換えで作った経路が既にある候補と同じ道で、その候補を選んだときは、一覧の上にそのことを候補の名前で出す。選んだカードは、一覧の横だけを送って見える範囲へ出す |
| `features/route/RouteCandidateActions/RouteCandidateActions.tsx` | 選んでいる候補1本への操作（「このルートで走る」［その候補で走行モードを始める。走っている間は出さない］・合成［始められるときだけ。押すと区間の選択を外す］・GPX出力。どれもアイコンだけのボタン）。`RouteOutcomeHeaderActions.tsx`が全消去の手前に置き、編集の間は出さない |
| `features/route/RouteOutcome/RouteOutcomeHeaderActions.tsx` | 「ルート結果」の見出しの行の操作: 選んでいる候補1本への操作と、全消去（確認の窓で「消す」を押したときだけ消す） |
| `features/route/useGenerationConditions.ts` | 生成の条件（「ルート設定」の入力）: 周回か・全長の目標を決めるか・距離・候補数・経由地と目的地（周回の間は置いた目的地を覚えておくだけで、返す`features/route/useGenerationConditions.ts: destination`はnull。判断は`savedConditions.ts: destinationInUse`）・地図のタップで置ける役割・住所の検索と地図の点の小窓で選んだ地点の置き方（`features/route/useGenerationConditions.ts: placeFound`）・重み・除外・道の行ごとの避け方と、保存した条件での入れ替え（`features/route/useGenerationConditions.ts: restore`）。いまの条件を保存と同じ形1つ（`features/route/useGenerationConditions.ts: snapshot`）で返し、保存・生成の入力はそれを読む。入れ替えは項目ごとの入れ方の表で書き、形に項目を足すと、いまの条件・保存値の読み方・入れ方のどれが欠けても型の誤りになる。保存する値は読むときに今の画面が受け付ける範囲・今の項目へ揃え、重みは軸カタログの公開軸へ揃えた値だけを返す（下記「RouteSettingsPanel.tsx」）。道の避け方の保存値は、軸カタログが届いたら今の行の鍵へ書き直して書き戻す。出発地は位置の取得と同じ持ち主（`hooks/useLocation.ts`）が持ち、地図で置いた出発地は呼び出し側へ渡す |
| `features/route/useRouteGeneration.ts` | ルート生成: 検証と送信（`features/route/useRouteGeneration.ts: useRouteFormSubmit`）・実行中の進み方・直近の案内（候補0件の理由・失敗の文言）・表示中の候補を作った条件といまのフォームのずれ（`features/route/useRouteGeneration.ts: conditionsDirty`）。生成の入力は生成と「条件が変わったか」の判定が同じ関数で組み立て、目的地が補正されたら補正後の地点で組み直す。補正後の地点で目的地のピンを書き換えるのは、生成を待つ間に目的地を置き直していないときだけ。候補の一覧と選択は持たず、結果を`features/route/useRouteGeneration.ts: onGenerated`で呼び出し側へ渡す。押した「生成」1回ごとに結果の種類（新しい結果か失敗か）を`features/route/useRouteGeneration.ts: onOutcome`で1度だけ知らせる——候補が出たときも、候補0件・失敗・入力の誤りと同じく知らせる |
| `features/route/useRoutePlanner.ts` | ルートを作る機能の入口。結果・生成・区間の乗り換えをつなぐ: 生成と乗り換えが作った候補を結果へ入れ、全消去は結果と生成を一緒に消し（乗り換えの編集は生成に結びつくので一緒に終わる）、乗り換えで作り始めると直前の生成の失敗の文言を消す。生成と乗り換えの結果は1本の`features/route/useRoutePlanner.ts: onOutcome`で呼び出し側へ知らせる。軸を「未使用」と分ける重み（`features/route/useRoutePlanner.ts: routeWeights`。生成に使われた重み、生成前は今の設定の重み）も1か所でここが決め、地図のレンズの選択肢と候補の中身が同じ値を読む。地図に描くルート（`features/route/useRoutePlanner.ts: mapRoutes`。編集で作ったルートを選んでいる間は元と2本だけ）もここが決める |
| `features/route/useSpliceSession.ts` | 区間の乗り換えの編集1回ぶんの状態（編集の元の候補・適用した乗り換え・評価結果の控え・処理状態）と操作。**抜けると中身ごと消え、次の編集へ持ち込まない**。編集は始めたときの生成に結びつき、作り直す・消すと効かなくなる（候補のidは作り直しでも同じ値が振られうる）。組み合わせた経路は**表示中の候補を作った生成の入力**で評価する——いまのフォームで評価すると、生成後に重みを変えた1本だけが別の条件で並ぶ。評価は組み合わせ（適用した順を含む）ごとに覚え、「差分を見る」と「作成」で投げ直さない（生成APIには回数の上限がある）。評価を待つ間に作り直す・消す・やめる・始め直すと、届いた評価は何も書かない（評価の控え・処理の状態・作った経路の受け渡しのどれも。編集は始めた1回ごとの印で見分ける）。「作成」は連打の2回目を同じタスクの中で止め、作った経路が既にある候補と同じ道ならその候補を選ぶだけにする。差分を見た時点でも、同じ道の候補があればそのidを編集面へ渡す。入口は、表示中の候補が2本以上あれば周回でも目的地ルートでも出す（終点［目的地、無ければ出発地］へ着くかはbackendが確かめる）。区間を割る下限（軸カタログの較正値）を引けない間は乗り換え先を作らず入口も出さない。返すのは地図へ渡す値（乗り換え先の帯・いま作っているルート・帯のタップ）と`features/route/useSpliceSession.ts: RouteSplicePanel`へ渡す値で、作った経路と元を結果へ足すのは呼び出し側（`features/route/useSpliceSession.ts: onApplied`） |
| `features/route/useSpliceOptions.ts` | 区間の乗り換えの編集で、いまの組み合わせ（元の候補へ適用した乗り換えを当てた形。`features/route/routeSplice.ts: buildSplicedShape`）と、そこから次に選べる乗り換え先（`features/route/stretchAlternatives.ts: stretchAlternativeGroups`）と地図の帯を導く。区間を割る下限が無い間は乗り換え先を作らない |
| `features/map/scene/groups/routes.ts`（乗り換え帯の箇所） | 他の候補が別の道を通る区間を地図へ帯で描き、**タップでその道を選べる**（`onSpliceStretchSelect`。選ぶ操作の中心を地図へ置く——パネルの行だけで選ばせると、どの行がどの帯かを目で対応づける必要がある。帯と当たり判定は役割`features/map/scene/groups/routes.ts: spliceBandLine`・`features/map/scene/groups/routes.ts: spliceBandHit`として宣言する）。帯はどれも破線で描く。タップして乗り換えた先は帯ではなく、いま作っているルート（太い実線）の一部として描かれる。破線の刻みは配列で持つ（feature式に依存しない） |
| `features/map/scene/groups/routes.ts` | ルート候補・選択中ルート・区間色分け・乗り換え帯・選んだ区間の範囲の縁取りの宣言。状態から載るべきレイヤーの並びを返すだけで、地図を直接は触らない |
| `features/map/scene/groups/routeSources.ts` | ルートの線のソース（候補の参考線・選択中・区間・乗り換え帯・合成ルート・選んだ区間）の名前と中身（`features/map/scene/groups/routeSources.ts: routeSourceEntries`）。どのレイヤーがどのソースを描くかは`routes.ts`が決める |

## RouteSettingsPanel.tsx（一般向けメイン設定面）

```
useAxisCatalog() ──→ catalog.axes（公開軸一覧、is_published=Trueのみ）
                          │
        ┌─────────────────┼───────────────────────┐
        ▼                                          ▼
  重み配分バー（帯グラフ、境界              軸の凡例チップ（折り返して並ぶ）:
  ドラッグ/矢印キーで隣接2軸の重みを        色ドット+ラベル（タップで有効/無効）+
  移し替え）                                (i)説明文ポップオーバー
        │                                          │
        └──────────────┬───────────────────────────┘
```

- 軸の一覧・既定重みは`useAxisCatalog`経由（取得完了まで・失敗時は軸0件。ビルド時の
  写しへは倒さない）。軸スタジオでの追加が再デプロイなしに反映される。
- 取得に失敗したときの告知と再試行導線は、**常設ヘッダーの「未取得」の印**（既定で開く条件タブ・地図を
  見ている人にも届く場所。[ページ全体構成](page-composition.md)「失敗・空・待ちの伝え方」）と、重みを
  触っている人へ向けたこのパネルの両方にある。影響は重み配分だけではない——同じ応答がタイル世代も
  運ぶ（地図は同じ取得から世代を導く）ため、地図の道路・POI・事故も出ない（[静的地図レイヤー](static-map-layers.md)「配信情報を取得できず
  表示できません」節）。告知の文面はその両方を述べる。
- **カタログ1件→画面の軸の変換は`catalogAxis.ts: catalogAxisFromEntry`1本**で、重み一覧も、
  地図が塗る軸（`axisLayers.ts`）の共通の項目もこれを通る——経路ごとに行を写すと、同じ行の欠けた
  項目（アイコンの`icon_id`が無い等）の補い方が経路ごとに食い違う。
- カテゴリ（観測/推定/動的）によるグルーピング表示は行わない。軸スタジオは常に
  `category="推定"`固定で軸を作るため、フラットな1本のリストで表示する。
- **軸が増えてもパネルの高さが変わらない構成**にする（走行中のスマホで扱うため）。
  全軸の取り分は高さ固定の帯グラフ1本に収まり、選択中の軸の行も1行で固定。縦に伸びうるのは
  軸チップの領域だけで、そこは高さ上限＋内部スクロールを持つ。チップは
  **有効な軸を先に並べる**ため、スクロールせずに現在の配分を読める。
- 帯グラフの区間には、幅が許すぶんだけ軸アイコンと%を入れる（`SEGMENT_ICON_MIN_PCT`・
  `SEGMENT_VALUE_MIN_PCT`。狭い区間は%のみ→何も出さない、の順に落とす）。区間に入らない
  軸の%もチップ側では必ず読める。設定側の帯は区間そのものが操作対象で高さが要るため、
  結果パネル側の細い帯（`ui/AxisLegend`の`stackBarClass`）とはスタイルを共有しない。
- 重み配分バー（帯グラフ）は表示専用ではなく、
  隣り合う2区間の境界（`role="slider"`のハンドル、幅16px）をポインタドラッグまたは
  矢印キーで操作すると、その両隣の2軸間でだけ重みが移動する（他の軸・2軸の合計は
  変わらない）。動く量は1刻み（`weightStep`。有効な軸の重みの合計の1%）の倍数で、矢印キーの1押しが1刻み。帯とチップは
  重みを合計に対する%で出すので、合計がいくつでも%が1ずつ動く。`clampBoundaryDrag`が重みを1刻み以上へクランプする
  （1軸へ寄せられる割合に上限は無く、引かれる側が0（無効）になる手前の1%で止まる）。
  ハンドル自身だけに`touch-action: none`を絞ってあり、帯グラフの他の部分（セグメント
  本体）はスクロールジェスチャーを妨げない。**重みの調整手段はこの帯グラフの
  ドラッグ・矢印キー操作のみ**。ドラッグ中の値は帯の区間とチップの%がその場で動いて
  示すため、操作の説明文も、同じ調整を別の形で用意した操作（増減ボタン等）も置かない（動かし方と止まる所は
  帯の右の(i)の奥に置く）。
  帯の色と凡例チップの色ドットは、どちらも軸カタログが1回だけ導く識別色
  （`lib/axisCatalog.ts: axisColors`、実際の軸数でHSL色相環を等分）を読むため、常に一致する
  （ルート結果・レンズの選択肢も同じ色）。**帯そのものが「重み配分」で
  あり「全体で100%」であることを示すため、タブは見出しも合計の表記も持たない**（言い換えの
  行を置かない、設計原則「冗長なものは削る」）。
- 軸の凡例チップ（`renderLegendChip`）は「本体（アイコン＋名前＋現在の%。タップで
  有効/無効を切替、weight>0が有効の判定基準）」「(i)説明文ポップオーバー」の2要素で構成
  される複合ボタン群。無効な軸（weight=0）はチップ全体を半透明にし、%は出さない。
  軸の説明は画面へ書かずこの(i)の奥に置く（設計原則「冗長なものは削る」）。`route_preference`の
  重みを切り替えるだけで、地図の色分けとは無関係（地図の色分け（レンズ）はこのパネルには
  なく、地図上の`LensControl`だけが持つ）。
- 向きを選ぶ操作はこのパネルには存在しない。風・勾配で周りの道を塗るときの走る向きは地図の上の向きで決まる
  （[ページ全体構成・状態管理](page-composition.md)「動的材料（風・勾配）の状態別表現契約」の「地図の向き」）。
- パネルが受け取る重みは、`useGenerationConditions.ts`がカタログのキー集合へ揃えた値（`routePreferenceSync.ts: alignRoutePreference`。
  軸の追加/unpublishに追従。backendは「上書きするなら既知の全axis_idキー一致」を要求するため、ズレるとルート生成が
  422になる）。パネル自身は揃えない——送る値・道の評価と同じ1つの揃えた値を表示し、それを元に編集する。
- 除外は独立したタブ（`HardFilterPanel`）に置き、道ごとの避け方を1つの並びにする。重みのタブと同じく見出しの行を持たず、タブを開くと
  すぐ並びが始まる。重みづけと違い「通らない」「なるべく避ける」指定であることは、行ごとの選ぶ口の使い方の文（説明を見る状態で出る）で
  明示し、将来の除外条件もこのタブへ足す。
  - **固定の行**: 自転車が通れない道（生成物の`hard_filters`）は、並びの先頭に畳まずに置き、選ぶ口の代わりに鍵と「通らない」を出す。
    backendはこの道をいつも除き、要求でも変えられない。
  - **選べる行**: 地図の道のレイヤの凡例の行を、配られた行のままレイヤごとに畳んで並べ（見出しの名前と並びは凡例のレイヤと同じものが配られる）、行ごとに「通る・なるべく避ける・通らない」を
    選ぶ。行は20近くあり全部を開くとスマホで長くなるので、レイヤは畳んで始め、畳んだ見出しに既定から変えた行の数と、「通る」以外を
    選んだ行の数を段ごとに出す（開かずに何を避けているかが分かる）。行の説明は行の名前の(i)の奥に置く。
  - 全部の行を1回で既定へ戻す操作は持たない（見出しの行を置かないため）。既定から変えた行は畳んだ見出しの印で分かり、行ごとに
    選び直すか、保存した条件を呼び出して戻す。
- 重みを既定値へ戻す操作はこのタブに持たない。重みを含む条件の切り替えは、名前を付けて保存した条件を「保存済み」タブで
  呼び出して行う（下記「保存した条件」。重みを上書きせずに保存した条件を呼び出すと、上書きをやめて既定の配分に戻る）。

**暗黙の前提**: `useAxisCatalog()`は`page.tsx`と`RouteSettingsPanel.tsx`から同時に呼ばれうる
（`page.tsx`がマウントした時点で子の`RouteSettingsPanel`も同時マウントされるため）。
カタログは画面のデータ取得が共有するキャッシュ（`lib/queryClient.ts`、TanStack Query）の1つのキーに置き、
全呼び出し元が同じ値を読むため、どちらか一方の取得が解決すれば両方の呼び出し元へ即座に反映される
（2インスタンス間で`axes`配列が食い違うことは構造的に起こらない）。同時に飛んでいる取得は同じキーの
1本にまとまる。届いた値は古いものとして扱い（軸スタジオでの公開操作を再デプロイなしに反映するため、
後続の別マウント[モバイルのBottomSheetを開き直す等]では改めて最新を取得する）、取得に失敗しても
取得済みの正常なカタログを巻き戻さない（失敗した取得は値を書き換えない）。読み手が一時いなくなっても
捨てない——捨てると次にマウントした部品が軸0件から始まる。

**暗黙の前提（`loaded`フラグの意味）**: `AxisCatalog.loaded`は「取得成功し他フィールドが
実際のDB由来の値であること」を表す。`loaded=false`（未取得/失敗）の間は軸が0件のため、「軸スタジオの現在の
公開軸集合と一致していなければならない」処理（`route_preference`のキー整合等）ではこのフラグで
未確定状態を区別しなければならない——区別しないと「公開軸が1つも無い」と読み、保存済みの重みを
全部消す。取得成功時に軸が0件（全軸非公開）であっても`loaded=true`になる
（0件も確定した実際の状態のため）。

`loaded`と対になる`failed`は「取得を試みて失敗し、まだ一度も成功していない」を表す
（未取得=両方false／成功=`loaded`のみ／失敗=`failed`のみ）。取り直している間（再試行・別の部品の
マウント）は`failed`を下ろして取得中に戻す。この状態でも重み配分は
編集できてしまうが、生成（`features/route/useRouteGeneration.ts`）は`loaded`ガードにより`route_preference`を
送らず、backendの既定配分で探索される。黙って捨てると「重みを変えたのに
結果が変わらない」を実験の差だと取り違えるため、常設ヘッダーの印と`RouteSettingsPanel`が失敗の表示と
再試行導線（`retryAxisCatalogFetch`、成功済みなら何もしない）を出し、重みを上書きしていたのに送れずに
作った候補には「ルート結果」の先頭に「重み配分を反映できず、既定の配分で作りました。」を出す
（`useRouteGeneration.ts: weightsNotApplied`）。上書きしていない生成には出さない——元から既定の配分で、
反映できなかったものが無い。生成そのものは断らない——既定の配分のルートでも走るには使える。

## cardinalLabel.ts（角度→方位の呼び名）

`cardinalLabel(bearingDeg)`（角度→方位の日本語ラベル）は、呼び名の並びを生成物
（`mapDisplay.compassLabels`、源泉は`backend/app/domain/geo.py: COMPASS_LABELS`）から読み、区分の幅は
その数から決める。丸め方だけを画面側に持ち、区分の境界ではbackendと同じく次の区分へ倒す（違うと境界の角度で
食い違う）。同じ呼び名になることは、backendが入力と答えを出す表（生成物`geo-expectations.json`）をテストが全行通して確かめる。

## RouteAxisProfile.tsx（候補ごとタブの中身: 総合難易度＋軸別内訳）

`RouteOutcome.tsx`（[ページ全体構成・状態管理](page-composition.md)「ルート結果の中身」参照）が組み立てる候補ごとの
タブの中身として、候補1件につき1つ表示する。呼び出し側（`RouteOutcome.tsx`）は`axes`へ公開軸すべてを渡す——
寄与が0・欠損でも重みのある軸のチップを凡例に残すためで、重み0の軸は`RouteAxisProfile`自身が凡例から落とす
（下記「評価に使っていない軸」）。

**難易度の数字の桁**: 画面に出す難易度（総合難易度・区間の難易度・軸別難易度・重み付き寄与度と、それらの差。
道の詳細の合成も）は、どれも`lib/mapDisplay/valueScale.ts: formatDifficulty`（差は`DIFFICULTY_DECIMALS`の桁で
`routeEditDiff.ts: formatDelta`）を通し、backendが区別する桁（小数1桁）で書く——候補の並びは0.1点の差で決まるので、
整数に丸めると並びの根拠が読めず、同じ面で桁が割れる。負荷（数百の値）だけは`formatLoad`で整数に書く。

**軸を1行ずつ並べる一覧は持たない**。軸ごとの詳細（軸別難易度・生値・材料内訳・説明）は
寄与度バーの凡例チップを押して開く。1軸1行の一覧は公開軸の本数ぶん縦へ伸びるのに対し、
チップは行内で折り返すため、軸が増えても縦は折り返しぶんしか伸びない。

- **軸の詳細（凡例チップから開く）**: 中身は軸別難易度（`RouteCandidate.axis_difficulties`、
  重みを掛ける前。桁は下の「難易度の数字の桁」）＋生値＋材料内訳＋軸の説明。**チップの数字（重み付き寄与度）とは
  別の値**であることが分かるよう「この評価軸の難易度 N/100」と単位付きで書く。寄与度バーの凡例
  （`AxisContributionBar`の`renderDetail`）と、下記の「寄与が出ていない軸」のチップの
  どちらから開いても同じ中身を出す（軸の詳細の出どころは1つ）。名前・軸別難易度・説明の形は
  `AxisDetail.tsx`が持ち、区間の詳細のチップも同じ形で開く（下記「区間クリック詳細」）。押せることは
  チップ内の(i)アイコンで示す——このアプリで「押すと説明が出る」を表す形を共有する。
- **評価に使っていない軸**: 重み（生成時点の`route_preference`）が0の軸のチップは**出さない**
  ——軸の一覧はルート設定側が持ち、結果側は「このルートの評価に効いた軸」に絞る。チップの形は
  ルート設定パネルの「重み配分」と共有する（`ui/AxisLegend`）——同じ軸が画面に
  よって違う形・違う色に見えると、設定した軸と結果に出ている軸が同じものだと読み取れない。
  重みは入っているのに値が来ない軸のチップは押せるままで、詳細が「データなし」を示す。
- **生値（詳細の中）**: 折れ点を通す前の生値を詳細へ単位付きで出す
  （`RouteCandidate.axis_raw_values` × `AxisCatalogEntry.raw_value_units.unit`、
  `axisRawValue.ts: formatAxisRawValue`）。候補の走行距離を掛けた総量も続ける
  （例:「0.8回/km・約26回」）——ただし**総量が読み手の判断を変える軸だけ**で、その判断は
  `AxisCatalogEntry.raw_value_units.total_unit`が持つ（「約3322度曲がる」には比べる尺度が無い）。得点0-100は目盛りの引き方に依存する相対評価
  でしかなく、それだけでは軸単体で経路の良し悪しを判断できないため
  （[設計原則](../../architecture/design-principles.md)11）。
- **内訳（詳細の中）**: 材料まで分解した絶対量を「この軸の内訳: ...」として全件出す
  （`AxisCatalogEntry.material_breakdown` × `RouteCandidate.material_values`、
  `axisRawValue.ts: formatMaterialBreakdown`）。
  表記は材料の型で決まり、軸ごとの対応表を持たない——numericは距離加重平均＋単位
  （「制限速度 42km/h」）、booleanは該当区間の延長割合（「街灯あり 68%」。値が0/1で
  運ばれるため平均がそのまま割合になる）、categoricalは**最も延長の長い値**のラベルと割合
  （「住宅街の道 62%」、`RouteCandidate.material_category_shares` ×
  `AxisCatalogEntry.material_breakdown[].value_labels`、`formatCategoryBreakdown`）。
  categoricalで2件目以降を出さないのは、「幹線道路が◯%」のように複数の値をまとめるには
  どの値を幹線とみなすかという判断表が要り、それをフロントが持つと軸を1本足すたびに表の
  更新が要る状態へ戻るため。ラベルはbackendが返す対訳を引き、未登録の値はタグ生値のまま
  出す。**並べ替えはしない**: 受け取った並びをそのまま使う（順序は配る側が決める）。
  値が来ない材料（categorical材料は数値列に載らない）は飛ばす。
- **負荷（難易度×距離）**: `RouteCandidate.overall_difficulty.load`を総合難易度の隣へ併記する
  （(i)で意味を説明する。平均・総量・値の無い区間の数え方の文は、式の横で backend が持つ`domain/difficulty.py: OVERALL_DIFFICULTY_WORDING`を
  生成物`route-generate-config.json`の`overall_difficulty_wording`から差し込み、画面はグラフと内訳を指す文だけを足す）。
  総合難易度が距離で正規化された平均であるのに対しこちらは総量で、
  「難所を通っても短いルート」と「遠回りで易しいルート」を見比べるための値
  （[評価・スコアリング](../backend/evaluation-scoring.md)「ルート単位の集約」節参照）。
  候補の並び順には影響しない。**数値と併せて、上の道のりのグラフの「評価で塗る」（`DifficultyProfile`）が面積で同じことを表す**
  ——負荷は総合難易度に距離を掛けただけの派生量のため、独立した数値として並べるだけでは平均と総量の関係が読めない。
- **所要時間の説明**: (i)は、区間ごとに速度を変える条件の名前を走行モデルの宣言（`domain/cycling_speed.py: SEGMENT_SPEED_CONDITIONS`。
  生成物`route-generate-config.json`の`segment_speed_conditions`）から差し込む。想定速度の(i)（`RideConditionBar`）も同じ並びを使う。
- **所要時間の前提が崩れたことの注記**: 所要時間のすぐ下に、`RouteCandidate.wind_unavailable`なら「風のモデルの計算値を
  使えなかったため、無風として所要時間を出しています」、`missing_travel_data_share`（勾配か停止要因の件数の値が無く、
  平地・待ち無しとして数えた区間の距離の割合）が丸めて1%以上なら「データの無い区間が◯%」を出す——黙って短い所要時間を
  見せない。0%は判断の材料にならないため出さない。どちらもbackendがEdge単位で数えた値をそのまま使う。
- **総合難易度**: `RouteCandidate.overall_difficulty.average`（絶対基準0-100の軸重み付き合成値）を
  表示する。下記内訳の合計そのものであり、内訳の1項目としては扱わない。候補タブの並び順は
  この値ではなく最速の印の1本が先頭、残りは所要時間の短い順（`routeTabLabel.ts: orderGenerated`。[ページ全体構成・状態管理](page-composition.md)参照）。数字の隣に(i)説明ポップオーバー
  （このコンポーネント自身が持つ、負荷の説明と同じ形）を置く。
- **軸別内訳（重み付き寄与度）**: `RouteCandidate.axis_contributions`（axis_id→重み付き
  寄与度0-100、backend側で区間ごとの合成に使ったのと同じ重み配分を軸別に分解しルート
  全体へ距離加重平均で集約した値。1kmあたりの回数で測る軸は、回数を平均してから得点にした値に重みの割合を掛けたもの
  （backend: `domain/route.py: merge_axis_contributions`）。評価できなかった軸（データ欠損）はキー自体が無く非表示。
  重み0の軸はキー自体は残り値が常に0.0になる（backend:
  `domain/difficulty.py: axis_contributions_at_row`参照。frontend側で値0を除外する、
  下記`AxisContributionBar.tsx`参照）を、「総合難易度」の数字の
  隣に`AxisContributionBar`（積み上げ1本バー＋その下の凡例）でそのまま表示する。バーは長さだけで
  総合難易度を表す（距離と面積は上の道のりのグラフが持つ）。合計が
  丸め誤差を除いて`overall_difficulty`と数学的に一致するため、frontend側での独自の
  重み計算は行わない。バーの各セグメントの色は`axisColors`（地図色分けチップと同じ配色）、
  幅は寄与度の値そのもの。

## AxisContributionBar.tsx（「重み付き寄与度」の共有表示部品）

「重み配分」帯グラフと同じ表現（`ui/AxisLegend`）の積み上げ1本バーと、その下の凡例（軸アイコン＋数値）を
描画する。**凡例は軸の名前を文字で出さない**——狭い幅では名前がそのまま行数になり、
公開軸の本数ぶんで内訳が画面の大半を占める。軸はアイコン（軸の`icon_id`を
`axisIconFor`で引く）で示し、名前は押して開く説明と、押せないチップの`aria-label`が持つ。
軸を選ぶ側（`RouteSettingsPanel`の「重み配分」）は名前が要るため、そちらは同じアイコンに
名前を添える。`axes`（表示順・ラベル）・`contributions`（axis_id→寄与度）・`axisColors`のみを
受け取る汎用コンポーネントで、値の出どころ（ルート全体か特定の区間か）を一切知らない。
`contributions`にキーが無い軸・値が0の軸（重み0の軸は常にこの値になる）は自動的に
除外されるため、呼び出し側は`axes`を絞り込まずに渡してよい。

凡例に並べる軸は`legendAxes`で差し替えられる（省略時は帯グラフに出る軸だけ）。公開軸
すべてを渡せば、寄与が出ない軸も凡例に残る。

並べ方は`layout`で選ぶ。既定の`stacked`は帯の下に凡例のチップを折り返して並べ、`inline`は帯の右に
軸のアイコンと数字だけの小さいチップを並べて1行に収める（道のりのグラフの地点の詳しくの3行目。(i)を省き、
チップの地の色で押せることを示す）。

**軸の並び順に連続的な意味は無い。** 軸を横に並べて見せるUIでは、隣り合う軸の間に傾き・
推移があるように見せない——値どうしを線やグラデーションでつなぐと、「隣の軸へ向かって
増えている」という読み方が生まれる。高低は各軸の中だけで示す（色と長さ）。

チップは詳細の入口で、中身は`renderDetail`（軸→詳細の中身）が決める。**軸ごとにnullを返すと、
その軸は凡例から落ちる**（結果パネルは重み0の軸でnullを返しており、評価に使っていない軸は
並ばない）。**詳細の中身はこのコンポーネントが組み立てない**
——軸別難易度も材料値も呼び出し側が持つデータであり、ここが知ると値の出どころを知らない
という前提が崩れる。
ルート全体の内訳（RouteAxisProfile、`RouteCandidate.axis_contributions`）と
区間の詳細（`SegmentDetail.tsx`・`ProfilePointDetail.tsx`、`RouteSegmentDetail.axis_contributions`、下記「区間クリック
詳細（selectedRouteSegment）」参照）の両方が同じこのコンポーネントを使う——「重み付き
寄与度」の表示はこの1部品に一元化されており、値の出どころごとに別の表現を持たない。

## 区間クリック詳細（selectedRouteSegment）

地図上でルート線の区間を押すか、道のりのグラフをなぞって地点を選ぶと、`useRouteResults.ts: selectedRouteSegment` state
（`{ segment: RouteSegmentDetail, latitude, longitude }`。押した所に最も近い区間の上の点）が入る。地図で区間を押して選べるのは、「ルート結果」が
地図で効いている間と、パネルを閉じて見るだけの間（[ページ全体構成・状態管理](page-composition.md)「地図を押したときの意味」）。地図側は
その点に選んだ地点の印を立て、その区間の範囲を縁取りで示し（下記）、見るだけの間はその上の小窓（`features/route/SegmentDetail/SegmentDetail.tsx`。[地図: 静的レイヤー・道路表示](static-map-layers.md)参照）に、
ほかの間は「ルート結果」の道のりのグラフの下（`features/route/RouteProfile/ProfilePointDetail.tsx`）に中身を出す。走行中の地図の下の
道のりのグラフも、選んだ地点の中身を同じ`ProfilePointDetail`で図の下に出す。`selectedRouteSegment`がnon-nullの間、「ルート結果」タブは
ルート全体の内訳（`RouteAxisProfile`）を出さない。

地図の印と縁取りは、地図で押してもグラフで選んでも、結果でも走行中でも同じに出し、選択を外すと消す。

- **選んだ地点の印**（`features/map/MapView/useMapMarkers.tsx: SelectedPointPin`）: 白い縁と内の白い丸を持つ塗りのしずく形で、
  先が地点を指す（Markerの`anchor: "bottom"`）。影を付けてどの配色の上でも浮かせ、色（`palette.semantic.selected_point`）は評価の配色・
  ルートの線の色・現在地の青のどれとも重ならない朱色にする。押すと選択を外す。読み上げ名は「選択中の区間」。見るだけの間の小窓は
  印の高さ（`useMapMarkers.tsx: SELECTED_POINT_PIN_HEIGHT_PX`）の上へ出す。
- **選んだ区間の範囲の縁取り**（`scene/groups/routes.ts`の役割`selectedSection`）: グラフの区間の帯と同じ区間の形を、どのルートの線より
  後ろに太い半透明の線で敷き、線の外側へはみ出た所で範囲を示す（線の上に重ねると区間の色分けを隠す）。形は選んでいる候補の同じ区間
  （`lib/routeDistance.ts: findSameSegment`）から引く——地図で押した区間は地物の属性から組み直した写しで、形を持たない。

中身は区間の地点（区間の始まりの道のり）・到達予想時刻・区間の総合難易度（`RouteSegmentDetail.difficulty`。算出できなかった区間は「—」）・
評価に使った風（区間の中ほどに最寄りの格子点の計算値であることとその時刻・風向風速、詳しくは(i)。
「予報」とは呼ばず、(i)は数値予報モデルの値に添える断りの文（生成物`mapDisplay.modelValueDisclaimer`）を出す——[動的気象レイヤー](dynamic-weather-layers.md)「責務」。
(i)の説明がレグごとに追う時間を生成物`route-generate-config.json`の`wind_forecast_hours_per_leg`から出す）＋
`AxisContributionBar`（区間の`axis_contributions`）。道のりのグラフの下では、これに選んだ地点の標高・勾配と、その地点で当たる道の区分の
チップを足して3行にまとめ（各行の中身は上の表の`ProfilePointDetail.tsx`の行）、風はチップにして、時刻・説明はチップを押すと開く。
×ボタン（地図の小窓では小窓を閉じる）で`selectedRouteSegment`をnullへ戻すとルート全体表示に復帰する。`AxisContributionBar`は寄与が1つも
無いと何も描かないので、寄与が全部0の区間は「どの評価軸も0（易しい）」と文で言う——内訳も数字も出ないと、壊れたのと見分けがつかない。
内訳のチップを押すと、軸の名前・**その区間の**軸別難易度（`RouteSegmentDetail.axis_difficulties`）・説明が開く（`AxisDetail.tsx`）
——チップは名前を文字で出さないため、押して開けないとマウスを重ねられないスマホでは軸の名前が分からない。
生値・材料の値は区間の詳細には出さない（設計原則「数値は3層で見せる」の、区間の詳細は得点まで）。

**近くの施設**（停止要因・補給・立ち寄り先・事故）は、生成の応答に載せず、区間を押しただけでも引かず、地図で押した区間の小窓の「探す」を押したときだけその区間の分を1回引く（`features/route/useSegmentSidePoints.ts`。backendの規則は[ルーティングエンジン](../backend/routing-engine.md)「区間の近くの点」）。点は地図に、点の層と同じ色・絵記号の印で描き（[静的地図レイヤー](static-map-layers.md)「選んだ区間の近くの点」）、区間の小窓の末尾（`SegmentSidePoints.tsx`）に種類ごとの件数のチップを出す。区間の小窓は地図で押した区間にだけ出し（グラフで選んだ地点へは出さない。なぞるたびに付いて回らない）、見るだけの間は区間の中身を全部、「ルート結果」が効いている間（走行中に出したパネルの中を含む）は中身をグラフの下が出すので近くの施設の行だけを出す。道のりのグラフの地点の詳しくには出さない。チップは押すとその種類を地図に出す・消す切り替えで、区間を押した直後と選び直したときは全部出す。区間を選ぶと地図をその区間へ寄せ（`features/map/MapView/mapCamera.ts: fitBoundsToSection`。同じ区間の中で地点を選び直しても寄せ直さない）、走行中は追うのを休んで寄せ、選びを外すと追い直す。結果の画面では、外しても地図を動かさない。引いている間は「読み込み中」、失敗したら「近くの施設を読めませんでした」と出し、ほかの中身は残す。

## 保存した条件（SavedConditionsPanel.tsx・useSavedConditions.ts）

「ルート設定」で組んだ条件に名前を付けてこの端末に保存し、選ぶだけで同じ条件に戻せる。ログインは要らない
（保存先はこの端末のブラウザの`localStorage`だけで、別の端末とは共有しない）。保存は「条件」タブ、呼び出しは4つ目のタブ
「保存済み」の中の「プリセット」で行う（「保存済み」の中は「地点」「プリセット」のタブに分かれ、地点は下記「保存した地点」）——地点の保存と同じく、
条件を詰める所で保存し、「保存済み」タブは設定も地点も呼び出す・消すだけを持つ。タブは保存したものが並ぶ所だと名前で読め、
保存した設定は呼び出すと各タブの値をまとめて入れ替えるものなので「プリセット」と呼ぶ。保存するものは重み・除外まで及ぶが、保存の
アイコンは「条件」タブの1行目（全長の目標・候補数の行）の右端に置き、縦の幅を増やさない。見出しの行には置かない。

- **保存するもの**: 周回か・全長の目標を決めるか・距離・候補数・出発地（固定したときだけ。下記）・経由地・目的地（周回の間に覚えている目的地も）・重み配分（上書きしていなければ「上書きしない」）・
  除外する道路と道の行ごとの避け方。**保存しないもの**: 出発時刻・想定速度・走行方位（その日の走行条件）と、生成した候補そのもの。呼び出して
  生成し直すと、道路データや気象が変わっていれば前と同じ候補になるとは限らない。
- **何が保存されるかを押す前に読める**: 「いまの設定を保存」で開く窓
  （`Dialog/Dialog.tsx`）に、残るものだけ——条件（目的地へ向かうか出発地へ戻る周回か・全長の目標・経由地・候補数）・出発地の扱いの切り替え・重み・
  除外する道路——を並べる。保存は条件を詰めたあとに1度する操作で、走行中に繰り返すのは呼び出しなので、スマホで中身の高さに
  合わせて開くシートが一覧まで短く収まるように、保存の中身を窓へ出す。保存しないものや、重みを変えたかどうかは書かない（スマホでは
  パネルの高さが限られ、残る中身が埋もれる）。重みは使う軸ごとの割合（重みの合計に占める%。
  「重み」タブのチップと同じ数）を割合の大きい順に出す。上書きしていない重みは、軸カタログが配る既定の配分を
  出す（生成のときもbackendの既定で探すため）。除外は段ごとに、強い段から「通らない 高速道路・…／なるべく避ける 国道・…」の形で
  名前を並べ（除外する道路の種類は「通らない」に入れる）、どれも無ければ「なし」と出す。一覧は見出しを持たず、行は名前と、アイコンだけの「呼び出す」「消す」（[デザイン基盤](frontend-design-system.md)
  「5-1. パネルの操作ボタンの形」）だけを出す——条件・出発地・重み・除外は呼び出しの窓で読む（ブックマークのように見渡せる簡素な一覧にし、
  名前と同じことを言い換える行を置かない）。
- **出発地**: 保存のときに「呼び出した時の現在地」か「今の出発地に固定」かを選ぶ。選ぶまでは、地図で出発地を置いていれば
  固定・現在地のままなら呼び出した時の現在地（保存すると選び直す前のこの既定へ戻る）。固定はいまの出発地（現在地でも地図で
  置いた地点でも）をその地点として保存し、呼び出すとその地点を出発地にする。固定しないものは呼び出したときの現在地から
  生成する（地図で置いた出発地があれば現在地へ戻す）。出発地が分からない間は固定を選べない。家で現在地のまま保存して
  職場で呼び出すと職場から作られる、という食い違いを、保存の時の一度の選択で防ぐ。
- **保存**: 名前の欄に、いまの条件から作った仮の名前（「周回 30km」等、`savedConditions.ts: suggestedConditionName`）が
  入った状態で出て、そのまま保存もできる（空にして保存しても仮の名前）。同じ名前で保存すると上書きし、そのときはボタンが
  「上書き保存」になる。保存すると窓を閉じ、保存した件は「保存済み」タブの「プリセット」の一覧の先頭に入る。
- **呼び出し**: 一覧の行の「呼び出す」を押すと窓（`Dialog/Dialog.tsx`）が開き、保存の窓と同じ並び（条件・出発地・重み・除外）で
  その設定の中身を出す。「反映する」を押したときだけ各タブの値と地図のピンが入れ替わり、一覧の上に反映したことを出す
  （何に入れ替わるかを押す前に読め、入れ替わったことが分かるように。出発地は窓と「条件」タブで
  読めるので、知らせには書かない）。知らせの行は読み上げのためにいつも置き、知らせが無い間は場所を取らない（一覧の上に空白を作らない）。生成はいつもの「ルート生成」で行う——
  入れ替えたあとに値を確かめたり少し変えたりできる。地点を入れ替えるので、地図のタップで置ける役割は解く。
- **消す**: 行の「消す」は確認の窓（`Dialog/Dialog.tsx: ConfirmDialog`）を出し、「消す」を押したときだけ消す。消した設定を戻す手段は無く、
  条件・重み・除外を組み直すことになるため（[デザイン基盤](frontend-design-system.md)「意図的に作らない・統合しないもの」の確認の窓の決まり）。
- **読み方**: 保存値は読むときに、今の画面が受け付けない件（範囲の外の距離・候補数、上限を超える経由地等）だけを捨て、
  ほかの件は残す。周回・目的地のモードを切り替えていた頃に保存した件は、周回なら全長の目標を決めて経由地・目的地を外し（周回は置いて
  あっても隠して使わなかった）、目的地なら全長の目標を外した形で読む。周回かを持たない件は、目的地を持たなければ周回、持てば周回を外した
  形で読む（周回の切り替えが無い間の生成と同じ形）。読んだ一覧は今の形で書き戻す（`useStoredState`の`rewrite`）。前の形の読み替えは、その形の変更が本番に出てから3か月で消し、消す日を
  読み替えの隣に書く。除外は今の項目へ揃え、道の避け方は今の行へ揃える（避け方を持たない件は既定の段で読む。前の鍵に選んだ段は、軸カタログが届いたら今の鍵へ移して書き戻す。`rewrite`は形を直すだけで、鍵は軸カタログが届くまで分からない）。重みは「重み」へ入れたあと、いつもの保存値と同じく軸カタログの公開軸へ揃える
  （「RouteSettingsPanel.tsx」）。

## 保存した地点（SavedPlacesPanel.tsx・useSavedPlaces.ts・PointDetail.tsx・PointSearch.tsx）

よく行く場所に名前を付けてこの端末に保存し、探し直さずに出発地・経由地・目的地に置ける（保存先は保存した条件と同じく
この端末の`localStorage`だけ）。保存は地点を置く所（条件タブの押した地点の詳しく）で行い、呼び出しは詳しくの打つ欄と、
「保存済み」タブの「地点」の一覧の両方からできる——一覧からは、保存した設定と同じく行の「呼び出す」で選べる。

- **保存**: 置いてある地点（出発地は現在地を取れているときだけ）の詳しくの、アイコンだけの「地点を保存」（星）で窓を開き、名前を付けて
  保存する。名前の欄には、探して置いた地点ならその候補の名前、ほかは辺り（無ければ詳しくの名前）を入れておく（空にして保存しても
  その名前）。同じ名前があればボタンが「上書き保存」になる。保存するのは位置・名前・辺りと、住所の代表の位置かどうか（探した候補の
  種類と段。地図で選んだ地点・現在地は、その位置そのもの）。同じ名前か同じ位置の地点は置き換える。
- **保存した地点の印**: 詳しくの地点の位置が保存した地点と同じなら、星を塗り、押すと保存をやめる（置いた地点はそのまま。もう一度
  星で保存し直せるので確認の窓を出さない）。
- **呼び出し**: 詳しくの打つ欄を押すと、保存した地点を住所・施設の候補の上に出す（打った文字を名前に含むものだけ。候補と同じ枠の中で、
  ✕・選ぶ・Escapeで閉じる）。選ぶと、探した候補を選んだのと同じく置く（`useGenerationConditions.ts: placeFound`）ので、名前は詳しくと並びに出て、
  住所の地点には代表の位置と出る。
- **一覧から呼び出す**: 「地点」の一覧の行の「呼び出す」（保存した設定の行と同じアイコン）はメニューを開き、「出発地にする」
  「経由地に足す」「目的地にする」から選ぶ。選ぶと詳しくから選んだときと同じく置き（経由地は足す）、「条件」タブへ移って置いた
  地点を選び、その詳しくを出す——置いた結果を地点の並びと詳しくで確かめられるように。経由地が上限まで置いてあれば「経由地に足す」は
  押せない（下記「地点の指定」の経由地の上限）。
- **消す**: 「地点」の一覧の「消す」は確認の窓を出す（付けた名前は戻せない）。

## 生成を待つ時間・投げる回数の根拠

**ポーリングの打ち切り（`features/route/routeApi.ts: MAX_POLL_DURATION_MS`）は、生成の最悪の所要を
安全マージン込みで上回る値にする。** 値はフロントに書かず、backendがジョブの結果を持つ時間
（`infrastructure/job_registry.py: JOB_TTL_SECONDS`）を生成物`route-generate-config.json`経由で
そのまま使う——保持時間より長く待つと、掃除済みのjob_idを引いて結果の代わりに404を見る。
動かすときはbackendの宣言を変える。

根拠にする最悪ケースは本番の実測（2026-09、本番と同じイメージ・メモリ上限の使い捨てコンテナ、
JITのコンパイル結果をイメージへ焼く前）:

| 場面 | 所要 |
|---|---|
| 同時に動く上限（2件）まで重ねる | 都心60km×2で29秒・都心80km×2で35秒 |
| デプロイ直後の最初の生成（JITのコンパイル込み） | 都心60kmで21秒・都心80kmで24秒 |

生成は探索範囲の区間数に比例して長くなり、区間数は読み込む量の上限（[ルート生成エンジン](../backend/routing-engine.md)
「取得の入口」）で抑えられている。開発機の所要は根拠にしない（取込範囲が本番と違い、並行する処理で振れる）。

**縮めるときは生成の所要だけを見ない**。打ち切りは生成の開始から数え、問い合わせの前に判定するため、
生成の間に画面を離れて打ち切りより後に戻った利用者は、終わっている結果を受け取らずにタイムアウトを見る。
DBの`ROUTE_GENERATION_COMMAND_TIMEOUT_SECONDS`はクエリ1本ごとの上限で、この値とは独立。

**差分プレビューを自動で走らせず、押したときだけ投げる。** 評価はbackendでしか出せず
（[design-principles.md](../../architecture/design-principles.md)構造仕様10）、かつ
**生成APIにはレート上限（1分あたり10回）がある**ため、選んでいる途中の組み合わせごとに
投げると上限へ当たる。選び終えてから押す形にし、同じ組み合わせの結果は覚えて投げ直さない。

## GPX書き出しの間引き（`gpxExport.ts`）

点数が上限を超える候補は、残す点を折れ線の形から選んで間引く（Ramer–Douglas–Peucker。一定の間隔で拾わない
理由・緯度経度のままずれを測らない理由・許容するずれの決め方は`gpxExport.ts`のコメントが持つ）。

**間引きは自前で持ち、simplify-js等の既成の実装を足さない**。simplify-jsは点を平面の`{x, y}`で受け取り、
許容するずれも点の座標と同じ単位で解釈する（[simplify-jsの文書](https://mourner.github.io/simplify-js/)）ため、
緯度経度をm単位の平面へ落とす変換と、上限に収まるまで許容を広げる繰り返しは使う側に残る。残るRDPそのものは
数十行なので、依存を1つ増やす理由にならない。

## RouteForm.tsx・useRouteFormSubmit.ts

「条件」タブの入力欄一式（`RouteForm.tsx`）と、その検証・送信ロジック（`useRouteFormSubmit.ts`）を分離する。
**周回か目的地へ向かうかは、地点の並びの左端の「周回」の切り替えだけで決まる**: 押している間（周回）は終点が出発地で、変えられるのは
経由地だけ。外すと終点は目的地で、経由地と目的地を変えられる。出発地・経由地（置いた順）・全長の目標は、どちらでも置いたとおりに
要求へ入る（全長の目標は、周回なら周回の長さ、目的地へ向かうなら寄り道して合わせる長さ）。**周回にしても置いた目的地は消さずに覚えて
おき、周回の間は要求にも地点の並びにも地図のピンにも出さない**。外すとその目的地が戻る（目的地を置き直さずに周回と行き先を試し比べられる。
効かない入力は画面に出さないので、置いた点がなぜ効かないかを読ませる場面を作らない）。周回の間は目的地を置く入口も出さない——終点の札は押せず、
選んでいる地点は目的地にならず（地図を押すと出発地を置く）、保存した地点の「目的地にする」を押せない。切り替えは端末に保存し、初めて開いたときは
周回（出発地と距離だけで周回を作る形を、開いてすぐ使える）。
デスクトップ・モバイルとも「ルート設定」区分（`RouteSettingsPanel`と同じ場所）から呼ぶ。
`RouteForm`は生成の条件を`useGenerationConditions.ts`の返り値（`conditions`）のまままとめて受け取る——呼び出し側が
欄を1つずつ中継すると、入力を足すたびに中継の行も増える。

「ルート設定」区分自体を「条件」（`RouteForm`の地点・全長の目標・候補数と、`saveConditionsButton`propの「いまの設定を保存」）・
「重み」（`weightsPanel`propで受け取る`RouteSettingsPanel`一式）・
「除外」（`exclusionsPanel`prop、`HardFilterPanel`）・「保存済み」（中の「地点」は`SavedPlacesPanel`、「プリセット」は`savedConditionsPanel`propの`SavedConditionsPanel`）のタブへ分ける。
**タブ列（`Tabs.List`）は見出し行の左（見出しのすぐ右）に置き、タブの中身
（`Tabs.Content`）は本文に出る**ため、
両方を囲む`Tabs.Root`（`@radix-ui/react-tabs`）は`app/RoutePanels.tsx`、選択状態は`app/page.tsx`が持つ
（タブ列は`SettingsTabsList.tsx`、`RouteForm`は中身だけを描く）。タブ専用の行を作らないぶん本文の縦が空き、ラベルは
2文字へ詰める。どのタブも`forceMount`で常時マウントし表示だけ`data-state`で切り替える
（`RouteSettingsPanel`がローカルstate[`movedWeights`等]を持つため、タブ切替のたびに
アンマウントすると失われる。ルート結果のタブと同じ方式）。
「ルート生成」ボタンも同じ見出し行の**右端**に置く（デスクトップは`Disclosure`の`trailing`
の中で左右へ分け、モバイルはタブを`BottomSheet`の`headerLead`・ボタンを`headerAction`へ
渡す）。中身を切り替えるタブと、押して生成を走らせるボタンは役割が違うため、行の中でも
離し、タブは下線型・ボタンは塗りと見た目でも分ける（「ルート結果」見出し行の
`RouteOutcomeHeaderActions.tsx`と
同じ場所）にあり、どのタブを見ていても押せる（`features/route/GenerateRouteActions/GenerateRouteActions.tsx: GenerateRouteActions`）。検証エラーは本文でもボタンの隣でもなく
「ルート結果」欄へ出す（[page-composition.md](page-composition.md)の「生成に関する
フィードバックの置き場」参照）。同じ見出し行には、生成条件が表示中の候補とずれている間だけ
印（`conditionsDirty`）を出す——条件を変えている本人は設定側を見ているため。印は押すと意味が開く（`InfoPopover`の中身を印に差し替えたもの）。検証・送信ロジック自体は
`useRouteFormSubmit`（`{error, check}`を返す）へ切り出し、生成（`useRouteGeneration.ts: submit`）が検証して送る。
見出しのボタンがその送信を呼ぶ（地図のレンズは要求に載らず、生成のフックは地図の見え方を読まない）。候補数の指定は
全長の目標の有無・置いた地点に依らず同じに効く。

全長の目標は目盛りを横に滑らせるルーラー（`components/ui/Ruler/Ruler.tsx`。出発時刻と同じ部品で、左端の目印に合わせたコマを選ぶ）、
候補数は「‹ 8 › 件」のステッパー（-/+ボタン、`DynamicLayerTimeSlider`の1コマ送りボタンと同じ役割分担）にし、
数値の直接入力欄は持たない（原則としてユーザーに数字を直接入力させない方針）。
distance・maxRoutesはいずれもstring stateのまま`useGenerationConditions.ts`が持ち、数値への変換は送るときに行う。
**距離・候補数は検証しない**——ルーラーはコマの並び、ステッパーはmin/maxで値域を強制するため空文字・範囲外を作れず、
保存値も読むときに範囲の外を捨てる（`useGenerationConditions.ts: useStoredState`の`deserialize`）。`useRouteFormSubmit`が
確かめるのは、出発地が分からないこと（下記）と、周回で全長の目標を外して経由地も無く作るものが無いこと（文はその入り切りの
アイコンで「全長の目標を決める」を指す）と、周回を外して目的地を置いていないこと（文は目的地を置くか、出発地へ戻るなら「周回」を押すよう促す）だけ。

**全長の目標は、アイコンの入り切り・ルーラー・値・(i)の1行**にし、候補数のステッパーも同じ行の右に置く。ルーラーは
目印より右の数コマだけを見せ、長い距離は滑らせると出る（短い距離をよく使うので、狭い幅でも1行に収めることを全区間の見通しより先に取る）。入り切りはパネルの他の押して切り替える操作と同じアイコンだけの
形（[デザイン基盤](frontend-design-system.md)「5-1」）で、押している間はアクセント色で塗り、名前は「全長の目標を決める」／「全長の目標を
やめる」。外している間もルーラーと値は出したまま薄くし、ルーラーは動かせなくする（入れ直すと前の値に戻ることが見え、行の高さも
変わらない。「5-2」）。目標から許す幅と、外したときに何を作るかは(i)の奥に置き、画面へ書かない（設計原則「冗長なものは削る」）。
開いたときは入れた形で（出発地と距離だけで周回を作る形を、開いてすぐ使える）、入り切りは利用者が決めた値として保存する。
全長の目標の値・候補数の値と地点の並びの札の名前は、同じ文字の大きさ（`--font-size-md`）で出す（同じ条件を詰める2行の文字が揃って読める）。

**出発地が仮の地点のままなら生成しない**。位置情報を許可しない・取得に失敗した・
端末が対応しない・許可の確認に答える前のどれでも、出発地は`useLocation`の決まった仮の地点で、そこから
作ったルートは利用者のいる場所と関係が無い。押すと「現在地が分かりません。位置情報を許可するか、地図をタップして出発地を置いてください。」
を出す（出し先は他の検証エラーと同じ「ルート結果」。モバイルは「ルート設定」シートにも、
page-composition.md「生成に関するフィードバックの置き場」）。「ルート設定」が効いている間は何も押していなければ出発地を選んでいるので、
地図を押せば出発地になる（下記「地点の指定」）。仮の地点そのものは地図の最初の
中心として残す（天候・警報は仮の地点では取らない。page-composition.md「失敗・空・待ちの伝え方」）。想定速度はこの
フォームでは扱わない（地図右上の条件アイコン列`RideConditionBar`、page-composition.md参照）。
候補数ステッパーは地点の並びの上の行の右に置く（どの入力にも効く共通の条件で、地点・全長の目標とは階層が違う）。

### 地点の指定（出発地・経由地・目的地）

**周回の切り替え・出発地 › 経由地の番号の丸・足す（＋） › 終点をいつも1行に並べ**、押した地点の詳しくをその下に1つだけ出す
（`RoutePoints.tsx`）。経由地は地図のピンと同じ番号の丸だけにするので、上限まで置いても
出発地と終点が欠けず、横にも縦にもスクロールしない。経由地の名前は丸を押すと詳しくに出る（どの丸がどこかは地図のピンの番号で読める）。

- **周回の切り替えは、輪の線と起点の点の印に「周回」を添えたボタン**（印は`components/ui/icons/icons.tsx: LoopRouteIcon`）。押している状態は
  `aria-pressed`で持ち、地点の札の押した状態と同じ強調色の枠と面で出す。
- **周回の間の終点は、出発地の印と出発地の名前に「[周回]」を添えた札**（例「現在地[周回]」）で、押せない（点線の枠で押せる札と見分ける）。
  ルートは出発地へ戻るので、終点の欄が空に見えると終わる所が分からない。周回を外すと終点は目的地の札になり、目的地が無ければ「未設定」
  （生成は断られ、目的地か周回を促す）。

- **両端の札の名前は、入りきるときだけ全部出す**。並び全体が1行に入りきらなければ、両端とも印だけにする（`PointStrip.tsx: namesShown`。
  札の幅を測って決め、印だけの間も名前の幅を測って戻せるかを見る）。名前を途中で切ると、切った分は画面のどこにも出ず読めない
  （e2e の全状態の走査が、省略記号で切った文字を落とす）。経由地が増えるほど、両端は先に印だけになる。
- **押した地点を選び、その詳しくを出す**。地図のタップも、選んでいる地点を置く（下記「地図で置く」）。**何も押していなければ出発地**を
  選んでいる（経由地も目的地も置かない人が、開いてすぐ出発地を直せる。周回を作る人が地図を触っても目的地が置かれない）。足す（＋）を押すと
  新しい経由地を選び、地図を押すたびに経由地を足す（続けて何地点も足すのが普通の使い方）。選んだ経由地が消えた・目的地を選んだまま周回にした
  ときも出発地に戻る。
- 詳しくは、呼び名・名前・出どころ（探して選んだ地点／地図で選んだ地点。名前と同じ言葉なら重ねて出さず、出発地が現在地なら名前が言うので出さない）・辺りを出すので、**地図を見に行かなくても
  どこが決まっているかが読める**。名前は、探して置いた地点ならその候補の名前（施設は辺りを添え、住所は
  注意の色で「代表の位置」と出す。ピンは当たった範囲の中ほどで、行きたい所そのものではない）、地図で置いた地点は「地図で選んだ地点」、
  出発地は「現在地」、目的地が無ければ「未設定」。探して置いた名前は、その地点が候補の位置にある間だけ出す（ピンを動かす・地図で置き直すと
  「地図で選んだ地点」に戻る。`useGenerationConditions.ts: foundAt`）。現在地を取れていない間の出発地は「現在地」と出さず「現在地を取得できていません」と出す
  （印も地図のピンと同じ灰色）——「現在地」と出ている出発地は、本当に今いる場所である。名前と辺りは切らずに折り返す。
- 辺りは、探して置いた施設なら候補の辺り、地図で置いた地点・現在地・辺りの無い施設なら置いた位置から引いた辺り（市区町村から字・丁目まで。
  口は`GET /api/place-area`）。探して置いた住所は名前が住所で、位置は代表の位置なので引かない。現在地を取れていない出発地も、仮の位置なので
  引かない。引いている間・引けない・名前のある境界の外では辺りを出さない（名前と出どころは出ている）。

- 地図のピンは3つとも同じ白い丸（地図はダークの表示でも明るいので、テーマによらない。`features/map/MapView/useMapMarkers.tsx: createPinElement`）で、
  役割は中の記号とその色で見分ける（出発地はスタートの旗・経由地は番号・目的地はゴールの旗。出発地の記号は「現在地に移動」の現在地の記号と
  分ける——走行モードでは本物の現在地の印も出るため）。ピンは役割の名前（「出発地」「経由地 1」「目的地」）を読み上げ名に持ち、
  地図で地点を置ける間は**どれもつかんで動かせ**、押すとその地点を選ぶ。ほかの間はつかめず、押すと呼び名と名前を地図の小窓に出す
  （押しただけでは消さない。消すのは詳しくの「消す」）。**行頭の印と地図のピンは同じ図形を使う**（`components/PinMark/PinMark.tsx`が中身・面・色を持ち、地図側は
  Markerへ渡す要素へ中身をportalで描く）——同じものを2箇所で描くと、片方だけ直したときに
  行とピンが違う見た目になる。動かした直後のclickは読み飛ばす（`bindDragAwareClick`）——同じ操作の
  終わりにclickが飛ぶため、動かしただけで選び直しや小窓が起きてしまう。
- **詳しくには住所・施設の名前を打てる欄**を置く（探す欄を別に設けず、地点の所で打てるほうが動線が単純）。
  打ち方・引き方・候補の行は下記「住所・施設で探す」のとおりで、候補は欄のすぐ下に出し、押すとその地点として置く（置いた経由地は
  その経由地を置き直し、新しい経由地なら足して、足した経由地の詳しくを出す）。広い画面では、候補が出たら欄をパネルの上端へ送り（ページは
  送らない）、一覧は自分で高さを限らずパネルのスクロールだけで読む。**狭い画面では、欄を押してから選ぶ・✕・Escapeで閉じるまで、欄と候補（保存した地点も）を
  いま見えている範囲の上側に重ねて出し**、候補はキーボードの上までの中で送る。上側へは欄のあった位置からせり上がって開く
  （一瞬で地図が消えると驚く。動きを減らす設定の端末では動かさない）。閉じる✕は見出しの行に置く。閉じるとシートに戻る——シートの中では、
  欄の下の候補がシートの下端とキーボードの裏に入る（キーボードは見える範囲だけを縮め、fixed の部品をその場に残す）。出す候補の有無では
  上げ下げせず、出す物が無い間は見出しと欄だけを出す（打つ途中で欄が上側とシートを行き来しない。打ち方は欄の中の案内で足りる）。上側に出している間は地図が
  隠れているので、地図で置く待ちでも欄の空の案内に地図で置く案内を出さない。欄は同じ要素のまま
  動かす（作り直すとキーボードが閉じる）。地図で置ける間は、欄の空の案内を「地図をタップ」にし（新しい経由地は置いた件数を添える）、
  詳しくの枠を強調色にする。消す・「現在地に戻す」は欄と同じ行に並べ、入らなければ操作を次の行へ送る（詳しくの高さを抑え、スマホのシートで
  地図を広く残す）。どれもパネルの他の操作と同じアイコンだけの形（[デザイン基盤](frontend-design-system.md)「5-1」）で、消すは保存したものを
  消すのと同じごみ箱、「現在地に戻す」は地図の現在地のボタンと同じ形。消す・「現在地に戻す」・地点の保存は、要らない間（置いていない・
  出発地が今の現在地にある）も出し入れせず押せない形で残す（デザイン基盤「5-2」）。
- **地図で置く**: 地図を押したときの意味は効いているパネルが決め（[ページ全体構成・状態管理](page-composition.md)「地図を押したときの意味」）、
  「ルート設定」の「条件」タブが効いている間だけ、押した所へ選んでいる地点を置く（`useGenerationConditions.ts: placeAtSelected`）。
  道の上を目的地にしたいこともあるので、道・ルートの線は開かずに置く。置いた後も選んだままにするので、続けて押すとその地点を置き直す
  （生成後に目的地を変えたいとき、消してから置き直す2段階を踏ませない）。役割を選ぶ操作を別に持たない——地点の詳しくを見ていることが、
  地図で置く地点を選んでいることになる。
- 出発地の詳しくにも操作が出るため、**動かせること自体が画面に現れる**（地図のマーカーを
  ドラッグしても動かせるが、それだけだと画面に手掛かりが無い）。「現在地に戻す」は現在地を取り直して出発地もそこへ置く
  （`hooks/useLocation.ts: useLocation`の`resetOriginToCurrent`。地図の「現在地に移動」は出発地を変えない）。
- **経由地は生成が受け付ける数まで**（生成物`route-generate-config.json`の`max_waypoints`。backendの
  `domain/route_request.py: MAX_WAYPOINTS`。達したかの判断は`useGenerationConditions.ts: waypointsFull`）。達したら地図を押しても足さず、
  足す（＋）と新しい経由地の打つ欄と、保存した地点の「経由地に足す」を押せなくして、上限まで置いてあると名前で伝える（置いた経由地を選んで消すことはできる）。超える点を置かせると、生成を押して初めて断られる。
- **置いた経由地と目的地は、並びの右の「経由地と目的地を全部消す」で一度に消せる**（`RoutePoints.tsx`。パネルの操作と同じアイコンだけの形で、
  アイコンは消す対象の地点のピンにバツを添えたもの）。出発地は残す——出発地は自宅・駅など決まった所に置いて行き先だけを試し直すことが多く、
  消すたびに置き直させない（戻すなら出発地の「現在地に戻す」）。周回の間は並びに出ている経由地だけを消し（名前は「経由地を全部消す」）、
  覚えている目的地は残す（見えない物を消さない）。消すと選んでいる地点も出発地に戻す（`useGenerationConditions.ts: clearPoints`）。
  すぐ置き直せるので確認の窓は通さない。消すものが無い間も押せない状態で残す（置き場が動くと、
  並びの両端の名前の出し分けが揺れる）。生成したルートは消さない（次に生成すると置き換わる）。
#### 名前のある点を押して置く

地図で地点を置ける間に名前のある点（立ち寄り先・補給のコンビニ等。点の宣言が名前のプロパティを持つもの）を押すと、選んでいる地点を
その点の位置（押した所ではなく点そのもの。押した所は絵の端のことがある）へ置き、その点の名前を付ける——地図で見つけた所を、探し直さずに
そのまま置ける。置いた点は住所・施設で探して選んだ施設と同じ形（`useGenerationConditions.ts: placeAtSelected`が候補として覚える）なので、
並びの番号・地図のピン・詳しくの名前と辺りは、ほかの入口で置いたものと同じに出る。点の中身（事実の小窓）はパネルを閉じて見る。

#### 住所・施設で探す（`PlaceSearch/usePlaceLookup.ts`・`PlaceSearch/PlaceCandidates.tsx`）

地点は地図のタップのほかに、住所か施設（立ち寄り先の表のお店・施設）の名前で探して置ける（[地点の検索（backend）](../backend/place-search.md)）。探す欄は
**押した地点の詳しくの中**（上記「詳しくには住所・施設の名前を打てる欄」）で、地図の上に別の欄を置かない——探す欄と置く所が
分かれると行き来が増え、狭い画面で欄が1つ地図を狭める。詳しくは
「条件」タブの中にあるので、探して置けるのはその詳しくを見ている間だけになる——ほかの面を見ている間に置けると、
置いたピンをつかんで直せない。

- **打ちかけでも、打つのが止まってから引く**: 空白を除いて生成物`route-generate-config.json: place_prediction_min_length`文字から、
  最後に打ってから`place_prediction_delay_seconds`の間を置いて引き、口が足す入力の続きの候補も同じ一覧に出す。打つたびには引かない
  ——口の回数制限はこの間から決まる（[地点の検索（backend）](../backend/place-search.md)）。かな漢字の変換中は引かず、確定してから
  間を置く。Enter はすぐ引く。引き直す間は前の候補を出したままにする（一覧が「探しています…」と入れ替わってちらつかない）。
  欄の文字が引き始める長さに足りなくなったら（消したとき）、候補をすぐ下げる——打った文字に合わない候補を残さない。
- **引くときに地図でいま見ている所の真ん中を渡す**（`useMapView.ts: center`。地図は出発地を真ん中にして開くので、地図が範囲を
  知らせる前は出発地）。口は住所を同じ段・同じ当たり方の中で、施設を同じ当たり方の中で、そこから近い順に並べる（並びの全体は
  [地点の検索（backend）](../backend/place-search.md)の「住所の並び」「並び」）——同じ名前の住所やチェーンの店でも、見ている辺りのものが上に出る（出発地ではなく
  地図の真ん中にするのは、地図を動かせば行きたい辺りを選べるため）。真ん中は引いた時点のものを使い、引いたあとに
  地図を動かしても引き直さない（選んでいる最中に並びと距離が変わらない。動かすたびに引くと回数制限に近づく）。
- 候補の行は表示名と、引いたときの地図の真ん中からの直線距離（住所・施設のどちらも。0.1km 単位。`lib/geoDistance.ts: haversineKm`。道に沿った距離は
  ルートを引かないと分からず、検索の待ちが延びる）と、種類・当たった段の札（「住所」「字・丁目」「街区・地番」、施設は「施設」「地点」）を並べる。施設は表示名の後ろに辺り（「川口市元郷四丁目」）を
  名前より小さく控えめな色で添え、同じ名前のチェーンの店を見分けられるようにする（行は1行で、狭い幅では辺りの後ろから切れる）。名前は語彙の生成物（`vocabulary.ts`の
  `placeKinds`・`placeMatchLevels`）から読み、画面に持たない——種類を足しても行の形は変わらない。
- 置くと、地図のタップで置く状態は解く（次のタップで意図しない地点が置かれる）。地図はその地点を、地図の上に重なるもの（モバイルの下部の
  シート・地図の上の部品）を避けた見えている所の中ほどへ寄せる（`app/page.tsx`が置いた地点を`MapView`の`focusPoint`へ渡し、
  `features/map/MapView/mapCamera.ts: flyToVisible`がルートを収めるときと同じ覆いの測り方で寄せる）——シートの陰に寄せると、直すピンが見えない。
- **住所の位置は当たった区画（街区・地番まで当たればその街区・地番）の代表点で、行きたい所そのものではない**（施設はその施設の位置）。区画（都道府県から字・丁目まで）で当たった住所を置いたときは、
  詳しくにそう出す（上記「地点の指定」。`PlaceCandidates.tsx: isRepresentative`。どの段が区画かはbackendの語彙`vocabulary.placeMatchLevels`の`area`が持つ）。街区・地番は番地まで当たった点なので出さない。ピンを直すのは地図のタップで置いたピンと同じドラッグ（上記）。
- 対象範囲を読めない等で口が使えないときは口の文（「対象範囲を読めませんでした」）を、当たらないときは「当たる住所・施設がありません。」を
  打つ欄の下の候補の所に出す。
