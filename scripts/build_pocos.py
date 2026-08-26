"""Gera data/pocos.json — todos os poços de cada contrato/campo do mapa.

Fonte: base cadastral de poços da ANP/BDEP (Tabela_pocos_2026_Agosto_16.csv,
baixada e enviada pelo usuário em 22/08/2026), a mesma usada para as
coordenadas dos marcos de poço no roadmap (ver shared.js).

Por que um arquivo à parte, e não mais marcos no seed: os campos em produção
têm de dezenas a mais de cem poços cada (Búzios 153, Tupi 159, Mero ~75) —
como marco de Gantt isso destruiria a leitura do roadmap, mas no mapa é
exatamente o que se quer ver ao aproximar num contrato. Então o seed segue
com os poços exploratórios (que são eventos de roadmap de verdade) e o mapa
usa este arquivo para desenhar todos.

Uso: python3 scripts/build_pocos.py caminho/para/pocos.csv
(o CSV original vem em ISO-8859-1; converta antes com
 iconv -f ISO-8859-1 -t UTF-8 origem.csv > pocos.csv)
"""
import csv
import json
import sys
from datetime import date

# Como casar os poços de cada projeto rastreado no roadmap. 'campos' usa
# SIG_CAMPO (código curto e estável do campo, o mesmo do shapefile de Campos
# de Produção — ver PLAN em build_geojson.py); 'blocos' usa BLOCO (código do
# bloco exploratório, também igual ao do shapefile). É união dos dois: um
# campo declarado costuma perder o BLOCO no cadastro, e um bloco ainda em
# exploração não tem campo — só os dois juntos cobrem o contrato inteiro.
PLAN = {
    # Libra: o bloco abriga o campo de Mero (e a área AnC_MERO), que no
    # cadastro de poços já perdeu o código do bloco — daí a união. Note que
    # NÃO entra o SIG_CAMPO 'ME': existe um campo "MERO SE" na bacia de
    # Sergipe, sem relação nenhuma com o Mero de Santos (o "SE" ali é do
    # estado, não de sudeste) — é justamente o tipo de colisão que o filtro
    # por bacia abaixo evita.
    'Libra': {'campos': ['MRO', 'AnC6'], 'blocos': ['LIBRA']},
    # Só BACN (Bacalhau Norte) — BAC (Bacalhau) é Concessão, fora deste CPP
    # (ver mesma nota em PLAN de build_geojson.py); entra em CAMPOS_CONTEXTO
    # abaixo, como campo de contexto próprio.
    'Norte de Carcará': {'campos': ['BACN']},
    'Entorno de Sapinhoá': {'campos': ['SWSH', 'NWSH', 'NESH']},
    'Búzios': {'campos': ['BUZ', 'BUZE']},
    'Itapu': {'campos': ['ITP', 'ITPE']},
    'Sépia': {'campos': ['SEP', 'SEPL', 'SEPE']},
    'Atapu': {'campos': ['ATP', 'ATPE']},
    'Alto de Cabo Frio Central': {'blocos': ['ALTO_CF_CE']},
    'Uirapuru': {'blocos': ['BLC_UIRAPR']},
    'Sudoeste de Tartaruga Verde': {'blocos': ['SO_TRTG_VD']},
    'Aram': {'blocos': ['ARAM']},
    'Água Marinha': {'blocos': ['ÁGUA-MARIN']},
    'Norte de Brava': {'blocos': ['N_DE_BRAVA']},
    'Bumerangue': {'blocos': ['BUMERANGUE']},
    'Tupinambá': {'blocos': ['TUPINAMBÁ']},
    # O bloco S-M-623 abrigou também o prospecto "Sagitário" original
    # (perfurado entre 2012 e 2019, contrato diferente e anterior), por isso
    # o corte por data: só entram os poços posteriores ao leilão de dez/2022
    # que originou o contrato rastreado aqui.
    'Sudoeste de Sagitário': {'blocos': ['S-M-623'], 'desde': '2023-01-01'},
    # Contratos sem poligonal no shapefile da ANP (devolvidos, ou área ainda
    # não declarada) — os poços são a única coisa que os coloca no mapa.
    'Sul de Gato do Mato': {'blocos': ['S_GATO_MAT']},
    'Peroba': {'blocos': ['PEROBA']},
    'Alto de Cabo Frio Oeste': {'blocos': ['ALTO_CF_O']},
    'Pau-Brasil': {'blocos': ['PAU_BRASIL']},
    'Dois Irmãos': {'blocos': ['2_IRMAOS']},
    'Três Marias': {'blocos': ['BLC_3MARIA']},
    'Saturno': {'blocos': ['SATURNO']},
    'Titã': {'blocos': ['TITA']},
}

# Campos da camada de contexto (campos_presal.geojson), casados pelo nome do
# campo exatamente como aparece lá. Mero, Jubarte, Raia e Wahoo entraram
# depois (v2 da lista em build_geojson.py, 22/08/2026) — não têm contrato
# rastreado próprio, exceto Mero, que é o campo âncora do bloco Libra (ver
# PLAN acima): os mesmos poços aparecem então nas duas camadas (grupo do
# Libra e aqui), o que é esperado — uma é o contrato/bloco todo, a outra é
# só o campo em si, mais preciso.
CAMPOS_CONTEXTO = [
    'TUPI', 'LAPA', 'SAPINHOÁ', 'OESTE DE ATAPU', 'SUL DE TUPI',
    'BERBIGÃO', 'NORTE DE BERBIGÃO', 'SUL DE BERBIGÃO',
    'MERO', 'JUBARTE', 'RAIA', 'WAHOO',
    # Caxareu não bate o critério automático (só 2 dos 6 poços confirmam
    # pré-sal, abaixo do mínimo de 3 usado nos outros) — inclusão manual,
    # pedida por nome, igual à exceção do Norte de Berbigão.
    'CAXAREU',
    # Bacalhau: Concessão, fora do CPP de Norte de Carcará (ver PLAN acima)
    # — mesmo padrão de Oeste de Atapu/Sapinhoá, campo de contexto que cita
    # o mesmo PD (jazida compartilhada) de um contrato rastreado.
    'BACALHAU',
]

# Nomes alternativos de CAMPO que devem contar como o mesmo campo de
# contexto. Mero perdeu o código do bloco Libra pra alguns poços recentes,
# que ficaram registrados como "AnC_MERO" (Área Não Concedida) em vez de
# "MERO" — geograficamente é a mesma área, então entram junto.
CAMPOS_CONTEXTO_ALIASES = {
    'MERO': ['MERO', 'AnC_MERO'],
}

# Todo contrato rastreado fica no polígono do pré-sal, que só cruza estas
# duas bacias. Serve de rede de segurança contra códigos de campo/bloco que
# se repetem em outra bacia (ver o caso do "MERO SE" acima): sem isso um
# poço de 1976 em Alagoas entrava no Libra e esticava a área do contrato
# por 1.500 km.
BACIAS = {'Santos', 'Campos'}


def iso(br):
    """'13/5/2010' -> '2010-05-13'; vazio/invalido -> None."""
    br = (br or '').strip()
    if not br:
        return None
    parts = br.split('/')
    if len(parts) != 3:
        return None
    try:
        d, m, y = (int(p) for p in parts)
        return date(y, m, d).isoformat()
    except ValueError:
        return None


def num(s):
    s = (s or '').strip().replace(',', '.')
    if not s:
        return None
    try:
        return round(float(s))
    except ValueError:
        return None


def coord(s):
    s = (s or '').strip().replace(',', '.')
    if not s:
        return None
    try:
        return round(float(s), 6)
    except ValueError:
        return None


def build_well(r):
    lat, lng = coord(r['LATITUDE_BASE_DD']), coord(r['LONGITUDE_BASE_DD'])
    if lat is None or lng is None:
        return None
    w = {'n': r['POCO'].strip(), 'c': [lat, lng]}
    d = iso(r['TÉRMINO']) or iso(r['INÍCIO'])
    if d:
        w['d'] = d
    for key, col in (('op', 'OPERADOR'), ('sit', 'SITUACAO'), ('cat', 'CATEGORIA'),
                     ('rec', 'RECLASSIFICACAO'), ('sonda', 'NOM_SONDA')):
        v = (r[col] or '').strip()
        if v:
            w[key] = v
    for key, col in (('lam', 'LAMINA_D_AGUA_M'), ('prof', 'PROFUNDIDADE_MEDIDA_M')):
        v = num(r[col])
        if v:
            w[key] = v
    # ATINGIU_PRESAL: 'S' sim, 'N' não, 'I' indeterminado, vazio = sem info.
    ps = (r['ATINGIU_PRESAL'] or '').strip()
    if ps in ('S', 'N'):
        w['ps'] = ps
    return w


def main(csv_path, out_path):
    with open(csv_path, encoding='utf-8') as f:
        rows = list(csv.DictReader(f, delimiter=';'))

    pocos = {}
    report = []
    used_poco_codes = set()

    for name, rule in PLAN.items():
        campos = set(rule.get('campos', []))
        blocos = set(rule.get('blocos', []))
        desde = rule.get('desde')
        matched = []
        for r in rows:
            if (r['BACIA'] or '').strip() not in BACIAS:
                continue
            if (r['SIG_CAMPO'] or '').strip() not in campos and (r['BLOCO'] or '').strip() not in blocos:
                continue
            w = build_well(r)
            if not w:
                continue
            if desde and (w.get('d') or '9999') < desde:
                continue
            matched.append(w)
            used_poco_codes.add(r['POCO'].strip())
        matched.sort(key=lambda w: (w.get('d') or '9999', w['n']))
        if matched:
            pocos[name] = matched
        report.append((name, len(matched)))

    for campo in CAMPOS_CONTEXTO:
        aliases = set(CAMPOS_CONTEXTO_ALIASES.get(campo, [campo]))
        matched = []
        for r in rows:
            if (r['BACIA'] or '').strip() not in BACIAS or (r['CAMPO'] or '').strip() not in aliases:
                continue
            w = build_well(r)
            if w:
                # Poço registrado numa Área Não Concedida (prefixo "AnC" no
                # cadastro da ANP) em vez de sob o nome definitivo do campo —
                # sinaliza isso pro mapa.js desenhar um símbolo diferente,
                # já que a área ainda não tem um contrato formal específico.
                if (r['CAMPO'] or '').strip().upper().startswith('ANC'):
                    w['anc'] = True
                matched.append(w)
                used_poco_codes.add(r['POCO'].strip())
        matched.sort(key=lambda w: (w.get('d') or '9999', w['n']))
        if matched:
            pocos[campo] = matched
        report.append((campo + ' (contexto)', len(matched)))

    # "Todos os poços do pré-sal": só poços que a ANP confirma terem
    # atingido o pré-sal (ATINGIU_PRESAL='S') — não todo poço das bacias de
    # Santos e Campos, que também têm décadas de produção pós-sal
    # convencional (Marlim, Albacora, Barracuda etc.) sem relação com o
    # play do pré-sal; incluir esses poluiria o mapa com pontos fora do
    # tema. 'I' (indeterminado) e vazio (sem informação, comum em poços
    # recentes sob confidencialidade) ficam de fora por serem incertos —
    # mais conservador que arriscar incluir poço que não é do pré-sal.
    # Ainda exclui quem já entrou em algum contrato/campo nomeado acima.
    outros = []
    for r in rows:
        if (r['BACIA'] or '').strip() not in BACIAS:
            continue
        if (r['TERRA_MAR'] or '').strip() != 'M':
            continue
        if (r['ATINGIU_PRESAL'] or '').strip() != 'S':
            continue
        if r['POCO'].strip() in used_poco_codes:
            continue
        w = build_well(r)
        if w:
            outros.append(w)
    outros.sort(key=lambda w: (w.get('d') or '9999', w['n']))
    report.append(('Outros poços do pré-sal', len(outros)))

    out = {
        'fonte': 'ANP/BDEP — Tabela de Poços (16/08/2026)',
        'pocos': pocos,
        'outros': outros,
    }
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))

    total = sum(n for _, n in report)
    for name, n in sorted(report, key=lambda x: -x[1]):
        print(f'{n:5d}  {name}')
    print(f'\n{total} poços ({len(pocos)} contratos/campos nomeados + {len(outros)} outros) -> {out_path}')


if __name__ == '__main__':
    src = sys.argv[1] if len(sys.argv) > 1 else 'pocos.csv'
    dst = sys.argv[2] if len(sys.argv) > 2 else 'data/pocos.json'
    main(src, dst)
