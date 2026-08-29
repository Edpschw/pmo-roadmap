#!/usr/bin/env python3
"""Extrai a tabela "Distribuição da produção dos campos do Pré-sal" do
Boletim Mensal da Produção de Petróleo e Gás Natural (BMP) da ANP e
atualiza data/producao.json.

Uso:
    python3 scripts/parse_producao.py caminho/para/boletim.pdf [--url URL]

A tabela é localizada pelo cabeçalho de coluna (não por número de página
fixo — a posição varia entre edições), então o script deve continuar
funcionando em meses futuros sem alteração. Ano e mês do período são lidos
do bloco de filtros ("Ano" / "Mês") que precede a tabela na mesma página.
Cada execução faz merge no JSON existente por (ano, mes) — meses já
carregados são sobrescritos (nova extração do mesmo mês), os demais são
preservados, então rodar o script todo mês só acrescenta ao histórico.
"""
import json
import re
import sys
from pathlib import Path

import pypdf

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = REPO_ROOT / 'data' / 'producao.json'

# "Nome do campo<glifo> 1.234,56 1.234,56 1.234,56 1.234,56 1.234,56 1.234,56"
# — nome (letras/espaços/acentos, sem dígito) seguido de exatamente 6
# números em formato BR (milhar com ponto, decimal com vírgula). O PDF da
# ANP intercala um glifo da área de uso privado da fonte (ex.: "",
# provavelmente um ícone decorativo) entre o nome e o primeiro número, sem
# espaço — daí o separador aceitar qualquer caractere fora de
# letra/dígito/vírgula/ponto, não só espaço.
NUM = r'-?[\d.]+,\d{2}'
ROW_RE = re.compile(
    r'^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s\-]*?)[^0-9A-Za-zÀ-ÿ]+(' + NUM + r')\s+(' + NUM + r')\s+(' + NUM + r')\s+(' + NUM + r')\s+(' + NUM + r')\s+(' + NUM + r')$'
)


def to_float(s):
    return float(s.replace('.', '').replace(',', '.'))


def parse_pdf(pdf_path):
    reader = pypdf.PdfReader(pdf_path)
    for page in reader.pages:
        text = page.extract_text()
        if 'Distribuição da produção dos campos do Pré-sal' not in text:
            continue
        lines = text.split('\n')
        ano = mes = None
        campos = {}
        for i, line in enumerate(lines):
            if line.strip() == 'Ano' and i + 1 < len(lines):
                m = re.match(r'\s*(\d{4})', lines[i + 1])
                if m:
                    ano = int(m.group(1))
            if line.strip() == 'Mês' and i + 1 < len(lines):
                m = re.match(r'\s*(\d{1,2})\s*-', lines[i + 1])
                if m:
                    mes = int(m.group(1))
            row = ROW_RE.match(line.strip())
            if row:
                nome = row.group(1).strip()
                if nome == 'Total':
                    continue
                vals = [to_float(row.group(k)) for k in range(2, 8)]
                campos[nome] = {
                    'oleoPreSalBbld': vals[0],
                    'oleoPosSalBbld': vals[1],
                    'gasPreSalMm3d': vals[2],
                    'gasPosSalMm3d': vals[3],
                    'boedPreSal': vals[4],
                    'boedPosSal': vals[5],
                }
        if ano and mes and campos:
            return ano, mes, campos
    raise RuntimeError('Tabela "Distribuição da produção dos campos do Pré-sal" não encontrada no PDF — '
                        'a ANP pode ter mudado o layout do boletim; revise o regex de ROW_RE.')


def load_existing():
    if DATA_PATH.exists():
        return json.loads(DATA_PATH.read_text(encoding='utf-8'))
    return {'fonte': {}, 'meses': []}


def merge(existing, ano, mes, campos, url):
    existing.setdefault('meses', [])
    existing['meses'] = [m for m in existing['meses'] if not (m['ano'] == ano and m['mes'] == mes)]
    existing['meses'].append({'ano': ano, 'mes': mes, 'campos': campos})
    existing['meses'].sort(key=lambda m: (m['ano'], m['mes']))
    existing['fonte'] = {
        'nome': 'ANP — Boletim da Produção de Petróleo e Gás Natural (pré-sal)',
        'urlBase': 'https://www.gov.br/anp/pt-br/centrais-de-conteudo/publicacoes/boletins-anp/boletins/arquivos-bmppgn',
        'ultimaImportacaoUrl': url or existing.get('fonte', {}).get('ultimaImportacaoUrl'),
    }
    return existing


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    pdf_path = sys.argv[1]
    url = None
    if '--url' in sys.argv:
        url = sys.argv[sys.argv.index('--url') + 1]

    ano, mes, campos = parse_pdf(pdf_path)
    existing = load_existing()
    result = merge(existing, ano, mes, campos, url)
    DATA_PATH.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'OK: {mes:02d}/{ano} — {len(campos)} campos gravados em {DATA_PATH.relative_to(REPO_ROOT)}')


if __name__ == '__main__':
    main()
