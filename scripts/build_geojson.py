import shapefile, json
from shapely.geometry import Polygon

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

    # Alguns campos da Cessão Onerosa (Búzios, Itapu, Sépia, Atapu) têm um
    # registro "_ECO" (a designação de excedente da cessão onerosa) cujo
    # polígono é idêntico ao do campo principal, não uma área adicional —
    # um MultiPolygon com as duas peças sobrepostas 100% faz o SVG (regra
    # evenodd) cancelar o próprio preenchimento, e o contrato aparece sem
    # cor nenhuma no mapa por mais denso que fique o zoom. Descarta peça
    # cuja área já esteja quase totalmente (>99%) coberta por outra já
    # aceita — sobreposição parcial genuína (sub-áreas vizinhas que só
    # tangenciam) continua sendo desenhada normalmente.
    def dedup_overlapping(rings):
        kept = []
        kept_polys = []
        for ring in rings:
            poly = Polygon(ring[0])
            if not poly.is_valid or poly.area == 0:
                kept.append(ring)
                kept_polys.append(poly)
                continue
            covered = any(
                poly.intersection(other).area / poly.area > 0.99
                for other in kept_polys
            )
            if not covered:
                kept.append(ring)
                kept_polys.append(poly)
        return kept

    if len(polys) > 1:
        polys = dedup_overlapping(polys)
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

# --------------------------------------------------------------------------
# Camada de contexto: outros campos do pré-sal que NÃO são um dos 29
# contratos rastreados no roadmap (só pra dar noção geográfica de onde eles
# ficam no polígono do pré-sal como um todo).
#
# v2 da lista (22/08/2026): a primeira versão vinha de pesquisa jornalística
# cruzada por nome (PPSA/ANP/imprensa) e por isso tinha lacunas conhecidas —
# faltava Mero (o próprio campo âncora do contrato Libra, coberto no mapa
# só pelo polígono do BLOCO, bem maior que o campo em si) e Jubarte tinha
# ficado de fora por "posição incerta em relação ao polígono legal". Esta
# versão troca a pesquisa por evidência direta: agrega a base de poços da
# ANP/BDEP (Tabela_pocos, mesma usada em scripts/build_pocos.py) por CAMPO,
# nas bacias de Santos e Campos, e inclui todo campo com pelo menos 3 poços
# com ATINGIU_PRESAL='S' E onde esses poços são pelo menos 20% do total
# perfurado ali. O corte em 20% é o que separa os campos de pré-sal de
# verdade (~60-90% dos poços confirmam, Jubarte inclusive com 26%) dos
# gigantes clássicos do pós-sal de Campos que só têm um poço ou outro mais
# fundo tocando o pré-sal por baixo (Marlim 2%, Roncador 1%, Albacora 3%) —
# sem esse corte por proporção, contar só poço confirmado incluiria toda a
# bacia de Campos histórica. Único ajuste manual sobre o resultado: Norte
# de Berbigão (mesmo regime — Cessão Onerosa — e cluster de Berbigão/Sul de
# Berbigão, os dois com poços confirmados) fica embora não tenha nenhum
# poço registrado com esse nome exato de campo na exportação atual — campo
# declarado (ETAPA=Desenvolvimento no cadastro da ANP), só ainda sem poço
# atribuído a ele especificamente. Caxareu (CXR) entrou depois, também por
# pedido manual: só 2 dos 6 poços confirmam pré-sal (33%, dentro do corte de
# 20%, mas abaixo do mínimo de 3 poços usado nos outros) — evidência mais
# fraca que o resto da lista, mas suficiente pra valer o contexto.
EXTRA_PRESALT_FIELDS = [
    'LPA', 'TUP', 'STUP', 'BBG', 'NBBG', 'SBBG', 'OATP', 'SPH', 'MRO', 'JUB', 'RMT', 'WAH', 'CXR',
]

extra_idxs = records_matching(campos, 'SIG_CAMPO', EXTRA_PRESALT_FIELDS)
extra_features = []
for i in extra_idxs:
    shp = campos.shape(i)
    rec = campos.record(i).as_dict()
    geom = shp.__geo_interface__
    geom['coordinates'] = round_coords(geom['coordinates'])
    props = {
        'nome': rec.get('NOM_CAMPO', ''),
        'bacia': rec.get('NOM_BACIA', ''),
        'operador': rec.get('OPERADOR_C', ''),
        'rodada': rec.get('NUM_RODADA', ''),
        'etapa': rec.get('ETAPA', ''),
        'area_km2': float(rec.get('AREA') or 0),
    }
    extra_features.append({'type': 'Feature', 'properties': props, 'geometry': geom})

extra_fc = {'type': 'FeatureCollection', 'features': extra_features}
with open('campos_presal.geojson', 'w', encoding='utf-8') as f:
    json.dump(extra_fc, f, ensure_ascii=False, separators=(',', ':'))

print('\nCampos extra de pré-sal (contexto):', len(extra_features))
for feat in extra_features:
    print(' ', feat['properties']['nome'])
