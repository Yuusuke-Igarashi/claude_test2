#!/usr/bin/env python3
"""Download an explicitly selected PMTiles file and export postal polygons.

Python 3.10+. See README_JA.md for Windows commands and limitations.
This reconstructs display tiles; it does not recover a pre-tiling source dataset.
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import mmap
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timezone


# URL reported in the preceding conversation; not live-verified in this build.
DEFAULT_URL = "https://zipmap.tsukumistudio.com/data/postal.pmtiles"
POSTCODE_FIELDS = {
    "postcode", "postal_code", "postalcode", "postal", "zip", "zip_code",
    "zipcode", "post_code", "yubin", "yubin_no", "郵便番号", "code",
}
GRID = 4096


class ExtractionError(Exception):
    pass


def log(message):
    print(message, file=sys.stderr, flush=True)


def require_dependencies():
    global mvt, Reader, all_tiles, Compression, TileType
    global make_valid, union_all, from_wkb, affine_transform, shape, mapping
    global box, transform, orient
    try:
        import mapbox_vector_tile as mvt
        from pmtiles.reader import Reader, all_tiles
        from pmtiles.tile import Compression, TileType
        from shapely import make_valid, union_all, from_wkb
        from shapely.affinity import affine_transform
        from shapely.geometry import shape, mapping, box
        from shapely.geometry.polygon import orient
        from shapely.ops import transform
    except ImportError as exc:
        raise ExtractionError(
            "依存パッケージがありません。py -m pip install -r requirements.txt を実行してください。"
        ) from exc


def normalize_postcode(value):
    """Strict seven-digit strings; numeric six-digit codes get their zero back."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return f"{value:07d}" if 0 <= value <= 9999999 else None
    if isinstance(value, float):
        return normalize_postcode(int(value)) if math.isfinite(value) and value.is_integer() else None
    if not isinstance(value, str):
        return None
    text = unicodedata.normalize("NFKC", value).strip()
    if text.startswith("〒"):
        text = text[1:].strip()
    text = text.replace(" ", "")
    if re.fullmatch(r"[0-9]{3}-[0-9]{4}", text):
        text = text.replace("-", "")
    # Short text is not padded: it could be a prefix rather than a complete code.
    return text if re.fullmatch(r"[0-9]{7}", text) else None


def ensure_target(path, overwrite=False):
    if path.exists() and not overwrite:
        raise ExtractionError(f"保存先が存在します: {path}（上書きする場合は --overwrite）")
    path.parent.mkdir(parents=True, exist_ok=True)


def download_file(url, output, overwrite=False):
    """One streamed GET, no crawler, authentication tricks, or retry loop."""
    if urllib.parse.urlsplit(url).scheme not in {"https", "http"}:
        raise ExtractionError("URLは http:// または https:// で指定してください。")
    ensure_target(output, overwrite)
    fd, name = tempfile.mkstemp(prefix=f".{output.name}.", suffix=".part", dir=output.parent)
    os.close(fd)
    temporary = Path(name)
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "PostalPolygonExtractor/1.0"})
        with urllib.request.urlopen(request, timeout=60) as response, temporary.open("wb") as stream:
            expected = response.headers.get("Content-Length")
            expected = int(expected) if expected else None
            received = 0
            last_log = 0.0
            while chunk := response.read(1024 * 1024):
                stream.write(chunk)
                received += len(chunk)
                if time.monotonic() - last_log >= 3:
                    total = f" / {expected / 1048576:.1f} MiB" if expected is not None else ""
                    log(f"取得: {received / 1048576:.1f} MiB{total}")
                    last_log = time.monotonic()
        if expected is not None and received != expected:
            raise ExtractionError(f"取得サイズが一致しません: {received} / {expected} bytes")
        with temporary.open("rb") as stream:
            prefix = stream.read(127)
        if len(prefix) < 127 or prefix[:7] != b"PMTiles" or prefix[7] != 3:
            raise ExtractionError("取得内容がPMTiles v3ではありません。URLと配信形式を確認してください。")
        os.replace(temporary, output)
        log(f"保存: {output.resolve()} ({received:,} bytes)")
    except urllib.error.HTTPError as exc:
        raise ExtractionError(
            f"HTTP {exc.code}。取得を中止しました。URL・取得条件を確認するか、手元のPMTilesを使用してください。"
        ) from exc
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def open_archive(path):
    require_dependencies()
    with path.open("rb") as stream:
        prefix = stream.read(127)
        if len(prefix) < 127 or prefix[:7] != b"PMTiles" or prefix[7] != 3:
            raise ExtractionError("入力はPMTiles v3ファイルにしてください。")
        with mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as memory:
            def source(offset, length):
                if offset < 0 or length < 0 or offset + length > len(memory):
                    raise ExtractionError("PMTiles内の参照範囲がファイルサイズを超えています。")
                return memory[offset:offset + length]
            reader = Reader(source)
            header = reader.header()
            if header["tile_type"] != TileType.MVT:
                raise ExtractionError("ポリゴン抽出にはMVTベクトルタイルのPMTilesが必要です。")
            # pmtiles 3.8.1's directory reader assumes gzip. Reject rather than misread.
            if header["internal_compression"] != Compression.GZIP:
                raise ExtractionError("この版は内部ディレクトリがgzipのPMTilesに対応します。")
            yield source, header, reader.metadata()


def tile_bytes(data, compression):
    if compression == Compression.NONE:
        return data
    if compression == Compression.GZIP:
        return gzip.decompress(data)
    raise ExtractionError(f"タイル圧縮 {compression.name} は未対応です（NONE/GZIPに対応）。")


def resolve_zoom(header, requested):
    zoom = header["max_zoom"] if requested == "max" else int(requested)
    if not header["min_zoom"] <= zoom <= header["max_zoom"]:
        raise ExtractionError(f"zoomは {header['min_zoom']}〜{header['max_zoom']} にしてください。")
    return zoom


def selected_tiles(source, header, zoom):
    for (z, x, y), data in all_tiles(source):
        if z == zoom:
            yield x, y, mvt.decode(
                tile_bytes(data, header["tile_compression"]),
                default_options={"y_coord_down": True},
            )


def vector_layers(metadata):
    layers = metadata.get("vector_layers")
    if layers is None and isinstance(metadata.get("json"), str):
        layers = json.loads(metadata["json"]).get("vector_layers")
    return layers if isinstance(layers, list) else []


def choose_layer(metadata, specified):
    if specified:
        return specified
    layers = vector_layers(metadata)
    if len(layers) == 1:
        return layers[0]["id"]
    candidates = [layer["id"] for layer in layers if any(
        str(field).casefold() in POSTCODE_FIELDS for field in layer.get("fields", {})
    )]
    if len(candidates) == 1:
        return candidates[0]
    if layers:
        raise ExtractionError("対象レイヤーが一意に決まりません。inspectで確認し --layer を指定してください。")
    return None


def choose_field(properties):
    candidates = [key for key, value in properties.items()
                  if str(key).casefold() in POSTCODE_FIELDS and normalize_postcode(value) is not None]
    if len(candidates) != 1:
        raise ExtractionError(
            f"郵便番号属性が一意に決まりません。属性={list(properties)}。--postcode-field を指定してください。"
        )
    return candidates[0]


def polygonal(geometry):
    if geometry.is_empty:
        return geometry
    if geometry.geom_type in {"Polygon", "MultiPolygon"}:
        return geometry
    parts = []
    if hasattr(geometry, "geoms"):
        for part in geometry.geoms:
            valid = polygonal(part)
            if not valid.is_empty and valid.geom_type in {"Polygon", "MultiPolygon"}:
                parts.append(valid)
    return union_all(parts)


def global_fragment(feature, x, y, extent):
    geometry = shape(feature["geometry"])
    repaired = not geometry.is_valid
    if repaired:
        geometry = make_valid(geometry)
    geometry = polygonal(geometry)
    if geometry.is_empty:
        return geometry, repaired
    # Clip away tile buffers before union. Use a common coordinate grid so that
    # adjacent tile borders coincide exactly before projecting to longitude/latitude.
    geometry = geometry.intersection(box(0, 0, extent, extent))
    geometry = polygonal(geometry)
    scale = GRID / extent
    return affine_transform(geometry, [scale, 0, 0, scale, x * GRID, y * GRID]), repaired


def to_lonlat(geometry, zoom):
    world = GRID * (1 << zoom)
    def project(xs, ys, zs=None):
        lons = [v / world * 360 - 180 for v in xs]
        lats = [math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * v / world)))) for v in ys]
        return (lons, lats) if zs is None else (lons, lats, zs)
    projected = transform(project, geometry)
    if projected.geom_type == "Polygon":
        return orient(projected, sign=1.0)
    from shapely.geometry import MultiPolygon
    return MultiPolygon([orient(part, sign=1.0) for part in projected.geoms])


def parse_filters(raw_filters):
    result = []
    for entry in raw_filters:
        if "=" not in entry:
            raise ExtractionError("--filter は FIELD=VALUE 形式で指定してください。")
        field, value = entry.split("=", 1)
        if not field:
            raise ExtractionError("--filter の属性名が空です。")
        result.append((field, value))
    return result


def inspect_archive(args):
    with open_archive(args.input) as (source, header, metadata):
        zoom = resolve_zoom(header, args.zoom)
        samples = {}
        examined = 0
        for x, y, layers in selected_tiles(source, header, zoom):
            examined += 1
            for name, layer in layers.items():
                samples.setdefault(name, {"extent": layer["extent"], "features": []})
                for feature in layer["features"]:
                    if len(samples[name]["features"]) < 3:
                        samples[name]["features"].append({
                            "geometry_type": feature.get("geometry", {}).get("type"),
                            "properties": feature.get("properties", {}),
                        })
            if examined >= args.sample_tiles:
                break
        summary = {
            "input": str(args.input.resolve()),
            "header": {key: getattr(value, "name", value) for key, value in header.items()},
            "metadata": metadata,
            "sample_zoom": zoom,
            "sample_tiles_examined": examined,
            "sample_layers": samples,
        }
        print(json.dumps(summary, ensure_ascii=False, indent=2))


def union_rows(rows, batch_size=256):
    batches, current = [], []
    for (geometry,) in rows:
        current.append(from_wkb(geometry))
        if len(current) == batch_size:
            batches.append(union_all(current))
            current.clear()
    if current:
        batches.append(union_all(current))
    return polygonal(union_all(batches))


def extract_archive(args):
    ensure_target(args.output, args.overwrite)
    report_path = args.output.with_suffix(".report.json")
    ensure_target(report_path, args.overwrite)
    if args.input.resolve() in {args.output.resolve(), report_path.resolve()}:
        raise ExtractionError("入力ファイルと出力ファイルは別のパスにしてください。")
    filters = parse_filters(args.filters)
    if args.postcode_prefix is not None and not re.fullmatch(r"[0-9]{1,7}", args.postcode_prefix):
        raise ExtractionError("--postcode-prefix は1〜7桁の数字にしてください。")
    statistics = {key: 0 for key in (
        "tiles_examined", "tiles_with_layer", "polygon_features_seen", "fragments_saved",
        "features_filtered", "invalid_or_missing_postcodes", "empty_after_clip", "geometries_repaired",
    )}
    with open_archive(args.input) as (source, header, metadata), tempfile.TemporaryDirectory(
        prefix="postal-extract-", dir=args.work_dir
    ) as directory:
        zoom = resolve_zoom(header, args.zoom)
        layer_name = choose_layer(metadata, args.layer)
        postcode_field = args.postcode_field
        log(f"変換: zoom={zoom}、作業データは一時SQLiteに保存します。")
        with sqlite3.connect(str(Path(directory) / "fragments.sqlite")) as db:
            db.execute("CREATE TABLE fragments (postcode TEXT, geometry BLOB, properties TEXT)")
            for x, y, layers in selected_tiles(source, header, zoom):
                statistics["tiles_examined"] += 1
                if layer_name is None:
                    candidates = [name for name, layer in layers.items() if any(
                        f.get("geometry", {}).get("type") in {"Polygon", "MultiPolygon"}
                        for f in layer["features"]
                    )]
                    if len(candidates) > 1:
                        raise ExtractionError("ポリゴンレイヤーが複数あります。--layer を指定してください。")
                    if not candidates:
                        continue
                    layer_name = candidates[0]
                if layer_name not in layers:
                    continue
                statistics["tiles_with_layer"] += 1
                layer = layers[layer_name]
                extent = layer["extent"]
                if not isinstance(extent, int) or extent <= 0:
                    raise ExtractionError("MVTレイヤーのextentが不正です。")
                for feature in layer["features"]:
                    if feature.get("geometry", {}).get("type") not in {"Polygon", "MultiPolygon"}:
                        continue
                    statistics["polygon_features_seen"] += 1
                    properties = feature.get("properties", {})
                    if any(field not in properties for field, _ in filters):
                        raise ExtractionError("--filter で指定した属性がありません。inspectで属性名を確認してください。")
                    if any(str(properties.get(field)) != value for field, value in filters):
                        statistics["features_filtered"] += 1
                        continue
                    if postcode_field is None:
                        postcode_field = choose_field(properties)
                        log(f"対象: layer={layer_name}, postcode_field={postcode_field}")
                    postcode = normalize_postcode(properties.get(postcode_field))
                    if postcode is None:
                        statistics["invalid_or_missing_postcodes"] += 1
                        continue
                    if args.postcode_prefix and not postcode.startswith(args.postcode_prefix):
                        statistics["features_filtered"] += 1
                        continue
                    fragment, repaired = global_fragment(feature, x, y, extent)
                    statistics["geometries_repaired"] += int(repaired)
                    if fragment.is_empty:
                        statistics["empty_after_clip"] += 1
                        continue
                    db.execute("INSERT INTO fragments VALUES (?, ?, ?)", (
                        postcode, fragment.wkb,
                        json.dumps(properties, ensure_ascii=False, sort_keys=True, allow_nan=False),
                    ))
                    statistics["fragments_saved"] += 1
                if statistics["tiles_examined"] % 500 == 0:
                    db.commit()
                    log(f"タイル {statistics['tiles_examined']:,} / 保存した断片 {statistics['fragments_saved']:,}")
            db.commit()
            if not statistics["fragments_saved"]:
                raise ExtractionError("出力対象が0件です。zoom・レイヤー・属性名・フィルターを確認してください。")
            db.execute("CREATE INDEX postcode_idx ON fragments(postcode)")
            codes = [row[0] for row in db.execute("SELECT DISTINCT postcode FROM fragments ORDER BY postcode")]
            fd, name = tempfile.mkstemp(prefix=f".{args.output.name}.", suffix=".tmp", dir=args.output.parent)
            os.close(fd)
            temporary = Path(name)
            try:
                with temporary.open("w", encoding="utf-8", newline="\n") as stream:
                    stream.write('{"type":"FeatureCollection","features":[\n')
                    for index, postcode in enumerate(codes):
                        geometry = union_rows(db.execute(
                            "SELECT geometry FROM fragments WHERE postcode=?", (postcode,)
                        ))
                        if geometry.is_empty or not geometry.is_valid:
                            raise ExtractionError(f"結合結果が空または不正です: {postcode}")
                        attributes = [json.loads(row[0]) for row in db.execute(
                            "SELECT DISTINCT properties FROM fragments WHERE postcode=? ORDER BY properties", (postcode,)
                        )]
                        count = db.execute("SELECT COUNT(*) FROM fragments WHERE postcode=?", (postcode,)).fetchone()[0]
                        feature = {
                            "type": "Feature", "id": postcode,
                            "properties": {
                                "postcode": postcode, "source_layer": layer_name, "zoom": zoom,
                                "fragment_count": count, "source_attributes": attributes,
                            },
                            "geometry": mapping(to_lonlat(geometry, zoom)),
                        }
                        if index:
                            stream.write(",\n")
                        json.dump(feature, stream, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
                        if (index + 1) % 1000 == 0:
                            log(f"結合・出力: {index + 1:,} / {len(codes):,} 郵便番号")
                    stream.write("\n]}\n")
                os.replace(temporary, args.output)
            finally:
                temporary.unlink(missing_ok=True)
        report = {
            "created_at_utc": datetime.now(timezone.utc).isoformat(),
            "input": str(args.input.resolve()), "output": str(args.output.resolve()),
            "zoom": zoom, "layer": layer_name, "postcode_field": postcode_field,
            "postcode_prefix": args.postcode_prefix, "filters": filters,
            "postcode_count": len(codes), "statistics": statistics,
            "archive_metadata": metadata,
            "coverage": "All available polygons in the selected layer at one zoom, after filters; not independently verified against Japan Post.",
            "geometry_note": "Reconstructed from quantized display tiles; simplification, omissions and seam artifacts may remain.",
        }
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        log(f"完了: {len(codes):,} 郵便番号 → {args.output.resolve()}")
        log(f"処理記録: {report_path.resolve()}")
        if statistics["invalid_or_missing_postcodes"]:
            log(f"郵便番号が欠損／不正で除外した地物: {statistics['invalid_or_missing_postcodes']:,} 件")


def build_parser():
    parser = argparse.ArgumentParser(description="郵便番号PMTilesを取得し、GeoJSONに変換します。")
    commands = parser.add_subparsers(dest="command", required=True)
    download = commands.add_parser("download", help="指定URLのPMTilesを一度だけ取得")
    download.add_argument("--url", default=DEFAULT_URL)
    download.add_argument("--output", type=Path, default=Path("postal.pmtiles"))
    download.add_argument("--overwrite", action="store_true")
    for name, help_text in [("inspect", "属性・レイヤー・zoomを表示"), ("extract", "郵便番号ごとに結合してGeoJSON保存")]:
        command = commands.add_parser(name, help=help_text)
        command.add_argument("--input", type=Path, default=Path("postal.pmtiles"))
        command.add_argument("--zoom", default="max", help="max（既定）または整数")
        if name == "inspect":
            command.add_argument("--sample-tiles", type=int, default=20)
        else:
            command.add_argument("--output", type=Path, default=Path("postal_polygons.geojson"))
            command.add_argument("--layer", help="対象MVTレイヤー名。未指定時は一意に決まる場合のみ自動検出")
            command.add_argument("--postcode-field", help="郵便番号の属性名")
            command.add_argument("--postcode-prefix", help="郵便番号の先頭1〜7桁で絞り込み")
            command.add_argument("--filter", dest="filters", action="append", default=[], help="属性一致 FIELD=VALUE。複数指定はAND")
            command.add_argument("--work-dir", type=Path, help="一時SQLiteの保存先。容量に余裕のあるフォルダを指定")
            command.add_argument("--overwrite", action="store_true")
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "download":
            download_file(args.url, args.output, args.overwrite)
        elif args.command == "inspect":
            if args.sample_tiles <= 0:
                raise ExtractionError("--sample-tiles は1以上にしてください。")
            inspect_archive(args)
        else:
            extract_archive(args)
        return 0
    except KeyboardInterrupt:
        log("中断しました。")
        return 130
    except Exception as exc:
        log(f"エラー: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
