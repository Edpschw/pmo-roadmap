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

const MIN_PX_PER_DAY = 0.35;
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
function formatTimeBR() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
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
  if (unit === 'month') return `${MONTHS_PT[boundary.getUTCMonth()]} ${boundary.getUTCFullYear()}`;
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

// O rótulo do marco fica sempre centralizado exatamente sobre o losango —
// nunca desloca horizontalmente, nem para desviar de barras de tarefa (isso
// já causou o rótulo "teleportando" para longe do marco). A única
// otimização: se colidir com o rótulo do marco anterior na mesma raia,
// alterna para abaixo do losango em vez de acima. Recebe os `placements` já
// calculados por packLanes() e devolve um Map item -> { below }.
function resolveMilestoneLabelLayout(placements, rangeStart) {
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
      const labelBoxWidth = milestoneLabelBoxWidth(item.name);
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
const PROJECT_LABEL_CHROME_MOBILE = 85;
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

function clampPxPerDay(v) {
  return Math.min(MAX_PX_PER_DAY, Math.max(MIN_PX_PER_DAY, v));
}

function syncScaleButtons() {
  document.querySelectorAll('.scale-btn').forEach((b) => {
    const preset = SCALE_PX_PER_DAY[b.dataset.scale];
    b.classList.toggle('active', Math.abs(preset - currentPxPerDay) < 0.02);
  });
}

function render() {
  const hasProjects = state.projects.length > 0;
  emptyStateEl.hidden = hasProjects;
  gridEl.style.display = hasProjects ? '' : 'none';
  if (!hasProjects) return;

  const { rangeStart, rangeEnd } = computeRange();
  currentRangeStart = rangeStart;
  currentPxPerDay = clampPxPerDay(state.pxPerDay || SCALE_PX_PER_DAY.month);
  const totalDays = diffDays(rangeStart, rangeEnd);
  const timelineWidth = totalDays * currentPxPerDay;
  currentTimelineWidth = timelineWidth;
  currentSidebarWidth = getSidebarWidth();
  document.documentElement.style.setProperty('--sidebar-w', currentSidebarWidth + 'px');
  applyResponsiveMetrics();
  document.documentElement.style.setProperty('--header-h', HEADER_H + 'px');
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

  // ---- Linhas de projeto / workstream ----
  let contentHeight = HEADER_H;

  for (const project of state.projects) {
    contentHeight += renderProjectRow(project, rangeStart);
    if (!project.collapsed) {
      for (const w of project.workstreams) {
        contentHeight += renderWorkstreamRow(project, w, rangeStart);
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
  if (today >= rangeStart && today <= rangeEnd) {
    const todayLeft = sidebarWidth + nowFractionalDayOffset(rangeStart) * currentPxPerDay;
    const todayLine = document.createElement('div');
    todayLine.className = 'today-line';
    todayLine.style.left = todayLeft + 'px';
    todayLine.style.height = (contentHeight - HEADER_H) + 'px';
    overlay.appendChild(todayLine);

    const flag = document.createElement('div');
    flag.className = 'today-flag';
    flag.style.left = todayLeft + 'px';
    flag.textContent = `Hoje ${formatTimeBR()}`;
    overlay.appendChild(flag);
  }

  gridEl.insertBefore(overlay, gridEl.firstChild);
  syncScaleButtons();
  updateBarLabelPositions();
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

let _labelUpdateScheduled = false;
function scheduleBarLabelUpdate() {
  if (_labelUpdateScheduled) return;
  _labelUpdateScheduled = true;
  requestAnimationFrame(() => {
    _labelUpdateScheduled = false;
    updateBarLabelPositions();
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
  label.title = 'Clique para editar';
  label.addEventListener('click', (e) => {
    e.stopPropagation();
    openProjectModal(project);
  });
  labelCell.appendChild(label);

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  actions.appendChild(iconButton('+', 'Nova workstream', () => openWorkstreamModal(project)));
  actions.appendChild(iconButton('✎', 'Editar projeto', () => openProjectModal(project), 'secondary-action'));
  actions.appendChild(iconButton('✕', 'Excluir projeto', () => confirmDeleteProject(project), 'secondary-action'));
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
  const ownerByItem = new Map();
  if (project.collapsed) {
    const milestones = [];
    for (const w of project.workstreams) {
      for (const it of w.items) {
        if (it.type === 'milestone') {
          milestones.push(it);
          ownerByItem.set(it, w);
        }
      }
    }
    if (milestones.length) {
      const { placements, laneCount } = packLanes(milestones);
      milestonePlacements = placements;
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

  const milestoneLabelLayout = resolveMilestoneLabelLayout(milestonePlacements, rangeStart);
  for (const { item, lane } of milestonePlacements) {
    timelineCell.appendChild(renderMilestone(project, ownerByItem.get(item), item, lane, rangeStart, milestoneLabelLayout.get(item)));
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
  actions.appendChild(iconButton('T', 'Nova tarefa', () => openTaskModal(project, ws)));
  actions.appendChild(iconButton('◆', 'Novo marco', () => openMilestoneModal(project, ws)));
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

  const milestoneLabelLayout = resolveMilestoneLabelLayout(placements, rangeStart);
  for (const { item, lane } of placements) {
    if (item.type === 'task') {
      timelineCell.appendChild(renderTaskBar(project, ws, item, lane, rangeStart));
    } else {
      timelineCell.appendChild(renderMilestone(project, ws, item, lane, rangeStart, milestoneLabelLayout.get(item)));
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

function renderTaskBar(project, ws, item, lane, rangeStart) {
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

  const handleLeft = document.createElement('div');
  handleLeft.className = 'handle left';
  bar.appendChild(handleLeft);
  const handleRight = document.createElement('div');
  handleRight.className = 'handle right';
  bar.appendChild(handleRight);

  bar.title = `${item.name}\n${formatBR(item.start)} → ${formatBR(item.end)}\n` +
    `Progresso real: ${actualProgress}%\nProgresso esperado (hoje): ${expectedProgress}%`;

  attachTaskDrag(bar, handleLeft, handleRight, project, ws, item);
  wrapper.appendChild(bar);

  // Dois números centralizados logo abaixo da barra: progresso real e o
  // progresso esperado hoje (com base no início/fim da tarefa).
  wrapper.appendChild(buildProgressNumbersEl(actualProgress, expectedProgress, left + width / 2, top + BAR_H + 2));

  return wrapper;
}

function renderMilestone(project, ws, item, lane, rangeStart, labelLayoutOverride) {
  const date = parseDate(item.date);
  const isPast = date < parseDate(todayISO());
  const left = diffDays(rangeStart, date) * currentPxPerDay;
  // Mesmo centro vertical usado pelas barras de tarefa na mesma raia.
  const top = LANE_PAD / 2 + lane * LANE_H + LANE_CONTENT_TOP + BAR_H / 2;

  const wrapper = document.createElement('div');
  wrapper.style.position = 'absolute';
  wrapper.style.left = '0';
  wrapper.style.top = '0';

  const dia = document.createElement('div');
  dia.className = 'milestone';
  dia.style.left = left + 'px';
  dia.style.top = top + 'px';
  dia.style.background = project.color;
  // Marco já passado e realizado: losango esmaecido. Já passado e NÃO
  // realizado (atrasado): mantém opacidade cheia, mas ganha borda vermelha.
  if (isPast) {
    if (item.done) {
      dia.style.opacity = '0.5';
    } else {
      dia.style.border = `2px solid ${MILESTONE_OVERDUE_LABEL_COLOR}`;
    }
  }
  dia.title = `${item.name}\n${formatBR(item.date)}` +
    (isPast ? (item.done ? '\nRealizado' : '\nAtrasado (não realizado)') : '');

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
  labelEl.textContent = item.name;
  if (isPast) labelEl.style.color = item.done ? MILESTONE_PAST_LABEL_COLOR : MILESTONE_OVERDUE_LABEL_COLOR;

  const labelBoxWidth = milestoneLabelBoxWidth(item.name);
  const labelLeft = Math.max(2, Math.min(left - labelBoxWidth / 2, currentTimelineWidth - labelBoxWidth - 2));
  labelEl.style.left = labelLeft + 'px';
  labelEl.style.width = labelBoxWidth + 'px';
  if (labelLayoutOverride && labelLayoutOverride.below) {
    labelEl.classList.add('below');
    labelEl.style.top = (top + 8) + 'px';
  } else {
    labelEl.style.top = (top - 8) + 'px';
  }

  attachMilestoneDrag(dia, project, ws, item);

  wrapper.appendChild(dia);
  wrapper.appendChild(labelEl);
  return wrapper;
}

/* ------------------------------- Drag logic ------------------------------- */

function attachTaskDrag(bar, handleLeft, handleRight, project, ws, item) {
  bar.addEventListener('pointerdown', (e) => startDrag(e, 'move'));
  handleLeft.addEventListener('pointerdown', (e) => startDrag(e, 'resize-left'));
  handleRight.addEventListener('pointerdown', (e) => startDrag(e, 'resize-right'));

  function startDrag(e, mode) {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const origStart = parseDate(item.start);
    const origEnd = parseDate(item.end);
    const origStartOffset = diffDays(currentRangeStart, origStart);
    const origEndOffset = diffDays(currentRangeStart, origEnd);
    let hasMoved = false;
    bar.classList.add('dragging');

    function onMove(ev) {
      const deltaPx = ev.clientX - startX;
      const deltaDays = Math.round(deltaPx / currentPxPerDay);
      if (deltaDays !== 0) hasMoved = true;

      let newStartOffset = origStartOffset;
      let newEndOffset = origEndOffset;
      if (mode === 'move') {
        newStartOffset = origStartOffset + deltaDays;
        newEndOffset = origEndOffset + deltaDays;
      } else if (mode === 'resize-left') {
        newStartOffset = Math.min(origStartOffset + deltaDays, origEndOffset);
      } else if (mode === 'resize-right') {
        newEndOffset = Math.max(origEndOffset + deltaDays, origStartOffset);
      }
      bar.style.left = (newStartOffset * currentPxPerDay) + 'px';
      bar.style.width = Math.max(14, (newEndOffset - newStartOffset + 1) * currentPxPerDay) + 'px';
      bar._pendingStartOffset = newStartOffset;
      bar._pendingEndOffset = newEndOffset;
    }

    function onUp(ev) {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      bar.classList.remove('dragging');

      if (hasMoved && bar._pendingStartOffset !== undefined) {
        item.start = toISO(addDays(currentRangeStart, bar._pendingStartOffset));
        item.end = toISO(addDays(currentRangeStart, bar._pendingEndOffset));
        saveState();
        render();
      } else if (!hasMoved) {
        openTaskModal(project, ws, item);
      }
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }
}

function attachMilestoneDrag(dia, project, ws, item) {
  dia.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const origOffset = diffDays(currentRangeStart, parseDate(item.date));
    let hasMoved = false;
    dia.classList.add('dragging');

    function onMove(ev) {
      const deltaPx = ev.clientX - startX;
      const deltaDays = Math.round(deltaPx / currentPxPerDay);
      if (deltaDays !== 0) hasMoved = true;
      const newOffset = origOffset + deltaDays;
      dia.style.left = (newOffset * currentPxPerDay) + 'px';
      dia._pendingOffset = newOffset;
    }
    function onUp(ev) {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      dia.classList.remove('dragging');
      if (hasMoved && dia._pendingOffset !== undefined) {
        item.date = toISO(addDays(currentRangeStart, dia._pendingOffset));
        saveState();
        render();
      } else if (!hasMoved) {
        openMilestoneModal(project, ws, item);
      }
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
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

function colorSwatchesHTML(selected) {
  return PALETTE.map((c) =>
    `<div class="color-swatch${c === selected ? ' selected' : ''}" data-color="${c}" style="background:${c}"></div>`
  ).join('');
}

function openProjectModal(project) {
  const isEdit = !!project;
  const color = project ? project.color : PALETTE[state.projects.length % PALETTE.length];
  const html = `
    <h2>${isEdit ? 'Editar projeto' : 'Novo projeto'}</h2>
    <div class="field">
      <label>Nome do projeto</label>
      <input type="text" id="f-name" value="${isEdit ? escapeAttr(project.name) : ''}" placeholder="Ex: Transformação Digital" />
    </div>
    <div class="field">
      <label>Cor</label>
      <div class="color-grid" id="f-color-grid">${colorSwatchesHTML(color)}</div>
    </div>
    <div class="modal-actions">
      <div>${isEdit ? '<button class="btn-danger" id="f-delete">Excluir projeto</button>' : ''}</div>
      <div class="modal-actions-right">
        <button class="btn-ghost" id="f-cancel">Cancelar</button>
        <button class="btn-primary" id="f-save">${isEdit ? 'Salvar' : 'Criar'}</button>
      </div>
    </div>`;
  openModalWith(html, (m) => {
    let selectedColor = color;
    m.querySelector('#f-color-grid').addEventListener('click', (e) => {
      const sw = e.target.closest('.color-swatch');
      if (!sw) return;
      selectedColor = sw.dataset.color;
      m.querySelectorAll('.color-swatch').forEach((s) => s.classList.toggle('selected', s === sw));
    });
    m.querySelector('#f-cancel').addEventListener('click', closeModal);
    if (isEdit) {
      m.querySelector('#f-delete').addEventListener('click', () => {
        closeModal();
        confirmDeleteProject(project);
      });
    }
    m.querySelector('#f-save').addEventListener('click', () => {
      const name = m.querySelector('#f-name').value.trim();
      if (!name) { showToast('Informe um nome para o projeto.'); return; }
      if (isEdit) {
        project.name = name;
        project.color = selectedColor;
      } else {
        state.projects.push({ id: uid('p'), name, color: selectedColor, collapsed: false, workstreams: [] });
      }
      saveState();
      render();
      closeModal();
      showToast(isEdit ? 'Projeto atualizado.' : 'Projeto criado.');
    });
  });
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

function openTaskModal(project, ws, item) {
  const isEdit = !!item;
  const today = todayISO();
  const start = isEdit ? item.start : today;
  const end = isEdit ? item.end : toISO(addDays(parseDate(today), 14));
  const progress = isEdit ? (item.progress || 0) : 0;
  const html = `
    <h2>${isEdit ? 'Editar tarefa' : 'Nova tarefa'}</h2>
    <p style="margin:-6px 0 14px;color:var(--text-muted);font-size:12px;">${escapeHtml(project.name)} / ${escapeHtml(ws.name)}</p>
    <div class="field">
      <label>Nome da tarefa</label>
      <input type="text" id="f-name" value="${isEdit ? escapeAttr(item.name) : ''}" placeholder="Ex: Levantamento de requisitos" />
    </div>
    <div class="field-row">
      <div class="field">
        <label>Início</label>
        <input type="date" id="f-start" value="${start}" />
      </div>
      <div class="field">
        <label>Fim</label>
        <input type="date" id="f-end" value="${end}" />
      </div>
    </div>
    <div class="field">
      <label>Progresso: <span class="progress-value" id="f-progress-val">${progress}%</span></label>
      <input type="range" id="f-progress" min="0" max="100" step="5" value="${progress}" />
    </div>
    <div class="modal-actions">
      <div>${isEdit ? '<button class="btn-danger" id="f-delete">Excluir tarefa</button>' : ''}</div>
      <div class="modal-actions-right">
        <button class="btn-ghost" id="f-cancel">Cancelar</button>
        <button class="btn-primary" id="f-save">${isEdit ? 'Salvar' : 'Criar'}</button>
      </div>
    </div>`;
  openModalWith(html, (m) => {
    m.querySelector('#f-progress').addEventListener('input', (e) => {
      m.querySelector('#f-progress-val').textContent = e.target.value + '%';
    });
    m.querySelector('#f-cancel').addEventListener('click', closeModal);
    if (isEdit) {
      m.querySelector('#f-delete').addEventListener('click', () => {
        closeModal();
        confirmDeleteItem(project, ws, item, 'tarefa');
      });
    }
    m.querySelector('#f-save').addEventListener('click', () => {
      const name = m.querySelector('#f-name').value.trim();
      const s = m.querySelector('#f-start').value;
      const e = m.querySelector('#f-end').value;
      const p = Number(m.querySelector('#f-progress').value);
      if (!name) { showToast('Informe um nome para a tarefa.'); return; }
      if (!s || !e) { showToast('Informe as datas de início e fim.'); return; }
      if (e < s) { showToast('A data de fim não pode ser anterior ao início.'); return; }
      if (isEdit) {
        item.name = name; item.start = s; item.end = e; item.progress = p;
      } else {
        ws.items.push({ id: uid('t'), type: 'task', name, start: s, end: e, progress: p });
      }
      saveState();
      render();
      closeModal();
      showToast(isEdit ? 'Tarefa atualizada.' : 'Tarefa criada.');
    });
  });
}

function openMilestoneModal(project, ws, item) {
  const isEdit = !!item;
  const date = isEdit ? item.date : todayISO();
  const html = `
    <h2>${isEdit ? 'Editar marco' : 'Novo marco'}</h2>
    <p style="margin:-6px 0 14px;color:var(--text-muted);font-size:12px;">${escapeHtml(project.name)} / ${escapeHtml(ws.name)}</p>
    <div class="field">
      <label>Nome do marco</label>
      <input type="text" id="f-name" value="${isEdit ? escapeAttr(item.name) : ''}" placeholder="Ex: Aprovação do comitê" />
    </div>
    <div class="field">
      <label>Data</label>
      <input type="date" id="f-date" value="${date}" />
    </div>
    <div class="field field-checkbox">
      <label><input type="checkbox" id="f-done" ${isEdit && item.done ? 'checked' : ''} /> Marco realizado</label>
    </div>
    <div class="modal-actions">
      <div>${isEdit ? '<button class="btn-danger" id="f-delete">Excluir marco</button>' : ''}</div>
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
        confirmDeleteItem(project, ws, item, 'marco');
      });
    }
    m.querySelector('#f-save').addEventListener('click', () => {
      const name = m.querySelector('#f-name').value.trim();
      const d = m.querySelector('#f-date').value;
      const done = m.querySelector('#f-done').checked;
      if (!name) { showToast('Informe um nome para o marco.'); return; }
      if (!d) { showToast('Informe a data do marco.'); return; }
      if (isEdit) {
        item.name = name; item.date = d; item.done = done;
      } else {
        ws.items.push({ id: uid('m'), type: 'milestone', name, date: d, done });
      }
      saveState();
      render();
      closeModal();
      showToast(isEdit ? 'Marco atualizado.' : 'Marco criado.');
    });
  });
}

/* ------------------------------- Delete flows ------------------------------ */

function confirmDeleteProject(project) {
  if (!confirm(`Excluir o projeto "${project.name}" e todas as suas workstreams?`)) return;
  state.projects = state.projects.filter((p) => p.id !== project.id);
  saveState();
  render();
  showToast('Projeto excluído.');
}

function confirmDeleteWorkstream(project, ws) {
  if (!confirm(`Excluir a workstream "${ws.name}" e todos os seus itens?`)) return;
  project.workstreams = project.workstreams.filter((w) => w.id !== ws.id);
  saveState();
  render();
  showToast('Workstream excluída.');
}

function confirmDeleteItem(project, ws, item, kindLabel) {
  if (!confirm(`Excluir ${kindLabel} "${item.name}"?`)) return;
  ws.items = ws.items.filter((i) => i.id !== item.id);
  saveState();
  render();
  showToast(kindLabel[0].toUpperCase() + kindLabel.slice(1) + ' excluído(a).');
}

/* --------------------------------- Utils ----------------------------------- */

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }

/* ------------------------------- Toolbar wiring ----------------------------- */

document.getElementById('addProjectBtn').addEventListener('click', () => openProjectModal(null));
document.getElementById('emptyAddProjectBtn').addEventListener('click', () => openProjectModal(null));

document.getElementById('scaleSwitch').addEventListener('click', (e) => {
  const btn = e.target.closest('.scale-btn');
  if (!btn) return;
  state.scale = btn.dataset.scale;
  state.pxPerDay = SCALE_PX_PER_DAY[btn.dataset.scale];
  saveState();
  render();
});

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
window.addEventListener('resize', () => {
  // A largura da sidebar muda ao cruzar o breakpoint mobile/desktop, o que
  // afeta o layout inteiro (não só as posições dos rótulos das barras).
  if (getSidebarWidth() !== currentSidebarWidth) {
    render();
  }
  scheduleBarLabelUpdate();
});

document.getElementById('todayBtn').addEventListener('click', () => {
  scrollToToday();
});

function scrollToToday() {
  if (!currentRangeStart) return;
  const today = parseDate(todayISO());
  const x = currentSidebarWidth + diffDays(currentRangeStart, today) * currentPxPerDay;
  scrollContainer.scrollTo({
    left: Math.max(0, x - scrollContainer.clientWidth / 2),
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
      if (!state.scale) state.scale = 'month';
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
      state = { scale: state.scale || 'month', pxPerDay: state.pxPerDay || SCALE_PX_PER_DAY.month, projects };
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

render();
setTimeout(scrollToToday, 50);
setInterval(render, 60000); // mantém a linha de "hoje" precisa com o passar do tempo
