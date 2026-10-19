from typing import Literal

# 天気コードは観測（アメダスと推計気象分布）からだけ導く。数値予報モデル（MSM）の値から天気を計算して出すことは、
# 気象業務法の予報業務の許可の対象と気象庁の公式の説明が書いているため、しない（docs/architecture/data-sources.md
# 「気象業務法の予報業務許可」節）。コードの分類と表示名はdomain/weather_display.py（WEATHER_CATEGORIES）が持つ。
#: これ未満（mm/h）は「降っていない」。
PRECIPITATION_MIN_MM = 0.1
_PRECIPITATION_MODERATE_MM = 1.0
_PRECIPITATION_HEAVY_MM = 4.0
_SNOW_MAX_TEMPERATURE_C = 0.0

#: 推計気象分布（天気）の区分。配信元の色からの読み替えは`infrastructure/jma_suikei_client.py`。
SuikeiWeather = Literal["clear", "cloudy", "rain", "rain_or_snow", "snow"]


def derive_observed_weather_code(
    precipitation_10min_mm: float | None, suikei: SuikeiWeather | None, temperature_c: float | None
) -> int | None:
    """アメダスの10分間の実測（降水量・気温）と推計気象分布の区分から WMO天気コードを求める。

    降水があれば10分間量を1時間あたりへ直し、気温で雨（61/63/65）と雪（71/73/75）を、1時間あたりの量で
    強さを分ける。降水が無ければ推計の区分で晴れ（0）/くもり（3）に分け、雨・雪の区分もくもりに数える
    ——降っているかは観測所の実測が決め、推計から読むのは降っていないときの空だけ。日照時間は夜は空によらず0になるため
    晴れ・くもりの材料にしない。霧・雷雨はどちらの項目からも判定できないため返さない。降っておらず空も
    分からなければNone。
    """
    hourly_mm = None if precipitation_10min_mm is None else precipitation_10min_mm * 6
    if hourly_mm is not None and hourly_mm >= PRECIPITATION_MIN_MM:
        snow = temperature_c is not None and temperature_c <= _SNOW_MAX_TEMPERATURE_C
        if hourly_mm < _PRECIPITATION_MODERATE_MM:
            return 71 if snow else 61
        if hourly_mm < _PRECIPITATION_HEAVY_MM:
            return 73 if snow else 63
        return 75 if snow else 65
    if suikei is None:
        return None
    return 0 if suikei == "clear" else 3
