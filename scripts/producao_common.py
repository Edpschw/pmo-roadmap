"""Utilidades compartilhadas entre parse_producao.py (PDF) e
parse_producao_xlsm.py (Excel) — carregar/gravar data/producao.json e
normalizar o nome do campo como a ANP publica no boletim, pra não acabar
com o mesmo campo fragmentado em várias linhas/legendas por causa de
variação de maiúscula, sufixo de nota de rodapé, ou erro de digitação da
própria planilha (ver normalize_field_name).
"""
import json
import re
import unicodedata
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = REPO_ROOT / 'data' / 'producao.json'

METRIC_KEYS = ['oleoPreSalBbld', 'oleoPosSalBbld', 'gasPreSalMm3d', 'gasPosSalMm3d', 'boedPreSal', 'boedPosSal']


def strip_accents(s):
    return ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn')


# Erros de digitação e renomeações confirmadas comparando meses adjacentes
# do próprio boletim (não é normalização automática — cada entrada aqui
# tem uma razão específica, documentada):
#   - "Malim Leste" (nov/2017, só nesse mês): "Marlim Leste" com o r
#     faltando — erro de digitação na própria planilha da ANP daquele mês.
#   - "Lula" -> "Tupi": mesmo campo, renomeado pela ANP em 2019 (mesmo PD,
#     "Lula 2018"/pd/lula.pdf em data/planos_desenvolvimento.json — a ANP
#     manteve o nome do documento, só o boletim mensal passou a usar o
#     nome novo). Sem isso "Lula" (até 2019) e "Tupi" (2019+) viram duas
#     linhas/cores diferentes na aba Produção, quando é uma linha só
#     contínua. Aplicado por palavra (ver _rename_word) pra pegar também
#     "Sul de Lula" -> "Sul de Tupi" e "Anc_Lula" -> "Anc_Tupi" (a área
#     não contratada e o campo satélite tiveram o nome mudado do mesmo
#     jeito) sem listar cada combinação à mão.
_TYPO_FIXES = {
    'malim leste': 'Marlim Leste',
}
_WORD_RENAMES = {
    'Lula': 'Tupi',
    # Acento faltando em algumas edições ("Noroeste de Sapinhoa") — mesmo
    # campo de "Noroeste de Sapinhoá", confirmado batendo os dois contra o
    # mesmo mês de referência de edições vizinhas.
    'Sapinhoa': 'Sapinhoá',
}


def _rename_word(name, old, new):
    # Fronteira por LETRA, não por \w — "Anc_Lula" tem "_" antes de "Lula",
    # que não é letra, então conta como fronteira mesmo o regex \b padrão
    # não contando (underscore é caractere de palavra em regex).
    return re.sub(r'(?<![A-Za-zÀ-ÿ])' + re.escape(old) + r'(?![A-Za-zÀ-ÿ])', new, name)


# Sufixo de 1-2 letras minúsculas colado ao nome em alguns meses (ver
# clean_field_name) — nenhum campo do boletim termina legitimamente com
# uma palavra desse tamanho, então é seguro remover sempre que aparecer
# assim, sem lista de exceção.
_GARBAGE_SUFFIX_RE = re.compile(r'\s+(?:c|co|p|co\+p)$', re.IGNORECASE)
_FOOTNOTE_RE = re.compile(r'[¹²³⁴⁵⁶⁷⁸⁹⁰]+$')
_PREPOSITION_RE = re.compile(r'(?<=\s)(De|Da|Do)(?=\s)')


def clean_field_name(raw):
    # Tira marcador de nota de rodapé colado no nome — "Jubarte³" (dígito
    # sobrescrito ¹²³, direto ou via unicodedata normalizado pra dígito
    # solto) no fim, ou "*Búzios" (asterisco) no início.
    s = str(raw).strip()
    s = _FOOTNOTE_RE.sub('', s)
    s = re.sub(r'^\*+\s*', '', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s


# Canonicaliza um nome de campo já limpo de nota de rodapé (clean_field_name)
# pra uma forma única, determinística, sem depender de ver outras variantes
# do mesmo campo — cada regra abaixo produz o MESMO resultado não importa
# qual variante bruta entrou, então duas fontes (PDF de uma edição, Excel de
# outra) que citam o mesmo campo com grafia diferente colapsam pro mesmo
# nome sem precisar reprocessar tudo junto:
#   1. sufixo de regime colado (" c", " co", " p", " co+p" — ver
#      _GARBAGE_SUFFIX_RE);
#   2. erro de digitação/renomeação conhecidos (_TYPO_FIXES/_WORD_RENAMES);
#   3. preposição no meio do nome em minúscula ("De"/"Da"/"Do" -> "de"/
#      "da"/"do", exceto na primeira palavra) — a ANP mistura "Sul De
#      Tupi" e "Sul de Tupi" entre edições, mesmo campo.
def normalize_field_name(raw):
    s = clean_field_name(raw)
    s = _GARBAGE_SUFFIX_RE.sub('', s)
    key = strip_accents(s).lower()
    if key in _TYPO_FIXES:
        s = _TYPO_FIXES[key]
    for old, new in _WORD_RENAMES.items():
        s = _rename_word(s, old, new)
    s = _PREPOSITION_RE.sub(lambda m: m.group(1).lower(), s)
    return s


def to_num(v):
    return float(v) if v is not None else 0.0


def load_existing():
    if DATA_PATH.exists():
        return json.loads(DATA_PATH.read_text(encoding='utf-8'))
    return {'fonte': {}, 'meses': []}


# campos: {nome_bruto: {metrica: valor}} — normaliza cada nome aqui (não no
# parser individual) e soma quando duas chaves brutas da MESMA extração já
# colapsam pro mesmo nome canônico (ex.: uma edição citando "Sépia" e
# "Sépia co" como linhas separadas da mesma tabela).
def upsert_month(existing, ano, mes, campos, url):
    existing.setdefault('meses', [])
    normalized = {}
    for nome_raw, valores in campos.items():
        nome = normalize_field_name(nome_raw)
        if nome in normalized:
            for k in METRIC_KEYS:
                normalized[nome][k] += valores[k]
        else:
            normalized[nome] = dict(valores)
    existing['meses'] = [m for m in existing['meses'] if not (m['ano'] == ano and m['mes'] == mes)]
    entry = {'ano': ano, 'mes': mes, 'campos': normalized}
    if url:
        entry['fonteUrl'] = url
    existing['meses'].append(entry)
    existing['meses'].sort(key=lambda m: (m['ano'], m['mes']))
    return existing


def save(existing):
    existing.setdefault('fonte', {})
    existing['fonte']['nome'] = 'ANP — Produção por Zona (dados abertos), conferida contra o Boletim da Produção de Petróleo e Gás Natural'
    DATA_PATH.write_text(json.dumps(existing, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
