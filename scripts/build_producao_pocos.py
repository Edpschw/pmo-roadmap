"""Gera data/producao_pocos.json — produção de óleo, injeção de água e
injeção de gás por POÇO (não por campo), pro último mês disponível no
arquivo.

Fonte: boletim de poços da ANP/BDEP — "Produção de poços" (dados abertos,
fase de desenvolvimento e produção), um mês por poço/instalação, granularidade
bem mais fina que o Boletim da Produção por campo já usado em data/producao.json
(scripts/parse_producao.py). Usado pelos gráficos "Produção por poço",
"Injeção de água por poço" e "Injeção de gás por poço" de campo.js (uma
jazida compartilhada por vez, cor da barra por FPSO/instalação) — cada poço
do boletim é OU produtor OU injetor num dado mês, nunca os dois ao mesmo
tempo (nenhum caso misto observado na base).

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
# Água e gás ficam nas unidades nativas do boletim (m³/d e Mm³/d — a mesma
# unidade já usada em UNITS.gas no app, shared.js), sem conversão pra
# barril, que não é como injeção costuma ser reportada.
M3_PARA_BBL = 6.2898

COL_MES = 1
COL_CAMPO = 4
COL_POCO = 5
COL_INSTALACAO = 7
COL_OLEO = 8
COL_COND = 9
COL_INJ_GAS = 13
COL_INJ_AGUA_SEC = 14
COL_INJ_AGUA_DESCARTE = 15
COL_INJ_CO2 = 16
COL_INJ_N2 = 17

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


def col(row, i):
    return row[i] if i < len(row) else ''


# Soma uma métrica (valor_de_linha aplicado a cada linha) por poço, pro
# último mês — poço pode repetir dentro do mesmo mês (trocou de instalação/
# plataforma no meio do mês, por exemplo), soma tudo em vez de sobrescrever.
# instalacao registrada é a da linha de MAIOR contribuição individual (a
# mais representativa do mês), não a última lida.
def agrega(rows, ultimo_mes, valor_de_linha):
    somas = {}
    for r in rows:
        if col(r, COL_MES) != ultimo_mes:
            continue
        poco = col(r, COL_POCO).strip()
        if not poco:
            continue
        valor = valor_de_linha(r)
        if poco not in somas:
            somas[poco] = {'campo': col(r, COL_CAMPO).strip(), 'valor': 0.0, 'instalacao': '', 'instalacao_valor': -1.0}
        d = somas[poco]
        d['valor'] += valor
        if valor > d['instalacao_valor']:
            d['instalacao_valor'] = valor
            d['instalacao'] = col(r, COL_INSTALACAO)
    return somas


def monta_saida(somas, dias_no_mes, fator, campo_valor):
    out = {}
    for poco, d in somas.items():
        if d['valor'] <= 0:
            continue
        out[poco] = {
            'campo': d['campo'],
            campo_valor: round(d['valor'] * fator / dias_no_mes, 1),
            'fpso': normaliza_instalacao(d['instalacao']),
        }
    return out


def main(csv_path, out_path):
    with open(csv_path, encoding='utf-8-sig') as f:
        rows = list(csv.reader(f))
    rows = rows[1:]  # cabeçalho

    meses = sorted({col(r, COL_MES) for r in rows if col(r, COL_MES)})
    if not meses:
        print('Nenhum mês encontrado no CSV.')
        return
    ultimo_mes = meses[-1]  # 'MM/AAAA'
    mm, aaaa = ultimo_mes.split('/')
    dias_no_mes = monthrange(int(aaaa), int(mm))[1]

    somas_oleo = agrega(rows, ultimo_mes, lambda r: br_num(col(r, COL_OLEO)) + br_num(col(r, COL_COND)))
    somas_agua = agrega(rows, ultimo_mes, lambda r: br_num(col(r, COL_INJ_AGUA_SEC)) + br_num(col(r, COL_INJ_AGUA_DESCARTE)))
    somas_gas = agrega(rows, ultimo_mes, lambda r: br_num(col(r, COL_INJ_GAS)) + br_num(col(r, COL_INJ_CO2)) + br_num(col(r, COL_INJ_N2)))

    pocos = monta_saida(somas_oleo, dias_no_mes, M3_PARA_BBL, 'oleoBbld')
    injetoresAgua = monta_saida(somas_agua, dias_no_mes, 1.0, 'aguaM3d')
    injetoresGas = monta_saida(somas_gas, dias_no_mes, 1.0, 'gasMm3d')

    out = {
        'fonte': 'ANP/BDEP — Boletim de poços (dados abertos, fase de desenvolvimento e produção)',
        'mesRef': f'{aaaa}-{mm}',
        'pocos': pocos,
        'injetoresAgua': injetoresAgua,
        'injetoresGas': injetoresGas,
    }
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))

    print(f'{ultimo_mes}: {len(pocos)} produtores de óleo, {len(injetoresAgua)} injetores de água, '
          f'{len(injetoresGas)} injetores de gás -> {out_path}')


if __name__ == '__main__':
    src = sys.argv[1] if len(sys.argv) > 1 else 'producao_pocos.csv'
    dst = sys.argv[2] if len(sys.argv) > 2 else 'data/producao_pocos.json'
    main(src, dst)
