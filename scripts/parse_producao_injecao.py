#!/usr/bin/env python3
"""Extrai injeção mensal (água + gás) por campo a partir dos mesmos CSVs
de "Produção por Zona" já usados em parse_producao_zona.py, e grava
data/producao_injecao.json — arquivo À PARTE de data/producao.json
(reaproveita normaliza_nome_campo/to_num de lá via import, mas não entra
no pipeline de METRIC_KEYS/upsert_month: injeção não existe no boletim
pra conferir contra, nem nos meses de jul/2025 em diante que só têm
boletim, então misturar no mesmo arquivo criaria um esquema inconsistente
— mês sem injeção e mês com injeção lado a lado na mesma lista de
chaves).

Duas colunas de água injetada (rec. secundária + descarte) somadas num
"aguaInjM3d" só; três de gás (natural + CO2 + N2) somadas num
"gasInjMm3d" só — o app mostra "quanto foi injetado no campo", não
distingue motivo/composição (isso fica no CSV bruto, não no gráfico).

NÃO aplica o fator de correção (dias do mês − 1) de parse_producao_zona.py
— aquele fator é específico da coluna "Petróleo (m³/d)" (confirmado
comparando contra o boletim; ver nota 3 lá), as colunas de injeção são
outras colunas do mesmo CSV e não têm esse problema. Achado ao investigar
"água injetada" com valor implausível: toda a série antes de jun/2025
tinha um salto de ~25-30× bem no mês de corte do fator (ex.: Búzios
mai/2025 2.022.409 m³/d caindo pra 84.852 m³/d em jun/2025 — sem
justificativa física pra uma queda dessas), o mesmo padrão do bug do gás
de produção — aplicar `fator` aqui era a causa.

Uso (lote, o normal):
    python3 scripts/parse_producao_injecao.py --dir pasta/ [--url-map arquivo.json]
"""
import argparse
import csv
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from parse_producao_zona import normaliza_nome_campo, to_num  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = REPO_ROOT / 'data' / 'producao_injecao.json'


def parse_injecao_csv(path):
    """Devolve {(ano, mes): {nome_campo: {aguaInjM3d, gasInjMm3d}}} — soma
    toda linha (poço+zona) do mesmo campo, mesmo mês, pré-sal ou não (a
    injeção mistura os dois lados sem problema — diferente da produção,
    não faz sentido rastrear separado aqui). Levanta RuntimeError se
    faltar alguma coluna de injeção esperada (mesmo critério de robustez
    de parse_zona_csv: layout mudou, arquivo inteiro fica de fora em vez
    de arriscar um número incompleto)."""
    colunas_agua = ['Água injetada para rec. secundária (m³/d)', 'Água injetada para descarte (m³/d)']
    colunas_gas = ['Gás injetado (Mil m³/d)', 'CO2 injetado (Mil m³/d)', 'N2 injetado (Mil m³/d)']
    with open(path, encoding='utf-8-sig', newline='') as f:
        reader = csv.DictReader(f)
        campos_csv = set(reader.fieldnames or [])
        faltando = [c for c in colunas_agua + colunas_gas if c not in campos_csv]
        if faltando:
            raise RuntimeError(f'coluna(s) de injeção ausente(s): {", ".join(faltando)}')

        sums = {}  # (ano, mes, nome_campo) -> {agua, gas}
        for row in reader:
            data = (row.get('Data') or '').strip()
            m = re.match(r'(\d{1,2})/(\d{4})', data)
            if not m:
                continue
            mes, ano = int(m.group(1)), int(m.group(2))
            campo_raw = (row.get('Campo') or '').strip()
            if not campo_raw:
                continue
            campo = normaliza_nome_campo(campo_raw)
            agua = sum(to_num(row.get(c)) for c in colunas_agua)
            gas = sum(to_num(row.get(c)) for c in colunas_gas)
            key = (ano, mes, campo)
            if key not in sums:
                sums[key] = {'agua': 0.0, 'gas': 0.0}
            sums[key]['agua'] += agua
            sums[key]['gas'] += gas

    by_month = {}
    for (ano, mes, campo), v in sums.items():
        # SEM fator de correção — ver nota grande no topo do arquivo (o
        # fator de dias-1 de parse_zona_csv é só da coluna de óleo).
        agua_m3d = v['agua']
        gas_mm3d = v['gas']
        if agua_m3d > 1e-9 or gas_mm3d > 1e-9:
            by_month.setdefault((ano, mes), {})[campo] = {'aguaInjM3d': agua_m3d, 'gasInjMm3d': gas_mm3d}
    return by_month


def load_existing():
    if DATA_PATH.exists():
        return json.loads(DATA_PATH.read_text(encoding='utf-8'))
    return {'fonte': {}, 'meses': []}


def upsert_month(existing, ano, mes, campos):
    existing.setdefault('meses', [])
    existing['meses'] = [m for m in existing['meses'] if not (m['ano'] == ano and m['mes'] == mes)]
    existing['meses'].append({'ano': ano, 'mes': mes, 'campos': campos})
    existing['meses'].sort(key=lambda m: (m['ano'], m['mes']))


def save(existing):
    existing.setdefault('fonte', {})
    existing['fonte']['nome'] = 'ANP — Produção por Zona (dados abertos), água + gás injetados por campo'
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
            by_month = parse_injecao_csv(path)
            if not by_month:
                raise RuntimeError('nenhuma linha com Data/Campo/injeção reconhecida')
            for (ano, mes), campos in by_month.items():
                upsert_month(existing, ano, mes, campos)
            ok += 1
        except Exception as e:
            failed.append((path.name, str(e)))
    save(existing)
    print(f'OK: {ok}/{len(files)} arquivos processados, {len(existing["meses"])} meses em {DATA_PATH.relative_to(REPO_ROOT)}')
    for name, reason in failed:
        print(f'  FALHOU {name}: {reason}')


if __name__ == '__main__':
    main()
