#!/usr/bin/env python3
"""Spark 出力の Parquet フォルダ（part-xxxxx.parquet + _SUCCESS、year=/month= の階層も可）を 1 本の CSV に書き出す。

Parquet の圧縮（zstd / snappy）は列の中にかかっているので「解凍」はファイル単位ではできない。代わりに、フォルダごと 1 つの表として
読み、そのまま CSV（または gzip 圧縮の CSV）に流し込む。メモリに全部は載せず、ファイルを 1 つずつ・バッチごとに書く。

  python parquet_to_csv.py /data/irys_bo_1473_uzb_22oct2026                                   # 作業フォルダ（カレント）に irys_bo_1473_uzb_22oct2026.csv
  python parquet_to_csv.py /data/FACTORI_AI_..._GPS_UZB/mobility --name factori_uzb_2026-05     # 名前を付けて factori_uzb_2026-05.csv
  python parquet_to_csv.py /data/irys_bo_1473_uzb_22oct2026 --out ~/work --gzip                # 出力先を指定、.csv.gz で
  python parquet_to_csv.py /data/irys_bo_1473_uzb_22oct2026 --info                             # 列と件数・ファイル数だけ見る

- year=2026/month=05 のような階層（Hive パーティション）は、year, month の列として CSV に入る。
- 出力は作業フォルダ（コマンドを実行した場所）に <フォルダ名>.csv。--out で場所、--name で名前を変えられる。既にあれば上書きしない（--force で上書き）。
- CSV は元より 3〜10 倍ほど大きくなることが多い。--info で件数を見て、ディスク（df -h）を確かめてから回す。
必要なもの: pyarrow（pip install pyarrow）
"""
import argparse
import gzip
import sys
import time
from pathlib import Path

import pyarrow as pa
import pyarrow.csv as pcsv
import pyarrow.dataset as ds


def open_dataset(folder: Path) -> ds.Dataset:
    """フォルダ以下の *.parquet を 1 つの表として開く（year=… の階層は列になる。_SUCCESS などは無視）"""
    return ds.dataset(str(folder), format="parquet", partitioning="hive", exclude_invalid_files=True)


def info(folder: Path) -> None:
    """列、ファイル数、件数を表示する（件数はメタデータから数えるので速い）"""
    d = open_dataset(folder)
    files = d.files
    print(f"== {folder}")
    print(f"   files : {len(files)}  (例: {Path(files[0]).name if files else '-'})")
    print(f"   rows  : {d.count_rows():,}")
    print(f"   size  : {sum(Path(f).stat().st_size for f in files) / 1e9:.2f} GB (parquet)")
    for f in d.schema:
        print(f"   - {f.name}: {f.type}")


def convert(folder: Path, out: Path, name: str, gzip_out: bool, force: bool, batch_rows: int) -> None:
    """フォルダを 1 本の CSV に書く。ヘッダは 1 回、以降はバッチを追記する"""
    d = open_dataset(folder)
    out.mkdir(parents=True, exist_ok=True)
    dst = out / ((name or folder.name) + (".csv.gz" if gzip_out else ".csv"))
    if dst.exists() and not force:
        print(f"skip (exists): {dst}  (--force で上書き)")
        return
    t0, rows = time.time(), 0
    opener = (lambda p: gzip.open(p, "wb", compresslevel=6)) if gzip_out else (lambda p: open(p, "wb"))
    with opener(dst) as fh:
        writer = None   # 最初のバッチでスキーマが決まる（パーティション列込み）
        for batch in d.to_batches(batch_size=batch_rows):
            if writer is None:
                writer = pcsv.CSVWriter(fh, batch.schema)
            writer.write_batch(batch)
            rows += batch.num_rows
            print(f"\r   {folder.name}: {rows:,} rows  {time.time() - t0:,.0f}s", end="", file=sys.stderr)
        if writer is None:   # 空のデータセット: ヘッダだけ書く
            pcsv.CSVWriter(fh, d.schema).close()
        else:
            writer.close()
    print(f"\nwrote {dst}  rows={rows:,}  size={dst.stat().st_size / 1e9:.2f} GB  ({time.time() - t0:,.0f}s)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folders", nargs="+", type=Path, help="Parquet のフォルダ（part-*.parquet があるフォルダ、または year=… の親）")
    ap.add_argument("--out", type=Path, default=Path.cwd(), help="出力先フォルダ（既定: 作業フォルダ = カレントディレクトリ）")
    ap.add_argument("--name", help="出力ファイルの名前（拡張子なし。既定: 入力フォルダの名前。入力が 1 つのときに使う）")
    ap.add_argument("--gzip", action="store_true", help="CSV を gzip 圧縮して書く（.csv.gz）")
    ap.add_argument("--force", action="store_true", help="出力があっても上書きする")
    ap.add_argument("--info", action="store_true", help="変換せず、列と件数だけ表示する")
    ap.add_argument("--batch-rows", type=int, default=500_000, help="一度に読む行数（メモリに合わせて。既定 500,000）")
    a = ap.parse_args()
    if a.name and len(a.folders) > 1:
        sys.exit("--name は入力フォルダが 1 つのときだけ使えます")
    for folder in a.folders:
        if not folder.is_dir():
            sys.exit(f"not a folder: {folder}")
        if a.info:
            info(folder)
        else:
            convert(folder, a.out, a.name, a.gzip, a.force, a.batch_rows)


if __name__ == "__main__":
    main()
