# 地図: レンズ・ルート色分け（frontend）

## 責務

地図のレンズ（総合と費用の軸ごと。どれも道を1kmあたりの代償の秒で塗る）を、(1) ルート確定前は視界内の全道路（レンズの線）、
(2) ルート確定後は選択中ルートの線、それぞれ地図上で色分け表示する。ルート確定前に道を塗る値は、backendが費用の軸の一覧
（`GET /api/cost-axes`の`map_lens.formula`）で配る式の木へ、レンズのタイル（`GET /api/region/lens-tiles/{lens_id}/{z}/{x}/{y}.pbf`。
路面タイルと同じ道の形に道ごとの材料を焼いたもの）の材料と走る条件（向き）を入れて地図が求める
（[レンズ・道ごとの値の配信（backend）](../backend/dynamic-way-values.md)）。

**対象ファイル**

| ファイル | 責務 |
|---|---|
| `lib/mapDisplay/mapLens.ts` | 地図のレンズの形（`lib/mapDisplay/mapLens.ts: MapLens`。id・名前・説明・アイコン・値が変わる走る条件・材料の要求へ載せる条件・塗る段・式の木） |
| `lib/mapDisplay/routeStyleModes.ts` | ルート確定後の色分けモードの形（`lib/mapDisplay/routeStyleModes.ts: RouteStyleMode`）と、段で塗るモードの組み立て（`lib/mapDisplay/routeStyleModes.ts: buildRangeSteppedMode`）・未選択のレンズのid・区間の地物が1kmあたりの代償の秒を持つ欄の名前（下記「routeStyleModes.ts」） |
| `features/map/costLens.ts` | 費用の軸の一覧から、地図のレンズ（`features/map/costLens.ts: costLenses`）・レンズの選択肢（`features/map/costLens.ts: costLensOptions`）・ルートの線のレンズのモード（`features/map/costLens.ts: costRouteStyleModes`。区間の1kmあたりの代償の秒を地図と同じ段で塗り、レンズを選んでいないときは総合で塗る）を導く |
| `features/map/mapCatalog.ts`・`features/map/useMapCatalog.ts` | 画面の設定と費用の軸の一覧のうち、地図だけが読むもの（`features/map/mapCatalog.ts: MapCatalog`。レンズ・ルートの線のモード・事故の収録年・較正値・道の線の層・地図に載るものの一覧）。届くまで・失敗の間はどれも無い |
| `lib/mapDisplay/costLensPaint.ts` | 費用のレンズの段の塗りの宣言（`lib/mapDisplay/costLensPaint.ts: costLensPaint`）と、レンズの値と事実の数の書き方。地図の道・ルートの線・候補の帯・道の窓が同じ段と同じ書き方にする |
| `hooks/useCostAxisCatalog.ts` | 費用の軸の一覧（`GET /api/cost-axes`）を画面が読む形で共有する取得（`services/costAxisCatalogApi.ts: getCostAxisCatalog`） |
| `lib/mapDisplay/valueScale.ts` | 地図が値を塗る宣言（`lib/mapDisplay/valueScale.ts: MapPaintDeclaration`）・段の並び（`lib/mapDisplay/valueScale.ts: valueBands`）・値が段に入るかの式（`lib/mapDisplay/valueScale.ts: bandCondition`・`lib/mapDisplay/valueScale.ts: bandStep`）・数の値が入る段（`lib/mapDisplay/valueScale.ts: bandAt`）。ルート前の道の線・ルート後の色分け・凡例・候補の帯が共有する（下記「valueScale.ts」） |
| `features/map/scene/groups/axisLines.ts` | ルート確定前にレンズの値で道を塗る線の宣言。塗っているレンズのタイルのソースと、値のある道の段の色の実線・値の無い道の破線（下記「レンズの線」） |
| `features/map/scene/wayValueFormula.ts` | 式の木をMapLibreの式へ置き換える唯一の所（下記「レンズの線」）。木の中身は持たず、節の種類ごとの置き換え方だけを持つ |
| `features/map/layers/dynamicWayValues.ts` | 押した点を含む道路タイルの選び方（地図のズームをタイルのある範囲へ丸める）。道の窓が押したタイルを名指すのに使う |
| `features/map/layers/webMercatorTile.ts` | Web MercatorのXYZタイルと緯度経度の行き来（点のタイル座標・点を含むタイル（世界の端はタイルの番号の範囲へ寄せる）・タイルが覆う範囲）。backendと同じ式で、一致は表の組`region`で照らす。道路タイルの値を引くタイルと、気象庁のタイルの在否の判定（`jmaTileIndex.ts`）が同じ式を通る |
| `lib/mapDisplay/mapColorLegend.ts` | 地図上の色分け凡例（`lib/mapDisplay/mapColorLegend.ts: MapColorLegendBand`型・`lib/mapDisplay/mapColorLegend.ts: buildRangeLegendBands`・`lib/mapDisplay/mapColorLegend.ts: rangeStepLabel`）の共通ロジックと、値が無い行（`lib/mapDisplay/mapColorLegend.ts: NO_DATA_LEGEND_BAND`）。凡例を作る関数（`features/map/view/lens.ts`）・道の属性の凡例（`features/map/scene/legends.ts`）が使う |
| `features/map/view/lens.ts` | レンズの凡例（`features/map/view/lens.ts: lensLegend`。ルート後はルートの線のモードの凡例） |
| `features/map/LensControl/LensControl.tsx` | レンズ（地図を何で塗るか）の唯一の入口。画面での名前は「難所を色で見る」（見出し・読み上げ名。「レンズ」はコードの中の名前で、画面には出さない）。地図の上のピルが、道のりのグラフの「難所を色で見る」の切り替えと同じ筆の絵（`lucideIcons.tsx: BurdenPaintIcon`）と、選んでいるレンズの名前と色の帯（段の数に依らない固定の幅）と、帯の右に一番濃い段の名前（その値から一番濃い色）を示し、タップで縦の一覧（各行にアイコン・(i) の説明）を開く。一覧は「表示」の一覧（`MapOverlayControls.tsx`）と同じ形と操作にそろえる——選んでも閉じず、選んでいる行をもう一度押すと外れ、一覧の頭に塗りの但し書きを出し、下に「選択を外す」を置く。凡例は持たない（段は事実で細かく刻むので、ピルの帯と右端の値で見せ、道の値は道を押した窓に出す）（選択肢・凡例は`features/map/view/useMapView.ts`が組み立て、`app/HomeMapPane.tsx`はそのまま渡す）。走行中も同じ大きさで出す |
| `features/map/LensControl/LensRow.tsx` | 一覧の1行（`features/map/LensControl/LensRow.tsx: LensRow`）と選択肢の型（`features/map/LensControl/LensRow.tsx: LensOption`）。行の (i) の開閉は「表示」の一覧の行と同じ部品（`features/map/LegendCheckboxList/LegendRow.tsx: useRowDescription`）を使い、チェックの代わりに1つだけ選ぶ印を出し、(i) で説明を、▶（選んでいる行だけ）で凡例を行のすぐ下に開く |
| `lib/lensLink.ts` | 走る条件のボタン（地図の向きの方位磁針・出発時刻・想定速度）に付ける、いまの周りの道の塗りがその条件で決まっている印（輪と読み上げ）。下記「周りの道の色が拠る走る条件」 |
| `features/map/layers/mapLayers.ts` | レンズの層（`features/map/layers/mapLayers.ts: isLensLayer`。記述子の印で判定。地図上チップの一覧`overlayChips`が除くのに使う） |
| `features/map/MapView/MapView.tsx`（レンズの線の箇所のみ） | 画面の状態を宣言の入力へ渡すだけの配線（下記「MapView.tsx側の配線」）。レンズごとの処理は持たない |
| `features/map/scene/groups/routes.ts` | 色分け線そのものを引く側。レンズの配色式・凡例フィルタを受け取ってMapLibreの線レイヤーへ流す |
| `features/map/lensTiles.ts` | 塗っているレンズのタイルのURL（レンズが依る条件と利用者の値を載せる。下記「lensTiles.ts」） |
| `features/map/useTimeFrames.ts` | 時刻で変わる値のコマの一覧（backend `GET /api/region/time-frames`）を読み直しながら持ち、出発時刻を含むコマの印を値の種類（路面タイル・レンズ）ごとに選ぶ。要求には時刻ではなくこの印を載せる |
| `features/map/regionApi.ts`（`features/map/regionApi.ts: lensTileUrl`・`features/map/regionApi.ts: fetchRoadInspection`） | backend APIラッパーとタイルのURL |
| `features/map/MapView/RoadInspectorPopup.tsx` | 道を押したときの窓。開いたら道の難所を取りに行き、地図が塗っている向きの区間の合計と難所のある軸ごとの秒を、区間の小窓と同じ1行（`components/MapPopup/PenaltyBreakdown.tsx`）で並べる。「秒／換算前」の切り替えで、軸ごとの秒の元の事実（backendが名前と単位を付けたもの。区分の事実は区分の名前だけ）に替える。向きは地図が塗っているレンズの塗り方で選ばせる。出発時刻の風のコマが無ければ、今の風で求めずに風を読まないで取らせ、風に依らない難所だけを合計なしで出し、風に依る難所と合計を出せないことを1行で言う。属性は畳む |

**`MapView.tsx`は路面タイル・動的気象（降水/雷/竜巻）・POI等のロジックも持つ
ファイルで、それらは[地図: 静的レイヤー・道路表示](static-map-layers.md)・
[地図: 動的気象レイヤー](dynamic-weather-layers.md)の管轄。本ドキュメントはレンズの線と
ルート確定後の色分け（DETAIL_LAYER_ID）に関わる箇所のみを扱う。**

## ルート確定前後で同じスケール（表示は複数、表示宣言は1つ）

```
ルート確定前  ── レンズの線 ──────────────┐
              （式の木×道ごとの材料×      │
               走る向きを地図が求めた値） ▼
                                   同じ塗る宣言（境界・単位・段階ラベル）
                                            ▲
ルート確定後  ── RouteSegmentDetailの ──────┘
              1kmあたりの代償の秒
```

どのレンズも1kmあたりの代償の秒で塗り、段の境目はその軸（総合はその総合のレンズ）の`lens`（`thresholds`と`band_labels`）。
塗る宣言は`lib/mapDisplay/costLensPaint.ts: costLensPaint`だけが作り、ルート前の線・ルート後のモード・凡例・候補の帯が
同じ宣言を`valueBands`へ渡す。

- **同じ塗りの部品を通す**: レンズは費用の軸の一覧から`features/map/costLens.ts: costLenses`が組み、地図の一覧
  （`features/map/useMapCatalog.ts: useMapCatalog`）に載る。式の木（backendがレンズごとの`map_lens.formula`で配る。走行方位で変わらないレンズは向きを選ばない木）・段・
  凡例・取得の状態はどのレンズも同じ部品が持つ。
- **段**: backend が色の物差しを事実の値で刻んで配る段（名前は事実の値の範囲）をそのまま塗る。その道の本当の事実は道を押したときの窓に出す。
- **ルートの線**: backendは区間に代償の内訳（`penalty`）と、地図のレンズと同じ量（`lens_seconds_per_km`。レンズid→1kmあたりの
  代償の秒）を載せる。ルートの線のモードはこの値を地図と同じ段で塗る。長さ0の区間は値を持たず、「データなし」の破線になる。
- **一覧が届く前**（ルートの線のモードが0件の間）と**数える軸が1つも無い間**は、ルートの線を値に依らず中立色の1色で引く
  （`features/map/scene/sceneInputs.ts`）。何も数えていないのに総合で塗ると、評価して1色になったように読める。

## レンズの選び方

レンズの選択肢は総合と費用の軸の順（`features/map/costLens.ts: costLensOptions`）。利用者が無効にした軸のレンズは選択肢に無い
（`features/map/view/useMapView.ts`が一覧を絞る。選んでいた軸を無効にすると選んでいない状態で塗り、無効を戻すとまた塗る）。
数える軸が1つも無い（全体のつまみを無効（0）にしたか、全部の軸を無効にした）なら、総合も数えないので、総合を含めてどのレンズも
選択肢に無く、凡例も出さない（`features/map/view/useMapView.ts: totalCounted`）。軸を数えるかは利用者の値だけで決め、生成の側
（`backend/app/domain/cost_preference.py: CostPreference.counts`）も同じ値から同じ答えを出すので、較正値を画面へ配らない。
**レンズを選んでいない状態は`UNSELECTED_LENS_ID`で表す**: ルート前は道を塗らず（ピルは画面の名前の短い形`lib/screenNames.ts: BURDEN_PAINT_SHORT_NAME`を出し、読み上げは画面の名前`lib/screenNames.ts: BURDEN_PAINT_NAME`）、ルート後はルートの
線を総合のレンズで塗る（ピルは費用の軸の一覧の総合の名前）。塗らない選択肢は持たない——レンズを選ばないことで表せ、ルートの線は「表示」で消せる。

**周りの道の色が拠る走る条件は、その条件を決めるボタンに印を付けて見せる**（`features/map/view/useMapView.ts: lensConditions`を
`app/HomeMapPane.tsx`が地図の右の列の方位磁針・出発時刻・想定速度のボタンへ渡し、ボタンは`lib/lensLink.ts`の輪と読み上げを付ける）。
周りの道を塗っている間、そのレンズが変わる条件（`MapLens.conditions`。材料の要求へ載せる条件と、式の木の条件の節が読む条件）の
ボタンにだけ付ける。走る向きは走行中の進む向きだけを木へ渡すので、方位磁針の印も走行中だけ付く（ルートの前は木がどの道も
両向きのきつい向きで塗り、地図を回しても色は変わらない）。走行中の進む向きは保存されない——印が無いと、見えない条件で同じ道の
色が変わる。

**レンズ状態は1つ**（`features/map/view/useMapView.ts: lens`。localStorageキーは`ridecompass:route-style-mode`。選択肢に無い値は
`UNSELECTED_LENS_ID`へ戻す——費用の軸の一覧が届いてから読み直す）。ルート前は全道路、ルート後はルート線をこの1つの値から
導く——地図へはレンズと周りを出すか（`surroundingsShown`）を渡し、どのレンズの線を出すかは地図側（`scene/sceneInputs.ts`）が
導く。道ごとの材料は塗っているレンズの分だけ取り（`useMapView`）、塗っていないレンズの材料は取らない。ルート後も全道路の塗りを
残すかは「表示」の「範囲と色」の表示する範囲（既定はルート沿い。点の層も同じ切り替えに従う）。ルートの線はいつも出す。
レンズは生成リクエストに載らず、切り替えてもルートを作り直さない。
**レンズは代償の秒で塗り、場所の事実（点・面）は「表示」の一覧が出す**（レンズは「表示」の一覧のレイヤーの入切を変えない
——片方を選んだ副作用でもう片方の状態を残さない）。

**タイルへ焼くのは材料タグ（生の属性）までで、代償の秒は別の口で取って実行時にブラウザの式へ組む。** 最終値をタイルへ焼くと、
費用の軸を1本調整するたびに全域のタイルを作り直すことになる。

## valueScale.ts（ルート前後で共有する葉モジュール）

- `MapPaintDeclaration`: 地図が値を塗る宣言（`{ground, boundaries, unit, bandLabels}`）。`costLensPaint`だけが作る。
- `valueBands(paint)`: 塗る宣言から求める段の並び（低い段から、段ごとに鍵・下限・範囲の文字・色）。体感ラベルは件数が段の数と
  合うときだけ範囲の前に添える（`mapColorLegend.ts: bandLabelsForBandCount`）。**件数が段階数と合わないラベルは添えずに捨てる**
  ——ずらして添えると最上位の段階のラベルが実際より狭い範囲を指す嘘になる。
  **ルート前の道の線（`scene/sceneInputs.ts`）・ルート後のルート線（`routeStyleModes.ts`）・凡例（`features/map/view/lens.ts`）・候補の帯
  （`bandAt`）がすべてこの1つの関数を通る**ため、同じレンズの同じ段はどこでも同じ鍵・色になる。
- `bandCondition(bands, index, value)`: 値（MapLibreの式）が段に入るときに真になる式（`>= 下限`・`< 次の下限`）。
  ルート後のルート線の色はこれで段を引き、ルート前の道の線の色は下の`bandStep`で引く。どれも
  `>= 下限`で分けるので、**境界ちょうどの値はどこでも上の段に入る**。値が無い場合は呼ぶ側が先に分ける（欠損との大小比較は評価時エラーになる）。
- `bandStep(bands, value, output)`: 値が入る段の出力を、値を1回だけ読む`step`で選ぶ式。ルート前の道の値の式は木を
  置き換えた大きな式で、MapLibre は式を読む所ごとに写して運ぶため、段ごとに値を読む`bandCondition`を使わない。
- `bandAt(bands, value)`: 数の値が入る段。地図の外の部品（「ルート結果」の候補のカードの帯）が地図と同じ段の色を引く口で、
  判定は`bandCondition`と同じ`>= 下限`・`< 次の下限`。
- **配色**: 段の色は評価の配色（緑→黄→赤→暗赤。中継点の色はbackendの`SEMANTIC_COLORS`の`evaluation_*`）の上にHSL色空間で
  置く。固定の色配列を持たないため、しきい値の個数が変わっても色が自動追従する。**緑は一番下の段だけ**——2段目から上は緑と黄の
  中間から暗赤までを均等に分ける。全部の段を均等に置くと、段が細かいほど下の数段がどれも緑に見え、「楽」に見える道が増える。
  **色相だけでなく明度も動かす**（良い・悪いの2色を色相だけで補間すると、隣の段が見分けにくい）。配色は1組で、どのレンズも同じものを使う。

## レンズの線（`scene/groups/axisLines.ts`）

ルート確定前に道を塗る線は、塗っているレンズのタイル（backendが路面タイルと同じ道の形に、道ごとの材料をプロパティで焼いたもの）を
1つのソースで読み、式の木を置き換えた地図の式で道ごとの値を求めて描く。線は、値のある道の段の色の実線（レイヤーの役割はレンズの
id）と、値の無い道の破線（役割は`<レンズのid>-no-data`）の2本で、どちらも値の有無の絞り込み（`filter`）で道を分ける——1本の道は
どちらか一方の線だけに入る。**道の値は、地図がタイルを読むとき（描画の裏の処理）に求める**——材料を画面のコードから道ごとの地図の
状態（feature-state）へ置くと、置くたびに地図が画面に入っている全部のタイルの描く配列を道ごとに書き直し、レンズの値が届いた直後と、
ズームで取るタイルの段が変わるたびに地図が止まる。

- **木が読む走る条件は、式へ値として埋め込む。** 条件を変えても材料を取り直さず、式が変わるので、地図がそのソースのタイルを
  描画の裏の処理で読み直して塗り直す。材料の要求へ載せる条件（時刻・想定速度）が変わると、タイルのURLが変わって取り直す。
- **走る条件は段に丸めてから置く。** 走る向き（走行中の進む向き。走っていなければ置かない）を[0, 360)の
  `features/map/mapHeading.ts: WAY_BEARING_STEP_DEG`刻みへ、走行中の速さは`features/ride/useRideWayConditions.ts: RIDING_SPEED_STEP_KMH`
  刻みへ丸める。丸めないと、向き・速さが揺れるたびに塗り直し・取り直しになる。
- **式の木を地図の式へ置き換えるのは`scene/wayValueFormula.ts: wayValueExpression`だけ。** 値の無いことはNaN
  （`["/", 0, 0]`）で表し、木の値の約束（backend `domain/way_value_formula.py`の先頭）に合わせる。丸め（`round`）と
  折れ線（`interpolate`）は、MapLibreの同名の式を使わずに書く——MapLibreの`round`は中点を0から遠い側へ倒し、`interpolate`は
  NaNで評価が止まり計算の順もnumpyと違う。段の境界で色が分かれるので、最下位の桁のずれがbackendと違う色になる。
  backendと同じ値になることは、backendが出す表（`types/generated/way-value-expectations.json`）を
  `scene/wayValueFormula.test.ts`が通して確かめる。
- **置き換えた式は、材料を読む所を少なく保つ。** MapLibreは`let`で束ねた式を、`var`で読む所ごとに評価し、描画の裏の処理へ
  運ぶときも読む所ごとに写す。節が引数を読む所の数（場合分けのどの枝も含む）は入れ子の深さだけ掛け合わさるので、
  大きな木で読む所が多いと、式を運ぶ間に画面が止まりページが落ちる。節の種類ごとの上限は`scene/wayValueFormula.test.ts`が見る。
- **値が無い道は段の色で塗らず、「データなし」の色の薄い破線（`mapDisplay.noDataDash`）で描く。** 式の値がNaN（読む材料が欠ける）の
  道が該当する。タイルはどの道も道の形で持ち、材料の無い道は道の鍵だけを持つ。破線の刻み（`line-dasharray`）は道ごとの
  プロパティを読めるが、線を分けるのは絞り込みで道を分ける方が式が1つで済むため。
- **レンズのタイルが届くまでは、その範囲にレンズの線を描かない。** 取得中であることは、レンズのピルの状態ドットに出す（下記
  「lensTiles.ts」）。
- **値が無い道は薄く、値を持つ道は濃く塗る**（濃さは源泉が配る`mapDisplay.road.unknownOpacity`/`knownOpacity`をそのまま使い、
  地図全体の「薄い＝対象外、濃い＝分類あり」という読み方に揃える）。

## routeStyleModes.ts（ルート確定後）

- `buildRangeSteppedMode`: 塗る宣言の境界の**長さがそのまま段階数を決める**汎用関数。ラベルは`valueBands`が凡例の目盛りの
  境界の数字から機械的に生成し、体感ラベルを持つ段ではその前に添える（ルート前の凡例と同じ規則）。モードは
  `features/map/costLens.ts: costRouteStyleModes`が、未選択（総合で塗る）・総合・軸ごとに組む。

**ルート確定の前と後は同じ段で塗る**（どちらも同じレンズの`lens`の境界）。同じ理由で段の識別子も前後で共通
（`mapColorLegend.ts: legendBandKey`＝`step-N`、値を持たない道の受け皿は`LEGEND_NO_DATA_KEY`）。値を持たない道・区間の行は、
道の属性の凡例も含めてどこでも`mapColorLegend.ts: NO_DATA_LEGEND_BAND`の1行（「データなし」）で、前後で呼び方が変わらない。

値を持たない区間（「データなし」）はルート前の道と同じく破線で描く。モードは色の式と同じ「値が無い」の判定を
`noDataExpression`として持ち、区間の線（役割`detailLine`）がそれで破線にする。

段の範囲を文字にするのは`mapColorLegend.ts: rangeStepLabel`だけ。**語は述語に合わせる**——
境界の判定は`>= lower`・`< upper`のため、最上位帯は「以上」であって「超」ではない。
- **候補は地図では選ばない**: 未選択候補の線（役割`candidateLine`、細い参考線）は当たり判定を
  持たず、押すと下の道の詳細が開く。候補の切り替えは一覧のタブだけで行う——複数の候補が同じ道を
  通る所で、区間の詳細を見ようとして別の候補へ切り替わらないようにする。ルートの当たり判定は
  選択中候補の区間（役割`detailHit`）と乗り換えの帯（役割`spliceBandHit`）だけで、押した所で一番上に
  描かれた地物だけを開くので、ルートの上を押しても下の道のポップアップは開かない。
- **地図上の重ね順**（`scene/groups/routes.ts`が背面から前面の順に宣言し、
  `applyMapScene`がその順へ当てる）:
  選択中候補の区間色分け線（役割`detailLine`、不透明）とその縁取り
  （役割`detailCasing`。幅は源泉の`mapDisplay.route.lineWidthsPx`/`casingWidthsPx`）・当たり判定線
  （役割`detailHit`、指の接地面ぶんの幅で透明）は、同じ候補の進行方向矢印
  （役割`arrowHalo`→`arrow`、`routeArrowIcon.ts`）より常に下に置く。
  矢印層はページ表示直後に、色分け線は最初の生成後に作られるため、作成順に任せず
  「縁取り→色分け線→当たり判定線→矢印ハロー→矢印」の順を両方の作成時に明示する。
  縁取りの色（`palette.semantic.route_casing`）はレンズ配色にも背景にも依存しない一定の暗色
  ——線の色と同系色の面レイヤー（災害・降水・標高図等）が背景に来ても輪郭が残るようにする
  ため。凡例で非表示にしたカテゴリの縁だけが残らないよう、縁取りには色分け線と同じfilterを適用する。矢印2層は
  衝突判定を無効（`icon-allow-overlap`/`icon-ignore-placement: true`）にしてある——
  MapLibreは上のレイヤーから順にシンボルを配置するため、衝突判定を有効にすると主層の矢印と
  同位置・大きめのハロー層が全て落ち、色分け線が紺系の段では同色の矢印が線に沈む。
- **選んだ区間の範囲の縁取り**（役割`selectedSection`）は、ルートの段のいちばん後ろに置く。選んでいる候補の縁取り
  （役割`selectedHalo`）より太い半透明の線で、どのルートの線にも隠されない外側へはみ出た所で範囲を示す（中身は
  [ルート設定・結果パネル](route-settings-and-results.md)「区間クリック詳細（selectedRouteSegment）」）。
- **走り終えた所は薄める**: 走行モードの間、選択中候補の区間を走り終えた地点（刻みへ切り下げる）で分け、手前の色分け線と縁取りを
  `mapDisplay.route.opacities.travelled`の濃さにする（区間の属性`travelled`で見分ける）。距離の決め方はpage-composition.md「走行モード」。
- **進行方向の矢印は、本体を白・縁を濃色にする。** 区間の色分けは段で変わるため、線と同系色になりうる有彩色を本体に使わない。
  濃色の縁が線と基礎地図の双方から矢印を切り離す。
- **矢印の大きさはズームに追従させる。** 画面上の固定ピクセルのままだと、拡大するほど周囲の
  道路が太く描かれる一方で矢印だけが相対的に小さくなり、目立たなくなる。
- **選択中候補のハローは、候補線より下に敷く。** ハローは「いまどれを選んでいるか」を背後から
  示すもので、候補線より前へ出すと薄い暗色が線にかぶり、レンズの配色が濁る。
- **当たり判定どうしの前後は、重なった場所で押したときにどちらが勝つかで決める。** 区間の
  当たり判定は太く（幅24px）ルート全体を覆うため、乗り換え区間の帯の当たり判定はその前面へ
  置く——後ろだと帯を一度も押せない。

## lensTiles.ts（レンズのタイルのURL）

塗っているレンズ1つのタイルのURLを、走る条件（時刻のコマ・想定速度）と利用者の値をそれぞれデバウンス（500ms）してから組む
（`features/map/lensTiles.ts: useLensTileUrl`）。要求には、レンズの材料の要求へ載せる条件（`MapLens.materialConditions`）と、
利用者の値（つまみと倍率。総合のレンズは全部の軸の倍率、軸のレンズはその軸の倍率だけ。`lib/costPreference.ts: lensPreferenceQuery`）
を載せ、ほかを変えても取り直さない（色は地図が式で求め直す）。表示範囲のどのタイルを取り、取ったタイルをどれだけ持つかは
地図ライブラリが決める。時刻に依るレンズは、コマの一覧が届くまでと、出発時刻のコマが無い間はURLを作らず、線を出さない。

**取得の状態**: `useMapView`が、レンズのタイルのソースの読み込みの状態（ほかのタイルの層と同じ`MapView/useLayerDataStatus.ts`。
情報源は`lens`）から`LayerDataStatus`を1つ選び、`LensControl`のピルへ小さな状態ドット（`ui/Dot`。地図上チップと同じ視覚表現）として
表示し、その意味をポップオーバーの見出しの下へ文として出す（`title`はスマホで出ないため）。出発時刻の風のコマが無ければ失敗、
コマの一覧を待つ間は読み込み中にする。取得失敗の原因（429・通信エラー）は区別しない（[ページ全体構成](page-composition.md)
「失敗・空・待ちの伝え方」）。レンズの層は表示の切り替えの鍵を持たないので、塗っている間だけ状態の判定に入れる
（`MapView/useMapLifecycle.ts`）。

- 出発時刻のレンズのコマが前に出た予報の風の素性（`GET /api/region/time-frames`の`lens`のコマごとの`wind_previous_run_from`）を
  持てば、風に依るレンズでは、前に出た予報の風で塗っているとして、選んでいる行の ▶ の中に但し書きを出す。前の予報かは
  backend が決め、画面は時刻を丸め直さない。
- 古い印（409）で断られたタイルは、路面タイルと同じくコマの一覧を読み直す（`MapView/useMapLifecycle.ts`）。新しい印で
  URLが変わり、取り直す。

## MapView.tsx側の配線

レンズの線・材料は、他の地図の要素と同じく**宣言**（`features/map/scene/`）の一部で、
`MapView.tsx`は画面の状態を宣言の入力へ渡すだけである。レンズごとの処理・effectは持たない。

```
features/map/view/useMapView.ts
  ├─ 塗っているレンズ（周りを出す間の lens）
  ├─ 走る条件 = {bearing_deg: 走行方位（段に丸める）, speed_kmh: 想定速度}
  ├─ useLensTileUrl(塗っているレンズ, 出発時刻と想定速度, 利用者の値, 総合のレンズのid) → タイルのURL
  ▼
<MapView look={{ …, lens, surroundingsShown, lensTileUrl, wayConditions: 走る条件 }} .../>
  │   （レンズの一覧は MapView が地図の一覧の共有ストアから読む）
  ├─ sceneInputsFrom(...)（scene/sceneInputs.ts）が塗っているレンズの段（レンズのdisplayから）・式の木・タイルのURL・
  │   走る条件をレンズの線の入力へ移す
  ├─ buildMapScene → レンズの線（scene/groups/axisLines.ts）が、レンズのタイルのソースと線レイヤーを宣言する
  └─ applyScene → 前回の宣言との差だけを地図へ当てる（applyMapScene.ts。走る条件だけが変われば、線の式を当て直すだけ）
```

レンズの数に依らず、見え方の値はタイルのURL1つと走る条件だけを持つ（design-principles.md構造仕様3「軸ごとにpropを新設しない」）。

## 動的気象レイヤーとの関係

レンズの線（道路そのものを線で塗る）は、[地図: 動的気象レイヤー](dynamic-weather-layers.md)が扱う動的気象の描き方
（`scene/groups/weather.ts`）とは異なり、`mapLayers.ts: isLensLayer`により地図上チップ（`MapOverlayControls.tsx`）に一切現れない。
表示ON/OFFの起動導線は地図上部中央の`LensControl`のみが持つ（本ファイル冒頭「対象ファイル」参照）。

## 費用の軸を足したときに自動で追従する範囲

費用の軸を管理APIで足すと、frontend側は地図の一覧（`features/map/useMapCatalog.ts`）の`lenses`経由で以下がすべて自動で増える
（このモジュールのファイルを編集する必要は無い）。

| 追従するもの | 導出元 |
|---|---|
| `MapLayerId`・`MapLayerDescriptor`（地図UIからの除外を含む） | 地図の一覧の`layers`（`buildMapLayers`） |
| MapLibreのソース・線レイヤー・色式・濃さ・絞り込み | `scene/sceneInputs.ts: sceneInputsFrom`が`lenses`をレンズの線（`scene/groups/axisLines.ts`）の入力へ移す |
| 表示ON/OFF（レンズ選択） | レンズと周りを出すか（`useMapView`の`surroundingsShown`）から`scene/sceneInputs.ts`が導く |
| レンズのタイルのURLと載せる条件の取捨 | `lensTiles.ts` + 一覧のレンズごとの`map_lens.material_conditions` |
| 道の値の式 | 一覧のレンズごとの`map_lens.formula`（`scene/wayValueFormula.ts`が地図の式へ置き換える） |
| 塗る段・凡例・ルートの線のモード | `costLenses`（レンズの`display`）・`lensLegend`・`costRouteStyleModes` |
