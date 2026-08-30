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
const PD_URL = 'data/planos_desenvolvimento.json';

const GROUP_BADGES = {
  producao: 'Produção',
  exploracao: 'Exploração',
  devolvidos: 'Devolvido',
};
const GROUP_ORDER = ['producao', 'exploracao', 'devolvidos'];

const RGO_LINE_COLOR = '#e0a72e';

// WELL_SHAPES/wellDivIcon/RIG_STATUS_STYLE/rigDivIcon/buildWellShapeLegend/
// buildRigLegend agora vêm de shared.js — mesmos ícones e legenda do mapa
// completo (mapa.js), reaproveitados aqui num mini-mapa por projeto só.
// Diferente do mapa completo (que colore o poço pela cor do PROJETO, já
// que várias cores de projeto convivem na mesma tela e a FORMA do ícone
// já diz a categoria): aqui também usamos a cor do projeto — um mini-mapa
// só tem um projeto mesmo, então a cor da poligonal e a do poço batem, e a
// legenda (mesma do mapa completo) continua ensinando o que cada FORMA
// quer dizer, independente da cor de quem está olhando.

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

// Marcos tipo 'fpso' (entrada de cada FPSO do campo, ver seedState em
// shared.js) de todas as workstreams do projeto — mesmo critério que o
// roadmap principal usa pra desenhar o ícone de FPSO (ver
// MILESTONE_ICON_BUILDERS), aqui só extraído pra virar marcador no
// gráfico de produção mensal (ver markers em createLineChart).
function fpsoMilestonesOf(project) {
  const items = [];
  for (const ws of project.workstreams) {
    for (const it of ws.items) {
      if (it.type === 'milestone' && it.icon === 'fpso') items.push({ date: it.date, name: it.name });
    }
  }
  return items;
}

/* ------------------------------- Mini-mapa --------------------------------- */
// Escala e legenda desenhadas do zero (não o L.control.scale padrão do
// Leaflet nem os .map-legend-row de mapa.js) — os dois herdados de um
// tema claro de fábrica e presos ao layout do resto do mapa completo;
// aqui têm cartão próprio (mesmo fundo "vidro fosco" de
// .map-well-legend-fixed em mapa.js) coerente com o resto do app.

// Distância "redonda" (1/2/3/5 × potência de 10) mais próxima do
// máximo que cabe em SCALE_MAX_WIDTH px na latitude atual — mesma tabela
// que o próprio L.Control.Scale usa por baixo dos panos, mas aqui
// controlamos o desenho da barra e o texto por inteiro.
const SCALE_MAX_WIDTH = 90;
function niceScaleDistance(maxMeters) {
  const pow10 = Math.pow(10, Math.floor(Math.log10(maxMeters)));
  const frac = maxMeters / pow10;
  const step = frac >= 5 ? 5 : frac >= 3 ? 3 : frac >= 2 ? 2 : 1;
  return step * pow10;
}
function formatScaleDistance(meters) {
  return meters >= 1000 ? fmtNum(meters / 1000, { maximumFractionDigits: 1 }) + ' km' : fmtNum(meters) + ' m';
}

const CampoScaleControl = L.Control.extend({
  options: { position: 'bottomleft' },
  onAdd(map) {
    this._map = map;
    const el = L.DomUtil.create('div', 'leaflet-control campo-map-scale');
    el.innerHTML = '<div class="campo-map-scale-label"></div><div class="campo-map-scale-bar"></div>';
    this._label = el.querySelector('.campo-map-scale-label');
    this._bar = el.querySelector('.campo-map-scale-bar');
    L.DomEvent.disableClickPropagation(el);
    map.on('move zoom', this._update, this);
    this._update();
    return el;
  },
  onRemove(map) { map.off('move zoom', this._update, this); },
  _update() {
    const map = this._map;
    const y = map.getSize().y / 2;
    const maxMeters = map.distance(map.containerPointToLatLng([0, y]), map.containerPointToLatLng([SCALE_MAX_WIDTH, y]));
    if (!isFinite(maxMeters) || maxMeters <= 0) return;
    const dist = niceScaleDistance(maxMeters);
    this._bar.style.width = Math.round(SCALE_MAX_WIDTH * dist / maxMeters) + 'px';
    this._label.textContent = formatScaleDistance(dist);
  },
});

// Wrapper genérico pro cartão de legenda — recebe o conteúdo já pronto de
// buildWellShapeLegend()/buildRigLegend() (shared.js, mesmas funções do
// mapa completo), só cuidando do posicionamento/cartão em volta.
const CampoLegendControl = L.Control.extend({
  options: { position: 'topright' },
  initialize(contentEl, options) {
    L.Util.setOptions(this, options);
    this._content = contentEl;
  },
  onAdd() {
    const el = L.DomUtil.create('div', 'leaflet-control campo-map-legend');
    el.appendChild(this._content);
    L.DomEvent.disableClickPropagation(el);
    return el;
  },
});

function buildMiniMap(container, project, jazidaFeatures, wells, biggestBounds) {
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
  // Escala numérica + gráfica, desenho próprio (ver CampoScaleControl
  // acima) — só métrico, a base da ANP não usa milhas.
  new CampoScaleControl().addTo(map);
  // Legenda dos ícones — mesma de mapa.js (buildWellShapeLegend/
  // buildRigLegend, shared.js): só aparece quando há o que legendar (sem
  // poço nenhum, sem legenda de poço; sem sonda ativa, sem legenda de
  // sonda), mesmo critério condicional que o mapa completo já usa.
  const hasWells = wells.some((w) => w.c);
  const hasRigs = wells.some((w) => w.c && RIG_STATUS_STYLE[w.sit]);
  if (hasWells) new CampoLegendControl(buildWellShapeLegend()).addTo(map);
  if (hasRigs) new CampoLegendControl(buildRigLegend()).addTo(map);

  const bounds = L.latLngBounds([]);
  // Poligonal PRÓPRIA (own) em traço cheio; as da MESMA jazida mas de
  // outro contrato/campo (extra — ver jazidaFeaturesByProject em init())
  // em traço tracejado, mesmo padrão visual que mapa.js já usa pra campo
  // de contexto ligado a um projeto rastreado (ver linkedPresaltLayers) —
  // sinaliza "mesmo reservatório, contrato diferente" sem inventar uma
  // legenda nova.
  if (jazidaFeatures.own) {
    const layer = L.geoJSON(jazidaFeatures.own, {
      style: { color: project.color, weight: 2, fillColor: project.color, fillOpacity: 0.32 },
    }).addTo(map);
    bounds.extend(layer.getBounds());
  }
  for (const feat of jazidaFeatures.extra) {
    const layer = L.geoJSON(feat, {
      style: { color: project.color, weight: 1.5, fillColor: project.color, fillOpacity: 0.22, dashArray: '4 3' },
    }).addTo(map);
    bounds.extend(layer.getBounds());
  }
  // Poço com sonda ativa (EM PERFURAÇÃO/EM COMPLETAÇÃO) ganha o ícone de
  // sonda em vez do ícone de categoria normal — mesma exclusão mútua do
  // mapa completo (lá os dois nunca aparecem juntos porque só um é visível
  // de cada vez, conforme o zoom; aqui, sem esse zoom, a exclusão é
  // explícita: wellCategory(w) pra esses poços cairia em "indefinido" (sem
  // reclassificação ainda, ainda perfurando) — mostrar os dois ícones no
  // mesmo ponto seria redundante e confuso).
  for (const w of wells) {
    if (!w.c) continue;
    const rigStyle = RIG_STATUS_STYLE[w.sit];
    if (rigStyle) {
      L.marker(w.c, { icon: rigDivIcon(rigStyle.color) })
        .bindTooltip(`${escapeHtml(w.n)}<br>${escapeHtml(rigStyle.label)}`, { direction: 'top', offset: [0, -11] })
        .addTo(map);
    } else {
      L.marker(w.c, { icon: wellDivIcon(project.color, wellCategory(w), !!w.anc, wellInjectionType(w)) })
        .bindTooltip(w.n, { direction: 'top', offset: [0, -8] })
        .addTo(map);
    }
    bounds.extend(w.c);
  }

  // buildMiniMap roda ANTES do painel entrar no DOM (activate() só faz
  // content.appendChild(panel) depois que esta função retorna) — mapDiv
  // está sem layout nenhum aqui (tamanho 0), e fitBounds/getBoundsZoom
  // calculado contra um container de tamanho 0 dá um zoom absurdo
  // (Leaflet cai pro maxZoom das camadas, 18, tentando "encher" uma
  // janela de tamanho zero) — o mapa nasce todo destorcido, cru: poços
  // somem da vista. invalidateSize() sozinho não resolve: ele só reata o
  // mapa ao tamanho real do container, sem refazer o cálculo de zoom. Por
  // isso os dois vão pro próximo frame, depois que o painel já está
  // anexado e visível (ver activate() em campo.js) e mapDiv já tem o
  // tamanho definitivo do layout flex.
  requestAnimationFrame(() => {
    map.invalidateSize();
    if (bounds.isValid()) {
      // Mesma escala (zoom) pra TODOS os projetos — calculada pelo maior
      // (biggestBounds, ver init()), não pelo contorno deste projeto —
      // cada mapa só centraliza no seu próprio campo. Sem isso, cada
      // mini-mapa dava fitBounds no próprio contorno e todo campo parecia
      // do mesmo tamanho na tela, por menor que fosse de verdade; com o
      // mesmo zoom em todos, o campo maior ocupa o mini-mapa quase
      // inteiro e um campo pequeno aparece pequeno, do jeito que é.
      const fitTarget = biggestBounds.isValid() ? biggestBounds : bounds;
      const zoom = map.getBoundsZoom(fitTarget, false, L.point(24, 24));
      map.setView(bounds.getCenter(), zoom);
    }
  });

  return { map, hasShape: !!(jazidaFeatures.own || jazidaFeatures.extra.length), hasWells };
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
  svgWrap.className = 'line-chart-wrap';
  svgWrap.innerHTML = `<svg class="lc-svg" viewBox="0 0 ${LINE_W} ${LINE_H}">${gridSvg}${axisSvg}${xLabelsSvg}${lineSvg('boedPreSal', yBoeAt, projectColor)}${lineSvg('rgo', yRgoAt, RGO_LINE_COLOR)}${crosshairSvg}${captureSvg}</svg>`;
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

/* -------------------------------- Mini-roadmap ------------------------------ */
// Recorte do Roadmap principal (index.html/app.js) pra um projeto só —
// mesmos dados (project.workstreams), mesma linguagem visual (reaproveita
// as classes .row/.label-cell/.timeline-cell/.task-bar/.milestone/
// .progress-fill/.today-line do CSS do roadmap principal, ver style.css),
// mas SEM a parte interativa de edição/zoom/scroll do board completo — só
// leitura, com tooltip nativo (title) em vez do popover rico com clique.
// Posiciona tudo em porcentagem (não pixel fixo como app.js, que depende
// de currentPxPerDay/scroll) pra a barra de tempo acompanhar a largura do
// cartão sem precisar recalcular em resize.
const ROADMAP_HEADER_H = 24;
const ROADMAP_ROW_MIN_H = 34;
const ROADMAP_LANE_H = 32;
const ROADMAP_LANE_PAD = 14;
const ROADMAP_BAR_H = 18;

function roadmapRange(project) {
  const allItems = project.workstreams.flatMap((w) => w.items);
  const today = parseDate(todayISO());
  let min = today;
  let max = today;
  for (const it of allItems) {
    const s = parseDate(it.type === 'milestone' ? it.date : it.start);
    const e = parseDate(it.type === 'milestone' ? it.date : it.end);
    if (s < min) min = s;
    if (e > max) max = e;
  }
  const rangeStart = addDays(min, -20);
  let rangeEnd = addDays(max, 20);
  const minSpanDays = 180;
  if (diffDays(rangeStart, rangeEnd) < minSpanDays) rangeEnd = addDays(rangeStart, minSpanDays);
  return { rangeStart, rangeEnd };
}

// Um tique por janeiro de cada ano coberto (rótulo = ano) + o próprio
// início do intervalo quando não cai perto de um janeiro (senão a ponta
// esquerda do gráfico ficaria sem nenhuma referência de data).
function roadmapAxisTicks(rangeStart, rangeEnd) {
  const ticks = [];
  let d = new Date(Date.UTC(rangeStart.getUTCFullYear(), 0, 1));
  if (d < rangeStart) d = new Date(Date.UTC(rangeStart.getUTCFullYear() + 1, 0, 1));
  while (d <= rangeEnd) {
    ticks.push({ date: d, label: String(d.getUTCFullYear()) });
    d = new Date(Date.UTC(d.getUTCFullYear() + 1, 0, 1));
  }
  if (!ticks.length || diffDays(rangeStart, ticks[0].date) > 60) {
    ticks.unshift({ date: rangeStart, label: `${MES_ABREV[rangeStart.getUTCMonth() + 1]}/${String(rangeStart.getUTCFullYear()).slice(2)}` });
  }
  return ticks;
}

function roadmapPctLeft(rangeStart, totalDays, date) {
  return Math.max(0, Math.min(100, (diffDays(rangeStart, date) / totalDays) * 100));
}

function buildRoadmapTaskBar(project, item, lane, rangeStart, totalDays) {
  const start = parseDate(item.start);
  const end = parseDate(item.end);
  const leftPct = roadmapPctLeft(rangeStart, totalDays, start);
  const widthPct = Math.max(0.6, ((diffDays(start, end) + 1) / totalDays) * 100);
  const top = ROADMAP_LANE_PAD / 2 + lane * ROADMAP_LANE_H;

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'position:absolute;left:0;top:0;right:0';

  const bar = document.createElement('div');
  bar.className = 'task-bar';
  bar.style.left = leftPct + '%';
  bar.style.width = widthPct + '%';
  bar.style.top = top + 'px';
  bar.style.height = ROADMAP_BAR_H + 'px';
  bar.style.background = project.color;

  const actualProgress = Math.min(100, Math.max(0, item.progress || 0));
  const expectedProgress = computeExpectedProgress(item);
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  fill.style.width = actualProgress + '%';
  bar.appendChild(fill);

  const labelSpan = document.createElement('span');
  labelSpan.className = 'bar-label';
  labelSpan.textContent = item.name;
  bar.appendChild(labelSpan);

  bar.title = `${item.name}\n${formatBR(item.start)} → ${formatBR(item.end)}\n`
    + `Progresso real: ${actualProgress}%\nProgresso esperado (hoje): ${expectedProgress}%`;
  wrapper.appendChild(bar);

  const statusClass = progressStatusClass(actualProgress, expectedProgress);
  const numbers = document.createElement('div');
  numbers.className = 'progress-numbers';
  numbers.style.left = leftPct + '%';
  numbers.style.width = widthPct + '%';
  numbers.style.top = (top + ROADMAP_BAR_H + 2) + 'px';
  numbers.innerHTML = `<span class="actual ${statusClass}">${actualProgress}%</span><span class="sep">/</span><span class="expected">${expectedProgress}%</span>`;
  wrapper.appendChild(numbers);

  return wrapper;
}

function buildRoadmapMilestone(project, item, lane, rangeStart, totalDays) {
  const date = parseDate(item.date);
  const isPast = date < parseDate(todayISO());
  const leftPct = roadmapPctLeft(rangeStart, totalDays, date);
  const top = ROADMAP_LANE_PAD / 2 + lane * ROADMAP_LANE_H + ROADMAP_BAR_H / 2;

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'position:absolute;left:0;top:0;right:0';

  const iconBuilder = MILESTONE_ICON_BUILDERS[item.icon];
  const dia = document.createElement('div');
  dia.className = 'milestone' + (iconBuilder ? ` milestone-icon milestone-${item.icon}` : '');
  dia.style.left = leftPct + '%';
  dia.style.top = top + 'px';
  if (iconBuilder) {
    dia.innerHTML = iconBuilder(project.color);
  } else {
    dia.style.background = project.color;
  }
  if (isPast) {
    if (item.done) dia.style.opacity = '0.5';
    else dia.style.border = `2px solid ${MILESTONE_OVERDUE_LABEL_COLOR}`;
  }

  const typeLabel = MILESTONE_TYPE_LABELS[item.icon] || 'Marco';
  const statusText = isPast ? (item.done ? 'Realizado' : 'Atrasado (não realizado)') : 'Previsto';
  dia.title = `${item.name}\n${typeLabel} · ${formatBR(item.date)}\n${statusText}`
    + (item.approx ? '\n(data aproximada — só o mês era conhecido)' : '');

  wrapper.appendChild(dia);
  return wrapper;
}

function buildRoadmapRow(labelText, items, rangeStart, totalDays, project) {
  const { placements, laneCount } = packLanes(items);
  const rowHeight = Math.max(ROADMAP_ROW_MIN_H, laneCount * ROADMAP_LANE_H + ROADMAP_LANE_PAD);

  const row = document.createElement('div');
  row.className = 'row workstream-row';
  row.style.height = rowHeight + 'px';

  const labelCell = document.createElement('div');
  labelCell.className = 'label-cell';
  const label = document.createElement('span');
  label.className = 'label-text';
  label.textContent = labelText;
  label.title = labelText;
  labelCell.appendChild(label);
  row.appendChild(labelCell);

  const timelineCell = document.createElement('div');
  timelineCell.className = 'timeline-cell';
  for (const { item, lane } of placements) {
    timelineCell.appendChild(
      item.type === 'task'
        ? buildRoadmapTaskBar(project, item, lane, rangeStart, totalDays)
        : buildRoadmapMilestone(project, item, lane, rangeStart, totalDays),
    );
  }
  row.appendChild(timelineCell);
  return row;
}

function buildRoadmapSection(project) {
  const wrap = document.createElement('div');
  wrap.className = 'campo-roadmap';
  wrap.style.setProperty('--sidebar-w', '150px');
  wrap.style.setProperty('--header-h', ROADMAP_HEADER_H + 'px');

  const allItems = project.workstreams.flatMap((w) => w.items);
  if (!allItems.length) {
    const note = document.createElement('div');
    note.className = 'campo-empty-note';
    note.textContent = 'Sem marcos ou tarefas cadastradas para este projeto ainda.';
    wrap.appendChild(note);
    return wrap;
  }

  const { rangeStart, rangeEnd } = roadmapRange(project);
  const totalDays = diffDays(rangeStart, rangeEnd);

  const headerRow = document.createElement('div');
  headerRow.className = 'row';
  headerRow.style.height = ROADMAP_HEADER_H + 'px';
  const cornerCell = document.createElement('div');
  cornerCell.className = 'label-cell';
  headerRow.appendChild(cornerCell);
  const headerTimeline = document.createElement('div');
  headerTimeline.className = 'timeline-cell';
  for (const tick of roadmapAxisTicks(rangeStart, rangeEnd)) {
    const t = document.createElement('div');
    t.className = 'header-tier-label fine';
    t.style.left = roadmapPctLeft(rangeStart, totalDays, tick.date) + '%';
    t.style.top = '0';
    t.style.height = ROADMAP_HEADER_H + 'px';
    t.textContent = tick.label;
    headerTimeline.appendChild(t);
  }
  headerRow.appendChild(headerTimeline);
  wrap.appendChild(headerRow);

  for (const ws of project.workstreams) {
    if (!ws.items.length) continue;
    wrap.appendChild(buildRoadmapRow(ws.name, ws.items, rangeStart, totalDays, project));
  }

  const today = parseDate(todayISO());
  if (today >= rangeStart && today <= rangeEnd) {
    const leftPct = roadmapPctLeft(rangeStart, totalDays, today) + '%';
    const line = document.createElement('div');
    line.className = 'today-line';
    line.style.left = leftPct;
    wrap.appendChild(line);
    const flag = document.createElement('div');
    flag.className = 'today-flag';
    flag.style.left = leftPct;
    flag.textContent = 'Hoje';
    wrap.appendChild(flag);
  }

  return wrap;
}

/* -------------------------------- Painel do projeto ------------------------ */

function buildProjectPanel(project, ctx) {
  const panel = document.createElement('div');
  panel.className = 'campo-panel';
  panel.hidden = true;

  const inner = document.createElement('div');
  inner.className = 'campo-panel-inner';
  panel.appendChild(inner);

  const header = document.createElement('div');
  header.className = 'campo-panel-header';
  header.innerHTML = `
    <h2 class="campo-panel-title"><span class="proj-dot" style="background:${project.color}"></span>${escapeHtml(project.name)}</h2>
    <span class="campo-panel-badge">${GROUP_BADGES[project.group] || ''}</span>
  `;
  inner.appendChild(header);

  const roadmapCard = chartCard('Roadmap do projeto', 'Marcos e tarefas de cada workstream — mesmos dados do Roadmap principal (index.html), num recorte só deste projeto. Passe o mouse sobre uma barra ou marco para ver os detalhes.');
  roadmapCard.appendChild(buildRoadmapSection(project));
  inner.appendChild(roadmapCard);

  const mapCard = chartCard('Contorno e poços', 'Poligonal do contrato/campo (quando disponível na ANP) e os poços perfurados dentro dela — cor do ponto por categoria (produção, injeção, seco...), mesmo critério de mapa.html. Escala igual em todos os projetos, calculada pelo maior campo — dá pra comparar tamanho de campo a olho entre um painel e outro.');
  inner.appendChild(mapCard);

  const jazidaFeatures = ctx.jazidaFeaturesByProject[project.name];
  const wells = contractOwnWells(ctx.pocosData, project.name);
  const mapInfo = buildMiniMap(mapCard, project, jazidaFeatures, wells, ctx.biggestBounds);
  panel._miniMap = mapInfo.map;
  if (!mapInfo.hasShape) {
    const note = document.createElement('p');
    note.className = 'analytics-table-note';
    note.textContent = wells.length
      ? 'Sem poligonal disponível para este contrato nos shapefiles da ANP — mostrando só os poços perfurados.'
      : 'Sem poligonal nem poço registrado para este contrato ainda.';
    mapCard.appendChild(note);
  } else if (jazidaFeatures.extra.length) {
    const names = jazidaFeatures.extra.map((f) => f.properties.projeto || f.properties.nome).join(', ');
    const note = document.createElement('p');
    note.className = 'analytics-table-note';
    note.textContent = `Jazida compartilhada (mesmo Plano de Desenvolvimento) — poligonal tracejada combinada com: ${names}.`;
    mapCard.appendChild(note);
  }

  const base = PROJECT_FIELD_BASE[project.name];
  if (!base) {
    const note = document.createElement('div');
    note.className = 'campo-empty-note';
    note.textContent = 'Sem dados de produção próprios no Boletim da Produção da ANP — campo ainda em exploração, ou produção não individualizada por campo neste contrato.';
    inner.appendChild(note);
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
    inner.appendChild(note);
    panel.dataset.ready = '1';
    return panel;
  }

  const fpsoMarkers = fpsoMilestonesOf(project);
  const prodCard = chartCard('Produção mensal', 'Um ponto por mês do boletim da ANP — só a fração pré-sal deste campo. Ícone de FPSO acima do gráfico marca quando cada unidade entrou; ícone pequeno abaixo do eixo marca a conclusão de cada poço perfurado (cor neutra, forma = categoria — mesma legenda do mapa acima). Role o mouse pra zoom, arraste pra mover a janela, "Ver tudo" reseta.');
  const prodControls = document.createElement('div');
  prodControls.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap';
  const prodReset = document.createElement('button');
  prodReset.type = 'button';
  prodReset.className = 'btn-ghost';
  prodReset.textContent = 'Ver tudo';
  prodControls.appendChild(prodReset);
  prodCard.insertBefore(prodControls, prodCard.querySelector('h3').nextSibling);
  const prodChart = createLineChart(prodCard, series, { fpsos: fpsoMarkers, wells });
  const prodUnitSwitch = buildUnitSwitch((unitKey) => prodChart.setUnit(unitKey), ['oleo', 'gas', 'boe']);
  prodControls.insertBefore(prodUnitSwitch, prodReset);
  prodReset.addEventListener('click', () => prodChart.resetZoom());
  inner.appendChild(prodCard);

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
  inner.appendChild(rgoCard);

  const comboCard = chartCard('Produção e RGO juntos', 'As duas curvas na mesma área, cada uma no seu eixo (produção à esquerda, RGO à direita) — pra comparar a forma ao longo do tempo. Sem zoom/arraste, mesmo período completo do boletim.');
  buildComboChart(comboCard, series, project.color);
  inner.appendChild(comboCard);

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
  let pdData = null;
  try {
    [geojson, presalGeojson, pocosJson, producaoData, pdData] = await Promise.all([
      fetch(GEOJSON_URL).then((r) => r.json()),
      fetch(PRESALT_FIELDS_URL).then((r) => r.json()),
      fetch(POCOS_URL).then((r) => r.json()),
      // no-store: mesmo motivo de producao.js — data/producao.json é
      // reprocessado sem deploy de código junto, o navegador não tem como
      // saber que precisa buscar de novo só pela URL.
      fetch(PRODUCAO_URL, { cache: 'no-store' }).then((r) => r.json()),
      fetch(PD_URL).then((r) => r.json()),
    ]);
  } catch (err) {
    console.error('Falha ao carregar dados de campo', err);
    content.innerHTML = '<p class="analytics-table-note" style="padding:20px">Falha ao carregar os dados desta página.</p>';
    return;
  }

  const pocosData = pocosJson.pocos || {};

  // featureByProject: poligonal PRÓPRIA do contrato (contratos.geojson,
  // casada por nome exato de props.projeto) — quando o projeto não tem
  // poligonal própria ali (hoje só Mero, que só existe como CAMPO dentro
  // do bloco de Libra), cai pra campos_presal.geojson (área declarada do
  // campo em si), mesmo fallback que mapa.js usa pra esse caso.
  const featureByProject = {};
  for (const feat of geojson.features) featureByProject[feat.properties.projeto] = feat;
  const trackedByUpperName = new Map(state.projects.map((p) => [p.name.toUpperCase(), p]));
  for (const feat of presalGeojson.features) {
    const trackedProject = trackedByUpperName.get(feat.properties.nome.toUpperCase());
    if (trackedProject && !featureByProject[trackedProject.name]) {
      featureByProject[trackedProject.name] = feat;
    }
  }

  // jazidaFeaturesByProject: além da poligonal PRÓPRIA (own, acima), os
  // OUTROS contratos/campos que compartilham a MESMA jazida — mesmo PD
  // (data/planos_desenvolvimento.json, campo "fonte") citado por mais de
  // um nome (ex.: Norte de Carcará + BACALHAU, um só reservatório
  // dividido entre o bloco de Partilha rastreado aqui e a Concessão
  // anterior fora dele; Atapu + OESTE DE ATAPU; Entorno de Sapinhoá +
  // SAPINHOÁ) — mesmo critério de vínculo já usado em mapa.js
  // (projectByPdFonte/groupByPdFonte, shared.js), aplicado aqui pra
  // desenhar TODOS os pedaços da jazida juntos, não só o contrato
  // rastreado. projectByPdFonte já ignora fonte citada por mais de um
  // projeto RASTREADO (ambíguo demais pra decidir sozinho).
  const fonteToProject = projectByPdFonte(state.projects, pdData);
  const jazidaFeaturesByProject = {};
  for (const project of state.projects) {
    const own = featureByProject[project.name] || null;
    const extra = [];
    const pd = byNameOrUpper(pdData, project.name);
    const fonte = pd && pd.fonte;
    if (fonte && fonteToProject.get(fonte) === project) {
      for (const feat of geojson.features) {
        if (feat === own) continue;
        const otherPd = byNameOrUpper(pdData, feat.properties.projeto);
        if (otherPd && otherPd.fonte === fonte) extra.push(feat);
      }
      for (const feat of presalGeojson.features) {
        if (feat === own) continue;
        const otherPd = byNameOrUpper(pdData, feat.properties.nome);
        if (otherPd && otherPd.fonte === fonte) extra.push(feat);
      }
    }
    jazidaFeaturesByProject[project.name] = { own, extra };
  }

  // Limites de mapa de cada projeto (poligonal própria + jazida
  // compartilhada + poços) — pra achar o maior campo entre os 30, ver
  // biggestBounds abaixo. L.geoJSON(...).getBounds() funciona sem
  // precisar de um mapa Leaflet de verdade (só computa a bounding box da
  // geometria) — bem mais barato que montar 30 mapas escondidos só pra
  // medir tamanho.
  const jazidaBoundsByProject = {};
  for (const project of state.projects) {
    const { own, extra } = jazidaFeaturesByProject[project.name];
    const b = L.latLngBounds([]);
    if (own) b.extend(L.geoJSON(own).getBounds());
    for (const feat of extra) b.extend(L.geoJSON(feat).getBounds());
    for (const w of contractOwnWells(pocosData, project.name)) {
      if (w.c) b.extend(w.c);
    }
    jazidaBoundsByProject[project.name] = b;
  }
  // Maior campo entre os 30 (diagonal NE-SW em metros, ver
  // L.LatLng.distanceTo) — referência de escala pro mini-mapa de TODOS os
  // projetos (ver buildMiniMap): mesmo zoom pra todos, cada um só
  // centralizado no próprio campo — dá pra comparar tamanho de campo a
  // olho entre um painel e outro. Sem isso, cada mini-mapa dava fitBounds
  // no próprio contorno e todo campo parecia do mesmo tamanho na tela,
  // por menor que fosse de verdade.
  let biggestBounds = L.latLngBounds([]);
  let biggestSpan = -1;
  for (const project of state.projects) {
    const b = jazidaBoundsByProject[project.name];
    if (!b.isValid()) continue;
    const span = b.getNorthEast().distanceTo(b.getSouthWest());
    if (span > biggestSpan) { biggestSpan = span; biggestBounds = b; }
  }

  const monthlySeries = computeMonthlySeries(producaoData.meses || [], state.projects);
  const ctx = { jazidaFeaturesByProject, biggestBounds, pocosData, monthlySeries };

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
