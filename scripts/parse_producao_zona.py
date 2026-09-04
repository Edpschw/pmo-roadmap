#!/usr/bin/env python3
"""Extrai produção mensal por campo a partir dos CSVs de "Produção por
Zona" (dados abertos da ANP — poço + zona geológica, com uma coluna
"Pré-sal: S/N" explícita por linha) e atualiza data/producao.json.

Por que trocar de fonte: o boletim (PDF/Excel, ver parse_producao.py e
parse_producao_xlsm.py) já vem pré-agregado por campo pela própria ANP —
e esse agregado tem bugs (offset de cabeçalho errado em algumas edições,
o mesmo campo fragmentado em nomes diferentes mês a mês, layout que muda
sem aviso). A "Produção por Zona" é registro bruto por poço, com o sinal
de pré-sal já vindo pronto por linha — dá pra somar por campo+mês aqui,
sem depender de nenhuma agregação prévia da ANP. Cobre out/2014 em
diante (3 anos a mais que o boletim, que só tem tabela por campo
confiável a partir de out/2017 — ver parse_producao.py).

O nome do campo vem em CAIXA ALTA nesse CSV ("BÚZIOS_ECO", "SUL DE
TUPI") — normaliza_nome_campo() capitaliza igual ao padrão já usado nos
nomes vindos do boletim ("Búzios_Eco", "Sul de Tupi"), pra casar direto
com PROJECT_FIELD_BASE/contextJazidaBase em shared.js sem mudar nada lá
(a mesma fragmentação por sub-área/economicidade existe nos dois — "
_ECO", "AnC_X", "<Direção> DE X" — só a caixa dos nomes muda).

TRÊS PEGADINHAS reais nesta fonte, achadas comparando contra o boletim
já validado (data/producao.json antes desta troca) mês a mês, campo a
campo — exatamente o motivo de manter o boletim como conferência, não
só como reserva:

1. Todo arquivo de out/2014 a mai/2025 publica "Petróleo (m³/d)" errado
   por um fator de (dias do mês − 1) — a vazão verdadeira é o valor do
   CSV MULTIPLICADO por esse fator, não o valor puro. Batido com
   precisão de ruído de arredondamento em toda a faixa out/2017-mai/2025
   (onde dá pra comparar contra o boletim): jan/2022 (31 dias), Búzios+
   Mero+Itapu+Sépia+Atapu+Sapinhoá somados = 36.088 bbl/d no CSV cru,
   1.082.139 bbl/d no boletim — 36.088 × 30 = 1.082.640, diferença
   <0,05%. Fevereiro confirma que o fator segue o número de dias do mês
   certo, não uma constante 30 fixa: fev/2023 (28 dias, não bissexto)
   pede fator 27, não 30. Não sei a causa exata do lado da ANP (não é uma
   simples "publicaram total do mês em vez de média diária" — o fator
   bate com dias−1, não com dias); é fator empírico, validado contra
   dezenas de meses reais, não teoria.
2. jun/2025 é o ÚNICO mês nessa faixa que já vem correto, sem esse fator
   (validado do mesmo jeito, diferença <0,02% em 6 campos × 3 métricas).
   A partir de jul/2025 o CSV muda de layout de novo e simplesmente PARA
   de trazer a coluna "Pré-sal" — sem ela não dá pra separar pré-sal de
   pós-sal, então esses meses são rejeitados aqui (RuntimeError), caem
   de volta pro boletim (ver DATA_INICIO_SEM_CORRECAO/parse_zona_csv).
3. O fator acima é ESPECÍFICO da coluna "Petróleo (m³/d)" — "Gás total
   (Mil m³/d)" no MESMO arquivo já vem certo, sem precisar de fator
   nenhum (bug encontrado depois da troca inicial: RGO calculado ficava
   na casa de milhares de m³/m³ pra praticamente todo campo, quando o
   valor típico do pré-sal é ~150-400; comparando contra o boletim
   arquivado — mesmo método do item 1 — Búzios jan/2022: gás cru do CSV
   × 30 batia EXATAMENTE 30× o valor do boletim, não 1×; oléo no mesmo
   mês batia 1:1 depois do fator, confirmando que só a coluna de óleo
   tem esse problema no CSV). Por isso `fator` só multiplica óleo abaixo
   — gás (pré-sal e pós-sal) usa o valor cru do CSV em todo o período,
   sem exceção de mês.

Uso (um arquivo):
    python3 scripts/parse_producao_zona.py caminho/producao_zona_MM-AAAA.csv --url URL

Uso (lote):
    python3 scripts/parse_producao_zona.py --dir pasta/ [--url-map arquivo.json]
"""
import argparse
import calendar
import csv
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from producao_common import load_existing, save, upsert_month  # noqa: E402

# Mês (ano, mes) a partir do qual o CSV já vem correto, sem o fator de
# correção de (dias do mês − 1) — ver nota grande no topo do arquivo.
# Estritamente ANTES disso, aplica a correção; a partir daqui não (mas
# nesta faixa a coluna "Pré-sal" já sumiu do CSV (ver parse_zona_csv,
# que rejeita o arquivo quando ela falta) — então na prática só jun/2025
# chega a cair neste "não corrigir").
DATA_SEM_CORRECAO = (2025, 6)

# 1 barril = 0,158987294928 m³ — mesma conversão usada em shared.js
# (computeRGO/BBL_TO_M3) pra ir de bbl/d pra m³/d; aqui é o inverso: o CSV
# já vem em m³/d, converte pra bbl/d (unidade que o resto do app usa pro
# óleo, ver METRIC_KEYS).
M3_TO_BBL = 1 / 0.158987294928

# 1 boe = 159 m³ de gás natural — equivalência padrão ANP/Petrobras,
# DIFERENTE da conversão de óleo acima (essa é por volume físico
# equivalente, não calórica). Confirmado batendo contra o boedPreSal já
# publicado no boletim, várias linhas de data/producao.json antes desta
# mudança: (boedPreSal - oleoPreSalBbld) / (gasPreSalMm3d × 1000) ≈
# 1/159 (ex.: Búzios dez/2025: 222.306 / 35.343.850 = 0,0062893...).
GAS_M3_PER_BOE = 159.0

PREPOSICOES = {'de', 'da', 'do', 'dos', 'das'}


def normaliza_nome_campo(bruto):
    """'SUL DE TUPI' -> 'Sul de Tupi'; 'BÚZIOS_ECO' -> 'Búzios_Eco';
    'AnC_TUPI' -> 'Anc_Tupi'. Preposição (de/da/do/dos/das) só fica
    minúscula quando não é a primeira palavra do nome."""
    partes = re.split(r'([ _])', bruto.strip())
    out = []
    idx_palavra = 0
    for p in partes:
        if p in (' ', '_'):
            out.append(p)
            continue
        minusc = p.lower()
        if idx_palavra > 0 and minusc in PREPOSICOES:
            out.append(minusc)
        else:
            out.append(p[:1].upper() + p[1:].lower())
        idx_palavra += 1
    return ''.join(out)


def to_num(s):
    if not s:
        return 0.0
    s = s.strip()
    if not s:
        return 0.0
    return float(s.replace('.', '').replace(',', '.'))


def parse_zona_csv(path):
    """Devolve {(ano, mes): {nome_campo: {6 métricas}}} — soma todo poço+
    zona do mesmo campo, mesmo mês, mesmo lado (pré-sal ou não); um
    arquivo normalmente cobre um mês só, mas a função não assume isso.
    Levanta RuntimeError se a coluna "Pré-sal" não existir nesse CSV (a
    partir de jul/2025 — ver nota grande no topo do arquivo) — sem essa
    coluna não dá pra separar pré-sal de pós-sal com confiança, então o
    arquivo é rejeitado inteiro em vez de arriscar classificar tudo como
    pós-sal por engano (foi exatamente isso que aconteceu numa tentativa
    anterior: campo.get('Pré-sal') devolvendo None por coluna ausente
    virava string vazia, nunca 'S', e cada mês inteiro ia parar em
    oleoPosSalBbld/gasPosSalMm3d — pré-sal saía zerado sem nenhum erro
    visível)."""
    with open(path, encoding='utf-8-sig', newline='') as f:
        reader = csv.DictReader(f)
        if 'Pré-sal' not in (reader.fieldnames or []):
            raise RuntimeError('coluna "Pré-sal" ausente neste CSV — layout mudou, não dá pra separar pré-sal/pós-sal com segurança')

        sums = {}  # (ano, mes, nome_campo) -> {oleoPreSal, oleoPosSal, gasPreSal, gasPosSal}
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
            presal = (row.get('Pré-sal') or '').strip().upper() == 'S'
            oleo = to_num(row.get('Petróleo (m³/d)'))
            gas = to_num(row.get('Gás total (Mil m³/d)'))
            key = (ano, mes, campo)
            if key not in sums:
                sums[key] = {'oleoPreSal': 0.0, 'oleoPosSal': 0.0, 'gasPreSal': 0.0, 'gasPosSal': 0.0}
            if presal:
                sums[key]['oleoPreSal'] += oleo
                sums[key]['gasPreSal'] += gas
            else:
                sums[key]['oleoPosSal'] += oleo
                sums[key]['gasPosSal'] += gas

    by_month = {}
    for (ano, mes, campo), v in sums.items():
        # Fator empírico de correção, SÓ pra óleo — ver nota 1 e nota 3 no
        # topo do arquivo. (ano, mes) < DATA_SEM_CORRECAO cobre toda a
        # faixa hoje conhecida como afetada (out/2014-mai/2025);
        # comparação por tupla funciona porque (ano, mes) já ordena
        # cronologicamente.
        fator = 1.0
        if (ano, mes) < DATA_SEM_CORRECAO:
            fator = calendar.monthrange(ano, mes)[1] - 1
        oleo_pre_bbld = v['oleoPreSal'] * M3_TO_BBL * fator
        oleo_pos_bbld = v['oleoPosSal'] * M3_TO_BBL * fator
        # Gás não leva `fator` (nota 3): a coluna "Gás total (Mil m³/d)"
        # já vem certa em toda a faixa, diferente de "Petróleo (m³/d)".
        gas_pre = v['gasPreSal']
        gas_pos = v['gasPosSal']
        entry = {
            'oleoPreSalBbld': oleo_pre_bbld,
            'oleoPosSalBbld': oleo_pos_bbld,
            'gasPreSalMm3d': gas_pre,
            'gasPosSalMm3d': gas_pos,
            'boedPreSal': oleo_pre_bbld + gas_pre * 1000 / GAS_M3_PER_BOE,
            'boedPosSal': oleo_pos_bbld + gas_pos * 1000 / GAS_M3_PER_BOE,
        }
        # Campo sem produção nenhuma naquele mês (todo poço fechado/sem
        # dado) não entra — "sem entrada" já significa "sem produção" no
        # resto do pipeline (ver buildSegments em shared.js), não precisa
        # de uma entrada zerada explícita.
        if any(abs(x) > 1e-9 for x in entry.values()):
            by_month.setdefault((ano, mes), {})[campo] = entry
    return by_month


# Os 7 contratos com produção própria rastreados no app (ver
# PROJECT_FIELD_BASE em shared.js) — mesma base usada aqui só pra
# conferência (soma por substring, sem precisar importar o JS).
CAMPOS_RASTREADOS = ['Búzios', 'Mero', 'Itapu', 'Sépia', 'Atapu', 'Sapinhoá', 'Bacalhau']
QC_TOLERANCIA = 0.05  # 5% — acima disso, mês fica de fora (ver qc_check)


def qc_check(campos_novo, campos_antigo):
    """Compara o total de óleo pré-sal dos 7 campos rastreados entre o mês
    novo (zona) e o que já existia (boletim) — devolve None quando bate
    dentro da tolerância OU não há boletim pra comparar (mês fora da
    cobertura dele, ex.: antes de out/2017 — aceita a zona sem checagem
    nesse caso, é a única fonte disponível); senão devolve a lista de
    avisos, campo a campo. A maioria dos ~470 pares campo×mês testados
    bate com <0,1% de diferença (o fator de correção em parse_zona_csv já
    resolve o normal) — quando um mês foge muito disso (achado real: dez/
    2021, Búzios 22% abaixo do boletim — não é o fator de dias, é a fonte
    zona genuinamente faltando poço naquele mês específico), é mais
    seguro manter o boletim do que aceitar um número que já sabemos que
    não bate."""
    if not campos_antigo:
        return None
    avisos = []
    for base in CAMPOS_RASTREADOS:
        novo_total = sum(v['oleoPreSalBbld'] for k, v in campos_novo.items() if base in k)
        antigo_total = sum(v['oleoPreSalBbld'] for k, v in campos_antigo.items() if base in k)
        if antigo_total <= 0:
            continue
        diff = (novo_total - antigo_total) / antigo_total
        if abs(diff) > QC_TOLERANCIA:
            avisos.append(f'{base}: boletim={antigo_total:,.0f} zona={novo_total:,.0f} ({diff*100:+.1f}%)')
    return avisos or None


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('csv', nargs='?', help='Caminho de um único CSV de produção por zona')
    parser.add_argument('--url', help='URL original (modo arquivo único)')
    parser.add_argument('--dir', help='Pasta com vários CSVs (modo lote)')
    parser.add_argument('--url-map', help='JSON {nome-do-arquivo: URL} pro modo lote')
    parser.add_argument('--sem-qc', action='store_true', help='Pula a conferência contra o boletim (não recomendado)')
    args = parser.parse_args()

    existing = load_existing()
    # Snapshot ANTES de qualquer upsert — upsert_month troca o campos do
    # mês em `existing` conforme o loop avança, então sem congelar aqui a
    # comparação do QC ia acabar comparando zona contra zona de um
    # arquivo processado antes, não contra o boletim original.
    original_by_key = {(m['ano'], m['mes']): m['campos'] for m in existing['meses']}

    if args.dir:
        url_map = {}
        if args.url_map:
            url_map = json.loads(Path(args.url_map).read_text(encoding='utf-8'))
        files = sorted(Path(args.dir).glob('*.csv'))
        ok, failed, qc_rejeitados = 0, [], []
        for path in files:
            try:
                by_month = parse_zona_csv(path)
                if not by_month:
                    raise RuntimeError('nenhuma linha com Data/Campo reconhecida')
                for (ano, mes), campos in by_month.items():
                    avisos = None if args.sem_qc else qc_check(campos, original_by_key.get((ano, mes)))
                    if avisos:
                        qc_rejeitados.append((path.name, ano, mes, avisos))
                        continue
                    upsert_month(existing, ano, mes, campos, url_map.get(path.name))
                ok += 1
            except Exception as e:
                failed.append((path.name, str(e)))
        save(existing)
        print(f'OK: {ok}/{len(files)} arquivos processados')
        for name, reason in failed:
            print(f'  FALHOU {name}: {reason}')
        for name, ano, mes, avisos in qc_rejeitados:
            print(f'  QC REJEITOU {mes:02d}/{ano} ({name}) — mantido o boletim:')
            for a in avisos:
                print(f'    {a}')
        return

    if not args.csv:
        parser.print_help()
        sys.exit(1)
    by_month = parse_zona_csv(args.csv)
    for (ano, mes), campos in by_month.items():
        avisos = None if args.sem_qc else qc_check(campos, original_by_key.get((ano, mes)))
        if avisos:
            print(f'QC REJEITOU {mes:02d}/{ano} — mantido o boletim:')
            for a in avisos:
                print(f'  {a}')
            continue
        upsert_month(existing, ano, mes, campos, args.url)
        print(f'OK: {mes:02d}/{ano} — {len(campos)} campos')
    save(existing)


if __name__ == '__main__':
    main()
