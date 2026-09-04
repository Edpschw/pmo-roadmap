"""Gera data/producao_pocos.json — produção de óleo por POÇO (não por campo),
pro último mês disponível no arquivo.

Fonte: boletim de poços da ANP/BDEP — "Produção de poços" (dados abertos,
fase de desenvolvimento e produção), um mês por poço/instalação, granularidade
bem mais fina que o Boletim da Produção por campo já usado em data/producao.json
(scripts/parse_producao.py). Usado pros gráficos "produção por poço" (campo.js,
uma jazida compartilhada por vez) e "maiores produtores" (analises.js, ranking
nacional de poços).

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
import sys
from calendar import monthrange

# 1 m³ de óleo = 6,2898 barris — fator padrão da indústria (42 galões
# americanos por barril; 1 m³ = 264,172 galões; 264,172 / 42 = 6,2898...),
# o mesmo que a ANP usa pra publicar bbl/d no Boletim da Produção por campo.
M3_PARA_BBL = 6.2898

# Coluna 1 (Poço) pode repetir dentro do mesmo mês (poço trocou de
# instalação/plataforma no meio do mês, por exemplo) — soma tudo do mesmo
# poço no mesmo mês em vez de sobrescrever.
COL_MES = 1
COL_CAMPO = 4
COL_POCO = 5
COL_OLEO = 8
COL_COND = 9


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

    somas = {}  # poço -> {campo, oleo_m3}
    for r in rows:
        if len(r) <= COL_OLEO or r[COL_MES] != ultimo_mes:
            continue
        poco = r[COL_POCO].strip()
        if not poco:
            continue
        oleo_m3 = br_num(r[COL_OLEO]) + br_num(r[COL_COND])
        if poco not in somas:
            somas[poco] = {'campo': r[COL_CAMPO].strip(), 'oleo_m3': 0.0}
        somas[poco]['oleo_m3'] += oleo_m3

    pocos = {}
    for poco, d in somas.items():
        if d['oleo_m3'] <= 0:
            continue  # só poço produtor de óleo (injetor/produtor de gás puro fica de fora)
        bbld = round(d['oleo_m3'] * M3_PARA_BBL / dias_no_mes, 1)
        pocos[poco] = {'campo': d['campo'], 'oleoBbld': bbld}

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
