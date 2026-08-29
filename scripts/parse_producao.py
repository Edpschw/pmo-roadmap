#!/usr/bin/env python3
"""Extrai a tabela "Distribuição da produção dos campos do Pré-sal" do
Boletim Mensal da Produção de Petróleo e Gás Natural (BMP) da ANP e
atualiza data/producao.json.

Uso (um boletim):
    python3 scripts/parse_producao.py caminho/para/boletim.pdf --url URL

Uso (lote — todo PDF de um diretório, um por edição):
    python3 scripts/parse_producao.py --dir caminho/para/pasta/ [--url-map arquivo.json]

--url-map (modo lote) é um JSON { "nome-do-arquivo.pdf": "URL original" } —
opcional; sem ele, o mês é gravado sem "fonteUrl" próprio.

A tabela é localizada pelo cabeçalho de coluna (não por número de página
fixo — a posição varia entre edições). O formato do número muda conforme a
edição: umas trazem sempre duas casas decimais ("875.527,49"), outras só
inteiro ("787.080" — ver ROW_RE/NUM abaixo, que aceita os dois). Ano e mês
do período são lidos do bloco de filtros ("Ano" / "Mês") que precede a
tabela na mesma página. Cada execução faz merge no JSON existente por
(ano, mes) — meses já carregados são sobrescritos (nova extração do mesmo
mês), os demais são preservados, então rodar de novo só acrescenta ao
histórico.
"""
import argparse
import json
import re
import sys
from pathlib import Path

import pypdf

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = REPO_ROOT / 'data' / 'producao.json'

# "Nome do campo<glifo> 875.527,49 28.467,01 ..." (com decimais) ou
# "Nome do campo<glifo> 787.080 0 39.702 0 ..." (só inteiro, edições mais
# antigas) — a parte ",dd" é opcional pelas duas variantes observadas no
# arquivo. O PDF intercala um glifo da área de uso privado da fonte (ex.:
# "", provavelmente um ícone decorativo) entre o nome e o primeiro número,
# sem espaço — daí o separador aceitar qualquer caractere fora de
# letra/dígito, não só espaço.
NUM = r'-?[\d.]+(?:,\d{1,2})?'
ROW_RE = re.compile(
    r'^([A-Za-zÀ-ÿ_][A-Za-zÀ-ÿ_\s\-]*?)[^0-9A-Za-zÀ-ÿ_]+(' + NUM + r')\s+(' + NUM + r')\s+(' + NUM + r')\s+(' + NUM + r')\s+(' + NUM + r')\s+(' + NUM + r')$'
)

TABLE_TITLE = 'Distribuição da produção dos campos do Pré-sal'


def to_float(s):
    return float(s.replace('.', '').replace(',', '.'))


def find_ano_mes(lines):
    """Ano/mês do período vêm do bloco de filtros que acompanha a tabela —
    em edições mais novas como linha "Ano" isolada seguida do valor; em
    algumas mais antigas, como "Filtros: Ano" (por isso o endswith, não
    igualdade exata)."""
    ano = mes = None
    for i, line in enumerate(lines):
        s = line.strip()
        if s.endswith('Ano') and i + 1 < len(lines):
            m = re.match(r'\s*(\d{4})', lines[i + 1])
            if m:
                ano = int(m.group(1))
        if s.endswith('Mês') and i + 1 < len(lines):
            m = re.match(r'\s*(\d{1,2})\s*-', lines[i + 1])
            if m:
                mes = int(m.group(1))
    return ano, mes


def campos_from_vals(vals):
    return {
        'oleoPreSalBbld': vals[0],
        'oleoPosSalBbld': vals[1],
        'gasPreSalMm3d': vals[2],
        'gasPosSalMm3d': vals[3],
        'boedPreSal': vals[4],
        'boedPosSal': vals[5],
    }


def parse_table_row_based(text):
    """Formato mais recente: cada linha já traz "Nome<glifo> n1 n2 n3 n4 n5
    n6" pronta — usado por editições ~2024 em diante. Nome do campo fica
    exatamente como a ANP publicou (sem tentar normalizar sub-área/regime
    contratual aqui) — quem agrega variantes do mesmo campo/contrato em uma
    linha só é producao.js (PROJECT_FIELD_BASE, por substring do nome), não
    o parser; nas edições cobertas por esta estratégia (~jun/2024 em
    diante) o nome do campo não vem com sufixo de regime colado, então não
    há nada pra normalizar aqui."""
    campos = {}
    for line in text.split('\n'):
        row = ROW_RE.match(line.strip())
        if not row:
            continue
        nome = row.group(1).strip()
        if nome in ('Total', 'Total Geral'):
            continue
        vals = [to_float(row.group(k)) for k in range(2, 8)]
        if nome in campos:
            for k, v in campos_from_vals(vals).items():
                campos[nome][k] += v
        else:
            campos[nome] = campos_from_vals(vals)
    return campos


def parse_table_columnar(lines):
    """Edições ~2021-2023: o extrator de texto do PDF junta a tabela em
    blocos separados por coluna, não por linha (todos os nomes primeiro,
    depois os números). Chegamos a reconstruir isso assumindo 6 blocos de
    N valores cada, mas descartamos: a soma de cada bloco reconstruído não
    batia com a linha "Total" do próprio boletim sob nenhuma permutação de
    coluna (erro de até 35% em alguns casos) — o layout parece omitir
    células "0" de forma inconsistente entre colunas, então o tamanho de
    cada bloco não é confiável, e os 6 números ficariam trocados entre si
    sem nenhum aviso. Preferível não ter o mês do que ter um número errado
    com aparência de certo — por isso esta função sempre devolve vazio
    (edição cai em "não reconhecida", ver parse_pdf) em vez de arriscar uma
    reconstrução que não dá pra verificar."""
    return {}


def parse_pdf(pdf_path):
    """Devolve (ano, mes, campos) ou levanta RuntimeError se a tabela não
    for encontrada nesse PDF, ou não bater com nenhuma das duas estratégias
    de layout conhecidas (algumas edições bem antigas, ~2010-2016, não
    trazem esta tabela)."""
    reader = pypdf.PdfReader(pdf_path)
    for page in reader.pages:
        text = page.extract_text()
        if TABLE_TITLE not in text:
            continue
        lines = text.split('\n')
        ano, mes = find_ano_mes(lines)
        campos = parse_table_row_based(text)
        if len(campos) < 5:
            campos = parse_table_columnar(lines)
        if ano and mes and len(campos) >= 5:
            return ano, mes, campos
    raise RuntimeError(f'Tabela "{TABLE_TITLE}" não encontrada (ou layout não reconhecido) neste PDF.')


def load_existing():
    if DATA_PATH.exists():
        return json.loads(DATA_PATH.read_text(encoding='utf-8'))
    return {'fonte': {}, 'meses': []}


def upsert_month(existing, ano, mes, campos, url):
    existing.setdefault('meses', [])
    existing['meses'] = [m for m in existing['meses'] if not (m['ano'] == ano and m['mes'] == mes)]
    entry = {'ano': ano, 'mes': mes, 'campos': campos}
    if url:
        entry['fonteUrl'] = url
    existing['meses'].append(entry)
    existing['meses'].sort(key=lambda m: (m['ano'], m['mes']))
    return existing


def save(existing):
    existing.setdefault('fonte', {})
    existing['fonte']['nome'] = 'ANP — Boletim da Produção de Petróleo e Gás Natural (pré-sal)'
    DATA_PATH.write_text(json.dumps(existing, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('pdf', nargs='?', help='Caminho de um único boletim PDF')
    parser.add_argument('--url', help='URL original do boletim (modo arquivo único)')
    parser.add_argument('--dir', help='Pasta com vários boletins PDF (modo lote)')
    parser.add_argument('--url-map', help='JSON {nome-do-arquivo: URL} pro modo lote')
    args = parser.parse_args()

    existing = load_existing()

    if args.dir:
        url_map = {}
        if args.url_map:
            url_map = json.loads(Path(args.url_map).read_text(encoding='utf-8'))
        pdf_files = sorted(Path(args.dir).glob('*.pdf'))
        ok, failed = [], []
        for pdf_path in pdf_files:
            try:
                ano, mes, campos = parse_pdf(pdf_path)
                upsert_month(existing, ano, mes, campos, url_map.get(pdf_path.name))
                ok.append((pdf_path.name, ano, mes, len(campos)))
            except Exception as e:
                failed.append((pdf_path.name, str(e)))
        save(existing)
        print(f'OK: {len(ok)}/{len(pdf_files)} boletins importados para {DATA_PATH.relative_to(REPO_ROOT)}')
        for name, reason in failed:
            print(f'  FALHOU {name}: {reason}')
        return

    if not args.pdf:
        parser.print_help()
        sys.exit(1)
    ano, mes, campos = parse_pdf(args.pdf)
    upsert_month(existing, ano, mes, campos, args.url)
    save(existing)
    print(f'OK: {mes:02d}/{ano} — {len(campos)} campos gravados em {DATA_PATH.relative_to(REPO_ROOT)}')


if __name__ == '__main__':
    main()
