#!/usr/bin/env python3
"""Extrai VOIP/VGIP (volume original de óleo/gás in place) e produção
acumulada por campo das planilhas "Tabela de dados BAR" que a ANP publica
junto do Boletim Anual de Reservas (BAR) e gera data/reservas_bar.json.

Fonte: gov.br/anp/pt-br/centrais-de-conteudo/dados-estatisticos/reservas-
nacionais-de-petroleo-e-gas-natural — um arquivo .xlsx por ano (2020 em
diante), baixado manualmente da seção "Abaixo estão listados os dados de
reservas do Brasil em cada ano de referência".

IMPORTANTE — isto NÃO é a reserva 1P/2P/3P: essa tabela traz o volume
ORIGINAL in place (antes de qualquer produção) e o volume JÁ produzido —
a reserva remanescente (1P/2P/3P) só está disponível consolidada no
"Painel Dinâmico de Recursos e Reservas de Hidrocarbonetos" (dashboard
interativo, não uma planilha baixável, não coberto por este script).
"Fração Recuperada de Petróleo" aqui é acumulado÷VOIP (quanto já saiu),
não um fator de recuperação final projetado — não confundir os dois.

Formato de coluna muda por ano (achado inspecionando os 6 arquivos):
  - 2020 (tabela-de-dados-bar-2020.xlsx, aba "Tabela de dados"): sem
    coluna "Ano" (o arquivo é um snapshot só) — o ano vem do nome do
    arquivo ou de --ano.
  - 2021 (aba "Export"): coluna 'ANO_REFERENCIA_BAR - Ano'.
  - 2022 (aba "BAR_excel_2022_campo") e 2023-2025 (aba "Export"): coluna
    'Ano' simples.
Nome do campo vem em CAIXA ALTA ("BÚZIOS_ECO", "SUL DE TUPI") — mesmo
padrão do CSV "Produção por Zona" da ANP, reaproveita normaliza_nome_campo
de parse_producao_zona.py em vez de duplicar.

Uso (um arquivo, ano inferido do nome ou via --ano):
    python3 scripts/parse_reservas_bar.py caminho/tabela-dados-bar-2025.xlsx

Uso (lote — nome do arquivo precisa ter o ano em algum lugar, ex. "bar_2020.xlsx"):
    python3 scripts/parse_reservas_bar.py --dir pasta/
"""
import argparse
import json
import re
import sys
from pathlib import Path

import openpyxl

sys.path.insert(0, str(Path(__file__).resolve().parent))
from parse_producao_zona import normaliza_nome_campo  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = REPO_ROOT / 'data' / 'reservas_bar.json'

ANO_COLUNAS = ('Ano', 'ANO_REFERENCIA_BAR - Ano')
CAMPO_COLUNA = 'Campo/Área de desenvolvimento'
COLUNAS = {
    'voipBbl': 'VOIP (bbl)',
    'vgipM3': 'VGIP (m³)',
    'acumOleoBbl': 'Petróleo Acumulado (bbl)',
    'acumGasM3': 'Gás Natural Acumulado (m³)',
    'situacao': 'Situação',
}

ANO_NO_NOME_RE = re.compile(r'(20\d{2})')


def parse_bar_xlsx(path, ano_forcado=None):
    """Devolve (ano, {nome_campo: {6 métricas}}) — um arquivo cobre sempre
    um ano de referência só (o BAR é anual, não mensal)."""
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb[wb.sheetnames[0]]
    header = [c.value for c in next(ws.iter_rows(min_row=1, max_row=1))]
    idx = {h: i for i, h in enumerate(header) if h}

    ano_col = next((c for c in ANO_COLUNAS if c in idx), None)
    campos = {}
    ano_arquivo = ano_forcado
    for row in ws.iter_rows(min_row=2, values_only=True):
        campo_raw = row[idx[CAMPO_COLUNA]]
        if not campo_raw:
            continue
        ano = row[idx[ano_col]] if ano_col else ano_forcado
        if ano is None:
            raise RuntimeError(f'{path.name}: sem coluna de ano e --ano não informado')
        ano = int(ano)
        if ano_arquivo is None:
            ano_arquivo = ano
        elif ano != ano_arquivo:
            raise RuntimeError(f'{path.name}: mistura {ano_arquivo} e {ano} num arquivo só — inesperado (BAR é anual)')
        nome = normaliza_nome_campo(campo_raw)
        entry = {}
        for key, col in COLUNAS.items():
            v = row[idx[col]]
            entry[key] = v if key == 'situacao' else float(v or 0)
        # Campo pode aparecer 2x no mesmo arquivo se o BAR trouxer sub-
        # divisão que normaliza_nome_campo funde num nome só (raro, mas
        # visto entre "X" e "X Co" nalguma edição do boletim mensal — o
        # mesmo motivo de producao_common.upsert_month somar em vez de
        # sobrescrever) — soma os volumes, mantém a última situação.
        if nome in campos:
            for key in ('voipBbl', 'vgipM3', 'acumOleoBbl', 'acumGasM3'):
                campos[nome][key] += entry[key]
            campos[nome]['situacao'] = entry['situacao']
        else:
            campos[nome] = entry
    if ano_arquivo is None:
        raise RuntimeError(f'{path.name}: nenhuma linha com campo reconhecida')
    return ano_arquivo, campos


def load_existing():
    if DATA_PATH.exists():
        return json.loads(DATA_PATH.read_text(encoding='utf-8'))
    return {'fonte': {}, 'anos': []}


def upsert_ano(existing, ano, campos):
    existing.setdefault('anos', [])
    existing['anos'] = [a for a in existing['anos'] if a['ano'] != ano]
    existing['anos'].append({'ano': ano, 'campos': campos})
    existing['anos'].sort(key=lambda a: a['ano'])


def save(existing):
    existing.setdefault('fonte', {})
    existing['fonte']['nome'] = (
        'ANP — Boletim Anual de Reservas (BAR), tabela de dados por campo/área de '
        'desenvolvimento: VOIP/VGIP (volume original de óleo/gás in place) e produção '
        'acumulada — NÃO é a reserva 1P/2P/3P (essa só no Painel Dinâmico de Recursos e '
        'Reservas, dashboard interativo, não coberto aqui)'
    )
    DATA_PATH.write_text(json.dumps(existing, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('xlsx', nargs='?', help='Caminho de uma Tabela de dados BAR (.xlsx)')
    parser.add_argument('--ano', type=int, help='Ano de referência (obrigatório se o arquivo não tiver coluna Ano — ex. BAR 2020)')
    parser.add_argument('--dir', help='Pasta com vários .xlsx (ano inferido do nome do arquivo quando faltar coluna Ano)')
    args = parser.parse_args()

    existing = load_existing()

    if args.dir:
        files = sorted(Path(args.dir).glob('*.xlsx'))
        ok, failed = 0, []
        for path in files:
            m = ANO_NO_NOME_RE.search(path.name)
            ano_no_nome = int(m.group(1)) if m else None
            try:
                ano, campos = parse_bar_xlsx(path, ano_forcado=ano_no_nome)
                upsert_ano(existing, ano, campos)
                ok += 1
                print(f'OK: {path.name} -> {ano} ({len(campos)} campos)')
            except Exception as e:
                failed.append((path.name, str(e)))
        save(existing)
        print(f'{ok}/{len(files)} arquivos processados')
        for name, reason in failed:
            print(f'  FALHOU {name}: {reason}')
        return

    if not args.xlsx:
        parser.print_help()
        sys.exit(1)
    ano, campos = parse_bar_xlsx(Path(args.xlsx), ano_forcado=args.ano)
    upsert_ano(existing, ano, campos)
    save(existing)
    print(f'OK: {ano} — {len(campos)} campos')


if __name__ == '__main__':
    main()
