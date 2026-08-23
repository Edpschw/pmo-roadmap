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

// Ordem fixa (nunca ciclada) das categorias de poço mostradas na seção
// "Campos em produção" — ver wellCategory em shared.js. "Abandonado" fica
// de fora de propósito: mesmo depois da revisão que já tirou abandono
// temporário/logística exploratória daquela categoria, o que sobra ali é
// poço definitivamente fora de operação, e a estatística de produção é
// sobre o que está em pé, não sobre o que já foi desativado (ver
// withoutAbandonedWells). A seção de exploração usa a contagem bruta
// (ALL_WELL_CATEGORIES) — lá abandonado é o desfecho normal da maioria
// dos poços, tirá-lo esvaziaria o gráfico. Cores validadas contra a
// superfície escura do app (ver skill de dataviz: paleta categórica, pior
// par adjacente CVD ΔE 8.4, revalidado pra esta sequência de 6 depois de
// tirar o slot 6).
const WELL_CATEGORY_ORDER = [
  ['producao', 'Produção', 'var(--viz-cat-1)'],
  ['gas', 'Gás', 'var(--viz-cat-2)'],
  ['injecao', 'Injeção', 'var(--viz-cat-3)'],
  ['indicio', 'Indício', 'var(--viz-cat-4)'],
  ['seco', 'Seco', 'var(--viz-cat-5)'],
  ['indefinido', 'Sem registro', 'var(--viz-cat-7)'],
];
const ALL_WELL_CATEGORIES = [...WELL_CATEGORY_ORDER.map(([cat]) => cat), 'abandonado'];

// Mesma lista, com "Abandonado" de volta — só pra o gráfico de poços por
// categoria da seção "Contratos de exploração" (buildWellsStackedCard
// recebe isto no lugar de WELL_CATEGORY_ORDER quando chamado de lá).
const EXPLORATION_WELL_CATEGORY_ORDER = [
  ...WELL_CATEGORY_ORDER,
  ['abandonado', 'Abandonado', 'var(--viz-cat-6)'],
];

// Cor neutra pros campos de contexto e pro balde "outros poços" nos
// gráficos/tabelas unificados — só os 29 contratos rastreados têm cor
// própria (a mesma do roadmap/mapa, project.color); tudo que não é
// contrato usa este cinza, pra "colorindo só quem tem contrato" ficar
// óbvio à primeira vista em qualquer gráfico.
const CONTEXT_FIELD_COLOR = '#7a828f';

// MERO (campo de contexto) e Libra (contrato) casam quase o mesmo poço —
// ver PLAN em scripts/build_pocos.py: Libra inclui SIG_CAMPO 'MRO' (o
// código do campo Mero) + 'AnC6' + BLOCO 'LIBRA'. Nas tabelas/gráficos por
// entidade os dois aparecem separados de propósito (é informação real:
// "aqui está o contrato todo, aqui está só o campo"), mas em qualquer
// AGREGADO (poços por ano, total de produtores/injetores) incluir os dois
// contaria o mesmo poço duas vezes — por isso MERO fica de fora desses
// agregados especificamente.
const AGGREGATE_DEDUP_EXCLUDE = ['MERO'];

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
// nos campos de contexto (ver computeFieldRow) — os 29 projetos
// rastreados são todos CPP/Partilha, então essa distinção não se aplica
// a eles (renderProducaoTable já rotula todo contrato como "Partilha").
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

// Contagem bruta (inclui abandonado) — usada como está pelos contratos de
// exploração, onde abandonado é o desfecho normal da maioria dos poços
// (ver nota no gráfico de renderExploracaoSection) e tirá-lo esvaziaria o
// gráfico. A seção "Campos em produção" usa withoutAbandonedWells (abaixo)
// pra recontar sem ele — ver nota em WELL_CATEGORY_ORDER.
function wellCountsFor(projectName) {
  const wells = pocosData[projectName] || [];
  const counts = {};
  for (const cat of ALL_WELL_CATEGORIES) counts[cat] = 0;
  for (const w of wells) counts[wellCategory(w)]++;
  return { total: wells.length, counts };
}

// Recontagem de uma linha de contrato rastreado (a única que ainda carrega
// contagem bruta — campo de contexto e poços avulsos já saem sem
// abandonado, ver computeFieldRow/computeOutrosRow) sem os poços
// definitivamente abandonados — só pra seção "Campos em produção".
function withoutAbandonedWells(row) {
  const wells = (pocosData[row.name] || []).filter((w) => wellCategory(w) !== 'abandonado');
  const counts = {};
  for (const [cat] of WELL_CATEGORY_ORDER) counts[cat] = 0;
  for (const w of wells) counts[wellCategory(w)]++;
  return { ...row, wellsTotal: wells.length, wellCounts: counts };
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
    isContract: true,
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
    pdKey: pd ? pd.fonte : null,
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
    `Base ANP/BDEP, todos os 29 contratos (inclui abandonados de exploração) — ${agg.wellCatTotals.producao} produtores · ${agg.wellCatTotals.injecao} injetores`,
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

// Contrato rastreado e campo de contexto que citam o mesmo Plano de
// Desenvolvimento (Atapu/Oeste de Atapu, Sapinhoá/Entorno de Sapinhoá,
// Libra/Mero, Berbigão/Norte de Berbigão/Sul de Berbigão) têm STOIIP
// idêntico by design — é a mesma jazida compartilhada, só documentada do
// ponto de vista do contrato inteiro ou só do campo por dentro. Duas
// barras coladas com o mesmo valor pareciam bug, não informação — agrupa
// por pd.fonte (a URL do PD é a chave real de "é o mesmo documento") numa
// barra só antes de desenhar.
function groupByPdKey(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = r.pdKey || r.name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.values()].map((members) => {
    const contractMember = members.find((m) => m.isContract);
    return {
      name: members.map((m) => m.name).join(' / '),
      color: contractMember ? contractMember.color : members[0].color,
      stoiip: members[0].stoiip,
      members,
    };
  });
}

function renderStoiipChart(container, rows) {
  const withStoiip = groupByPdKey(rows.filter((r) => r.stoiip != null)).sort((a, b) => b.stoiip - a.stoiip);
  if (!withStoiip.length) return;

  const card = document.createElement('div');
  card.className = 'chart-card';
  const title = document.createElement('h3');
  title.className = 'chart-card-title';
  title.textContent = 'STOIIP por contrato/campo (óleo in situ)';
  const sub = document.createElement('p');
  sub.className = 'chart-card-subtitle';
  sub.textContent = `Só as ${withStoiip.length} entidades/grupos com Plano de Desenvolvimento público — as demais ainda não têm PD aprovado/divulgado. Contrato e campo de contexto do mesmo PD (mesma jazida compartilhada) aparecem juntos numa barra só. Cor própria = grupo com contrato rastreado; cinza = só campo de contexto.`;
  card.appendChild(title);
  card.appendChild(sub);

  const list = document.createElement('div');
  list.className = 'hbar-list';
  const max = Math.max(...withStoiip.map((r) => r.stoiip));
  for (const g of withStoiip) {
    const row = document.createElement('div');
    row.className = 'hbar-row';
    const name = document.createElement('div');
    name.className = 'hbar-name';
    name.textContent = g.name;
    name.title = g.name;
    const track = document.createElement('div');
    track.className = 'hbar-track';
    const fill = document.createElement('div');
    fill.className = 'hbar-fill';
    fill.style.width = Math.max(3, (g.stoiip / max) * 100) + '%';
    fill.style.background = g.color;
    fill.tabIndex = 0;
    attachTooltip(fill, () => `<strong>${escapeHtml(g.name)}</strong>`
      + tooltipRowHTML('STOIIP', `${fmtNum(g.stoiip)} MMbbl`)
      + (g.members.length > 1 ? `<div class="viz-tooltip-row"><span>Mesma jazida compartilhada, ${g.members.length} entidades</span></div>` : ''));
    track.appendChild(fill);
    const value = document.createElement('div');
    value.className = 'hbar-value';
    value.textContent = fmtNum(g.stoiip) + ' MMbbl';
    track.appendChild(value);
    row.appendChild(name);
    row.appendChild(track);
    list.appendChild(row);
  }
  card.appendChild(list);
  container.appendChild(card);
}

function buildStackedBarRow(row, maxTotal, categoryOrder) {
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
  for (const [cat, label, colorVar] of categoryOrder) {
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
function buildWellsStackedCard(rows, title, subtitle, categoryOrder) {
  categoryOrder = categoryOrder || WELL_CATEGORY_ORDER;
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
  for (const [, label, colorVar] of categoryOrder) {
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
    for (const r of withWells) list.appendChild(buildStackedBarRow(r, max, categoryOrder));
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

// Cartão de colunas por ano — reaproveitado por "FPSOs por ano" e "poços
// por ano" (mesma forma de coluna, só muda a série de contagem e o rótulo
// do tooltip).
function buildYearColumnCard(byYear, title, subtitle, tooltipLabel) {
  const years = Object.keys(byYear).map(Number);
  if (!years.length) return null;
  const minY = Math.min(...years);
  const maxY = Math.max(...years);

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
    attachTooltip(fill, () => `<strong>${y}</strong>` + tooltipRowHTML(tooltipLabel, String(count)));
    const label = document.createElement('div');
    label.className = 'vbar-label';
    label.textContent = String(y);
    col.appendChild(val);
    col.appendChild(fill);
    col.appendChild(label);
    chart.appendChild(col);
  }
  card.appendChild(chart);
  return card;
}

function renderFpsoByYearChart(container, projects) {
  const byYear = computeFpsoByYear(projects);
  const years = Object.keys(byYear).map(Number);
  if (!years.length) return;
  const total = years.reduce((s, y) => s + byYear[y], 0);
  const minY = Math.min(...years);
  const maxY = Math.max(...years);
  const card = buildYearColumnCard(
    byYear,
    'Primeiro óleo por FPSO, por ano',
    `${total} FPSOs em operação entre ${minY} e ${maxY}.`,
    'FPSOs com 1º óleo',
  );
  if (card) container.appendChild(card);
}

// Dedup — ver AGGREGATE_DEDUP_EXCLUDE: soma poços dos contratos de
// produção rastreados + campos de contexto (menos os excluídos) + poços
// sem campo nomeado, sem contar o mesmo poço duas vezes (Mero dentro de
// Libra). Só serve pra agregados de portfólio — a tabela e os gráficos
// por entidade continuam mostrando cada contrato/campo separado.
function dedupedProducaoWells(producaoProjectRows, fieldRows, outrosPocos) {
  const wells = [];
  for (const r of producaoProjectRows) wells.push(...(pocosData[r.name] || []));
  for (const r of fieldRows) {
    if (r.isOutros || AGGREGATE_DEDUP_EXCLUDE.includes(r.name)) continue;
    wells.push(...(pocosData[r.name] || []));
  }
  wells.push(...outrosPocos);
  // Poço definitivamente abandonado fica fora daqui também — ver nota em
  // WELL_CATEGORY_ORDER — pra "poços por ano" e os stat tiles de
  // produtores/injetores não contarem poço fora de operação.
  return wells.filter((w) => wellCategory(w) !== 'abandonado');
}

function computeProdInjStats(wells) {
  let produtores = 0;
  let injAgua = 0;
  let injGas = 0;
  let injOutro = 0;
  for (const w of wells) {
    const cat = wellCategory(w);
    if (cat === 'producao') produtores++;
    else if (cat === 'injecao') {
      const t = wellInjectionType(w);
      if (t === 'agua') injAgua++;
      else if (t === 'gas') injGas++;
      else injOutro++;
    }
  }
  return { produtores, injAgua, injGas, injOutro, injetores: injAgua + injGas + injOutro };
}

// "Poços perfurados por ano" — usa a data de conclusão/início de cada
// poço (w.d). Corta em MIN_YEAR: a base tem uns poucos poços de 1980-1999
// (8 no total) bem espalhados, que só esticariam o eixo sem acrescentar
// leitura — ficam resumidos numa nota em vez de 20 colunas quase vazias.
const WELLS_BY_YEAR_MIN = 2000;
function renderWellsByYearChart(container, wells) {
  const byYear = {};
  let early = 0;
  for (const w of wells) {
    if (!w.d) continue;
    const y = yearOfISO(w.d);
    if (y == null) continue;
    if (y < WELLS_BY_YEAR_MIN) { early++; continue; }
    byYear[y] = (byYear[y] || 0) + 1;
  }
  const years = Object.keys(byYear).map(Number);
  if (!years.length) return;
  const total = years.reduce((s, y) => s + byYear[y], 0);
  const minY = Math.min(...years);
  const maxY = Math.max(...years);
  const card = buildYearColumnCard(
    byYear,
    'Poços perfurados por ano',
    `${fmtNum(total)} poços entre ${minY} e ${maxY}${early ? ` — mais ${early} antes de ${WELLS_BY_YEAR_MIN}, fora do gráfico` : ''}. Contratos de produção + campos de contexto (sem Mero, já contado em Libra) + poços sem campo nomeado.`,
    'Poços perfurados',
  );
  if (card) container.appendChild(card);
}

// "Poços por FPSO instalado" — total de poços do contrato dividido pelo
// número de FPSOs já instalados. É densidade média por projeto, não
// poço-a-poço por unidade (a base ANP não registra a qual FPSO cada poço
// está ligado).
function renderWellsPerFpsoChart(container, projectRows) {
  const withFpso = projectRows
    .filter((r) => r.fpsoInstalled > 0)
    .map((r) => ({ ...r, perFpso: r.wellsTotal / r.fpsoInstalled }))
    .sort((a, b) => b.perFpso - a.perFpso);
  if (!withFpso.length) return;

  const card = document.createElement('div');
  card.className = 'chart-card';
  const title = document.createElement('h3');
  title.className = 'chart-card-title';
  title.textContent = 'Poços por FPSO instalado (média)';
  const sub = document.createElement('p');
  sub.className = 'chart-card-subtitle';
  sub.textContent = 'Poços do contrato (base ANP/BDEP) dividido pelo número de FPSOs já instalados — densidade média por projeto; a base não liga poço individual a FPSO individual.';
  card.appendChild(title);
  card.appendChild(sub);

  const list = document.createElement('div');
  list.className = 'hbar-list';
  const max = Math.max(...withFpso.map((r) => r.perFpso));
  for (const r of withFpso) {
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
    fill.style.width = Math.max(3, (r.perFpso / max) * 100) + '%';
    fill.style.background = r.color;
    fill.tabIndex = 0;
    attachTooltip(fill, () => `<strong>${escapeHtml(r.name)}</strong>`
      + tooltipRowHTML('Poços', String(r.wellsTotal))
      + tooltipRowHTML('FPSOs instalados', String(r.fpsoInstalled))
      + tooltipRowHTML('Poços/FPSO', fmtNum(r.perFpso, { maximumFractionDigits: 1 })));
    track.appendChild(fill);
    const value = document.createElement('div');
    value.className = 'hbar-value';
    value.textContent = fmtNum(r.perFpso, { maximumFractionDigits: 1 }) + ' poços/FPSO';
    track.appendChild(value);
    row.appendChild(name);
    row.appendChild(track);
    list.appendChild(row);
  }
  card.appendChild(list);
  container.appendChild(card);
}

// Nome com uma bolinha da cor da entidade — cor própria pra contrato
// rastreado, CONTEXT_FIELD_COLOR (cinza) pra campo de contexto ou poço
// sem campo nomeado. É o "colorindo só quem tem contrato" pedido, num só
// lugar reaproveitado pela tabela de produção e pela de exploração.
function nameCellHTML(r) {
  return `<div class="proj-name-cell"><span class="proj-dot" style="background:${r.color}"></span>${escapeHtml(r.name)}</div>`;
}

/* ------------------------ Campos de contexto (não-CPP) --------------------- */
// Campos do play do pré-sal que não são nenhum dos 29 contratos rastreados
// acima (ver PRESALT_FIELDS_URL) — a maioria em regime de Concessão ou
// Cessão Onerosa, bem anterior à Lei da Partilha (2010); só Mero é
// Partilha. Alguns ficam dentro da área de um contrato rastreado (Mero
// dentro do bloco de Libra, por exemplo) — daí entrarem na mesma tabela/
// gráfico dos contratos de produção só com uma cor diferente, em vez de
// somados nos KPIs do topo: somar contaria poço/volume em dobro.

function computeFieldRow(feature) {
  const props = feature.properties;
  const name = props.nome;
  const pd = pdData[name];
  const volumes = pd && pd.volumes ? pd.volumes : null;
  // Campo de contexto só aparece na seção "Campos em produção" — nunca na
  // de exploração — então já sai contado sem abandonado, igual aos
  // contratos rastreados dessa seção (ver withoutAbandonedWells).
  return withoutAbandonedWells({
    name,
    color: CONTEXT_FIELD_COLOR,
    isContract: false,
    operador: props.operador || null,
    bacia: props.bacia || null,
    regime: regimeOf(props.rodada),
    areaKm2: props.area_km2 || null,
    stoiip: volumes && volumes.oleoInSituMMbbl != null ? volumes.oleoInSituMMbbl : null,
    participacao: participacaoText(pd),
    pdKey: pd ? pd.fonte : null,
  });
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
  const wells = outrosPocos.filter((w) => wellCategory(w) !== 'abandonado');
  const counts = {};
  for (const [cat] of WELL_CATEGORY_ORDER) counts[cat] = 0;
  for (const w of wells) counts[wellCategory(w)]++;
  return {
    name: 'Outros poços do pré-sal (sem campo nomeado)',
    color: CONTEXT_FIELD_COLOR,
    isContract: false,
    operador: null,
    bacia: null,
    regime: null,
    areaKm2: null,
    wellsTotal: wells.length,
    wellCounts: counts,
    stoiip: null,
    participacao: null,
    isOutros: true,
  };
}

// Tabela unificada da seção "Campos em Produção": contratos rastreados do
// grupo produção + campos de contexto + poços sem campo nomeado, cada
// grupo com seu próprio cabeçalho (como as duas tabelas separadas faziam
// antes), mas agora numa tabela só — dá pra comparar contrato e campo
// lado a lado, e o ponto pedido ("colorindo só quem tem contrato") fica
// visível linha a linha.
function renderProducaoTable(container, contractRows, fieldRows) {
  const wrap = document.createElement('div');
  wrap.className = 'table-wrapper';
  wrap.style.padding = '0';
  const table = document.createElement('table');
  table.className = 'data-table analytics-table';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr>
    <th>Nome</th>
    <th>Regime</th>
    <th>Operador</th>
    <th>Parceiros (%)</th>
    <th>Bacia</th>
    <th class="num">Poços (ANP)</th>
    <th class="num">Produtores</th>
    <th class="num">Injetores</th>
    <th class="num">FPSOs</th>
    <th class="num">STOIIP (MMbbl)</th>
    <th class="num">Vol. recuperável (MMbbl)</th>
    <th class="num">Área (km²)</th>
  </tr>`;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const contracts = [...contractRows].sort((a, b) => b.wellsTotal - a.wellsTotal);
  const named = fieldRows.filter((r) => !r.isOutros).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const outros = fieldRows.filter((r) => r.isOutros);
  const groups = [
    ['Contratos rastreados (Partilha)', contracts],
    ['Campos de contexto', named],
    ['Poços sem campo nomeado', outros],
  ];
  for (const [label, groupRows] of groups) {
    if (!groupRows.length) continue;
    const gtr = document.createElement('tr');
    gtr.className = 'group-row';
    const gtd = document.createElement('td');
    gtd.colSpan = 12;
    gtd.textContent = `${label} (${groupRows.length})`;
    gtr.appendChild(gtd);
    tbody.appendChild(gtr);
    for (const r of groupRows) {
      const tr = document.createElement('tr');
      if (r.isOutros) tr.className = 'muted';
      const regimeLabel = r.isContract ? 'Partilha' : (r.regime || '—');
      tr.innerHTML = `
        <td>${nameCellHTML(r)}</td>
        <td class="${r.isContract || r.regime === 'Partilha' ? '' : 'muted'}">${escapeHtml(regimeLabel)}</td>
        <td class="${r.operador ? '' : 'muted'}">${escapeHtml(r.operador || '—')}</td>
        <td class="${r.participacao ? '' : 'muted'} participacao-cell">${escapeHtml(r.participacao || '—')}</td>
        <td class="${r.bacia ? '' : 'muted'}">${escapeHtml(r.bacia || '—')}</td>
        <td class="num">${r.wellsTotal || '—'}</td>
        <td class="num">${r.wellCounts.producao || '—'}</td>
        <td class="num">${r.wellCounts.injecao || '—'}</td>
        <td class="num">${r.isContract ? `${r.fpsoInstalled}${r.fpsoPlanned ? ` (+${r.fpsoPlanned})` : ''}` : '—'}</td>
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
  note.textContent = 'Cor do nome = cor do contrato (a mesma do roadmap/mapa); cinza = campo de contexto ou poço sem campo nomeado, sem contrato próprio. Parceiros: só onde o sumário executivo de PD publicado trouxe a tabela de participação. FPSOs: instalados (+ previstos entre parênteses) — só contrato rastreado tem essa informação. Mero soma poço em dobro com Libra de propósito (é o campo dentro do bloco) — os KPIs do topo e os gráficos de poços por ano/produtores-injetores excluem esse dobro; esta tabela mostra os dois porque aqui cada linha é uma entidade, não uma soma.';
  container.appendChild(note);
}

function renderProducaoSection(container, contractRows, fieldRows, outrosPocos, allProjects) {
  const allEntities = [...contractRows, ...fieldRows];
  const wells = dedupedProducaoWells(contractRows, fieldRows, outrosPocos);
  const stats = computeProdInjStats(wells);
  const namedFields = fieldRows.filter((r) => !r.isOutros);

  const intro = document.createElement('p');
  intro.className = 'chart-card-subtitle';
  intro.style.margin = '0 0 14px';
  intro.textContent = `Os ${contractRows.length} contratos rastreados já em produção, mais os ${namedFields.length} campos de contexto do pré-sal (Concessão, Cessão Onerosa e só Mero em Partilha) e os poços sem campo nomeado — o play de produção inteiro. Cor própria = contrato rastreado; cinza = campo de contexto ou poço avulso, sem contrato próprio.`;
  container.appendChild(intro);

  const statsRow = document.createElement('div');
  statsRow.className = 'kpi-row';
  statsRow.style.marginBottom = '18px';
  statsRow.appendChild(statTile(
    'Poços produtores', fmtNum(stats.produtores),
    'Contratos de produção + campos de contexto + poços avulsos, sem contar Mero duas vezes',
  ));
  statsRow.appendChild(statTile(
    'Poços injetores', fmtNum(stats.injetores),
    `${fmtNum(stats.injAgua)} água · ${fmtNum(stats.injGas)} gás${stats.injOutro ? ` · ${fmtNum(stats.injOutro)} outro` : ''}`,
  ));
  container.appendChild(statsRow);

  renderStoiipChart(container, allEntities);
  container.appendChild(buildWellsStackedCard(
    allEntities,
    'Poços por categoria, por contrato/campo',
    'Base ANP/BDEP — contratos de produção rastreados + campos de contexto + poços sem campo nomeado.',
  ));
  renderWellsPerFpsoChart(container, contractRows);
  renderFpsoByYearChart(container, allProjects);
  renderWellsByYearChart(container, wells);
  renderProducaoTable(container, contractRows, fieldRows);
}

function renderExploracaoSection(container, explorationRows) {
  const exploracaoCount = explorationRows.filter((r) => r.group === 'exploracao').length;
  const devolvidosCount = explorationRows.filter((r) => r.group === 'devolvidos').length;

  const intro = document.createElement('p');
  intro.className = 'chart-card-subtitle';
  intro.style.margin = '0 0 14px';
  intro.textContent = `Os ${explorationRows.length} contratos que ainda não chegaram à produção — ${exploracaoCount} em exploração e ${devolvidosCount} devolvidos (sem descoberta comercial). Nenhum tem Plano de Desenvolvimento, FPSO ou STOIIP — só o que a exploração já perfurou até agora.`;
  container.appendChild(intro);

  container.appendChild(buildWellsStackedCard(
    explorationRows,
    'Poços por categoria, por contrato de exploração',
    'Base ANP/BDEP — poços pioneiros e de avaliação; a maioria acaba abandonada (rotina de poço exploratório) independente do resultado geológico, ver nota em shared.js/wellCategory.',
    EXPLORATION_WELL_CATEGORY_ORDER,
  ));

  const wrap = document.createElement('div');
  wrap.className = 'table-wrapper';
  wrap.style.padding = '0';
  const table = document.createElement('table');
  table.className = 'data-table analytics-table';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr>
    <th>Contrato</th>
    <th>Status</th>
    <th>Operador</th>
    <th>Parceiros (%)</th>
    <th>Bacia</th>
    <th class="num">Leilão</th>
    <th class="num">Poços (ANP)</th>
    <th class="num">Área (km²)</th>
  </tr>`;
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  const sorted = [...explorationRows].sort((a, b) => (a.leilaoYear || 9999) - (b.leilaoYear || 9999));
  for (const r of sorted) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${nameCellHTML(r)}</td>
      <td>${r.group === 'devolvidos' ? 'Devolvido' : 'Em exploração'}</td>
      <td class="${r.operador ? '' : 'muted'}">${escapeHtml(r.operador || '—')}</td>
      <td class="${r.participacao ? '' : 'muted'} participacao-cell">${escapeHtml(r.participacao || '—')}</td>
      <td class="${r.bacia ? '' : 'muted'}">${escapeHtml(r.bacia || '—')}</td>
      <td class="num">${r.leilaoYear != null ? r.leilaoYear : '—'}</td>
      <td class="num">${r.wellsTotal || '—'}</td>
      <td class="num">${r.areaKm2 != null ? fmtNum(r.areaKm2) : '—'}</td>
    `;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
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

  // Duas seções, cada uma com seus próprios gráficos e tabela — em vez de
  // "Gráficos" + "Projetos" + "Campos" genéricos, a análise agora segue o
  // ciclo de vida do contrato: campos que já produzem (rastreados +
  // contexto, juntos) de um lado, contratos que ainda estão em exploração
  // (ou devolvidos sem descoberta) do outro.
  // withoutAbandonedWells só na produção — ver nota em WELL_CATEGORY_ORDER;
  // a de exploração usa o row bruto (rows), com abandonado incluído.
  const producaoRows = rows.filter((r) => r.group === 'producao').map(withoutAbandonedWells);
  const exploracaoRows = rows.filter((r) => r.group === 'exploracao' || r.group === 'devolvidos');

  const producaoSection = document.createElement('section');
  producaoSection.className = 'analytics-section';
  const producaoTitle = document.createElement('h2');
  producaoTitle.className = 'analytics-section-title';
  producaoTitle.textContent = 'Campos em produção';
  producaoSection.appendChild(producaoTitle);
  renderProducaoSection(producaoSection, producaoRows, fieldRows, outrosPocos, state.projects);
  wrapper.appendChild(producaoSection);

  const exploracaoSection = document.createElement('section');
  exploracaoSection.className = 'analytics-section';
  const exploracaoTitle = document.createElement('h2');
  exploracaoTitle.className = 'analytics-section-title';
  exploracaoTitle.textContent = 'Contratos de exploração';
  exploracaoSection.appendChild(exploracaoTitle);
  renderExploracaoSection(exploracaoSection, exploracaoRows);
  wrapper.appendChild(exploracaoSection);
}

init();
