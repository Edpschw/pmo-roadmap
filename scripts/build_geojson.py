import shapefile, json

blocos = shapefile.Reader('blocos_exploratorios/BLOCOS_EXPLORATORIOS_SIRGASPolygon.shp', encoding='latin1')
campos = shapefile.Reader('campos_producao/CAMPOS_PRODUCAO_SIRGASPolygon.shp', encoding='latin1')

# project name -> (source reader, key field, [key values]) source: 'bloco' | 'campo'
PLAN = {
    'Libra': ('bloco', 'COD_BLOCO', ['LIBRA']),
    'Norte de Carcará': ('campo', 'SIG_CAMPO', ['BAC', 'BACN']),
    'Entorno de Sapinhoá': ('campo', 'SIG_CAMPO', ['SWSH', 'NWSH', 'NESH']),
    'Alto de Cabo Frio Central': ('bloco', 'COD_BLOCO', ['ALTO_CF_CE']),
    'Uirapuru': ('bloco', 'COD_BLOCO', ['BLC_UIRAPR']),
    'Sudoeste de Tartaruga Verde': ('bloco', 'COD_BLOCO', ['SO_TRTG_VD']),
    'Aram': ('bloco', 'COD_BLOCO', ['ARAM']),
    'Búzios': ('campo', 'SIG_CAMPO', ['BUZ', 'BUZE']),
    'Itapu': ('campo', 'SIG_CAMPO', ['ITP', 'ITPE']),
    'Sépia': ('campo', 'SIG_CAMPO', ['SEP', 'SEPL', 'SEPE']),
    'Atapu': ('campo', 'SIG_CAMPO', ['ATP', 'ATPE']),
    'Água Marinha': ('bloco', 'COD_BLOCO', ['ÁGUA-MARIN']),
    'Norte de Brava': ('bloco', 'COD_BLOCO', ['N_DE_BRAVA']),
    'Bumerangue': ('bloco', 'COD_BLOCO', ['BUMERANGUE']),
    'Sudoeste de Sagitário': ('bloco', 'COD_BLOCO', ['SO_DE_SGTR']),
    'Tupinambá': ('bloco', 'COD_BLOCO', ['TUPINAMBÁ']),
    'Esmeralda': ('bloco', 'COD_BLOCO', ['Esmeralda']),
    'Ametista': ('bloco', 'COD_BLOCO', ['Ametista']),
    'Citrino': ('bloco', 'COD_BLOCO', ['Citrino']),
    'Itaimbezinho': ('bloco', 'COD_BLOCO', ['Itaimbezin']),
    'Jaspe': ('bloco', 'COD_BLOCO', ['Jaspe']),
}
# Projetos sem shapefile disponível nos dois arquivos fornecidos (devolvidos
# há mais tempo, ou área ainda não declarada oficialmente): Sul de Gato do
# Mato, Pau-Brasil, Peroba, Alto de Cabo Frio Oeste, Dois Irmãos, Três
# Marias, Saturno, Titã.

def records_matching(reader, key_field, values):
    fields = [f[0] for f in reader.fields[1:]]
    idx = fields.index(key_field)
    out = []
    for i, rec in enumerate(reader.iterRecords()):
        if rec[idx] in values:
            out.append(i)
    return out

features = []
summary = []
for name, (source, key_field, values) in PLAN.items():
    reader = blocos if source == 'bloco' else campos
    idxs = records_matching(reader, key_field, values)
    if not idxs:
        summary.append((name, source, values, 'NAO ENCONTRADO'))
        continue
    geoms = []
    attrs_list = []
    for i in idxs:
        shp = reader.shape(i)
        geoms.append(shp.__geo_interface__)
        rec = reader.record(i).as_dict()
        attrs_list.append(rec)
    # Junta em MultiPolygon se houver mais de uma peça
    polys = []
    for g in geoms:
        if g['type'] == 'Polygon':
            polys.append(g['coordinates'])
        elif g['type'] == 'MultiPolygon':
            polys.extend(g['coordinates'])
    geometry = {'type': 'MultiPolygon', 'coordinates': polys} if len(polys) > 1 else {'type': 'Polygon', 'coordinates': polys[0]}

    a0 = attrs_list[0]
    if source == 'bloco':
        props = {
            'projeto': name,
            'fonte': 'bloco_exploratorio',
            'bacia': a0.get('NOM_BACIA', ''),
            'operador': a0.get('OPERADOR_C', ''),
            'rodada': a0.get('RODADA', ''),
            'assinatura': a0.get('DAT_ASSINA', ''),
            'area_km2': sum(float(a.get('AREA_TOTAL') or 0) for a in attrs_list),
        }
    else:
        # Campo "principal" = o de código mais curto (sem sufixo _ECO/LESTE/
        # NORTE/etc.), usado como referência de rodada/regime de origem —
        # sub-áreas do mesmo contrato costumam ter NUM_RODADA divergente
        # entre si (ex.: Búzios/Sépia/Atapu/Itapu nasceram na Cessão Onerosa
        # de 2010 e só viraram partilha depois, no leilão do excedente).
        primary = min(attrs_list, key=lambda a: len(a.get('SIG_CAMPO') or 'zzzzzzzz'))
        props = {
            'projeto': name,
            'fonte': 'campo_producao',
            'bacia': a0.get('NOM_BACIA', ''),
            'operador': a0.get('OPERADOR_C', ''),
            'campos': ', '.join(sorted(set(a.get('NOM_CAMPO', '') for a in attrs_list))),
            'rodada': primary.get('NUM_RODADA', ''),
            'inicio_producao': a0.get('DAT_INICIO', ''),
            'area_km2': sum(float(a.get('AREA') or 0) for a in attrs_list),
        }
    features.append({'type': 'Feature', 'properties': props, 'geometry': geometry})
    summary.append((name, source, values, f'{len(idxs)} peça(s)'))

def round_coords(c, nd=5):
    if isinstance(c[0], (int, float)):
        return [round(c[0], nd), round(c[1], nd)]
    return [round_coords(x, nd) for x in c]

for feat in features:
    feat['geometry']['coordinates'] = round_coords(feat['geometry']['coordinates'])

fc = {'type': 'FeatureCollection', 'features': features}
with open('contratos.geojson', 'w', encoding='utf-8') as f:
    json.dump(fc, f, ensure_ascii=False, separators=(',', ':'))

print('Features escritas:', len(features))
for s in summary:
    print(s)
