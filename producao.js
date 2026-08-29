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

/* -------------------------------- Agregação anual -------------------------- */
// "producao de cada campo sendo somada" por ano: cada segmento do
// empilhado é a MÉDIA diária do campo nos meses do boletim disponíveis
// naquele ano (petróleo/gás/produção são vazões, bbl/d e Mm³/d — não faz
// sentido "somar" meses de uma taxa; a leitura fiel de "ano" pra uma vazão
// é a média do período), e o empilhado então SOMA essa média entre os
// campos — a altura total da barra do ano é a produção pré-sal média
// somada de todos os campos, exatamente o que foi pedido. 2024 (a partir
// de junho) e 2026 (até junho, o mês mais recente coberto) são anos
// parciais — sinalizado no eixo x e na legenda do gráfico, pra não
// comparar a barra inteira de um ano parcial com um ano completo sem
// ressalva.
function averageCampos(mesesSubset) {
  const sums = {};
  const counts = {};
  for (const mes of mesesSubset) {
    for (const [nome, dados] of Object.entries(mes.campos)) {
      if (!sums[nome]) {
        sums[nome] = emptyMetrics();
        counts[nome] = 0;
      }
      for (const k of METRIC_KEYS) sums[nome][k] += dados[k];
      counts[nome] += 1;
    }
  }
  const avg = {};
  for (const nome of Object.keys(sums)) {
    avg[nome] = {};
    for (const k of METRIC_KEYS) avg[nome][k] = sums[nome][k] / counts[nome];
  }
  return avg;
}

// Uma linha "Outros campos" por ano, somando todos os campos de contexto
// (fora dos 7 contratos rastreados com produção própria) — o empilhado
// mostra só os contratos rastreados + esse total combinado, não uma barra
// por campo de contexto (seriam ~20 fatias minúsculas, ilegível).
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

function computeAnnualData(meses, projects) {
  const byYear = new Map();
  for (const mes of meses) {
    if (!byYear.has(mes.ano)) byYear.set(mes.ano, []);
    byYear.get(mes.ano).push(mes);
  }
  const years = [...byYear.keys()].sort((a, b) => a - b);
  return years.map((year) => {
    const mesesDoAno = byYear.get(year);
    const avgCampos = averageCampos(mesesDoAno);
    const rows = collapseContext(computeFieldRows(avgCampos, projects));
    const mesesNums = mesesDoAno.map((m) => m.mes).sort((a, b) => a - b);
    return { year, monthCount: mesesDoAno.length, isPartial: mesesDoAno.length < 12, mesesNums, rows };
  });
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

/* ---------------------------- Gráfico anual (empilhado) -------------------- */
// Barra vertical por ano, empilhada por campo — cada segmento é a MÉDIA
// diária daquele campo nos meses do ano disponíveis no boletim (ver
// computeAnnualData/averageCampos), somada entre campos pra formar a
// altura total da barra do ano.

const STACK_W = 900;
const STACK_H = 380;
const STACK_MARGIN = { top: 16, right: 16, bottom: 44, left: 64 };

// Ordem fixa de empilhamento (mesma em todo ano, pra ler a evolução de um
// campo específico comparando a mesma faixa de cor entre barras) — projeto
// rastreado por ordem de aparição em state.projects (mesma ordem do
// roadmap/análises), "Outros campos" sempre por último (no topo).
function stackOrder(annualData) {
  const seen = new Map();
  for (const y of annualData) {
    for (const r of y.rows) {
      if (!seen.has(r.name)) seen.set(r.name, r);
    }
  }
  const names = [...seen.keys()];
  const contract = names.filter((n) => seen.get(n).isContract);
  const context = names.filter((n) => !seen.get(n).isContract);
  return [...contract, ...context];
}

function niceMax(v) {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

function renderAnnualStackedChart(container, annualData, unitKey) {
  const unit = UNITS[unitKey];
  const order = stackOrder(annualData);
  const rowByName = (y, name) => y.rows.find((r) => r.name === name);
  const totals = annualData.map((y) => order.reduce((s, name) => {
    const r = rowByName(y, name);
    return s + (r ? r[unit.key] : 0);
  }, 0));
  const maxTotal = niceMax(Math.max(...totals, 0));

  const plotW = STACK_W - STACK_MARGIN.left - STACK_MARGIN.right;
  const plotH = STACK_H - STACK_MARGIN.top - STACK_MARGIN.bottom;
  const bandW = plotW / annualData.length;
  const barW = Math.min(96, bandW * 0.6);

  const yTicks = 5;
  let gridSvg = '';
  for (let i = 0; i <= yTicks; i++) {
    const v = (maxTotal / yTicks) * i;
    const y = STACK_MARGIN.top + plotH - (v / maxTotal) * plotH;
    gridSvg += `<line x1="${STACK_MARGIN.left}" y1="${y}" x2="${STACK_W - STACK_MARGIN.right}" y2="${y}" stroke="var(--border)" stroke-width="1" />`;
    gridSvg += `<text x="${STACK_MARGIN.left - 10}" y="${y + 4}" text-anchor="end" font-size="11" style="fill:var(--text-faint)">${fmtNum(v)}</text>`;
  }

  let barsSvg = '';
  const rectMeta = [];
  annualData.forEach((y, i) => {
    const cx = STACK_MARGIN.left + bandW * i + bandW / 2;
    let yTop = STACK_MARGIN.top + plotH;
    for (const name of order) {
      const r = rowByName(y, name);
      const v = r ? r[unit.key] : 0;
      if (v <= 0) continue;
      const h = (v / maxTotal) * plotH;
      const rectY = yTop - h;
      const id = `seg_${i}_${order.indexOf(name)}`;
      barsSvg += `<rect id="${id}" x="${cx - barW / 2}" y="${rectY}" width="${barW}" height="${Math.max(h, 0.5)}" fill="${r.color}" data-hoverable="1" tabindex="0" style="cursor:pointer" />`;
      rectMeta.push({ id, year: y.year, name, value: v, row: r, monthCount: y.monthCount });
      yTop = rectY;
    }
    const xLabel = y.isPartial ? `${y.year} (${y.monthCount} m.)` : String(y.year);
    barsSvg += `<text x="${cx}" y="${STACK_MARGIN.top + plotH + 20}" text-anchor="middle" font-size="12" style="fill:var(--text-muted)">${xLabel}</text>`;
  });

  const axisSvg = `<line x1="${STACK_MARGIN.left}" y1="${STACK_MARGIN.top + plotH}" x2="${STACK_W - STACK_MARGIN.right}" y2="${STACK_MARGIN.top + plotH}" stroke="var(--border-strong)" stroke-width="1" />`;

  const svgWrap = document.createElement('div');
  svgWrap.innerHTML = `<svg viewBox="0 0 ${STACK_W} ${STACK_H}" style="width:100%;height:auto;display:block">${gridSvg}${axisSvg}${barsSvg}</svg>`;
  const svgEl = svgWrap.firstElementChild;

  for (const meta of rectMeta) {
    const el = svgEl.querySelector(`#${meta.id}`);
    if (!el) continue;
    attachTooltip(el, () => `<strong>${escapeHtml(meta.name)}</strong>`
      + tooltipRowHTML('Ano', `${meta.year}${meta.monthCount < 12 ? ` (${meta.monthCount} meses)` : ''}`)
      + tooltipRowHTML(unit.label, unit.fmt(meta.value))
      + (meta.row.isContract ? '' : tooltipRowHTML('Contrato', 'Fora dos 7 com produção própria rastreados')));
  }

  container.appendChild(svgWrap);

  const legend = document.createElement('div');
  legend.className = 'kpi-row';
  legend.style.marginTop = '10px';
  for (const name of order) {
    const sample = annualData.map((y) => rowByName(y, name)).find(Boolean);
    if (!sample) continue;
    const item = document.createElement('div');
    item.style.display = 'flex';
    item.style.alignItems = 'center';
    item.style.gap = '6px';
    item.style.fontSize = '12px';
    item.style.color = 'var(--text-muted)';
    item.innerHTML = `<span style="width:10px;height:10px;border-radius:2px;background:${sample.color};flex:0 0 auto"></span>${escapeHtml(name)}`;
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

function buildAnnualSection(producaoData) {
  const annualData = computeAnnualData(producaoData.meses, state.projects);

  const section = document.createElement('section');
  section.className = 'analytics-section';

  const first = producaoData.meses[0];
  const last = producaoData.meses[producaoData.meses.length - 1];
  const row = document.createElement('div');
  row.className = 'kpi-row';
  row.appendChild(statTileP('Período coberto', `${annualData[0].year}–${annualData[annualData.length - 1].year}`, `${producaoData.meses.length} boletins mensais, de ${MESES_PT[first.mes]}/${first.ano} a ${MESES_PT[last.mes]}/${last.ano}`));
  row.appendChild(statTileP('Anos completos', String(annualData.filter((y) => !y.isPartial).length), `${annualData.filter((y) => y.isPartial).length} ano(s) parcial(is) no boletim ainda`));
  section.appendChild(row);

  const card = chartCard(
    'Produção pré-sal por ano, por campo',
    'Cada barra é a soma, entre os campos, da produção MÉDIA diária de cada um nos meses do boletim disponíveis naquele ano — não dá pra "somar" uma vazão (bbl/d) entre meses, mas dá pra somar a média de cada campo pra formar o total do ano. Anos marcados com "(N m.)" têm boletim disponível só pra parte do ano — não comparar a barra inteira com um ano completo sem essa ressalva.',
  );
  const unitSwitch = buildUnitSwitch((unitKey) => {
    const oldSvg = card.querySelector('svg');
    if (oldSvg) oldSvg.parentElement.remove();
    const oldLegend = card.querySelector('.kpi-row');
    if (oldLegend) oldLegend.remove();
    renderAnnualStackedChart(card, annualData, unitKey);
  });
  card.insertBefore(unitSwitch, card.querySelector('h3').nextSibling);
  renderAnnualStackedChart(card, annualData, 'oleo');
  section.appendChild(card);

  const note = document.createElement('p');
  note.className = 'analytics-table-note';
  note.textContent = `Fonte: ${producaoData.fonte.nome}. Só edições do boletim com layout compatível com extração automática entraram nesta base — coberto: ${producaoData.meses.length} de todos os boletins publicados desde 2010 (a maioria das edições mais antigas usa um layout de tabela que a extração de texto não reconstitui com segurança).`;
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
  const annualSection = buildAnnualSection(producaoData);
  annualSection.hidden = true;

  const pageSwitch = buildPageSwitch(
    [['mensal', 'Mensal'], ['anual', 'Por ano']],
    (page) => {
      monthlySection.hidden = page !== 'mensal';
      annualSection.hidden = page !== 'anual';
    },
  );
  wrapper.appendChild(pageSwitch);
  wrapper.appendChild(monthlySection);
  wrapper.appendChild(annualSection);
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
