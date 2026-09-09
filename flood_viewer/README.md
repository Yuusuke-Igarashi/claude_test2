# Flood candidates viewer (Tokyo 2024-08-21)

`run2024.ipynb` の出力（ネットワーク GeoJSON と 5 種類の CSV 行列）を地図上に表示する単一 HTML です。

## 使い方

1. `flood_viewer.html` をノートブックの `output` フォルダ（以下のファイルがある場所）にコピーする。
   - `tokyo_20240821_network.geojson`
   - `baseline_speed.csv`, `event_speed.csv`, `baseline_count.csv`, `event_count.csv`, `error.csv`
2. そのフォルダで `python -m http.server 8000` を実行し、ブラウザで `http://localhost:8000/flood_viewer.html` を開く。
   - ファイルをダブルクリック（`file://`）で開いた場合は自動読み込みが CORS で失敗するため、
     画面に出るファイル選択ボタンから上記 6 ファイルをまとめて選択する。
3. 上部スライダーで時刻を切り替える（← → キー、Space で再生/停止）。
4. リンクにホバーすると、平時/イベント時の速度と台数の時系列が表示される。クリックで固定。

## 色

| 色 | 条件 |
|---|---|
| 灰 | is_target = false（またはデータなし） |
| 黒 | is_target = true |
| 赤 | error = true |

`is_target` は CSV に含まれないため、`baseline_count >= 5 AND baseline_speed >= 15` を HTML 側で再計算している
（`CONFIG.MIN_BASE_COUNT` / `CONFIG.MIN_BASE_SPEED`）。ノートブック側で
`save_time_matrix("is_target", "is_target.csv", boolean=True)` を出力しておけば、そちらが優先して使われる。

## 依存

- MapLibre GL JS 5.24.0（unpkg CDN）
- 背景地図: 地理院タイル（淡色）。`CONFIG.basemap` で OpenStreetMap に切り替え可。
