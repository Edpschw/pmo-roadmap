'use strict';

/* =========================================================================
   PMO Roadmap — visão Gantt, vanilla JS, sem dependências externas.
   Estado: projetos > workstreams > itens (tarefa | marco). Persistido em
   localStorage (ver shared.js, carregado antes deste arquivo). Renderização
   reconstrói o DOM a cada mudança de estado (simples e suficiente para a
   escala de um roadmap de PMO).
   ========================================================================= */

const MONTHS_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const WEEKDAYS_PT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

// Piso bem baixo de propósito: serve só para evitar largura zero/negativa
// em casos patológicos — quem realmente limita o zoom mínimo no dia a dia
// é minPxPerDayToFillScreen() (a tela nunca fica com espaço vazio sobrando,
// mas também nunca fica maior que a tela quando o intervalo de dados é
// muito grande, como no roadmap de CPPs que cobre ~14 anos).
const MIN_PX_PER_DAY = 0.02;
const MAX_PX_PER_DAY = 32;

const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif';

const _measureCanvas = document.createElement('canvas');
const _measureCtx = _measureCanvas.getContext('2d');
function measureTextWidth(text, font) {
  _measureCtx.font = font;
  return _measureCtx.measureText(text).width;
}

// Deslocamento fracionário (em dias) do instante atual em relação a rangeStart,
// combinando a data local com a hora local — usado para posicionar a linha de
// "hoje" também dentro do dia, não só no início dele.
function nowFractionalDayOffset(rangeStart) {
  const now = new Date();
  const wholeDays = diffDays(rangeStart, parseDate(todayISO()));
  const secondsIntoDay = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  return wholeDays + secondsIntoDay / 86400;
}
function formatTodayFlagLabel() {
  const now = new Date();
  const dateLabel = `${pad2(now.getDate())} ${MONTHS_PT[now.getMonth()]}`;
  const timeLabel = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return `${dateLabel}, ${timeLabel}`;
}
// Progresso do projeto como um todo: média do progresso real e do esperado
// de todas as suas tarefas, ponderada pela duração de cada uma (tarefas mais
// longas pesam mais). Marcos não entram, pois não têm campo de progresso.
// Retorna null se o projeto não tiver nenhuma tarefa.
function computeProjectProgress(project) {
  let weightedActual = 0;
  let weightedExpected = 0;
  let totalDays = 0;
  for (const w of project.workstreams) {
    for (const it of w.items) {
      if (it.type !== 'task') continue;
      const days = Math.max(1, diffDays(parseDate(it.start), parseDate(it.end)) + 1);
      weightedActual += Math.min(100, Math.max(0, it.progress || 0)) * days;
      weightedExpected += computeExpectedProgress(it) * days;
      totalDays += days;
    }
  }
  if (totalDays === 0) return null;
  return {
    actual: Math.round(weightedActual / totalDays),
    expected: Math.round(weightedExpected / totalDays),
  };
}
// Elemento com os dois números centralizados (real / esperado), reutilizado
// tanto pelas barras de tarefa quanto pela linha-resumo de projeto colapsado.
function buildProgressNumbersEl(actualProgress, expectedProgress, centerX, top) {
  const actualClass = progressStatusClass(actualProgress, expectedProgress);
  const numbers = document.createElement('div');
  numbers.className = 'progress-numbers';
  numbers.innerHTML =
    `<span class="actual ${actualClass}">${actualProgress}%</span>` +
    `<span class="sep">/</span>` +
    `<span class="expected">${expectedProgress}%</span>`;
  const numbersText = `${actualProgress}% / ${expectedProgress}%`;
  const numbersWidth = measureTextWidth(numbersText, PROGRESS_BADGE_FONT) + 6;
  const numbersLeft = Math.max(2, Math.min(centerX - numbersWidth / 2, currentTimelineWidth - numbersWidth - 2));
  numbers.style.left = numbersLeft + 'px';
  numbers.style.width = numbersWidth + 'px';
  numbers.style.top = top + 'px';
  return numbers;
}
function startOfMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}
function startOfWeekMonday(date) {
  const dow = date.getUTCDay(); // 0=dom .. 6=sáb
  const diff = dow === 0 ? -6 : 1 - dow;
  return addDays(date, diff);
}
function pad2(n) {
  return String(n).padStart(2, '0');
}

/* ------------------------ Cabeçalho dinâmico (zoom) ---------------------- */

// Define quais unidades de tempo aparecem no cabeçalho (linha "grossa" de
// contexto + linha "fina" de detalhe) de acordo com o nível de zoom atual.
function getHeaderBand(pxPerDay) {
  if (pxPerDay < 0.9) return { coarse: null, fine: 'year' };
  if (pxPerDay < 3.2) return { coarse: 'year', fine: 'month' };
  if (pxPerDay < 10) return { coarse: 'month', fine: 'week' };
  return { coarse: 'week', fine: 'day' };
}

// Gera os segmentos (início/fim/data de referência) de uma unidade de tempo
// que cobrem o intervalo [rangeStart, rangeEnd). Usado tanto para os rótulos
// do cabeçalho quanto para as linhas de grade verticais, para que fiquem
// sempre alinhados.
function iterateSegments(unit, rangeStart, rangeEnd) {
  const segments = [];
  if (unit === 'year') {
    let cur = new Date(Date.UTC(rangeStart.getUTCFullYear(), 0, 1));
    while (cur < rangeEnd) {
      const next = new Date(Date.UTC(cur.getUTCFullYear() + 1, 0, 1));
      segments.push({ start: cur, end: next, boundary: cur });
      cur = next;
    }
  } else if (unit === 'month') {
    let cur = startOfMonth(rangeStart);
    while (cur < rangeEnd) {
      const next = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
      segments.push({ start: cur, end: next, boundary: cur });
      cur = next;
    }
  } else if (unit === 'week') {
    let cur = startOfWeekMonday(rangeStart);
    while (cur < rangeEnd) {
      const next = addDays(cur, 7);
      segments.push({ start: cur, end: next, boundary: cur });
      cur = next;
    }
  } else if (unit === 'day') {
    let cur = new Date(rangeStart.getTime());
    while (cur < rangeEnd) {
      const next = addDays(cur, 1);
      segments.push({ start: cur, end: next, boundary: cur });
      cur = next;
    }
  }
  return segments;
}

function formatSegmentLabel(unit, boundary, tierKind) {
  if (unit === 'year') return String(boundary.getUTCFullYear());
  if (unit === 'month') {
    // Como "week" logo abaixo: no nível "fine" (mês dentro de um cabeçalho
    // de ano) a coluna é estreita demais pra "jan 2026" inteiro — o ano já
    // está na linha "coarse" acima, então basta o mês abreviado.
    if (tierKind === 'fine') return MONTHS_PT[boundary.getUTCMonth()];
    return `${MONTHS_PT[boundary.getUTCMonth()]} ${boundary.getUTCFullYear()}`;
  }
  if (unit === 'week') {
    if (tierKind === 'coarse') return `${pad2(boundary.getUTCDate())} ${MONTHS_PT[boundary.getUTCMonth()]}`;
    return boundary.getUTCDate() === 1 ? `${pad2(boundary.getUTCDate())} ${MONTHS_PT[boundary.getUTCMonth()]}` : pad2(boundary.getUTCDate());
  }
  if (unit === 'day') return pad2(boundary.getUTCDate());
  return '';
}

/* -------------------------------- DOM refs ------------------------------- */

const gridEl = document.getElementById('grid');
const scrollContainer = document.getElementById('scrollContainer');
const emptyStateEl = document.getElementById('emptyState');
const rangeLabelEl = document.getElementById('rangeLabel');
const modalOverlay = document.getElementById('modalOverlay');
const modalEl = document.getElementById('modal');
const toastEl = document.getElementById('toast');
const popoverEl = document.getElementById('popover');

/* -------------------------------- Toast --------------------------------- */

let toastTimer = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2200);
}

/* ------------------------------ Range calc ------------------------------- */

function computeRange() {
  let min = null, max = null;
  for (const p of state.projects) {
    for (const w of p.workstreams) {
      for (const it of w.items) {
        const s = parseDate(it.type === 'milestone' ? it.date : it.start);
        const e = parseDate(it.type === 'milestone' ? it.date : it.end);
        if (!min || s < min) min = s;
        if (!max || e > max) max = e;
      }
    }
  }
  const today = parseDate(todayISO());
  if (!min) min = today;
  if (!max) max = today;
  if (today < min) min = today;
  if (today > max) max = today;

  let rangeStart = startOfMonth(addDays(min, -30));
  let rangeEnd = startOfMonth(addDays(addDays(max, 30), 31));

  const minSpanDays = 300;
  if (diffDays(rangeStart, rangeEnd) < minSpanDays) {
    rangeEnd = addDays(rangeStart, minSpanDays);
  }
  return { rangeStart, rangeEnd };
}

/* -------------------------------- Lanes ---------------------------------- */

// Empacota itens que se sobrepõem no tempo em "raias" verticais dentro da
// linha de uma workstream, para que não fiquem desenhados um sobre o outro.
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

// Largura da caixa do rótulo de um marco, usada tanto para desenhá-la
// (renderMilestone) quanto para o cálculo de colisão (resolveMilestoneLabelLayout)
// — se as duas contas divergissem, a colisão poderia ser calculada para uma
// largura diferente da realmente renderizada. Inclui uma margem extra (~10%)
// além do texto medido via canvas, já que a métrica real da fonte pode variar
// um pouco entre navegador/dispositivo em relação à medição.
function milestoneLabelBoxWidth(name) {
  return Math.ceil(measureTextWidth(name, MILESTONE_LABEL_FONT) * 1.1) + 12;
}

// Rótulo sempre visível no gráfico fica só com o essencial. Marco de poço
// (icon 'well') tem regra própria — ver wellMilestoneLabel logo abaixo,
// que usa o código do poço e o operador direto da base da ANP; esta
// função aqui cobre os demais tipos (contrato, FPSO, genérico): corta o
// parêntese final e a cláusula final com travessão do nome ("Petrobras
// compra 50% (Equinor)" vira "Petrobras compra 50%") — o texto completo
// não se perde, continua aparecendo por inteiro no hover (ver
// showMilestoneTooltip). Só corta em cima de travessão "—", nunca hífen
// comum, porque nome de marco pode ter hífen no meio (datas, códigos).
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

// Base de poços da ANP/BDEP (data/pocos.json), a mesma usada pelo mapa —
// mapa.js tem uma cópia independente destas mesmas funções (wellCategory,
// wellCodeOf) porque as duas páginas carregam scripts separados sem
// bundler; mudar a classificação num lugar exige mudar no outro igual.
const POCOS_URL = 'data/pocos.json';
let pocosDataApp = {};

const WELL_CODE_RE = /\b\d+-[A-Z]{2,6}-\d+[A-Z]*-[A-Z]{3}\b/;
function wellCodeOf(name) {
  const m = String(name).match(WELL_CODE_RE);
  return m ? m[0] : null;
}

// Mesma prioridade de classificação do mapa.js: RECLASSIFICACAO (resultado
// apurado) antes de SITUACAO (estado atual), pra não achar "produtor" só
// porque o poço está tecnicamente "produzindo" num sentido genérico.
// Produtor/injetor só conta se o poço ainda estiver ativo — RECLASSIFICACAO
// é um veredito histórico que não muda quando o poço é desativado depois;
// SITUACAO, sim (ver mapa.js para o caso real que motivou isso: quase
// metade dos poços "produtor" na base tinham SITUACAO abandonado).
function wellCategory(info) {
  if (!info) return 'indefinido';
  const rec = info.rec || '';
  const sit = info.sit || '';
  const sitAbandoned = sit.includes('ABANDONADO') || sit === 'ARRASADO' || sit === 'FECHADO' || sit === 'DEVOLVIDO';
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
  return 'indefinido';
}

// Marco agregado ("17 poços perfurados em 2024", workstream "Poços
// Perfurados" dos campos em produção) — casa só o número no início do
// nome, sem exigir o resto do texto, pra não depender do plural/singular
// ("1 poço perfurado" vs "17 poços perfurados").
const WELL_COUNT_MILESTONE_RE = /^(\d+)\s+poços?\s+perfurados?\s+em\s+\d{4}/i;

// Ordem/rótulo de exibição da quebra por tipo no tooltip — mesma
// categorização do mapa (ver wellCategory), do resultado mais positivo
// (produz) ao mais neutro (sem registro).
const WELL_COUNT_LABELS = [
  ['producao', 'Produtores'],
  ['gas', 'Gás'],
  ['injecao', 'Injetores'],
  ['indicio', 'Indícios'],
  ['seco', 'Secos'],
  ['abandonado', 'Abandonados'],
  ['indefinido', 'Sem registro'],
];

// Conta todos os poços do projeto cadastrados na ANP com data de
// conclusão naquele ano, por categoria (ver wellCategory) — não só
// produtor/injetor, também seco/indício/abandonado/sem registro, pra dar
// o quadro completo do que os "X poços perfurados" daquele ano viraram.
function wellCountBreakdown(project, year) {
  const wells = pocosDataApp[project.name] || [];
  const counts = {};
  for (const w of wells) {
    if (!w.d || w.d.slice(0, 4) !== year) continue;
    const cat = wellCategory(w);
    counts[cat] = (counts[cat] || 0) + 1;
  }
  return counts;
}

// Rótulo sempre visível de um marco de poço: só o essencial, direto da
// base da ANP em vez do texto curado (que tinha prefixo de tipo, apelido
// entre aspas e o resultado detalhado — tudo isso continua no hover, ver
// showMilestoneTooltip). Agregado de ano vira só o número; poço
// individual vira "código (operador)"; sem correspondência na base (ex.:
// "Poço exploratório (previsto)", que ainda não tem poço real perfurado)
// cai no corte genérico de simplifyMilestoneLabel.
function wellMilestoneLabel(project, item) {
  const countMatch = item.name.match(WELL_COUNT_MILESTONE_RE);
  if (countMatch) return countMatch[1];
  const code = wellCodeOf(item.name);
  if (code) {
    const wells = pocosDataApp[project.name] || [];
    const found = wells.find((w) => w.n === code);
    if (found && found.op) return `${code} (${found.op})`;
    return code;
  }
  return simplifyMilestoneLabel(item.name);
}

// Ponto único de decisão entre as duas regras de simplificação (poço vs.
// os demais tipos) — usado tanto no cálculo de colisão
// (resolveMilestoneLabelLayout) quanto no desenho (renderMilestone), pra
// nunca divergir entre a largura calculada e o texto realmente exibido.
function milestoneLabelOf(project, item) {
  return item.icon === 'well' ? wellMilestoneLabel(project, item) : simplifyMilestoneLabel(item.name);
}

// O rótulo do marco fica sempre centralizado exatamente sobre o losango —
// nunca desloca horizontalmente, nem para desviar de barras de tarefa (isso
// já causou o rótulo "teleportando" para longe do marco). A única
// otimização: se colidir com o rótulo do marco anterior na mesma raia,
// alterna para abaixo do losango em vez de acima. Recebe os `placements` já
// calculados por packLanes() e devolve um Map item -> { below }.
function resolveMilestoneLabelLayout(project, placements, rangeStart) {
  const GAP = 6;
  const byLane = new Map();
  for (const { item, lane } of placements) {
    if (item.type !== 'milestone') continue;
    if (!byLane.has(lane)) byLane.set(lane, []);
    byLane.get(lane).push(item);
  }

  const result = new Map();
  for (const laneItems of byLane.values()) {
    const withPos = laneItems.map((item) => {
      const diamondX = diffDays(rangeStart, parseDate(item.date)) * currentPxPerDay;
      const labelBoxWidth = milestoneLabelBoxWidth(milestoneLabelOf(project, item));
      return { item, left: diamondX - labelBoxWidth / 2, right: diamondX + labelBoxWidth / 2 };
    }).sort((a, b) => a.left - b.left);

    let prevAbove = null;
    for (const entry of withPos) {
      const below = !!(prevAbove && entry.left < prevAbove.right + GAP);
      if (!below) prevAbove = entry;
      result.set(entry.item, { below });
    }
  }
  return result;
}

/* -------------------------------- Render ---------------------------------- */

const SIDEBAR_WIDTH_DESKTOP = 300;
const SIDEBAR_WIDTH_MOBILE_MIN = 150;
const MOBILE_BREAKPOINT = 640;
// Espaço reservado na label-cell além do texto do nome do projeto: padding +
// chevron + bolinha de cor + ícone "+" + gaps (ver .label-cell no CSS mobile).
const PROJECT_LABEL_CHROME_MOBILE = 95;
const PROJECT_NAME_FONT_SIZE_MOBILE = 12;
const PROJECT_NAME_FONT_WEIGHT_MOBILE = '600';
const PROJECT_NAME_MIN_FONT_SIZE_MOBILE = 9;

// Usa o menor dos dois lados da viewport para que um celular também caia no
// modo compacto quando girado para paisagem (largura grande, altura curta).
function isMobileLayout() {
  return Math.min(window.innerWidth, window.innerHeight) <= MOBILE_BREAKPOINT;
}

// No mobile, a sidebar cresce o suficiente para caber o nome do projeto mais
// longo numa única linha, respeitando um mínimo compacto e um máximo que
// ainda deixa espaço utilizável para a timeline ao lado. Nomes que mesmo
// assim não couberem têm a fonte reduzida por linha em fitProjectLabelFont
// (ver renderProjectRow), sem depender só da largura da sidebar.
function computeMobileSidebarWidth() {
  const font = `${PROJECT_NAME_FONT_WEIGHT_MOBILE} ${PROJECT_NAME_FONT_SIZE_MOBILE}px ${FONT_STACK}`;
  let widestName = 0;
  for (const project of state.projects) {
    const w = measureTextWidth(project.name, font);
    if (w > widestName) widestName = w;
  }
  const desired = Math.ceil(widestName + PROJECT_LABEL_CHROME_MOBILE);
  const max = Math.max(SIDEBAR_WIDTH_MOBILE_MIN, window.innerWidth - 70);
  return Math.min(max, Math.max(SIDEBAR_WIDTH_MOBILE_MIN, desired));
}

// Tamanho de fonte (px) para o nome do projeto caber em uma linha só dentro
// da largura disponível: usa o tamanho padrão se couber, senão reduz aos
// poucos até um piso legível (não trunca nem depende de quebrar linha).
function fitProjectLabelFontSize(name, availableWidth) {
  let size = PROJECT_NAME_FONT_SIZE_MOBILE;
  while (size > PROJECT_NAME_MIN_FONT_SIZE_MOBILE) {
    const font = `${PROJECT_NAME_FONT_WEIGHT_MOBILE} ${size}px ${FONT_STACK}`;
    if (measureTextWidth(name, font) <= availableWidth) break;
    size -= 0.5;
  }
  return size;
}

function getSidebarWidth() {
  return isMobileLayout() ? computeMobileSidebarWidth() : SIDEBAR_WIDTH_DESKTOP;
}
let currentSidebarWidth = getSidebarWidth();

// Dimensões do Gantt em pixels. No celular, tudo encolhe (linhas, barras,
// cabeçalho, fontes) para caber mais informação na tela sem exigir zoom.
// Recalculadas a cada render() via applyResponsiveMetrics().
const METRICS_DESKTOP = {
  headerH: 46, headerTopTierH: 18, projectRowH: 44, barH: 22,
  laneH: 40, laneContentTop: 3, lanePad: 24,
  milestoneLabelFont: '600 11px ' + FONT_STACK,
  progressBadgeFont: '700 10.5px ' + FONT_STACK,
};
const METRICS_MOBILE = {
  headerH: 34, headerTopTierH: 14, projectRowH: 36, barH: 16,
  laneH: 28, laneContentTop: 2, lanePad: 16,
  milestoneLabelFont: '600 9.5px ' + FONT_STACK,
  progressBadgeFont: '700 9px ' + FONT_STACK,
};

let HEADER_H, HEADER_TOP_TIER_H, HEADER_BOTTOM_TIER_H, PROJECT_ROW_H, BAR_H,
  LANE_H, LANE_CONTENT_TOP, LANE_PAD, MILESTONE_LABEL_FONT, PROGRESS_BADGE_FONT;

function applyResponsiveMetrics() {
  const m = isMobileLayout() ? METRICS_MOBILE : METRICS_DESKTOP;
  HEADER_H = m.headerH;
  HEADER_TOP_TIER_H = m.headerTopTierH;
  HEADER_BOTTOM_TIER_H = HEADER_H - HEADER_TOP_TIER_H;
  PROJECT_ROW_H = m.projectRowH;
  BAR_H = m.barH;
  LANE_H = m.laneH;
  LANE_CONTENT_TOP = m.laneContentTop;
  LANE_PAD = m.lanePad;
  MILESTONE_LABEL_FONT = m.milestoneLabelFont;
  PROGRESS_BADGE_FONT = m.progressBadgeFont;
}
applyResponsiveMetrics();

let currentPxPerDay = SCALE_PX_PER_DAY.month;
let currentRangeStart = null;
let currentTimelineWidth = 0;
let todayLineEl = null;
let todayFlagEl = null;

function clampPxPerDay(v, minOverride) {
  const min = Math.max(MIN_PX_PER_DAY, minOverride || 0);
  return Math.min(MAX_PX_PER_DAY, Math.max(min, v));
}

// Zoom mínimo dinâmico: mesma conta de pxPerDayToFitAll(), mas aplicada como
// piso permanente do zoom (não só quando se clica em "Tudo"), para que
// afastar o zoom livremente nunca deixe espaço vazio sobrando na tela.
function minPxPerDayToFillScreen(totalDays) {
  if (totalDays <= 0) return MIN_PX_PER_DAY;
  const visibleTimelineWidth = scrollContainer.clientWidth - getSidebarWidth();
  return visibleTimelineWidth / totalDays;
}

function syncScaleButtons() {
  document.querySelectorAll('.scale-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.scale === state.scale);
  });
}

function render() {
  const hasProjects = state.projects.length > 0;
  emptyStateEl.hidden = hasProjects;
  gridEl.style.display = hasProjects ? '' : 'none';
  if (!hasProjects) return;

  const { rangeStart, rangeEnd } = computeRange();
  currentRangeStart = rangeStart;
  const totalDays = diffDays(rangeStart, rangeEnd);
  currentSidebarWidth = getSidebarWidth();
  document.documentElement.style.setProperty('--sidebar-w', currentSidebarWidth + 'px');
  applyResponsiveMetrics();
  document.documentElement.style.setProperty('--header-h', HEADER_H + 'px');
  // Escala "Tudo" recalcula o zoom pra caber a tela a cada render (em vez
  // de reusar o valor salvo), pra continuar exata mesmo se a janela mudar
  // de tamanho ou novos dados alterarem o intervalo total desde a última
  // vez que "Tudo" foi selecionado (inclusive no primeiro carregamento,
  // que já abre nessa escala por padrão — ver seedState() em shared.js).
  const minFit = minPxPerDayToFillScreen(totalDays);
  currentPxPerDay = state.scale === 'all' ? clampPxPerDay(minFit) : clampPxPerDay(state.pxPerDay || SCALE_PX_PER_DAY.month, minFit);
  const timelineWidth = totalDays * currentPxPerDay;
  currentTimelineWidth = timelineWidth;
  const sidebarWidth = currentSidebarWidth;
  const totalWidth = sidebarWidth + timelineWidth;

  rangeLabelEl.textContent = `Exibindo ${MONTHS_PT[rangeStart.getUTCMonth()]} ${rangeStart.getUTCFullYear()} — ${MONTHS_PT[rangeEnd.getUTCMonth()]} ${rangeEnd.getUTCFullYear()}`;

  gridEl.innerHTML = '';
  gridEl.style.width = totalWidth + 'px';

  // ---- Linha de cabeçalho (dinâmica: anos / meses / semanas / dias) ----
  const band = getHeaderBand(currentPxPerDay);

  const headerRow = document.createElement('div');
  headerRow.className = 'row header-row';
  headerRow.style.height = HEADER_H + 'px';

  const cornerCell = document.createElement('div');
  cornerCell.className = 'label-cell';
  cornerCell.innerHTML = '<span class="corner-title">Projeto / Workstream</span>';
  headerRow.appendChild(cornerCell);

  const headerTimelineCell = document.createElement('div');
  headerTimelineCell.className = 'timeline-cell';

  const fineTop = band.coarse ? HEADER_TOP_TIER_H : 0;
  const fineHeight = band.coarse ? HEADER_BOTTOM_TIER_H : HEADER_H;
  if (band.coarse) {
    renderHeaderTier(headerTimelineCell, band.coarse, rangeStart, rangeEnd, 0, HEADER_TOP_TIER_H, 'coarse');
  }
  renderHeaderTier(headerTimelineCell, band.fine, rangeStart, rangeEnd, fineTop, fineHeight, 'fine');

  headerRow.appendChild(headerTimelineCell);
  gridEl.appendChild(headerRow);

  // ---- Linhas de grupo / projeto / workstream ----
  let contentHeight = HEADER_H;

  for (const groupDef of GROUP_DEFS) {
    const groupProjects = state.projects.filter((p) => (p.group || GROUP_FALLBACK) === groupDef.id);
    if (!groupProjects.length) continue;
    const isCollapsed = !!state.groupCollapsed[groupDef.id];
    contentHeight += renderGroupRow(groupDef, groupProjects, isCollapsed);
    if (isCollapsed) continue;
    for (const project of groupProjects) {
      contentHeight += renderProjectRow(project, rangeStart);
      if (!project.collapsed) {
        for (const w of project.workstreams) {
          contentHeight += renderWorkstreamRow(project, w, rangeStart);
        }
      }
    }
  }

  // ---- Overlay de gridlines + linha de "hoje" (atrás das linhas) ----
  const overlay = document.createElement('div');
  overlay.style.position = 'absolute';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = totalWidth + 'px';
  overlay.style.height = contentHeight + 'px';
  overlay.style.pointerEvents = 'none';

  for (const seg of iterateSegments(band.fine, rangeStart, rangeEnd)) {
    if (band.fine === 'day') {
      const dow = seg.boundary.getUTCDay();
      if (dow === 0 || dow === 6) {
        const segStart = seg.start < rangeStart ? rangeStart : seg.start;
        const segEnd = seg.end > rangeEnd ? rangeEnd : seg.end;
        const shade = document.createElement('div');
        shade.className = 'weekend-shade';
        shade.style.left = (sidebarWidth + diffDays(rangeStart, segStart) * currentPxPerDay) + 'px';
        shade.style.width = (diffDays(segStart, segEnd) * currentPxPerDay) + 'px';
        shade.style.height = contentHeight + 'px';
        overlay.appendChild(shade);
      }
    }
    if (seg.start <= rangeStart) continue;
    const left = sidebarWidth + diffDays(rangeStart, seg.start) * currentPxPerDay;
    const line = document.createElement('div');
    line.className = 'gridline' + (band.fine === 'month' || band.fine === 'year' ? ' month-start' : '');
    line.style.left = left + 'px';
    line.style.height = contentHeight + 'px';
    overlay.appendChild(line);
  }

  const today = parseDate(todayISO());
  todayLineEl = null;
  todayFlagEl = null;
  if (today >= rangeStart && today <= rangeEnd) {
    const todayLeft = sidebarWidth + nowFractionalDayOffset(rangeStart) * currentPxPerDay;
    const todayLine = document.createElement('div');
    todayLine.className = 'today-line';
    todayLine.style.left = todayLeft + 'px';
    todayLine.style.height = (contentHeight - HEADER_H) + 'px';
    overlay.appendChild(todayLine);
    todayLineEl = todayLine;

    const flag = document.createElement('div');
    flag.className = 'today-flag';
    flag.style.left = todayLeft + 'px';
    flag.textContent = `Hoje ${formatTodayFlagLabel()}`;
    overlay.appendChild(flag);
    todayFlagEl = flag;
  }

  gridEl.insertBefore(overlay, gridEl.firstChild);
  syncScaleButtons();
  updateBarLabelPositions();
  updateTodayMarkerVisibility();
}

// Mantém o nome de cada tarefa centralizado na parte da barra que está
// visível na tela: em barras longas, o texto "segue" a rolagem/zoom em vez
// de ficar preso numa ponta que pode sair da área visível.
function updateBarLabelPositions() {
  const containerRect = scrollContainer.getBoundingClientRect();
  const visibleLeft = containerRect.left + currentSidebarWidth;
  const visibleRight = containerRect.right;

  document.querySelectorAll('.task-bar').forEach((bar) => {
    const labelEl = bar.querySelector('.bar-label');
    if (!labelEl) return;
    const barRect = bar.getBoundingClientRect();
    const maxWidth = Math.max(0, barRect.width - 12);
    labelEl.style.maxWidth = maxWidth + 'px';

    const visStart = Math.max(barRect.left, visibleLeft);
    const visEnd = Math.min(barRect.right, visibleRight);
    if (visEnd <= visStart || maxWidth <= 0) {
      labelEl.style.visibility = 'hidden';
      return;
    }
    labelEl.style.visibility = '';

    const labelWidth = labelEl.offsetWidth;
    const visCenterScreen = (visStart + visEnd) / 2;
    let localLeft = (visCenterScreen - barRect.left) - labelWidth / 2;
    localLeft = Math.max(6, Math.min(localLeft, barRect.width - labelWidth - 6));
    labelEl.style.left = localLeft + 'px';
  });
}

// A sidebar (coluna de projeto/workstream) é sticky e fica sempre visível por
// cima da timeline. A linha/flag de "hoje" tem posição fixa dentro do
// conteúdo rolável, então, ao rolar, pode acabar caindo exatamente atrás da
// sidebar — nesse caso, escondemos os dois em vez de deixá-los meio
// cobertos/meio visíveis, o que pareceria um elemento "vazando" por trás da
// coluna fixa.
function updateTodayMarkerVisibility() {
  if (!todayLineEl || !todayFlagEl) return;
  const sidebarRight = scrollContainer.getBoundingClientRect().left + currentSidebarWidth;
  const flagRect = todayFlagEl.getBoundingClientRect();
  const lineRect = todayLineEl.getBoundingClientRect();
  const hidden = flagRect.left < sidebarRight || lineRect.left < sidebarRight;
  todayLineEl.style.visibility = hidden ? 'hidden' : '';
  todayFlagEl.style.visibility = hidden ? 'hidden' : '';
}

let _labelUpdateScheduled = false;
function scheduleBarLabelUpdate() {
  if (_labelUpdateScheduled) return;
  _labelUpdateScheduled = true;
  requestAnimationFrame(() => {
    _labelUpdateScheduled = false;
    updateBarLabelPositions();
    updateTodayMarkerVisibility();
  });
}

function renderHeaderTier(container, unit, rangeStart, rangeEnd, top, height, tierKind) {
  for (const seg of iterateSegments(unit, rangeStart, rangeEnd)) {
    const segStart = seg.start < rangeStart ? rangeStart : seg.start;
    const segEnd = seg.end > rangeEnd ? rangeEnd : seg.end;
    if (segEnd <= segStart) continue;
    const left = diffDays(rangeStart, segStart) * currentPxPerDay;
    const width = diffDays(segStart, segEnd) * currentPxPerDay;
    const label = document.createElement('div');
    label.className = 'header-tier-label ' + tierKind + ' unit-' + unit;
    if (unit === 'day') {
      const dow = seg.boundary.getUTCDay();
      if (dow === 0 || dow === 6) label.classList.add('weekend');
    }
    label.style.left = left + 'px';
    label.style.width = width + 'px';
    label.style.top = top + 'px';
    label.style.height = height + 'px';
    label.textContent = formatSegmentLabel(unit, seg.boundary, tierKind);
    container.appendChild(label);
  }
}

// No mobile o nome do projeto/workstream pode quebrar em várias linhas (ver
// .label-text em style.css) para nunca ser cortado. Como a altura da linha é
// definida via JS em pixels (para posicionar as barras/marcos da timeline),
// medimos a altura natural do rótulo já quebrado — fora da árvore visível —
// e usamos o maior valor entre ela e a altura calculada pelas raias.
let _labelMeasureContainer = null;
function measureLabelCellHeight(labelCellEl) {
  if (!_labelMeasureContainer) {
    _labelMeasureContainer = document.createElement('div');
    _labelMeasureContainer.style.cssText = 'position:absolute; visibility:hidden; pointer-events:none; left:-9999px; top:-9999px;';
    document.body.appendChild(_labelMeasureContainer);
  }
  _labelMeasureContainer.appendChild(labelCellEl);
  const height = labelCellEl.scrollHeight;
  _labelMeasureContainer.removeChild(labelCellEl);
  return height;
}

// Linha de grupo (Exploração / Produção / Devolvidos): nível colapsável
// acima dos projetos. Recolher esconde todos os projetos (e workstreams)
// daquele grupo; não tem barra-resumo própria, só o cabeçalho.
function renderGroupRow(groupDef, groupProjects, isCollapsed) {
  const row = document.createElement('div');
  row.className = 'row group-row';
  row.style.height = PROJECT_ROW_H + 'px';

  const labelCell = document.createElement('div');
  labelCell.className = 'label-cell';

  const chevron = document.createElement('span');
  chevron.className = 'chevron' + (isCollapsed ? ' collapsed' : '');
  chevron.textContent = '▾';
  chevron.title = isCollapsed ? 'Expandir grupo' : 'Recolher grupo';
  chevron.addEventListener('click', (e) => {
    e.stopPropagation();
    state.groupCollapsed[groupDef.id] = !isCollapsed;
    saveState();
    render();
  });
  labelCell.appendChild(chevron);

  const label = document.createElement('span');
  label.className = 'label-text';
  label.textContent = `${groupDef.label} (${groupProjects.length})`;
  labelCell.appendChild(label);

  row.appendChild(labelCell);

  const timelineCell = document.createElement('div');
  timelineCell.className = 'timeline-cell';
  row.appendChild(timelineCell);

  gridEl.appendChild(row);
  return PROJECT_ROW_H;
}

function renderProjectRow(project, rangeStart) {
  const row = document.createElement('div');
  row.className = 'row project-row';

  const labelCell = document.createElement('div');
  labelCell.className = 'label-cell';

  const chevron = document.createElement('span');
  chevron.className = 'chevron' + (project.collapsed ? ' collapsed' : '');
  chevron.textContent = '▾';
  chevron.title = project.collapsed ? 'Expandir' : 'Recolher';
  chevron.addEventListener('click', (e) => {
    e.stopPropagation();
    project.collapsed = !project.collapsed;
    saveState();
    render();
  });
  labelCell.appendChild(chevron);

  const dot = document.createElement('span');
  dot.className = 'color-dot';
  dot.style.background = project.color;
  labelCell.appendChild(dot);

  const label = document.createElement('span');
  label.className = 'label-text';
  label.textContent = project.name;
  labelCell.appendChild(label);

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  actions.appendChild(iconButton('+', 'Nova workstream', () => openWorkstreamModal(project)));
  labelCell.appendChild(actions);

  // No mobile, o nome do projeto sempre cabe numa linha só: a sidebar já
  // cresce para o nome mais longo (computeMobileSidebarWidth), e aqui a
  // fonte reduz um pouco se ainda faltar espaço (ex.: nomes muito longos).
  if (isMobileLayout()) {
    const available = currentSidebarWidth - PROJECT_LABEL_CHROME_MOBILE;
    label.style.fontSize = fitProjectLabelFontSize(project.name, available) + 'px';
  }

  const mobileLabelHeight = isMobileLayout() ? measureLabelCellHeight(labelCell) : 0;
  row.appendChild(labelCell);

  const timelineCell = document.createElement('div');
  timelineCell.className = 'timeline-cell';

  // Quando o projeto está colapsado, os marcos continuam visíveis na linha
  // resumo (só as barras de tarefa somem) — assim os prazos-chave não se
  // perdem ao recolher. A altura da linha é calculada primeiro para que a
  // barra-resumo abaixo saiba onde posicionar os números de progresso.
  let rowHeight = Math.max(PROJECT_ROW_H, mobileLabelHeight);
  let milestonePlacements = [];
  let milestoneLaneCount = 1;
  if (project.collapsed) {
    const milestones = [];
    for (const w of project.workstreams) {
      for (const it of w.items) {
        if (it.type === 'milestone' && isKeyCollapsedMilestone(it)) milestones.push(it);
      }
    }
    if (milestones.length) {
      const { placements, laneCount } = packLanes(milestones);
      milestonePlacements = placements;
      milestoneLaneCount = laneCount;
      rowHeight = Math.max(PROJECT_ROW_H, mobileLabelHeight, laneCount * LANE_H + LANE_PAD);
    }
  }
  row.style.height = rowHeight + 'px';

  // Barra-resumo (span do projeto inteiro), colapsado ou não: mesma lógica
  // visual das barras de tarefa — cor do projeto de ponta a ponta, com um
  // realce translúcido cobrindo a fração já concluída (progress-fill) e os
  // mesmos números real/esperado usados nas barras de tarefa abaixo dela.
  // Sem nenhuma tarefa no projeto, cai de volta na linha fina ilustrativa.
  const allItems = project.workstreams.flatMap((w) => w.items);
  if (allItems.length) {
    let min = null, max = null;
    for (const it of allItems) {
      const s = parseDate(it.type === 'milestone' ? it.date : it.start);
      const e = parseDate(it.type === 'milestone' ? it.date : it.end);
      if (!min || s < min) min = s;
      if (!max || e > max) max = e;
    }
    const barLeft = diffDays(rangeStart, min) * currentPxPerDay;
    const barWidth = Math.max(4, (diffDays(min, max) + 1) * currentPxPerDay);
    const bar = document.createElement('div');
    bar.className = 'project-overview-bar';
    bar.style.left = barLeft + 'px';
    bar.style.width = barWidth + 'px';
    bar.style.background = project.color;

    const progress = computeProjectProgress(project);
    if (progress) {
      bar.style.overflow = 'hidden';
      const fill = document.createElement('div');
      fill.className = 'progress-fill';
      fill.style.width = progress.actual + '%';
      bar.appendChild(fill);
      timelineCell.appendChild(bar);
      timelineCell.appendChild(buildProgressNumbersEl(progress.actual, progress.expected, barLeft + barWidth / 2, rowHeight / 2 + 6));
    } else {
      bar.style.opacity = '0.30';
      timelineCell.appendChild(bar);
    }
  }

  // Colapsado não há barra de tarefa para alinhar (só a barra-resumo, que
  // fica centralizada via CSS em 50% da linha) — os losangos usam esse
  // centro da linha como referência, em vez do cálculo de raia normal, e
  // as raias extras (quando há mais de um marco no mesmo instante) se
  // distribuem simetricamente acima/abaixo desse centro. Um deslocamento
  // fixo sobe todos um pouco para não ficarem em cima da barra-resumo,
  // que agora é bem mais fina.
  const COLLAPSED_MILESTONE_LIFT = 8;
  const milestoneLabelLayout = resolveMilestoneLabelLayout(project, milestonePlacements, rangeStart);
  for (const { item, lane } of milestonePlacements) {
    const milestoneTop = rowHeight / 2 - COLLAPSED_MILESTONE_LIFT + (lane - (milestoneLaneCount - 1) / 2) * LANE_H;
    timelineCell.appendChild(renderMilestone(project, item, lane, rangeStart, milestoneLabelLayout.get(item), milestoneTop));
  }

  row.appendChild(timelineCell);
  gridEl.appendChild(row);
  return rowHeight;
}

function renderWorkstreamRow(project, ws, rangeStart) {
  const { placements, laneCount } = packLanes(ws.items);

  const labelCell = document.createElement('div');
  labelCell.className = 'label-cell';

  const label = document.createElement('span');
  label.className = 'label-text';
  label.textContent = ws.name;
  label.title = 'Clique para editar';
  label.addEventListener('click', (e) => {
    e.stopPropagation();
    openWorkstreamModal(project, ws);
  });
  labelCell.appendChild(label);

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  actions.appendChild(iconButton('✎', 'Editar workstream', () => openWorkstreamModal(project, ws), 'secondary-action'));
  actions.appendChild(iconButton('✕', 'Excluir workstream', () => confirmDeleteWorkstream(project, ws), 'secondary-action'));
  labelCell.appendChild(actions);

  const mobileLabelHeight = isMobileLayout() ? measureLabelCellHeight(labelCell) : 0;
  const rowHeight = Math.max(PROJECT_ROW_H, mobileLabelHeight, laneCount * LANE_H + LANE_PAD);

  const row = document.createElement('div');
  row.className = 'row workstream-row';
  row.style.height = rowHeight + 'px';
  row.appendChild(labelCell);

  const timelineCell = document.createElement('div');
  timelineCell.className = 'timeline-cell';

  const milestoneLabelLayout = resolveMilestoneLabelLayout(project, placements, rangeStart);
  for (const { item, lane } of placements) {
    if (item.type === 'task') {
      timelineCell.appendChild(renderTaskBar(project, item, lane, rangeStart));
    } else {
      timelineCell.appendChild(renderMilestone(project, item, lane, rangeStart, milestoneLabelLayout.get(item)));
    }
  }

  row.appendChild(timelineCell);
  gridEl.appendChild(row);
  return rowHeight;
}

function iconButton(symbol, title, onClick, extraClass) {
  const btn = document.createElement('button');
  btn.className = 'btn-icon' + (extraClass ? ' ' + extraClass : '');
  btn.textContent = symbol;
  btn.title = title;
  btn.type = 'button';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

function renderTaskBar(project, item, lane, rangeStart) {
  const start = parseDate(item.start);
  const end = parseDate(item.end);
  const left = diffDays(rangeStart, start) * currentPxPerDay;
  const width = Math.max(14, (diffDays(start, end) + 1) * currentPxPerDay);
  const top = LANE_PAD / 2 + lane * LANE_H + LANE_CONTENT_TOP;
  const actualProgress = Math.min(100, Math.max(0, item.progress || 0));
  const expectedProgress = computeExpectedProgress(item);

  const wrapper = document.createElement('div');
  wrapper.style.position = 'absolute';
  wrapper.style.left = '0';
  wrapper.style.top = '0';

  const bar = document.createElement('div');
  bar.className = 'task-bar';
  bar.style.left = left + 'px';
  bar.style.width = width + 'px';
  bar.style.top = top + 'px';
  bar.style.height = BAR_H + 'px';
  bar.style.background = project.color;

  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  fill.style.width = actualProgress + '%';
  bar.appendChild(fill);

  // O nome fica sempre dentro da barra; se não couber inteiro, é truncado
  // com reticências (ver overflow/text-overflow em .bar-label no CSS).
  const labelSpan = document.createElement('span');
  labelSpan.className = 'bar-label';
  labelSpan.textContent = item.name;
  bar.appendChild(labelSpan);

  bar.title = `${item.name}\n${formatBR(item.start)} → ${formatBR(item.end)}\n` +
    `Progresso real: ${actualProgress}%\nProgresso esperado (hoje): ${expectedProgress}%`;

  wrapper.appendChild(bar);

  // Dois números centralizados logo abaixo da barra: progresso real e o
  // progresso esperado hoje (com base no início/fim da tarefa).
  wrapper.appendChild(buildProgressNumbersEl(actualProgress, expectedProgress, left + width / 2, top + BAR_H + 2));

  return wrapper;
}

// Ícones de marco por tipo: "contrato" (documento com dobra e linhas de
// texto) e "fpso" (casco + superestrutura de navio) substituem o losango
// padrão para deixar visualmente óbvio o que aquele marco representa. Sem
// tipo definido (marco genérico), mantém o losango de sempre (via CSS).
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

// Projeto colapsado só mostra os marcos mais essenciais pra leitura rápida
// da linha do tempo: leilão, primeiro óleo (FPSO) e devolução do bloco já
// dizem o essencial do ciclo de vida; poços agregados ("N poços perfurados
// em YYYY") e marcos como Assinatura/FID ficam de fora, só reaparecem ao
// expandir o projeto.
function isKeyCollapsedMilestone(item) {
  if (item.icon === 'fpso') return true;
  if (item.icon === 'contract') return item.name === 'Leilão' || item.name === 'Devolução';
  if (item.icon === 'well') return item.name.startsWith('Poço pioneiro');
  return false;
}

// Tooltip de hover/clique do marco — mostra o nome completo (o rótulo
// sempre visível no gráfico é o simplificado, ver milestoneLabelOf) e os
// detalhes que antes só davam pra ver editando o marco (agora só leitura,
// ver "retirar edição" no histórico do repositório). Marco agregado de
// poços perfurados no ano ganha a quebra completa por tipo (produtor,
// gás, injetor, indício, seco, abandonado, sem registro — só as
// categorias com poço), calculada na hora a partir da base da ANP (ver
// wellCountBreakdown) — só aparece quando pocosDataApp já carregou, pra
// não mostrar contagem zerada enganosa antes do fetch terminar.
// Reaproveita o #popover, que não tinha nenhum
// outro uso na página.
function showMilestoneTooltip(dia, project, item, isPast) {
  const typeLabel = MILESTONE_TYPE_LABELS[item.icon] || 'Marco';
  let statusHTML = '';
  if (isPast) {
    statusHTML = item.done
      ? `<p class="milestone-tooltip-status" style="color:${MILESTONE_PAST_LABEL_COLOR}">Realizado</p>`
      : `<p class="milestone-tooltip-status" style="color:${MILESTONE_OVERDUE_LABEL_COLOR}">Atrasado (não realizado)</p>`;
  } else {
    statusHTML = '<p class="milestone-tooltip-status">Previsto</p>';
  }
  const approxHTML = item.approx
    ? '<p class="milestone-tooltip-approx">Data aproximada — só o mês era conhecido.</p>'
    : '';
  let breakdownHTML = '';
  const countMatch = item.name.match(WELL_COUNT_MILESTONE_RE);
  if (countMatch && Object.keys(pocosDataApp).length) {
    const counts = wellCountBreakdown(project, item.date.slice(0, 4));
    const parts = WELL_COUNT_LABELS
      .filter(([cat]) => counts[cat] > 0)
      .map(([cat, label]) => `${label}: ${counts[cat]}`);
    if (parts.length) {
      breakdownHTML = `<p class="milestone-tooltip-meta">${escapeHtml(parts.join(' · '))}</p>`;
    }
  }
  popoverEl.innerHTML = `
    <div class="milestone-tooltip">
      <h3>${escapeHtml(item.name)}</h3>
      <p class="milestone-tooltip-meta">${escapeHtml(typeLabel)} · ${formatBR(item.date)}</p>
      ${breakdownHTML}
      ${statusHTML}
      ${approxHTML}
    </div>`;
  popoverEl.hidden = false;
  popoverEl.classList.add('milestone-tooltip-popover');

  const rect = dia.getBoundingClientRect();
  const popRect = popoverEl.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - popRect.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - popRect.width - 8));
  let top = rect.top - popRect.height - 10;
  let arrowBelow = false;
  if (top < 8) {
    top = rect.bottom + 10;
    arrowBelow = true;
  }
  popoverEl.classList.toggle('arrow-below', arrowBelow);
  popoverEl.classList.toggle('arrow-above', !arrowBelow);
  popoverEl.style.left = left + 'px';
  popoverEl.style.top = top + 'px';
  // Seta aponta pro losango mesmo quando o tooltip precisa deslocar
  // horizontalmente pra não sair da tela (ver clamp de `left` acima).
  popoverEl.style.setProperty('--arrow-left', (rect.left + rect.width / 2 - left) + 'px');
}

function hideMilestoneTooltip() {
  popoverEl.hidden = true;
  popoverEl.classList.remove('milestone-tooltip-popover', 'arrow-below', 'arrow-above');
}
// Clique no marco já para a propagação (ver renderMilestone) — este
// listener só roda pra qualquer clique FORA de um marco, fechando um
// tooltip que ficou aberto por toque.
document.addEventListener('click', hideMilestoneTooltip);

function renderMilestone(project, item, lane, rangeStart, labelLayoutOverride, topOverride) {
  const date = parseDate(item.date);
  const isPast = date < parseDate(todayISO());
  const left = diffDays(rangeStart, date) * currentPxPerDay;
  // Por padrão, mesmo centro vertical usado pelas barras de tarefa na mesma
  // raia. topOverride (vindo da linha-resumo de projeto colapsado) centraliza
  // o losango na barra-resumo (que fica em 50% da linha via CSS) em vez de
  // usar o cálculo de raia, que não se aplica quando não há barra de tarefa.
  const top = topOverride !== undefined
    ? topOverride
    : LANE_PAD / 2 + lane * LANE_H + LANE_CONTENT_TOP + BAR_H / 2;

  const wrapper = document.createElement('div');
  wrapper.style.position = 'absolute';
  wrapper.style.left = '0';
  wrapper.style.top = '0';

  const iconBuilder = MILESTONE_ICON_BUILDERS[item.icon];
  const dia = document.createElement('div');
  dia.className = 'milestone' + (iconBuilder ? ` milestone-icon milestone-${item.icon}` : '');
  dia.style.left = left + 'px';
  dia.style.top = top + 'px';
  if (iconBuilder) {
    dia.innerHTML = iconBuilder(project.color);
  } else {
    dia.style.background = project.color;
  }
  // Marco já passado e realizado: ícone esmaecido. Já passado e NÃO
  // realizado (atrasado): mantém opacidade cheia, mas ganha borda vermelha.
  if (isPast) {
    if (item.done) {
      dia.style.opacity = '0.5';
    } else {
      dia.style.border = `2px solid ${MILESTONE_OVERDUE_LABEL_COLOR}`;
    }
  }
  // Sem title nativo: o hover mostra o tooltip rico (ver
  // showMilestoneTooltip), que já leva nome completo, data e status —
  // duplicar num title do navegador só criaria dois tooltips concorrendo.
  // Clique repete o mesmo conteúdo (stopPropagation pra não disparar o
  // listener de documento logo abaixo, que fecha o tooltip em qualquer
  // outro clique) — é o que dá acesso à mesma informação em touch, onde
  // não existe hover.
  dia.addEventListener('mouseenter', () => showMilestoneTooltip(dia, project, item, isPast));
  dia.addEventListener('mouseleave', hideMilestoneTooltip);
  dia.addEventListener('click', (e) => {
    e.stopPropagation();
    showMilestoneTooltip(dia, project, item, isPast);
  });

  // Rótulo sempre centralizado exatamente sobre o losango (não ao lado).
  // Marcos já passados e realizados ficam acinzentados (padrão de tarefa
  // concluída); já passados e NÃO realizados ficam em vermelho; marcos
  // futuros mantêm a cor padrão (preta) do CSS. Por padrão o rótulo fica
  // acima do losango; quando um marco vizinho na mesma raia está perto o
  // bastante para colidir, labelLayoutOverride (vindo de
  // resolveMilestoneLabelLayout) alterna esse marco para abaixo — a posição
  // horizontal nunca muda, continua centralizada na data real.
  const labelEl = document.createElement('span');
  labelEl.className = 'milestone-label';
  const simplifiedName = milestoneLabelOf(project, item);
  labelEl.textContent = simplifiedName;
  if (isPast) labelEl.style.color = item.done ? MILESTONE_PAST_LABEL_COLOR : MILESTONE_OVERDUE_LABEL_COLOR;

  const labelBoxWidth = milestoneLabelBoxWidth(simplifiedName);
  const labelLeft = Math.max(2, Math.min(left - labelBoxWidth / 2, currentTimelineWidth - labelBoxWidth - 2));
  labelEl.style.left = labelLeft + 'px';
  labelEl.style.width = labelBoxWidth + 'px';
  if (labelLayoutOverride && labelLayoutOverride.below) {
    labelEl.classList.add('below');
    labelEl.style.top = (top + 8) + 'px';
  } else {
    labelEl.style.top = (top - 8) + 'px';
  }

  wrapper.appendChild(dia);
  wrapper.appendChild(labelEl);
  return wrapper;
}

/* -------------------------------- Modals ---------------------------------- */

function closeModal() {
  modalOverlay.hidden = true;
  modalEl.innerHTML = '';
}
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modalOverlay.hidden) closeModal();
});

function openModalWith(html, wireFn) {
  modalEl.innerHTML = html;
  modalOverlay.hidden = false;
  wireFn(modalEl);
  const firstInput = modalEl.querySelector('input, textarea, select');
  if (firstInput) firstInput.focus();
}

function openWorkstreamModal(project, ws) {
  const isEdit = !!ws;
  const html = `
    <h2>${isEdit ? 'Editar workstream' : 'Nova workstream'}</h2>
    <p style="margin:-6px 0 14px;color:var(--text-muted);font-size:12px;">Projeto: <strong>${escapeHtml(project.name)}</strong></p>
    <div class="field">
      <label>Nome da workstream</label>
      <input type="text" id="f-name" value="${isEdit ? escapeAttr(ws.name) : ''}" placeholder="Ex: Arquitetura & Plataforma" />
    </div>
    <div class="modal-actions">
      <div>${isEdit ? '<button class="btn-danger" id="f-delete">Excluir workstream</button>' : ''}</div>
      <div class="modal-actions-right">
        <button class="btn-ghost" id="f-cancel">Cancelar</button>
        <button class="btn-primary" id="f-save">${isEdit ? 'Salvar' : 'Criar'}</button>
      </div>
    </div>`;
  openModalWith(html, (m) => {
    m.querySelector('#f-cancel').addEventListener('click', closeModal);
    if (isEdit) {
      m.querySelector('#f-delete').addEventListener('click', () => {
        closeModal();
        confirmDeleteWorkstream(project, ws);
      });
    }
    m.querySelector('#f-save').addEventListener('click', () => {
      const name = m.querySelector('#f-name').value.trim();
      if (!name) { showToast('Informe um nome para a workstream.'); return; }
      if (isEdit) {
        ws.name = name;
      } else {
        project.workstreams.push({ id: uid('ws'), name, items: [] });
      }
      saveState();
      render();
      closeModal();
      showToast(isEdit ? 'Workstream atualizada.' : 'Workstream criada.');
    });
  });
}

/* ------------------------------- Delete flows ------------------------------ */

function confirmDeleteWorkstream(project, ws) {
  if (!confirm(`Excluir a workstream "${ws.name}" e todos os seus itens?`)) return;
  project.workstreams = project.workstreams.filter((w) => w.id !== ws.id);
  saveState();
  render();
  showToast('Workstream excluída.');
}

/* --------------------------------- Utils ----------------------------------- */

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }

/* ------------------------------- Toolbar wiring ----------------------------- */

document.getElementById('scaleSwitch').addEventListener('click', (e) => {
  const btn = e.target.closest('.scale-btn');
  if (!btn) return;
  state.scale = btn.dataset.scale;
  state.pxPerDay = btn.dataset.scale === 'all' ? pxPerDayToFitAll() : SCALE_PX_PER_DAY[btn.dataset.scale];
  saveState();
  render();
  scrollContainer.scrollLeft = 0;
});

// Escala "Tudo": calcula o zoom mínimo necessário para que o intervalo
// inteiro de dados (mesmo cálculo de computeRange usado no render) caiba na
// largura de timeline realmente visível (descontando a sidebar), sem
// depender de rolagem.
function pxPerDayToFitAll() {
  const { rangeStart, rangeEnd } = computeRange();
  const totalDays = diffDays(rangeStart, rangeEnd);
  const visibleTimelineWidth = scrollContainer.clientWidth - getSidebarWidth();
  return clampPxPerDay(visibleTimelineWidth / totalDays);
}

/* ---- Zoom dinâmico com a roda do mouse, ancorado na posição do cursor ---- */
scrollContainer.addEventListener('wheel', (e) => {
  if (!currentRangeStart) return;
  e.preventDefault();

  const containerRect = scrollContainer.getBoundingClientRect();
  const mouseXInContent = scrollContainer.scrollLeft + (e.clientX - containerRect.left);
  const timelineX = mouseXInContent - currentSidebarWidth;
  const dayOffset = timelineX / currentPxPerDay;

  const zoomFactor = Math.exp(-e.deltaY * 0.0015);
  const newPxPerDay = clampPxPerDay(currentPxPerDay * zoomFactor);
  if (newPxPerDay === currentPxPerDay) return;

  state.pxPerDay = newPxPerDay;
  // O zoom livre da roda do mouse deixa de corresponder a qualquer preset do
  // seletor de escala (Mês/Trimestre/Ano/Tudo) — evita que um botão fique
  // marcado como ativo indevidamente depois do zoom manual.
  state.scale = null;
  saveState();
  render();

  const newTimelineX = dayOffset * currentPxPerDay;
  scrollContainer.scrollLeft = newTimelineX + currentSidebarWidth - (e.clientX - containerRect.left);
}, { passive: false });

/* ---- Clicar e arrastar para navegar na linha do tempo ---- */
scrollContainer.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const target = e.target;
  const isPannable = target === scrollContainer || target === gridEl ||
    target.classList.contains('timeline-cell') || target.classList.contains('roadmap-grid');
  if (!isPannable) return;

  const startX = e.clientX;
  const startY = e.clientY;
  const startScrollLeft = scrollContainer.scrollLeft;
  const startScrollTop = scrollContainer.scrollTop;
  let moved = false;

  function onMove(ev) {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      moved = true;
      scrollContainer.classList.add('panning');
    }
    scrollContainer.scrollLeft = startScrollLeft - dx;
    scrollContainer.scrollTop = startScrollTop - dy;
  }
  function onUp() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    scrollContainer.classList.remove('panning');
  }
  e.preventDefault();
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
});

// Re-centraliza os nomes das barras visíveis ao rolar (inclui o pan por
// clique-arrastar, que também dispara 'scroll') e ao redimensionar a janela.
scrollContainer.addEventListener('scroll', scheduleBarLabelUpdate);
let _lastViewportWidth = window.innerWidth;
window.addEventListener('resize', () => {
  // A largura da sidebar muda ao cruzar o breakpoint mobile/desktop, o que
  // afeta o layout inteiro (não só as posições dos rótulos das barras).
  // Qualquer mudança de largura também precisa re-renderizar porque o zoom
  // mínimo (que mantém o roadmap preenchendo a tela) depende dela.
  const widthChanged = window.innerWidth !== _lastViewportWidth;
  _lastViewportWidth = window.innerWidth;
  if (getSidebarWidth() !== currentSidebarWidth || widthChanged) {
    render();
  }
  scheduleBarLabelUpdate();
});

document.getElementById('todayBtn').addEventListener('click', () => {
  scrollToToday();
});

// Dois botões explícitos (em vez de um só alternando "Recolher"/"Expandir"
// conforme o estado) — mais claro quando o estado já está misto (alguns
// grupos/projetos recolhidos, outros não), caso em que um toggle único não
// deixa óbvio pra qual lado ele vai.
document.getElementById('collapseAllBtn').addEventListener('click', () => {
  for (const project of state.projects) project.collapsed = true;
  for (const groupDef of GROUP_DEFS) state.groupCollapsed[groupDef.id] = true;
  saveState();
  render();
});
document.getElementById('expandAllBtn').addEventListener('click', () => {
  for (const project of state.projects) project.collapsed = false;
  for (const groupDef of GROUP_DEFS) state.groupCollapsed[groupDef.id] = false;
  saveState();
  render();
});

function scrollToToday() {
  if (!currentRangeStart) return;
  const today = parseDate(todayISO());
  const x = currentSidebarWidth + diffDays(currentRangeStart, today) * currentPxPerDay;
  // A sidebar fica fixa (sticky) sobre a área visível, então o centro de
  // referência é o meio do espaço de timeline realmente visível (descontando
  // a sidebar), não o meio do container inteiro — senão "hoje" pode acabar
  // posicionado atrás da própria sidebar.
  const visibleTimelineWidth = scrollContainer.clientWidth - currentSidebarWidth;
  const targetScreenX = currentSidebarWidth + visibleTimelineWidth / 2;
  scrollContainer.scrollTo({
    left: Math.max(0, x - targetScreenX),
    behavior: 'smooth',
  });
}

document.getElementById('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `roadmap-pmo-${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('Roadmap exportado.');
});

document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importFile').click();
});
document.getElementById('importFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed || !Array.isArray(parsed.projects)) throw new Error('formato inválido');
      state = parsed;
      if (!state.scale) state.scale = 'all';
      saveState();
      render();
      showToast('Roadmap importado.');
    } catch (err) {
      showToast('Arquivo inválido. Verifique o JSON exportado.');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

/* ------------------------------ Importar Excel ----------------------------- */
// Formato esperado: uma linha por tarefa/marco, agrupados repetindo o nome
// do Projeto e da Workstream. Colunas (nomes flexíveis quanto a acento/caixa):
// Projeto | Cor | Workstream | Tipo (Tarefa/Marco) | Item | Início | Fim | Progresso | Data

const EXCEL_HEADER_ALIASES = {
  'projeto': 'projeto',
  'cor': 'cor',
  'workstream': 'workstream',
  'tipo': 'tipo',
  'item': 'item',
  'nome': 'item',
  'tarefa': 'item',
  'inicio': 'inicio',
  'data inicio': 'inicio',
  'data de inicio': 'inicio',
  'fim': 'fim',
  'data fim': 'fim',
  'data de fim': 'fim',
  'progresso': 'progresso',
  'progresso (%)': 'progresso',
  'data': 'data',
};

function normalizeHeaderKey(h) {
  return String(h).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function normalizeExcelRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    const norm = normalizeHeaderKey(key);
    const field = EXCEL_HEADER_ALIASES[norm] || norm;
    out[field] = value;
  }
  return out;
}

// Aceita células já convertidas em Date (SheetJS com cellDates:true), datas em
// texto "AAAA-MM-DD" ou no formato brasileiro "DD/MM/AAAA".
function excelValueToISO(value) {
  if (value instanceof Date) {
    return toISO(new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())));
  }
  const s = String(value == null ? '' : value).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`;
  return null;
}

// Agrupa as linhas planas da planilha em projetos > workstreams > itens,
// criando projetos/workstreams na primeira vez que seus nomes aparecem.
function excelRowsToProjects(rawRows) {
  const rows = rawRows.map(normalizeExcelRow);
  const projectsByName = new Map();
  const projects = [];
  let colorCursor = 0;
  let skipped = 0;

  for (const row of rows) {
    const projectName = String(row.projeto || '').trim();
    const wsName = String(row.workstream || '').trim();
    const itemName = String(row.item || '').trim();
    if (!projectName || !wsName || !itemName) { skipped++; continue; }

    let project = projectsByName.get(projectName);
    if (!project) {
      const colorCell = String(row.cor || '').trim();
      const color = /^#[0-9a-fA-F]{6}$/.test(colorCell) ? colorCell : PALETTE[colorCursor % PALETTE.length];
      colorCursor++;
      project = { id: uid('p'), name: projectName, color, collapsed: false, workstreams: [] };
      projectsByName.set(projectName, project);
      projects.push(project);
    }
    let ws = project.workstreams.find((w) => w.name === wsName);
    if (!ws) {
      ws = { id: uid('ws'), name: wsName, items: [] };
      project.workstreams.push(ws);
    }

    const tipo = normalizeHeaderKey(row.tipo || '');
    if (tipo.startsWith('marco') || tipo === 'milestone') {
      const date = excelValueToISO(row.data);
      if (!date) { skipped++; continue; }
      ws.items.push({ id: uid('m'), type: 'milestone', name: itemName, date });
    } else {
      const start = excelValueToISO(row.inicio);
      const end = excelValueToISO(row.fim);
      if (!start || !end || end < start) { skipped++; continue; }
      const progress = Math.min(100, Math.max(0, Math.round(Number(row.progresso) || 0)));
      ws.items.push({ id: uid('t'), type: 'task', name: itemName, start, end, progress });
    }
  }
  return { projects, skipped };
}

document.getElementById('importExcelBtn').addEventListener('click', () => {
  document.getElementById('importExcelFile').click();
});
document.getElementById('importExcelFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const workbook = XLSX.read(new Uint8Array(reader.result), { type: 'array', cellDates: true });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      const { projects, skipped } = excelRowsToProjects(rawRows);
      if (!projects.length) {
        showToast('Nenhuma linha válida encontrada. Baixe o "Modelo Excel" para ver o formato esperado.');
        return;
      }
      if (!confirm(`Importar substituirá o roadmap atual por ${projects.length} projeto(s) da planilha. Continuar?`)) return;
      state = { scale: state.scale || 'all', pxPerDay: state.pxPerDay || SCALE_PX_PER_DAY.year, projects };
      saveState();
      render();
      showToast(skipped ? `Roadmap importado (${skipped} linha(s) ignorada(s) por dados incompletos).` : 'Roadmap importado do Excel.');
    } catch (err) {
      console.warn('Falha ao importar Excel.', err);
      showToast('Não foi possível ler a planilha. Verifique se é um .xlsx válido.');
    }
  };
  reader.readAsArrayBuffer(file);
  e.target.value = '';
});

document.getElementById('templateExcelBtn').addEventListener('click', () => {
  const sampleRows = [
    { Projeto: 'Transformação Digital', Cor: '#3457d5', Workstream: 'Arquitetura & Plataforma', Tipo: 'Tarefa', Item: 'Levantamento de requisitos', 'Início': '2026-05-04', Fim: '2026-05-29', Progresso: 100, Data: '' },
    { Projeto: 'Transformação Digital', Cor: '#3457d5', Workstream: 'Arquitetura & Plataforma', Tipo: 'Marco', Item: 'Aprovação do comitê', 'Início': '', Fim: '', Progresso: '', Data: '2026-07-15' },
    { Projeto: 'Expansão Comercial', Cor: '#1c9e6b', Workstream: 'Novos Mercados', Tipo: 'Tarefa', Item: 'Estudo de viabilidade', 'Início': '2026-04-06', Fim: '2026-05-15', Progresso: 40, Data: '' },
  ];
  const sheet = XLSX.utils.json_to_sheet(sampleRows, {
    header: ['Projeto', 'Cor', 'Workstream', 'Tipo', 'Item', 'Início', 'Fim', 'Progresso', 'Data'],
  });
  sheet['!cols'] = [{ wch: 22 }, { wch: 9 }, { wch: 26 }, { wch: 9 }, { wch: 30 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 12 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Roadmap');
  XLSX.writeFile(workbook, 'modelo-roadmap-pmo.xlsx');
  showToast('Modelo baixado. Preencha uma linha por tarefa ou marco.');
});

/* ---------------------------------- Init ------------------------------------ */

// Rótulo/tooltip de marco de poço depende da base da ANP (ver
// wellMilestoneLabel, wellCountBreakdown) — carrega em paralelo com o
// primeiro render() (que já roda com pocosDataApp vazio, caindo no corte
// genérico até isso terminar) e manda um re-render assim que chegar.
fetch(POCOS_URL).then((r) => r.json()).then((d) => {
  pocosDataApp = d.pocos || {};
  render();
}).catch(() => {
  // Sem os dados da ANP, os marcos de poço seguem no rótulo genérico
  // (só corta parêntese/travessão) em vez de "código (operador)".
});

render();
setTimeout(scrollToToday, 50);
setInterval(render, 60000); // mantém a linha de "hoje" precisa com o passar do tempo

// Estado salvo em versão antiga: shared.js já mesclou automaticamente as
// workstreams/marcos novos de seedState() (só o que faltava) — avisa aqui
// porque showToast só existe depois que este arquivo carrega.
if (seedMigrationHappened) {
  showToast('Roadmap atualizado com novos marcos (ex.: poços exploratórios).');
}
