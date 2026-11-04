#!/usr/bin/env bash
# 合成データで 4 本を通しで動かす簡易チェック。
# 使い方: bash tests/run_synth_check.sh <作業フォルダ> [格子の節点数（既定 30）]
# 必要: pip install duckdb pyarrow pandas numpy scipy shapely geopandas networkx pyproj pyogrio
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd); W=${1:?作業フォルダを指定してください}; G=${2:-30}
mkdir -p "$W"
python3 "$HERE/tests/gen_synth.py" --out "$W/data" --grid "$G"
python3 "$HERE/1_extract_dense.py" "$W/data/raw" --out "$W/dense"
python3 "$HERE/2_make_trips.py" "$W/dense_points.parquet" --out "$W/trips" --source Factori
python3 "$HERE/3_build_tashkent_graphs.py" --input "$W/data/Tashkent_Road_Network.gpkg" --output-dir "$W/graphs" --overwrite
python3 "$HERE/4_map_match.py" --trips "$W/trips_trips.parquet" --points "$W/trips_trip_points.parquet" --graphs "$W/graphs" --out "$W/mm" --workers 2 --chunk 10
echo "完了: $W"
