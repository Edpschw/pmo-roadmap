'use strict';

/* =========================================================================
   Núcleo de dados compartilhado entre as páginas do Roadmap PMO (visão
   Gantt em index.html e visão em tabela em tabela.html). Sem dependências
   externas. Carregar antes de app.js / tabela.js.
   ========================================================================= */

const STORAGE_KEY = 'pmo-roadmap-state-v1';

const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif';

// Medição de largura de texto via canvas (sem inserir/remover elemento
// DOM) — compartilhada entre app.js (largura da sidebar do roadmap
// principal, rótulo de marco) e campo.js (largura da sidebar do
// mini-roadmap por projeto).
const _measureCanvas = document.createElement('canvas');
const _measureCtx = _measureCanvas.getContext('2d');
function measureTextWidth(text, font) {
  _measureCtx.font = font;
  return _measureCtx.measureText(text).width;
}

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
// Garante que o fim do intervalo do roadmap sempre cubra o último ano por
// inteiro (até 31/dez), em vez de cortar no meio do ano (ex.: timeline
// terminando em "mar 2029", com 2029 aparecendo incompleto) — usado tanto
// no roadmap principal (computeRange, app.js) quanto no mini-roadmap por
// projeto (roadmapRange, campo.js). rangeEnd é fronteira EXCLUSIVA nos
// dois (iteração/desenho sempre vai até `< rangeEnd`), então "1º de
// janeiro" já significa "31/dez do ano anterior incluído por inteiro" —
// só empurra pro 1º de janeiro seguinte quando rangeEnd cai em outro dia.
function completeLastYear(rangeEnd) {
  if (rangeEnd.getUTCMonth() === 0 && rangeEnd.getUTCDate() === 1) return rangeEnd;
  return new Date(Date.UTC(rangeEnd.getUTCFullYear() + 1, 0, 1));
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

// Ícones de marco por tipo: "contrato" (documento com dobra e linhas de
// texto) e "fpso" (casco + superestrutura de navio) substituem o losango
// padrão para deixar visualmente óbvio o que aquele marco representa. Sem
// tipo definido (marco genérico), mantém o losango de sempre (via CSS).
// Compartilhado entre app.js (roadmap principal) e campo.js (mini-roadmap
// por projeto).
function contractIconSVG(color) {
  return `<svg viewBox="0 0 16 16">
    <path d="M3 1h6l4 4v9.3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z" fill="${color}"/>
    <path d="M9 1v4h4" fill="none" stroke="#fff" stroke-opacity="0.6" stroke-width="1" stroke-linejoin="round"/>
    <line x1="4" y1="9" x2="10" y2="9" stroke="#fff" stroke-opacity="0.85" stroke-width="1.2" stroke-linecap="round"/>
    <line x1="4" y1="11.5" x2="9" y2="11.5" stroke="#fff" stroke-opacity="0.85" stroke-width="1.2" stroke-linecap="round"/>
  </svg>`;
}
function fpsoIconSVG(color) {
  return `<svg viewBox="0 0 16 16">
    <path d="M1 10.5h14l-2.3 4H3.3z" fill="${color}"/>
    <rect x="8.3" y="5.3" width="4.2" height="5.2" rx="0.6" fill="${color}"/>
    <rect x="9.9" y="2.8" width="1.2" height="2.8" fill="${color}"/>
    <line x1="3.3" y1="10.5" x2="12.7" y2="10.5" stroke="#fff" stroke-opacity="0.35" stroke-width="0.8"/>
  </svg>`;
}
function wellIconSVG(color) {
  return `<svg viewBox="0 0 16 16">
    <path d="M8 1L3.2 13.5h1.7L8 4.6l3.1 8.9h1.7z" fill="${color}"/>
    <line x1="4.6" y1="9.6" x2="11.4" y2="9.6" stroke="#fff" stroke-opacity="0.6" stroke-width="0.9"/>
    <line x1="5.7" y1="6.8" x2="10.3" y2="6.8" stroke="#fff" stroke-opacity="0.6" stroke-width="0.9"/>
    <rect x="2.6" y="13.5" width="10.8" height="1.3" rx="0.3" fill="${color}"/>
  </svg>`;
}
const MILESTONE_ICON_BUILDERS = { contract: contractIconSVG, fpso: fpsoIconSVG, well: wellIconSVG };
const MILESTONE_TYPE_LABELS = { contract: 'Marco de contrato', fpso: 'FPSO', well: 'Poço' };

// Empacota itens que se sobrepõem no tempo em "raias" verticais dentro da
// linha de uma workstream, para que não fiquem desenhados um sobre o outro
// — compartilhada entre app.js (roadmap principal) e campo.js (mini-roadmap
// por projeto).
function packLanes(items) {
  const withRange = items.map((it) => {
    const s = parseDate(it.type === 'milestone' ? it.date : it.start);
    const e = it.type === 'milestone' ? s : parseDate(it.end);
    return { item: it, s, e };
  }).sort((a, b) => a.s - b.s);

  const lanes = []; // cada lane = data do último "e" ocupado
  const placements = [];
  for (const entry of withRange) {
    let laneIndex = lanes.findIndex((lastEnd) => entry.s > lastEnd);
    if (laneIndex === -1) {
      laneIndex = lanes.length;
      lanes.push(entry.e);
    } else {
      lanes[laneIndex] = entry.e;
    }
    placements.push({ item: entry.item, lane: laneIndex });
  }
  return { placements, laneCount: Math.max(1, lanes.length) };
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

/* -------------------------- Rótulo visível do marco ----------------------- */
// Compartilhado entre app.js (roadmap principal, rótulo sempre visível
// acima/abaixo do losango — ver renderMilestone) e campo.js (mini-roadmap
// por projeto, mesmo rótulo, ver buildRoadmapMilestone). O texto completo
// continua disponível no hover (tooltip rico em app.js, title nativo em
// campo.js) — aqui é só a versão curta que cabe no gráfico.

// Rótulo sempre visível no gráfico fica só com o essencial. Marco de poço
// (icon 'well') tem regra própria — ver wellMilestoneLabel logo abaixo, que
// usa o código do poço e o operador direto da base da ANP; esta função aqui
// cobre os demais tipos (contrato, FPSO, genérico): corta o parêntese final
// e a cláusula final com travessão do nome ("Petrobras compra 50%
// (Equinor)" vira "Petrobras compra 50%") — o texto completo não se perde,
// continua aparecendo por inteiro no hover. Só corta em cima de travessão
// "—", nunca hífen comum, porque nome de marco pode ter hífen no meio
// (datas, códigos).
function simplifyMilestoneLabel(name) {
  let s = String(name);
  let changed = true;
  while (changed) {
    changed = false;
    let m = s.match(/^(.*?)\s*\([^()]*\)\s*$/);
    if (m && m[1]) { s = m[1]; changed = true; continue; }
    m = s.match(/^(.*)\s+—\s+.+$/);
    if (m && m[1]) { s = m[1]; changed = true; continue; }
  }
  s = s.trim();
  return s || String(name).trim();
}

// Marco agregado ("17 poços perfurados em 2024", workstream "Poços
// Perfurados" dos campos em produção) — casa só o número no início do
// nome, sem exigir o resto do texto, pra não depender do plural/singular
// ("1 poço perfurado" vs "17 poços perfurados").
const WELL_COUNT_MILESTONE_RE = /^(\d+)\s+poços?\s+perfurados?\s+em\s+\d{4}/i;

// Rótulo sempre visível de um marco de poço: só o essencial, direto da base
// da ANP em vez do texto curado (que tinha prefixo de tipo, apelido entre
// aspas e o resultado detalhado — tudo isso continua no hover). Agregado de
// ano vira só o número; poço individual vira "código (operador)"; sem
// correspondência na base (ex.: "Poço exploratório (previsto)", que ainda
// não tem poço real perfurado) cai no corte genérico de
// simplifyMilestoneLabel. pocosData: data/pocos.json já carregado (chave =
// nome do projeto).
function wellMilestoneLabel(pocosData, project, item) {
  const countMatch = item.name.match(WELL_COUNT_MILESTONE_RE);
  if (countMatch) return countMatch[1];
  const code = wellCodeOf(item.name);
  if (code) {
    const wells = pocosData[project.name] || [];
    const found = wells.find((w) => w.n === code);
    if (found && found.op) return `${code} (${found.op})`;
    return code;
  }
  return simplifyMilestoneLabel(item.name);
}

// Ponto único de decisão entre as duas regras de simplificação (poço vs. os
// demais tipos) — usado tanto no cálculo de colisão/layout do rótulo quanto
// no desenho, pra nunca divergir entre o que foi medido/decidido e o texto
// realmente exibido.
function milestoneLabelOf(pocosData, project, item) {
  return item.icon === 'well' ? wellMilestoneLabel(pocosData, project, item) : simplifyMilestoneLabel(item.name);
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

/* ------------------------- Ícones de poço e sonda ------------------------- */
// Compartilhados entre mapa.js (mapa completo, um ícone por poço colorido
// pelo PROJETO) e campo.js (mini-mapa por projeto — mesmos ícones/legenda,
// só reaproveitados num container menor).

// Um desenho por situação, todos no mesmo viewBox 16×16 (assim o mesmo
// iconAnchor serve pra todos). Vocabulário de símbolo de poço mais comum em
// mapas de E&P (o mesmo círculo/triângulo usado pelos basemaps de agências
// como a Texas RRC e a Colorado COGCC, e pelo estilo "Petroleum" do
// ArcGIS) em vez de pictogramas desenhados — mais reconhecível pra quem já
// viu um mapa de poços antes, e mais simples de manter legível pequeno:
// círculo = óleo, triângulo = gás, seta pra baixo = injeção (fluido volta
// pro reservatório), vazio = não achou nada (seco) ou achou pela metade
// (indício), X = abandonado.
const WELL_SHAPES = {
  producao: (c) => `
    <circle cx="8" cy="8" r="5.4" fill="${c}" stroke="#0b0d10" stroke-width="1.4"/>`,
  gas: (c) => `
    <path d="M8 2 L13.7 12.6 L2.3 12.6 Z" fill="${c}" stroke="#0b0d10" stroke-width="1.4" stroke-linejoin="round"/>`,
  injecao: (c) => `
    <path d="M6.2 2.2H9.8V7.4H12.8L8 13L3.2 7.4H6.2Z" fill="${c}" stroke="#0b0d10" stroke-width="1.4" stroke-linejoin="round"/>`,
  indicio: (c) => `
    <circle cx="8" cy="8" r="5.4" fill="none" stroke="#0b0d10" stroke-width="1.4"/>
    <path d="M8 2.6 A5.4 5.4 0 0 0 8 13.4 Z" fill="${c}"/>`,
  seco: (c) => `
    <circle cx="8" cy="8" r="4.2" fill="none" stroke="#0b0d10" stroke-width="1.6"/>
    <circle cx="8" cy="8" r="4.2" fill="none" stroke="${c}" stroke-width="0.9"/>`,
  abandonado: (c) => `
    <circle cx="8" cy="8" r="5.4" fill="none" stroke="#0b0d10" stroke-width="1.4"/>
    <path d="M5 5 L11 11 M11 5 L5 11" stroke="#0b0d10" stroke-width="2.4" stroke-linecap="round"/>
    <path d="M5 5 L11 11 M11 5 L5 11" stroke="${c}" stroke-width="1.3" stroke-linecap="round"/>`,
  indefinido: (c) => `
    <circle cx="8" cy="8" r="2.6" fill="${c}" stroke="#0b0d10" stroke-width="1" fill-opacity="0.55"/>`,
};

// Selo no canto superior direito da seta de injeção, indicando o fluido
// injetado (os únicos dois valores de RECLASSIFICACAO observados na base
// são "INJEÇÃO DE ÁGUA" e "INJEÇÃO DE GÁS NATURAL" — ver wellInjectionType).
// Cor fixa (não a cor do projeto): assim o selo se reconhece à distância
// como "água" ou "gás" em qualquer contrato, igual o anel laranja de AnC.
const INJECTION_BADGES = {
  agua: `<path d="M13 0.6C14.6 2.9 15.5 4.5 15.5 5.7A2.5 2.5 0 1 1 10.5 5.7C10.5 4.5 11.4 2.9 13 0.6Z" fill="#3aa8ff" stroke="#0b0d10" stroke-width="0.6"/>`,
  gas: `<path d="M13.4 0.5C13.7 2.1 14.7 2.9 15.4 3.8A2.6 2.6 0 1 1 10.5 4.9C10.5 4.4 10.65 4.0 10.9 3.6C11.0 4.1 11.25 4.3 11.6 4.1C11.35 3.0 11.75 1.9 13.4 0.5Z" fill="#ff6b35" stroke="#0b0d10" stroke-width="0.6"/>`,
};

// Ícone de poço no mapa: uma silhueta por situação (ver WELL_SHAPES e
// wellCategory), como divIcon do Leaflet (contorno escuro pra destacar
// tanto sobre o tile escuro quanto sobre o preenchimento colorido do
// polígono). Pequeno de propósito: contratos densos (Búzios chega a 137
// marcadores) já ficam cheios mesmo assim — um ícone maior só empilharia
// mais um em cima do outro.
// Anel tracejado laranja em volta do símbolo normal — não troca o símbolo
// (a categoria do poço continua valendo), só avisa que ele fica numa Área
// Não Concedida (AnC): a ANP ainda não deu um nome/contrato formal a essa
// área específica, então ela não tem polígono nenhum no mapa (ver
// CAMPOS_CONTEXTO_ALIASES em build_pocos.py) — o anel é a única pista
// visual de que aquele ponto está fora de qualquer contorno desenhado.
const ANC_RING_COLOR = '#e8a33d';

function wellDivIcon(color, category, anc, injType) {
  const shape = WELL_SHAPES[category] || WELL_SHAPES.indefinido;
  const ring = anc ? `<circle cx="8" cy="8" r="7.2" fill="none" stroke="${ANC_RING_COLOR}" stroke-width="1.1" stroke-dasharray="2 1.4"/>` : '';
  const badge = category === 'injecao' && INJECTION_BADGES[injType] ? INJECTION_BADGES[injType] : '';
  return L.divIcon({
    className: 'map-well-icon',
    html: `<svg viewBox="0 0 16 16" width="13" height="13" style="filter:drop-shadow(0 1px 1px rgba(0,0,0,0.7))">${shape(color)}${badge}${ring}</svg>`,
    iconSize: [13, 13],
    iconAnchor: [6.5, 6.5],
  });
}

// Sonda em perfuração/completação — mesmo desenho (derrick sobre um casco)
// pras duas situações que ganham ícone, só a cor muda, codificando a fase:
// vermelho perfurando (poço ainda formando), cinza completando (poço já
// perfurado, preparando pra entrar em produção). Cor fixa por situação
// (não a do projeto) — é indicador de SITUAÇÃO, não de propriedade, mesmo
// raciocínio do anel de AnC acima.
const RIG_STATUS_STYLE = {
  'EM PERFURAÇÃO': { color: '#e5484d', label: 'Em perfuração' },
  'EM COMPLETAÇÃO': { color: '#9aa1ad', label: 'Em completação' },
};
function rigIconSvg(color, size) {
  return `<svg viewBox="0 0 20 20" width="${size}" height="${size}" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,0.8))">
      <path d="M4 15.5 L16 15.5 L14 18.4 L6 18.4 Z" fill="#14171b" stroke="${color}" stroke-width="1.1" stroke-linejoin="round"/>
      <path d="M10 2 L6.3 15.5 M10 2 L13.7 15.5 M7.6 9.6 L12.4 9.6" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="10" cy="2" r="1.3" fill="${color}"/>
    </svg>`;
}
// Tamanho base do ícone de sonda — maior que o ícone de poço comum (ver
// wellDivIcon) de propósito: no mapa completo, no zoom baixo em que
// aparece, precisa se destacar sozinho, sem outros poços por perto pra dar
// contexto de escala; no mini-mapa de campo.js, onde não há o
// zoom-out/zoom-in do mapa completo, esse mesmo tamanho fixo continua
// proporcional ao container menor.
const RIG_ICON_BASE_SIZE = 14;
// No mapa completo acompanha o zoom (ver --map-rig-scale/updateMapLabelScale
// em mapa.js — a sonda só aparece no mesmo intervalo de zoom que o rótulo,
// zoom < wellsMinZoom); no mini-mapa de campo.js, sem esse cálculo de zoom,
// a variável cai no fallback (escala 1, ver .map-rig-icon-wrap no CSS) e o
// ícone fica no tamanho base acima. O wrap interno (não a classe do
// próprio divIcon, que o Leaflet já usa pra posicionar via transform
// inline) é quem recebe o scale — mesmo motivo de .map-project-label-wrap
// não estar na classe do ícone.
function rigDivIcon(color) {
  return L.divIcon({
    className: 'map-rig-icon',
    html: `<div class="map-rig-icon-wrap">${rigIconSvg(color, RIG_ICON_BASE_SIZE)}</div>`,
    iconSize: [RIG_ICON_BASE_SIZE, RIG_ICON_BASE_SIZE],
    iconAnchor: [RIG_ICON_BASE_SIZE / 2, RIG_ICON_BASE_SIZE * 0.9],
  });
}

// Ícone de FPSO no mini-mapa de campo.js (buildMiniMap) — mesmo desenho
// de fpsoIconSVG (marco de FPSO no roadmap e nos gráficos de produção),
// bem maior que o ícone de poço (20px vs 13px, ver wellDivIcon) pra
// destacar que é a instalação, não um poço — sombra igual, mesmo
// critério visual do resto do mini-mapa.
function fpsoDivIcon(color) {
  return L.divIcon({
    className: 'map-fpso-icon',
    html: `<svg viewBox="0 0 16 16" width="20" height="20" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,0.8))">${fpsoIconSVG(color)}</svg>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

// Ordem de exibição na legenda — do resultado mais positivo (achou e
// produz) ao mais neutro (sem registro), agrupando injeção/abandonado
// (intervenção/descontinuado) no meio.
const WELL_CATEGORY_LABELS = [
  ['producao', 'Produção (óleo)'],
  ['gas', 'Produção/indício de gás'],
  ['indicio', 'Indício de óleo (poço seco)'],
  ['seco', 'Seco, sem indícios'],
  ['abandonado', 'Abandonado'],
  ['indefinido', 'Sem resultado registrado'],
];
const WELL_LEGEND_COLOR = '#c7cad1';

function buildWellShapeLegend() {
  const legend = document.createElement('div');
  legend.className = 'map-legend';
  for (const [category, label] of WELL_CATEGORY_LABELS) {
    const row = document.createElement('div');
    row.className = 'map-legend-row';
    const icon = document.createElement('span');
    icon.className = 'map-legend-well-icon';
    icon.innerHTML = `<svg viewBox="0 0 16 16" width="15" height="15">${WELL_SHAPES[category](WELL_LEGEND_COLOR)}</svg>`;
    row.appendChild(icon);
    row.appendChild(document.createTextNode(label));
    legend.appendChild(row);
  }
  for (const [injType, label] of [['agua', 'Injeção de água'], ['gas', 'Injeção de gás']]) {
    const row = document.createElement('div');
    row.className = 'map-legend-row';
    const icon = document.createElement('span');
    icon.className = 'map-legend-well-icon';
    icon.innerHTML = `<svg viewBox="0 0 16 16" width="15" height="15">${WELL_SHAPES.injecao(WELL_LEGEND_COLOR)}${INJECTION_BADGES[injType]}</svg>`;
    row.appendChild(icon);
    row.appendChild(document.createTextNode(label));
    legend.appendChild(row);
  }
  const ancRow = document.createElement('div');
  ancRow.className = 'map-legend-row';
  const ancIcon = document.createElement('span');
  ancIcon.className = 'map-legend-well-icon';
  ancIcon.innerHTML = `<svg viewBox="0 0 16 16" width="15" height="15">${WELL_SHAPES.indefinido(WELL_LEGEND_COLOR)}<circle cx="8" cy="8" r="7.2" fill="none" stroke="${ANC_RING_COLOR}" stroke-width="1.1" stroke-dasharray="2 1.4"/></svg>`;
  ancRow.appendChild(ancIcon);
  ancRow.appendChild(document.createTextNode('Anel laranja: área não concedida (AnC), sem contrato formal'));
  legend.appendChild(ancRow);
  return legend;
}

// Legenda das sondas (ver RIG_STATUS_STYLE) — mesmo padrão visual de
// buildWellShapeLegend.
function buildRigLegend() {
  const legend = document.createElement('div');
  legend.className = 'map-legend';
  for (const style of Object.values(RIG_STATUS_STYLE)) {
    const row = document.createElement('div');
    row.className = 'map-legend-row';
    const icon = document.createElement('span');
    icon.className = 'map-legend-well-icon';
    icon.innerHTML = rigIconSvg(style.color, 15);
    row.appendChild(icon);
    row.appendChild(document.createTextNode(style.label));
    legend.appendChild(row);
  }
  return legend;
}

// Escapa texto pra uso seguro em template string de HTML — compartilhada
// entre app.js, mapa.js e analises.js (todas montam HTML por concatenação
// de string, sem framework).
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* ------------------ Gráfico de barra horizontal + tooltip ---------------- */
// Compartilhado entre analises.js e producao.js — as duas telas de gráfico
// usam a mesma barra horizontal com tooltip acessível (hover ou foco de
// teclado, nunca só hover — ver skill de dataviz) e o mesmo cartão em volta
// de cada gráfico.

// Cor neutra pros campos/linhas de contexto — fora dos 30 contratos
// rastreados (project.color própria), mas ainda parte do pré-sal e por
// isso mostrados para comparação (ex.: STOIIP em analises.js, produção em
// producao.js).
const CONTEXT_FIELD_COLOR = '#7a828f';

function fmtNum(n, opts) {
  return n.toLocaleString('pt-BR', opts || { maximumFractionDigits: 0 });
}

let tooltipEl = null;
function ensureTooltip() {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'viz-tooltip';
    tooltipEl.hidden = true;
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}
function positionTooltip(x, y) {
  const el = ensureTooltip();
  const pad = 14;
  const rect = el.getBoundingClientRect();
  let left = x + pad;
  let top = y + pad;
  if (left + rect.width > window.innerWidth - 8) left = x - rect.width - pad;
  if (top + rect.height > window.innerHeight - 8) top = y - rect.height - pad;
  el.style.left = Math.max(4, left) + 'px';
  el.style.top = Math.max(4, top) + 'px';
}
function hideTooltip() {
  if (tooltipEl) tooltipEl.hidden = true;
}
function tooltipRowHTML(label, value) {
  return `<div class="viz-tooltip-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}
// htmlFn é preguiçoso (só chamado no hover/foco) pra não montar milhares de
// strings de tooltip que talvez nunca sejam vistas.
function attachTooltip(el, htmlFn) {
  const show = (x, y) => {
    const t = ensureTooltip();
    t.innerHTML = htmlFn();
    t.hidden = false;
    positionTooltip(x, y);
    el.classList.add('is-hovered');
  };
  const hide = () => {
    hideTooltip();
    el.classList.remove('is-hovered');
  };
  el.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
  el.addEventListener('pointerleave', hide);
  el.addEventListener('focus', () => {
    const rect = el.getBoundingClientRect();
    show(rect.left + rect.width / 2, rect.top);
  });
  el.addEventListener('blur', hide);
}

function chartCard(title, subtitle) {
  const card = document.createElement('div');
  card.className = 'chart-card';
  const h3 = document.createElement('h3');
  h3.className = 'chart-card-title';
  h3.textContent = title;
  card.appendChild(h3);
  if (subtitle) {
    const sub = document.createElement('p');
    sub.className = 'chart-card-subtitle';
    sub.textContent = subtitle;
    card.appendChild(sub);
  }
  return card;
}

function barRow(label, widthPct, valueText, color, tooltipHtmlFn) {
  const row = document.createElement('div');
  row.className = 'hbar-row';
  const name = document.createElement('div');
  name.className = 'hbar-name';
  name.textContent = label;
  name.title = label;
  const track = document.createElement('div');
  track.className = 'hbar-track';
  const fill = document.createElement('div');
  fill.className = 'hbar-fill';
  fill.style.width = Math.max(3, widthPct) + '%';
  fill.style.background = color;
  fill.tabIndex = 0;
  attachTooltip(fill, tooltipHtmlFn);
  track.appendChild(fill);
  const value = document.createElement('div');
  value.className = 'hbar-value';
  value.textContent = valueText;
  track.appendChild(value);
  row.appendChild(name);
  row.appendChild(track);
  return row;
}

/* -------------------------------- Histograma ------------------------------ */
// Distribuição de uma métrica contínua (dias de perfuração, produção por
// poço, injeção por poço...) em faixas de largura igual — usada na aba
// Poços (ver pocos.js) pra mostrar a FORMA da distribuição, algo que nem a
// tabela crua nem um valor médio sozinho mostram (ex.: poucos poços muito
// produtivos puxando a média bem acima da mediana). SVG próprio no mesmo
// viewBox/escala de createLineChart (reusa .lc-svg/.line-chart-wrap), mas
// bem mais simples: sem pan/zoom/crosshair, só barras + eixo.
const HIST_W = 760;
const HIST_H = 300;
const HIST_MARGIN = { top: 18, right: 14, bottom: 46, left: 54 };

// Menor número da sequência "1-2-5-10 × 10^k" que é >= v — mesma régua por
// trás de eixo "redondo" em qualquer lib de gráfico; serve tanto pra
// arredondar a largura da faixa (nº de dias, bbl/d...) quanto o teto do
// eixo Y (contagem de poços).
function niceRoundUp(v) {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

function median(sortedVals) {
  const n = sortedVals.length;
  const mid = Math.floor(n / 2);
  return n % 2 ? sortedVals[mid] : (sortedVals[mid - 1] + sortedVals[mid]) / 2;
}

// values: array de números já na unidade de exibição (dias, bbl/d...).
// opts: { title, subtitle, unit, color, formatValue(v) -> string (default
// fmtNum) }. Sem poço nenhum com o dado, não desenha nada (mesmo padrão de
// buildWellBarChart em campo.js) — deixa o chamador decidir se isso é
// esperado (campo sem produção individualizada, por exemplo).
function buildHistogram(container, values, opts) {
  const vals = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!vals.length) return;
  const fmt = opts.formatValue || ((v) => fmtNum(v));
  const unitSuffix = opts.unit ? ' ' + opts.unit : '';
  const min = vals[0];
  const max = vals[vals.length - 1];
  const range = Math.max(max - min, 1e-9);

  // Nº de faixas cresce devagar com o tamanho da amostra (regra prática, não
  // Sturges/Scott formal) — poucos poços não travam num punhado de faixas
  // minúsculas, muitos poços não viram 200 barrinhas ilegíveis.
  const targetBins = Math.max(6, Math.min(16, Math.round(Math.sqrt(vals.length))));
  const step = niceRoundUp(range / targetBins) || 1;
  const binStart = Math.floor(min / step) * step;
  const binCount = Math.max(1, Math.floor((max - binStart) / step) + 1);
  const bins = new Array(binCount).fill(0);
  for (const v of vals) {
    let idx = Math.floor((v - binStart) / step);
    if (idx < 0) idx = 0;
    if (idx >= binCount) idx = binCount - 1;
    bins[idx]++;
  }
  const maxCount = Math.max(...bins);
  const yMax = niceRoundUp(maxCount);

  const plotW = HIST_W - HIST_MARGIN.left - HIST_MARGIN.right;
  const plotH = HIST_H - HIST_MARGIN.top - HIST_MARGIN.bottom;
  const barW = plotW / binCount;
  const xAt = (i) => HIST_MARGIN.left + barW * i;
  const yAt = (count) => HIST_MARGIN.top + plotH - (count / yMax) * plotH;

  const med = median(vals);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const card = chartCard(
    opts.title,
    `${opts.subtitle} — ${vals.length.toLocaleString('pt-BR')} poços, mediana ${fmt(med)}${unitSuffix}, média ${fmt(mean)}${unitSuffix}.`,
  );

  let gridSvg = '';
  let yLabelsSvg = '';
  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const count = (yMax * i) / ySteps;
    const y = yAt(count);
    gridSvg += `<line x1="${HIST_MARGIN.left}" y1="${y}" x2="${HIST_W - HIST_MARGIN.right}" y2="${y}" stroke="var(--border)" stroke-width="1" />`;
    yLabelsSvg += `<text x="${HIST_MARGIN.left - 8}" y="${y + 3}" text-anchor="end" font-size="10.5" style="fill:var(--text-muted)">${Math.round(count).toLocaleString('pt-BR')}</text>`;
  }

  const maxLabels = 10;
  const labelStep = Math.max(1, Math.ceil(binCount / maxLabels));
  let barsSvg = '';
  let xLabelsSvg = '';
  for (let i = 0; i < binCount; i++) {
    const x = xAt(i);
    const count = bins[i];
    const y = yAt(count);
    const h = HIST_MARGIN.top + plotH - y;
    const lo = binStart + i * step;
    const hi = lo + step;
    barsSvg += `<rect class="hist-bar" x="${x + 1}" y="${y}" width="${Math.max(0, barW - 2)}" height="${Math.max(0, h)}" fill="${opts.color || '#4d8bf5'}" rx="2" tabindex="0" data-lo="${lo}" data-hi="${hi}" data-count="${count}" />`;
    if (i % labelStep === 0) {
      const lx = x + barW / 2;
      xLabelsSvg += `<text x="0" y="0" transform="translate(${lx} ${HIST_MARGIN.top + plotH + 14}) rotate(-40)" text-anchor="end" font-size="10" style="fill:var(--text-muted)">${fmt(lo)}</text>`;
    }
  }

  const medX = HIST_MARGIN.left + ((med - binStart) / step) * barW;
  const medianSvg = (med >= binStart && med <= binStart + binCount * step)
    ? `<line x1="${medX}" y1="${HIST_MARGIN.top}" x2="${medX}" y2="${HIST_MARGIN.top + plotH}" stroke="var(--text-faint)" stroke-width="1.2" stroke-dasharray="3 3" />
       <text x="${medX}" y="${HIST_MARGIN.top - 6}" text-anchor="middle" font-size="10" style="fill:var(--text-muted)">mediana</text>`
    : '';

  const axisSvg = `<line x1="${HIST_MARGIN.left}" y1="${HIST_MARGIN.top + plotH}" x2="${HIST_W - HIST_MARGIN.right}" y2="${HIST_MARGIN.top + plotH}" stroke="var(--border-strong)" stroke-width="1" />`;

  const svgWrap = document.createElement('div');
  svgWrap.className = 'line-chart-wrap';
  svgWrap.innerHTML = `<svg class="lc-svg" viewBox="0 0 ${HIST_W} ${HIST_H}">${gridSvg}${axisSvg}${yLabelsSvg}${xLabelsSvg}${medianSvg}${barsSvg}</svg>`;
  card.appendChild(svgWrap);

  for (const rect of svgWrap.querySelectorAll('.hist-bar')) {
    const lo = Number(rect.dataset.lo);
    const hi = Number(rect.dataset.hi);
    const count = Number(rect.dataset.count);
    attachTooltip(rect, () => tooltipRowHTML(
      `${fmt(lo)}–${fmt(hi)}${unitSuffix}`,
      `${count.toLocaleString('pt-BR')} poço${count === 1 ? '' : 's'}`,
    ));
  }

  container.appendChild(card);
}

/* ------------------------- Produção mensal (ANP) -------------------------- */
// Compartilhada entre producao.js (visão por campo) e campo.js (visão por
// projeto) — os dois calculam a mesma série mensal a partir de data/
// producao.json, só mudam o que mostram em cima dela.

const MESES_PT = [
  '', 'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];
const MES_ABREV = ['', 'jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

const METRIC_KEYS = ['oleoPreSalBbld', 'oleoPosSalBbld', 'gasPreSalMm3d', 'gasPosSalMm3d', 'boedPreSal', 'boedPosSal'];

// Campo-base do boletim da ANP de cada projeto rastreado com produção
// própria — casado por SUBSTRING contra as chaves de data/producao.json
// (nome do campo como a ANP publica), não por igualdade exata. Motivo: a
// granularidade da tabela varia por edição do boletim — meses mais
// recentes trazem só "Atapu", outros trazem "Atapu" + "Oeste de Atapu" +
// "Anc_Norte_Atapu" (Área Não Contratada) como linhas separadas da MESMA
// jazida/contrato (confirmado pela ligação de poço->campo já usada no
// roadmap, ver contractOwnWells acima: poços de Atapu citam "Atapu /
// Atapu_Eco / Anc_Norte_Atapu / Oeste De Atapu" juntos). Casar por
// substring soma essas sub-áreas automaticamente em qualquer mês, sem
// precisar listar cada variante à mão. Norte de Carcará é o único caso
// que soma duas jazidas por nome DIFERENTE ("Bacalhau Norte", dentro do
// CPP rastreado aqui, + "Bacalhau", Concessão anterior e fora dele) — "
// Bacalhau" como base já casa as duas por conter a substring, mesmo
// critério já usado no roadmap para "Poços Perfurados" desse contrato. Os
// demais projetos em produção (Libra) não têm campo próprio no boletim —
// a produção de Libra/Mero sai inteira sob "Mero".
const PROJECT_FIELD_BASE = {
  'Búzios': 'Búzios',
  'Mero': 'Mero',
  'Itapu': 'Itapu',
  'Sépia': 'Sépia',
  'Atapu': 'Atapu',
  'Entorno de Sapinhoá': 'Sapinhoá',
  'Norte de Carcará': 'Bacalhau',
};

const UNITS = {
  oleo: { label: 'Petróleo (bbl/d)', key: 'oleoPreSalBbld', fmt: (n) => fmtNum(n) + ' bbl/d' },
  gas: { label: 'Gás natural (Mm³/d)', key: 'gasPreSalMm3d', fmt: (n) => fmtNum(n, { maximumFractionDigits: 1 }) + ' Mm³/d' },
  boe: { label: 'Produção (boe/d)', key: 'boedPreSal', fmt: (n) => fmtNum(n) + ' boe/d' },
  rgo: { label: 'RGO (m³/m³)', key: 'rgo', fmt: (n) => fmtNum(n) + ' m³/m³' },
  // Água/gás injetado por campo (data/producao_injecao.json, ver
  // scripts/parse_producao_injecao.py) — mesmo createLineChart dos
  // gráficos de produção/RGO, só troca a chave/rótulo; usado só em
  // campo.js (buildUnitSwitch(..., ['agua','gasInj'])), não aparece nos
  // outros gráficos porque eles passam sua própria lista de chaves.
  agua: { label: 'Água injetada (m³/d)', key: 'aguaInjM3d', fmt: (n) => fmtNum(n) + ' m³/d' },
  gasInj: { label: 'Gás injetado (Mil m³/d)', key: 'gasInjMm3d', fmt: (n) => fmtNum(n, { maximumFractionDigits: 1 }) + ' Mil m³/d' },
};

function emptyMetrics() {
  const m = {};
  for (const k of METRIC_KEYS) m[k] = 0;
  return m;
}

// RGO (Razão Gás-Óleo) = volume de gás produzido / volume de óleo
// produzido, os dois em m³ — mesma unidade que a indústria usa pra
// caracterizar um campo (Búzios ~270 m³/m³, por exemplo). O boletim vem
// em bbl/d (óleo) e "Mm³/d" (gás) — aqui "M" é "mil" (milhares de m³/dia),
// não "mega" (milhões): dá pra confirmar pelo total do pré-sal no
// boletim (~150 mil m³/d em dez/2025) — se fosse milhão, seria mais gás
// só no pré-sal brasileiro do que o mundo inteiro produz. Por isso o
// fator aqui é ×1.000 (não ×1.000.000) pra converter gás pra m³/d puro;
// óleo usa a conversão padrão de 1 bbl = 0,158987 m³. Sempre calculado a
// partir dos volumes JÁ somados (nunca soma/média de RGO direto — RGO é
// uma razão, não dá pra somar razão entre campos ou meses).
const BBL_TO_M3 = 0.158987;
function computeRGO(oleoBbld, gasMm3d) {
  const oleoM3 = oleoBbld * BBL_TO_M3;
  if (oleoM3 <= 0) return 0;
  return (gasMm3d * 1000) / oleoM3;
}

// Fusão de campo de CONTEXTO fragmentado em mais de uma linha pelo próprio
// boletim — mesma ideia de "a jazida inteira é o que importa acompanhar"
// já usada em PROJECT_FIELD_BASE (contratos rastreados), aqui por
// igualdade de nome já normalizado (ver scripts/producao_common.py
// normalize_field_name — data/producao.json já chega limpo de sufixo de
// regime/nota de rodapé, então essa função só cuida de fusão de JAZIDA,
// não de variação de grafia):
//   - "Anc_X" (Área Não Contratada) funde no campo "X" (primeiro pedaço
//     depois de "Anc_") — mesmo padrão já usado pra Anc_Norte_Atapu/
//     Anc_Mero nos contratos rastreados (esses dois já caem no contrato
//     certo por substring, antes de chegar aqui) — só quando "X" já é
//     nome de outro campo em ALGUM mês do boletim inteiro (não só do mês
//     sendo processado agora: "Tupi" e "Anc_Tupi" nem sempre aparecem
//     juntos no mesmo mês — de jan/2024 a jun/2025 o boletim só lista
//     "Anc_Tupi", sem "Tupi" separado naquele período — então o alvo
//     precisa vir do conjunto de nomes de TODO o histórico, ver
//     allFieldNames, senão "Anc_Tupi" vira linha própria só nesses meses).
//     Sem alvo confirmado em nenhum mês (ex.: Anc_Brava/Anc_Forno, sem
//     campo "Brava"/"Forno" avulso no boletim inteiro), fica como está.
//   - Sul de Berbigão funde em Berbigão — mesmo PD (berbigao.pdf,
//     "Berbigão, Norte de Berbigão e Sul de Berbigão 2025" em data/
//     planos_desenvolvimento.json), Sul de Tupi NÃO funde em Tupi (PD
//     próprio, sul-de-lula.pdf — campo satélite diferente, só o nome
//     mudou junto quando Lula virou Tupi em 2019, ver normalize_field_name).
const CONTEXT_JAZIDA_ALIAS = {
  'Sul de Berbigão': 'Berbigão',
};
function contextJazidaBase(name, knownNames) {
  if (CONTEXT_JAZIDA_ALIAS[name]) return CONTEXT_JAZIDA_ALIAS[name];
  if (name.startsWith('Anc_')) {
    const base = name.slice(4).split('_')[0];
    if (knownNames.has(base)) return base;
  }
  return name;
}

// Nomes de campo (já normalizados, ver data/producao.json) vistos em
// QUALQUER mês do boletim — usado por contextJazidaBase pra achar o alvo
// de fusão de um "Anc_X" mesmo em meses onde "X" não aparece sozinho.
function allFieldNames(meses) {
  const names = new Set();
  for (const mes of meses) {
    for (const nome of Object.keys(mes.campos)) names.add(nome);
  }
  return names;
}

// Um projeto rastreado por campo-base (soma por substring, ver
// PROJECT_FIELD_BASE) mapeado; os demais campos do boletim (Tupi,
// Berbigão, Jubarte, Lapa...) entram como contexto — mesmo campo pré-sal,
// mas fora dos 30 contratos de partilha rastreados neste app
// (Concessão/Cessão Onerosa sem CPP próprio nesta lista), com fusão por
// jazida (ver contextJazidaBase) quando o próprio boletim traz mais de um
// nome pra mesma jazida. "campos" tem o mesmo formato num mês só (data/
// producao.json) ou já com métricas médias de um ano — esta função não
// distingue os dois.
function computeFieldRows(campos, projects, knownNames) {
  const usedFieldNames = new Set();
  const rows = [];

  for (const p of projects) {
    const base = PROJECT_FIELD_BASE[p.name];
    if (!base) continue;
    const parts = Object.keys(campos).filter((n) => n.includes(base)).map((n) => ({ nome: n, dados: campos[n] }));
    if (!parts.length) continue;
    parts.forEach((part) => usedFieldNames.add(part.nome));
    const sum = emptyMetrics();
    for (const part of parts) {
      for (const k of METRIC_KEYS) sum[k] += part.dados[k];
    }
    rows.push({
      name: projectDisplayName(p.name),
      color: p.color,
      isContract: true,
      parts,
      ...sum,
      rgo: computeRGO(sum.oleoPreSalBbld, sum.gasPreSalMm3d),
    });
  }

  const contextGroups = new Map();
  for (const [nome, dados] of Object.entries(campos)) {
    if (usedFieldNames.has(nome)) continue;
    const jazida = contextJazidaBase(nome, knownNames);
    if (!contextGroups.has(jazida)) contextGroups.set(jazida, []);
    contextGroups.get(jazida).push({ nome, dados });
  }
  for (const [jazida, parts] of contextGroups) {
    // Um grupo com UM SÓ pedaço, e esse pedaço é só a Área Não Contratada
    // ("Anc_X", renomeada pra "X" por contextJazidaBase) sem o campo "X"
    // em si nem nenhuma outra sub-área junto: a ANC sozinha é sempre só
    // uma fração do campo (por definição, é a parte FORA do contrato) —
    // um mês assim não tem o total do campo publicado no boletim, só esse
    // fragmento. Mostrar isso com o nome do campo inteiro ("Tupi") daria
    // a impressão de produção quase zero num mês em que na verdade o
    // boletim simplesmente não trouxe o total — melhor não ter o ponto
    // nesse mês (linha corta ali, ver buildSegments) do que ter um
    // número enganoso.
    if (parts.length === 1 && parts[0].nome.toLowerCase().startsWith('anc_') && jazida !== parts[0].nome) {
      continue;
    }
    const sum = emptyMetrics();
    for (const part of parts) {
      for (const k of METRIC_KEYS) sum[k] += part.dados[k];
    }
    rows.push({
      name: jazida,
      color: CONTEXT_FIELD_COLOR,
      isContract: false,
      parts,
      ...sum,
      rgo: computeRGO(sum.oleoPreSalBbld, sum.gasPreSalMm3d),
    });
  }

  return rows;
}

// Campo de contexto (fora dos 7 rastreados) que nunca passou de 50 mil
// bbl/d de petróleo pré-sal em NENHUM mês do histórico inteiro vira uma
// linha cinza só, "Campos menores", somando todos esses juntos por mês —
// evita 20+ linhas minúsculas disputando espaço com as grandes. O corte
// usa sempre petróleo (bbl/d) e o máximo do campo em TODO o período, não
// o valor do mês nem a unidade escolhida no momento (gás/boe/RGO) — sem
// isso um campo trocaria de grupo (linha própria ↔ "Campos menores") só
// por variar de mês pra mês perto do limiar, ou ao trocar de aba de
// unidade, o que quebraria a cor/posição na legenda entre uma visita e
// outra.
const SMALL_FIELD_THRESHOLD_BBLD = 50000;
const SMALL_FIELDS_LABEL = 'Campos menores';
function groupSmallContextFields(monthlySeries) {
  const maxOleo = new Map();
  for (const m of monthlySeries) {
    for (const r of m.rows) {
      if (r.isContract) continue;
      maxOleo.set(r.name, Math.max(maxOleo.get(r.name) || 0, r.oleoPreSalBbld));
    }
  }
  const smallNames = new Set([...maxOleo.entries()].filter(([, v]) => v < SMALL_FIELD_THRESHOLD_BBLD).map(([k]) => k));
  if (!smallNames.size) return monthlySeries;

  return monthlySeries.map((m) => {
    const kept = m.rows.filter((r) => r.isContract || !smallNames.has(r.name));
    const smallRows = m.rows.filter((r) => !r.isContract && smallNames.has(r.name));
    if (!smallRows.length) return { ...m, rows: kept };
    const sum = emptyMetrics();
    for (const r of smallRows) {
      for (const k of METRIC_KEYS) sum[k] += r[k];
    }
    kept.push({
      name: SMALL_FIELDS_LABEL,
      color: CONTEXT_FIELD_COLOR,
      isContract: false,
      parts: smallRows.flatMap((r) => r.parts),
      ...sum,
      rgo: computeRGO(sum.oleoPreSalBbld, sum.gasPreSalMm3d),
    });
    return { ...m, rows: kept };
  });
}

// "produção diária por mês" — sem agregação nenhuma: um ponto por mês do
// boletim, com o valor exatamente como a ANP publicou naquele mês (bbl/d,
// Mm³/d ou boe/d — já é uma vazão diária, não precisa converter nada).
// Campos de contexto (fora dos 7 contratos rastreados) ficam SEPARADOS,
// uma linha por campo (agrupados em "Campos menores" quando pequenos, ver
// groupSmallContextFields), cada um com cor própria (hash do nome, ver
// colorForCompany acima — não é cor de marca, só um jeito determinístico
// de dar uma cor distinta pra cada nome sem expandir a paleta).
function computeMonthlySeries(meses, projects) {
  const knownNames = allFieldNames(meses);
  const raw = meses.map((mes) => {
    const rows = computeFieldRows(mes.campos, projects, knownNames).map((r) => (
      r.isContract ? r : { ...r, color: colorForCompany(r.name) }
    ));
    return { ano: mes.ano, mes: mes.mes, rows };
  });
  return groupSmallContextFields(raw);
}

/* ---------------------- Gráfico de linhas (produção/RGO) ------------------ */
// Uma linha por campo — eixo x é o mês do boletim, eixo y é a vazão diária
// na unidade escolhida. Interativo:
//  - roda do mouse sobre a área do gráfico: zoom no tempo (eixo x),
//    ancorado no cursor; sobre os números do eixo vertical: zoom só no
//    eixo y (base sempre 0, só o teto visível muda);
//  - arrastar: move a janela visível (eixo x) — só depois de já ter dado
//    zoom, com pointer capture pra continuar seguindo o cursor fora da
//    área do gráfico durante o arraste;
//  - clicar num campo na legenda: isola aquela linha (as outras ficam
//    esmaecidas) — clicar de novo no mesmo campo, ou num campo diferente,
//    troca/limpa o isolamento;
//  - passar o mouse sobre o gráfico: mostra o valor de TODOS os campos
//    daquele mês de uma vez (não só o campo sob o cursor), com uma linha
//    vertical marcando o mês.
// Compartilhado entre producao.js (todos os campos) e campo.js (só o
// projeto selecionado, monthlySeries com uma linha só).

const LINE_W = 900;
const LINE_H = 460;
const LINE_MARGIN = { top: 16, right: 16, bottom: 62, left: 64 };
const MIN_VIEW_SPAN = 2; // menor janela de zoom, em nº de meses - 1

// Escala do eixo Y dos gráficos de produção (createLineChart/buildComboChart)
// ancorada no ÚLTIMO valor da série, não no pico histórico — produção
// normalmente sobe com o tempo (ramp-up de FPSO), então ancorar no nível
// atual evita sobra de espaço vazio por causa de um pico antigo bem maior
// que a produção de hoje. Arredonda pro próximo múltiplo de uma unidade
// proporcional à magnitude do valor (1/10 da potência de 10 abaixo dele,
// nunca menor que 100) — não um múltiplo de 100 fixo, que pra valores na
// casa do milhão (soma de vários campos) mal se notava, nem a escala
// 1-2-5-10 "solta" de uma escala genérica, que dobrava o teto e desperdiçava
// metade do gráfico. Um valor ~1.000.000 vira múltiplo de 100.000 (centena
// de milhar); ~5.000 vira múltiplo de 100; ~300 (RGO) fica em 100 — sempre
// perto o bastante do dado real pra ler como "zoom nele", não uma escala
// genérica qualquer.
function niceMaxFromLastValue(lastValue) {
  if (lastValue <= 0) return 100;
  const unit = Math.max(100, Math.pow(10, Math.floor(Math.log10(lastValue)) - 1));
  return Math.ceil(lastValue / unit) * unit;
}

// Ordem fixa das linhas (mesma cor sempre no mesmo campo entre trocas de
// unidade) — projeto rastreado por ordem de aparição em state.projects
// (mesma ordem do roadmap/análises), depois os campos de contexto por
// ordem de primeira aparição no boletim.
function seriesOrder(monthlySeries) {
  const seen = new Map();
  for (const m of monthlySeries) {
    for (const r of m.rows) {
      if (!seen.has(r.name)) seen.set(r.name, r);
    }
  }
  const names = [...seen.keys()];
  const contract = names.filter((n) => seen.get(n).isContract);
  const context = names.filter((n) => !seen.get(n).isContract);
  return [...contract, ...context];
}

// Quebra os pontos de uma série em trechos contínuos, cortando onde o mês
// não tem dado (campo de contexto que só aparece em algumas edições, ver
// nota em computeMonthlySeries) — sem isso um <polyline> ligaria os dois
// lados do buraco com uma reta enganosa.
function buildSegments(monthlySeries, loIdx, hiIdx, name, xAt, yAt, unitKey) {
  const segments = [];
  let current = [];
  for (let i = loIdx; i <= hiIdx; i++) {
    const r = monthlySeries[i].rows.find((row) => row.name === name);
    if (!r) {
      if (current.length) segments.push(current);
      current = [];
      continue;
    }
    current.push(`${xAt(i)},${yAt(r[unitKey])}`);
  }
  if (current.length) segments.push(current);
  return segments;
}

// Posição contínua (índice fracionário, mesma escala que xAt/idxAt em
// createLineChart) de uma data ISO dentro de monthlySeries — usada pelos
// marcadores de FPSO/poço (ver markers em createLineChart), que têm data
// exata (dia), não só mês. Interpola linearmente pelo número de dias
// corridos entre o 1º dia do primeiro mês da série e o 1º dia do último,
// ignorando os poucos meses sem boletim no meio do período (ver nota em
// buildEvolutionSection/producao.js — gap raro, a distorção de posição
// que isso causa é pequena demais pra valer o custo de contornar). Pode
// vir fora de [0, n-1] (data antes/depois do período coberto pelo
// gráfico) — quem chama decide se corta ou não.
function dateToContinuousIndex(monthlySeries, isoDate) {
  const first = monthlySeries[0];
  const last = monthlySeries[monthlySeries.length - 1];
  const firstDate = new Date(Date.UTC(first.ano, first.mes - 1, 1));
  const lastDate = new Date(Date.UTC(last.ano, last.mes - 1, 1));
  const totalDays = diffDays(firstDate, lastDate);
  if (totalDays <= 0) return 0;
  const targetDays = diffDays(firstDate, parseDate(isoDate));
  return (targetDays / totalDays) * (monthlySeries.length - 1);
}

// Marcadores opcionais desenhados JUNTO com o gráfico de linha (não por
// cima, via CSS/HTML — precisam acompanhar pan/zoom exatamente como as
// linhas, então entram no mesmo viewBox/redraw de createLineChart) — hoje
// só usados por campo.js na "Produção mensal" de um projeto (produao.js,
// com vários campos na mesma linha do tempo, não passa isso). Desenhados
// EM CIMA da própria linha de dados (não numa faixa à parte): a posição Y
// de cada marcador é o valor da série naquela data (interpolado entre os
// dois pontos vizinhos, ver valueAt dentro de draw()), não uma altura
// fixa — então sobe e desce acompanhando a curva.
//   - fpsos: [{date:'AAAA-MM-DD', name}] — marcos tipo 'fpso' do roadmap
//     do projeto (ver fpsoMilestonesOf em campo.js).
//   - wells: [poço da base ANP/BDEP, mesmo formato de data/pocos.json,
//     precisa de w.d pra posicionar] — ícone de categoria (WELL_SHAPES)
//     bem pequeno.
// Sem markers (chamada de producao.js, ou de campo.js pro gráfico de
// RGO), tudo aqui cai pra array vazio e nada muda no desenho.
//   - refLines: [{value, label}] opcional — 0+ linhas horizontais
//     tracejadas constantes (ex.: pico histórico e potencial máximo/
//     capacidade nominal de um FPSO, ver buildWellProductionChart em
//     campo.js), sempre incluídas no cálculo do teto automático (ver
//     autoMax abaixo) pra já nascerem visíveis na visão "Ver tudo", sem
//     exigir zoom manual em y.
//   - stacked: true opcional — em vez de uma linha por série no MESMO
//     valor (padrão), empilha: cada série desenha no topo da soma de
//     todas as anteriores (mesma ordem de `order`/legenda), com a área
//     entre a própria linha e a da série anterior preenchida com a cor
//     dela — a linha mais alta é sempre o total agregado. Usado só pro
//     gráfico de poço-por-FPSO (campo.js): mantém uma cor/linha por poço,
//     mas a leitura principal é "quanto no total, e quanto cada poço
//     contribui" em vez de comparar poços lado a lado na mesma escala.
//     Mês sem produção de uma série conta como 0 na pilha (não quebra a
//     linha em segmentos como o modo normal — buildSegments só é usado
//     fora do modo empilhado).
//   - onSeriesClick: callback(name) opcional — quando presente, um clique
//     na legenda NÃO faz o isolamento interno sozinho (ver legendGroup
//     abaixo): só chama onSeriesClick(name) e espera quem chamou decidir
//     e devolver o estado resolvido via setHighlight (retornado no fim),
//     em vez do toggle "highlighted === name ? null : name" de sempre.
//     Existe pra ligar a legenda a um estado externo compartilhado (ex.:
//     seleção de poço também usada pelo mini-mapa em campo.js) sem
//     duplicar/dessincronizar o toggle em dois lugares. Sem esse
//     callback, a legenda continua se isolando sozinha, como sempre.
function createLineChart(container, monthlySeries, markers, initialUnitKey, refLines, stacked, onSeriesClick) {
  const n = monthlySeries.length;
  const order = seriesOrder(monthlySeries);
  const meta = new Map(order.map((name) => {
    const sample = monthlySeries.map((m) => m.rows.find((r) => r.name === name)).find(Boolean);
    return [name, { color: sample.color, isContract: sample.isContract }];
  }));
  const fpsoMarkers = (markers && markers.fpsos) || [];
  const wellMarkers = (markers && markers.wells) || [];
  // Cor dos dois: a mesma da própria série (cor do projeto, no caso de uso
  // real — gráfico de um campo só, ver campo.js), mesmos ícones/cor do
  // mapa principal (WELL_SHAPES/wellDivIcon coloridos pelo projeto, ver
  // mapa.js) — FPSO ACIMA da linha, poço ABAIXO (ver fpsoSvg/wellSvg
  // abaixo), então não colidem com o próprio traço mesmo usando a mesma
  // cor dele.
  const markerColor = order.length ? meta.get(order[0]).color : '#e8eaed';

  let unitKey = initialUnitKey || 'oleo';
  let viewStart = 0;
  let viewEnd = n - 1;
  let yMaxOverride = null; // null = auto-ajusta ao máximo visível (ver draw)
  let highlighted = null;
  // Ano marcado externamente (ver setHighlightYear no retorno, e o filtro
  // de ano do mini-mapa em campo.js — arrastar o slider ali chama isso
  // aqui, ligando "até que ano os poços aparecem no mapa" com "onde esse
  // ano cai no gráfico de produção/RGO"). null = nenhuma marca (padrão,
  // gráfico sem esse recurso — producao.js nunca chama setHighlightYear).
  let highlightYear = null;
  // Estado do arraste (pan) precisa sobreviver a um redraw no meio do
  // próprio arraste — draw() troca svgWrap.innerHTML a cada pointermove
  // durante o drag, o que recria #lc-capture do zero e derruba a captura
  // de ponteiro do elemento antigo (removido do DOM). Por isso mora aqui
  // fora, não redeclarado dentro de draw(): dragPointerId é reusado logo
  // depois de cada redraw pra recapturar o ponteiro no elemento novo (ver
  // final de draw()), e um pointerup/pointercancel na window (não só no
  // elemento de captura, que pode já ter sido trocado) garante que
  // isDragging sempre volta a false, mesmo se a recaptura falhar.
  let isDragging = false;
  let dragPointerId = null;
  let dragStartClientX = 0;
  let dragStartView = [0, 0];
  window.addEventListener('pointerup', () => { isDragging = false; dragPointerId = null; });
  window.addEventListener('pointercancel', () => { isDragging = false; dragPointerId = null; });

  const svgWrap = document.createElement('div');
  svgWrap.className = 'line-chart-wrap';
  svgWrap.style.position = 'relative';
  const legendWrap = document.createElement('div');
  legendWrap.style.marginTop = '10px';

  function clampView(start, end) {
    let span = Math.max(end - start, MIN_VIEW_SPAN);
    span = Math.min(span, n - 1);
    if (start < 0) { start = 0; end = start + span; }
    if (end > n - 1) { end = n - 1; start = end - span; }
    return [start, end];
  }

  function draw() {
    const unit = UNITS[unitKey];
    const plotW = LINE_W - LINE_MARGIN.left - LINE_MARGIN.right;
    const plotH = LINE_H - LINE_MARGIN.top - LINE_MARGIN.bottom;
    const span = Math.max(viewEnd - viewStart, 0.001);
    const xAt = (i) => LINE_MARGIN.left + ((i - viewStart) / span) * plotW;
    const idxAt = (px) => viewStart + ((px - LINE_MARGIN.left) / plotW) * span;
    const loIdx = Math.max(0, Math.floor(viewStart));
    const hiIdx = Math.min(n - 1, Math.ceil(viewEnd));

    // rawMax (pico da janela visível) alimenta o piso do zoom manual em y
    // logo abaixo (wheel sobre o eixo) E funciona de segurança da escala
    // automática, que normalmente ancora no último valor visível, não no
    // pico (ver niceMaxFromLastValue) — usar só o último valor deixava
    // clipada uma série com um pico ANTIGO maior que o nível atual dentro
    // da própria janela visível (ex.: Tupi bem mais alto em dez/2019 do
    // que hoje — o teto calculado só pelo último mês ficava abaixo desse
    // pico, cortando a linha no topo do gráfico). Math.max com rawMax
    // garante que o pico realmente visível nunca fica maior que o teto,
    // sem abrir mão de ancorar no último valor no caso comum (produção
    // subindo com o tempo, onde o último valor já É o maior da janela).
    // stacked: o "pico da janela" e o "último valor" são da PILHA inteira
    // (soma de todas as séries naquele mês), não do maior valor individual
    // — é a altura total (linha mais alta) que precisa caber no teto, não
    // a série isolada mais alta.
    let rawMax = 0;
    for (let i = loIdx; i <= hiIdx; i++) {
      if (stacked) {
        let sum = 0;
        for (const r of monthlySeries[i].rows) sum += r[unit.key] || 0;
        rawMax = Math.max(rawMax, sum);
      } else {
        for (const r of monthlySeries[i].rows) rawMax = Math.max(rawMax, r[unit.key]);
      }
    }
    let lastMax = 0;
    if (stacked) {
      for (const r of monthlySeries[hiIdx].rows) lastMax += r[unit.key] || 0;
    } else {
      for (const r of monthlySeries[hiIdx].rows) lastMax = Math.max(lastMax, r[unit.key]);
    }
    const refLineValues = (refLines || []).map((r) => r.value).filter((v) => v != null);
    // Com refLines (pico/potencial máximo, ver buildWellProductionChart em
    // campo.js): o teto do eixo y é só o maior desses dois valores, não o
    // pico/último valor da janela VISÍVEL — fixo relativo à capacidade da
    // instalação, não reencolhe/expande sozinho quando o usuário dá zoom
    // em x pra um período de produção mais baixa (diferente do gráfico sem
    // refLines, que continua ancorando no que está visível agora).
    const autoMax = refLineValues.length
      ? niceMaxFromLastValue(Math.max(...refLineValues))
      : niceMaxFromLastValue(Math.max(lastMax, rawMax));
    // yMaxOverride persiste entre trocas de unidade/pan/zoom em x até o
    // usuário resetar ("Ver tudo") — dar zoom em x não desfaz um zoom em y
    // já ajustado, e vice-versa (são eixos independentes).
    const maxVal = yMaxOverride !== null ? yMaxOverride : autoMax;
    const yAt = (v) => LINE_MARGIN.top + plotH - (v / maxVal) * plotH;

    const yTicks = 5;
    let gridSvg = '';
    for (let i = 0; i <= yTicks; i++) {
      const v = (maxVal / yTicks) * i;
      const y = yAt(v);
      gridSvg += `<line x1="${LINE_MARGIN.left}" y1="${y}" x2="${LINE_W - LINE_MARGIN.right}" y2="${y}" stroke="var(--border)" stroke-width="1" />`;
      gridSvg += `<text x="${LINE_MARGIN.left - 10}" y="${y + 4}" text-anchor="end" font-size="11" style="fill:var(--text-faint)">${fmtNum(v)}</text>`;
    }

    // Rótulo do eixo x: se a janela visível já é curta (zoom), rotula todo
    // mês visível; senão só janeiro de cada ano (+ o último mês) — mesmo
    // motivo de antes (>100 pontos no zoom "tudo" ficaria ilegível mês a
    // mês), mas dando zoom o usuário já pediu pra ver o detalhe mensal.
    const dense = span <= 15;
    let xLabelsSvg = '';
    for (let i = loIdx; i <= hiIdx; i++) {
      const m = monthlySeries[i];
      const isLast = i === n - 1;
      if (!dense && m.mes !== 1 && !isLast) continue;
      const x = xAt(i);
      const label = (!dense && m.mes === 1) ? String(m.ano) : `${MES_ABREV[m.mes]}/${String(m.ano).slice(2)}`;
      const y = LINE_MARGIN.top + plotH + 14;
      if (!dense && m.mes === 1) {
        xLabelsSvg += `<line x1="${x}" y1="${LINE_MARGIN.top}" x2="${x}" y2="${LINE_MARGIN.top + plotH}" stroke="var(--border)" stroke-width="1" stroke-dasharray="2,3" />`;
      }
      xLabelsSvg += `<text x="0" y="0" transform="translate(${x} ${y}) rotate(-45)" text-anchor="end" font-size="${dense ? 10 : 11}" style="fill:var(--text-muted)">${escapeHtml(label)}</text>`;
    }

    let linesSvg = '';
    let areaSvg = '';
    const dotR = span > 40 ? 1.6 : span > 15 ? 2.2 : 3;
    if (stacked) {
      // cumBefore[k] = altura acumulada das séries ANTERIORES no índice
      // visível k (0 na primeira série) — cresce a cada volta do loop;
      // cumAfter[k] = cumBefore[k] + valor da série atual = topo da banda
      // dela, e também a base da PRÓXIMA série. Índice por posição na
      // janela visível (loIdx..hiIdx), não por mês do ano inteiro.
      const idxs = [];
      for (let i = loIdx; i <= hiIdx; i++) idxs.push(i);
      const rowsByIdx = idxs.map((i) => {
        const map = new Map();
        for (const r of monthlySeries[i].rows) map.set(r.name, r[unit.key] || 0);
        return map;
      });
      let cumBefore = idxs.map(() => 0);
      for (const name of order) {
        const { color } = meta.get(name);
        const dimmed = highlighted && highlighted !== name;
        const lineOpacity = dimmed ? 0.12 : 1;
        const areaOpacity = dimmed ? 0.05 : 0.5;
        const width = highlighted === name ? 2.5 : 1.5;
        const basePts = idxs.map((i, k) => `${xAt(i)},${yAt(cumBefore[k])}`);
        const cumAfter = idxs.map((i, k) => cumBefore[k] + (rowsByIdx[k].get(name) || 0));
        const topPts = idxs.map((i, k) => `${xAt(i)},${yAt(cumAfter[k])}`);
        const polygonPts = [...topPts, ...[...basePts].reverse()].join(' ');
        areaSvg += `<polygon points="${polygonPts}" fill="${color}" opacity="${areaOpacity}" data-series="${escapeHtml(name)}" />`;
        linesSvg += `<polyline points="${topPts.join(' ')}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round" opacity="${lineOpacity}" data-series="${escapeHtml(name)}" />`;
        cumBefore = cumAfter;
      }
    } else {
      for (const name of order) {
        const { color, isContract } = meta.get(name);
        const dimmed = highlighted && highlighted !== name;
        const opacity = dimmed ? 0.12 : 1;
        const width = highlighted === name ? 3 : 2;
        const segments = buildSegments(monthlySeries, loIdx, hiIdx, name, xAt, yAt, unit.key);
        for (const seg of segments) {
          linesSvg += `<polyline points="${seg.join(' ')}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round" opacity="${opacity}" data-series="${escapeHtml(name)}" />`;
          if (seg.length === 1) {
            const [px, py] = seg[0].split(',');
            linesSvg += `<circle cx="${px}" cy="${py}" r="${dotR}" fill="${color}" opacity="${opacity}" />`;
          }
        }
        void isContract;
      }
    }

    const axisSvg = `<line x1="${LINE_MARGIN.left}" y1="${LINE_MARGIN.top + plotH}" x2="${LINE_W - LINE_MARGIN.right}" y2="${LINE_MARGIN.top + plotH}" stroke="var(--border-strong)" stroke-width="1" />`;
    const captureSvg = `<rect id="lc-capture" x="${LINE_MARGIN.left}" y="${LINE_MARGIN.top}" width="${plotW}" height="${plotH}" fill="transparent" style="cursor:crosshair" />`;
    // Faixa invisível sobre os rótulos do eixo y — só pra indicar com o
    // cursor (ns-resize) que rolar o mouse ali zoom o eixo y, não o x; o
    // zoom em si é tratado no wheel handler abaixo (checa a posição do
    // cursor, não depende de qual elemento recebeu o evento).
    const yAxisHintSvg = `<rect x="0" y="${LINE_MARGIN.top}" width="${LINE_MARGIN.left}" height="${plotH}" fill="transparent" style="cursor:ns-resize" />`;
    const crosshairSvg = `<line id="lc-crosshair" x1="0" y1="${LINE_MARGIN.top}" x2="0" y2="${LINE_MARGIN.top + plotH}" stroke="var(--text-faint)" stroke-width="1" hidden />`;

    // Valor da série na posição fracionária idxFrac (interpola entre os
    // dois meses vizinhos) — pra ancorar os marcadores de FPSO/poço na
    // altura da própria linha ali (ver fpsoSvg/wellSvg abaixo: poço um
    // tanto ABAIXO desse valor, FPSO um tanto ACIMA, não em cima do
    // traço). Só faz sentido com uma série só (o uso real é o gráfico de
    // um projeto em campo.js, nunca o de vários campos de producao.js) —
    // com mais de uma linha pega a primeira (rows[0]); markers não são
    // usados nesse outro caso mesmo.
    function valueAt(idxFrac) {
      const i0 = Math.max(0, Math.min(n - 1, Math.floor(idxFrac)));
      const i1 = Math.min(n - 1, i0 + 1);
      const r0 = monthlySeries[i0].rows[0];
      const r1 = monthlySeries[i1].rows[0];
      if (!r0 && !r1) return null;
      if (!r0) return r1[unit.key];
      if (!r1) return r0[unit.key];
      return r0[unit.key] + (r1[unit.key] - r0[unit.key]) * (idxFrac - i0);
    }

    // Marcadores de FPSO (acima da linha) e poço (abaixo), ancorados no x
    // = data e y = valor interpolado da série ali (ver valueAt) mais um
    // deslocamento vertical fixo pra não tampar o próprio traço — só o
    // que cai dentro da janela visível atual (loIdx/hiIdx, respeitando
    // zoom/pan) e onde a série realmente tem dado (valueAt null = mês sem
    // produção registrada, sem onde ancorar o ícone). Mesmos ícones de
    // poço do mapa completo (WELL_SHAPES, coloridos pelo projeto — ver
    // wellDivIcon em mapa.js). <title> nativo no lugar do tooltip rico
    // (crosshair já cobre esse papel pros dados da linha): elementos
    // estáticos por redraw, sem handler próprio de hover, mais simples
    // que replicar ensureTooltip aqui.
    let wellSvg = '';
    for (const w of wellMarkers) {
      if (!w.d) continue;
      const idx = dateToContinuousIndex(monthlySeries, w.d);
      if (idx < loIdx - 0.5 || idx > hiIdx + 0.5) continue;
      const val = valueAt(idx);
      if (val == null) continue;
      const x = xAt(idx);
      const size = 7;
      const y = yAt(val) + size;
      const shape = WELL_SHAPES[wellCategory(w)] || WELL_SHAPES.indefinido;
      wellSvg += `<svg x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}" viewBox="0 0 16 16"><title>${escapeHtml(w.n)} — ${formatBR(w.d)}</title>${shape(markerColor)}</svg>`;
    }
    let fpsoSvg = '';
    for (const fp of fpsoMarkers) {
      const idx = dateToContinuousIndex(monthlySeries, fp.date);
      if (idx < loIdx - 0.5 || idx > hiIdx + 0.5) continue;
      const val = valueAt(idx);
      if (val == null) continue;
      const x = xAt(idx);
      const size = 13;
      const y = yAt(val) - size;
      fpsoSvg += `<svg x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}" viewBox="0 0 16 16" style="overflow:visible"><title>${escapeHtml(fp.name)} — ${formatBR(fp.date)}</title>${fpsoIconSVG(markerColor)}</svg>`;
    }

    // Marca de ano externa (ver setHighlightYear no retorno) — linha
    // vertical sólida (não o crosshair cinza fino de hover) em 31/dez do
    // ano marcado, com uma bandeirinha do ano no topo, mesmo padrão visual
    // da linha de "hoje" do roadmap principal (ver .today-line/.today-flag
    // em style.css, mas aqui dentro do próprio SVG do gráfico). Só
    // desenha se cair dentro da janela visível atual (zoom/pan).
    let highlightSvg = '';
    if (highlightYear != null) {
      const idx = dateToContinuousIndex(monthlySeries, `${highlightYear}-12-31`);
      if (idx >= loIdx - 0.5 && idx <= hiIdx + 0.5) {
        const x = xAt(idx);
        highlightSvg = `<g>
          <line x1="${x}" y1="${LINE_MARGIN.top}" x2="${x}" y2="${LINE_MARGIN.top + plotH}" stroke="var(--today)" stroke-width="1.5" stroke-dasharray="4,3" />
          <rect x="${x - 16}" y="${LINE_MARGIN.top - 14}" width="32" height="14" rx="3" fill="var(--today)" />
          <text x="${x}" y="${LINE_MARGIN.top - 4}" text-anchor="middle" font-size="10" font-weight="700" fill="#fff">${highlightYear}</text>
        </g>`;
      }
    }

    // Linhas horizontais constantes (ver refLines no topo da função) —
    // ex.: pico histórico + potencial máximo/capacidade nominal de um
    // FPSO, sempre dentro do teto automático (ver autoMax acima), mas
    // pode sair da área visível com um zoom manual em y (yMaxOverride) só
    // pra baixo desse valor: nesse caso não desenha essa linha, em vez de
    // vazar pra fora da área de plotagem. Rótulo de cada uma alternando
    // acima/abaixo do traço (índice par/ímpar) pra não empilhar texto em
    // cima de texto quando duas linhas ficam próximas (ex.: pico bem perto
    // do potencial máximo, plataforma quase no limite).
    let refLineSvg = '';
    (refLines || []).forEach((rl, idx) => {
      if (rl.value == null) return;
      const y = yAt(rl.value);
      if (y < LINE_MARGIN.top - 0.5 || y > LINE_MARGIN.top + plotH + 0.5) return;
      const labelY = idx % 2 === 0 ? y - 5 : y + 13;
      refLineSvg += `<g>
        <line x1="${LINE_MARGIN.left}" y1="${y}" x2="${LINE_W - LINE_MARGIN.right}" y2="${y}" stroke="var(--text-faint)" stroke-width="1.5" stroke-dasharray="5,4" />
        <text x="${LINE_W - LINE_MARGIN.right}" y="${labelY}" text-anchor="end" font-size="11" style="fill:var(--text-faint)">${escapeHtml(rl.label)}</text>
      </g>`;
    });

    svgWrap.innerHTML = `<svg class="lc-svg" viewBox="0 0 ${LINE_W} ${LINE_H}">${gridSvg}${axisSvg}${xLabelsSvg}${refLineSvg}${areaSvg}${linesSvg}${wellSvg}${fpsoSvg}${highlightSvg}${crosshairSvg}${captureSvg}${yAxisHintSvg}</svg>`;
    const svgEl = svgWrap.firstElementChild;
    const capture = svgEl.querySelector('#lc-capture');
    const crosshair = svgEl.querySelector('#lc-crosshair');

    // Redraw no meio de um arraste (ver isDragging lá em cima) troca este
    // elemento por um novo — recaptura o ponteiro nele pra continuar
    // seguindo o cursor fora da área do gráfico sem esperar o mouse voltar
    // pra cima do retângulo.
    if (isDragging && dragPointerId != null) {
      try { capture.setPointerCapture(dragPointerId); } catch (err) { /* elemento novo, ponteiro pode já ter soltado — arraste some, próximo pointerup na window ainda limpa isDragging */ }
    }

    // Zoom: roda do mouse sobre a área do gráfico dá zoom no eixo x
    // (tempo), ancorado no cursor (mesma ideia do zoom do roadmap
    // principal — ver MIN_PX_PER_DAY/wheel handler em app.js); roda sobre
    // a faixa de rótulos do eixo y (à esquerda da área do gráfico) dá
    // zoom só no eixo y — a base (0) fica fixa, só o teto visível muda,
    // pra não inventar uma linha de base que não é zero num gráfico de
    // vazão. Os dois eixos são independentes: zoom em um não reseta o
    // outro (só "Ver tudo" reseta os dois). Não deixa a página rolar
    // enquanto o mouse está sobre o gráfico.
    svgEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      const pt = svgPoint(svgEl, e.clientX, e.clientY);
      const factor = e.deltaY > 0 ? 1.25 : 1 / 1.25;
      if (pt.x < LINE_MARGIN.left) {
        const base = yMaxOverride !== null ? yMaxOverride : autoMax;
        const floor = Math.max(rawMax * 0.02, 1);
        yMaxOverride = Math.max(floor, base * factor);
        draw();
        return;
      }
      const cursorIdx = clampIdx(idxAt(pt.x));
      let newSpan = span * factor;
      newSpan = Math.max(MIN_VIEW_SPAN, Math.min(n - 1, newSpan));
      const frac = span > 0 ? (cursorIdx - viewStart) / span : 0.5;
      let newStart = cursorIdx - frac * newSpan;
      let newEnd = newStart + newSpan;
      [viewStart, viewEnd] = clampView(newStart, newEnd);
      draw();
    }, { passive: false });

    // Arrastar: move a janela visível — só ativa dentro da área do
    // gráfico, com pointer capture pra continuar recebendo o movimento
    // mesmo se o cursor sair da área durante o arraste (recapturada a
    // cada redraw no elemento novo, ver logo acima). dragStartClientX/
    // dragStartView moram fora de draw() (topo de createLineChart) pra
    // não resetar a cada um desses redraws no meio do próprio arraste.
    capture.addEventListener('pointerdown', (e) => {
      isDragging = true;
      dragPointerId = e.pointerId;
      dragStartClientX = e.clientX;
      dragStartView = [viewStart, viewEnd];
      try { capture.setPointerCapture(e.pointerId); } catch (err) { /* ponteiro sintético (ex.: teste automatizado) sem sessão ativa pra capturar — arraste ainda funciona sem, só não segue o cursor fora da área do gráfico */ }
      hideTooltip();
      if (crosshair) crosshair.hidden = true;
    });
    capture.addEventListener('pointermove', (e) => {
      if (isDragging) {
        const dxPx = e.clientX - dragStartClientX;
        const dxIdx = -(dxPx / plotW) * (dragStartView[1] - dragStartView[0]);
        [viewStart, viewEnd] = clampView(dragStartView[0] + dxIdx, dragStartView[1] + dxIdx);
        draw();
        return;
      }
      const pt = svgPoint(svgEl, e.clientX, e.clientY);
      const idx = clampIdx(Math.round(idxAt(pt.x)));
      showCrosshair(idx, xAt, unit);
    });
    capture.addEventListener('pointerup', (e) => {
      isDragging = false;
      dragPointerId = null;
      try { capture.releasePointerCapture(e.pointerId); } catch (err) { /* idem — nada a liberar se a captura não pegou */ }
    });
    capture.addEventListener('pointerleave', () => {
      if (!isDragging) {
        hideTooltip();
        if (crosshair) crosshair.hidden = true;
      }
    });

    function showCrosshair(idx, xAtFn, unitObj) {
      if (!crosshair) return;
      const x = xAtFn(idx);
      crosshair.setAttribute('x1', x);
      crosshair.setAttribute('x2', x);
      crosshair.hidden = false;
      const m = monthlySeries[idx];
      const rows = [...m.rows].sort((a, b) => b[unitObj.key] - a[unitObj.key]);
      const html = `<strong>${escapeHtml(MESES_PT[m.mes])}/${m.ano}</strong>`
        + rows.map((r) => `<div class="viz-tooltip-row"><span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${r.color};margin-right:5px;vertical-align:middle"></span>${escapeHtml(r.name)}</span><strong>${escapeHtml(unitObj.fmt(r[unitObj.key]))}</strong></div>`).join('');
      const t = ensureTooltip();
      t.innerHTML = html;
      t.hidden = false;
      const rect = svgEl.getBoundingClientRect();
      const scale = rect.width / LINE_W;
      positionTooltip(rect.left + x * scale, rect.top + LINE_MARGIN.top * scale);
    }
  }

  function svgPoint(svgEl, clientX, clientY) {
    const rect = svgEl.getBoundingClientRect();
    const scale = LINE_W / rect.width;
    return { x: (clientX - rect.left) * scale, y: (clientY - rect.top) * scale };
  }
  function clampIdx(i) {
    return Math.max(0, Math.min(n - 1, i));
  }

  // Legenda em dois grupos — contratos de Partilha da Produção rastreados
  // (isContract: true) separados dos demais campos do pré-sal (contexto,
  // fora dos 7 rastreados) — mesma distinção que já colore as linhas
  // (cor do projeto x cor por hash do nome), só deixando explícito na
  // legenda pra não misturar contrato com campo de contexto na mesma
  // lista corrida.
  function legendGroup(title, names) {
    const group = document.createElement('div');
    if (!names.length) return group;
    const label = document.createElement('div');
    label.className = 'stat-tile-label';
    label.style.margin = '10px 0 4px';
    label.textContent = title;
    group.appendChild(label);
    const row = document.createElement('div');
    row.className = 'kpi-row';
    row.style.rowGap = '6px';
    for (const name of names) {
      const { color } = meta.get(name);
      const item = document.createElement('button');
      item.type = 'button';
      item.style.display = 'inline-flex';
      item.style.alignItems = 'center';
      item.style.gap = '6px';
      item.style.fontSize = '12px';
      item.style.background = 'none';
      item.style.border = 'none';
      item.style.padding = '2px 4px';
      item.style.cursor = 'pointer';
      item.style.color = highlighted && highlighted !== name ? 'var(--text-faint)' : 'var(--text-muted)';
      item.style.opacity = highlighted && highlighted !== name ? '0.5' : '1';
      item.innerHTML = `<span style="width:16px;height:2px;background:${color};flex:0 0 auto"></span>${escapeHtml(name)}`;
      item.addEventListener('click', () => {
        if (onSeriesClick) { onSeriesClick(name); return; }
        highlighted = highlighted === name ? null : name;
        drawLegend();
        draw();
      });
      row.appendChild(item);
    }
    group.appendChild(row);
    return group;
  }

  function drawLegend() {
    legendWrap.innerHTML = '';
    const contractNames = order.filter((name) => meta.get(name).isContract);
    const contextNames = order.filter((name) => !meta.get(name).isContract);
    legendWrap.appendChild(legendGroup('Partilha da Produção', contractNames));
    legendWrap.appendChild(legendGroup('Outros projetos', contextNames));
  }

  draw();
  drawLegend();
  container.appendChild(svgWrap);
  container.appendChild(legendWrap);

  return {
    setUnit(key) { unitKey = key; draw(); },
    resetZoom() { viewStart = 0; viewEnd = n - 1; yMaxOverride = null; draw(); },
    isZoomed() { return viewStart > 0 || viewEnd < n - 1 || yMaxOverride !== null; },
    // year: número do ano a marcar (31/dez desse ano), ou null pra tirar a
    // marca — ver highlightSvg em draw(). Usado por campo.js pra ligar o
    // filtro de ano do mini-mapa (até que ano os poços aparecem) com os
    // gráficos de produção/RGO do mesmo painel.
    setHighlightYear(year) { highlightYear = year; draw(); },
    // Estado ABSOLUTO (não toggle) do isolamento da legenda — pra sincronizar
    // com uma seleção externa (ver onSeriesClick acima e selectWell em
    // campo.js): name fora de `order` (ex.: poço de outro cartão/FPSO) cai
    // pra null, então só o gráfico que realmente tem essa série destaca
    // alguma coisa, os demais voltam ao normal.
    setHighlight(name) {
      highlighted = order.includes(name) ? name : null;
      drawLegend();
      draw();
    },
  };
}

// Seletor de unidade (Petróleo/Gás/Produção/RGO, ver UNITS) — botões estilo
// .scale-switch, reaproveitados pelo gráfico de barras e pelo de linhas de
// producao.js, e pelos gráficos por campo de campo.js. keys restringe quais
// abas mostrar (ex.: campo.js não repete "RGO" aqui — tem gráfico próprio
// só de RGO); omitido, mostra as 4.
function buildUnitSwitch(onChange, keys) {
  const wrap = document.createElement('div');
  wrap.className = 'scale-switch analytics-tab-switch';
  (keys || Object.keys(UNITS)).forEach((key, i) => {
    const btn = document.createElement('button');
    btn.className = 'scale-btn' + (i === 0 ? ' active' : '');
    btn.textContent = UNITS[key].label;
    btn.dataset.unit = key;
    wrap.appendChild(btn);
  });
  wrap.addEventListener('click', (e) => {
    const btn = e.target.closest('.scale-btn');
    if (!btn) return;
    wrap.querySelectorAll('.scale-btn').forEach((b) => b.classList.toggle('active', b === btn));
    onChange(btn.dataset.unit);
  });
  return wrap;
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
  // Parceiras que só aparecem em blocos de exploração/devolvidos (sem PD —
  // participação vem do resultado do leilão/rodada, não de um Sumário
  // Executivo, ver nota em planos_desenvolvimento.json). QPI Brasil
  // Petróleo Ltda. e QatarEnergy Brasil Ltda. são a mesma empresa (Qatar
  // Petroleum International renomeada QatarEnergy ~2021) — duas chaves,
  // mesmo selo, cada uma com o nome usado no leilão da época.
  'Chevron Brasil Óleo e Gás Ltda.': { short: 'Chevron', initials: 'CV' },
  'Ecopetrol Óleo e Gás do Brasil Ltda.': { short: 'Ecopetrol', initials: 'EC' },
  'QPI Brasil Petróleo Ltda.': { short: 'QatarEnergy', initials: 'QE' },
  'QatarEnergy Brasil Ltda.': { short: 'QatarEnergy', initials: 'QE' },
  'Petronas Petróleo Brasil Ltda.': { short: 'Petronas', initials: 'PT' },
  'Sinopec Petroleum do Brasil Ltda.': { short: 'Sinopec', initials: 'SP' },
  // Variantes mais curtas do campo "op" de data/pocos.json (nome do
  // operador do POÇO, não do contrato — formato diferente do operador do
  // GeoJSON acima) — mesma empresa, mesmo selo. Usadas pelo fallback de
  // operador do roadmap (ver wellOperatorFallback em app.js) pro único
  // projeto sem poligonal na ANP (ver PROJECTS_WITHOUT_SHAPE em mapa.js).
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
  'TotalEnergies': 'assets/logos/totalenergies.png',
  'Shell': 'assets/logos/shell.png',
  'Equinor': 'assets/logos/equinor.png',
  'BP': 'assets/logos/bp.png',
  'Galp': 'assets/logos/galp.png',
  'Repsol Sinopec': 'assets/logos/repsol-sinopec.png',
  'CNODC': 'assets/logos/cnodc.png',
  'CNOOC': 'assets/logos/cnooc.png',
  'PRIO': 'assets/logos/prio.png',
  'Karoon': 'assets/logos/karoon.png',
  'ExxonMobil': 'assets/logos/exxonmobil.png',
  'Ecopetrol': 'assets/logos/ecopetrol.png',
  'Chevron': 'assets/logos/chevron.png',
  'QatarEnergy': 'assets/logos/qatarenergy.png',
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
    // Qual dos GROUP_DEFS (Exploração/Produção/Devolvidos) o roadmap
    // mostra — substituiu o antigo groupCollapsed (grupo colapsável,
    // todos empilhados) por sub-abas (só um grupo por vez, ver
    // renderGroupTabSwitch em app.js): mais rápido pra trocar de contexto
    // do que abrir/fechar cada grupo, e a timeline não precisa mais
    // acomodar 3 grupos empilhados ao mesmo tempo.
    groupTab: 'exploracao',
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
        // groupTab substitui o antigo groupCollapsed (ver seedState) — estado
        // salvo de antes dessa troca não tem groupTab (nem group definido em
        // nenhum grupo específico pra "lembrar"), cai no mesmo padrão de
        // seedState.
        if (!parsed.groupTab) parsed.groupTab = 'exploracao';
        delete parsed.groupCollapsed;
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
