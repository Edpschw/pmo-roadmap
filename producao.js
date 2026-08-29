'use strict';

/* =========================================================================
   PMO Roadmap — Produção. Produção mensal de petróleo e gás natural dos
   campos do pré-sal, direto do Boletim da Produção de Petróleo e Gás
   Natural (BMP) da ANP (data/producao.json, gerado por
   scripts/parse_producao.py a partir do PDF oficial — ver esse script para
   atualizar com um mês novo). Diferente da aba Análises (que é STOIIP/
   volume in-place, do Plano de Desenvolvimento — um número fixo por
   jazida, não muda mês a mês): aqui é vazão de produção real, por mês.
   Infra de gráfico (tooltip, fmtNum, chartCard, barRow,
   CONTEXT_FIELD_COLOR) vem de shared.js — compartilhada com analises.js.
   ========================================================================= */

const PRODUCAO_URL = 'data/producao.json';

const MESES_PT = [
  '', 'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

const METRIC_KEYS = ['oleoPreSalBbld', 'oleoPosSalBbld', 'gasPreSalMm3d', 'gasPosSalMm3d', 'boedPreSal', 'boedPosSal'];

// Campo-base do boletim da ANP de cada projeto rastreado com produção
// própria — casado por SUBSTRING contra as chaves de data/producao.json
// (nome do campo como a ANP publica), não por igualdade exata. Motivo: a
// granularidade da tabela varia por edição do boletim — meses mais
// recentes trazem só "Atapu", outros trazem "Atapu" + "Oeste de Atapu" +
// "Anc_Norte_Atapu" (Área Não Contratada) como linhas separadas da MESMA
// jazida/contrato (confirmado pela ligação de poço->campo já usada no
// roadmap, ver contractOwnWells em shared.js: poços de Atapu citam
// "Atapu / Atapu_Eco / Anc_Norte_Atapu / Oeste De Atapu" juntos). Casar por
// substring soma essas sub-áreas automaticamente em qualquer mês, sem
// precisar listar cada variante à mão. Norte de Carcará é o único caso
// que soma duas jazidas por nome DIFERENTE ("Bacalhau Norte", dentro do
// CPP rastreado aqui, + "Bacalhau", Concessão anterior e fora dele) — "
// Bacalhau" como base já casa as duas por conter a substring, mesmo
// critério já usado no roadmap para "Poços Perfurados" desse contrato (ver
// v11 em shared.js: a jazida inteira é o que importa acompanhar). Os
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
};

function emptyMetrics() {
  const m = {};
  for (const k of METRIC_KEYS) m[k] = 0;
  return m;
}

/* ------------------------------ Linhas por campo -------------------------- */

// Um projeto rastreado por campo-base (soma por substring, ver
// PROJECT_FIELD_BASE) mapeado; os demais campos do boletim (Tupi,
// Berbigão, Jubarte, Lapa...) entram como contexto — mesmo campo pré-sal,
// mas fora dos 30 contratos de partilha rastreados neste app
// (Concessão/Cessão Onerosa sem CPP próprio nesta lista), mesmo padrão de
// contexto usado em analises.js. "campos" tem o mesmo formato num mês só
// (data/producao.json) ou já com métricas médias de um ano (ver
// averageCampos) — esta função não distingue os dois.
function computeFieldRows(campos, projects) {
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
    });
  }

  for (const [nome, dados] of Object.entries(campos)) {
    if (usedFieldNames.has(nome)) continue;
    rows.push({ name: nome, color: CONTEXT_FIELD_COLOR, isContract: false, parts: [{ nome, dados }], ...dados });
  }

  return rows;
}

/* ------------------------------ Série mensal -------------------------------- */
// "produção diária por mês" — sem agregação nenhuma: um ponto por mês do
// boletim, com o valor exatamente como a ANP publicou naquele mês (bbl/d,
// Mm³/d ou boe/d — já é uma vazão diária, não precisa converter nada).

// Uma linha "Outros campos" por mês, somando todos os campos de contexto
// (fora dos 7 contratos rastreados com produção própria) — o gráfico
// mostra só os contratos rastreados + essa linha combinada, não uma linha
// por campo de contexto (seriam ~20 linhas minúsculas, ilegível).
function collapseContext(rows) {
  const tracked = rows.filter((r) => r.isContract);
  const contextRows = rows.filter((r) => !r.isContract);
  if (!contextRows.length) return tracked;
  const sum = emptyMetrics();
  for (const r of contextRows) {
    for (const k of METRIC_KEYS) sum[k] += r[k];
  }
  tracked.push({ name: 'Outros campos (contexto)', color: CONTEXT_FIELD_COLOR, isContract: false, parts: contextRows, ...sum });
  return tracked;
}

function computeMonthlySeries(meses, projects) {
  return meses.map((mes) => ({
    ano: mes.ano,
    mes: mes.mes,
    rows: collapseContext(computeFieldRows(mes.campos, projects)),
  }));
}

/* -------------------------------- KPIs ------------------------------------ */

function renderProducaoKpis(container, rows, mesRef) {
  const totalBoed = rows.reduce((s, r) => s + r.boedPreSal, 0);
  const contratosBoed = rows.filter((r) => r.isContract).reduce((s, r) => s + r.boedPreSal, 0);
  const totalOleo = rows.reduce((s, r) => s + r.oleoPreSalBbld, 0);
  const totalGas = rows.reduce((s, r) => s + r.gasPreSalMm3d, 0);

  const row = document.createElement('div');
  row.className = 'kpi-row';
  row.appendChild(statTileP('Mês de referência', `${MESES_PT[mesRef.mes]}/${mesRef.ano}`, 'ANP — Boletim da Produção (pré-sal)'));
  row.appendChild(statTileP('Produção pré-sal total', fmtNum(totalBoed) + ' boe/d', `${fmtNum(totalOleo)} bbl/d óleo · ${fmtNum(totalGas, { maximumFractionDigits: 1 })} Mm³/d gás`));
  row.appendChild(statTileP('Nos contratos rastreados', fmtNum(contratosBoed) + ' boe/d', `${((contratosBoed / totalBoed) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% do pré-sal`));
  row.appendChild(statTileP('Campos no boletim', String(rows.length), `${rows.filter((r) => r.isContract).length} contratos rastreados · ${rows.filter((r) => !r.isContract).length} de contexto`));
  container.appendChild(row);
}

function statTileP(label, value, sub) {
  const div = document.createElement('div');
  div.className = 'stat-tile';
  const l = document.createElement('div');
  l.className = 'stat-tile-label';
  l.textContent = label;
  const v = document.createElement('div');
  v.className = 'stat-tile-value';
  v.textContent = value;
  div.appendChild(l);
  div.appendChild(v);
  if (sub) {
    const s = document.createElement('div');
    s.className = 'stat-tile-sub';
    s.textContent = sub;
    div.appendChild(s);
  }
  return div;
}

/* ------------------------------- Gráfico de barras ------------------------- */
// barRow/attachTooltip/tooltipRowHTML/chartCard vêm de shared.js.

function renderProductionChart(container, rows, unitKey) {
  const unit = UNITS[unitKey];
  const sorted = [...rows].filter((r) => r[unit.key] > 0).sort((a, b) => b[unit.key] - a[unit.key]);
  if (!sorted.length) return;
  const max = Math.max(...sorted.map((r) => r[unit.key]));

  const list = document.createElement('div');
  list.className = 'hbar-list';
  for (const r of sorted) {
    const multi = r.parts.length > 1;
    list.appendChild(barRow(
      r.name, (r[unit.key] / max) * 100, unit.fmt(r[unit.key]), r.color,
      () => `<strong>${escapeHtml(r.name)}</strong>`
        + tooltipRowHTML('Petróleo', fmtNum(r.oleoPreSalBbld) + ' bbl/d')
        + tooltipRowHTML('Gás natural', fmtNum(r.gasPreSalMm3d, { maximumFractionDigits: 1 }) + ' Mm³/d')
        + tooltipRowHTML('Produção', fmtNum(r.boedPreSal) + ' boe/d')
        + (r.isContract ? '' : tooltipRowHTML('Contrato', 'Fora dos 30 rastreados (contexto)'))
        + (multi ? `<div class="viz-tooltip-row"><span>${escapeHtml(r.parts.map((p) => p.nome).join(' + '))}</span></div>` : ''),
    ));
  }
  container.appendChild(list);
}

/* ------------------------------ Seletor de unidade ------------------------- */

function buildUnitSwitch(onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'scale-switch analytics-tab-switch';
  Object.entries(UNITS).forEach(([key, u], i) => {
    const btn = document.createElement('button');
    btn.className = 'scale-btn' + (i === 0 ? ' active' : '');
    btn.textContent = u.label;
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

/* ------------------------------ Gráfico de linhas --------------------------- */
// Uma linha por campo — eixo x é o mês do boletim (todos os pontos
// disponíveis, sem agregar), eixo y é a vazão diária na unidade escolhida.

const MES_ABREV = ['', 'jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const LINE_W = 900;
const LINE_H = 420;
const LINE_MARGIN = { top: 16, right: 16, bottom: 62, left: 64 };

function niceMax(v) {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

// Ordem fixa das linhas (mesma cor sempre no mesmo campo entre trocas de
// unidade) — projeto rastreado por ordem de aparição em state.projects
// (mesma ordem do roadmap/análises), "Outros campos" sempre por último.
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

function renderMonthlyLineChart(container, monthlySeries, unitKey) {
  const unit = UNITS[unitKey];
  const order = seriesOrder(monthlySeries);
  const n = monthlySeries.length;
  const rowByName = (m, name) => m.rows.find((r) => r.name === name);
  const maxVal = niceMax(Math.max(...monthlySeries.flatMap((m) => m.rows.map((r) => r[unit.key])), 0));

  const plotW = LINE_W - LINE_MARGIN.left - LINE_MARGIN.right;
  const plotH = LINE_H - LINE_MARGIN.top - LINE_MARGIN.bottom;
  const xAt = (i) => LINE_MARGIN.left + (n > 1 ? (plotW * i) / (n - 1) : plotW / 2);
  const yAt = (v) => LINE_MARGIN.top + plotH - (v / maxVal) * plotH;

  const yTicks = 5;
  let gridSvg = '';
  for (let i = 0; i <= yTicks; i++) {
    const v = (maxVal / yTicks) * i;
    const y = yAt(v);
    gridSvg += `<line x1="${LINE_MARGIN.left}" y1="${y}" x2="${LINE_W - LINE_MARGIN.right}" y2="${y}" stroke="var(--border)" stroke-width="1" />`;
    gridSvg += `<text x="${LINE_MARGIN.left - 10}" y="${y + 4}" text-anchor="end" font-size="11" style="fill:var(--text-faint)">${fmtNum(v)}</text>`;
  }

  // Rótulo do eixo x só em janeiro de cada ano (+ o último mês, se não for
  // janeiro) — com muitos meses (a base cobre 2017-2026, >100 pontos),
  // rotular todo mês vira ilegível; ano completo já orienta a leitura da
  // tendência, e o ponto exato de cada mês continua no tooltip ao passar
  // o mouse/focar. Uma linha vertical fina marca a virada de ano no fundo
  // do gráfico, alinhada com o rótulo.
  let xLabelsSvg = '';
  monthlySeries.forEach((m, i) => {
    const isLast = i === monthlySeries.length - 1;
    if (m.mes !== 1 && !isLast) return;
    const x = xAt(i);
    const label = m.mes === 1 ? String(m.ano) : `${MES_ABREV[m.mes]}/${String(m.ano).slice(2)}`;
    const y = LINE_MARGIN.top + plotH + 14;
    xLabelsSvg += `<line x1="${x}" y1="${LINE_MARGIN.top}" x2="${x}" y2="${LINE_MARGIN.top + plotH}" stroke="var(--border)" stroke-width="1" stroke-dasharray="2,3" />`;
    xLabelsSvg += `<text x="0" y="0" transform="translate(${x} ${y}) rotate(-45)" text-anchor="end" font-size="11" style="fill:var(--text-muted)">${label}</text>`;
  });

  let linesSvg = '';
  let dotsSvg = '';
  const dotMeta = [];
  const dotR = n > 40 ? 2 : 3;
  for (const name of order) {
    const color = monthlySeries.map((m) => rowByName(m, name)).find(Boolean).color;
    const pts = [];
    monthlySeries.forEach((m, i) => {
      const r = rowByName(m, name);
      if (!r) return;
      const x = xAt(i);
      const y = yAt(r[unit.key]);
      pts.push(`${x},${y}`);
      const id = `dot_${order.indexOf(name)}_${i}`;
      dotsSvg += `<circle id="${id}" cx="${x}" cy="${y}" r="${dotR}" fill="${color}" tabindex="0" style="cursor:pointer" />`;
      dotMeta.push({ id, name, color, value: r[unit.key], mes: m.mes, ano: m.ano, isContract: r.isContract });
    });
    if (pts.length) {
      linesSvg += `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`;
    }
  }

  const axisSvg = `<line x1="${LINE_MARGIN.left}" y1="${LINE_MARGIN.top + plotH}" x2="${LINE_W - LINE_MARGIN.right}" y2="${LINE_MARGIN.top + plotH}" stroke="var(--border-strong)" stroke-width="1" />`;

  const svgWrap = document.createElement('div');
  svgWrap.innerHTML = `<svg viewBox="0 0 ${LINE_W} ${LINE_H}" style="width:100%;height:auto;display:block">${gridSvg}${axisSvg}${xLabelsSvg}${linesSvg}${dotsSvg}</svg>`;
  const svgEl = svgWrap.firstElementChild;

  for (const meta of dotMeta) {
    const el = svgEl.querySelector(`#${meta.id}`);
    if (!el) continue;
    attachTooltip(el, () => `<strong>${escapeHtml(meta.name)}</strong>`
      + tooltipRowHTML('Mês', `${MESES_PT[meta.mes]}/${meta.ano}`)
      + tooltipRowHTML(unit.label, unit.fmt(meta.value))
      + (meta.isContract ? '' : tooltipRowHTML('Contrato', 'Fora dos 7 com produção própria rastreados')));
  }

  container.appendChild(svgWrap);

  const legend = document.createElement('div');
  legend.className = 'kpi-row';
  legend.style.marginTop = '10px';
  for (const name of order) {
    const sample = monthlySeries.map((m) => rowByName(m, name)).find(Boolean);
    if (!sample) continue;
    const item = document.createElement('div');
    item.style.display = 'flex';
    item.style.alignItems = 'center';
    item.style.gap = '6px';
    item.style.fontSize = '12px';
    item.style.color = 'var(--text-muted)';
    item.innerHTML = `<span style="width:16px;height:2px;background:${sample.color};flex:0 0 auto"></span>${escapeHtml(name)}`;
    legend.appendChild(item);
  }
  container.appendChild(legend);
}

/* -------------------------------- Seções ------------------------------ */

function buildMonthlySection(producaoData) {
  const mesRef = producaoData.meses[producaoData.meses.length - 1];
  const rows = computeFieldRows(mesRef.campos, state.projects);

  const section = document.createElement('section');
  section.className = 'analytics-section';
  renderProducaoKpis(section, rows, mesRef);

  const card = chartCard(
    'Produção por campo — pré-sal',
    'Os contratos rastreados (cor do projeto) e os demais campos do pré-sal em produção fora desta lista (cinza, contexto). Só a fração pré-sal de cada campo — a fração pós-sal (quando existe) fica de fora.',
  );
  const unitSwitch = buildUnitSwitch((unitKey) => {
    const list = card.querySelector('.hbar-list');
    if (list) list.remove();
    renderProductionChart(card, rows, unitKey);
  });
  card.insertBefore(unitSwitch, card.querySelector('h3').nextSibling);
  renderProductionChart(card, rows, 'oleo');
  section.appendChild(card);

  const note = document.createElement('p');
  note.className = 'analytics-table-note';
  note.textContent = `Fonte: ${producaoData.fonte.nome}, edição de ${MESES_PT[mesRef.mes]}/${mesRef.ano}.`;
  section.appendChild(note);

  return section;
}

function buildEvolutionSection(producaoData) {
  const monthlySeries = computeMonthlySeries(producaoData.meses, state.projects);

  const section = document.createElement('section');
  section.className = 'analytics-section';

  const first = producaoData.meses[0];
  const last = producaoData.meses[producaoData.meses.length - 1];
  const seen = new Set(producaoData.meses.map((m) => `${m.ano}-${m.mes}`));
  let gaps = 0;
  for (let y = first.ano, m = first.mes; y < last.ano || (y === last.ano && m <= last.mes); m++) {
    if (m > 12) { m = 1; y++; }
    if (!seen.has(`${y}-${m}`)) gaps++;
  }
  const row = document.createElement('div');
  row.className = 'kpi-row';
  row.appendChild(statTileP('Período coberto', `${MESES_PT[first.mes]}/${first.ano} – ${MESES_PT[last.mes]}/${last.ano}`, `${producaoData.meses.length} boletins mensais${gaps ? ` · ${gaps} mês(es) sem boletim compatível no meio do período` : ''}`));
  section.appendChild(row);

  const card = chartCard(
    'Produção diária por mês, por campo',
    'Um ponto por mês do boletim, exatamente como a ANP publicou — sem agregar nem estimar nada entre meses. Uma linha por contrato rastreado, mais uma linha combinada dos demais campos do pré-sal (contexto). Uma linha só aparece a partir do mês em que o campo passou a ter produção própria no boletim (ex.: Norte de Carcará entra em outubro/2025, primeiro mês de produção do FPSO).',
  );
  const unitSwitch = buildUnitSwitch((unitKey) => {
    const oldSvg = card.querySelector('svg');
    if (oldSvg) oldSvg.parentElement.remove();
    const oldLegend = card.querySelector('.kpi-row');
    if (oldLegend) oldLegend.remove();
    renderMonthlyLineChart(card, monthlySeries, unitKey);
  });
  card.insertBefore(unitSwitch, card.querySelector('h3').nextSibling);
  renderMonthlyLineChart(card, monthlySeries, 'oleo');
  section.appendChild(card);

  const note = document.createElement('p');
  note.className = 'analytics-table-note';
  note.textContent = `Fonte: ${producaoData.fonte.nome}. De out/2017 a jun/2025, vem da planilha Excel oficial que acompanha o boletim (número de célula exato, sem risco de extração de texto); de jul/2025 em diante, do PDF (a ANP ainda não publicou o Excel desses meses). Antes de out/2017 a ANP não publicava essa tabela por campo. Meses faltando no meio do período são edições sem o arquivo correspondente disponível no site da ANP.`;
  section.appendChild(note);

  return section;
}

/* ---------------------------------- Init ----------------------------------- */

async function init() {
  const wrapper = document.getElementById('producaoWrapper');
  let producaoData = null;
  try {
    producaoData = await fetch(PRODUCAO_URL).then((r) => r.json());
  } catch (err) {
    console.error('Falha ao carregar dados de produção', err);
  }

  wrapper.innerHTML = '';

  if (!producaoData || !producaoData.meses || !producaoData.meses.length) {
    const empty = document.createElement('p');
    empty.className = 'chart-card-subtitle';
    empty.textContent = 'Nenhum dado de produção carregado ainda.';
    wrapper.appendChild(empty);
    return;
  }

  const monthlySection = buildMonthlySection(producaoData);
  const evolutionSection = buildEvolutionSection(producaoData);
  evolutionSection.hidden = true;

  const pageSwitch = buildPageSwitch(
    [['mensal', 'Mês atual'], ['evolucao', 'Evolução mensal']],
    (page) => {
      monthlySection.hidden = page !== 'mensal';
      evolutionSection.hidden = page !== 'evolucao';
    },
  );
  wrapper.appendChild(pageSwitch);
  wrapper.appendChild(monthlySection);
  wrapper.appendChild(evolutionSection);
}

function buildPageSwitch(tabs, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'scale-switch analytics-tab-switch';
  tabs.forEach(([key, label], i) => {
    const btn = document.createElement('button');
    btn.className = 'scale-btn' + (i === 0 ? ' active' : '');
    btn.textContent = label;
    btn.dataset.page = key;
    wrap.appendChild(btn);
  });
  wrap.addEventListener('click', (e) => {
    const btn = e.target.closest('.scale-btn');
    if (!btn) return;
    wrap.querySelectorAll('.scale-btn').forEach((b) => b.classList.toggle('active', b === btn));
    onChange(btn.dataset.page);
  });
  return wrap;
}

init();
