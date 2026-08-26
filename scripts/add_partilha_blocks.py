import json
import shapefile
from shapely.geometry import shape

# Adiciona 7 dos 8 projetos que ficavam sem poligonal em contratos.geojson
# (ver PLAN em build_geojson.py) — não vieram do shapefile unificado de
# blocos exploratórios (não fornecido), mas de três shapefiles por rodada,
# recebidos depois:
#   - Rodada3_Presal.shp (3ª Rodada de Partilha, leilão 27/10/2017,
#     assinatura 31/01/2018): Peroba, Alto de Cabo Frio Oeste (mais Alto
#     de Cabo Frio Central, que já tinha poligonal — ignorado aqui).
#   - PS_R4_v11_SDT.shp (4ª Rodada de Partilha, leilão 07/06/2018,
#     assinatura 17/12/2018): Dois Irmãos, Três Marias (mais Uirapuru e
#     Itaimbezinho, que já tinham poligonal — ignorados aqui; Itaimbezinho
#     é o mesmo bloco físico reofertado depois na Oferta Permanente, área
#     idêntica — não é coincidência).
#   - Blocos_Partilha_5_SDT.shp (5ª Rodada de Partilha, leilão 28/09/2018,
#     assinatura 17/12/2018): Pau-Brasil, Saturno, Titã (mais Sudoeste de
#     Tartaruga Verde, que já tinha poligonal — ignorado aqui).
# Só Sul de Gato do Mato continua sem poligonal (FID recente, 2025 — ver
# PROJECTS_WITHOUT_SHAPE em mapa.js e o fallback de operador em
# wellOperatorFallback, app.js).
#
# Ajuste os caminhos abaixo pros shapefiles de cada rodada (SIRGAS 2000,
# mesmo CRS do resto do projeto — sem reprojeção necessária). O campo com
# o nome do bloco varia de rodada pra rodada (ver name_field no PLAN).
P3_PATH = 'sources/Rodada3_Presal/Rodada3_Presal.shp'
P4_PATH = 'sources/PS_R4_v11_SDT/PS_R4_v11_SDT.shp'
P5_PATH = 'sources/Blocos_Partilha_5_SDT/Blocos_Partilha_5_SDT.shp'

# projeto -> (shapefile, campo com o nome do bloco nesse shapefile, nome
# do bloco, bacia, operador, rodada, assinatura) — bacia e operador vieram
# de checagem externa (o shapefile por rodada só tem nome/área/ID, sem
# esses campos): confirmados por reportagem da época (bacia) e pelo
# operador do poço pioneiro de cada um (ver data/pocos.json), na grafia já
# usada em contratos.geojson/COMPANY_ALIASES (shared.js). Assinatura =
# mesma data do marco "Assinatura" já cadastrado pro projeto em shared.js
# (mesma rodada, mesma data de assinatura pra todo bloco dela — inclusive
# entre a 4ª e a 5ª rodada, assinadas no mesmo dia).
PLAN = {
    'Peroba': (P3_PATH, 'Nome', 'Peroba', 'SANTOS',
               'Petróleo Brasileiro S.A. - PETROBRAS', 'Partilha 3', '31-01-2018'),
    'Alto de Cabo Frio Oeste': (P3_PATH, 'Nome', 'Alto de Cabo Frio Oeste', 'CAMPOS',
               'Shell Brasil Petróleo Ltda.', 'Partilha 3', '31-01-2018'),
    'Dois Irmãos': (P4_PATH, 'Nome_Campo', 'Dois Irmãos', 'CAMPOS',
               'Petróleo Brasileiro S.A. - PETROBRAS', 'Partilha 4', '17-12-2018'),
    'Três Marias': (P4_PATH, 'Nome_Campo', 'Três Marias', 'SANTOS',
               'Petróleo Brasileiro S.A. - PETROBRAS', 'Partilha 4', '17-12-2018'),
    'Pau-Brasil': (P5_PATH, 'Nome', 'Pau-Brasil', 'SANTOS',
               'BP Energy do Brasil Ltda.', 'Partilha 5', '17-12-2018'),
    'Saturno': (P5_PATH, 'Nome', 'Saturno', 'SANTOS',
               'Shell Brasil Petróleo Ltda.', 'Partilha 5', '17-12-2018'),
    'Titã': (P5_PATH, 'Nome', 'Titã', 'SANTOS',
               'ExxonMobil Exploração Brasil Ltda.', 'Partilha 5', '17-12-2018'),
}

readers = {}
def get_reader(path):
    if path not in readers:
        readers[path] = shapefile.Reader(path, encoding='latin1')
    return readers[path]

new_features = []
for projeto, (path, name_field, nome, bacia, operador, rodada, assinatura) in PLAN.items():
    r = get_reader(path)
    fields = [f[0] for f in r.fields[1:]]
    idx = fields.index(name_field)
    match = next((sr for sr in r.iterShapeRecords() if sr.record[idx] == nome), None)
    if not match:
        print('NAO ENCONTRADO:', projeto)
        continue
    geom = shape(match.shape.__geo_interface__)
    area = match.record[fields.index('Area')]
    new_features.append({
        'type': 'Feature',
        'properties': {
            'projeto': projeto,
            'fonte': 'bloco_exploratorio',
            'bacia': bacia,
            'operador': operador,
            'rodada': rodada,
            'assinatura': assinatura,
            'area_km2': round(float(area), 2),
        },
        'geometry': json.loads(json.dumps(geom.__geo_interface__)),
    })
    print(f'{projeto}: area={area:.2f} km2, bacia={bacia}, geom_type={geom.geom_type}')

with open('data/contratos.geojson') as f:
    data = json.load(f)

existing_names = {f['properties']['projeto'] for f in data['features']}
for feat in new_features:
    name = feat['properties']['projeto']
    if name in existing_names:
        print(f'JA EXISTE, pulando: {name}')
        continue
    data['features'].append(feat)

with open('data/contratos.geojson', 'w') as f:
    json.dump(data, f, ensure_ascii=False, separators=(',', ':'))

print('contratos.geojson atualizado. Total features:', len(data['features']))
