// 生成物。`backend/scripts/export_openapi.py`が書き出す。手で編集しない。
export const mapDisplay = {
  "overlayGroups": [
    {
      "key": "road",
      "label": "道路",
      "initialItems": 3
    },
    {
      "key": "environment",
      "label": "天気と地形",
      "initialItems": 2
    },
    {
      "key": "spot",
      "label": "スポット",
      "initialItems": 3
    }
  ],
  "legendSharedRows": {
    "other": {
      "label": "その他",
      "description": "値は書かれているが、上のどの行にも当てはまらない道[まれな種類など]。"
    },
    "notApplicable": {
      "label": "該当なし",
      "description": "この種類に当たらない道[例: トンネルの凡例では、トンネルでない道]。"
    },
    "noData": {
      "label": "データなし",
      "description": "元にする地図のデータに値が無く、どの行にも分けられない道。道が無いのではなく、値が分からない。"
    },
    "undetermined": {
      "label": "向きで決まらない",
      "description": "地図の上の向き[走行中は進む向き]とほぼ直角に交わるため、値を決められない道[勾配なら登りか下りか]。\n・地図を回して向きが変わると色が付く。"
    }
  },
  "layerCategories": [
    {
      "key": "roadCondition",
      "group": "road"
    },
    {
      "key": "weather",
      "group": "environment"
    },
    {
      "key": "terrain",
      "group": "environment"
    },
    {
      "key": "disaster",
      "group": "environment"
    },
    {
      "key": "amenity",
      "group": "spot"
    },
    {
      "key": "trafficSafety",
      "group": "spot"
    }
  ],
  "layerDataSources": [
    {
      "key": "road_surface",
      "minZoom": 10
    },
    {
      "key": "poi",
      "minZoom": 12
    },
    {
      "key": "accident",
      "minZoom": 12
    },
    {
      "key": "stop_place",
      "minZoom": 12
    },
    {
      "key": "gsiRelief",
      "minZoom": null
    },
    {
      "key": "landcoverRaster",
      "minZoom": 6
    },
    {
      "key": "ownFetch",
      "minZoom": null
    },
    {
      "key": "msmGrid",
      "minZoom": 8
    }
  ],
  "layerDataNatures": [
    "raw",
    "dynamic"
  ],
  "layers": [
    {
      "id": "elevation",
      "label": "標高",
      "dataSource": "gsiRelief",
      "category": "terrain",
      "dataNature": "raw",
      "drawMinZoom": null,
      "description": [
        "土地の高さを色で見られます"
      ],
      "panelHint": null,
      "hideMissingRows": false,
      "segmentSeries": null
    },
    {
      "id": "landcover",
      "label": "緑と水",
      "dataSource": "landcoverRaster",
      "category": "terrain",
      "dataNature": "raw",
      "drawMinZoom": null,
      "description": [
        "畑・草地・林・水辺など、土地の使われ方を色で見られます"
      ],
      "panelHint": [
        "・ルートの結果の「緑と水」は道の周り",
        {
          "name": "landcoverRingOuterM",
          "before": "",
          "after": "m"
        },
        "の割合で、この塗りとは別です。"
      ],
      "hideMissingRows": false,
      "segmentSeries": "landcoverClass"
    },
    {
      "id": "stop_poi",
      "label": "信号・一時停止",
      "dataSource": "poi",
      "category": "trafficSafety",
      "dataNature": "raw",
      "drawMinZoom": 15,
      "description": [
        "止まったり減速したりする所[信号、横断歩道、一時停止、徐行、踏切、車止め・ゲート、ハンプ・狭さく]です"
      ],
      "panelHint": null,
      "hideMissingRows": false,
      "segmentSeries": null
    },
    {
      "id": "supply_poi",
      "label": "補給・休憩",
      "dataSource": "poi",
      "category": "amenity",
      "dataNature": "raw",
      "drawMinZoom": null,
      "description": [
        "コンビニ、飲料自販機、自販機(中身不明)、トイレ、給水、駐輪場の場所です"
      ],
      "panelHint": [
        "・「飲料自販機」は飲み物を売るもの、「自販機(中身不明)」は売るものが分からないものです。\n・コンビニはチェーンの店だけです。\n・閉店・撤去が反映されていないことがあります。"
      ],
      "hideMissingRows": false,
      "segmentSeries": null
    },
    {
      "id": "stop_place",
      "label": "立ち寄り先",
      "dataSource": "stop_place",
      "category": "amenity",
      "dataNature": "raw",
      "drawMinZoom": null,
      "description": [
        "飲食店、銭湯・温泉、自転車、景色・名所、宿、寺社の場所です"
      ],
      "panelHint": [
        "・寺社は国の文化財の建物を持つものです。\n・閉店にデータが追いついていないことがあり、現地と違う場合があります。"
      ],
      "hideMissingRows": false,
      "segmentSeries": null
    },
    {
      "id": "accident_point",
      "label": "事故の地点",
      "dataSource": "accident",
      "category": "trafficSafety",
      "dataNature": "raw",
      "drawMinZoom": 15,
      "description": [
        "交通事故の起きた場所です",
        {
          "name": "accidentYears",
          "before": "[",
          "after": "]"
        }
      ],
      "panelHint": [
        "・死亡事故は円を大きく表示します。"
      ],
      "hideMissingRows": false,
      "segmentSeries": null
    },
    {
      "id": "precipitationNowcast",
      "label": "雨雲",
      "dataSource": "ownFetch",
      "category": "weather",
      "dataNature": "dynamic",
      "drawMinZoom": null,
      "description": [
        "雨の降っている所と、この先の雨雲を、時刻を動かして見られます"
      ],
      "panelHint": [
        "・60分先までは実況に近い予測、15時間先までは短時間予報、48時間先までは数値予報モデルの値で、赤は線状降水帯です。\n・数値予報モデルの計算結果で、大きな誤差を含む可能性があります。予報ではありません。\n・取得に失敗することがあります。"
      ],
      "hideMissingRows": false,
      "segmentSeries": null
    },
    {
      "id": "windVector",
      "label": "風",
      "dataSource": "msmGrid",
      "category": "weather",
      "dataNature": "dynamic",
      "drawMinZoom": null,
      "description": [
        "風の向きと強さを、約5kmごとの矢印で見られます"
      ],
      "panelHint": [
        "・矢印は風の吹いていく向きで、長く太いほど強い風です。\n・48時間先まで時刻で切り替えられます。\n・数値予報モデルの計算結果で、大きな誤差を含む可能性があります。予報ではありません。"
      ],
      "hideMissingRows": false,
      "segmentSeries": null
    },
    {
      "id": "disaster",
      "label": "災害の危険度",
      "dataSource": "ownFetch",
      "category": "disaster",
      "dataNature": "dynamic",
      "drawMinZoom": null,
      "description": [
        "気象庁の防災情報の危険度を地図に出します"
      ],
      "panelHint": [
        "・危険の無いときは何も出ません。\n・雷ナウキャスト・竜巻発生確度は60分先まで時刻スライダーで切り替えられます。\n・落雷[発生地点]は最新の観測だけを出します。\n・大雨キキクル・土砂災害キキクル・浸水キキクル・洪水キキクル[河川]は現在の危険度で、時刻に連動しません。\n・取得に失敗することがあります。"
      ],
      "hideMissingRows": false,
      "segmentSeries": null
    }
  ],
  "axisLayers": {
    "dedicated": {
      "dataSource": "road_surface",
      "category": null,
      "dataNature": "dynamic",
      "drawMinZoom": 12
    },
    "road": {
      "dataSource": "road_surface",
      "category": null,
      "dataNature": "raw",
      "drawMinZoom": null
    }
  },
  "weatherLayerGroups": [
    "precipitationNowcast",
    "windVector",
    "disaster"
  ],
  "weatherElements": [
    {
      "group": "precipitationNowcast",
      "source": "main",
      "kind": "rasterTile",
      "label": "降水",
      "frameRule": {
        "kind": "nearest",
        "windowMinutes": null
      },
      "gridValue": null,
      "levelScale": null,
      "description": null,
      "legendColor": null,
      "initiallyHidden": false,
      "jmaElements": [
        {
          "id": "hrpns",
          "targetTimesPaths": [
            "bosai/jmatile/data/nowc/targetTimes_N1.json",
            "bosai/jmatile/data/nowc/targetTimes_N2.json"
          ],
          "urlTemplate": "bosai/jmatile/data/nowc/{basetime}/{member}/{validtime}/surf/hrpns/{z}/{x}/{y}.png",
          "reader": "nowcast",
          "refreshIntervalMs": 300000,
          "dataDelayMinutes": 0,
          "forecastMinutes": 60
        },
        {
          "id": "rasrf",
          "targetTimesPaths": [
            "bosai/jmatile/data/rasrf/targetTimes.json"
          ],
          "urlTemplate": "bosai/jmatile/data/rasrf/{basetime}/{member}/{validtime}/surf/rasrf/{z}/{x}/{y}.png",
          "reader": "latestFullRun",
          "refreshIntervalMs": 600000,
          "dataDelayMinutes": 0,
          "forecastMinutes": 900
        }
      ],
      "tile": {
        "minZoom": 4,
        "maxZoom": 10,
        "vectorLayer": null
      }
    },
    {
      "group": "precipitationNowcast",
      "source": "main",
      "kind": "gridFill",
      "label": "降水",
      "frameRule": {
        "kind": "nearest",
        "windowMinutes": null
      },
      "gridValue": "precipitation",
      "levelScale": null,
      "description": null,
      "legendColor": null,
      "initiallyHidden": false,
      "jmaElements": [],
      "tile": null
    },
    {
      "group": "precipitationNowcast",
      "source": "linearRainband",
      "kind": "rasterTile",
      "label": "線状降水帯予測",
      "frameRule": {
        "kind": "current",
        "windowMinutes": 180
      },
      "gridValue": null,
      "levelScale": null,
      "description": "今後3時間以内に大雨のおそれ[矩形の予測領域。現在〜3時間先のみ]",
      "legendColor": "#ff2800",
      "initiallyHidden": false,
      "jmaElements": [
        {
          "id": "sjfcstmap",
          "targetTimesPaths": [
            "bosai/jmatile/data/rasrf/targetTimes.json"
          ],
          "urlTemplate": "bosai/jmatile/data/rasrf/{basetime}/{member}/{validtime}/surf/sjfcstmap/{z}/{x}/{y}.png",
          "reader": "latest",
          "refreshIntervalMs": 600000,
          "dataDelayMinutes": 0,
          "forecastMinutes": null
        }
      ],
      "tile": {
        "minZoom": 4,
        "maxZoom": 10,
        "vectorLayer": null
      }
    },
    {
      "group": "precipitationNowcast",
      "source": "linearRainbandArea",
      "kind": "outline",
      "label": "線状降水帯の雨域",
      "frameRule": {
        "kind": "nearest",
        "windowMinutes": null
      },
      "gridValue": null,
      "levelScale": null,
      "description": "大雨災害発生の危険度が急激に高まっている線状降水帯の雨域[赤い輪郭線。実況〜30分先のみ]",
      "legendColor": "#ff0000",
      "initiallyHidden": false,
      "jmaElements": [
        {
          "id": "slmcs_unify",
          "targetTimesPaths": [
            "bosai/jmatile/data/nowc/targetTimes_N3.json"
          ],
          "urlTemplate": "bosai/jmatile/data/nowc/{basetime}/{member}/{validtime}/surf/slmcs_unify/data.geojson?id=slmcs_unify",
          "reader": "nowcast",
          "refreshIntervalMs": 300000,
          "dataDelayMinutes": 10,
          "forecastMinutes": null
        }
      ],
      "tile": null
    },
    {
      "group": "precipitationNowcast",
      "source": "linearRainbandAreaForecast",
      "kind": "outline",
      "label": "線状降水帯の雨域",
      "frameRule": {
        "kind": "nearest",
        "windowMinutes": null
      },
      "gridValue": null,
      "levelScale": null,
      "description": "大雨災害発生の危険度が急激に高まっている線状降水帯の雨域[赤い輪郭線。実況〜30分先のみ]",
      "legendColor": "#ff0000",
      "initiallyHidden": false,
      "jmaElements": [
        {
          "id": "slmcs_unifyfcst",
          "targetTimesPaths": [
            "bosai/jmatile/data/nowc/targetTimes_N3.json"
          ],
          "urlTemplate": "bosai/jmatile/data/nowc/{basetime}/{member}/{validtime}/surf/slmcs_unifyfcst/data.geojson?id=slmcs_unifyfcst",
          "reader": "nowcast",
          "refreshIntervalMs": 300000,
          "dataDelayMinutes": 10,
          "forecastMinutes": 30
        }
      ],
      "tile": null
    },
    {
      "group": "windVector",
      "source": "arrow",
      "kind": "gridMark",
      "label": "風",
      "frameRule": {
        "kind": "nearest",
        "windowMinutes": null
      },
      "gridValue": "wind",
      "levelScale": null,
      "description": null,
      "legendColor": null,
      "initiallyHidden": false,
      "jmaElements": [],
      "tile": null
    },
    {
      "group": "disaster",
      "source": "heavyRain",
      "kind": "rasterTile",
      "label": "大雨キキクル",
      "frameRule": {
        "kind": "current",
        "windowMinutes": null
      },
      "gridValue": null,
      "levelScale": "risk_levels",
      "description": "浸水キキクルと洪水キキクル[河川]のうち、危険度の高い方を段階で示す気象庁の情報。",
      "legendColor": null,
      "initiallyHidden": true,
      "jmaElements": [
        {
          "id": "rain_mesh",
          "targetTimesPaths": [
            "bosai/jmatile/data/risk/targetTimes.json"
          ],
          "urlTemplate": "bosai/jmatile/data/risk/{basetime}/{member}/{validtime}/surf/rain_mesh/{z}/{x}/{y}.png",
          "reader": "latest",
          "refreshIntervalMs": 600000,
          "dataDelayMinutes": 0,
          "forecastMinutes": null
        }
      ],
      "tile": {
        "minZoom": 4,
        "maxZoom": 10,
        "vectorLayer": null
      }
    },
    {
      "group": "disaster",
      "source": "landslide",
      "kind": "rasterTile",
      "label": "土砂災害キキクル",
      "frameRule": {
        "kind": "current",
        "windowMinutes": null
      },
      "gridValue": null,
      "levelScale": "risk_levels",
      "description": "大雨による土砂災害[がけ崩れ・土石流など]の危険度の高まりを段階で示す気象庁の情報。",
      "legendColor": null,
      "initiallyHidden": false,
      "jmaElements": [
        {
          "id": "land",
          "targetTimesPaths": [
            "bosai/jmatile/data/risk/targetTimes.json"
          ],
          "urlTemplate": "bosai/jmatile/data/risk/{basetime}/{member}/{validtime}/surf/land/{z}/{x}/{y}.png",
          "reader": "latest",
          "refreshIntervalMs": 600000,
          "dataDelayMinutes": 0,
          "forecastMinutes": null
        }
      ],
      "tile": {
        "minZoom": 4,
        "maxZoom": 10,
        "vectorLayer": null
      }
    },
    {
      "group": "disaster",
      "source": "inundation",
      "kind": "rasterTile",
      "label": "浸水キキクル",
      "frameRule": {
        "kind": "current",
        "windowMinutes": null
      },
      "gridValue": null,
      "levelScale": "risk_levels",
      "description": "短い時間の強い雨で、道路や低い土地が水につかる危険度の高まりを段階で示す気象庁の情報。",
      "legendColor": null,
      "initiallyHidden": false,
      "jmaElements": [
        {
          "id": "inund",
          "targetTimesPaths": [
            "bosai/jmatile/data/risk/targetTimes.json"
          ],
          "urlTemplate": "bosai/jmatile/data/risk/{basetime}/{member}/{validtime}/surf/inund/{z}/{x}/{y}.png",
          "reader": "latest",
          "refreshIntervalMs": 600000,
          "dataDelayMinutes": 0,
          "forecastMinutes": null
        }
      ],
      "tile": {
        "minZoom": 4,
        "maxZoom": 10,
        "vectorLayer": null
      }
    },
    {
      "group": "disaster",
      "source": "thunder",
      "kind": "rasterTile",
      "label": "雷ナウキャスト",
      "frameRule": {
        "kind": "nearest",
        "windowMinutes": null
      },
      "gridValue": null,
      "levelScale": "thunder_activity",
      "description": "雷の激しさと雷が起こる可能性を、活動度の段階で示す気象庁の実況と60分先までの予測。",
      "legendColor": null,
      "initiallyHidden": false,
      "jmaElements": [
        {
          "id": "thns",
          "targetTimesPaths": [
            "bosai/jmatile/data/nowc/targetTimes_N3.json"
          ],
          "urlTemplate": "bosai/jmatile/data/nowc/{basetime}/{member}/{validtime}/surf/thns/{z}/{x}/{y}.png",
          "reader": "nowcast",
          "refreshIntervalMs": 300000,
          "dataDelayMinutes": 0,
          "forecastMinutes": 60
        }
      ],
      "tile": {
        "minZoom": 4,
        "maxZoom": 8,
        "vectorLayer": null
      }
    },
    {
      "group": "disaster",
      "source": "tornado",
      "kind": "rasterTile",
      "label": "竜巻発生確度",
      "frameRule": {
        "kind": "nearest",
        "windowMinutes": null
      },
      "gridValue": null,
      "levelScale": "tornado_potential",
      "description": "竜巻などの激しい突風が起こりやすい所を、確度の段階で示す気象庁の実況と60分先までの予測。",
      "legendColor": null,
      "initiallyHidden": false,
      "jmaElements": [
        {
          "id": "trns",
          "targetTimesPaths": [
            "bosai/jmatile/data/nowc/targetTimes_N3.json"
          ],
          "urlTemplate": "bosai/jmatile/data/nowc/{basetime}/{member}/{validtime}/surf/trns/{z}/{x}/{y}.png",
          "reader": "nowcast",
          "refreshIntervalMs": 300000,
          "dataDelayMinutes": 0,
          "forecastMinutes": 60
        }
      ],
      "tile": {
        "minZoom": 4,
        "maxZoom": 8,
        "vectorLayer": null
      }
    },
    {
      "group": "disaster",
      "source": "flood",
      "kind": "vectorTile",
      "label": "洪水キキクル[河川]",
      "frameRule": {
        "kind": "current",
        "windowMinutes": null
      },
      "gridValue": null,
      "levelScale": "risk_levels",
      "description": "大雨で川があふれる危険度の高まりを、川に沿った色で示す気象庁の情報。",
      "legendColor": null,
      "initiallyHidden": false,
      "jmaElements": [
        {
          "id": "flood",
          "targetTimesPaths": [
            "bosai/jmatile/data/risk/targetTimes.json"
          ],
          "urlTemplate": "bosai/jmatile/data/risk/{basetime}/{member}/{validtime}/surf/flood/{z}/{x}/{y}.pbf",
          "reader": "latest",
          "refreshIntervalMs": 600000,
          "dataDelayMinutes": 0,
          "forecastMinutes": null
        }
      ],
      "tile": {
        "minZoom": 4,
        "maxZoom": 10,
        "vectorLayer": "flood"
      }
    },
    {
      "group": "disaster",
      "source": "liden",
      "kind": "gridMark",
      "label": "落雷[発生地点]",
      "frameRule": {
        "kind": "latestObservation",
        "windowMinutes": 20
      },
      "gridValue": null,
      "levelScale": null,
      "description": "気象庁の雷の観測が捉えた、直近の雷の発生地点。",
      "legendColor": null,
      "initiallyHidden": false,
      "jmaElements": [
        {
          "id": "liden",
          "targetTimesPaths": [
            "bosai/jmatile/data/nowc/targetTimes_N3.json"
          ],
          "urlTemplate": "bosai/jmatile/data/nowc/{basetime}/{member}/{validtime}/surf/liden/data.geojson?id=liden",
          "reader": "nowcast",
          "refreshIntervalMs": 300000,
          "dataDelayMinutes": 0,
          "forecastMinutes": null
        }
      ],
      "tile": null
    }
  ],
  "compassLabels": [
    "北",
    "北東",
    "東",
    "南東",
    "南",
    "南西",
    "西",
    "北西"
  ],
  "modelValueDisclaimer": "数値予報モデルの計算結果で、大きな誤差を含む可能性があります。予報ではありません。",
  "alwaysShownAttributions": [
    "&copy; <a href=\"https://www.openstreetmap.org/copyright\" target=\"_blank\" rel=\"noreferrer\">OpenStreetMap contributors</a>",
    "道ごとの値の<a href=\"/api/derived-database\" target=\"_blank\" rel=\"noreferrer\">派生データベース(ZIP)</a>(<a href=\"https://opendatacommons.org/licenses/odbl/1-0/\" target=\"_blank\" rel=\"noreferrer\">ODbL 1.0</a>)",
    "<a href=\"https://maps.gsi.go.jp/development/ichiran.html\" target=\"_blank\" rel=\"noreferrer\">地理院タイル(標高タイル)</a>を加工して作成",
    "<a href=\"https://www.npa.go.jp/publications/statistics/koutsuu/opendata/index_opendata.html\" target=\"_blank\" rel=\"noreferrer\">交通事故統計情報</a>[警察庁]を加工して作成",
    "<a href=\"https://www.jma.go.jp/\" target=\"_blank\" rel=\"noreferrer\">気象庁ホームページ</a>(アメダス・警報・キキクル・ナウキャスト等)と気象庁「<a href=\"https://www.data.jma.go.jp/developer/gis.html\" target=\"_blank\" rel=\"noreferrer\">予報区等GISデータ</a>」を加工して作成",
    "気象庁メソ数値予報モデル(MSM)を加工して作成。配布: <a href=\"https://open-meteo.com/\" target=\"_blank\" rel=\"noreferrer\">Weather data by Open-Meteo.com</a> (<a href=\"https://creativecommons.org/licenses/by/4.0/\" target=\"_blank\" rel=\"noreferrer\">CC BY 4.0</a>)",
    "暑さ指数: 出典 <a href=\"https://www.wbgt.env.go.jp/\" target=\"_blank\" rel=\"noreferrer\">環境省熱中症予防情報サイト</a>",
    "土地被覆: <a href=\"https://livingatlas.arcgis.com/landcover/\" target=\"_blank\" rel=\"noreferrer\">Esri, Impact Observatory, Microsoft</a> (<a href=\"https://creativecommons.org/licenses/by/4.0/\" target=\"_blank\" rel=\"noreferrer\">CC BY 4.0</a>)を加工して作成",
    "住所: 「<a href=\"https://www.digital.go.jp/policies/base_registry_address/\" target=\"_blank\" rel=\"noreferrer\">アドレス・ベース・レジストリ</a>」[デジタル庁]の町字マスター・住居表示の街区マスター・位置参照拡張を加工して作成 (<a href=\"https://creativecommons.org/licenses/by/4.0/\" target=\"_blank\" rel=\"noreferrer\">CC BY 4.0</a>)",
    "住所の境界: 出典 <a href=\"https://www.e-stat.go.jp/\" target=\"_blank\" rel=\"noreferrer\">政府統計の総合窓口(e-Stat)</a>。「令和2年国勢調査 小地域(町丁・字等別)境界データ」[総務省統計局]を加工して作成",
    "住所の地番: 「<a href=\"https://nlftp.mlit.go.jp/isj/\" target=\"_blank\" rel=\"noreferrer\">街区レベル位置参照情報</a>」[国土交通省]を加工して作成",
    "地点: <a href=\"https://overturemaps.org/\" target=\"_blank\" rel=\"noreferrer\">Overture Maps Foundation</a>の名前のある地点を、種類で分け近くの同じ店をまとめて加工。Data from Meta, Microsoft, PinMeTo, DAC, Uberall, OpenTravel (<a href=\"https://cdla.dev/permissive-2-0/\" target=\"_blank\" rel=\"noreferrer\">CDLA Permissive 2.0</a>), AllThePlaces (<a href=\"https://creativecommons.org/publicdomain/zero/1.0/\" target=\"_blank\" rel=\"noreferrer\">CC0 1.0</a>), Foursquare (Copyright 2024 Foursquare Labs, Inc. All rights reserved. Available under <a href=\"/licenses/apache-2.0.txt\" target=\"_blank\" rel=\"noreferrer\">Apache 2.0</a>. Foursquare data was transformed to the Overture schema. <a href=\"/licenses/foursquare-places-NOTICE.txt\" target=\"_blank\" rel=\"noreferrer\">NOTICE</a>)",
    "寺社: ジャパンサーチ「<a href=\"https://jpsearch.go.jp/database/bunka\" target=\"_blank\" rel=\"noreferrer\">文化遺産オンライン[文化庁・国立情報学研究所]</a>」のメタデータを改変して利用[所有者で寺社ごとにまとめた]",
    "交通規制: 公益財団法人日本道路交通情報センター「<a href=\"https://www.jartic.or.jp/service/opendata/\" target=\"_blank\" rel=\"noreferrer\">交通規制情報</a>」を加工して作成"
  ],
  "noDataDash": [
    1,
    2
  ],
  "road": {
    "lineWidthPx": 3,
    "trackOffsetStepPx": 2,
    "knownOpacity": 0.8,
    "unknownOpacity": 0.6,
    "inspectedWidthPx": 8,
    "noDataValue": "-"
  },
  "avoidanceRail": {
    "widthPx": 2,
    "gapPx": 2,
    "avoidedDash": [
      3,
      2
    ]
  },
  "roadAvoidance": {
    "widthByZoom": [
      [
        12,
        3
      ],
      [
        14,
        5
      ],
      [
        16,
        9
      ],
      [
        18,
        18
      ]
    ]
  },
  "point": {
    "radiusPx": 4,
    "strokeWidthPx": 1,
    "iconSizePx": 20,
    "opacityByLayer": {
      "stop_poi": 0.9,
      "accident_point": 0.75,
      "supply_poi": 0.9,
      "stop_place": 0.9
    },
    "segmentNearbyMaxDistanceM": 100.0,
    "countProperty": "count",
    "membersProperty": "members"
  },
  "area": {
    "opacity": 0.55,
    "hillshadeIlluminationDeg": 315,
    "hillshadeMethod": "igor",
    "hillshadeExaggeration": 1,
    "hillshadeShadowColor": "rgba(60, 50, 40, 0.55)",
    "hillshadeHighlightColor": "rgba(255, 252, 245, 0.55)",
    "terrainExaggeration": 5
  },
  "weather": {
    "windIconScaleRange": [
      0.8,
      1.4
    ],
    "windFullScaleMs": 15,
    "lightningIconScale": 0.8,
    "markSizeByZoom": [
      [
        10,
        0.75
      ],
      [
        13,
        1
      ],
      [
        16,
        1.5
      ],
      [
        19,
        2
      ]
    ],
    "floodLineWidthByZoom": [
      [
        6,
        1.5
      ],
      [
        10,
        3
      ],
      [
        14,
        5
      ]
    ],
    "rainbandOutlineWidthPx": 4,
    "rainbandOutlineCasingWidthPx": 6,
    "msmForecastHours": 48
  },
  "route": {
    "lineWidthsPx": {
      "candidate": 2.5,
      "selectedHalo": 10,
      "splice": 3,
      "composite": 7,
      "detail": 6,
      "selectedSection": 18
    },
    "casingWidthsPx": {
      "composite": 11,
      "detail": 10
    },
    "opacities": {
      "selectedHalo": 0.25,
      "splice": 0.75,
      "candidate": 0.65,
      "arrowHalo": 0.95,
      "travelled": 0.35,
      "selectedSection": 0.45
    },
    "spliceDash": [
      2,
      1.5
    ],
    "arrowSpacingPx": 80,
    "arrowHaloScale": 1.5,
    "arrowSizeByZoom": [
      [
        10,
        0.6
      ],
      [
        13,
        0.8
      ],
      [
        16,
        1.2
      ],
      [
        19,
        1.6
      ]
    ]
  }
} as const;
