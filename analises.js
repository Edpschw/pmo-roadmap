'use strict';

/* =========================================================================
   PMO Roadmap — Análises. Estatísticas e métricas gerenciais calculadas no
   navegador a partir do mesmo estado (shared.js) e das mesmas fontes que o
   mapa usa: data/contratos.geojson (operador/bacia/área), data/pocos.json
   (base ANP/BDEP de poços, wellCategory de shared.js) e
   data/planos_desenvolvimento.json (STOIIP/GIIP/volume recuperável — só
   disponível pros projetos com sumário executivo de PD publicado). Sem
   servidor: tudo é derivado desses arquivos estáticos a cada carga.
   ========================================================================= */

const GEOJSON_URL = 'data/contratos.geojson';
const POCOS_URL = 'data/pocos.json';
const PD_URL = 'data/planos_desenvolvimento.json';
// Campos de contexto do pré-sal (ver mapa.js) — a maioria é regime
// Concessão ou Cessão Onerosa, não Partilha de Produção (só MERO, com
// "(PP)" na rodada). Não são nenhum dos 29 contratos rastreados (podem
// sobrepor um deles em área — ex.: MERO é o reservatório dentro do bloco
// de Libra — por isso ficam numa seção à parte, sem somar nos KPIs do
// topo: somar contaria o mesmo poço/volume duas vezes.
const PRESALT_FIELDS_URL = 'data/campos_presal.geojson';

// Ordem fixa (nunca ciclada) das 7 categorias de poço — ver wellCategory em
// shared.js. Cores validadas contra a superfície escura do app (ver skill
// de dataviz: paleta categórica, pior par adjacente CVD ΔE 8.4).
const WELL_CATEGORY_ORDER = [
  ['producao', 'Produção', 'var(--viz-cat-1)'],
  ['gas', 'Gás', 'var(--viz-cat-2)'],
  ['injecao', 'Injeção', 'var(--viz-cat-3)'],
  ['indicio', 'Indício', 'var(--viz-cat-4)'],
  ['seco', 'Seco', 'var(--viz-cat-5)'],
  ['abandonado', 'Abandonado', 'var(--viz-cat-6)'],
  ['indefinido', 'Sem registro', 'var(--viz-cat-7)'],
];

const GROUP_ORDER = ['exploracao', 'producao', 'devolvidos'];

let featureByProject = {};
let pocosData = {};
let pdData = {};

/* -------------------------------- Helpers -------------------------------- */

function fmtNum(n, opts) {
  return n.toLocaleString('pt-BR', opts || { maximumFractionDigits: 0 });
}

function yearOfISO(iso) {
  const y = parseInt(String(iso).slice(0, 4), 10);
  return Number.isFinite(y) ? y : null;
}

// "Empresa X 40% · Empresa Y 25%" — mesmo formato usado no popup do mapa
// (ver pdSectionHTML em mapa.js). null quando o PD dessa chave não trouxe
// a tabela de participação (a maioria dos sumários executivos traz, mas
// nem todos — Wahoo e Lapa nunca chegaram a PD completo com essa seção).
function participacaoText(pd) {
  if (!pd || !pd.participacao || !pd.participacao.length) return null;
  return pd.participacao.map((p) => `${p.empresa} ${p.pct.toLocaleString('pt-BR')}%`).join(' · ');
}

// Regime do contrato a partir do campo "rodada" do GeoJSON: "(PP)" marca
// Partilha de Produção explicitamente; "Cessão Onerosa" é regime próprio
// (2010); qualquer outra rodada numerada (0, 1, 2, 6, 7...) sem "(PP)" é
// uma rodada de Concessão, de antes da Lei do Partilha (2010). Usado só
// nos campos de contexto (ver renderFieldsSection) — os 29 projetos
// rastreados são todos CPP, então essa distinção não se aplica a eles.
function regimeOf(rodada) {
  if (!rodada) return null;
  if (rodada.includes('(PP)')) return 'Partilha';
  if (rodada === 'Cessão Onerosa') return 'Cessão Onerosa';
  return 'Concessão';
}

/* --------------------------- Tooltip de hover ----------------------------- */
// Um só elemento reaproveitado por todo mark hoverável do gráfico (barras,
// segmentos, colunas) — mostra a mesma informação acessível via foco de
// teclado, nunca só no hover (ver skill de dataviz).

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

/* ----------------------------- Cálculo por projeto ------------------------ */

function wellCountsFor(projectName) {
  const wells = pocosData[projectName] || [];
  const counts = {};
  for (const [cat] of WELL_CATEGORY_ORDER) counts[cat] = 0;
  for (const w of wells) counts[wellCategory(w)]++;
  return { total: wells.length, counts };
}

// FPSOs de "Primeiro Óleo por FPSO" — instalados (marco done) contam pro
// total em operação; não-done são previstos. firstOilYear é o ano do
// primeiro FPSO já instalado (não o previsto), pra "lead time" comparar
// coisas realmente aconteceram.
function fpsoInfo(project) {
  let installed = 0;
  let planned = 0;
  let firstOilYear = null;
  for (const ws of project.workstreams) {
    if (!ws.name.includes('FPSO')) continue;
    for (const it of ws.items) {
      if (it.type !== 'milestone' || it.icon !== 'fpso') continue;
      if (it.done) {
        installed++;
        const y = yearOfISO(it.date);
        if (y != null && (firstOilYear == null || y < firstOilYear)) firstOilYear = y;
      } else {
        planned++;
      }
    }
  }
  return { installed, planned, firstOilYear };
}

function leilaoYearOf(project) {
  for (const ws of project.workstreams) {
    if (ws.name !== 'Marcos do Contrato') continue;
    const leilao = ws.items.find((i) => i.name === 'Leilão');
    if (leilao) return yearOfISO(leilao.date);
    const years = ws.items.filter((i) => i.icon === 'contract').map((i) => yearOfISO(i.date)).filter((y) => y != null);
    if (years.length) return Math.min(...years);
  }
  return null;
}

// "Lead time" negativo é esperado (não é bug) pra Búzios/Itapu/Sépia/Atapu/
// Entorno de Sapinhoá: esses campos já produziam sob a Cessão Onerosa
// anterior antes do leilão do CPP específico rastreado aqui — o número
// negativo é justamente essa informação (ver nota na tabela).
function computeProjectRow(project) {
  const feature = featureByProject[project.name];
  const props = feature ? feature.properties : null;
  const wc = wellCountsFor(project.name);
  const fpso = fpsoInfo(project);
  const leilaoYear = leilaoYearOf(project);
  const leadTimeYears = (leilaoYear != null && fpso.firstOilYear != null) ? fpso.firstOilYear - leilaoYear : null;
  const pd = pdData[project.name];
  const volumes = pd && pd.volumes ? pd.volumes : null;
  return {
    name: project.name,
    color: project.color,
    group: project.group,
    operador: props ? props.operador : null,
    bacia: props ? props.bacia : null,
    areaKm2: props && props.area_km2 ? props.area_km2 : null,
    leilaoYear,
    wellsTotal: wc.total,
    wellCounts: wc.counts,
    fpsoInstalled: fpso.installed,
    fpsoPlanned: fpso.planned,
    firstOilYear: fpso.firstOilYear,
    leadTimeYears,
    stoiip: volumes && volumes.oleoInSituMMbbl != null ? volumes.oleoInSituMMbbl : null,
    recOleo: volumes && volumes.reservaProvada && volumes.reservaProvada.oleoMMbbl != null ? volumes.reservaProvada.oleoMMbbl : null,
    participacao: participacaoText(pd),
  };
}

function computeFpsoByYear(projects) {
  const byYear = {};
  for (const p of projects) {
    for (const ws of p.workstreams) {
      if (!ws.name.includes('FPSO')) continue;
      for (const it of ws.items) {
        if (it.type !== 'milestone' || it.icon !== 'fpso' || !it.done) continue;
        const y = yearOfISO(it.date);
        if (y == null) continue;
        byYear[y] = (byYear[y] || 0) + 1;
      }
    }
  }
  return byYear;
}

function computeAggregates(rows) {
  const byGroup = { exploracao: 0, producao: 0, devolvidos: 0 };
  for (const r of rows) byGroup[r.group]++;
  const successRate = byGroup.producao / (byGroup.producao + byGroup.devolvidos);

  const wellCatTotals = {};
  for (const [cat] of WELL_CATEGORY_ORDER) wellCatTotals[cat] = 0;
  let wellsTotal = 0;
  for (const r of rows) {
    wellsTotal += r.wellsTotal;
    for (const [cat] of WELL_CATEGORY_ORDER) wellCatTotals[cat] += r.wellCounts[cat];
  }

  let fpsoInstalled = 0;
  let fpsoPlanned = 0;
  for (const r of rows) { fpsoInstalled += r.fpsoInstalled; fpsoPlanned += r.fpsoPlanned; }

  let stoiipTotal = 0;
  let stoiipCount = 0;
  let recOleoTotal = 0;
  let recCount = 0;
  for (const r of rows) {
    if (r.stoiip != null) { stoiipTotal += r.stoiip; stoiipCount++; }
    if (r.recOleo != null) { recOleoTotal += r.recOleo; recCount++; }
  }

  return { byGroup, successRate, wellCatTotals, wellsTotal, fpsoInstalled, fpsoPlanned, stoiipTotal, stoiipCount, recOleoTotal, recCount, totalProjects: rows.length };
}

/* --------------------------------- Render --------------------------------- */

function statTile(label, value, sub) {
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

function renderKPIRow(container, agg) {
  const row = document.createElement('div');
  row.className = 'kpi-row';
  row.appendChild(statTile(
    'Projetos rastreados', String(agg.totalProjects),
    `${agg.byGroup.exploracao} exploração · ${agg.byGroup.producao} produção · ${agg.byGroup.devolvidos} devolvidos`,
  ));
  row.appendChild(statTile(
    'Taxa de sucesso exploratório', Math.round(agg.successRate * 100) + '%',
    `${agg.byGroup.producao} de ${agg.byGroup.producao + agg.byGroup.devolvidos} blocos com desfecho viraram produção — ${agg.byGroup.exploracao} ainda em exploração`,
  ));
  row.appendChild(statTile(
    'Poços perfurados', fmtNum(agg.wellsTotal),
    `Base ANP/BDEP — ${agg.wellCatTotals.producao} produtores · ${agg.wellCatTotals.injecao} injetores · ${agg.wellCatTotals.abandonado} abandonados`,
  ));
  row.appendChild(statTile(
    'FPSOs em operação', fmtNum(agg.fpsoInstalled),
    `+ ${agg.fpsoPlanned} previstos`,
  ));
  row.appendChild(statTile(
    'STOIIP total', fmtNum(agg.stoiipTotal / 1000, { maximumFractionDigits: 1 }) + ' bi bbl',
    `${agg.stoiipCount} de ${agg.totalProjects} projetos com Plano de Desenvolvimento público`,
  ));
  row.appendChild(statTile(
    'Volume recuperável', fmtNum(agg.recOleoTotal) + ' MMbbl',
    `Dado parcial — só ${agg.recCount} projeto(s) com essa figura no PD`,
  ));
  container.appendChild(row);
}

function renderStoiipChart(container, rows) {
  const withStoiip = rows.filter((r) => r.stoiip != null).sort((a, b) => b.stoiip - a.stoiip);
  if (!withStoiip.length) return;

  const card = document.createElement('div');
  card.className = 'chart-card';
  const title = document.createElement('h3');
  title.className = 'chart-card-title';
  title.textContent = 'STOIIP por projeto (óleo in situ)';
  const sub = document.createElement('p');
  sub.className = 'chart-card-subtitle';
  sub.textContent = `Só os ${withStoiip.length} projetos com Plano de Desenvolvimento público — os demais ainda não têm PD aprovado/divulgado.`;
  card.appendChild(title);
  card.appendChild(sub);

  const list = document.createElement('div');
  list.className = 'hbar-list';
  const max = Math.max(...withStoiip.map((r) => r.stoiip));
  for (const r of withStoiip) {
    const row = document.createElement('div');
    row.className = 'hbar-row';
    const name = document.createElement('div');
    name.className = 'hbar-name';
    name.textContent = r.name;
    name.title = r.name;
    const track = document.createElement('div');
    track.className = 'hbar-track';
    const fill = document.createElement('div');
    fill.className = 'hbar-fill';
    fill.style.width = Math.max(3, (r.stoiip / max) * 100) + '%';
    fill.style.background = 'var(--accent)';
    fill.tabIndex = 0;
    attachTooltip(fill, () => `<strong>${escapeHtml(r.name)}</strong>` + tooltipRowHTML('STOIIP', `${fmtNum(r.stoiip)} MMbbl`));
    track.appendChild(fill);
    const value = document.createElement('div');
    value.className = 'hbar-value';
    value.textContent = fmtNum(r.stoiip) + ' MMbbl';
    track.appendChild(value);
    row.appendChild(name);
    row.appendChild(track);
    list.appendChild(row);
  }
  card.appendChild(list);
  container.appendChild(card);
}

function buildStackedBarRow(row, maxTotal) {
  const wrap = document.createElement('div');
  wrap.className = 'hbar-row';

  const name = document.createElement('div');
  name.className = 'hbar-name';
  name.textContent = row.name;
  name.title = row.name;
  wrap.appendChild(name);

  const track = document.createElement('div');
  track.className = 'hbar-track';
  const fill = document.createElement('div');
  fill.className = 'hbar-fill';
  fill.style.width = Math.max(3, (row.wellsTotal / maxTotal) * 100) + '%';
  for (const [cat, label, colorVar] of WELL_CATEGORY_ORDER) {
    const n = row.wellCounts[cat];
    if (!n) continue;
    const seg = document.createElement('div');
    seg.className = 'hbar-seg';
    seg.style.background = colorVar;
    seg.style.flex = `${n} 0 0`;
    seg.tabIndex = 0;
    attachTooltip(seg, () => `<strong>${escapeHtml(row.name)}</strong>` + tooltipRowHTML(label, `${n} poço${n === 1 ? '' : 's'}`));
    fill.appendChild(seg);
  }
  track.appendChild(fill);

  const value = document.createElement('div');
  value.className = 'hbar-value';
  value.textContent = fmtNum(row.wellsTotal);
  track.appendChild(value);

  wrap.appendChild(track);
  return wrap;
}

// Cartão de barra empilhada por categoria de poço — reaproveitado pelos
// 29 projetos rastreados e pelos campos de contexto (mesma forma de linha,
// só muda o título/legenda de rodapé de quem não tem poço ainda).
function buildWellsStackedCard(rows, title, subtitle) {
  const withWells = rows.filter((r) => r.wellsTotal > 0).sort((a, b) => b.wellsTotal - a.wellsTotal);
  const withoutWells = rows.filter((r) => r.wellsTotal === 0);

  const card = document.createElement('div');
  card.className = 'chart-card';
  const titleEl = document.createElement('h3');
  titleEl.className = 'chart-card-title';
  titleEl.textContent = title;
  const sub = document.createElement('p');
  sub.className = 'chart-card-subtitle';
  sub.textContent = subtitle;
  card.appendChild(titleEl);
  card.appendChild(sub);

  const legend = document.createElement('div');
  legend.className = 'viz-legend';
  for (const [, label, colorVar] of WELL_CATEGORY_ORDER) {
    const item = document.createElement('div');
    item.className = 'viz-legend-item';
    const sw = document.createElement('span');
    sw.className = 'viz-legend-swatch';
    sw.style.background = colorVar;
    item.appendChild(sw);
    item.appendChild(document.createTextNode(label));
    legend.appendChild(item);
  }
  card.appendChild(legend);

  if (withWells.length) {
    const list = document.createElement('div');
    list.className = 'hbar-list';
    const max = Math.max(...withWells.map((r) => r.wellsTotal));
    for (const r of withWells) list.appendChild(buildStackedBarRow(r, max));
    card.appendChild(list);
  }

  if (withoutWells.length) {
    const note = document.createElement('p');
    note.className = 'analytics-table-note';
    note.textContent = `Sem poço perfurado ainda: ${withoutWells.map((r) => r.name).join(', ')}.`;
    card.appendChild(note);
  }
  return card;
}

function renderWellsStackedChart(container, rows) {
  container.appendChild(buildWellsStackedCard(
    rows,
    'Poços por categoria, por projeto',
    'Base ANP/BDEP — o comprimento da barra é o total de poços; os segmentos mostram a composição por categoria.',
  ));
}

function renderFpsoByYearChart(container, projects) {
  const byYear = computeFpsoByYear(projects);
  const years = Object.keys(byYear).map(Number);
  if (!years.length) return;
  const minY = Math.min(...years);
  const maxY = Math.max(...years);
  const total = years.reduce((s, y) => s + byYear[y], 0);

  const card = document.createElement('div');
  card.className = 'chart-card';
  const title = document.createElement('h3');
  title.className = 'chart-card-title';
  title.textContent = 'Primeiro óleo por FPSO, por ano';
  const sub = document.createElement('p');
  sub.className = 'chart-card-subtitle';
  sub.textContent = `${total} FPSOs em operação entre ${minY} e ${maxY}.`;
  card.appendChild(title);
  card.appendChild(sub);

  const chart = document.createElement('div');
  chart.className = 'vbar-chart';
  const maxCount = Math.max(...Object.values(byYear));
  for (let y = minY; y <= maxY; y++) {
    const count = byYear[y] || 0;
    const col = document.createElement('div');
    col.className = 'vbar-col';
    const val = document.createElement('div');
    val.className = 'vbar-value';
    val.textContent = count ? String(count) : '';
    const fill = document.createElement('div');
    fill.className = 'vbar-fill' + (count === 0 ? ' is-zero' : '');
    fill.style.height = count === 0 ? '3px' : Math.max(6, (count / maxCount) * 130) + 'px';
    fill.tabIndex = 0;
    attachTooltip(fill, () => `<strong>${y}</strong>` + tooltipRowHTML('FPSOs com 1º óleo', String(count)));
    const label = document.createElement('div');
    label.className = 'vbar-label';
    label.textContent = String(y);
    col.appendChild(val);
    col.appendChild(fill);
    col.appendChild(label);
    chart.appendChild(col);
  }
  card.appendChild(chart);
  container.appendChild(card);
}

function renderProjectTable(container, rows) {
  const wrap = document.createElement('div');
  wrap.className = 'table-wrapper';
  wrap.style.padding = '0';
  const table = document.createElement('table');
  table.className = 'data-table analytics-table';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr>
    <th>Projeto</th>
    <th>Operador</th>
    <th>Parceiros (%)</th>
    <th>Bacia</th>
    <th class="num">Leilão</th>
    <th class="num">Poços (ANP)</th>
    <th class="num">FPSOs</th>
    <th class="num">1º óleo</th>
    <th class="num">Lead time</th>
    <th class="num">STOIIP (MMbbl)</th>
    <th class="num">Vol. recuperável (MMbbl)</th>
    <th class="num">Área (km²)</th>
  </tr>`;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const groupId of GROUP_ORDER) {
    const groupRows = rows.filter((r) => r.group === groupId);
    if (!groupRows.length) continue;
    const groupDef = GROUP_DEFS.find((g) => g.id === groupId);
    const gtr = document.createElement('tr');
    gtr.className = 'group-row';
    const gtd = document.createElement('td');
    gtd.colSpan = 12;
    gtd.textContent = `${groupDef ? groupDef.label : groupId} (${groupRows.length})`;
    gtr.appendChild(gtd);
    tbody.appendChild(gtr);

    for (const r of groupRows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><div class="proj-name-cell"><span class="proj-dot" style="background:${r.color}"></span>${escapeHtml(r.name)}</div></td>
        <td class="${r.operador ? '' : 'muted'}">${escapeHtml(r.operador || '—')}</td>
        <td class="${r.participacao ? '' : 'muted'} participacao-cell">${escapeHtml(r.participacao || '—')}</td>
        <td class="${r.bacia ? '' : 'muted'}">${escapeHtml(r.bacia || '—')}</td>
        <td class="num">${r.leilaoYear != null ? r.leilaoYear : '—'}</td>
        <td class="num">${r.wellsTotal || '—'}</td>
        <td class="num">${r.fpsoInstalled}${r.fpsoPlanned ? ` (+${r.fpsoPlanned})` : ''}</td>
        <td class="num">${r.firstOilYear != null ? r.firstOilYear : '—'}</td>
        <td class="num">${r.leadTimeYears != null ? r.leadTimeYears : '—'}</td>
        <td class="num">${r.stoiip != null ? fmtNum(r.stoiip) : '—'}</td>
        <td class="num">${r.recOleo != null ? fmtNum(r.recOleo) : '—'}</td>
        <td class="num">${r.areaKm2 != null ? fmtNum(r.areaKm2) : '—'}</td>
      `;
      tbody.appendChild(tr);
    }
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);

  const note = document.createElement('p');
  note.className = 'analytics-table-note';
  note.textContent = 'Parceiros: só onde o sumário executivo de PD publicado trouxe a tabela de participação. FPSOs: instalados (+ previstos entre parênteses). Lead time = anos entre o leilão e o 1º óleo instalado; negativo indica que o campo já produzia num contrato anterior (Cessão Onerosa/unitização) antes do leilão deste contrato específico — Búzios, Itapu, Sépia, Atapu e Entorno de Sapinhoá.';
  container.appendChild(note);
}

/* ------------------------ Campos de contexto (não-CPP) --------------------- */
// Campos do play do pré-sal que não são nenhum dos 29 contratos rastreados
// acima (ver PRESALT_FIELDS_URL) — a maioria em regime de Concessão ou
// Cessão Onerosa, bem anterior à Lei da Partilha (2010); só Mero é
// Partilha. Alguns ficam dentro da área de um contrato rastreado (Mero
// dentro do bloco de Libra, por exemplo) — por isso entram numa seção à
// parte em vez de nos KPIs do topo: somar contaria poço/volume em dobro.

function computeFieldRow(feature) {
  const props = feature.properties;
  const name = props.nome;
  const wc = wellCountsFor(name);
  const pd = pdData[name];
  const volumes = pd && pd.volumes ? pd.volumes : null;
  return {
    name,
    operador: props.operador || null,
    bacia: props.bacia || null,
    regime: regimeOf(props.rodada),
    areaKm2: props.area_km2 || null,
    wellsTotal: wc.total,
    wellCounts: wc.counts,
    stoiip: volumes && volumes.oleoInSituMMbbl != null ? volumes.oleoInSituMMbbl : null,
    participacao: participacaoText(pd),
  };
}

// "outros" em data/pocos.json: poços do play do pré-sal (ATINGIU_PRESAL=
// 'S' na base ANP/BDEP) que não caem em nenhum dos 29 contratos
// rastreados nem em nenhum dos 13 campos de contexto nomeados — sem
// operador/bacia/regime/STOIIP porque não são um campo, é o resto
// espalhado do play. Sem isso, "todos os campos do pré-sal" ficava
// faltando justamente os ~225 poços que o mapa já desenha (camada
// "outros poços", cor neutra) mas a página de análises não somava em
// lugar nenhum.
function computeOutrosRow(outrosPocos) {
  const counts = {};
  for (const [cat] of WELL_CATEGORY_ORDER) counts[cat] = 0;
  for (const w of outrosPocos) counts[wellCategory(w)]++;
  return {
    name: 'Outros poços do pré-sal (sem campo nomeado)',
    operador: null,
    bacia: null,
    regime: null,
    areaKm2: null,
    wellsTotal: outrosPocos.length,
    wellCounts: counts,
    stoiip: null,
    participacao: null,
    isOutros: true,
  };
}

function renderFieldsTable(container, fieldRows) {
  const wrap = document.createElement('div');
  wrap.className = 'table-wrapper';
  wrap.style.padding = '0';
  const table = document.createElement('table');
  table.className = 'data-table analytics-table';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr>
    <th>Campo</th>
    <th>Regime</th>
    <th>Operador</th>
    <th>Parceiros (%)</th>
    <th>Bacia</th>
    <th class="num">Poços (ANP)</th>
    <th class="num">STOIIP (MMbbl)</th>
    <th class="num">Área (km²)</th>
  </tr>`;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  // "Outros" não é um campo nomeado — fica sempre por último em vez de
  // entrar na ordem alfabética junto dos campos de verdade.
  const named = fieldRows.filter((r) => !r.isOutros).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const outros = fieldRows.filter((r) => r.isOutros);
  for (const r of [...named, ...outros]) {
    const tr = document.createElement('tr');
    if (r.isOutros) tr.className = 'muted';
    tr.innerHTML = `
      <td>${escapeHtml(r.name)}</td>
      <td class="${r.regime === 'Partilha' ? '' : 'muted'}">${escapeHtml(r.regime || '—')}</td>
      <td class="${r.operador ? '' : 'muted'}">${escapeHtml(r.operador || '—')}</td>
      <td class="${r.participacao ? '' : 'muted'} participacao-cell">${escapeHtml(r.participacao || '—')}</td>
      <td class="${r.bacia ? '' : 'muted'}">${escapeHtml(r.bacia || '—')}</td>
      <td class="num">${r.wellsTotal || '—'}</td>
      <td class="num">${r.stoiip != null ? fmtNum(r.stoiip) : '—'}</td>
      <td class="num">${r.areaKm2 != null ? fmtNum(r.areaKm2) : '—'}</td>
    `;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
}

function renderFieldsSection(container, fieldRows) {
  const named = fieldRows.filter((r) => !r.isOutros);
  const outros = fieldRows.find((r) => r.isOutros);
  const intro = document.createElement('p');
  intro.className = 'chart-card-subtitle';
  intro.style.margin = '0 0 14px';
  intro.textContent = `Campos do pré-sal que não são nenhum dos 29 contratos rastreados acima — a maioria em regime de Concessão ou Cessão Onerosa (${named.filter((r) => r.regime !== 'Partilha').length} de ${named.length}), bem anterior à Lei da Partilha (2010); só Mero é Partilha. Alguns ficam dentro da área de um contrato já rastreado (ex.: Mero fica dentro do bloco de Libra) — por isso os poços e o STOIIP daqui não entram nos KPIs do topo, pra não contar em dobro.${outros ? ` Inclui também os ${fmtNum(outros.wellsTotal)} poços do play do pré-sal (ATINGIU_PRESAL=S na base ANP/BDEP) que não pertencem a nenhum campo nomeado nem contrato rastreado — a mesma camada "outros poços" já desenhada no mapa.` : ''}`;
  container.appendChild(intro);
  container.appendChild(buildWellsStackedCard(
    fieldRows,
    'Poços por categoria, por campo',
    'Base ANP/BDEP — mesma leitura do gráfico de projetos, agora pros 13 campos de contexto do play do pré-sal.',
  ));
  renderFieldsTable(container, fieldRows);
}

/* ---------------------------------- Init ----------------------------------- */

async function init() {
  const wrapper = document.getElementById('analyticsWrapper');
  let presalGeojson = null;
  let outrosPocos = [];
  try {
    const [geojson, pocosJson, pd, presal] = await Promise.all([
      fetch(GEOJSON_URL).then((r) => r.json()),
      fetch(POCOS_URL).then((r) => r.json()),
      fetch(PD_URL).then((r) => r.json()),
      fetch(PRESALT_FIELDS_URL).then((r) => r.json()),
    ]);
    for (const feat of geojson.features) featureByProject[feat.properties.projeto] = feat;
    pocosData = pocosJson.pocos || {};
    outrosPocos = pocosJson.outros || [];
    pdData = pd;
    presalGeojson = presal;
  } catch (err) {
    console.error('Falha ao carregar dados de análise', err);
  }

  const rows = state.projects.map(computeProjectRow);
  const agg = computeAggregates(rows);
  const fieldRows = presalGeojson ? presalGeojson.features.map(computeFieldRow) : [];
  if (outrosPocos.length) fieldRows.push(computeOutrosRow(outrosPocos));

  wrapper.innerHTML = '';

  const kpiSection = document.createElement('section');
  kpiSection.className = 'analytics-section';
  renderKPIRow(kpiSection, agg);
  wrapper.appendChild(kpiSection);

  const chartsSection = document.createElement('section');
  chartsSection.className = 'analytics-section';
  const chartsTitle = document.createElement('h2');
  chartsTitle.className = 'analytics-section-title';
  chartsTitle.textContent = 'Gráficos';
  chartsSection.appendChild(chartsTitle);
  renderStoiipChart(chartsSection, rows);
  renderWellsStackedChart(chartsSection, rows);
  renderFpsoByYearChart(chartsSection, state.projects);
  wrapper.appendChild(chartsSection);

  const tableSection = document.createElement('section');
  tableSection.className = 'analytics-section';
  const tableTitle = document.createElement('h2');
  tableTitle.className = 'analytics-section-title';
  tableTitle.textContent = 'Projetos';
  tableSection.appendChild(tableTitle);
  renderProjectTable(tableSection, rows);
  wrapper.appendChild(tableSection);

  if (fieldRows.length) {
    const fieldsSection = document.createElement('section');
    fieldsSection.className = 'analytics-section';
    const fieldsTitle = document.createElement('h2');
    fieldsTitle.className = 'analytics-section-title';
    fieldsTitle.textContent = 'Campos (inclusive fora da Partilha)';
    fieldsSection.appendChild(fieldsTitle);
    renderFieldsSection(fieldsSection, fieldRows);
    wrapper.appendChild(fieldsSection);
  }
}

init();
