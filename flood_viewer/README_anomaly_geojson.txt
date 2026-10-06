異常箇所 GeoJSON README
=====================

平時と比べて交通・人流が大きく変わった箇所だけを、15 分の時間窓ごとに GeoJSON にしたものです。
座標系は WGS84（EPSG:4326）。該当が無い窓も空のファイルがあります（= その窓は異常なし）。
個人や車両を特定できる情報は含みません。

1. tomtom/  車流（TomTom プローブ）
   ファイル : error_L{1|2|3}_YYYYMMDD_HHMM.geojson（HHMM = 窓の開始時刻）
   内容     : 道路リンク（線）。平時（過去 4 週の同曜日平均）に対して速度・交通量が落ちたリンク
   レベル   : L1 = 速度比 ≤ 0.5 または 交通量比 ≤ 0.5 / L2 = 両方 ≤ 0.5 / L3 = 両方 ≤ 0.25
              （対向車線または前後の窓でも同じ条件を満たすものだけ。各ファイルはそのレベルのリンクのみ）
   主な属性 : id, timestamp, baseline_speed, event_speed, speed_ratio, baseline_count, event_count, count_ratio, error_level

2. truck/   トラック（矢崎総業プローブ）
   ファイル : error_L{1|2|3}_YYYYMMDD_HHMM.geojson（HHMM = 窓の開始時刻）
   内容     : 道路リンク（線）。平時（前日）に対して台数・速度が落ちたリンク。レベルの定義は車流と同じ
              （前後の窓でも同じ条件を満たすものだけ）
   主な属性 : Id, timestamp, baseline_count, event_count, count_ratio, baseline_speed, event_speed, speed_ratio, error_level, StreetName

3. walk25/  人流（端末位置ログ、徒歩）
   ファイル : walk25_anomaly_HHMM.geojson（HHMM = 窓の終端時刻。窓はその直近 1 時間）
   内容     : 25 m メッシュ（四角形）。直近 1 時間にそのセルを徒歩で通った人数（ユニーク）が、
              平時（1 週間前の同曜日）の 1/3 以下（kind = low）または 3 倍以上（kind = high）になったセル
              （平時 5 人以上のセルのみ判定）
   主な属性 : time, baseline, event, ratio, kind

注意: 速度は km/h、台数・人数はプローブで観測できた数です（実際の交通量・歩行者数ではありません）。
