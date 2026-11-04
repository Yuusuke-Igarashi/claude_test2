#!/usr/bin/env python3
"""タシケントの道路・歩行者ネットワークを2つの有向グラフに変換する。（版 2026-11-02b: レビュー対応版）

Python 3.10+。依存ライブラリ:
    python -m pip install geopandas networkx pyproj pyogrio

実行例（入力GeoPackageと本スクリプトを同じフォルダに置く場合）:
    python build_tashkent_graphs.py --input Tashkent_Road_Network.gpkg --output-dir graphs

道路網を幹線だけに絞る例（既定は residential 等も含む）:
    python build_tashkent_graphs.py --input Tashkent_Road_Network.gpkg \
        --output-dir graphs --road-highways primary,primary_link,secondary,secondary_link,tertiary,tertiary_link

入力:
    既に接続点で分割された network_edges レイヤーと、元タグを保持した
    all_highway_ways レイヤー。単なる道路線の集合から接続関係を推定する処理ではない。

処理方針:
    ・道路: 既定ではmotorway/trunk/primary/secondary/tertiary/unclassified/residential/living_streetと各*_link。
      oneway=yes/-1/no、車種別oneway、roundabout、motorwayの暗黙的一方通行を反映。
    ・歩行者: 道路網の選択とは独立に決める。全道路区分＋footway/pedestrian/path/steps/corridorから、
      --walk-exclude（既定 motorway/motorway_link/trunk/trunk_link）とfoot=no等の線を除く。基本は双方向。
      車両向けonewayは適用せず、oneway:footとfoot:forward/backwardを反映。
      footway等に付いたonewayは既定で無視し件数だけ数える（--footway-oneway applyで適用）。
    ・ノードIDは元のOSM IDを保持。始点=from_node、終点=to_nodeとして
      LineStringの両端から経緯度を補完。
    ・座標が同じでもOSM IDが異なる点は結合しない。平面交差を新設しない。
    ・MultiDiGraphで並行エッジと自己ループを保持。逆方向の線形状も反転する。
    ・最も具体的なaccessタグがno/private/use_sidepathなら既定では除外。
      --include-restrictedで保持可能。destination/customers等は保持しタグで識別。
    ・reversible/alternating等、静的に方向を決められないエッジは除外し、skipped_edges.csvに記録。
    ・不正なデータは既定では該当エッジだけを除外して skipped_edges.csv に記録し、処理を続ける:
      1部だけのMultiLineStringはLineStringに変換、複数部はlinemergeで1本になれば使う（向きはfrom_nodeに合わせる）、
      整数値のfloat ID（123.0）は整数として受け入れる、同じノードIDの座標不一致（許容値超）・長さ0・空の幾何は除外、
      エッジ層と元wayのタグ不一致はエッジ層の値を使う。--strict を付けると従来どおり最初の不正で停止する。

出力（選択した形式に応じて作成）:
    road.graphml / walk.graphml                    NetworkX用（--no-graphml-tags で tags_json を省いて軽くできる）
    road_nodes.csv / road_edges.csv                道路のノード・エッジ
    walk_nodes.csv / walk_edges.csv                歩行者のノード・エッジ
    network_graphs.gpkg                            上記4レイヤー、EPSG:4326
    skipped_edges.csv / summary.json               除外理由・設定・集計
    CSVのgeometry_wktはWKT。x=経度、y=緯度。length_mはWGS84測地線長。
    エッジ属性に maxspeed / lanes / surface / sidewalk / service の列を含む（元タグそのまま）。
    GraphML読込例:
        G = networkx.read_graphml('graphs/road.graphml', node_type=int,
                                 edge_key_type=str, force_multigraph=True)
        route = networkx.shortest_path(G, start_id, end_id, weight='length_m')

範囲と限界:
    元データの分割と市外延長部分を保持。次数2のノードの簡略化は行わない。
    道路・歩行者グラフは同じOSM IDを共有し得るが、相互の乗換リンクは作らない。
    sidewalk属性から未収録の歩道線は生成しない。欠落した接続の補完はしない。
    sidewalk=separate の車道線は歩行者網に残す（歩道線と並行する。--walk-drop-sidewalk-separate で除外）。
    cycleway/bridleway/platform等は既定の歩行者対象外。必要なら--pedestrian-highways
    に列挙する。その場合もfoot等のタグを確認すること。
    バリア点の通行可否、ターン制限relation、条件付き・時間帯別制限は適用しない。
    通行権・現地の歩道網羅率を保証するルーティングデータではない。

OSMタグの参照先:
    https://wiki.openstreetmap.org/wiki/Key:oneway
    https://wiki.openstreetmap.org/wiki/Key:oneway:foot
元データの出典・ライセンス（生成した地理データにも継承）:
    © OpenStreetMap contributors / Geofabrik
    https://www.openstreetmap.org/copyright
    https://opendatacommons.org/licenses/odbl/1-0/
"""

from __future__ import annotations

import argparse
from collections import Counter
import csv
from datetime import datetime, timezone
import json
import math
from numbers import Integral, Real
import os
from pathlib import Path
import re
import sys
import tempfile

try:
    import geopandas as gpd
    import networkx as nx
    from pyproj import Geod
    from shapely.geometry import LineString, MultiLineString, Point
    from shapely.ops import linemerge
    from shapely import wkt
except ImportError as exc:
    raise SystemExit(
        '必要なパッケージがありません。python -m pip install geopandas networkx pyproj pyogrio'
    ) from exc


VERSION = '2026-11-02b'
GEOD = Geod(ellps='WGS84')
LINKS = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary'}
MAJOR = LINKS | {f'{h}_link' for h in LINKS}
DEFAULT_ROAD = MAJOR | {'unclassified', 'residential', 'living_street'}
ROAD_CLASSES = MAJOR | {
    'unclassified', 'unclassified_link', 'residential', 'living_street',
    'service', 'road', 'track',
}
DEFAULT_WALK_EXCLUDE = {'motorway', 'motorway_link', 'trunk', 'trunk_link'}
DEFAULT_PEDESTRIAN = {'footway', 'pedestrian', 'path', 'steps', 'corridor'}
FORWARD = {'yes', '1', 'true'}
BACKWARD = {'-1', 'reverse'}
TWO_WAY = {'no', '0', 'false'}
BLOCKED = {'no', 'private', 'use_sidepath'}
ALIASES = {
    'oneway_foot': 'oneway:foot', 'oneway_motor_vehicle': 'oneway:motor_vehicle', 'oneway_vehicle': 'oneway:vehicle',
    'oneway_motorcar': 'oneway:motorcar', 'foot_forward': 'foot:forward', 'foot_backward': 'foot:backward',
    'motor_vehicle_forward': 'motor_vehicle:forward', 'motor_vehicle_backward': 'motor_vehicle:backward',
}
EDGE_TAG_COLUMNS = ('highway', 'footway', 'foot', 'access', 'oneway', 'oneway_foot', 'bridge', 'tunnel', 'layer',
                    'maxspeed', 'lanes', 'surface', 'sidewalk', 'service', 'junction', 'motor_vehicle', 'name')
NODE_FIELDS = ['node_id', 'x', 'y', 'lon', 'lat', 'shared_with_other_graph']
EDGE_FIELDS = [
    'edge_id', 'source_edge_id', 'osm_way_id', 'u', 'v', 'highway', 'name',
    'direction', 'length_m', 'oneway', 'oneway_foot', 'access', 'foot',
    'motor_vehicle', 'junction', 'bridge', 'tunnel', 'layer',
    'maxspeed', 'lanes', 'surface', 'sidewalk', 'service',
    'has_conditional_tags', 'tags_json', 'geometry_wkt',
]
SKIP_FIELDS = ['source_edge_id', 'osm_way_id', 'graph', 'reason', 'value']


class EdgeProblem(ValueError):
    """1本のエッジだけに関わる不正。--strict でなければ除外して続行する。"""


def text(value) -> str:
    """欠損値をGraphMLへ渡さず、元の文字列を保つ。"""
    if value is None:
        return ''
    if isinstance(value, float) and math.isnan(value):
        return ''
    return str(value)


def integer_id(value, label: str) -> int:
    # 整数、整数値のfloat（123.0）、数字だけの文字列を受け入れる。丸め・欠損は接続点として使用しない。
    if isinstance(value, Integral) and not isinstance(value, bool):
        result = int(value)
    elif isinstance(value, Real) and math.isfinite(float(value)) and float(value).is_integer():
        result = int(value)
    elif isinstance(value, str) and re.fullmatch(r'[0-9]+(\.0+)?', value.strip()):
        result = int(float(value))
    else:
        raise EdgeProblem(f'{label}: 整数のOSM IDが必要です: {value!r}')
    if result <= 0:
        raise EdgeProblem(f'{label}: OSM IDは正の整数である必要があります')
    return result


def csv_set(value: str) -> set[str]:
    result = {item.strip().lower() for item in value.split(',') if item.strip()}
    if not result:
        raise argparse.ArgumentTypeError('カンマ区切りで1つ以上指定してください')
    return result


def csv_set_or_empty(value: str) -> set[str]:
    return {item.strip().lower() for item in value.split(',') if item.strip()}


def norm(value: str) -> str:
    return value.strip().lower()


def access_value(tags: dict[str, str], mode: str, suffix: str = '') -> str:
    keys = ['motorcar', 'motor_vehicle', 'vehicle', 'access'] if mode == 'road' else ['foot', 'access']
    return next((norm(tags[k + suffix]) for k in keys if tags.get(k + suffix)), '')


def directions(tags: dict[str, str], mode: str, footway_oneway: str, pedestrian: set) -> tuple[tuple[int, ...], str, bool]:
    """戻り値: 元線に対する進行方向(1/-1)、解決不能だったタグ値、歩行者区分のonewayを無視したか。"""
    ignored = False
    if mode == 'walk':
        value = norm(tags.get('oneway:foot', ''))
        plain = norm(tags.get('oneway', ''))
        if not value and plain and norm(tags.get('highway', '')) in pedestrian:
            if footway_oneway == 'apply':
                value = plain
            else:
                ignored = plain not in TWO_WAY
    else:
        keys = ('oneway:motorcar', 'oneway:motor_vehicle', 'oneway:vehicle', 'oneway')
        value = next((norm(tags[k]) for k in keys if tags.get(k)), '')
        if not value and (
            norm(tags.get('junction', '')) == 'roundabout' or norm(tags.get('highway', '')) == 'motorway'
        ):
            value = 'yes'
    if not value or value in TWO_WAY:
        return (1, -1), '', ignored
    if value in FORWARD:
        return (1,), '', ignored
    if value in BACKWARD:
        return (-1,), '', ignored
    return (), value, ignored


def register_node(coords: dict, node_id: int, coordinate, tolerance_m: float) -> None:
    lon, lat = float(coordinate[0]), float(coordinate[1])
    if not (math.isfinite(lon) and math.isfinite(lat) and -180 <= lon <= 180 and -90 <= lat <= 90):
        raise EdgeProblem(f'ノード{node_id}の経緯度が不正です: {(lon, lat)}')
    previous = coords.get(node_id)
    if previous is not None:
        distance = abs(GEOD.inv(previous[0], previous[1], lon, lat)[2])
        if not math.isfinite(distance) or distance > tolerance_m:
            raise EdgeProblem(f'同一ノード{node_id}の座標が{distance:.3f}m不一致です')
    else:
        coords[node_id] = (lon, lat)


def as_linestring(geometry, from_xy, to_xy, counts: Counter):
    """LineString に揃える。1部のMultiLineStringは変換、複数部はlinemergeで1本になれば使い、from_node側に向きを合わせる。"""
    if geometry is None or geometry.is_empty:
        raise EdgeProblem('空の幾何です')
    if geometry.geom_type == 'MultiLineString':
        parts = [p for p in geometry.geoms if not p.is_empty]
        if len(parts) == 1:
            geometry = parts[0]
            counts['geometry:multipart_single_converted'] += 1
        else:
            merged = linemerge(MultiLineString(parts))
            if merged.geom_type != 'LineString':
                raise EdgeProblem(f'複数部のMultiLineStringを1本に結合できません（{len(parts)}部）')
            geometry = merged
            counts['geometry:multipart_merged'] += 1
    if geometry.geom_type != 'LineString':
        raise EdgeProblem(f'LineStringが必要です: {geometry.geom_type}')
    if not geometry.is_valid:
        raise EdgeProblem('無効な幾何です')
    line = LineString([(c[0], c[1]) for c in geometry.coords])   # 経緯度の2次元線へ統一。元の線の向きはfrom_node -> to_node
    if from_xy is not None or to_xy is not None:                 # 結合後の向きが分かる範囲で from_node 側に合わせる
        start, end = line.coords[0], line.coords[-1]
        d_same = (GEOD.inv(*start, *from_xy)[2] if from_xy else 0) + (GEOD.inv(*end, *to_xy)[2] if to_xy else 0)
        d_flip = (GEOD.inv(*end, *from_xy)[2] if from_xy else 0) + (GEOD.inv(*start, *to_xy)[2] if to_xy else 0)
        if d_flip + 1e-9 < d_same:
            line = LineString(list(line.coords)[::-1]); counts['geometry:reoriented_to_from_node'] += 1
    return line


def load_source(source: Path, edges_layer: str, ways_layer: str):
    edges = gpd.read_file(source, layer=edges_layer)
    required = {'edge_id', 'osm_way_id', 'from_node', 'to_node', 'highway'}
    missing = required - set(edges.columns)
    if missing:
        raise ValueError(f'{edges_layer}の必須列がありません: {sorted(missing)}')
    if edges.crs is None:
        raise ValueError('入力の座標参照系が不明です。推定せず処理を停止します')
    if edges.empty:
        raise ValueError('入力エッジが0件です')
    if edges['edge_id'].isna().any() or edges['edge_id'].astype(str).str.strip().eq('').any():
        raise ValueError('edge_idに欠損・空文字があります')
    if not edges['edge_id'].astype(str).is_unique:
        raise ValueError('edge_idが一意ではありません')
    edges = edges.to_crs(4326)
    # network_edgesにはjunction等がないため、必ず元wayの全タグと突き合わせる。
    ways = gpd.read_file(source, layer=ways_layer, columns=['osm_id', 'tags_json'])
    if not {'osm_id', 'tags_json'} <= set(ways.columns):
        raise ValueError(f'{ways_layer}にはosm_idとtags_jsonが必要です')
    if not ways['osm_id'].is_unique:
        raise ValueError('元wayのosm_idが重複しています')
    way_tags = {}
    for row in ways.itertuples(index=False):
        way_id = integer_id(row.osm_id, 'osm_id')
        tags = json.loads(row.tags_json) if text(row.tags_json) else {}
        if not isinstance(tags, dict):
            raise ValueError(f'way {way_id}: tags_jsonがオブジェクトではありません')
        way_tags[way_id] = {str(k): text(v) for k, v in tags.items()}
    return edges, way_tags


def build_graphs(edges, way_tags: dict, road: set, walk_exclude: set, pedestrian: set,
                 include_restricted: bool = False, strict: bool = False,
                 coordinate_tolerance_m: float = 0.05, footway_oneway: str = 'ignore',
                 drop_sidewalk_separate: bool = False):
    graphs = {mode: nx.MultiDiGraph(
        crs='EPSG:4326', network_type=mode, source='OpenStreetMap / Geofabrik',
        attribution='© OpenStreetMap contributors', license='ODbL-1.0',
        turn_restrictions_applied=False, barriers_applied=False,
        conditional_restrictions_applied=False,
    ) for mode in ('road', 'walk')}
    walking = (ROAD_CLASSES | pedestrian) - walk_exclude
    coordinates, skipped, counts = {}, [], Counter()
    geometry_col = edges.geometry.name

    def skip(row, mode: str, reason: str, value: str):
        counts[f'{mode}:{reason}'] += 1
        skipped.append(dict(source_edge_id=text(row['edge_id']), osm_way_id=text(row['osm_way_id']),
                            graph=mode, reason=reason, value=value))

    def problem(row, mode: str, reason: str, exc: Exception):
        if strict:
            raise ValueError(f'{text(row["edge_id"])}: {exc}') from exc
        skip(row, mode, reason, str(exc))

    for row in edges.to_dict('records'):
        highway = norm(text(row['highway']))
        modes = [m for m, selected in (('road', highway in road), ('walk', highway in walking)) if selected]
        if not modes:
            counts[f'unselected_highway:{highway}'] += 1
            continue
        source_id = text(row['edge_id'])
        try:
            way_id = integer_id(row['osm_way_id'], 'osm_way_id')
            if way_id not in way_tags:
                raise EdgeProblem(f'元way {way_id}が見つかりません')
        except EdgeProblem as exc:
            for mode in modes:
                problem(row, mode, 'bad_way_id', exc)
            continue
        tags = dict(way_tags[way_id])
        for key in EDGE_TAG_COLUMNS:
            if key not in row:
                continue
            value = text(row.get(key))
            canonical = ALIASES.get(key, key)
            if value:
                if tags.get(canonical) and tags[canonical] != value:
                    if strict:
                        raise ValueError(f'{source_id}: 元wayとエッジの{canonical}が不一致です')
                    counts[f'tag_mismatch:{canonical}'] += 1            # エッジ層の値を優先して続行
                tags[canonical] = value
        tags['highway'] = highway
        # 幾何と端点（両グラフ共通）
        try:
            start = integer_id(row['from_node'], 'from_node')
            end = integer_id(row['to_node'], 'to_node')
            line = as_linestring(row[geometry_col], coordinates.get(start), coordinates.get(end), counts)
            length_m = abs(float(GEOD.geometry_length(line)))
            if not math.isfinite(length_m) or length_m <= 0:
                raise EdgeProblem(f'エッジ長が不正です: {length_m}')
            register_node(coordinates, start, line.coords[0], coordinate_tolerance_m)
            register_node(coordinates, end, line.coords[-1], coordinate_tolerance_m)
        except EdgeProblem as exc:
            for mode in modes:
                problem(row, mode, 'bad_geometry_or_node', exc)
            continue
        for mode in modes:
            denied = access_value(tags, mode)
            if not include_restricted and denied in BLOCKED:
                skip(row, mode, 'restricted_access', denied)
                continue
            if mode == 'walk' and drop_sidewalk_separate and norm(tags.get('sidewalk', '')) == 'separate':
                skip(row, mode, 'sidewalk_separate', 'separate')
                continue
            travel, unresolved, ignored = directions(tags, mode, footway_oneway, pedestrian)
            if ignored:
                counts['walk:oneway_on_pedestrian_way_ignored'] += 1
            if unresolved:
                skip(row, mode, 'unresolved_oneway', unresolved)
                continue
            if not include_restricted:
                travel = tuple(d for d in travel if access_value(
                    tags, mode, ':forward' if d == 1 else ':backward') not in BLOCKED)
            if not travel:
                skip(row, mode, 'directional_access', 'both_directions_blocked')
                continue
            graph = graphs[mode]
            for node_id in (start, end):
                lon, lat = coordinates[node_id]
                graph.add_node(node_id, x=lon, y=lat, lon=lon, lat=lat)
            attrs = dict(
                source_edge_id=source_id, osm_way_id=way_id, highway=highway,
                name=tags.get('name', ''), length_m=length_m,
                oneway=tags.get('oneway', ''), oneway_foot=tags.get('oneway:foot', ''),
                access=tags.get('access', ''), foot=tags.get('foot', ''),
                motor_vehicle=tags.get('motor_vehicle', ''), junction=tags.get('junction', ''),
                bridge=tags.get('bridge', ''), tunnel=tags.get('tunnel', ''), layer=tags.get('layer', ''),
                maxspeed=tags.get('maxspeed', ''), lanes=tags.get('lanes', ''), surface=tags.get('surface', ''),
                sidewalk=tags.get('sidewalk', ''), service=tags.get('service', ''),
                has_conditional_tags=any(':conditional' in k for k in tags),
                tags_json=json.dumps(tags, ensure_ascii=False, separators=(',', ':')),
            )
            for direction in travel:
                u, v = (start, end) if direction == 1 else (end, start)
                edge_id = f'{source_id}:{"f" if direction == 1 else "r"}'
                oriented = line if direction == 1 else LineString(list(line.coords)[::-1])
                graph.add_edge(u, v, key=edge_id, edge_id=edge_id,
                               direction='forward' if direction == 1 else 'backward',
                               geometry_wkt=oriented.wkt, **attrs)
            counts[f'{mode}:selected_source_edges'] += 1
    shared = set(graphs['road']) & set(graphs['walk'])
    for graph in graphs.values():
        nx.set_node_attributes(graph, {n: n in shared for n in graph}, 'shared_with_other_graph')
    return graphs, skipped, counts


def node_rows(graph):
    for node_id, attrs in graph.nodes(data=True):
        yield {'node_id': node_id, **attrs}


def edge_rows(graph):
    for u, v, key, attrs in graph.edges(keys=True, data=True):
        yield {**attrs, 'edge_id': key, 'u': u, 'v': v}


def write_csv(path: Path, rows, fields: list[str]) -> None:
    with path.open('w', encoding='utf-8-sig', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=fields, extrasaction='raise')
        writer.writeheader()
        writer.writerows(rows)


def export_graphs(graphs, output: Path, formats: set[str], graphml_tags: bool = True) -> None:
    gpkg = output / 'network_graphs.gpkg'
    for mode, graph in graphs.items():
        if 'graphml' in formats:
            target = graph
            if not graphml_tags:                                   # tags_json を省いた複製を書く（元のグラフは変えない）
                target = nx.MultiDiGraph(**graph.graph)
                target.add_nodes_from(graph.nodes(data=True))
                target.add_edges_from((u, v, k, {a: b for a, b in d.items() if a != 'tags_json'})
                                      for u, v, k, d in graph.edges(keys=True, data=True))
            nx.write_graphml(target, output / f'{mode}.graphml', encoding='utf-8')
        if 'csv' in formats:
            write_csv(output / f'{mode}_nodes.csv', node_rows(graph), NODE_FIELDS)
            write_csv(output / f'{mode}_edges.csv', edge_rows(graph), EDGE_FIELDS)
        if 'gpkg' in formats:
            nodes, links = list(node_rows(graph)), list(edge_rows(graph))
            points = gpd.GeoDataFrame(
                nodes, columns=NODE_FIELDS,
                geometry=[Point(n['x'], n['y']) for n in nodes], crs=4326)
            lines = gpd.GeoDataFrame(
                links, columns=EDGE_FIELDS,
                geometry=[wkt.loads(e['geometry_wkt']) for e in links], crs=4326)
            # 空のグラフも空レイヤーとして出力。geometry_typeで型を明示する。
            points.to_file(gpkg, layer=f'{mode}_nodes', driver='GPKG', engine='pyogrio',
                           geometry_type='Point')
            lines.to_file(gpkg, layer=f'{mode}_edges', driver='GPKG', engine='pyogrio',
                          geometry_type='LineString')


def graph_summary(graph) -> dict:
    components = [len(nodes) for nodes in nx.weakly_connected_components(graph)]
    return dict(nodes=graph.number_of_nodes(), directed_edges=graph.number_of_edges(),
                weak_components=len(components), largest_weak_component_nodes=max(components, default=0),
                self_loop_arcs=nx.number_of_selfloops(graph))


def main(argv=None) -> int:
    print(f'build_tashkent_graphs.py 版 {VERSION}', flush=True)
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--input', type=Path, required=True, help='入力GeoPackage')
    parser.add_argument('--output-dir', type=Path, default=Path('graphs'))
    parser.add_argument('--edges-layer', default='network_edges')
    parser.add_argument('--ways-layer', default='all_highway_ways')
    parser.add_argument('--road-highways', '--major-highways', dest='road_highways', type=csv_set, default=DEFAULT_ROAD,
                        help='道路グラフに入れるhighway区分（既定: motorway〜tertiaryと各link、unclassified、residential、living_street）')
    parser.add_argument('--walk-exclude', type=csv_set_or_empty, default=DEFAULT_WALK_EXCLUDE,
                        help='歩行者グラフから除くhighway区分（既定: motorway,motorway_link,trunk,trunk_link。空文字で除外なし）')
    parser.add_argument('--pedestrian-highways', type=csv_set, default=DEFAULT_PEDESTRIAN,
                        help='道路区分に加える歩行者専用の区分。指定時は既定値を置き換える')
    parser.add_argument('--footway-oneway', choices=['ignore', 'apply'], default='ignore',
                        help='歩行者専用区分に付いたoneway（oneway:footではない）の扱い')
    parser.add_argument('--walk-drop-sidewalk-separate', action='store_true', help='sidewalk=separateの車道線を歩行者グラフから除く')
    parser.add_argument('--formats', type=csv_set, default={'csv', 'graphml', 'gpkg'})
    parser.add_argument('--no-graphml-tags', action='store_true', help='GraphMLにtags_jsonを入れない（CSV/GPKGには入る）')
    parser.add_argument('--include-restricted', action='store_true')
    parser.add_argument('--strict', action='store_true', help='不正なエッジで除外せず停止する（旧版の挙動）')
    parser.add_argument('--unknown-oneway', choices=['skip', 'error'], default='skip', help='互換用。errorは--strictと同じ扱い')
    parser.add_argument('--coordinate-tolerance-m', type=float, default=0.05)
    parser.add_argument('--overwrite', action='store_true', help='本スクリプトの同名出力を上書き')
    args = parser.parse_args(argv)
    strict = args.strict or args.unknown_oneway == 'error'
    if not args.input.is_file():
        parser.error(f'入力ファイルがありません: {args.input}')
    if args.formats - {'csv', 'graphml', 'gpkg'}:
        parser.error('--formatsにはcsv,graphml,gpkgから指定してください')
    if not math.isfinite(args.coordinate_tolerance_m) or args.coordinate_tolerance_m < 0:
        parser.error('--coordinate-tolerance-mには0以上の有限値を指定してください')
    expected = {'skipped_edges.csv', 'summary.json'}
    for mode in ('road', 'walk'):
        if 'csv' in args.formats:
            expected.update({f'{mode}_nodes.csv', f'{mode}_edges.csv'})
        if 'graphml' in args.formats:
            expected.add(f'{mode}.graphml')
    if 'gpkg' in args.formats:
        expected.add('network_graphs.gpkg')
    if any((args.output_dir / name).resolve() == args.input.resolve() for name in expected):
        parser.error('入力ファイルと出力ファイルのパスが重複しています')
    existing = sorted(name for name in expected if (args.output_dir / name).exists())
    if existing and not args.overwrite:
        parser.error(f'同名出力が存在します。別の出力先か--overwriteを指定: {existing}')
    print('入力レイヤーを読み込みます。', flush=True)
    edges, tags = load_source(args.input, args.edges_layer, args.ways_layer)
    walk_highways = sorted((ROAD_CLASSES | args.pedestrian_highways) - args.walk_exclude)
    graphs, skipped, counts = build_graphs(
        edges, tags, args.road_highways, args.walk_exclude, args.pedestrian_highways,
        args.include_restricted, strict, args.coordinate_tolerance_m, args.footway_oneway,
        args.walk_drop_sidewalk_separate)
    summary = dict(
        created_at_utc=datetime.now(timezone.utc).isoformat(), script_version=VERSION, input=str(args.input.resolve()),
        input_edges=len(edges), crs='EPSG:4326', coordinate_order='x=longitude, y=latitude',
        settings=dict(road_highways=sorted(args.road_highways), walk_highways=walk_highways,
                      walk_exclude=sorted(args.walk_exclude), pedestrian_highways=sorted(args.pedestrian_highways),
                      footway_oneway=args.footway_oneway, walk_drop_sidewalk_separate=args.walk_drop_sidewalk_separate,
                      include_restricted=args.include_restricted, strict=strict,
                      coordinate_tolerance_m=args.coordinate_tolerance_m, formats=sorted(args.formats),
                      graphml_tags=not args.no_graphml_tags),
        road=graph_summary(graphs['road']), walk=graph_summary(graphs['walk']),
        shared_nodes=len(set(graphs['road']) & set(graphs['walk'])),
        counts=dict(sorted(counts.items())), skipped_selected_edges=len(skipped),
        limitations=['市境で切断せず元エッジを保持', '幾何交差・近接による新規接続なし',
                     '未収録の歩道・接続は補完しない', 'ターン制限・バリアの通行可否・条件付き制限は未適用',
                     '歩行者グラフは道路グラフと独立に選ぶ（既定でmotorway/trunkのみ除外）',
                     '不正なエッジは既定で除外して続行（skipped_edges.csv）'],
        attribution='© OpenStreetMap contributors / Geofabrik',
        license='ODbL 1.0: https://opendatacommons.org/licenses/odbl/1-0/',
    )
    args.output_dir.mkdir(parents=True, exist_ok=True)
    # 全形式の出力完了後に移動し、書出しエラーによる不完全な成果物を残しにくくする。
    with tempfile.TemporaryDirectory(prefix='.graph_build_', dir=args.output_dir) as temp:
        staging = Path(temp)
        export_graphs(graphs, staging, args.formats, graphml_tags=not args.no_graphml_tags)
        write_csv(staging / 'skipped_edges.csv', skipped, SKIP_FIELDS)
        (staging / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
        for name in sorted(expected):
            destination = args.output_dir / name
            if destination.exists() and not args.overwrite:
                raise FileExistsError(f'処理中に出力ファイルが作成されました: {destination}')
            os.replace(staging / name, destination)
    print(json.dumps({k: summary[k] for k in ('road', 'walk', 'shared_nodes', 'skipped_selected_edges')},
                     ensure_ascii=False, indent=2))
    print('除外・変換の内訳:', json.dumps({k: v for k, v in summary['counts'].items() if not k.startswith('unselected_highway')}, ensure_ascii=False))
    print(f'出力先: {args.output_dir.resolve()}')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError) as exc:
        print(f'ERROR: {exc}', file=sys.stderr)
        raise SystemExit(1) from exc
