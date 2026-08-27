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
// Campos de contexto do pré-sal (ver mapa.js) — regime de Concessão ou
// Cessão Onerosa, bem anterior à Lei da Partilha (2010); nenhum dos 30
// projetos rastreados (Mero, o único campo de contexto em Partilha, virou
// projeto próprio — ver seedState em shared.js). Ficam numa seção à parte,
// sem somar nos KPIs do topo: somar contaria o mesmo poço/volume duas
// vezes com algum contrato rastreado que sobreponha a mesma área.
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
// gráficos/tabelas unificados — só os 30 projetos rastreados têm cor
// própria (a mesma do roadmap/mapa, project.color); tudo que não é
// contrato usa este cinza, pra "colorindo só quem tem contrato" ficar
// óbvio à primeira vista em qualquer gráfico.
const CONTEXT_FIELD_COLOR = '#7a828f';

let featureByProject = {};
let pocosData = {};
let pdData = {};

// Ordem cronológica fixa das rodadas/ciclos de licitação que arremataram os
// 30 projetos rastreados — não dá pra ordenar as strings alfabeticamente:
// "Rodada 2" (bare, Norte de Carcará) é a 2ª Rodada de CONCESSÃO (ano 2000);
// "Rodada 2 (PP)" (Entorno de Sapinhoá) é a 2ª Rodada de PARTILHA (2017) —
// dois sistemas de numeração completamente diferentes que só coincidem no
// número. Cada entrada é [chaves brutas do campo "rodada", rótulo de
// exibição por extenso com o ano] — mais de uma chave bruta pro mesmo
// balde porque o mesmo leilão aparece com convenção de nome diferente
// conforme o shapefile de origem (Mero, que empresta feature de
// campos_presal.geojson, cita "Rodada 1 (PP)" pro mesmo leilão que Libra,
// de contratos.geojson, chama "Partilha 1").
const RODADA_ORDER = [
  [['Rodada 2'], '2ª Rodada Concessão (2000)'],
  [['Cessão Onerosa'], 'Cessão Onerosa (2010)'],
  [['Partilha 1', 'Rodada 1 (PP)'], '1ª Rodada Partilha (2013)'],
  [['Rodada 2 (PP)'], '2ª Rodada Partilha (2017)'],
  [['Partilha 3'], '3ª Rodada Partilha (2017)'],
  [['Partilha 4'], '4ª Rodada Partilha (2018)'],
  [['Partilha 5'], '5ª Rodada Partilha (2018)'],
  [['Partilha 6'], '6ª Rodada Partilha (2019)'],
  [['OPP1'], 'Oferta Permanente — 1º Ciclo (2022)'],
  [['OPP2'], 'Oferta Permanente — 2º Ciclo (2023)'],
  [['OPP3'], 'Oferta Permanente — 3º Ciclo (2025)'],
];
// Sul de Gato do Mato não tem feature em contratos.geojson (sem poligonal
// na ANP, ver PROJECTS_WITHOUT_SHAPE em mapa.js) — mesma rodada de Entorno
// de Sapinhoá (2ª Rodada de Partilha, 2017, ver fonteObs do bloco em
// data/planos_desenvolvimento.json), sem outra fonte estruturada pra puxar
// isso automaticamente.
const RODADA_OVERRIDE = { 'Sul de Gato do Mato': 'Rodada 2 (PP)' };
function rodadaOf(project) {
  const feat = featureByProject[project.name];
  return (feat && feat.properties.rodada) || RODADA_OVERRIDE[project.name] || null;
}

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
// nos campos de contexto (ver computeFieldRow) — os 30 projetos
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
  const wells = contractOwnWells(pocosData, projectName);
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
  const wells = contractOwnWells(pocosData, row.name)
    .filter((w) => wellCategory(w) !== 'abandonado');
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
  const pd = byNameOrUpper(pdData, project.name);
  const volumes = pd && pd.volumes ? pd.volumes : null;
  return {
    name: project.name,
    color: project.color,
    isContract: true,
    group: project.group,
    operador: props ? props.operador : null,
    bacia: props ? props.bacia : null,
    areaKm2: props && props.area_km2 ? props.area_km2 : null,
    rodada: rodadaOf(project),
    leilaoYear,
    wellsTotal: wc.total,
    wellCounts: wc.counts,
    fpsoInstalled: fpso.installed,
    fpsoPlanned: fpso.planned,
    firstOilYear: fpso.firstOilYear,
    leadTimeYears,
    stoiip: volumes && volumes.oleoInSituMMbbl != null ? volumes.oleoInSituMMbbl : null,
    recOleo: volumes && volumes.reservaProvada && volumes.reservaProvada.oleoMMbbl != null ? volumes.reservaProvada.oleoMMbbl : null,
    excedenteOleoPct: pd && pd.excedenteOleoPct != null ? pd.excedenteOleoPct : null,
    excedenteOleoObs: pd ? pd.excedenteOleoObs : null,
    tracts: pd && pd.tracts ? pd.tracts : null,
    participacao: participacaoText(pd),
    pdKey: pd ? pd.fonte : null,
    comercialidade: pd ? pd.comercialidade : null,
    resolucao: pd ? pd.resolucao : null,
    jazidaNome: jazidaNome(pd),
    jazidaComposicao: jazidaComposicao(pd),
    // Nome do contrato de partilha propriamente dito — ver
    // projectContractName em shared.js: nem sempre é o próprio
    // project.name (Mero cita "Libra", ver nota lá).
    contratoNome: projectContractName(project.name),
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
    `Base ANP/BDEP, todos os 30 projetos rastreados (inclui abandonados de exploração) — ${agg.wellCatTotals.producao} produtores · ${agg.wellCatTotals.injecao} injetores`,
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

// Uma barra por rodada/ciclo (ver RODADA_ORDER), ordem cronológica — não
// por contagem — pra ler como uma linha do tempo de licitações, não um
// ranking. Cor única (var(--accent)): mesma lógica de renderWellTypeChart,
// é contagem de uma categoria só por eixo, sem outra série pra comparar
// dentro da mesma barra.
function renderBlocksByRodadaChart(container, projects) {
  const counts = new Map();
  for (const p of projects) {
    const r = rodadaOf(p);
    if (!r) continue;
    if (!counts.has(r)) counts.set(r, []);
    counts.get(r).push(p.name);
  }
  const data = RODADA_ORDER
    .map(([keys, label]) => ({ label, names: keys.flatMap((k) => counts.get(k) || []) }))
    .filter((r) => r.names.length > 0);
  if (!data.length) return;

  const card = document.createElement('div');
  card.className = 'chart-card';
  const title = document.createElement('h3');
  title.className = 'chart-card-title';
  title.textContent = 'Blocos arrematados por rodada';
  const sub = document.createElement('p');
  sub.className = 'chart-card-subtitle';
  sub.textContent = `Os ${projects.length} projetos rastreados, pela rodada/ciclo de licitação da ANP em que cada bloco foi arrematado — ordem cronológica, da mais antiga à mais recente.`;
  card.appendChild(title);
  card.appendChild(sub);

  const list = document.createElement('div');
  list.className = 'hbar-list';
  const max = Math.max(...data.map((r) => r.names.length));
  for (const r of data) {
    const row = document.createElement('div');
    row.className = 'hbar-row';
    const name = document.createElement('div');
    name.className = 'hbar-name';
    name.textContent = r.label;
    name.title = r.label;
    const track = document.createElement('div');
    track.className = 'hbar-track';
    const fill = document.createElement('div');
    fill.className = 'hbar-fill';
    fill.style.width = Math.max(3, (r.names.length / max) * 100) + '%';
    fill.style.background = 'var(--accent)';
    fill.tabIndex = 0;
    attachTooltip(fill, () => `<strong>${escapeHtml(r.label)}</strong>`
      + tooltipRowHTML('Blocos', String(r.names.length))
      + `<div class="viz-tooltip-row"><span>${escapeHtml(r.names.join(', '))}</span></div>`);
    track.appendChild(fill);
    const value = document.createElement('div');
    value.className = 'hbar-value';
    value.textContent = String(r.names.length);
    track.appendChild(value);
    row.appendChild(name);
    row.appendChild(track);
    list.appendChild(row);
  }
  card.appendChild(list);
  container.appendChild(card);
}

// "Profit oil" = óleo lucro/excedente em óleo — a fatia do óleo excedente
// (depois do custo em óleo) que vai pra União, ofertada no leilão de cada
// bloco. Conceito específico do regime de Partilha de Produção (não existe
// em Concessão/Cessão Onerosa, que pagam royalties + participação especial
// em vez disso) — por isso a lista cobre só os blocos de Partilha, nunca
// os 30 projetos inteiros. rows já vem por projeto (ver computeProjectRow),
// não por jazida — cada bloco arrematado tem sua própria oferta de leilão,
// mesmo quando duas entradas depois viram a mesma jazida compartilhada.
function renderProfitOilChart(container, rows) {
  const withPct = rows.filter((r) => r.excedenteOleoPct != null).sort((a, b) => b.excedenteOleoPct - a.excedenteOleoPct);
  if (!withPct.length) return;

  const card = document.createElement('div');
  card.className = 'chart-card';
  const title = document.createElement('h3');
  title.className = 'chart-card-title';
  title.textContent = 'Profit oil por bloco (% de excedente em óleo)';
  const sub = document.createElement('p');
  sub.className = 'chart-card-subtitle';
  sub.textContent = `Percentual do óleo excedente ofertado à União no leilão de cada bloco — o "profit oil" do regime de Partilha de Produção. Só se aplica a contrato de Partilha (não a Concessão/Cessão Onerosa, que não têm esse mecanismo) — ${withPct.length} dos 30 projetos rastreados, pesquisado por rodada (ver data/planos_desenvolvimento.json).`;
  card.appendChild(title);
  card.appendChild(sub);

  const list = document.createElement('div');
  list.className = 'hbar-list';
  const max = Math.max(...withPct.map((r) => r.excedenteOleoPct));
  for (const r of withPct) {
    const row = document.createElement('div');
    row.className = 'hbar-row';
    const label = displayName(r);
    const name = document.createElement('div');
    name.className = 'hbar-name';
    name.textContent = label;
    name.title = label;
    const track = document.createElement('div');
    track.className = 'hbar-track';
    const fill = document.createElement('div');
    fill.className = 'hbar-fill';
    fill.style.width = Math.max(3, (r.excedenteOleoPct / max) * 100) + '%';
    fill.style.background = r.color;
    fill.tabIndex = 0;
    attachTooltip(fill, () => `<strong>${escapeHtml(label)}</strong>`
      + tooltipRowHTML('Profit oil', `${r.excedenteOleoPct.toLocaleString('pt-BR')}%`)
      + (r.excedenteOleoObs ? `<div class="viz-tooltip-row"><span>${escapeHtml(r.excedenteOleoObs)}</span></div>` : ''));
    track.appendChild(fill);
    const value = document.createElement('div');
    value.className = 'hbar-value';
    value.textContent = r.excedenteOleoPct.toLocaleString('pt-BR') + '%';
    track.appendChild(value);
    row.appendChild(name);
    row.appendChild(track);
    list.appendChild(row);
  }
  card.appendChild(list);
  container.appendChild(card);
}

// STOIIP por PROJETO (não por jazida — ver renderJazidaComboChart, a
// versão agrupada com TP/profit oil usada dentro de "Campos em Produção")
// — visão de portfólio inteiro logo na Visão Geral, cobrindo os 30
// projetos rastreados (produção + exploração + devolvidos), não só os já
// em produção.
function renderStoiipByBlockChart(container, rows) {
  const withStoiip = rows.filter((r) => r.stoiip != null).sort((a, b) => b.stoiip - a.stoiip);
  if (!withStoiip.length) return;

  const card = document.createElement('div');
  card.className = 'chart-card';
  const title = document.createElement('h3');
  title.className = 'chart-card-title';
  title.textContent = 'STOIIP estimado por bloco (óleo in situ)';
  const sub = document.createElement('p');
  sub.className = 'chart-card-subtitle';
  sub.textContent = `Volume de óleo em place estimado, por projeto rastreado — só os ${withStoiip.length} de 30 com Plano de Desenvolvimento público (a maioria dos blocos ainda em exploração não tem essa figura, só divulgada depois de comercialidade + PD aprovado).`;
  card.appendChild(title);
  card.appendChild(sub);

  const list = document.createElement('div');
  list.className = 'hbar-list';
  const max = Math.max(...withStoiip.map((r) => r.stoiip));
  for (const r of withStoiip) {
    const row = document.createElement('div');
    row.className = 'hbar-row';
    const label = displayName(r);
    const name = document.createElement('div');
    name.className = 'hbar-name';
    name.textContent = label;
    name.title = label;
    const track = document.createElement('div');
    track.className = 'hbar-track';
    const fill = document.createElement('div');
    fill.className = 'hbar-fill';
    fill.style.width = Math.max(3, (r.stoiip / max) * 100) + '%';
    fill.style.background = r.color;
    fill.tabIndex = 0;
    attachTooltip(fill, () => `<strong>${escapeHtml(label)}</strong>` + tooltipRowHTML('STOIIP', `${fmtNum(r.stoiip)} MMbbl`));
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

// Contrato rastreado e campo de contexto que citam o mesmo Plano de
// Desenvolvimento (Atapu/Oeste de Atapu, Sapinhoá/Entorno de Sapinhoá,
// Norte de Carcará/Bacalhau, Berbigão/Norte de Berbigão/Sul de Berbigão)
// são a mesma jazida compartilhada, só documentada do ponto de vista do
// contrato inteiro ou só do campo por dentro (ver jazidaNome/
// jazidaComposicao em shared.js). Agrupa por pd.fonte (a URL do PD é a
// chave real de "é o mesmo documento") — base de computeJazidaRows abaixo,
// que agrega poços/FPSOs de cada grupo numa linha só pra toda a seção
// "Campos em Produção" (gráficos e tabela).
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

// Uma linha por JAZIDA (não por contrato/campo separado) — toda a seção
// "Campos em Produção" (gráficos e tabela) analisa nesse nível, agregando
// os membros do mesmo grupo de groupByPdKey. Contrato + campo de contexto
// ligados (ex.: Norte de Carcará + BACALHAU) somam poços/FPSOs numa linha
// só; STOIIP/volume recuperável não somam — é a mesma jazida, mesmo
// volume, já vem igual em cada membro (ver groupByPdKey). Grupo de 1
// membro só (a maioria — Búzios, Itapu, Lapa...) sai idêntico à linha
// original, sem essa agregação mudar nada.
function computeJazidaRows(contractRows, fieldRows) {
  return groupByPdKey([...contractRows, ...fieldRows]).map((g) => {
    const contractMember = g.members.find((m) => m.isContract);
    const rep = contractMember || g.members[0];
    // Nome: o do contrato (já no "nome popular", ver displayName) quando
    // tem contrato no grupo; senão o primeiro pedaço do título do PD antes
    // do "e"/"," — "Berbigão, Norte de Berbigão e Sul de Berbigão" vira só
    // "Berbigão", mesma lógica que já dá "Bacalhau"/"Sapinhoá" pros
    // contratos com override (ver PROJECT_DISPLAY_NAME_OVERRIDE).
    const name = contractMember
      ? displayName(contractMember)
      : (rep.jazidaNome || g.name).split(/,| e /)[0].trim();
    const wellCounts = {};
    for (const [cat] of WELL_CATEGORY_ORDER) wellCounts[cat] = 0;
    let wellsTotal = 0;
    let fpsoInstalled = 0;
    let fpsoPlanned = 0;
    let areaKm2 = 0;
    for (const m of g.members) {
      wellsTotal += m.wellsTotal;
      for (const [cat] of WELL_CATEGORY_ORDER) wellCounts[cat] += m.wellCounts[cat] || 0;
      fpsoInstalled += m.fpsoInstalled || 0;
      fpsoPlanned += m.fpsoPlanned || 0;
      areaKm2 += m.areaKm2 || 0;
    }
    const others = g.members.filter((m) => m !== rep).map((m) => displayName(m));
    return {
      name,
      color: g.color,
      isContract: !!contractMember,
      group: rep.group,
      operador: rep.operador,
      bacia: rep.bacia,
      regime: contractMember ? 'Partilha' : (rep.regime || '—'),
      areaKm2: areaKm2 || null,
      wellsTotal,
      wellCounts,
      fpsoInstalled,
      fpsoPlanned,
      stoiip: g.stoiip,
      recOleo: rep.recOleo,
      excedenteOleoPct: rep.excedenteOleoPct,
      // Composição estruturada da jazida (ver "tracts" em data/planos_
      // desenvolvimento.json) — mesmo array em todo membro do grupo que a
      // publica (ex.: Norte de Carcará e BACALHAU citam o mesmo), então
      // o primeiro membro que tiver já serve.
      tracts: g.members.map((m) => m.tracts).find(Boolean) || null,
      participacao: rep.participacao,
      comercialidade: g.members.map((m) => m.comercialidade).find(Boolean) || null,
      resolucao: g.members.map((m) => m.resolucao).find(Boolean) || null,
      // Contrato de partilha por trás da linha, pra nameCellHTML — o do
      // membro contrato (já no nome real, ver projectContractName em
      // shared.js) quando existe; senão null (grupo só de campos de
      // contexto, ex. Berbigão, sem contrato rastreado nenhum).
      contratoNome: contractMember ? contractMember.contratoNome : null,
      membersOther: others,
      memberCount: g.members.length,
      composicao: g.members.map((m) => m.jazidaComposicao).find(Boolean) || null,
    };
  });
}

// Uma linha de barra dentro de um grupo de jazida — mesmo <div class=
// "hbar-row"> usado pelos outros gráficos, só que aqui cada jazida monta
// várias dessas em sequência (uma por métrica/fatia) em vez de uma só.
function comboBarRow(label, widthPct, valueText, color, tooltipHtmlFn) {
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

// Um único cartão com 3 métricas por jazida — STOIIP, Tract Participation
// (TP, a % de cada fatia/contrato dentro da jazida, só quando há mais de
// um — ver "tracts" em data/planos_desenvolvimento.json, decomposição
// estruturada de pd.areaObs) e profit oil (% de excedente em óleo
// ofertado no leilão de cada fatia — só existe pra Partilha ou pro
// excedente da Cessão Onerosa; Concessão, Cessão Onerosa original e Área
// Não Contratada não têm esse mecanismo, ficam sem barra). Jazida sem
// "tracts" publicado vira uma fatia só (ela mesma, 100%) — mesmo
// resultado de antes (só STOIIP + profit oil do contrato, sem TP).
function renderJazidaComboChart(container, rows) {
  const withStoiip = rows.filter((r) => r.stoiip != null).sort((a, b) => b.stoiip - a.stoiip);
  if (!withStoiip.length) return;

  const card = document.createElement('div');
  card.className = 'chart-card';
  const title = document.createElement('h3');
  title.className = 'chart-card-title';
  title.textContent = 'STOIIP, participação (TP) e profit oil por jazida';
  const sub = document.createElement('p');
  sub.className = 'chart-card-subtitle';
  sub.textContent = `As ${withStoiip.length} jazidas com Plano de Desenvolvimento público. STOIIP (óleo in situ) por jazida; Tract Participation (TP) — % de cada fatia/contrato dentro da jazida — só onde o PD publica a composição e há mais de um contrato; profit oil — % de excedente em óleo ofertado no leilão de cada fatia, quando existe (Concessão e a fatia original da Cessão Onerosa não têm esse mecanismo, só a Partilha e o excedente da Cessão Onerosa).`;
  card.appendChild(title);
  card.appendChild(sub);

  const maxStoiip = Math.max(...withStoiip.map((r) => r.stoiip));

  for (const r of withStoiip) {
    const group = document.createElement('div');
    group.className = 'jazida-combo-group';

    const header = document.createElement('div');
    header.className = 'jazida-combo-header';
    header.innerHTML = `<span class="proj-dot" style="background:${r.color}"></span>${escapeHtml(r.name)}`;
    group.appendChild(header);

    // Fatia única sintética quando não há "tracts" publicado — mesmo
    // valor de profit oil que o contrato/jazida já carregava.
    const tracts = r.tracts && r.tracts.length ? r.tracts : [{ nome: r.name, pct: 100, excedenteOleoPct: r.excedenteOleoPct }];

    const stoiipMetric = document.createElement('div');
    stoiipMetric.className = 'jazida-combo-metric';
    const stoiipLabel = document.createElement('p');
    stoiipLabel.className = 'jazida-combo-metric-label';
    stoiipLabel.textContent = 'STOIIP';
    stoiipMetric.appendChild(stoiipLabel);
    stoiipMetric.appendChild(comboBarRow(
      r.name, (r.stoiip / maxStoiip) * 100, fmtNum(r.stoiip) + ' MMbbl', r.color,
      () => `<strong>${escapeHtml(r.name)}</strong>` + tooltipRowHTML('STOIIP', `${fmtNum(r.stoiip)} MMbbl`),
    ));
    group.appendChild(stoiipMetric);

    if (tracts.length > 1) {
      const tpMetric = document.createElement('div');
      tpMetric.className = 'jazida-combo-metric';
      const tpLabel = document.createElement('p');
      tpLabel.className = 'jazida-combo-metric-label';
      tpLabel.textContent = 'Participação (TP)';
      tpMetric.appendChild(tpLabel);
      for (const t of tracts) {
        tpMetric.appendChild(comboBarRow(
          t.nome, t.pct, t.pct.toLocaleString('pt-BR') + '%', r.color,
          () => `<strong>${escapeHtml(t.nome)}</strong>` + tooltipRowHTML('Participação na jazida', `${t.pct.toLocaleString('pt-BR')}%`),
        ));
      }
      group.appendChild(tpMetric);
    }

    const withPct = tracts.filter((t) => t.excedenteOleoPct != null);
    const profitMetric = document.createElement('div');
    profitMetric.className = 'jazida-combo-metric';
    const profitLabel = document.createElement('p');
    profitLabel.className = 'jazida-combo-metric-label';
    profitLabel.textContent = 'Profit oil';
    profitMetric.appendChild(profitLabel);
    if (withPct.length) {
      for (const t of withPct) {
        const label = tracts.length > 1 ? t.nome : r.name;
        profitMetric.appendChild(comboBarRow(
          label, t.excedenteOleoPct, t.excedenteOleoPct.toLocaleString('pt-BR') + '%', r.color,
          () => `<strong>${escapeHtml(label)}</strong>` + tooltipRowHTML('Profit oil', `${t.excedenteOleoPct.toLocaleString('pt-BR')}%`),
        ));
      }
    } else {
      const note = document.createElement('p');
      note.className = 'jazida-combo-metric-note';
      note.textContent = 'Sem profit oil — regime de Concessão/Cessão Onerosa, sem esse mecanismo.';
      profitMetric.appendChild(note);
    }
    group.appendChild(profitMetric);

    card.appendChild(group);
  }
  container.appendChild(card);
}

// CATEGORIA (ANP/BDEP) é um campo cru que nunca virou estatística até
// agora — só aparecia em texto no popup do mapa e na aba Poços. É um eixo
// diferente do "resultado" que os gráficos de poços por categoria já
// mostram (wellCategory, calculado a partir de RECLASSIFICACAO/SITUACAO):
// CATEGORIA é o que o poço foi PROJETADO PRA SER (Desenvolvimento,
// Extensão, Pioneiro, Injeção, Especial, Jazida Mais Profunda, Pioneiro
// Adjacente, Estratigráfico), não o que ele achou. Dá o perfil do programa
// de perfuração — quanto é poço de avaliação/exploração vs. já é
// desenvolvimento/injeção — informação que nenhum gráfico existente
// mostra. Cor única (var(--accent), não uma das --viz-cat-N): é comparação
// de totais numa lista só, sem outra série na mesma barra, então uma cor
// da paleta categórica do resultado ao lado só criaria associação errada
// (ex.: essa barra usar o azul de "produção" não quer dizer que é sobre
// resultado de produção).
function computeWellTypeTotals(pocosData, outrosPocos) {
  const wells = [];
  for (const name of Object.keys(pocosData)) {
    wells.push(...contractOwnWells(pocosData, name));
  }
  wells.push(...outrosPocos);
  const totals = new Map();
  for (const w of wells) {
    const cat = w.cat || 'Sem categoria registrada';
    totals.set(cat, (totals.get(cat) || 0) + 1);
  }
  return [...totals.entries()]
    .map(([cat, count]) => ({ cat, count }))
    .sort((a, b) => b.count - a.count);
}

function renderWellTypeChart(container, pocosData, outrosPocos) {
  const totals = computeWellTypeTotals(pocosData, outrosPocos);
  if (!totals.length) return;
  const grandTotal = totals.reduce((s, t) => s + t.count, 0);

  const card = document.createElement('div');
  card.className = 'chart-card';
  const title = document.createElement('h3');
  title.className = 'chart-card-title';
  title.textContent = 'Poços por categoria de perfuração (ANP/BDEP)';
  const sub = document.createElement('p');
  sub.className = 'chart-card-subtitle';
  sub.textContent = `${fmtNum(grandTotal)} poços — todo o play do pré-sal (contratos rastreados + campos de contexto + poços sem campo nomeado, cada poço contado uma vez só). O que o poço foi projetado pra ser, não o resultado que achou (isso já está nos gráficos "poços por categoria" de cada seção abaixo).`;
  card.appendChild(title);
  card.appendChild(sub);

  const list = document.createElement('div');
  list.className = 'hbar-list';
  const max = Math.max(...totals.map((t) => t.count));
  for (const t of totals) {
    const row = document.createElement('div');
    row.className = 'hbar-row';
    const name = document.createElement('div');
    name.className = 'hbar-name';
    name.textContent = t.cat;
    name.title = t.cat;
    const track = document.createElement('div');
    track.className = 'hbar-track';
    const fill = document.createElement('div');
    fill.className = 'hbar-fill';
    fill.style.width = Math.max(3, (t.count / max) * 100) + '%';
    fill.style.background = 'var(--accent)';
    fill.tabIndex = 0;
    attachTooltip(fill, () => `<strong>${escapeHtml(t.cat)}</strong>`
      + tooltipRowHTML('Poços', fmtNum(t.count))
      + tooltipRowHTML('% do total', `${Math.round((t.count / grandTotal) * 100)}%`));
    track.appendChild(fill);
    const value = document.createElement('div');
    value.className = 'hbar-value';
    value.textContent = fmtNum(t.count);
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
// 30 projetos rastreados e pelos campos de contexto (mesma forma de linha,
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

// Soma poços dos contratos de produção rastreados (já sem os que
// pertencem a outro projeto rastreado com overlap conhecido, ver
// contractOwnWells/wellCountsFor) + campos de contexto + poços sem campo
// nomeado. Só serve pra agregados de portfólio — a tabela e os gráficos
// por entidade continuam mostrando cada contrato/campo separado.
function dedupedProducaoWells(producaoProjectRows, fieldRows, outrosPocos) {
  const wells = [];
  for (const r of producaoProjectRows) wells.push(...contractOwnWells(pocosData, r.name));
  for (const r of fieldRows) {
    if (r.isOutros) continue;
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
    `${fmtNum(total)} poços entre ${minY} e ${maxY}${early ? ` — mais ${early} antes de ${WELLS_BY_YEAR_MIN}, fora do gráfico` : ''}. Contratos de produção + campos de contexto + poços sem campo nomeado, cada poço contado uma vez só.`,
    'Poços perfurados',
  );
  if (card) container.appendChild(card);
}

// "Poços por FPSO instalado" — total de poços da jazida (ver
// computeJazidaRows) dividido pelo número de FPSOs já instalados. É
// densidade média por jazida, não poço-a-poço por unidade (a base ANP não
// registra a qual FPSO cada poço está ligado).
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

// projectDisplayName (nome popular da jazida no lugar do nome do contrato,
// ver shared.js) espera um nome de projeto — este wrapper aceita a row
// (contrato ou campo de contexto) usada nesta tela.
function displayName(r) {
  return projectDisplayName(r.name);
}

// Nome com uma bolinha da cor da entidade — cor própria pra contrato
// rastreado, CONTEXT_FIELD_COLOR (cinza) pra campo de contexto ou poço
// sem campo nomeado. É o "colorindo só quem tem contrato" pedido, num só
// lugar reaproveitado pela tabela de produção e pela de exploração.
// r.contratoNome (contrato de partilha por trás da linha — ver
// computeJazidaRows) vira uma segunda linha "Contrato: ..." só quando
// acrescenta informação (diferente do nome já exibido); grupo sem
// contrato mas com mais de um campo de contexto (só Berbigão hoje) mostra
// os outros membros em vez disso. Composição (% de cada membro na jazida,
// quando o PD publica) fica só como tooltip — não cabe numa tabela.
function nameCellHTML(r) {
  const name = displayName(r);
  let sub = '';
  if (r.contratoNome && r.contratoNome !== name) {
    sub = `<span class="proj-name-sub">Contrato: ${escapeHtml(r.contratoNome)}</span>`;
  } else if (r.membersOther && r.membersOther.length) {
    sub = `<span class="proj-name-sub">+ ${escapeHtml(r.membersOther.join(', '))}</span>`;
  }
  const title = r.composicao ? ` title="${escapeHtml(r.composicao)}"` : '';
  return `<div class="proj-name-cell"><span class="proj-dot" style="background:${r.color}"></span><span class="proj-name-stack"${title}><span class="proj-name-main">${escapeHtml(name)}</span>${sub}</span></div>`;
}

/* ------------------------ Campos de contexto (não-CPP) --------------------- */
// Campos do play do pré-sal que não são nenhum dos 30 projetos rastreados
// acima (ver PRESALT_FIELDS_URL) — regime de Concessão ou Cessão Onerosa,
// bem anterior à Lei da Partilha (2010); o único campo de contexto em
// Partilha (Mero) virou projeto rastreado próprio (ver seedState em
// shared.js) e é filtrado antes de chegar aqui (ver init).

function computeFieldRow(feature, projectByFonte) {
  const props = feature.properties;
  const name = props.nome;
  const pd = pdData[name];
  const volumes = pd && pd.volumes ? pd.volumes : null;
  const linkedProject = pd && pd.fonte ? projectByFonte.get(pd.fonte) : null;
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
    excedenteOleoPct: pd && pd.excedenteOleoPct != null ? pd.excedenteOleoPct : null,
    tracts: pd && pd.tracts ? pd.tracts : null,
    participacao: participacaoText(pd),
    pdKey: pd ? pd.fonte : null,
    comercialidade: pd ? pd.comercialidade : null,
    resolucao: pd ? pd.resolucao : null,
    jazidaNome: jazidaNome(pd),
    jazidaComposicao: jazidaComposicao(pd),
    // Contrato rastreado que cita o mesmo PD (mesma jazida) — ver
    // projectByPdFonte em shared.js e nameCellHTML abaixo.
    contratoNome: linkedProject ? linkedProject.name : null,
  });
}

// "outros" em data/pocos.json: poços do play do pré-sal (ATINGIU_PRESAL=
// 'S' na base ANP/BDEP) que não caem em nenhum dos 30 projetos
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
function renderProducaoTable(container, jazidaRows, outrosRow) {
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
    <th>Comercialidade</th>
    <th>PD (resolução)</th>
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
  const withContract = jazidaRows.filter((r) => r.isContract).sort((a, b) => b.wellsTotal - a.wellsTotal);
  const withoutContract = jazidaRows.filter((r) => !r.isContract).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const groups = [
    ['Jazidas com contrato de partilha', withContract],
    ['Campos de contexto (sem contrato rastreado)', withoutContract],
    ['Poços sem campo nomeado', outrosRow ? [outrosRow] : []],
  ];
  for (const [label, groupRows] of groups) {
    if (!groupRows.length) continue;
    const gtr = document.createElement('tr');
    gtr.className = 'group-row';
    const gtd = document.createElement('td');
    gtd.colSpan = 14;
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
        <td class="nowrap-cell ${r.comercialidade ? '' : 'muted'}">${r.comercialidade ? formatBR(r.comercialidade) : '—'}</td>
        <td class="nowrap-cell ${r.resolucao ? '' : 'muted'}">${escapeHtml(r.resolucao || '—')}</td>
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
  note.textContent = 'Uma linha por jazida: contrato rastreado e campo de contexto que citam o mesmo Plano de Desenvolvimento (ex.: Norte de Carcará + BACALHAU) somam poços/FPSOs numa linha só, com o nome popular da jazida (Bacalhau, Sapinhoá...) — passe o mouse sobre o nome pra ver a composição %, quando o PD publica. "Contrato" embaixo do nome mostra o contrato de partilha por trás; "+ outro(s) campo(s)" aparece quando a jazida não tem contrato rastreado (ex.: Berbigão). Cor do nome = cor do contrato; cinza = jazida sem contrato de partilha ou poço sem campo nomeado. Comercialidade = data da declaração de comercialidade; PD (resolução) = despacho da ANP que aprovou o Plano de Desenvolvimento. Parceiros: só onde o sumário executivo de PD publicado trouxe a tabela de participação. FPSOs: instalados (+ previstos entre parênteses) — soma de todos os membros da jazida.';
  container.appendChild(note);
}

function renderProducaoSection(container, contractRows, fieldRows, outrosPocos, allProjects) {
  const namedFieldRows = fieldRows.filter((r) => !r.isOutros);
  const outrosRow = fieldRows.find((r) => r.isOutros) || null;
  // Uma linha por jazida (ver computeJazidaRows) — todo gráfico e a
  // tabela desta seção usam jazidaRows a partir daqui, não mais contrato
  // e campo de contexto ligados como entidades separadas.
  const jazidaRows = computeJazidaRows(contractRows, namedFieldRows);
  const wells = dedupedProducaoWells(contractRows, fieldRows, outrosPocos);
  const stats = computeProdInjStats(wells);

  const intro = document.createElement('p');
  intro.className = 'chart-card-subtitle';
  intro.style.margin = '0 0 14px';
  intro.textContent = `As ${jazidaRows.length} jazidas/contratos avulsos já em produção (contrato rastreado + campo de contexto do mesmo PD somados numa linha só, quando é o caso) e os poços sem campo nomeado — o play de produção inteiro. Cor própria = jazida com contrato rastreado; cinza = só campo de contexto (sem contrato de partilha) ou poço avulso.`;
  container.appendChild(intro);

  const statsRow = document.createElement('div');
  statsRow.className = 'kpi-row';
  statsRow.style.marginBottom = '18px';
  statsRow.appendChild(statTile(
    'Poços produtores', fmtNum(stats.produtores),
    'Contratos de produção + campos de contexto + poços avulsos, cada poço contado uma vez só',
  ));
  statsRow.appendChild(statTile(
    'Poços injetores', fmtNum(stats.injetores),
    `${fmtNum(stats.injAgua)} água · ${fmtNum(stats.injGas)} gás${stats.injOutro ? ` · ${fmtNum(stats.injOutro)} outro` : ''}`,
  ));
  container.appendChild(statsRow);

  renderJazidaComboChart(container, jazidaRows);
  container.appendChild(buildWellsStackedCard(
    outrosRow ? [...jazidaRows, outrosRow] : jazidaRows,
    'Poços por categoria, por jazida',
    'Base ANP/BDEP — uma barra por jazida (contrato + campo de contexto ligados somados) + poços sem campo nomeado.',
  ));
  renderWellsPerFpsoChart(container, jazidaRows);
  renderFpsoByYearChart(container, allProjects);
  renderWellsByYearChart(container, wells);
  renderProducaoTable(container, jazidaRows, outrosRow);
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

  // Campo de contexto cujo nome bate com um projeto rastreado (hoje só
  // MERO -> "Mero") empresta operador/bacia/área pro projeto — Mero não
  // tem feature própria em contratos.geojson (só o bloco inteiro de
  // Libra), mas campos_presal.geojson tem a área declarada do campo (ver
  // mesma lógica em mapa.js/featureByProject). O campo é filtrado da
  // lista de campos de contexto logo abaixo pra não ser contado duas
  // vezes, na tabela/gráficos de "Campos de contexto".
  const trackedProjectByUpperName = new Map(state.projects.map((p) => [p.name.toUpperCase(), p]));
  const presalAllFeatures = presalGeojson ? presalGeojson.features : [];
  for (const feat of presalAllFeatures) {
    const trackedProject = trackedProjectByUpperName.get(feat.properties.nome.toUpperCase());
    if (trackedProject) featureByProject[trackedProject.name] = feat;
  }
  const presalFeatures = presalAllFeatures.filter((f) => !trackedProjectByUpperName.has(f.properties.nome.toUpperCase()));

  // Campo de contexto que cita o mesmo PD de um único projeto rastreado
  // (ver projectByPdFonte em shared.js) — usado por nameCellHTML/
  // computeFieldRow pra saber qual contrato citar como informação.
  const projectByFonte = projectByPdFonte(state.projects, pdData);

  const rows = state.projects.map(computeProjectRow);
  const agg = computeAggregates(rows);
  const fieldRows = presalFeatures.map((f) => computeFieldRow(f, projectByFonte));
  if (outrosPocos.length) fieldRows.push(computeOutrosRow(outrosPocos));

  wrapper.innerHTML = '';

  const kpiSection = document.createElement('section');
  kpiSection.className = 'analytics-section';
  const kpiTitle = document.createElement('h2');
  kpiTitle.className = 'analytics-section-title';
  kpiTitle.textContent = 'Visão Geral';
  kpiSection.appendChild(kpiTitle);
  renderKPIRow(kpiSection, agg);
  renderBlocksByRodadaChart(kpiSection, state.projects);
  renderProfitOilChart(kpiSection, rows);
  renderStoiipByBlockChart(kpiSection, rows);
  renderWellTypeChart(kpiSection, pocosData, outrosPocos);
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
