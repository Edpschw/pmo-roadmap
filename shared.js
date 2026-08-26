'use strict';

/* =========================================================================
   Núcleo de dados compartilhado entre as páginas do Roadmap PMO (visão
   Gantt em index.html e visão em tabela em tabela.html). Sem dependências
   externas. Carregar antes de app.js / tabela.js.
   ========================================================================= */

const STORAGE_KEY = 'pmo-roadmap-state-v1';

const PALETTE = [
  '#3457d5', '#1c9e6b', '#e0762f', '#a24bd6', '#d64545',
  '#0aa3a3', '#c9a227', '#5b6ee1', '#2f9ed6', '#c14f8a'
];

// Cor do texto de marcos já passados e marcados como realizados — mesmo tom
// usado no número de progresso de uma tarefa concluída (.actual.complete).
const MILESTONE_PAST_LABEL_COLOR = '#9aa4b2';
// Cor do texto de marcos já passados e NÃO realizados — mesmo tom de
// "atrasado" usado no número de progresso das tarefas (.actual.behind).
const MILESTONE_OVERDUE_LABEL_COLOR = '#d64545';

const SCALE_PX_PER_DAY = { day: 24, month: 6, quarter: 2.3, year: 1.0 };

// Nível de agrupamento acima dos projetos (colapsável), por fase/situação
// do contrato. GROUP_FALLBACK é usado para projetos antigos salvos sem
// campo "group" (compatibilidade com dados de antes deste agrupamento).
const GROUP_DEFS = [
  { id: 'exploracao', label: 'Exploração' },
  { id: 'producao', label: 'Produção' },
  { id: 'devolvidos', label: 'Devolvidos' },
];
const GROUP_FALLBACK = 'exploracao';

// Mesma classificação usada no seed (por prefixo do nome oficial do
// contrato), reaproveitada no preenchimento retroativo de estados salvos
// antes deste agrupamento existir — sem isso, todo projeto antigo cairia
// sempre em GROUP_FALLBACK em vez do grupo real do contrato.
const KNOWN_PROJECT_GROUPS = {
  'Mero': 'producao',
  'Libra': 'exploracao',
  'Sul de Gato do Mato': 'exploracao',
  'Norte de Carcará': 'producao',
  'Entorno de Sapinhoá': 'producao',
  'Pau-Brasil': 'devolvidos',
  'Peroba': 'exploracao',
  'Alto de Cabo Frio Oeste': 'exploracao',
  'Alto de Cabo Frio Central': 'exploracao',
  'Uirapuru': 'exploracao',
  'Dois Irmãos': 'exploracao',
  'Três Marias': 'devolvidos',
  'Saturno': 'devolvidos',
  'Titã': 'devolvidos',
  'Sudoeste de Tartaruga Verde': 'exploracao',
  'Aram': 'exploracao',
  'Búzios': 'producao',
  'Itapu': 'producao',
  'Sépia': 'producao',
  'Atapu': 'producao',
  'Água Marinha': 'exploracao',
  'Norte de Brava': 'exploracao',
  'Bumerangue': 'exploracao',
  'Sudoeste de Sagitário': 'exploracao',
  'Tupinambá': 'exploracao',
  'Esmeralda': 'exploracao',
  'Ametista': 'exploracao',
  'Citrino': 'exploracao',
  'Itaimbezinho': 'exploracao',
  'Jaspe': 'exploracao',
};
function inferProjectGroup(name) {
  const key = Object.keys(KNOWN_PROJECT_GROUPS).find((k) => name.startsWith(k));
  return key ? KNOWN_PROJECT_GROUPS[key] : GROUP_FALLBACK;
}

let uidCounter = 0;
function uid(prefix) {
  uidCounter += 1;
  return prefix + '_' + Date.now().toString(36) + '_' + uidCounter;
}

/* ---------------------------- Date helpers ---------------------------- */

function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function toISO(date) {
  return date.toISOString().slice(0, 10);
}
function addDays(date, n) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}
function diffDays(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}
function todayISO() {
  const now = new Date();
  return toISO(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
}
function formatBR(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
// Progresso que a tarefa deveria ter hoje, assumindo avanço linear entre
// início e fim — usado para comparar com o progresso real informado.
function computeExpectedProgress(item) {
  const start = parseDate(item.start);
  const end = parseDate(item.end);
  const today = parseDate(todayISO());
  if (today <= start) return 0;
  if (today >= end) return 100;
  const span = diffDays(start, end);
  if (span <= 0) return 100;
  return Math.round((diffDays(start, today) / span) * 100);
}
// Classificação usada para colorir o número de progresso real: verde (em
// dia/adiantado), laranja (até 10% atrasado), vermelho (mais atrasado) ou
// cinza claro quando já está 100% concluído.
function progressStatusClass(actualProgress, expectedProgress) {
  if (actualProgress === 100) return 'complete';
  if (actualProgress >= expectedProgress) return 'on-track';
  if (expectedProgress - actualProgress <= 10) return 'slightly-behind';
  return 'behind';
}

/* ---------------------------- Poços (ANP/BDEP) --------------------------- */
// Compartilhado entre mapa.js, app.js e analises.js — as três páginas usam a
// mesma classificação de poço (data/pocos.json) e o mesmo jeito de casar um
// código de poço com o marco do roadmap que o cita.

// Código do poço dentro do nome de um marco ("Poço pioneiro 1-BRSA-1363-RJS
// (gás com CO2...)" -> "1-BRSA-1363-RJS"), pra casar o marco com o registro
// da ANP. Marco sem código (ex.: "Poço exploratório (previsto)") não casa
// com nada. O segundo grupo de dígitos aceita sufixo minúsculo (ex.:
// "3-BRSA-1267i-RJS") — sidetrack/complemento do poço-mãe, convenção usada
// pela ANP em ~19 poços da base (Libra, Búzios); sem o "i" no meio da
// classe de caracteres, o marco ficava sem casar com o próprio registro.
const WELL_CODE_RE = /\b\d+-[A-Z]{2,6}-\d+[A-Za-z]*-[A-Z]{3}\b/;
function wellCodeOf(name) {
  const m = String(name).match(WELL_CODE_RE);
  return m ? m[0] : null;
}

// Categoria de um poço a partir do registro da ANP/BDEP (info = um item de
// data/pocos.json: { rec: RECLASSIFICACAO, sit: SITUACAO, ... }).
// RECLASSIFICACAO (resultado apurado) manda antes de SITUACAO (estado
// atual) — mas produtor/injetor só conta se o poço ainda estiver
// definitivamente fora de operação: RECLASSIFICACAO é um veredito
// histórico que não muda quando o poço é desativado depois; SITUACAO,
// sim. Sem essa checagem, quase metade dos poços "produtor" na base
// tinham SITUACAO abandonado/fechado e apareciam como óleo/injeção
// ativos indevidamente no mapa.
//
// Revisão (poços abandonados): SITUACAO tem 4 variantes de "abandonado"
// bem diferentes — só ABANDONADO PERMANENTEMENTE (e ARRASADO/DEVOLVIDO/
// "aguardando arrasamento") é estado final. ABANDONADO TEMPORARIAMENTE
// (com ou sem monitoramento) e ABANDONADO POR LOGÍSTICA EXPLORATÓRIA são
// pausas operacionais — o poço pode ser reaberto, e não é coincidência
// que a maioria desses dois grupos tenha RECLASSIFICACAO de produtor/
// portador/descobridor (achou petróleo ou gás): plugar um poço
// exploratório depois do teste e voltar depois pra decidir o
// desenvolvimento é rotina, não um resultado negativo. Contar os dois
// como "abandonado" escondia justamente a descoberta que a categoria
// deveria mostrar — por isso só entram no sitAbandoned os estados
// realmente finais; FECHADO continua contando (é o caso identificado no
// bug original: poço fechado é poço que não está operando agora).
// Revisão (situação/resultado/classificação, análise completa dos três
// campos brutos da ANP): RECLASSIFICACAO só existe pra ~78% dos poços —
// os ~22% sem ela ficavam por conta só de SITUACAO, que também falta ou é
// um estado transitório (equipado aguardando operação, em perfuração/
// completação, pausa temporária) pra boa parte deles. Isso inflava
// "indefinido" com poço que na verdade tem um sinal claro: quando
// CATEGORIA (info.cat, o que a ANP registrou que o poço FOI PROJETADO PRA
// SER) é "Injeção", é fato de cadastro, não resultado incerto — poço
// injetor de desenvolvimento em geral nem passa por reclassificação
// geológica (essa é uma verificação de resultado exploratório: achou
// óleo/gás/nada), daí o rec vazio. As outras 7 categorias (Desenvolvimento,
// Extensão, Pioneiro...) não valem o mesmo truque: elas dizem o TIPO de
// poço, não se achou óleo, gás ou nada — usar isso de fallback seria
// inventar resultado. Efeito medido na base inteira: indefinido cai de 82
// pra 52 poços (os 30 que saem eram mesmo injetor sem outro sinal), sem
// tocar em nenhum poço que já tinha veredito por rec/sit.
function wellCategory(info) {
  if (!info) return 'indefinido';
  const rec = info.rec || '';
  const cat = info.cat || '';
  const sit = info.sit || '';
  const sitAbandoned = sit === 'ABANDONADO PERMANENTEMENTE' || sit === 'ARRASADO' || sit === 'FECHADO'
    || sit === 'DEVOLVIDO' || sit === 'ABANDONADO AGUARDANDO ABANDONO DEFINITIVO/ARRASAMENTO';
  if (rec.includes('INJEÇÃO')) return sitAbandoned ? 'abandonado' : 'injecao';
  if (rec.includes('ABANDONADO')) return 'abandonado';
  if (rec === 'SECO SEM INDÍCIOS') return 'seco';
  if (rec.includes('INDÍCIOS')) return rec.includes('PETRÓLEO') ? 'indicio' : 'gas';
  if (rec.includes('GÁS') && !rec.includes('PETRÓLEO')) return 'gas';
  if (rec.includes('PRODUTOR') || rec.includes('PORTADOR') || rec.includes('DESCOBRIDOR') || rec.includes('EXTENSÃO')) {
    return sitAbandoned ? 'abandonado' : 'producao';
  }
  if (sit === 'PRODUZINDO') return 'producao';
  if (sit === 'INJETANDO') return 'injecao';
  if (sitAbandoned) return 'abandonado';
  if (cat === 'Injeção') return 'injecao';
  return 'indefinido';
}

// Sub-tipo de injeção (água ou gás), pro selo do ícone do poço injetor no
// mapa — só faz sentido quando wellCategory(info) já deu 'injecao'. Os
// únicos dois valores de RECLASSIFICACAO observados na base são "INJEÇÃO DE
// ÁGUA" e "INJEÇÃO DE GÁS NATURAL".
function wellInjectionType(info) {
  const rec = (info && info.rec) || '';
  if (rec.includes('GÁS')) return 'gas';
  if (rec.includes('ÁGUA')) return 'agua';
  return null;
}

// Escapa texto pra uso seguro em template string de HTML — compartilhada
// entre app.js, mapa.js e analises.js (todas montam HTML por concatenação
// de string, sem framework).
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* --------------------- Poços do contrato x campo ligado ------------------ */
// Compartilhada entre analises.js, mapa.js e pocos.js.

// Alguns dados por nome (pocosData, pdData) trazem a chave em MAIÚSCULO
// quando vêm de um campo de contexto do pré-sal, padrão ANP (MERO,
// SAPINHOÁ...). "Mero" também é hoje um projeto rastreado, com nome em
// Título Case como todo projeto do seed, mas puxando do mesmo registro —
// esta função deixa os dois lados casarem sem duplicar a entrada no
// arquivo de dados.
function byNameOrUpper(obj, name) {
  return obj[name] !== undefined ? obj[name] : obj[name.toUpperCase()];
}
function wellsForKey(pocosData, name) {
  return byNameOrUpper(pocosData, name) || [];
}

// Mero é o campo comercial DENTRO do bloco original de Libra — os dois
// nasceram do mesmo contrato de partilha (Leilão 2013-10-21, Assinatura
// 2013-12-02, 48610.011150/2013-10), mas hoje são dois projetos
// rastreados: Mero (produção) e Libra (exploração — o que sobrou do bloco
// fora da área declarada de Mero). pocosData['Libra'] (ver
// scripts/build_pocos.py) ainda lista os 74 poços do bloco inteiro — 69 já
// pertencem a Mero e precisam ser descontados daqui, senão apareciam
// desenhados/contados duas vezes: uma como parte do bloco de Libra, outra
// como projeto Mero.
const CONTRACT_WELL_OVERLAP = { 'Libra': 'Mero' };

// Poços do CONTRATO propriamente ditos — wellsForKey(pocosData, name)
// menos os que já pertencem a outro projeto rastreado com overlap
// conhecido (ver CONTRACT_WELL_OVERLAP). Pra qualquer nome sem overlap
// (todo mundo hoje, exceto Libra), isso é só wellsForKey sem filtro.
function contractOwnWells(pocosData, name) {
  const wells = wellsForKey(pocosData, name);
  const overlapName = CONTRACT_WELL_OVERLAP[name];
  if (!overlapName) return wells;
  const excluded = new Set(wellsForKey(pocosData, overlapName).map((w) => w.n));
  return wells.filter((w) => !excluded.has(w.n));
}

/* ------------------------------ Jazida compartilhada --------------------- */
// Modelo do domínio (ANP): CONTRATO vem do leilão/rodada (Marcos do
// Contrato no seed, ver seedState); CAMPO é declarado depois, quando a
// comercialidade é declarada e o Plano de Desenvolvimento (PD) é enviado —
// dentro de um contrato, ou em Área Não Contratada (ANC); JAZIDA é o
// reservatório físico que o PD descreve, e pode ser compartilhada por mais
// de um campo (ex.: a jazida de Bacalhau é formada pelos campos Bacalhau e
// Bacalhau Norte, um só PD cobrindo os dois). Compartilhada entre
// analises.js e mapa.js.

// pd.areaObs, quando existe, descreve a composição em prosa ("Jazida
// compartilhada — 48% Bacalhau / 52% Bacalhau Norte") — mas nem todo PD
// composto preenche esse campo (ex.: Berbigão/Norte/Sul de Berbigão não
// tem), por isso NÃO é o sinal principal de "é uma jazida compartilhada"
// (ver groupByPdFonte abaixo, que não depende dele); serve só pra mostrar
// a composição quando o sumário a publicou.
function jazidaComposicao(pd) {
  if (!pd || !pd.areaObs || !pd.areaObs.startsWith('Jazida compartilhada')) return null;
  return pd.areaObs.replace(/^Jazida compartilhada\s*[—-]?\s*/, '').trim();
}

// Nome de exibição da jazida a partir do título do PD ("Bacalhau e
// Bacalhau Norte (AIP) 2021" -> "Bacalhau e Bacalhau Norte") — tira o ano
// e a sigla do tipo de sumário (AIP/PD) do final, que não fazem parte do
// nome da jazida.
function jazidaNome(pd) {
  if (!pd || !pd.titulo) return null;
  return pd.titulo.replace(/\s*(?:\(?(?:AIP|PD)\)?\s*)?\d{4}\s*$/, '').trim();
}

// Projeto rastreado dono da MESMA jazida de um campo de contexto, quando
// exatamente um projeto usa o pd.fonte desse campo (ex.: Atapu <- OESTE DE
// ATAPU, Entorno de Sapinhoá <- SAPINHOÁ — os dois PDs citam os dois lados
// da mesma jazida). Usado pelo mapa (ver mapa.js) pra colorir o campo como
// parte do contrato em vez de neutro, já que visualmente ele "pertence" ao
// mesmo contrato. Ambíguo (fonte usada por mais de um projeto, ou por
// nenhum) devolve null — não dá pra saber a qual contrato o campo
// pertence.
function projectByPdFonte(projects, pdData) {
  const fonteToProjects = new Map();
  for (const p of projects) {
    const pd = byNameOrUpper(pdData, p.name);
    if (!pd || !pd.fonte) continue;
    if (!fonteToProjects.has(pd.fonte)) fonteToProjects.set(pd.fonte, []);
    fonteToProjects.get(pd.fonte).push(p);
  }
  const map = new Map();
  for (const [fonte, projs] of fonteToProjects) {
    if (projs.length === 1) map.set(fonte, projs[0]);
  }
  return map;
}

// Nome popular da jazida no lugar do nome do contrato, só quando o nome do
// contrato não diz nada sobre ela — hoje só Norte de Carcará ("Bacalhau")
// e Entorno de Sapinhoá ("Sapinhoá"); os demais contratos já têm o nome
// popular como nome do próprio contrato. Usado em toda EXIBIÇÃO do nome do
// projeto (roadmap em app.js, tabela de análises) — nunca em chave de
// dado: pocosData, pdData, featureByProject, KNOWN_PROJECT_GROUPS,
// CONTRACT_WELL_OVERLAP e o campo de nome editável de tabela.js continuam
// usando project.name, o nome real do contrato (editar o campo "renomeado"
// em tabela.js sem essa distinção quebraria essas referências, por isso
// tabela.js não usa este helper). No mapa (mapa.js), Norte de Carcará usa
// "Bacalhau Norte" em vez de "Bacalhau" — override próprio ali
// (MAP_DISPLAY_NAME_OVERRIDE), pela distinção geográfica entre as duas
// metades da jazida que só faz sentido lá.
const PROJECT_DISPLAY_NAME_OVERRIDE = {
  'Norte de Carcará': 'Bacalhau',
  'Entorno de Sapinhoá': 'Sapinhoá',
};
function projectDisplayName(name) {
  return PROJECT_DISPLAY_NAME_OVERRIDE[name] || name;
}

// Nome do CONTRATO por trás de um projeto rastreado, quando difere do
// próprio nome — hoje só Mero: o contrato de partilha é "Libra" (mesmo
// Leilão 2013-10-21/Assinatura 2013-12-02 dos dois, ver seedState), mas
// Mero é o campo/jazida compartilhada dentro dele, viraram dois projetos
// rastreados separados (Mero produção, Libra exploração) porque cada um
// tem seu próprio grupo. Diferente de Bacalhau/Sapinhoá (onde o contrato
// e a jazida compartilhada citam o mesmo PD, ver groupByPdKey em
// analises.js), Libra não tem PD próprio — não dá pra derivar essa
// ligação a partir dos dados carregados em runtime, por isso o mapa
// explícito aqui (mesmo padrão de PROJECT_DISPLAY_NAME_OVERRIDE acima).
const PROJECT_CONTRACT_OVERRIDE = {
  'Mero': 'Libra',
};
function projectContractName(name) {
  return PROJECT_CONTRACT_OVERRIDE[name] || name;
}

// Selos de empresa (operador/parceiros) no mapa e no roadmap — como este
// ambiente não tem acesso de rede pra baixar o logo real de cada empresa
// (site de cada operador bloqueado pela política de saída desta sessão),
// o selo é gerado: um círculo colorido com a sigla da empresa, no mesmo
// espírito do avatar-padrão do GitHub/Slack. Nome cru (como aparece em
// props.operador do GeoJSON ou pd.participacao[].empresa) -> nome curto +
// sigla; a cor é derivada por hash do nome curto (colorForCompany), não é
// a cor de marca real de cada empresa — evita parecer um logo oficial.
// Cobre todo operador/parceiro observado nos dados atuais (ver nota em
// build_geojson.py/planos_desenvolvimento.json); empresa nova cai no
// fallback de companyBadge (sigla derivada automaticamente do nome).
const COMPANY_ALIASES = {
  'Petróleo Brasileiro S.A. - PETROBRAS': { short: 'Petrobras', initials: 'PB' },
  'Petróleo Brasileiro S.A.': { short: 'Petrobras', initials: 'PB' },
  'Equinor Brasil Energia Ltda.': { short: 'Equinor', initials: 'EQ' },
  'Equinor Energy do Brasil  Ltda.': { short: 'Equinor', initials: 'EQ' },
  'Shell Brasil Petróleo Ltda.': { short: 'Shell', initials: 'SH' },
  'TotalEnergies EP Brasil Ltda.': { short: 'TotalEnergies', initials: 'TE' },
  'TotalEnergies EP do Brasil Ltda.': { short: 'TotalEnergies', initials: 'TE' },
  'CNOOC Petroleum Brasil Ltda.': { short: 'CNOOC', initials: 'CN' },
  'CNODC Brasil Petróleo e Gás Ltda.': { short: 'CNODC', initials: 'CD' },
  'BP Energy do Brasil Ltda.': { short: 'BP', initials: 'BP' },
  'Karoon Petróleo & Gás Ltda.': { short: 'Karoon', initials: 'KE' },
  'Prio Forte S.A.': { short: 'PRIO', initials: 'PR' },
  'Petro Rio Jaguar Petróleo S.A.': { short: 'PRIO', initials: 'PR' },
  'ExxonMobil Exploração Brasil Ltda.': { short: 'ExxonMobil', initials: 'XM' },
  'IBV Brasil Petróleo Ltda.': { short: 'IBV Brasil', initials: 'IB' },
  'Petrogal Brasil S.A.': { short: 'Galp', initials: 'GP' },
  'Repsol Sinopec Brasil S.A.': { short: 'Repsol Sinopec', initials: 'RS' },
  // Variantes mais curtas do campo "op" de data/pocos.json (nome do
  // operador do POÇO, não do contrato — formato diferente do operador do
  // GeoJSON acima) — mesma empresa, mesmo selo. Usadas pelo fallback de
  // operador do roadmap (ver wellOperatorFallback em app.js) pros 3
  // projetos sem poligonal na ANP (ver PROJECTS_WITHOUT_SHAPE em mapa.js).
  'Petrobras': { short: 'Petrobras', initials: 'PB' },
  'Shell Brasil': { short: 'Shell', initials: 'SH' },
  'Shell': { short: 'Shell', initials: 'SH' },
  'BP Energy': { short: 'BP', initials: 'BP' },
  'ExxonMobil Brasil': { short: 'ExxonMobil', initials: 'XM' },
  'Equinor Brasil': { short: 'Equinor', initials: 'EQ' },
  'Equinor Energy': { short: 'Equinor', initials: 'EQ' },
  'TotalEnergies EP': { short: 'TotalEnergies', initials: 'TE' },
  'Prio Forte S.A': { short: 'PRIO', initials: 'PR' },
  'Prio Bravo': { short: 'PRIO', initials: 'PR' },
  'Prio Tigris': { short: 'PRIO', initials: 'PR' },
};

function colorForCompany(shortName) {
  let hash = 0;
  for (let i = 0; i < shortName.length; i++) hash = (hash * 31 + shortName.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360}, 55%, 40%)`;
}

// Logo real (arquivo enviado pelo usuário, ver assets/logos/) por nome
// curto da empresa (mesma chave de COMPANY_ALIASES.short) — quando existe
// aqui, o selo usa a imagem em vez do círculo com sigla gerado (ver
// companyBadge). Só Petrobras até agora; demais empresas seguem no selo
// gerado até que o arquivo do logo seja enviado.
const COMPANY_LOGO_FILES = {
  'Petrobras': 'assets/logos/petrobras.png',
};

function companyBadge(rawName) {
  if (!rawName) return null;
  const known = COMPANY_ALIASES[rawName];
  const short = known ? known.short : rawName.trim();
  const initials = known ? known.initials : short.split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
  return { name: short, initials, color: colorForCompany(short), logo: COMPANY_LOGO_FILES[short] || null };
}

// Selo do operador (maior) + selos dos parceiros do PD (menores), pro
// contrato/jazida de um projeto — usado no popup do mapa e embaixo do
// nome no roadmap. Operador deduplicado da lista de parceiros (a tabela
// de participação do PD normalmente já inclui o operador de novo, com o
// maior %). "participacao" é pd.participacao (array {empresa, pct}) —
// null/vazio quando o PD não publicou essa tabela (ver participacaoText
// em analises.js).
function companyBadgesFor(operadorRaw, participacao) {
  const list = [];
  const seen = new Set();
  const op = companyBadge(operadorRaw);
  if (op) {
    list.push({ ...op, role: 'operador' });
    seen.add(op.name);
  }
  if (participacao) {
    for (const p of participacao) {
      const b = companyBadge(p.empresa);
      if (!b || seen.has(b.name)) continue;
      seen.add(b.name);
      list.push({ ...b, role: 'parceiro', pct: p.pct });
    }
  }
  return list;
}

// Agrupa uma lista de { name, pd } por pd.fonte — a URL do PD é a chave
// real de "é o mesmo documento, logo a mesma jazida", já que o PD é o
// documento POR JAZIDA (não por campo/contrato). Grupo com mais de um
// membro é uma jazida compartilhada entre mais de um campo/contrato —
// esse é o sinal confiável (ver nota em jazidaComposicao); grupo de um
// membro só é jazida compartilhada quando pd.areaObs diz isso em prosa
// (caso Mero: campo + Área Não Contratada, que não é uma entidade própria
// nesta base).
function groupByPdFonte(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const pd = entry.pd;
    if (!pd || !pd.fonte) continue;
    if (!groups.has(pd.fonte)) groups.set(pd.fonte, []);
    groups.get(pd.fonte).push(entry);
  }
  return [...groups.values()];
}

/* ------------------------------- Seed data ------------------------------ */

// Contratos reais de Partilha de Produção (CPP) do polígono do pré-sal,
// administrados pela PPSA e licitados pela ANP.
function seedState() {
  const t = (name, start, end, progress) => ({ id: uid('t'), type: 'task', name, start, end, progress });
  // icon: 'contract' (documento) | 'fpso' (navio) | 'well' (torre de
  // perfuração) | undefined (losango genérico). approx: true quando só o
  // mês/ano da data era conhecido (o dia usa 01 como placeholder) — some
  // visualmente do nome (que fica curto) mas continua exposto no tooltip,
  // para não esconder a incerteza. coords: [lat, lng] real (cadastro de
  // poços da ANP/BDEP) — só em marcos de poço; usado pelo mapa pra
  // posicionar o marcador no local exato em vez de uma aproximação.
  const m = (name, date, done, icon, approx, coords) => {
    const item = { id: uid('m'), type: 'milestone', name, date, done: !!done, icon, approx: !!approx };
    if (coords) item.coords = coords;
    return item;
  };
  const ws = (name, items) => ({ id: uid('ws'), name, items });
  const proj = (name, color, group, workstreams) => ({ id: uid('p'), name, color, group, collapsed: false, workstreams });

  return {
    scale: 'all',
    pxPerDay: SCALE_PX_PER_DAY.year,
    groupCollapsed: {},
    projects: [
      // Os 29 contratos de Partilha de Produção (CPP) em vigor no pré-sal,
      // conforme presalpetroleo.gov.br/contratos-de-partilha-e-producao/
      // contratos-em-vigor/ (consultado em 21/08/2026) — 30 projetos
      // rastreados no total, porque um desses contratos (Libra) já virou
      // dois projetos separados (Mero produção + Libra exploração, ver
      // nota junto dos dois abaixo). Nomes de projeto e
      // marco ficam só com o essencial (o ícone e a workstream já dizem o
      // tipo) — a rodada/ano de cada contrato e o motivo de cada devolução
      // saíram do texto visível, mas continuam no histórico do repositório.
      // "FID" raramente é divulgada publicamente por bloco — a maioria não
      // tem essa data. Em Búzios, Itapu, Sépia, Atapu e Entorno de Sapinhoá,
      // o campo já produzia sob o regime anterior (Cessão Onerosa/
      // unitização) antes da assinatura do próprio CPP.
      // Workstreams "Poços Exploratórios" (blocos em exploração e
      // devolvidos): reunidas de notícias públicas (imprensa especializada,
      // PPSA, Agência Brasil), não de boletins oficiais da ANP por poço —
      // datas sem dia divulgado usam 01 como placeholder (approx: true).
      // Blocos sem poço perfurado ou com resultado ainda não divulgado
      // publicamente (Sul de Gato do Mato, Esmeralda, Ametista, Citrino,
      // Itaimbezinho, Jaspe) ficam sem essa workstream até haver dado
      // concreto.
      // Mero e Libra nasceram do mesmo contrato de partilha (Leilão
      // 2013-10-21, Assinatura 2013-12-02, 48610.011150/2013-10) — Mero é
      // o campo comercial dentro do bloco, hoje em produção; Libra (grupo
      // exploração, logo abaixo) é o que sobrou do bloco fora da área
      // declarada de Mero, ainda sem descoberta comercial própria (os 5
      // poços que caem ali são todos abandonados). O PD público do
      // contrato ("Campo de Mero (AIP) 2021") é sobre Mero, não sobre o
      // resto do bloco — daí STOIIP/volume recuperável/FPSOs ficarem só
      // aqui. Contagem de "Poços Perfurados" (base ANP/BDEP, ver
      // scripts/build_pocos.py) é só dos 69 poços dentro da área declarada
      // de Mero (CAMPO MERO/AnC_MERO) — os outros 5 do bloco entram no
      // workstream "Poços Exploratórios" de Libra.
      proj('Mero', PALETTE[3], 'producao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2013-10-21', true, 'contract'),
          m('Assinatura', '2013-12-02', true, 'contract'),
          m('Comercialidade', '2017-11-30', true, 'contract'),
          m('PD aprovado (RD 0758/2021)', '2021-12-09', true, 'contract'),
        ]),
        ws('Poços Perfurados', [
          m('2 poços perfurados em 2010', '2010-12-31', true, 'well'),
          m('2 poços perfurados em 2014', '2014-12-31', true, 'well'),
          m('2 poços perfurados em 2015', '2015-12-31', true, 'well'),
          m('7 poços perfurados em 2016', '2016-12-31', true, 'well'),
          m('3 poços perfurados em 2017', '2017-12-31', true, 'well'),
          m('6 poços perfurados em 2018', '2018-12-31', true, 'well'),
          m('4 poços perfurados em 2019', '2019-12-31', true, 'well'),
          m('9 poços perfurados em 2020', '2020-12-31', true, 'well'),
          m('8 poços perfurados em 2021', '2021-12-31', true, 'well'),
          m('11 poços perfurados em 2022', '2022-12-31', true, 'well'),
          m('5 poços perfurados em 2023', '2023-12-31', true, 'well'),
          m('4 poços perfurados em 2024', '2024-12-31', true, 'well'),
          m('5 poços perfurados em 2025', '2025-12-31', true, 'well'),
          m('1 poço perfurado em 2026 (até agora)', '2026-03-10', true, 'well'),
        ]),
        ws('Primeiro Óleo por FPSO', [
          m('Pioneiro (EWT)', '2017-11-26', true, 'fpso'),
          m('Guanabara (Mero-1)', '2022-04-30', true, 'fpso'),
          m('Sepetiba (Mero-2)', '2023-12-31', true, 'fpso'),
          m('Duque de Caxias (Mero-3)', '2024-10-30', true, 'fpso'),
          m('Alexandre de Gusmão (Mero-4)', '2025-05-26', true, 'fpso'),
        ]),
      ]),
      // O resto do bloco de Libra fora da área declarada de Mero (ver
      // nota acima) — 5 poços de extensão/pioneiro adjacente, todos
      // abandonados, sem descoberta comercial própria: ainda em
      // exploração, sem workstream de FPSO.
      proj('Libra', PALETTE[4], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2013-10-21', true, 'contract'),
          m('Assinatura', '2013-12-02', true, 'contract'),
        ]),
        ws('Poços Exploratórios', [
          m('Poço de extensão 3-BRSA-1267i-RJS (indícios de petróleo)', '2014-09-25', true, 'well', false, [-24.650638, -42.031936]),
          m('Poço de extensão 3-BRSA-1267-RJS (portador de petróleo e gás natural)', '2015-01-21', true, 'well', false, [-24.650649, -42.03243]),
          m('Poço de extensão 3-BRSA-1267A-RJS (portador de petróleo e gás natural)', '2015-02-27', true, 'well', false, [-24.650649, -42.03243]),
          m('Poço de extensão 3-BRSA-1310-RJS (seco com indícios de petróleo)', '2015-09-05', true, 'well', false, [-24.610277, -42.110245]),
          m('Poço pioneiro adjacente 4-BRSA-1346-RJS (seco com indícios de gás natural)', '2017-05-11', true, 'well', false, [-24.655928, -41.905046]),
        ]),
      ]),
      proj('Sul de Gato do Mato', PALETTE[4], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2017-10-27', true, 'contract'),
          m('Assinatura', '2018-01-31', true, 'contract'),
          m('FID', '2025-03-21', true, 'contract'),
        ]),
        ws('Poços Exploratórios', [
          m('Poço 3-SHEL-30-RJS', '2019-08-05', true, 'well', false, [-25.0377719444, -42.9877680555]),
          m('Poço 3-SHEL-32D-RJS', '2020-03-28', true, 'well', false, [-25.0007769444, -43.0176375]),
        ]),
        ws('Primeiro Óleo por FPSO', [
          m('FPSO Gato do Mato (previsto)', '2029-01-01', false, 'fpso', true),
        ]),
      ]),
      // Norte de Carcará (CPP/Partilha, este projeto) é só a metade norte
      // da jazida — "Bacalhau Norte". A metade sul ("Bacalhau" propriamente
      // dito) é Concessão (contrato 48610.003883/2000, Rodada 2, anterior
      // e separado do CPP) e não é deste contrato — ver campo de contexto
      // "BACALHAU" no mapa, colorido igual a este por citar o mesmo PD
      // (jazida compartilhada). contratos.geojson tinha os dois lados
      // fundidos num MultiPolygon só sob "Norte de Carcará" (erro:
      // Bacalhau nunca foi parte do bloco/contrato de Partilha) — corrigido
      // junto com a poligonal (ver scripts/build_geojson.py) e a base de
      // poços (data/pocos.json separa os 22 poços do bloco fundido entre
      // os dois: só 5 são de Bacalhau Norte, 17 de Bacalhau).
      // "Poços Perfurados" abaixo, ao contrário do mapa, conta os 22 juntos
      // de propósito — pedido explícito: no roadmap a perfuração da jazida
      // inteira (as duas metades, mesmo operador/projeto de
      // desenvolvimento) é o que importa acompanhar, não só a metade sob
      // contrato de partilha.
      proj('Norte de Carcará', PALETTE[5], 'producao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2017-10-27', true, 'contract'),
          m('Assinatura', '2018-01-31', true, 'contract'),
          m('FID', '2021-06-01', true, 'contract', true),
          m('Comercialidade', '2019-12-26', true, 'contract'),
        ]),
        ws('Poços Perfurados', [
          m('2 poços perfurados em 2011', '2011-12-31', true, 'well'),
          m('1 poço perfurado em 2012', '2012-12-31', true, 'well'),
          m('1 poço perfurado em 2013', '2013-12-31', true, 'well'),
          m('2 poços perfurados em 2015', '2015-12-31', true, 'well'),
          m('1 poço perfurado em 2018', '2018-12-31', true, 'well'),
          m('2 poços perfurados em 2019', '2019-12-31', true, 'well'),
          m('3 poços perfurados em 2023', '2023-12-31', true, 'well'),
          m('4 poços perfurados em 2024', '2024-12-31', true, 'well'),
          m('4 poços perfurados em 2025', '2025-12-31', true, 'well'),
          m('2 poços perfurados em 2026 (até agora)', '2026-07-07', true, 'well'),
        ]),
        ws('Primeiro Óleo por FPSO', [
          m('Bacalhau', '2025-10-16', true, 'fpso'),
        ]),
      ]),
      proj('Entorno de Sapinhoá', PALETTE[7], 'producao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2017-10-27', true, 'contract'),
          m('Assinatura (unitização)', '2018-01-31', true, 'contract'),
          m('Comercialidade', '2011-12-29', true, 'contract'),
          m('PD aprovado (RD 1.140/2024)', '2024-07-11', true, 'contract'),
        ]),
        ws('Poços Perfurados', [
          m('1 poço perfurado em 2021', '2021-12-31', true, 'well'),
        ]),
        ws('Primeiro Óleo por FPSO', [
          m('Cidade de São Paulo (regime anterior)', '2013-01-01', true, 'fpso', true),
        ]),
      ]),
      proj('Pau-Brasil', PALETTE[8], 'devolvidos', [
        ws('Marcos do Contrato', [
          m('Leilão', '2018-09-28', true, 'contract'),
          m('Assinatura', '2018-12-17', true, 'contract'),
          // Data de devolução incerta: a fonte mais específica achada é um
          // artigo de set/2025 noticiando a devolução formal — pode ser só
          // defasagem de divulgação do resultado do poço (ago/2024, ver
          // workstream abaixo) ou a data real do protocolo na ANP.
          m('Devolução', '2024-08-01', true, 'contract', true),
        ]),
        ws('Poços Exploratórios', [
          m('Poço 1-BP-12D-RJS (poço seco)', '2024-08-08', true, 'well', false, [-25.7683027777, -42.26555]),
        ]),
      ]),
      // Peroba e Alto de Cabo Frio Oeste: chegamos a marcar como "status
      // contestado" (a página da PPSA os listava como ativos), mas pesquisa
      // adicional confirmou a devolução com múltiplas fontes independentes
      // e consistentes entre si (consórcio, data e motivo batendo) — por
      // isso migraram para o grupo "Devolvidos".
      proj('Peroba', PALETTE[9], 'devolvidos', [
        ws('Marcos do Contrato', [
          m('Leilão', '2017-10-27', true, 'contract'),
          m('Assinatura', '2018-01-31', true, 'contract'),
          m('Devolução', '2021-01-01', true, 'contract', true),
        ]),
        ws('Poços Exploratórios', [
          m('Poço pioneiro 1-BRSA-1363-RJS (gás com CO2, sem viabilidade)', '2019-01-13', true, 'well', false, [-25.8670094444, -42.8721602777]),
        ]),
      ]),
      proj('Alto de Cabo Frio Oeste', PALETTE[0], 'devolvidos', [
        ws('Marcos do Contrato', [
          m('Leilão', '2017-10-27', true, 'contract'),
          m('Assinatura', '2018-01-31', true, 'contract'),
          m('Devolução', '2024-09-01', true, 'contract', true),
        ]),
        ws('Poços Exploratórios', [
          m('Poço pioneiro 1-SHEL-31-RJS (navio Brava Star)', '2019-12-01', true, 'well', false, [-24.1683375, -41.554565]),
        ]),
      ]),
      proj('Alto de Cabo Frio Central', PALETTE[1], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2017-10-27', true, 'contract'),
          m('Assinatura', '2018-01-31', true, 'contract'),
        ]),
        ws('Poços Exploratórios', [
          m('Poço piloto 1-BRSA-1383-RJS (sem indícios de pré-sal)', '2022-01-14', true, 'well', false, [-24.0065952777, -41.2217283333]),
          m('Poço pioneiro 1-BRSA-1383A-RJS (teste de formação)', '2022-04-22', true, 'well', false, [-24.0069738888, -41.2217544444]),
          m('Poço de extensão 3-BRSA-1398-RJS', '2025-06-21', true, 'well', false, [-23.9855466666, -41.0245102777]),
          m('Poço pioneiro adjacente 4-BRSA-1402-RJS', '2025-08-30', true, 'well', false, [-24.0024966666, -40.8114041666]),
        ]),
      ]),
      proj('Uirapuru', PALETTE[2], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2018-06-07', true, 'contract'),
          m('Assinatura', '2018-12-17', true, 'contract'),
        ]),
        ws('Poços Exploratórios', [
          m('Poço pioneiro 1-BRSA-1373-SPS', '2019-11-19', true, 'well', false, [-25.1068191666, -43.8094255555]),
          m('Poço 1-BRSA-1373A-SPS (sem indícios de pré-sal)', '2019-11-26', true, 'well', false, [-25.1068191666, -43.8094255555]),
          m('Poço 1-BRSA-1373B-SPS (descoberta)', '2020-03-20', true, 'well', false, [-25.1073161111, -43.8094705555]),
        ]),
      ]),
      proj('Dois Irmãos', PALETTE[3], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2018-06-07', true, 'contract'),
          m('Assinatura', '2018-12-17', true, 'contract'),
        ]),
        ws('Poços Exploratórios', [
          m('Poço pioneiro 1-BRSA-1384-RJS (poço seco) — bloco devolvido', '2022-04-21', true, 'well', false, [-23.9493144444, -40.5409130555]),
        ]),
      ]),
      proj('Três Marias', PALETTE[4], 'devolvidos', [
        ws('Marcos do Contrato', [
          m('Leilão', '2018-06-07', true, 'contract'),
          m('Assinatura', '2018-12-17', true, 'contract'),
          m('Devolução', '2023-10-01', true, 'contract', true),
        ]),
        ws('Poços Exploratórios', [
          m('Poço 1-BRSA-1382D-RJS (indícios sem viabilidade)', '2022-02-01', true, 'well', false, [-24.9830291666, -42.0607191666]),
        ]),
      ]),
      // Saturno: a data de devolução abaixo foi corrigida — o poço seco
      // (maio/2020, ver workstream) tinha sido registrado por engano como
      // a própria devolução. Fontes convergentes (Petróleo Hoje, Eixos)
      // indicam que o bloco só foi devolvido à ANP no 4º tri/2022, quase
      // 2 anos e meio depois; dia exato não encontrado (01/10 é placeholder
      // de início do trimestre).
      proj('Saturno', PALETTE[5], 'devolvidos', [
        ws('Marcos do Contrato', [
          m('Leilão', '2018-09-28', true, 'contract'),
          m('Assinatura', '2018-12-17', true, 'contract'),
          m('Devolução', '2022-10-01', true, 'contract', true),
        ]),
        ws('Poços Exploratórios', [
          m('Poço 1-SHEL-33-RJS "Saturno1" (poço seco)', '2020-05-30', true, 'well', false, [-25.0051347222, -41.141395]),
        ]),
      ]),
      proj('Titã', PALETTE[6], 'devolvidos', [
        ws('Marcos do Contrato', [
          m('Leilão', '2018-09-28', true, 'contract'),
          m('Assinatura', '2018-12-17', true, 'contract'),
          m('Devolução', '2025-09-30', true, 'contract'),
        ]),
        ws('Poços Exploratórios', [
          m('Poço 1-EMEB-2-RJS "Titã-1" (indícios, avaliado como não comercial)', '2021-10-23', true, 'well', false, [-24.6917719444, -41.0392758333]),
        ]),
      ]),
      proj('Sudoeste de Tartaruga Verde', PALETTE[7], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2018-09-28', true, 'contract'),
          m('Assinatura', '2018-12-17', true, 'contract'),
        ]),
        ws('Poços Exploratórios', [
          m('Poço 1-BRSA-1375-RJS (sem indícios de pré-sal)', '2020-03-28', true, 'well', false, [-23.0201805555, -40.7220438888]),
          m('Poço 4-BRSA-1403D-RJS (descoberta)', '2025-11-10', true, 'well', false, [-23.0157605555, -40.7963169444]),
        ]),
      ]),
      proj('Aram', PALETTE[8], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2019-11-07', true, 'contract'),
          m('Assinatura', '2020-03-30', true, 'contract'),
        ]),
        ws('Poços Exploratórios', [
          m('Poço pioneiro "Curaçao" 1-BRSA-1381-SPS (descoberta)', '2021-12-10', true, 'well', false, [-25.6399680555, -44.6537894444]),
          m('Poço de extensão 3-BRSA-1387D-SPS', '2023-05-29', true, 'well', false, [-25.7290438888, -44.6548777777]),
          m('Poço 3-BRSA-1396D-SPS (óleo de alta qualidade)', '2025-04-26', true, 'well', false, [-25.6443022222, -44.6005983333]),
          m('Poço 4-BRSA-1395-SPS (óleo e gás)', '2025-05-22', true, 'well', false, [-25.3788336111, -44.4963166666]),
          m('Poço de extensão 3-BRSA-1400-SPS (sem indícios de pré-sal)', '2025-06-29', true, 'well', false, [-25.5827458333, -44.6510069444]),
          m('Poço de extensão 3-BRSA-1399-SPS', '2025-09-15', true, 'well', false, [-25.6742902777, -44.6978444444]),
          m('Poço de extensão 3-BRSA-1400A-SPS', '2025-09-29', true, 'well', false, [-25.5827458333, -44.6510069444]),
        ]),
      ]),
      proj('Búzios', PALETTE[9], 'producao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2019-11-06', true, 'contract'),
          m('Assinatura', '2020-03-30', true, 'contract'),
          // Comercialidade sob a Cessão Onerosa anterior, bem antes do
          // leilão do CPP específico rastreado aqui — mesmo padrão de
          // "lead time negativo" já documentado em analises.js (Búzios,
          // Itapu, Sépia, Atapu e Entorno de Sapinhoá já produziam sob o
          // regime anterior antes do leilão do CPP).
          m('Comercialidade (Cessão Onerosa)', '2013-12-19', true, 'contract'),
          m('PD aprovado (RD 832/2016)', '2016-02-18', true, 'contract'),
        ]),
        ws('Poços Perfurados', [
          m('1 poço perfurado em 2010', '2010-12-31', true, 'well'),
          m('2 poços perfurados em 2011', '2011-12-31', true, 'well'),
          m('3 poços perfurados em 2012', '2012-12-31', true, 'well'),
          m('6 poços perfurados em 2013', '2013-12-31', true, 'well'),
          m('4 poços perfurados em 2014', '2014-12-31', true, 'well'),
          m('4 poços perfurados em 2015', '2015-12-31', true, 'well'),
          m('3 poços perfurados em 2016', '2016-12-31', true, 'well'),
          m('11 poços perfurados em 2017', '2017-12-31', true, 'well'),
          m('12 poços perfurados em 2018', '2018-12-31', true, 'well'),
          m('7 poços perfurados em 2019', '2019-12-31', true, 'well'),
          m('15 poços perfurados em 2020', '2020-12-31', true, 'well'),
          m('12 poços perfurados em 2021', '2021-12-31', true, 'well'),
          m('5 poços perfurados em 2022', '2022-12-31', true, 'well'),
          m('16 poços perfurados em 2023', '2023-12-31', true, 'well'),
          m('18 poços perfurados em 2024', '2024-12-31', true, 'well'),
          m('17 poços perfurados em 2025', '2025-12-31', true, 'well'),
          m('17 poços perfurados em 2026 (até agora)', '2026-08-02', true, 'well'),
        ]),
        ws('Primeiro Óleo por FPSO', [
          m('P-74', '2018-04-24', true, 'fpso'),
          m('P-75', '2018-11-11', true, 'fpso'),
          m('P-76', '2019-02-20', true, 'fpso'),
          m('P-77', '2019-03-19', true, 'fpso'),
          m('Almirante Barroso', '2023-05-31', true, 'fpso'),
          m('Almirante Tamandaré', '2025-02-15', true, 'fpso'),
          m('P-78', '2025-12-31', true, 'fpso'),
          m('P-79', '2026-05-01', true, 'fpso'),
          m('P-80 (previsto)', '2027-01-01', false, 'fpso', true),
          m('P-82 (previsto)', '2027-04-01', false, 'fpso', true),
          m('P-83 (previsto)', '2027-07-01', false, 'fpso', true),
        ]),
      ]),
      proj('Itapu', PALETTE[0], 'producao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2019-11-06', true, 'contract'),
          m('Assinatura', '2020-03-30', true, 'contract'),
          // Sem data de comercialidade no sumário do PD (só descoberta e
          // resolução) — diferente dos outros campos de origem Cessão
          // Onerosa deste seed, que trazem os dois.
          m('PD aprovado (RD 885/2017)', '2017-05-17', true, 'contract'),
        ]),
        ws('Poços Perfurados', [
          m('1 poço perfurado em 2013', '2013-12-31', true, 'well'),
          m('1 poço perfurado em 2014', '2014-12-31', true, 'well'),
          m('1 poço perfurado em 2015', '2015-12-31', true, 'well'),
          m('2 poços perfurados em 2022', '2022-12-31', true, 'well'),
          m('3 poços perfurados em 2023', '2023-12-31', true, 'well'),
          m('2 poços perfurados em 2024', '2024-12-31', true, 'well'),
          m('2 poços perfurados em 2025', '2025-12-31', true, 'well'),
        ]),
        ws('Primeiro Óleo por FPSO', [
          m('P-71', '2022-12-21', true, 'fpso'),
        ]),
      ]),
      proj('Sépia', PALETTE[1], 'producao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2021-12-17', true, 'contract'),
          m('Assinatura', '2022-04-27', true, 'contract'),
          m('FID Sépia-2', '2024-05-27', true, 'contract'),
          m('Comercialidade (Cessão Onerosa)', '2014-09-03', true, 'contract'),
        ]),
        ws('Poços Perfurados', [
          m('1 poço perfurado em 2011', '2011-12-31', true, 'well'),
          m('1 poço perfurado em 2012', '2012-12-31', true, 'well'),
          m('1 poço perfurado em 2013', '2013-12-31', true, 'well'),
          m('1 poço perfurado em 2014', '2014-12-31', true, 'well'),
          m('1 poço perfurado em 2015', '2015-12-31', true, 'well'),
          m('1 poço perfurado em 2019', '2019-12-31', true, 'well'),
          m('5 poços perfurados em 2020', '2020-12-31', true, 'well'),
          m('1 poço perfurado em 2021', '2021-12-31', true, 'well'),
          m('1 poço perfurado em 2022', '2022-12-31', true, 'well'),
          m('2 poços perfurados em 2025', '2025-12-31', true, 'well'),
          m('2 poços perfurados em 2026 (até agora)', '2026-06-23', true, 'well'),
        ]),
        ws('Primeiro Óleo por FPSO', [
          m('Carioca (regime anterior)', '2021-08-23', true, 'fpso'),
          m('P-85 (previsto)', '2029-01-01', false, 'fpso', true),
        ]),
      ]),
      proj('Atapu', PALETTE[2], 'producao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2021-12-17', true, 'contract'),
          m('Assinatura', '2022-04-27', true, 'contract'),
          m('FID Atapu-2', '2024-05-27', true, 'contract'),
          m('Comercialidade (Cessão Onerosa)', '2014-12-29', true, 'contract'),
          m('PD aprovado (RD 355/2024)', '2024-05-29', true, 'contract'),
        ]),
        ws('Poços Perfurados', [
          m('2 poços perfurados em 2013', '2013-12-31', true, 'well'),
          m('1 poço perfurado em 2014', '2014-12-31', true, 'well'),
          m('3 poços perfurados em 2015', '2015-12-31', true, 'well'),
          m('1 poço perfurado em 2016', '2016-12-31', true, 'well'),
          m('3 poços perfurados em 2017', '2017-12-31', true, 'well'),
          m('2 poços perfurados em 2025', '2025-12-31', true, 'well'),
          m('2 poços perfurados em 2026 (até agora)', '2026-07-31', true, 'well'),
        ]),
        ws('Primeiro Óleo por FPSO', [
          m('P-70 (regime anterior)', '2020-06-25', true, 'fpso'),
          m('P-84 (previsto)', '2029-01-01', false, 'fpso', true),
        ]),
      ]),
      proj('Água Marinha', PALETTE[3], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2022-12-16', true, 'contract'),
          m('Assinatura', '2023-05-31', true, 'contract'),
        ]),
        ws('Poços Exploratórios', [
          m('Poço piloto 1-BRSA-1401D-RJS (sem indícios de pré-sal)', '2025-07-08', true, 'well', false, [-22.8648086111, -40.0253722222]),
          m('Poço 1-BRSA-1401DA-RJS (atingiu o pré-sal)', '2025-10-17', true, 'well', false, [-22.8645369444, -40.0254675]),
        ]),
      ]),
      // Correção: "Anita Garibaldi" não é o FPSO de Norte de Brava — é o
      // FPSO dos campos de Marlim e Voador (pós-sal/pré-sal da Bacia de
      // Campos), sem relação com este contrato. O FPSO real da área
      // (revitalização de Albacora, reservatório Forno unitizado com o
      // bloco de Norte de Brava) ainda está em licitação (nov/2025, sem
      // vencedor definido) — sem 1º óleo confirmado. O único poço
      // perfurado no contrato (1-BRSA-1394-RJS, pioneiro) foi abandonado
      // permanentemente — volta pro grupo exploração, sem workstream de
      // FPSO, e "Poços Perfurados" (contagem anual) vira "Poços
      // Exploratórios" (poço nomeado), mesmo padrão dos outros contratos
      // desse grupo.
      proj('Norte de Brava', PALETTE[4], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2022-12-16', true, 'contract'),
          m('Assinatura', '2023-07-05', true, 'contract'),
        ]),
        ws('Poços Exploratórios', [
          m('Poço pioneiro 1-BRSA-1394-RJS (abandonado permanentemente)', '2025-03-14', true, 'well', false, [-22.28171, -40.014952]),
        ]),
      ]),
      proj('Bumerangue', PALETTE[5], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2022-12-16', true, 'contract'),
          m('Assinatura', '2023-07-05', true, 'contract'),
        ]),
        ws('Poços Exploratórios', [
          m('Poço pioneiro 1-BP-13-SPS (descoberta)', '2025-07-17', true, 'well', false, [-26.492925, -43.4648333333]),
        ]),
      ]),
      proj('Sudoeste de Sagitário', PALETTE[6], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2022-12-16', true, 'contract'),
          m('Assinatura', '2023-07-05', true, 'contract'),
        ]),
        ws('Poços Exploratórios', [
          m('Poço piloto 3-BRSA-1388D-SPS (sem indícios de pré-sal)', '2023-06-23', true, 'well', false, [-25.1666836111, -44.1801369444]),
          m('Poço de extensão 3-BRSA-1388DA-SPS (resultado abaixo do esperado)', '2023-10-11', true, 'well', false, [-25.1664525, -44.1807536111]),
        ]),
      ]),
      proj('Tupinambá', PALETTE[7], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2023-12-13', true, 'contract'),
          m('Assinatura (data prevista)', '2024-05-31', false, 'contract'),
        ]),
        ws('Poços Exploratórios', [
          m('Poço exploratório (previsto)', '2026-01-01', false, 'well', true),
        ]),
      ]),
      proj('Esmeralda', PALETTE[8], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2025-10-22', true, 'contract'),
          m('Assinatura', '2026-08-05', true, 'contract'),
        ]),
      ]),
      proj('Ametista', PALETTE[9], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2025-10-22', true, 'contract'),
          m('Assinatura', '2026-08-05', true, 'contract'),
        ]),
      ]),
      proj('Citrino', PALETTE[0], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2025-10-22', true, 'contract'),
          m('Assinatura', '2026-08-05', true, 'contract'),
        ]),
      ]),
      proj('Itaimbezinho', PALETTE[1], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2025-10-22', true, 'contract'),
          m('Assinatura', '2026-08-05', true, 'contract'),
          m('Petrobras compra 50% (Equinor)', '2026-06-01', true, 'contract'),
        ]),
      ]),
      proj('Jaspe', PALETTE[2], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2025-10-22', true, 'contract'),
          m('Assinatura', '2026-08-05', true, 'contract'),
        ]),
      ]),
    ],
  };
}

/* -------------------------------- State -------------------------------- */

// Incrementar sempre que seedState() ganhar workstreams/marcos novos, ou
// corrigir dados existentes, que devem chegar automaticamente a quem já
// tem estado salvo no navegador (ver mergeSeedUpdates). Estado salvo sem
// "seedVersion" é tratado como 0.
// v2: workstreams "Poços Exploratórios". v3: FPSOs previstos (Búzios,
// Sul de Gato do Mato, Sépia-2, Atapu-2) + Peroba/Alto de Cabo Frio Oeste
// confirmados como devolvidos (grupo e nome do marco de status). v4:
// corrige a data da Anita Garibaldi (ver FIELD_CORRECTIONS) e passa a
// travar o arraste de item em zoom muito baixo (ver MIN_PX_PER_DAY_FOR_DRAG
// em app.js) — a causa provável do erro: nessa escala poucos pixels de
// mouse já representam anos, e um clique impreciso vira arraste enorme.
// v5: workstreams "Poços Exploratórios" dos blocos devolvidos (Pau-Brasil,
// Três Marias, Saturno, Titã) + corrige a data de devolução do Saturno
// (ver FIELD_CORRECTIONS).
// v6: dados reais de localização e data da base oficial de poços da
// ANP/BDEP (Tabela_pocos, ago/2026) — substitui aproximações por
// coordenadas e datas exatas (campo "coords" em m(), ver FIELD_CORRECTIONS
// para marcos com nome inalterado) e adiciona poços até então não
// rastreados para Sul de Gato do Mato, Alto de Cabo Frio Central,
// Uirapuru, Sudoeste de Tartaruga Verde, Aram, Água Marinha e Sudoeste de
// Sagitário. Não inclui os grandes campos em produção (Búzios, Itapu,
// Sépia, Atapu etc.), que têm dezenas a centenas de poços na base ANP —
// fora da granularidade deste roadmap.
// v7: workstream "Poços Perfurados" nos 8 projetos do grupo Produção
// (Libra, Norte de Carcará, Entorno de Sapinhoá, Búzios, Itapu, Sépia,
// Atapu, Norte de Brava) — um marco por ano-calendário com a contagem de
// poços concluídos naquele ano (fonte: mesma base ANP/BDEP, agregada por
// scripts/build_pocos.py), datado em 31/12. É o resumo que faltava pros
// campos excluídos do v6 por terem poço demais pra virar marco individual
// — ano incompleto (2026) fica com "(até agora)" no nome e a data do
// último poço concluído, não 31/12, pra não postar um marco "concluído"
// numa data ainda no futuro. Nome de workstream diferente de "Poços
// Exploratórios" de propósito: mapa.js só desenha marcador de poço pra
// esse nome exato, e estes marcos não têm um ponto único no mapa (são
// contagem agregada de um ano inteiro), então ficam só no roadmap/tabela.
// v8: revisão Mero/Libra — Mero (campo comercial de produção, PD "Campo de
// Mero (AIP) 2021") vira projeto rastreado próprio, com "Poços Perfurados"
// (69 poços dentro da área declarada do campo) e "Primeiro Óleo por FPSO"
// (antes em "Libra", sempre foi sobre Mero); Libra passa a representar só
// o resto do bloco original, fora da área de Mero, ainda em exploração (5
// poços, todos abandonados) — grupo muda de produção pra exploração, e o
// workstream de poços vira "Poços Exploratórios" (ver REMOVED_WORKSTREAMS
// pra quem já tinha Libra salvo com a estrutura antiga). Estado salvo sem
// "Mero" não ganha o projeto novo automaticamente (mergeSeedUpdates só
// atualiza projeto que o usuário já tem — ver nota ali); só estado novo
// (sem localStorage prévio) parte de seedState() já com os dois.
// v9: datas do Plano de Desenvolvimento (Comercialidade e/ou PD aprovado,
// ver data/planos_desenvolvimento.json) na workstream "Marcos do
// Contrato" dos 7 projetos com PD publicado (Mero, Norte de Carcará,
// Entorno de Sapinhoá, Búzios, Itapu, Sépia, Atapu) — só quando a data
// exata existe na fonte (comercialidade sempre vem com dia; a data de
// aprovação do PD só quando a resolução citada no sumário traz o dia,
// nem toda traz — Norte de Carcará e Sépia ficam sem "PD aprovado", Itapu
// fica sem "Comercialidade": o sumário de cada uma não publicou a data
// que falta). "Comercialidade" já sob a Cessão Onerosa (Búzios, Sépia,
// Atapu) fica ANTES do Leilão do CPP atual na mesma workstream — não é
// erro, é o mesmo "lead time negativo" documentado em analises.js
// (leilaoYearOf/computeProjectRow): esses campos já produziam sob o
// regime anterior antes do leilão do contrato de partilha rastreado aqui.
// v10: corrige Norte de Carcará — a poligonal e a base de poços tinham
// Bacalhau (Concessão) fundido com Bacalhau Norte (o CPP/Partilha
// realmente rastreado aqui), como se fossem o mesmo contrato (ver nota no
// seed, junto de "Norte de Carcará"). "Poços Perfurados" recontado só com
// os 5 poços de Bacalhau Norte (RENAMED_MILESTONES remove a lista antiga,
// fundida com os poços de Bacalhau).
// v11: "Poços Perfurados" de Norte de Carcará volta a contar Bacalhau
// Norte + Bacalhau juntos (22 poços) — pedido explícito: no roadmap a
// perfuração da jazida inteira é o que importa acompanhar, mesmo com
// Bacalhau fora do contrato de partilha (mapa e análises continuam
// separando os dois, só o roadmap soma).
// v12: corrige Norte de Brava — volta pro grupo exploração (ver nota no
// seed, junto de "Norte de Brava"): "Anita Garibaldi" é o FPSO de Marlim/
// Voador, não deste contrato, e o FPSO real da área ainda está em
// licitação, sem 1º óleo. Workstream de FPSO removida, "Poços Perfurados"
// vira "Poços Exploratórios" com o único poço do contrato (pioneiro,
// abandonado).
const SEED_VERSION = 12;

// Nomes antigos de marco que migraram para um nome novo em seedState() —
// sem isso, o merge abaixo (que só adiciona, nunca substitui) deixaria o
// marco antigo e o novo lado a lado. Chave: nome do projeto; valor: nomes
// de marco antigos a remover ao mesclar.
const RENAMED_MILESTONES = {
  'Peroba': [
    'Status contestado (PPSA: ativo / imprensa: devolvido)',
    'Poço pioneiro (gás com CO2, sem viabilidade)',
  ],
  'Alto de Cabo Frio Oeste': [
    'Status contestado (PPSA: ativo / imprensa: devolvido)',
    'Poço pioneiro (navio Brava Star)',
  ],
  'Uirapuru': ['Poço pioneiro (descoberta)'],
  'Dois Irmãos': ['Poço pioneiro (poço seco, navio Ocean Courage) — bloco devolvido'],
  'Água Marinha': ['Início da perfuração (poço 1-BRSA-1401D/DA-RJS) — resultado ainda não divulgado'],
  // v10 recontou "Poços Perfurados" só com os poços de Bacalhau Norte
  // (separando de Bacalhau/Concessão, ver nota no seed) — v11 volta a
  // contar os dois juntos (pedido explícito: no roadmap a perfuração da
  // jazida inteira é o que importa, ver nota no seed). Remove só os 2
  // nomes que só existiram em v10, pra quem já tinha migrado pra lá nesse
  // meio-tempo não ficar com os dois ao mesmo tempo (o resto da lista
  // v11 é idêntico ao de antes do v10, então não precisa de remoção).
  'Norte de Carcará': ['1 poço perfurado em 2024', '1 poço perfurado em 2025'],
};

// Nome de workstream inteira que saiu de um projeto em seedState() — sem
// isso, o merge abaixo (que só adiciona workstream/item novo, nunca
// remove) deixaria a workstream antiga do usuário lado a lado com a nova
// de mesmo assunto. Chave: nome do projeto; valor: nomes de workstream
// antigos a remover ao mesclar.
const REMOVED_WORKSTREAMS = {
  // Libra virou o resto do bloco fora da área de Mero (grupo exploração,
  // ver seedState/v8 acima) — "Poços Perfurados" (contagem anual, do
  // bloco inteiro) e "Primeiro Óleo por FPSO" (sempre foi sobre Mero)
  // migraram pra lá.
  'Libra': ['Poços Perfurados', 'Primeiro Óleo por FPSO'],
  // Norte de Brava volta pro grupo exploração (ver nota no seed) — nunca
  // teve FPSO de verdade (Anita Garibaldi era de Marlim/Voador) nem poço
  // "perfurado" no sentido de produção (o único poço foi um pioneiro
  // abandonado, agora em "Poços Exploratórios").
  'Norte de Brava': ['Poços Perfurados', 'Primeiro Óleo por FPSO'],
};

// Correções pontuais de um campo que já se sabe estar errado (bug de
// arraste em zoom baixo, erro de digitação etc.) — diferente do resto do
// merge (que só adiciona), isto SOBRESCREVE o valor salvo do usuário. Usar
// só para erros confirmados com fonte, nunca para forçar preferência.
const FIELD_CORRECTIONS = [
  {
    // Registrada por engano com a data do poço seco (05/2020); a devolução
    // real do bloco só ocorreu no 4º tri/2022 (ver comentário no seed).
    project: 'Saturno', workstream: 'Marcos do Contrato', item: 'Devolução',
    fields: { date: '2022-10-01' },
  },
  // Datas exatas e coordenadas reais (base de poços ANP/BDEP,
  // ago/2026) substituindo aproximações anteriores — nomes de marco
  // inalterados, então o merge (que só adiciona por nome) não pegaria
  // essas correções sozinho.
  {
    project: 'Alto de Cabo Frio Central', workstream: 'Poços Exploratórios', item: 'Poço pioneiro 1-BRSA-1383A-RJS (teste de formação)',
    fields: { date: '2022-04-22', coords: [-24.0069738888, -41.2217544444] },
  },
  {
    project: 'Sudoeste de Tartaruga Verde', workstream: 'Poços Exploratórios', item: 'Poço 4-BRSA-1403D-RJS (descoberta)',
    fields: { date: '2025-11-10', coords: [-23.0157605555, -40.7963169444] },
  },
  {
    project: 'Aram', workstream: 'Poços Exploratórios', item: 'Poço pioneiro "Curaçao" 1-BRSA-1381-SPS (descoberta)',
    fields: { date: '2021-12-10', coords: [-25.6399680555, -44.6537894444] },
  },
  {
    project: 'Aram', workstream: 'Poços Exploratórios', item: 'Poço 4-BRSA-1395-SPS (óleo e gás)',
    fields: { date: '2025-05-22', coords: [-25.3788336111, -44.4963166666] },
  },
  {
    project: 'Aram', workstream: 'Poços Exploratórios', item: 'Poço 3-BRSA-1396D-SPS (óleo de alta qualidade)',
    fields: { date: '2025-04-26', coords: [-25.6443022222, -44.6005983333] },
  },
  {
    project: 'Bumerangue', workstream: 'Poços Exploratórios', item: 'Poço pioneiro 1-BP-13-SPS (descoberta)',
    fields: { date: '2025-07-17', coords: [-26.492925, -43.4648333333] },
  },
  {
    project: 'Pau-Brasil', workstream: 'Poços Exploratórios', item: 'Poço 1-BP-12D-RJS (poço seco)',
    fields: { date: '2024-08-08', coords: [-25.7683027777, -42.26555] },
  },
  {
    project: 'Três Marias', workstream: 'Poços Exploratórios', item: 'Poço 1-BRSA-1382D-RJS (indícios sem viabilidade)',
    fields: { date: '2022-02-01', coords: [-24.9830291666, -42.0607191666] },
  },
  {
    project: 'Saturno', workstream: 'Poços Exploratórios', item: 'Poço 1-SHEL-33-RJS "Saturno1" (poço seco)',
    fields: { date: '2020-05-30', coords: [-25.0051347222, -41.141395] },
  },
  {
    project: 'Titã', workstream: 'Poços Exploratórios', item: 'Poço 1-EMEB-2-RJS "Titã-1" (indícios, avaliado como não comercial)',
    fields: { date: '2021-10-23', coords: [-24.6917719444, -41.0392758333] },
  },
  {
    project: 'Sudoeste de Sagitário', workstream: 'Poços Exploratórios', item: 'Poço de extensão 3-BRSA-1388DA-SPS (resultado abaixo do esperado)',
    fields: { date: '2023-10-11', coords: [-25.1664525, -44.1807536111] },
  },
];

// Projeto rastreado novo que precisa ser adicionado a QUALQUER estado
// salvo que ainda não tenha — ver ensureNewTrackedProjects, chamada
// incondicionalmente (não só quando o seedVersion está desatualizado, ver
// nota lá). Hoje só Mero: mergeSeedUpdates nunca recria um projeto que o
// usuário não tem salvo (pra não ressuscitar um removido de propósito),
// e isso escondeu Mero pra sempre de quem já usava o app desde antes dele
// existir — mesmo depois de seedVersion já ter avançado várias vezes sem
// o projeto ser adicionado (o gate de versão, se dependesse só dele, já
// tinha "passado" pra esses usuários). Único projeto na lista até hoje —
// se algum outro caso aparecer, considerar se cabe aqui ou se é mesmo
// caso de o usuário ter removido de propósito.
const NEW_TRACKED_PROJECTS = ['Mero'];

// Garante que os projetos de NEW_TRACKED_PROJECTS existam no estado
// salvo, incondicionalmente (sem checar seedVersion) — diferente do resto
// da migração (mergeSeedUpdates), que só roda quando a versão está
// desatualizada. Devolve true se adicionou algo (pra loadState saber se
// precisa salvar de novo).
//
// A ordem dentro de cada grupo no roadmap é simplesmente a ordem do array
// state.projects (não há sort explícito por data em app.js) — e a ordem
// de seedState() já reflete a data do Leilão dentro de cada grupo. Por
// isso o novo projeto é (re)inserido na posição correspondente à
// referência (antes do primeiro projeto já salvo cuja posição na
// referência é maior), em vez de simplesmente ir pro final do array: um
// push cego jogaria, por ex., o Mero (Leilão de 2013, o mais antigo de
// todos) pro fim do grupo de produção, atrás de projetos com leilão bem
// mais recente — o que já tinha acontecido com quem recebeu o Mero pela
// primeira versão desta função (só push). Por isso a reposição roda pra
// TODO projeto de NEW_TRACKED_PROJECTS, mesmo quando ele já existe no
// estado salvo — a função é idempotente (não mexe em mais nada se a
// posição já está correta) e corrige automaticamente quem ficou com o
// Mero mal posicionado por causa daquele bug antigo.
function ensureNewTrackedProjects(saved) {
  const before = saved.projects.map((p) => p.name).join('|');
  const reference = seedState();
  const refIndexByName = new Map(reference.projects.map((p, i) => [p.name, i]));
  for (const name of NEW_TRACKED_PROJECTS) {
    const newIdx = refIndexByName.get(name);
    const existingIdx = saved.projects.findIndex((p) => p.name === name);
    let entry;
    if (existingIdx === -1) {
      const refProj = reference.projects.find((p) => p.name === name);
      if (!refProj) continue;
      entry = JSON.parse(JSON.stringify(refProj));
    } else {
      entry = saved.projects.splice(existingIdx, 1)[0];
    }
    const insertAt = saved.projects.findIndex((p) => {
      const idx = refIndexByName.get(p.name);
      return idx !== undefined && idx > newIdx;
    });
    if (insertAt === -1) saved.projects.push(entry);
    else saved.projects.splice(insertAt, 0, entry);
  }
  return saved.projects.map((p) => p.name).join('|') !== before;
}

// Aplica ao estado salvo do usuário só o que existe em seedState() e ainda
// não existe localmente — nunca sobrescreve nem remove nada que o usuário
// já tenha editado ou adicionado por conta própria. Casa projeto por nome
// e, dentro dele, workstream por nome; workstream nova é adicionada
// inteira, workstream já existente ganha apenas os itens (por nome) que
// faltarem. Projeto que o usuário não tem salvo não é recriado aqui
// (removido ou nunca importado) — ver ensureNewTrackedProjects pra a
// única exceção conhecida. O grupo (Exploração/Produção/Devolvidos) é
// sincronizado com a referência, já que reflete a situação real do
// contrato (não uma preferência pessoal) — se você reclassificou um
// projeto de propósito, ajuste de novo depois de uma migração.
function mergeSeedUpdates(saved) {
  const reference = seedState();
  for (const refProj of reference.projects) {
    const savedProj = saved.projects.find((p) => p.name === refProj.name);
    if (!savedProj) continue;
    savedProj.group = refProj.group;
    const removedWs = REMOVED_WORKSTREAMS[refProj.name];
    if (removedWs) savedProj.workstreams = savedProj.workstreams.filter((w) => !removedWs.includes(w.name));
    const renamed = RENAMED_MILESTONES[refProj.name];
    for (const refWs of refProj.workstreams) {
      const savedWs = savedProj.workstreams.find((w) => w.name === refWs.name);
      if (!savedWs) {
        savedProj.workstreams.push(refWs);
        continue;
      }
      if (renamed) {
        savedWs.items = savedWs.items.filter((i) => !renamed.includes(i.name));
      }
      for (const refItem of refWs.items) {
        const exists = savedWs.items.some((i) => i.name === refItem.name);
        if (!exists) savedWs.items.push(refItem);
      }
    }
  }
  for (const fix of FIELD_CORRECTIONS) {
    const p = saved.projects.find((pr) => pr.name === fix.project);
    const w = p && p.workstreams.find((ws) => ws.name === fix.workstream);
    const i = w && w.items.find((it) => it.name === fix.item);
    if (i) Object.assign(i, fix.fields);
  }
  saved.seedVersion = SEED_VERSION;
  return saved;
}

// Sinaliza para app.js/tabela.js, depois do carregamento, se algo foi
// adicionado automaticamente — para mostrar um toast avisando o usuário.
let seedMigrationHappened = false;

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.projects)) {
        if (!parsed.pxPerDay) parsed.pxPerDay = SCALE_PX_PER_DAY[parsed.scale] || SCALE_PX_PER_DAY.month;
        if (!parsed.groupCollapsed) parsed.groupCollapsed = {};
        // Compatibilidade: projetos salvos antes do agrupamento por
        // fase/situação (Exploração/Produção/Devolvidos) não têm "group".
        // Se o nome bater com um dos 29 contratos oficiais, usa o grupo
        // real dele (inferProjectGroup) em vez de cair sempre no fallback.
        for (const p of parsed.projects) {
          if (!p.group) p.group = inferProjectGroup(p.name);
        }
        let changed = false;
        if ((parsed.seedVersion || 0) < SEED_VERSION) {
          mergeSeedUpdates(parsed);
          changed = true;
        }
        // Incondicional (não só quando seedVersion está desatualizado) —
        // ver nota em NEW_TRACKED_PROJECTS: o gate de versão sozinho não
        // bastava pra garantir que Mero chegasse a quem já tinha passado
        // por uma migração anterior sem ganhar o projeto.
        if (ensureNewTrackedProjects(parsed)) changed = true;
        if (changed) {
          seedMigrationHappened = true;
          localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
        }
        return parsed;
      }
    }
  } catch (e) {
    console.warn('Falha ao carregar estado salvo, usando dados de exemplo.', e);
  }
  const fresh = seedState();
  fresh.seedVersion = SEED_VERSION;
  return fresh;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function findProject(projectId) {
  return state.projects.find((p) => p.id === projectId);
}
function findWorkstream(projectId, wsId) {
  const p = findProject(projectId);
  return p && p.workstreams.find((w) => w.id === wsId);
}
function findItem(projectId, wsId, itemId) {
  const w = findWorkstream(projectId, wsId);
  return w && w.items.find((i) => i.id === itemId);
}

let state = loadState();

/* --------------------------- Menu de opções (toolbar) --------------------------- */
// Só os botões de navegação entre páginas ficam soltos na toolbar; o resto
// (escala, importar/exportar, novo projeto etc.) mora dentro de um menu
// discreto por trás do botão "⋯". Genérico o bastante pra servir as três
// páginas sem duplicar a lógica de abrir/fechar em cada uma.
(function initOptionsMenu() {
  const btn = document.getElementById('optionsBtn');
  const menu = document.getElementById('optionsMenu');
  if (!btn || !menu) return;

  function closeMenu() {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }
  function openMenu() {
    // position: fixed no CSS (ver style.css) pra não ser cortado pelo
    // overflow-x: auto de .toolbar-right no mobile — por isso calcula a
    // posição em vez de deixar o CSS resolver relativo ao botão.
    const rect = btn.getBoundingClientRect();
    menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.right = (window.innerWidth - rect.right) + 'px';
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) openMenu(); else closeMenu();
  });
  // Fecha ao clicar em qualquer botão/link dentro do menu (a ação já foi
  // disparada pelo próprio listener do item antes deste, na fase de bolha).
  menu.addEventListener('click', (e) => {
    if (e.target.closest('button, a')) closeMenu();
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) closeMenu();
  });
})();
