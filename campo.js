'use strict';

/* =========================================================================
   PMO Roadmap — Campo. Uma sub-aba por projeto rastreado (os mesmos 30 de
   state.projects): contorno do campo + poços num mini-mapa, e os gráficos
   de produção/RGO mensal do próprio projeto (ANP). Cada painel é montado
   uma vez, na primeira vez que o projeto é aberto (mapa Leaflet + gráfico
   custam caro pra montar 30 vezes de cara), e fica em cache pra reabrir
   instantâneo depois — troca de aba de verdade (hidden), não
   scroll-to-anchor como pocos.html.
   Cálculo da série mensal (UNITS, computeRGO, computeFieldRows,
   computeMonthlySeries) e o gráfico de linhas interativo (createLineChart)
   vêm de shared.js — compartilhados com producao.js (visão por campo,
   todos os projetos juntos). Só 7 dos 30 projetos têm campo próprio no
   boletim da ANP (ver PROJECT_FIELD_BASE em shared.js) — os outros 23
   (exploração, ou produção ainda não individualizada no boletim) mostram
   uma nota no lugar dos gráficos em vez de um gráfico vazio/quebrado.
   ========================================================================= */

const GEOJSON_URL = 'data/contratos.geojson';
const PRESALT_FIELDS_URL = 'data/campos_presal.geojson';
const POCOS_URL = 'data/pocos.json';
const PRODUCAO_URL = 'data/producao.json';

const GROUP_BADGES = {
  producao: 'Produção',
  exploracao: 'Exploração',
  devolvidos: 'Devolvido',
};
const GROUP_ORDER = ['producao', 'exploracao', 'devolvidos'];

// Cor do marcador de poço no mini-mapa por categoria (ver wellCategory em
// shared.js) — diferente do mapa completo (mapa.js), que colore o poço
// pela cor do PROJETO (a forma do ícone já diz a categoria): aqui só há um
// projeto por mini-mapa, então a cor do próprio poço carrega a categoria.
const WELL_CATEGORY_DOT = {
  producao: '#1c9e6b',
  injecao: '#2f9ed6',
  indicio: '#e0a72e',
  gas: '#e07b2e',
  seco: '#d64545',
  abandonado: '#7a828f',
  indefinido: '#aeb4bd',
};
const RGO_LINE_COLOR = '#e0a72e';

function slug(name) {
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/* --------------------------- Série de um projeto --------------------------- */
// Recorta a série de TODOS os campos (computeMonthlySeries, shared.js) pro
// campo de um projeto só, preservando a posição de cada mês no array
// (rows: [] onde o projeto não tem linha naquele mês) — createLineChart
// espera um array com um item por mês do boletim inteiro (usa o índice
// pra eixo x e pra achar buraco de dado, ver buildSegments em shared.js);
// filtrar os meses sem linha desalinharia o eixo x do restante do app.
function extractProjectSeries(monthlySeries, displayName) {
  return monthlySeries.map((m) => {
    const row = m.rows.find((r) => r.name === displayName);
    return { ano: m.ano, mes: m.mes, rows: row ? [row] : [] };
  });
}

/* ------------------------------- Mini-mapa --------------------------------- */

function buildMiniMap(container, project, feature, wells) {
  const mapDiv = document.createElement('div');
  mapDiv.className = 'campo-mapa';
  container.appendChild(mapDiv);

  const map = L.map(mapDiv, { zoomControl: true, attributionControl: false, minZoom: 2 }).setView([-25.3, -43], 5);
  // Mesmo basemap escuro do mapa completo (Esri Canvas Dark Gray, ver nota
  // em mapa.js) — sem chave, funciona igual num container bem menor.
  L.tileLayer('https://server.arcgisonline.com/arcgis/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    maxNativeZoom: 16, maxZoom: 18,
  }).addTo(map);
  L.tileLayer('https://server.arcgisonline.com/arcgis/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
    maxNativeZoom: 16, maxZoom: 18,
  }).addTo(map);

  const bounds = L.latLngBounds([]);
  if (feature) {
    const layer = L.geoJSON(feature, {
      style: { color: project.color, weight: 2, fillColor: project.color, fillOpacity: 0.32 },
    }).addTo(map);
    bounds.extend(layer.getBounds());
  }
  for (const w of wells) {
    if (!w.c) continue;
    const color = WELL_CATEGORY_DOT[wellCategory(w)] || WELL_CATEGORY_DOT.indefinido;
    L.circleMarker(w.c, { radius: 4, weight: 1, color: '#0b0d10', fillColor: color, fillOpacity: 0.95 })
      .bindTooltip(w.n, { direction: 'top', offset: [0, -6] })
      .addTo(map);
    bounds.extend(w.c);
  }

  if (bounds.isValid()) {
    map.fitBounds(bounds, { padding: [24, 24] });
  }
  // Container criado hidden==false (painel só é montado na primeira vez em
  // que fica visível), mas o tamanho definitivo do flex layout só se
  // assenta depois do primeiro reflow — sem isso o Leaflet mede a largura
  // errada e o mapa nasce cortado/desalinhado até o usuário redimensionar
  // a janela.
  requestAnimationFrame(() => map.invalidateSize());

  return { map, hasShape: !!feature, hasWells: wells.some((w) => w.c) };
}

/* ----------------------- Gráfico combinado (produção + RGO) --------------- */
// Estático (sem zoom/pan, diferente de createLineChart): dois eixos Y
// independentes na mesma área de plotagem — produção (boe/d) à esquerda,
// RGO (m³/m³) à direita — pra comparar a forma das duas curvas ao longo do
// tempo sem trocar de gráfico. Mesmas dimensões/margens de createLineChart
// (LINE_W/LINE_H/LINE_MARGIN, shared.js) menos a margem direita, alargada
// pra caber os rótulos do segundo eixo.
const COMBO_MARGIN = { top: 16, right: 58, bottom: 62, left: 64 };

function buildComboChart(container, series, projectColor) {
  const n = series.length;
  const plotW = LINE_W - COMBO_MARGIN.left - COMBO_MARGIN.right;
  const plotH = LINE_H - COMBO_MARGIN.top - COMBO_MARGIN.bottom;
  const xAt = (i) => COMBO_MARGIN.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);

  const boeVals = series.map((m) => m.rows[0] && m.rows[0].boedPreSal).filter((v) => v != null);
  const rgoVals = series.map((m) => m.rows[0] && m.rows[0].rgo).filter((v) => v != null);
  const boeMax = niceMax(Math.max(0, ...boeVals));
  const rgoMax = niceMax(Math.max(0, ...rgoVals));
  const yBoeAt = (v) => COMBO_MARGIN.top + plotH - (v / boeMax) * plotH;
  const yRgoAt = (v) => COMBO_MARGIN.top + plotH - (v / rgoMax) * plotH;

  const yTicks = 5;
  let gridSvg = '';
  for (let i = 0; i <= yTicks; i++) {
    const boeV = (boeMax / yTicks) * i;
    const rgoV = (rgoMax / yTicks) * i;
    const y = yBoeAt(boeV);
    gridSvg += `<line x1="${COMBO_MARGIN.left}" y1="${y}" x2="${LINE_W - COMBO_MARGIN.right}" y2="${y}" stroke="var(--border)" stroke-width="1" />`;
    gridSvg += `<text x="${COMBO_MARGIN.left - 10}" y="${y + 4}" text-anchor="end" font-size="11" style="fill:var(--text-faint)">${fmtNum(boeV)}</text>`;
    gridSvg += `<text x="${LINE_W - COMBO_MARGIN.right + 10}" y="${y + 4}" text-anchor="start" font-size="11" style="fill:${RGO_LINE_COLOR}">${fmtNum(rgoV)}</text>`;
  }

  let xLabelsSvg = '';
  for (let i = 0; i < n; i++) {
    const m = series[i];
    const isLast = i === n - 1;
    if (m.mes !== 1 && !isLast) continue;
    const x = xAt(i);
    const label = m.mes === 1 ? String(m.ano) : `${MES_ABREV[m.mes]}/${String(m.ano).slice(2)}`;
    const y = COMBO_MARGIN.top + plotH + 14;
    if (m.mes === 1) {
      xLabelsSvg += `<line x1="${x}" y1="${COMBO_MARGIN.top}" x2="${x}" y2="${COMBO_MARGIN.top + plotH}" stroke="var(--border)" stroke-width="1" stroke-dasharray="2,3" />`;
    }
    xLabelsSvg += `<text x="0" y="0" transform="translate(${x} ${y}) rotate(-45)" text-anchor="end" font-size="11" style="fill:var(--text-muted)">${escapeHtml(label)}</text>`;
  }

  function segmentsFor(key, yAtFn) {
    const segs = [];
    let cur = [];
    for (let i = 0; i < n; i++) {
      const row = series[i].rows[0];
      if (!row) {
        if (cur.length) segs.push(cur);
        cur = [];
        continue;
      }
      cur.push(`${xAt(i)},${yAtFn(row[key])}`);
    }
    if (cur.length) segs.push(cur);
    return segs;
  }

  function lineSvg(key, yAtFn, color) {
    let svg = '';
    for (const seg of segmentsFor(key, yAtFn)) {
      svg += `<polyline points="${seg.join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`;
      if (seg.length === 1) {
        const [px, py] = seg[0].split(',');
        svg += `<circle cx="${px}" cy="${py}" r="2.2" fill="${color}" />`;
      }
    }
    return svg;
  }

  const axisSvg = `<line x1="${COMBO_MARGIN.left}" y1="${COMBO_MARGIN.top + plotH}" x2="${LINE_W - COMBO_MARGIN.right}" y2="${COMBO_MARGIN.top + plotH}" stroke="var(--border-strong)" stroke-width="1" />`;
  const crosshairSvg = `<line id="cc-crosshair" x1="0" y1="${COMBO_MARGIN.top}" x2="0" y2="${COMBO_MARGIN.top + plotH}" stroke="var(--text-faint)" stroke-width="1" hidden />`;
  const captureSvg = `<rect id="cc-capture" x="${COMBO_MARGIN.left}" y="${COMBO_MARGIN.top}" width="${plotW}" height="${plotH}" fill="transparent" style="cursor:crosshair" />`;

  const svgWrap = document.createElement('div');
  svgWrap.innerHTML = `<svg viewBox="0 0 ${LINE_W} ${LINE_H}" style="width:100%;height:auto;display:block">${gridSvg}${axisSvg}${xLabelsSvg}${lineSvg('boedPreSal', yBoeAt, projectColor)}${lineSvg('rgo', yRgoAt, RGO_LINE_COLOR)}${crosshairSvg}${captureSvg}</svg>`;
  const svgEl = svgWrap.firstElementChild;
  const capture = svgEl.querySelector('#cc-capture');
  const crosshair = svgEl.querySelector('#cc-crosshair');

  capture.addEventListener('pointermove', (e) => {
    const rect = svgEl.getBoundingClientRect();
    const scale = LINE_W / rect.width;
    const px = (e.clientX - rect.left) * scale;
    const idx = Math.max(0, Math.min(n - 1, Math.round((px - COMBO_MARGIN.left) / plotW * (n - 1))));
    const x = xAt(idx);
    crosshair.setAttribute('x1', x);
    crosshair.setAttribute('x2', x);
    crosshair.hidden = false;
    const m = series[idx];
    const row = m.rows[0];
    const html = `<strong>${escapeHtml(MESES_PT[m.mes])}/${m.ano}</strong>`
      + (row
        ? tooltipRowHTML('Produção', UNITS.boe.fmt(row.boedPreSal)) + tooltipRowHTML('RGO', UNITS.rgo.fmt(row.rgo))
        : `<div class="viz-tooltip-row"><span>Sem dado neste mês</span></div>`);
    const t = ensureTooltip();
    t.innerHTML = html;
    t.hidden = false;
    positionTooltip(rect.left + x / scale, rect.top + (COMBO_MARGIN.top / scale));
  });
  capture.addEventListener('pointerleave', () => { hideTooltip(); crosshair.hidden = true; });

  container.appendChild(svgWrap);

  const legend = document.createElement('div');
  legend.style.cssText = 'display:flex;gap:16px;margin-top:10px;font-size:12px;color:var(--text-muted)';
  legend.innerHTML = `
    <span style="display:inline-flex;align-items:center;gap:6px"><span style="width:16px;height:2px;background:${projectColor};display:inline-block"></span>Produção (boe/d, eixo esquerdo)</span>
    <span style="display:inline-flex;align-items:center;gap:6px"><span style="width:16px;height:2px;background:${RGO_LINE_COLOR};display:inline-block"></span>RGO (m³/m³, eixo direito)</span>
  `;
  container.appendChild(legend);
}

/* -------------------------------- Painel do projeto ------------------------ */

function buildProjectPanel(project, ctx) {
  const panel = document.createElement('div');
  panel.className = 'campo-panel';
  panel.hidden = true;

  const header = document.createElement('div');
  header.className = 'campo-panel-header';
  header.innerHTML = `
    <h2 class="campo-panel-title"><span class="proj-dot" style="background:${project.color}"></span>${escapeHtml(project.name)}</h2>
    <span class="campo-panel-badge">${GROUP_BADGES[project.group] || ''}</span>
  `;
  panel.appendChild(header);

  const mapCard = chartCard('Contorno e poços', 'Poligonal do contrato/campo (quando disponível na ANP) e os poços perfurados dentro dela — cor do ponto por categoria (produção, injeção, seco...), mesmo critério de mapa.html.');
  panel.appendChild(mapCard);

  const feature = ctx.featureByProject[project.name];
  const wells = contractOwnWells(ctx.pocosData, project.name);
  const mapInfo = buildMiniMap(mapCard, project, feature, wells);
  panel._miniMap = mapInfo.map;
  if (!mapInfo.hasShape) {
    const note = document.createElement('p');
    note.className = 'analytics-table-note';
    note.textContent = wells.length
      ? 'Sem poligonal disponível para este contrato nos shapefiles da ANP — mostrando só os poços perfurados.'
      : 'Sem poligonal nem poço registrado para este contrato ainda.';
    mapCard.appendChild(note);
  }

  const base = PROJECT_FIELD_BASE[project.name];
  if (!base) {
    const note = document.createElement('div');
    note.className = 'campo-empty-note';
    note.textContent = 'Sem dados de produção próprios no Boletim da Produção da ANP — campo ainda em exploração, ou produção não individualizada por campo neste contrato.';
    panel.appendChild(note);
    panel.dataset.ready = '1';
    return panel;
  }

  const displayName = projectDisplayName(project.name);
  const series = extractProjectSeries(ctx.monthlySeries, displayName);
  const hasAnyData = series.some((m) => m.rows.length);
  if (!hasAnyData) {
    const note = document.createElement('div');
    note.className = 'campo-empty-note';
    note.textContent = 'Campo listado no boletim, mas sem produção registrada em nenhum mês do período coberto.';
    panel.appendChild(note);
    panel.dataset.ready = '1';
    return panel;
  }

  const prodCard = chartCard('Produção mensal', 'Um ponto por mês do boletim da ANP — só a fração pré-sal deste campo. Role o mouse pra zoom, arraste pra mover a janela, "Ver tudo" reseta.');
  const prodControls = document.createElement('div');
  prodControls.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap';
  const prodReset = document.createElement('button');
  prodReset.type = 'button';
  prodReset.className = 'btn-ghost';
  prodReset.textContent = 'Ver tudo';
  prodControls.appendChild(prodReset);
  prodCard.insertBefore(prodControls, prodCard.querySelector('h3').nextSibling);
  const prodChart = createLineChart(prodCard, series);
  const prodUnitSwitch = buildUnitSwitch((unitKey) => prodChart.setUnit(unitKey), ['oleo', 'gas', 'boe']);
  prodControls.insertBefore(prodUnitSwitch, prodReset);
  prodReset.addEventListener('click', () => prodChart.resetZoom());
  panel.appendChild(prodCard);

  const rgoCard = chartCard('RGO mensal (Razão Gás-Óleo)', 'm³ de gás por m³ de óleo produzido no mês — calculado aqui a partir do óleo e gás do próprio boletim, não vem pronto da ANP.');
  const rgoControls = document.createElement('div');
  rgoControls.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap';
  const rgoReset = document.createElement('button');
  rgoReset.type = 'button';
  rgoReset.className = 'btn-ghost';
  rgoReset.textContent = 'Ver tudo';
  rgoControls.appendChild(rgoReset);
  rgoCard.insertBefore(rgoControls, rgoCard.querySelector('h3').nextSibling);
  const rgoChart = createLineChart(rgoCard, series);
  rgoChart.setUnit('rgo');
  rgoReset.addEventListener('click', () => rgoChart.resetZoom());
  panel.appendChild(rgoCard);

  const comboCard = chartCard('Produção e RGO juntos', 'As duas curvas na mesma área, cada uma no seu eixo (produção à esquerda, RGO à direita) — pra comparar a forma ao longo do tempo. Sem zoom/arraste, mesmo período completo do boletim.');
  buildComboChart(comboCard, series, project.color);
  panel.appendChild(comboCard);

  panel.dataset.ready = '1';
  return panel;
}

/* ---------------------------------- Nav ------------------------------------ */

function buildNavItem(project) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'campo-nav-item';
  btn.dataset.projectId = project.id;
  btn.innerHTML = `<span class="campo-nav-dot" style="background:${project.color}"></span><span class="campo-nav-item-name">${escapeHtml(project.name)}</span>`;
  return btn;
}

function applyNavFilter(query) {
  const q = query.trim().toLowerCase();
  let visible = 0;
  let total = 0;
  for (const item of document.querySelectorAll('.campo-nav-item')) {
    total++;
    const match = !q || item.textContent.toLowerCase().includes(q);
    item.hidden = !match;
    if (match) visible++;
  }
  for (const label of document.querySelectorAll('.campo-nav-group-label')) {
    const group = label.nextElementSibling;
    const anyVisible = group && [...group.children].some((c) => !c.hidden);
    label.hidden = !anyVisible;
  }
  const resultEl = document.getElementById('campoFilterResult');
  if (resultEl) resultEl.textContent = q ? `${visible} de ${total} projetos correspondem a "${query.trim()}"` : '';
}

/* ---------------------------------- Init ------------------------------------ */

async function init() {
  const nav = document.getElementById('campoNav');
  const content = document.getElementById('campoContent');

  let geojson = null;
  let presalGeojson = null;
  let pocosJson = null;
  let producaoData = null;
  try {
    [geojson, presalGeojson, pocosJson, producaoData] = await Promise.all([
      fetch(GEOJSON_URL).then((r) => r.json()),
      fetch(PRESALT_FIELDS_URL).then((r) => r.json()),
      fetch(POCOS_URL).then((r) => r.json()),
      // no-store: mesmo motivo de producao.js — data/producao.json é
      // reprocessado sem deploy de código junto, o navegador não tem como
      // saber que precisa buscar de novo só pela URL.
      fetch(PRODUCAO_URL, { cache: 'no-store' }).then((r) => r.json()),
    ]);
  } catch (err) {
    console.error('Falha ao carregar dados de campo', err);
    content.innerHTML = '<p class="analytics-table-note" style="padding:20px">Falha ao carregar os dados desta página.</p>';
    return;
  }

  const pocosData = pocosJson.pocos || {};

  // featureByProject: poligonal do contrato (contratos.geojson, casada por
  // nome exato de props.projeto) — quando o projeto não tem poligonal
  // própria ali (hoje só Mero, que só existe como CAMPO dentro do bloco de
  // Libra), cai pra campos_presal.geojson (área declarada do campo em si),
  // mesmo fallback que mapa.js usa pra esse caso.
  const featureByProject = {};
  for (const feat of geojson.features) featureByProject[feat.properties.projeto] = feat;
  const trackedByUpperName = new Map(state.projects.map((p) => [p.name.toUpperCase(), p]));
  for (const feat of presalGeojson.features) {
    const trackedProject = trackedByUpperName.get(feat.properties.nome.toUpperCase());
    if (trackedProject && !featureByProject[trackedProject.name]) {
      featureByProject[trackedProject.name] = feat;
    }
  }

  const monthlySeries = computeMonthlySeries(producaoData.meses || [], state.projects);
  const ctx = { featureByProject, pocosData, monthlySeries };

  // Ordem: mesmo agrupamento por status de pocos.js/analises.js (Produção,
  // Exploração, Devolvidos), cada grupo alfabético.
  const byGroup = {};
  for (const g of GROUP_ORDER) byGroup[g] = [];
  for (const p of state.projects) {
    if (byGroup[p.group]) byGroup[p.group].push(p);
  }
  for (const g of GROUP_ORDER) byGroup[g].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  const searchRow = document.createElement('input');
  searchRow.type = 'text';
  searchRow.className = 'campo-search';
  searchRow.id = 'campoSearch';
  searchRow.placeholder = 'Filtrar projeto...';
  nav.appendChild(searchRow);
  const filterResult = document.createElement('span');
  filterResult.className = 'campo-nav-filter-result';
  filterResult.id = 'campoFilterResult';
  nav.appendChild(filterResult);

  const panelByProjectId = {};
  const navItemByProjectId = {};
  let activeProjectId = null;

  function activate(projectId) {
    if (activeProjectId === projectId) return;
    if (activeProjectId && panelByProjectId[activeProjectId]) panelByProjectId[activeProjectId].hidden = true;
    if (activeProjectId && navItemByProjectId[activeProjectId]) navItemByProjectId[activeProjectId].classList.remove('active');
    activeProjectId = projectId;
    navItemByProjectId[projectId].classList.add('active');
    let panel = panelByProjectId[projectId];
    if (!panel) {
      const project = state.projects.find((p) => p.id === projectId);
      panel = buildProjectPanel(project, ctx);
      panelByProjectId[projectId] = panel;
      content.appendChild(panel);
    }
    panel.hidden = false;
    if (panel._miniMap) panel._miniMap.invalidateSize();
  }

  let firstProjectId = null;
  for (const g of GROUP_ORDER) {
    if (!byGroup[g].length) continue;
    const label = document.createElement('div');
    label.className = 'campo-nav-group-label';
    label.textContent = GROUP_BADGES[g];
    nav.appendChild(label);
    const list = document.createElement('div');
    list.className = 'campo-nav-list';
    for (const p of byGroup[g]) {
      const item = buildNavItem(p);
      item.addEventListener('click', () => activate(p.id));
      navItemByProjectId[p.id] = item;
      list.appendChild(item);
      if (!firstProjectId) firstProjectId = p.id;
    }
    nav.appendChild(list);
  }

  searchRow.addEventListener('input', (e) => applyNavFilter(e.target.value));

  if (firstProjectId) activate(firstProjectId);
}

init();
