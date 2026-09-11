#!/usr/bin/env python3
"""Extrai produção mensal de óleo E GÁS por POÇO (não por campo) a partir
dos mesmos CSVs de "Produção por Zona" já usados em parse_producao_zona.py,
e grava data/producao_pocos_serie.json — só poços PRÉ-SAL (Pré-sal='S' em
pelo menos um mês), pra não carregar os milhares de poços onshore/pós-sal
do resto do Brasil que esta base também tem e o app não rastreia.

gasMm3d entra pra dar RGO por poço (RGO = gás/óleo, ver computeRGO em
shared.js) cobrindo out/2014-jun/2025 — bem mais que a janela rolante de
poucos meses do boletim de poços da ANP (data/producao_pocos.json.pocosMensal,
ver scripts/build_producao_pocos.py e buildWellRgoChart em campo.js), que
continua sendo a fonte pros meses mais recentes que esta base não cobre
(a partir de jul/2025 esse CSV para de trazer a coluna "Pré-sal", mesmo
corte de todo o resto que usa esta fonte). SEM o fator de correção
(dias do mês − 1) que oleoBbld leva — mesmo achado de parse_producao_zona.py
(nota 3 lá): esse fator é específico da coluna "Petróleo (m³/d)", "Gás
total (Mil m³/d)" já vem certo em todo o período.

Por que arquivo à parte de data/producao.json: granularidade diferente
(poço, não campo) — mesma razão de data/producao_pocos.json (o snapshot
de um mês só que este arquivo complementa em campo.js, ver
scripts/build_producao_pocos.py) já ser separado.

Uso (lote, o normal):
    python3 scripts/parse_producao_pocos_serie.py --dir pasta/
"""
import argparse
import calendar
import csv
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from parse_producao_zona import DATA_SEM_CORRECAO, M3_TO_BBL, normaliza_nome_campo, to_num  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = REPO_ROOT / 'data' / 'producao_pocos_serie.json'


def parse_pocos_csv(path):
    """Devolve {(ano, mes): {nome_poco: {campo, oleoBbld, gasMm3d?}}} — só
    poços com Pré-sal='S' na linha (um poço pode ter zona pré-sal e
    pós-sal ao mesmo tempo em tese; soma só o lado pré-sal, mesmo
    critério de parse_zona_csv). gasMm3d só entra quando o poço também
    produziu óleo no mês (RGO sem óleo não faz sentido) e o gás é
    positivo — sem gás registrado, o poço fica só com oleoBbld, sem a
    chave (não gasMm3d=0 à toa)."""
    with open(path, encoding='utf-8-sig', newline='') as f:
        reader = csv.DictReader(f)
        if 'Pré-sal' not in (reader.fieldnames or []):
            raise RuntimeError('coluna "Pré-sal" ausente neste CSV')

        sums = {}  # (ano, mes, poco) -> {campo, oleo, gas}
        for row in reader:
            if (row.get('Pré-sal') or '').strip().upper() != 'S':
                continue
            data = (row.get('Data') or '').strip()
            # ANP trocou "Data" de "M/AAAA" pra "DD/MM/AAAA" a partir de
            # mar/2026 (achado em scripts/parse_producao_injecao.py) — sem
            # efeito aqui hoje (linha já cai no filtro de Pré-sal != 'S'
            # acima antes de chegar nesta, arquivo sem essa coluna vira
            # "0 poços" de qualquer forma), só defensivo.
            m = re.match(r'(?:\d{1,2}/)?(\d{1,2})/(\d{4})', data)
            if not m:
                continue
            mes, ano = int(m.group(1)), int(m.group(2))
            poco = (row.get('Nome poço ANP') or '').strip()
            campo_raw = (row.get('Campo') or '').strip()
            if not poco or not campo_raw:
                continue
            campo = normaliza_nome_campo(campo_raw)
            oleo = to_num(row.get('Petróleo (m³/d)'))
            gas = to_num(row.get('Gás total (Mil m³/d)'))
            key = (ano, mes, poco)
            if key not in sums:
                sums[key] = {'campo': campo, 'oleo': 0.0, 'gas': 0.0}
            sums[key]['oleo'] += oleo
            sums[key]['gas'] += gas

    by_month = {}
    for (ano, mes, poco), v in sums.items():
        # Fator (dias do mês − 1) só no óleo — ver nota grande no topo do
        # arquivo e nota 3 de parse_producao_zona.py.
        fator = 1.0
        if (ano, mes) < DATA_SEM_CORRECAO:
            fator = calendar.monthrange(ano, mes)[1] - 1
        oleo_bbld = v['oleo'] * M3_TO_BBL * fator
        if oleo_bbld > 1e-9:
            entry = {'campo': v['campo'], 'oleoBbld': oleo_bbld}
            if v['gas'] > 1e-9:
                entry['gasMm3d'] = v['gas']
            by_month.setdefault((ano, mes), {})[poco] = entry
    return by_month


def load_existing():
    if DATA_PATH.exists():
        return json.loads(DATA_PATH.read_text(encoding='utf-8'))
    return {'fonte': {}, 'meses': []}


def upsert_month(existing, ano, mes, pocos):
    existing.setdefault('meses', [])
    existing['meses'] = [m for m in existing['meses'] if not (m['ano'] == ano and m['mes'] == mes)]
    existing['meses'].append({'ano': ano, 'mes': mes, 'pocos': pocos})
    existing['meses'].sort(key=lambda m: (m['ano'], m['mes']))


def save(existing):
    existing.setdefault('fonte', {})
    existing['fonte']['nome'] = 'ANP — Produção por Zona (dados abertos), óleo e gás por poço pré-sal'
    DATA_PATH.write_text(json.dumps(existing, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--dir', required=True, help='Pasta com os CSVs de produção por zona')
    args = parser.parse_args()

    existing = load_existing()
    files = sorted(Path(args.dir).glob('*.csv'))
    ok, failed = 0, []
    for path in files:
        try:
            by_month = parse_pocos_csv(path)
            if not by_month:
                raise RuntimeError('nenhum poço pré-sal reconhecido')
            for (ano, mes), pocos in by_month.items():
                upsert_month(existing, ano, mes, pocos)
            ok += 1
        except Exception as e:
            failed.append((path.name, str(e)))
    save(existing)
    n_pocos = len({p for m in existing['meses'] for p in m['pocos']})
    print(f'OK: {ok}/{len(files)} arquivos, {len(existing["meses"])} meses, {n_pocos} poços distintos em {DATA_PATH.relative_to(REPO_ROOT)}')
    for name, reason in failed:
        print(f'  FALHOU {name}: {reason}')


if __name__ == '__main__':
    main()
