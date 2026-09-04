"""Gera data/producao_pocos.json — produção de óleo por POÇO (não por campo),
pro último mês disponível no arquivo.

Fonte: boletim de poços da ANP/BDEP — "Produção de poços" (dados abertos,
fase de desenvolvimento e produção), um mês por poço/instalação, granularidade
bem mais fina que o Boletim da Produção por campo já usado em data/producao.json
(scripts/parse_producao.py). Usado pelo gráfico "Produção por poço" de campo.js
(uma jazida compartilhada por vez, cor da barra por FPSO/instalação).

Por que um arquivo à parte, e não plugado em data/producao.json: granularidade
diferente (poço, não campo) e fonte diferente (boletim de poços, não o BMP
mensal por campo) — plugar os dois juntaria dado de proveniência e frequência
de atualização diferentes numa mesma estrutura.

Uso: python3 scripts/build_producao_pocos.py caminho/para/producao.csv
(o CSV original vem em UTF-8 com BOM, delimitado por vírgula, número em
formato BR "1.234,56" — igual ao boletim de poços que a ANP disponibiliza)
"""
import csv
import json
import re
import sys
from calendar import monthrange

# 1 m³ de óleo = 6,2898 barris — fator padrão da indústria (42 galões
# americanos por barril; 1 m³ = 264,172 galões; 264,172 / 42 = 6,2898...),
# o mesmo que a ANP usa pra publicar bbl/d no Boletim da Produção por campo.
M3_PARA_BBL = 6.2898

# Coluna 1 (Poço) pode repetir dentro do mesmo mês (poço trocou de
# instalação/plataforma no meio do mês, por exemplo) — soma tudo do mesmo
# poço no mesmo mês em vez de sobrescrever; a instalação registrada é a de
# maior contribuição individual (a mais representativa do mês), não a
# última linha lida.
COL_MES = 1
COL_CAMPO = 4
COL_POCO = 5
COL_INSTALACAO = 7
COL_OLEO = 8
COL_COND = 9

# Só um caso observado no boletim com acento faltando (o resto, mesmo em
# CAIXA ALTA, já vem acentuado — "FPSO CIDADE DE SÃO PAULO" etc.).
PALAVRA_SEM_ACENTO = {'TAMANDARE': 'TAMANDARÉ'}
# "Petrobras NN" é como a ANP registra a instalação de vários FPSOs
# numerados (P-74, P-76, P-70...) — mesmo apelido "P-NN" já usado no
# roadmap (ver seedState em shared.js, marco tipo 'fpso').
RE_PETROBRAS_NUM = re.compile(r'^PETROBRAS\s+(\d+)$', re.IGNORECASE)
# Preposição/artigo minúsculo quando não é a primeira palavra ("Cidade de
# São Paulo", não "Cidade De São Paulo").
PREPOSICOES_MINUSCULAS = {'DE', 'DA', 'DO', 'DAS', 'DOS'}


def normaliza_instalacao(raw):
    s = (raw or '').strip()
    if not s:
        return 'Sem instalação registrada'
    m = RE_PETROBRAS_NUM.match(s)
    if m:
        return f'P-{m.group(1)}'
    upper = s.upper()
    is_fpso = upper.startswith('FPSO ')
    body = upper[5:] if is_fpso else upper
    words = []
    for i, w in enumerate(body.split()):
        w = PALAVRA_SEM_ACENTO.get(w, w)
        words.append(w.lower() if i > 0 and w in PREPOSICOES_MINUSCULAS else w.capitalize())
    label = ' '.join(words)
    return f'FPSO {label}' if is_fpso else label


def br_num(s):
    s = (s or '').strip()
    if not s:
        return 0.0
    return float(s.replace('.', '').replace(',', '.'))


def main(csv_path, out_path):
    with open(csv_path, encoding='utf-8-sig') as f:
        rows = list(csv.reader(f))
    rows = rows[1:]  # cabeçalho

    meses = sorted({r[COL_MES] for r in rows if len(r) > COL_MES and r[COL_MES]})
    if not meses:
        print('Nenhum mês encontrado no CSV.')
        return
    ultimo_mes = meses[-1]  # 'MM/AAAA'
    mm, aaaa = ultimo_mes.split('/')
    dias_no_mes = monthrange(int(aaaa), int(mm))[1]

    somas = {}  # poço -> {campo, oleo_m3, instalacao, instalacao_oleo_m3}
    for r in rows:
        if len(r) <= COL_OLEO or r[COL_MES] != ultimo_mes:
            continue
        poco = r[COL_POCO].strip()
        if not poco:
            continue
        oleo_m3 = br_num(r[COL_OLEO]) + br_num(r[COL_COND])
        if poco not in somas:
            somas[poco] = {'campo': r[COL_CAMPO].strip(), 'oleo_m3': 0.0, 'instalacao': '', 'instalacao_oleo_m3': -1.0}
        d = somas[poco]
        d['oleo_m3'] += oleo_m3
        if oleo_m3 > d['instalacao_oleo_m3']:
            d['instalacao_oleo_m3'] = oleo_m3
            d['instalacao'] = r[COL_INSTALACAO]

    pocos = {}
    for poco, d in somas.items():
        if d['oleo_m3'] <= 0:
            continue  # só poço produtor de óleo (injetor/produtor de gás puro fica de fora)
        bbld = round(d['oleo_m3'] * M3_PARA_BBL / dias_no_mes, 1)
        pocos[poco] = {'campo': d['campo'], 'oleoBbld': bbld, 'fpso': normaliza_instalacao(d['instalacao'])}

    out = {
        'fonte': 'ANP/BDEP — Boletim de poços (dados abertos, fase de desenvolvimento e produção)',
        'mesRef': f'{aaaa}-{mm}',
        'pocos': pocos,
    }
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))

    print(f'{len(pocos)} poços produtores de óleo em {ultimo_mes} -> {out_path}')


if __name__ == '__main__':
    src = sys.argv[1] if len(sys.argv) > 1 else 'producao_pocos.csv'
    dst = sys.argv[2] if len(sys.argv) > 2 else 'data/producao_pocos.json'
    main(src, dst)
