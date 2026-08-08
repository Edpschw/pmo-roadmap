'use strict';

/* =========================================================================
   PMO Roadmap — vanilla JS, sem dependências externas.
   Estado: projetos > workstreams > itens (tarefa | marco). Persistido em
   localStorage. Renderização reconstrói o DOM a cada mudança de estado
   (simples e suficiente para a escala de um roadmap de PMO).
   ========================================================================= */

const STORAGE_KEY = 'pmo-roadmap-state-v1';

const PALETTE = [
  '#3457d5', '#1c9e6b', '#e0762f', '#a24bd6', '#d64545',
  '#0aa3a3', '#c9a227', '#5b6ee1', '#2f9ed6', '#c14f8a'
];

const MONTHS_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const WEEKDAYS_PT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

const SCALE_PX_PER_DAY = { month: 6, quarter: 2.3, year: 1.0 };
const MIN_PX_PER_DAY = 0.35;
const MAX_PX_PER_DAY = 32;

const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif';
const MILESTONE_LABEL_FONT = '600 11px ' + FONT_STACK;
const PROGRESS_BADGE_FONT = '700 10.5px ' + FONT_STACK;

const _measureCanvas = document.createElement('canvas');
const _measureCtx = _measureCanvas.getContext('2d');
function measureTextWidth(text, font) {
  _measureCtx.font = font;
  return _measureCtx.measureText(text).width;
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

/* ------------------------------- Seed data ------------------------------ */

function seedState() {
  const t = (name, start, end, progress) => ({ id: uid('t'), type: 'task', name, start, end, progress });
  const m = (name, date) => ({ id: uid('m'), type: 'milestone', name, date });
  const ws = (name, items) => ({ id: uid('ws'), name, items });
  const proj = (name, color, workstreams) => ({ id: uid('p'), name, color, collapsed: false, workstreams });

  return {
    scale: 'month',
    pxPerDay: SCALE_PX_PER_DAY.month,
    projects: [
      proj('Transformação Digital', PALETTE[0], [
        ws('Arquitetura & Plataforma', [
          t('Levantamento de requisitos', '2026-05-04', '2026-05-29', 100),
          t('Desenho da arquitetura alvo', '2026-06-01', '2026-07-10', 80),
          m('Aprovação do comitê', '2026-07-15'),
          t('Migração para nuvem', '2026-07-16', '2026-10-30', 25),
        ]),
        ws('Dados & Integrações', [
          t('Mapeamento de fontes de dados', '2026-05-18', '2026-06-26', 100),
          t('Construção de pipelines ETL', '2026-06-29', '2026-09-18', 40),
          m('Go-live do data lake', '2026-09-25'),
        ]),
        ws('Change Management', [
          t('Plano de comunicação', '2026-06-08', '2026-07-03', 60),
          t('Treinamento de usuários-chave', '2026-09-01', '2026-10-16', 0),
        ]),
      ]),
      proj('Expansão Comercial', PALETTE[1], [
        ws('Novos Mercados', [
          t('Estudo de viabilidade — LATAM', '2026-04-06', '2026-05-15', 100),
          m('Decisão go/no-go', '2026-05-20'),
          t('Registro legal e fiscal', '2026-05-21', '2026-07-31', 55),
          t('Contratação de time local', '2026-07-01', '2026-09-11', 20),
        ]),
        ws('Parcerias Estratégicas', [
          t('Negociação com distribuidores', '2026-06-15', '2026-08-28', 45),
          m('Assinatura de contrato-âncora', '2026-09-02'),
        ]),
      ]),
      proj('Eficiência Operacional', PALETTE[2], [
        ws('Automação de Processos', [
          t('Mapeamento AS-IS', '2026-05-11', '2026-06-05', 100),
          t('Implantação de RPA — Financeiro', '2026-06-08', '2026-08-14', 65),
          t('Implantação de RPA — Suprimentos', '2026-08-17', '2026-10-23', 5),
        ]),
        ws('Qualidade & Governança', [
          m('Auditoria interna', '2026-07-10'),
          t('Padronização de KPIs', '2026-07-13', '2026-08-21', 30),
          t('Revisão de políticas de compliance', '2026-09-07', '2026-10-30', 0),
        ]),
      ]),
    ],
  };
}

/* -------------------------------- State -------------------------------- */

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.projects)) {
        if (!parsed.pxPerDay) parsed.pxPerDay = SCALE_PX_PER_DAY[parsed.scale] || SCALE_PX_PER_DAY.month;
        return parsed;
      }
    }
  } catch (e) {
    console.warn('Falha ao carregar estado salvo, usando dados de exemplo.', e);
  }
  return seedState();
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

/* -------------------------------- Render ---------------------------------- */

const SIDEBAR_WIDTH_DESKTOP = 300;
const SIDEBAR_WIDTH_MOBILE = 150;
const MOBILE_BREAKPOINT = 640;
function getSidebarWidth() {
  return window.innerWidth <= MOBILE_BREAKPOINT ? SIDEBAR_WIDTH_MOBILE : SIDEBAR_WIDTH_DESKTOP;
}
let currentSidebarWidth = getSidebarWidth();

const HEADER_H = 46;
const HEADER_TOP_TIER_H = 18;
const HEADER_BOTTOM_TIER_H = HEADER_H - HEADER_TOP_TIER_H;
const PROJECT_ROW_H = 44;
const BAR_H = 22;
// LANE_H acomoda a barra (topo da raia) + os dois números de progresso
// logo abaixo dela, sem invadir a raia seguinte.
const LANE_H = 40;
const LANE_CONTENT_TOP = 3;
// LANE_PAD reserva espaço extra acima da 1ª raia para caber o rótulo do
// marco (que fica acima do losango) sem invadir a linha anterior.
const LANE_PAD = 24;

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

  row.appendChild(labelCell);

  const timelineCell = document.createElement('div');
  timelineCell.className = 'timeline-cell';

  // barra-resumo (span do projeto inteiro), meramente ilustrativa
  const allItems = project.workstreams.flatMap((w) => w.items);
  if (allItems.length) {
    let min = null, max = null;
    for (const it of allItems) {
      const s = parseDate(it.type === 'milestone' ? it.date : it.start);
      const e = parseDate(it.type === 'milestone' ? it.date : it.end);
      if (!min || s < min) min = s;
      if (!max || e > max) max = e;
    }
    const bar = document.createElement('div');
    bar.className = 'project-overview-bar';
    bar.style.left = (diffDays(rangeStart, min) * currentPxPerDay) + 'px';
    bar.style.width = Math.max(4, (diffDays(min, max) + 1) * currentPxPerDay) + 'px';
    bar.style.background = project.color;
    bar.style.opacity = '0.30';
    timelineCell.appendChild(bar);
  }

  // Quando o projeto está colapsado, os marcos continuam visíveis na linha
  // resumo (só as barras de tarefa somem) — assim os prazos-chave não se
  // perdem ao recolher.
  let rowHeight = PROJECT_ROW_H;
  if (project.collapsed) {
    const milestones = [];
    const ownerByItem = new Map();
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
      rowHeight = Math.max(PROJECT_ROW_H, laneCount * LANE_H + LANE_PAD);
      for (const { item, lane } of placements) {
        timelineCell.appendChild(renderMilestone(project, ownerByItem.get(item), item, lane, rangeStart));
      }
    }
  }
  row.style.height = rowHeight + 'px';

  row.appendChild(timelineCell);
  gridEl.appendChild(row);
  return rowHeight;
}

function renderWorkstreamRow(project, ws, rangeStart) {
  const { placements, laneCount } = packLanes(ws.items);
  const rowHeight = Math.max(PROJECT_ROW_H, laneCount * LANE_H + LANE_PAD);

  const row = document.createElement('div');
  row.className = 'row workstream-row';
  row.style.height = rowHeight + 'px';

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

  row.appendChild(labelCell);

  const timelineCell = document.createElement('div');
  timelineCell.className = 'timeline-cell';

  for (const { item, lane } of placements) {
    if (item.type === 'task') {
      timelineCell.appendChild(renderTaskBar(project, ws, item, lane, rangeStart));
    } else {
      timelineCell.appendChild(renderMilestone(project, ws, item, lane, rangeStart));
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
  // progresso esperado hoje (com base no início/fim da tarefa). A cor do
  // número real sinaliza a situação frente ao esperado: verde (em dia ou
  // adiantado), laranja (até 10% atrasado), vermelho (mais de 10% atrasado)
  // ou cinza claro quando a tarefa já está 100% concluída.
  let actualClass;
  if (actualProgress === 100) {
    actualClass = 'complete';
  } else if (actualProgress >= expectedProgress) {
    actualClass = 'on-track';
  } else if (expectedProgress - actualProgress <= 10) {
    actualClass = 'slightly-behind';
  } else {
    actualClass = 'behind';
  }
  const numbers = document.createElement('div');
  numbers.className = 'progress-numbers';
  numbers.innerHTML =
    `<span class="actual ${actualClass}">${actualProgress}%</span>` +
    `<span class="sep">/</span>` +
    `<span class="expected">${expectedProgress}%</span>`;
  const numbersText = `${actualProgress}% / ${expectedProgress}%`;
  const numbersWidth = measureTextWidth(numbersText, PROGRESS_BADGE_FONT) + 6;
  const barCenter = left + width / 2;
  const numbersLeft = Math.max(2, Math.min(barCenter - numbersWidth / 2, currentTimelineWidth - numbersWidth - 2));
  numbers.style.left = numbersLeft + 'px';
  numbers.style.width = numbersWidth + 'px';
  numbers.style.top = (top + BAR_H + 2) + 'px';
  wrapper.appendChild(numbers);

  return wrapper;
}

function renderMilestone(project, ws, item, lane, rangeStart) {
  const date = parseDate(item.date);
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
  dia.title = `${item.name}\n${formatBR(item.date)}`;

  // Rótulo centralizado acima do losango (não ao lado), para não sobrepor
  // barras de tarefa que estejam na mesma raia ou em raias vizinhas.
  const labelEl = document.createElement('span');
  labelEl.className = 'milestone-label';
  labelEl.textContent = item.name;

  const textWidth = measureTextWidth(item.name, MILESTONE_LABEL_FONT);
  const labelBoxWidth = textWidth + 10;
  const labelLeft = Math.max(2, Math.min(left - labelBoxWidth / 2, currentTimelineWidth - labelBoxWidth - 2));
  labelEl.style.left = labelLeft + 'px';
  labelEl.style.width = labelBoxWidth + 'px';
  labelEl.style.top = (top - 8) + 'px';

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
      if (!name) { showToast('Informe um nome para o marco.'); return; }
      if (!d) { showToast('Informe a data do marco.'); return; }
      if (isEdit) {
        item.name = name; item.date = d;
      } else {
        ws.items.push({ id: uid('m'), type: 'milestone', name, date: d });
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

/* ---------------------------------- Init ------------------------------------ */

render();
setTimeout(scrollToToday, 50);
setInterval(render, 60000); // mantém a linha de "hoje" precisa com o passar do tempo
