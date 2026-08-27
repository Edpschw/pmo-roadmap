import json
import shapefile
from shapely.geometry import shape, mapping

# Duas camadas de contexto geográfico "de fundo" pro mapa — só contorno,
# sem preenchimento (ver mapa.js), pra situar visualmente contratos/campos
# sem competir com eles: o polígono do play do pré-sal (ANP) e as bacias
# sedimentares do Brasil (ANP/GISHub), enviados pelo usuário em 27/08/2026.

# Caminhos relativos à raiz do repo — rode como `python3 scripts/build_contornos.py`
# a partir da raiz, com os shapefiles brutos em scripts/sources/ (não versionado).
PRESAL_PATH = 'scripts/sources/presal_shp_geoanp/presal_shp_geoanp.shp'
BACIAS_PATH = 'scripts/sources/bacias_gishub_db/bacias_gishub_db.shp'

def round_coords(c, nd=5):
    if isinstance(c[0], (int, float)):
        return [round(c[0], nd), round(c[1], nd)]
    return [round_coords(x, nd) for x in c]

# --- Play do pré-sal: 1 polígono só, já enxuto (13 pontos) — sem simplificar. ---
presal_r = shapefile.Reader(PRESAL_PATH, encoding='latin1')
presal_shp = presal_r.shape(0)
presal_geom = presal_shp.__geo_interface__
presal_geom['coordinates'] = round_coords(presal_geom['coordinates'])
presal_fc = {
    'type': 'FeatureCollection',
    'features': [{'type': 'Feature', 'properties': {'nome': 'Play do Pré-sal'}, 'geometry': presal_geom}],
}
with open('data/pre_sal_contorno.geojson', 'w', encoding='utf-8') as f:
    json.dump(presal_fc, f, ensure_ascii=False, separators=(',', ':'))
print('pre_sal_contorno.geojson: 1 feature,', len(presal_shp.points), 'pontos')

# --- Bacias sedimentares: 72 polígonos, ~345 mil pontos no dado bruto (alta
# resolução de costa/limite geológico) — pesado demais pra uma camada que é
# só referência visual discreta de fundo. Simplifica geometria (Douglas-
# Peucker via shapely, tolerância 0.02° ~ 2km) antes de gravar: reduz pra
# ~11 mil pontos mantendo a forma reconhecível de cada bacia, sem o
# serrilhado fino da linha de costa original que não faz diferença nenhuma
# num contorno fino e discreto (ver estilo em mapa.js).
bacias_r = shapefile.Reader(BACIAS_PATH, encoding='latin1')
bacias_features = []
total_pts = 0
for sr in bacias_r.iterShapeRecords():
    rec = sr.record.as_dict()
    geom = shape(sr.shape.__geo_interface__).simplify(0.02, preserve_topology=True)
    geo_interface = mapping(geom)
    geo_interface['coordinates'] = round_coords(geo_interface['coordinates'])
    if geo_interface['type'] == 'Polygon':
        total_pts += len(geo_interface['coordinates'][0])
    props = {
        'nome': rec.get('name', ''),
        'situacao': rec.get('situacao', ''),
    }
    bacias_features.append({'type': 'Feature', 'properties': props, 'geometry': geo_interface})

bacias_fc = {'type': 'FeatureCollection', 'features': bacias_features}
with open('data/bacias.geojson', 'w', encoding='utf-8') as f:
    json.dump(bacias_fc, f, ensure_ascii=False, separators=(',', ':'))
print('bacias.geojson:', len(bacias_features), 'features,', total_pts, 'pontos (simplificado)')
