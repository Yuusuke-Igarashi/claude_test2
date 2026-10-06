# 郵便番号ポリゴン抽出（PMTiles → GeoJSON）

郵便番号ポリゴンの PMTiles を取得し、郵便番号ごとに結合して GeoJSON に変換するツールです。
CLI 版と Jupyter Notebook 版の2つの入口があり、処理ロジックは共通です。

| ファイル | 役割 |
|---|---|
| `extract_postal_polygons.ipynb` | **Notebook 版**。パラメータセルを編集して上から順に実行 |
| `extract_postal_polygons.py` | CLI 版（元のスクリプト。`download` / `inspect` / `extract` サブコマンド） |
| `requirements.txt` | 依存パッケージ（`mapbox-vector-tile`, `pmtiles`, `shapely`） |

## Notebook 版の使い方

1. Python 3.10 以上の Jupyter 環境（JupyterLab / VS Code / Google Colab など）で `extract_postal_polygons.ipynb` を開く
2. 「0. 準備」のセルで依存パッケージを導入（初回のみ）
3. 「関数定義」のセルを順に実行
4. 「1. download」「2. inspect」「3. extract」の各パラメータセルを編集し、続く `run(...)` セルを実行

`run()` は CLI 版の終了コードに対応する値（0=成功 / 1=エラー / 130=中断）を返します。
出力先が既に存在する場合は `overwrite=True` を指定してください。

Notebook 版が CLI 版と異なる点（ロジック以外）:

- 引数はコマンドライン引数ではなくパラメータセル（`SimpleNamespace`）で指定
- 進捗ログは標準出力に表示（CLI 版は標準エラー出力）
- `ExtractionError` はメッセージのみ表示し、想定外の例外はトレースバックを表示
- エラー文中の指示が `--layer` などの CLI オプション名ではなくパラメータ名（`layer` など）

## CLI 版の使い方

```bash
python -m pip install -r requirements.txt
python extract_postal_polygons.py download --output postal.pmtiles
python extract_postal_polygons.py inspect  --input postal.pmtiles
python extract_postal_polygons.py extract  --input postal.pmtiles --output postal_polygons.geojson
```

## 注意

- 既定の取得 URL は実在確認していません。取得できない場合は手元の PMTiles を `input` に指定してください。
- 配信用の表示タイルからポリゴンを再構成するため、簡略化・欠落・タイル継ぎ目の痕跡が残る場合があります。
  タイル化前の元データを復元するものではなく、日本郵便の公式データとの照合も行っていません。
- 全国分を最大 zoom で処理すると時間とディスク容量を消費します。まず `postcode_prefix` で一部地域に絞ることを推奨します。
- 取得した PMTiles・出力 GeoJSON・処理記録（`*.report.json`）はリポジトリの `.gitignore` で除外しています。
