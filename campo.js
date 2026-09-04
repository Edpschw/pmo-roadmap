'use strict';

/* =========================================================================
   PMO Roadmap — Campo. Um painel por jazida rastreada (os mesmos 30
   contratos de state.projects, mas exibidos pelo nome popular da jazida
   quando ela difere do nome do contrato — Bacalhau, Sapinhoá, ver
   projectDisplayName em shared.js — e com a poligonal de QUALQUER outro
   contrato/campo que compartilhe a mesma jazida desenhada junto no mapa,
   ver jazidaFeaturesByProject): contorno + poços num mini-mapa GRANDE,
   central, com o roadmap acima (largura cheia) e os gráficos de
   produção/RGO mensal ao lado (ver .campo-dashboard-grid no CSS). Troca
   de jazida por um seletor compacto (botão + painel flutuante, ver
   buildProjectSelector) em vez de uma coluna de nav inteira sempre
   visível — deixa a tela toda pro dashboard. Cada painel é montado uma
   vez, na primeira vez que a jazida é aberta (mapa Leaflet + gráfico
   custam caro pra montar 30 vezes de cara), e fica em cache pra reabrir
   instantâneo depois.
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
const PRODUCAO_POCOS_URL = 'data/producao_pocos.json';
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

function buildMiniMap(container, project, jazidaFeatures, wells) {
  const mapDiv = document.createElement('div');
  mapDiv.className = 'campo-mapa';
  container.appendChild(mapDiv);

  // Zoom interativo desligado (scroll do mouse, botões +/-, duplo clique,
  // pinça no touch, teclado) — só arrastar (pan) continua livre. O
  // enquadramento automático no contorno+poços do campo (ver
  // requestAnimationFrame abaixo) já decide o zoom certo pra cada painel;
  // deixar o usuário mexer nele aqui só atrapalhava o scroll da página
  // quando o mouse passava por cima do mini-mapa.
  const map = L.map(mapDiv, {
    zoomControl: false, attributionControl: false, minZoom: 2,
    scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false,
    boxZoom: false, keyboard: false,
  }).setView([-25.3, -43], 5);
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
  // mesmo ponto seria redundante e confuso). Também entra no filtro de ano
  // (wellMarkersByYear) como qualquer outro poço, usando w.d — pra sonda
  // ativa isso é a data do último boletim (não uma "conclusão" ainda), mas
  // é a única data disponível e aproxima bem "desde quando essa
  // perfuração aparece no boletim da ANP". category null: não é produtor
  // nem injetor ainda, não entra na contagem de setYearFilter.
  const wellsLayer = L.layerGroup().addTo(map);
  const wellMarkersByYear = [];
  for (const w of wells) {
    if (!w.c) continue;
    const rigStyle = RIG_STATUS_STYLE[w.sit];
    if (rigStyle) {
      const marker = L.marker(w.c, { icon: rigDivIcon(rigStyle.color) })
        .bindTooltip(`${escapeHtml(w.n)}<br>${escapeHtml(rigStyle.label)}`, { direction: 'top', offset: [0, -11] });
      wellMarkersByYear.push({ marker, year: w.d ? Number(w.d.slice(0, 4)) : null, category: null });
    } else {
      const category = wellCategory(w);
      const marker = L.marker(w.c, { icon: wellDivIcon(project.color, category, !!w.anc, wellInjectionType(w)) })
        .bindTooltip(w.n, { direction: 'top', offset: [0, -8] });
      wellMarkersByYear.push({ marker, year: w.d ? Number(w.d.slice(0, 4)) : null, category });
    }
    bounds.extend(w.c);
  }
  const wellYears = wellMarkersByYear.filter((x) => x.year != null).map((x) => x.year);
  const minWellYear = wellYears.length ? Math.min(...wellYears) : null;
  const maxWellYear = wellYears.length ? Math.max(...wellYears) : null;
  // Até que ano mostrar (inclusive) — null = todos. Poço sem data
  // registrada (raro) sempre aparece, não dá pra posicioná-lo na linha do
  // tempo então não faz sentido escondê-lo condicionalmente. Retorna
  // quantos produtores/injetores/abandonados ficaram visíveis (categoria de
  // wellCategory, shared.js) pra alimentar os contadores do filtro de ano
  // (ver buildYearFilterBar) — sonda ativa entra no filtro (category null),
  // mas nunca soma nos contadores: ainda não virou produtor, injetor nem
  // abandonado.
  function setYearFilter(year) {
    wellsLayer.clearLayers();
    let producers = 0;
    let injectors = 0;
    let abandoned = 0;
    for (const { marker, year: y, category } of wellMarkersByYear) {
      if (year == null || y == null || y <= year) {
        wellsLayer.addLayer(marker);
        if (category === 'producao') producers++;
        else if (category === 'injecao') injectors++;
        else if (category === 'abandonado') abandoned++;
      }
    }
    return { producers, injectors, abandoned };
  }
  // Estado inicial (sem filtro aplicado) também popula a camada — reusa
  // setYearFilter(null) em vez de duplicar o loop de addLayer.
  const initialCounts = setYearFilter(null);

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
      // Zoom calculado pelo contorno + poços DESTE projeto (não mais por um
      // "maior campo entre os 30" compartilhado) — cada mini-mapa preenche
      // o máximo possível do próprio espaço, em vez de ficar pequeno no
      // meio de uma tela vazia quando o campo é pequeno perto do maior do
      // conjunto. Sacrifica a comparação de tamanho a olho entre painéis
      // (cada um no seu próprio zoom agora) em troca de preencher a tela.
      // Padding pequeno (8px) — só o suficiente pra não cortar ícone de
      // poço/sonda na borda.
      const zoom = map.getBoundsZoom(bounds, false, L.point(8, 8));
      map.setView(bounds.getCenter(), zoom);
    }
  });

  return { map, hasShape: !!(jazidaFeatures.own || jazidaFeatures.extra.length), hasWells, minWellYear, maxWellYear, setYearFilter, initialCounts };
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
  // Ancorado no último valor, não no pico histórico (ver niceMaxFromLastValue
  // em shared.js) — mesmo critério do gráfico de produção/RGO acima.
  const boeMax = niceMaxFromLastValue(boeVals.length ? boeVals[boeVals.length - 1] : 0);
  const rgoMax = niceMaxFromLastValue(rgoVals.length ? rgoVals[rgoVals.length - 1] : 0);
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

/* ------------------------- Produção por poço (jazida) ---------------------- */
// Só faz sentido pra jazida COMPARTILHADA — "quais poços produzem mais"
// só é uma pergunta interessante quando são poços de contratos/operadores
// diferentes disputando o mesmo reservatório; um campo de contrato único
// já mostra seus poços no mini-mapa/roadmap sem precisar de outro gráfico.
// Fonte diferente de tudo mais nesta tela: data/producao_pocos.json (ver
// scripts/build_producao_pocos.py), o boletim de POÇOS da ANP — granularidade
// mais fina que data/producao.json (por campo), então cobre só o último mês
// disponível ali, não uma série histórica.
function buildWellProductionChart(container, wells, producaoPocos, mesRef) {
  const rows = [];
  for (const w of wells) {
    const p = producaoPocos[w.n];
    if (p && p.oleoBbld > 0) rows.push({ name: w.n, oleoBbld: p.oleoBbld, campo: p.campo });
  }
  if (!rows.length) return;
  rows.sort((a, b) => b.oleoBbld - a.oleoBbld);
  const max = rows[0].oleoBbld;

  const [ano, mes] = mesRef.split('-').map(Number);
  const card = chartCard(
    'Produção por poço',
    `Óleo por poço produtor (bbl/d), ${MESES_PT[mes]}/${ano} — boletim de poços da ANP, todos os poços da jazida compartilhada (mesmo critério do mini-mapa acima: contrato próprio + os outros contratos/campos da mesma jazida). Só poços com produção de óleo no mês; injetor/seco/abandonado fica de fora.`,
  );
  const list = document.createElement('div');
  list.className = 'hbar-list';
  for (const r of rows) {
    list.appendChild(barRow(
      r.name, (r.oleoBbld / max) * 100, fmtNum(r.oleoBbld) + ' bbl/d', WELL_LEGEND_COLOR,
      () => `<strong>${escapeHtml(r.name)}</strong>`
        + tooltipRowHTML('Campo/trato (boletim ANP)', r.campo)
        + tooltipRowHTML('Óleo', fmtNum(r.oleoBbld) + ' bbl/d'),
    ));
  }
  card.appendChild(list);
  container.appendChild(card);
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

// Largura da 1ª coluna (nome da workstream) dinâmica em vez de fixa — cabe
// o nome mais longo entre as workstreams DESTE projeto ("Marcos do
// Contrato", "Poços Perfurados"...), que antes cortava com reticências
// numa sidebar de 150px fixos. Fonte/chrome = mesma medida de
// .row.workstream-row .label-cell/.label-text no CSS (padding-left 50 +
// padding-right 8 = 58, com folga — mesmo cálculo do roadmap principal,
// ver WORKSTREAM_LABEL_CHROME_DESKTOP em app.js). Só afeta desktop: no
// mobile o CSS troca pra --sidebar-w fixo (84px !important) porque o nome
// quebra em várias linhas em vez de truncar (ver .label-text na media
// query), então não precisa desse cálculo lá.
const CAMPO_WORKSTREAM_LABEL_FONT = '500 12.5px ' + FONT_STACK;
const CAMPO_WORKSTREAM_LABEL_CHROME = 64;
const CAMPO_SIDEBAR_MIN = 100;
const CAMPO_SIDEBAR_MAX = 200;
function campoSidebarWidth(project) {
  let widest = 0;
  for (const ws of project.workstreams) {
    const w = measureTextWidth(ws.name, CAMPO_WORKSTREAM_LABEL_FONT) + CAMPO_WORKSTREAM_LABEL_CHROME;
    if (w > widest) widest = w;
  }
  return Math.min(CAMPO_SIDEBAR_MAX, Math.max(CAMPO_SIDEBAR_MIN, Math.ceil(widest)));
}

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
  rangeEnd = completeLastYear(rangeEnd);
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

function buildRoadmapMilestone(project, item, lane, rangeStart, totalDays, pocosData, below) {
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

  // Rótulo sempre visível (não só no hover) — mesmo texto simplificado do
  // roadmap principal (milestoneLabelOf, shared.js), centralizado sobre o
  // losango via CSS (.campo-roadmap .milestone-label, transform:
  // translateX(-50%)) já que aqui a posição é em porcentagem, não pixel
  // (ver comentário no topo do arquivo) — sem a colisão em pixel do
  // roadmap principal, "below" já veio decidido por data
  // (resolveCampoMilestoneLabelLayout).
  const labelEl = document.createElement('span');
  labelEl.className = 'milestone-label' + (below ? ' below' : '');
  labelEl.style.left = leftPct + '%';
  labelEl.style.top = top + 'px';
  labelEl.textContent = milestoneLabelOf(pocosData, project, item);
  if (isPast) labelEl.style.color = item.done ? MILESTONE_PAST_LABEL_COLOR : MILESTONE_OVERDUE_LABEL_COLOR;
  wrapper.appendChild(labelEl);

  return wrapper;
}

function buildRoadmapRow(labelText, items, rangeStart, totalDays, project, pocosData) {
  const { placements, laneCount } = packLanes(items);
  const rowHeight = Math.max(ROADMAP_ROW_MIN_H, laneCount * ROADMAP_LANE_H + ROADMAP_LANE_PAD);
  const belowByItem = resolveCampoMilestoneLabelLayout(placements, totalDays);

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
        : buildRoadmapMilestone(project, item, lane, rangeStart, totalDays, pocosData, belowByItem.get(item)),
    );
  }
  row.appendChild(timelineCell);
  return row;
}

// Mesma ideia de resolveMilestoneLabelLayout (app.js), mas sem o cálculo em
// pixel: o mini-roadmap posiciona tudo em porcentagem (ver comentário no
// topo do arquivo), e o container só ganha tamanho real depois de montado
// no DOM (mesmo problema do zoom do mini-mapa, ver buildMiniMap) — medir
// largura de rótulo em pixel aqui daria conta errada. Em vez disso, um
// marco que cai muito perto do anterior NA MESMA RAIA (em fração do
// período total do roadmap, não em pixel) alterna pra baixo do losango —
// aproximação suficiente pra rótulo curto (ver milestoneLabelOf) num
// recorte de um projeto só.
const CAMPO_MILESTONE_LABEL_MIN_GAP_FRACTION = 0.05;
function resolveCampoMilestoneLabelLayout(placements, totalDays) {
  const byLane = new Map();
  for (const { item, lane } of placements) {
    if (item.type !== 'milestone') continue;
    if (!byLane.has(lane)) byLane.set(lane, []);
    byLane.get(lane).push(item);
  }
  const minGapDays = totalDays * CAMPO_MILESTONE_LABEL_MIN_GAP_FRACTION;
  const below = new Map();
  for (const laneItems of byLane.values()) {
    const sorted = laneItems.slice().sort((a, b) => parseDate(a.date) - parseDate(b.date));
    let prevDate = null;
    let prevBelow = false;
    for (const item of sorted) {
      const date = parseDate(item.date);
      const tooClose = prevDate !== null && diffDays(prevDate, date) < minGapDays;
      const isBelow = tooClose ? !prevBelow : false;
      below.set(item, isBelow);
      prevDate = date;
      prevBelow = isBelow;
    }
  }
  return below;
}

function buildRoadmapSection(project, pocosData) {
  const wrap = document.createElement('div');
  wrap.className = 'campo-roadmap';
  wrap.style.setProperty('--sidebar-w', campoSidebarWidth(project) + 'px');
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
    wrap.appendChild(buildRoadmapRow(ws.name, ws.items, rangeStart, totalDays, project, pocosData));
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

/* ----------------------------- Filtro de ano (poços) ------------------------ */
// Slider compacto abaixo do mini-mapa: "poços perfurados até o ano X",
// cumulativo (não "só naquele ano") pra combinar com "ver a evolução da
// perfuração" — arrastar mostra o campo se preenchendo aos poucos. Sonda
// ativa fica sempre visível (ver comentário em buildMiniMap), só entra no
// filtro o poço já concluído com data conhecida.

function fmtWellCount(n, singular, plural) {
  return `${n} ${n === 1 ? singular : plural}`;
}

function buildYearFilterBar(minYear, maxYear, initialCounts, onChange) {
  // Sem poço datado, ou um único ano só — não tem "evolução" pra mostrar.
  if (minYear == null || maxYear == null || minYear >= maxYear) return null;

  const wrap = document.createElement('div');
  wrap.className = 'campo-year-filter';
  wrap.innerHTML = `
    <div class="campo-year-filter-row">
      <span class="campo-year-filter-label">Poços perfurados até <strong class="campo-year-filter-value">${maxYear}</strong></span>
      <button type="button" class="btn-ghost campo-year-filter-reset">Ver todos</button>
    </div>
    <input type="range" class="campo-year-filter-slider" min="${minYear}" max="${maxYear}" step="1" value="${maxYear}" aria-label="Filtrar poços por ano de conclusão" />
    <div class="campo-year-filter-counts">
      <span class="campo-year-filter-count campo-year-filter-count-prod"><span class="campo-year-filter-count-dot"></span><span class="campo-year-filter-count-text">${fmtWellCount(initialCounts.producers, 'produtor', 'produtores')}</span></span>
      <span class="campo-year-filter-count campo-year-filter-count-inj"><span class="campo-year-filter-count-dot"></span><span class="campo-year-filter-count-text">${fmtWellCount(initialCounts.injectors, 'injetor', 'injetores')}</span></span>
      <span class="campo-year-filter-count campo-year-filter-count-aband"><span class="campo-year-filter-count-dot"></span><span class="campo-year-filter-count-text">${fmtWellCount(initialCounts.abandoned, 'abandonado', 'abandonados')}</span></span>
    </div>
  `;
  const slider = wrap.querySelector('.campo-year-filter-slider');
  const valueEl = wrap.querySelector('.campo-year-filter-value');
  const resetBtn = wrap.querySelector('.campo-year-filter-reset');
  const prodCountEl = wrap.querySelector('.campo-year-filter-count-prod .campo-year-filter-count-text');
  const injCountEl = wrap.querySelector('.campo-year-filter-count-inj .campo-year-filter-count-text');
  const abandCountEl = wrap.querySelector('.campo-year-filter-count-aband .campo-year-filter-count-text');

  // onChange devolve { producers, injectors, abandoned } (ver setYearFilter
  // em buildMiniMap) pra atualizar os contadores junto com o mapa e os
  // gráficos, tudo no mesmo arrastar do slider.
  function applyCounts(counts) {
    prodCountEl.textContent = fmtWellCount(counts.producers, 'produtor', 'produtores');
    injCountEl.textContent = fmtWellCount(counts.injectors, 'injetor', 'injetores');
    abandCountEl.textContent = fmtWellCount(counts.abandoned, 'abandonado', 'abandonados');
  }

  // Nasce sem chamar onChange — slider no máximo já mostra tudo (mesmo
  // comportamento de antes do filtro existir), só dispara ao usuário mexer.
  slider.addEventListener('input', () => {
    const year = Number(slider.value);
    valueEl.textContent = String(year);
    applyCounts(onChange(year));
  });
  resetBtn.addEventListener('click', () => {
    slider.value = String(maxYear);
    valueEl.textContent = String(maxYear);
    applyCounts(onChange(null));
  });

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

  // Nome popular da jazida (ver PROJECT_DISPLAY_NAME_OVERRIDE em
  // shared.js — "Bacalhau" em vez de "Norte de Carcará", "Sapinhoá" em
  // vez de "Entorno de Sapinhoá") em toda exibição pro usuário; a busca
  // no boletim da ANP (extractProjectSeries) continua usando esse mesmo
  // nome de exibição — é a chave que computeFieldRows usa lá.
  const displayName = projectDisplayName(project.name);

  // Ligados pelo filtro de ano abaixo do mapa (buildYearFilterBar) — `let`
  // porque projetos sem produção retornam antes de chegar na criação dos
  // gráficos (ver early returns abaixo); o filtro checa `if (prodChart)`
  // antes de chamar setHighlightYear, então precisam existir (como null)
  // desde já.
  let prodChart = null;
  let rgoChart = null;

  const header = document.createElement('div');
  header.className = 'campo-panel-header';
  header.innerHTML = `
    <h2 class="campo-panel-title"><span class="proj-dot" style="background:${project.color}"></span>${escapeHtml(displayName)}</h2>
    <span class="campo-panel-badge">${GROUP_BADGES[project.group] || ''}</span>
  `;
  inner.appendChild(header);

  const roadmapCard = chartCard('Roadmap do projeto', 'Marcos e tarefas de cada workstream — mesmos dados do Roadmap principal (index.html), num recorte só deste projeto. Passe o mouse sobre uma barra ou marco para ver os detalhes.');
  roadmapCard.appendChild(buildRoadmapSection(project, ctx.pocosData));
  inner.appendChild(roadmapCard);

  // Dashboard: mapa grande de um lado, roadmap já foi (acima, largura
  // cheia) e produção/RGO do outro lado — ver .campo-dashboard-grid no
  // CSS. mapCol/chartsCol viram 2 colunas lado a lado a partir de
  // MIN_DASHBOARD_W; empilham (mapa em cima) em telas mais estreitas.
  const dashboardGrid = document.createElement('div');
  dashboardGrid.className = 'campo-dashboard-grid';
  inner.appendChild(dashboardGrid);
  const mapCol = document.createElement('div');
  mapCol.className = 'campo-dashboard-map-col';
  dashboardGrid.appendChild(mapCol);
  const chartsCol = document.createElement('div');
  chartsCol.className = 'campo-dashboard-charts-col';
  dashboardGrid.appendChild(chartsCol);

  const mapCard = chartCard('Contorno e poços', 'Poligonal do contrato/campo (quando disponível na ANP) e os poços perfurados dentro dela — cor do ponto por categoria (produção, injeção, seco...), mesmo critério de mapa.html. Zoom ajustado pra preencher o mapa com o contorno deste campo.');
  mapCol.appendChild(mapCard);

  const jazidaFeatures = ctx.jazidaFeaturesByProject[project.name];
  // Jazida compartilhada de dois jeitos possíveis nesta base: (a) entre
  // ENTRADAS diferentes de planos_desenvolvimento.json, cada uma com sua
  // própria poligonal (Atapu/Oeste de Atapu) — isso é jazidaFeatures.extra;
  // (b) dentro de UMA SÓ entrada, via tracts (TP) — Búzios (CO+PP), Sépia
  // (CO+PP), Itapu (CO+PP), Mero (Mero+ANC), Bacalhau (Bacalhau+Bacalhau
  // Norte) — não aparece em jazidaFeatures.extra porque não é uma poligonal
  // à parte, é o MESMO campo/contrato dividido por trato. Sem checar os
  // dois, "Produção por poço" (abaixo) nunca aparecia pros casos do tipo
  // (b), que são a maioria dos exemplos reais dessa base.
  const pd = byNameOrUpper(ctx.pdData, project.name);
  const isSharedJazida = jazidaFeatures.extra.length > 0 || !!(pd && pd.tracts && pd.tracts.length > 1);
  // Poços do contrato PRÓPRIO + dos outros contratos/campos que
  // compartilham a mesma jazida (jazidaFeatures.extra — poligonal
  // tracejada, ver init()) — sem isso só os poços cadastrados sob o nome
  // do contrato rastreado apareciam, mesmo com a poligonal combinada
  // desenhando a jazida inteira: os poços do(s) outro(s) lado(s) ficavam
  // sem marcador nenhum. Dedup por nome do poço (w.n) — mesmo critério de
  // identidade que CONTRACT_WELL_OVERLAP usa (shared.js), pro caso raro de
  // um poço listado sob mais de um dos nomes.
  const extraContractNames = jazidaFeatures.extra.map((f) => f.properties.projeto || f.properties.nome);
  const wells = [];
  const seenWellNames = new Set();
  for (const name of [project.name, ...extraContractNames]) {
    for (const w of contractOwnWells(ctx.pocosData, name)) {
      if (seenWellNames.has(w.n)) continue;
      seenWellNames.add(w.n);
      wells.push(w);
    }
  }
  const mapInfo = buildMiniMap(mapCard, project, jazidaFeatures, wells);
  panel._miniMap = mapInfo.map;
  // Filtro de ano — mostra só os poços perfurados até o ano escolhido
  // (ver setYearFilter em buildMiniMap) e marca a mesma data nos gráficos
  // de produção/RGO (setHighlightYear, shared.js), ligando "quantos poços
  // já tinham entrado" com "onde a produção estava" no mesmo instante.
  // prodChart/rgoChart ainda não existem neste ponto do código (são
  // criados mais abaixo, se houver dados de produção) — o `let` no topo
  // da função e o guard `if (prodChart)` cobrem isso.
  const yearFilterBar = buildYearFilterBar(mapInfo.minWellYear, mapInfo.maxWellYear, mapInfo.initialCounts, (year) => {
    const counts = mapInfo.setYearFilter(year);
    if (prodChart) prodChart.setHighlightYear(year);
    if (rgoChart) rgoChart.setHighlightYear(year);
    return counts;
  });
  if (yearFilterBar) mapCard.appendChild(yearFilterBar);
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
  } else if (pd && pd.tracts && pd.tracts.length > 1) {
    // Compartilhada por TRATO (TP) dentro da mesma entrada/poligonal — ver
    // isSharedJazida acima — sem poligonal à parte pra desenhar tracejada,
    // mas ainda vale avisar (jazidaComposicao lê pd.areaObs, shared.js).
    const composicao = jazidaComposicao(pd);
    const note = document.createElement('p');
    note.className = 'analytics-table-note';
    note.textContent = composicao
      ? `Jazida compartilhada entre tratos do mesmo contrato — ${composicao}.`
      : 'Jazida compartilhada entre tratos do mesmo contrato (Cessão Onerosa + Partilha do Excedente, ou similar).';
    mapCard.appendChild(note);
  }

  // Produção por poço — só faz sentido pra jazida compartilhada (ver
  // buildWellProductionChart e isSharedJazida acima); fica antes dos
  // gráficos de produção/RGO por campo (que dependem de PROJECT_FIELD_BASE,
  // abaixo) porque a fonte aqui é outra (boletim de poços, não boletim por
  // campo) — funciona mesmo pra projeto sem produção individualizada no
  // boletim por campo.
  if (isSharedJazida) {
    buildWellProductionChart(chartsCol, wells, ctx.producaoPocos, ctx.producaoPocosMesRef);
  }

  const base = PROJECT_FIELD_BASE[project.name];
  if (!base) {
    const note = document.createElement('div');
    note.className = 'campo-empty-note';
    note.textContent = 'Sem dados de produção próprios no Boletim da Produção da ANP — campo ainda em exploração, ou produção não individualizada por campo neste contrato.';
    chartsCol.appendChild(note);
    panel.dataset.ready = '1';
    return panel;
  }

  const series = extractProjectSeries(ctx.monthlySeries, displayName);
  const hasAnyData = series.some((m) => m.rows.length);
  if (!hasAnyData) {
    const note = document.createElement('div');
    note.className = 'campo-empty-note';
    note.textContent = 'Campo listado no boletim, mas sem produção registrada em nenhum mês do período coberto.';
    chartsCol.appendChild(note);
    panel.dataset.ready = '1';
    return panel;
  }

  const fpsoMarkers = fpsoMilestonesOf(project);
  const prodCard = chartCard('Produção mensal', 'Um ponto por mês do boletim da ANP — só a fração pré-sal deste campo. Acompanhando a linha: ícone de FPSO acima marca quando cada unidade entrou; ícone de poço (bem pequeno, mesma forma por categoria do mapa acima) abaixo marca a conclusão de cada poço perfurado. Role o mouse pra zoom, arraste pra mover a janela, "Ver tudo" reseta.');
  const prodControls = document.createElement('div');
  prodControls.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap';
  const prodReset = document.createElement('button');
  prodReset.type = 'button';
  prodReset.className = 'btn-ghost';
  prodReset.textContent = 'Ver tudo';
  prodControls.appendChild(prodReset);
  prodCard.insertBefore(prodControls, prodCard.querySelector('h3').nextSibling);
  prodChart = createLineChart(prodCard, series, { fpsos: fpsoMarkers, wells });
  const prodUnitSwitch = buildUnitSwitch((unitKey) => prodChart.setUnit(unitKey), ['oleo', 'gas', 'boe']);
  prodControls.insertBefore(prodUnitSwitch, prodReset);
  prodReset.addEventListener('click', () => prodChart.resetZoom());
  chartsCol.appendChild(prodCard);

  const rgoCard = chartCard('RGO mensal (Razão Gás-Óleo)', 'm³ de gás por m³ de óleo produzido no mês — calculado aqui a partir do óleo e gás do próprio boletim, não vem pronto da ANP.');
  const rgoControls = document.createElement('div');
  rgoControls.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap';
  const rgoReset = document.createElement('button');
  rgoReset.type = 'button';
  rgoReset.className = 'btn-ghost';
  rgoReset.textContent = 'Ver tudo';
  rgoControls.appendChild(rgoReset);
  rgoCard.insertBefore(rgoControls, rgoCard.querySelector('h3').nextSibling);
  rgoChart = createLineChart(rgoCard, series);
  rgoChart.setUnit('rgo');
  rgoReset.addEventListener('click', () => rgoChart.resetZoom());
  chartsCol.appendChild(rgoCard);

  const comboCard = chartCard('Produção e RGO juntos', 'As duas curvas na mesma área, cada uma no seu eixo (produção à esquerda, RGO à direita) — pra comparar a forma ao longo do tempo. Sem zoom/arraste, mesmo período completo do boletim.');
  buildComboChart(comboCard, series, project.color);
  chartsCol.appendChild(comboCard);

  panel.dataset.ready = '1';
  return panel;
}

/* ------------------------------- Seletor ------------------------------------ */
// Botão compacto + painel flutuante (ver .campo-selector no CSS) em vez de
// uma coluna de nav inteira sempre visível — só ocupa uma linha até o
// usuário clicar, deixando a tela inteira pro dashboard (mapa grande +
// roadmap/produção ao redor, ver buildProjectPanel). Nome de exibição
// sempre o popular da jazida (projectDisplayName, shared.js — "Bacalhau"
// em vez de "Norte de Carcará" etc.), não o nome do contrato.

function buildNavItem(project) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'campo-nav-item';
  btn.dataset.projectId = project.id;
  btn.innerHTML = `<span class="campo-nav-dot" style="background:${project.color}"></span><span class="campo-nav-item-name">${escapeHtml(projectDisplayName(project.name))}</span>`;
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
  if (resultEl) resultEl.textContent = q ? `${visible} de ${total} jazidas correspondem a "${query.trim()}"` : '';
}

// byGroup: { producao: [...], exploracao: [...], devolvidos: [...] }
// (mesmo agrupamento por status de sempre, já ordenado). Devolve o
// wrapper pronto pra inserir no DOM, um mapa id->botão da lista (pra
// activate() ligar o clique) e um setActive(project) que atualiza o
// texto/cor/badge do botão e destaca o item corrente na lista — a busca
// (applyNavFilter) e o abrir/fechar do painel ficam todos aqui dentro,
// então quem chama só precisa reagir ao clique de cada item.
function buildProjectSelector(byGroup) {
  const wrap = document.createElement('div');
  wrap.className = 'campo-selector';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'campo-selector-btn';
  btn.innerHTML = `
    <span class="campo-selector-dot"></span>
    <span class="campo-selector-name"></span>
    <span class="campo-selector-badge"></span>
    <span class="campo-selector-chevron">▾</span>
  `;
  wrap.appendChild(btn);

  const panel = document.createElement('div');
  panel.className = 'campo-selector-panel';
  panel.hidden = true;
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'campo-search';
  searchInput.id = 'campoSearch';
  searchInput.placeholder = 'Filtrar jazida...';
  panel.appendChild(searchInput);
  const filterResult = document.createElement('span');
  filterResult.className = 'campo-nav-filter-result';
  filterResult.id = 'campoFilterResult';
  panel.appendChild(filterResult);

  const navItemByProjectId = {};
  let firstProjectId = null;
  for (const g of GROUP_ORDER) {
    if (!byGroup[g].length) continue;
    const label = document.createElement('div');
    label.className = 'campo-nav-group-label';
    label.textContent = GROUP_BADGES[g];
    panel.appendChild(label);
    const list = document.createElement('div');
    list.className = 'campo-nav-list';
    for (const p of byGroup[g]) {
      const item = buildNavItem(p);
      navItemByProjectId[p.id] = item;
      list.appendChild(item);
      if (!firstProjectId) firstProjectId = p.id;
    }
    panel.appendChild(list);
  }
  wrap.appendChild(panel);

  function open() {
    panel.hidden = false;
    wrap.classList.add('open');
    searchInput.value = '';
    applyNavFilter('');
    searchInput.focus();
  }
  function close() {
    panel.hidden = true;
    wrap.classList.remove('open');
  }
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panel.hidden) open(); else close();
  });
  // Fecha ao clicar fora (documento inteiro) ou ao apertar Esc — mesmo
  // padrão de qualquer combobox/dropdown; clique DENTRO do painel (busca,
  // item da lista) não deve fechar sozinho por bolhar até o documento.
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !wrap.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) close();
  });
  searchInput.addEventListener('input', (e) => applyNavFilter(e.target.value));

  function setActive(project) {
    btn.querySelector('.campo-selector-dot').style.background = project.color;
    btn.querySelector('.campo-selector-name').textContent = projectDisplayName(project.name);
    btn.querySelector('.campo-selector-badge').textContent = GROUP_BADGES[project.group] || '';
    for (const [id, item] of Object.entries(navItemByProjectId)) {
      item.classList.toggle('active', id === project.id);
    }
  }

  return { wrap, navItemByProjectId, setActive, close, firstProjectId };
}

/* ---------------------------------- Init ------------------------------------ */

async function init() {
  const content = document.getElementById('campoContent');

  let geojson = null;
  let presalGeojson = null;
  let pocosJson = null;
  let producaoData = null;
  let pdData = null;
  let producaoPocosJson = null;
  try {
    [geojson, presalGeojson, pocosJson, producaoData, pdData, producaoPocosJson] = await Promise.all([
      fetch(GEOJSON_URL).then((r) => r.json()),
      fetch(PRESALT_FIELDS_URL).then((r) => r.json()),
      fetch(POCOS_URL).then((r) => r.json()),
      // no-store: mesmo motivo de producao.js — data/producao.json é
      // reprocessado sem deploy de código junto, o navegador não tem como
      // saber que precisa buscar de novo só pela URL.
      fetch(PRODUCAO_URL, { cache: 'no-store' }).then((r) => r.json()),
      fetch(PD_URL).then((r) => r.json()),
      // Produção por poço (boletim de poços da ANP, ver
      // scripts/build_producao_pocos.py) — granularidade mais fina que
      // data/producao.json (por campo), usada só pro gráfico "Produção por
      // poço" de jazida compartilhada (ver buildWellProductionChart). Mesmo
      // no-store: reprocessado sem deploy de código junto.
      fetch(PRODUCAO_POCOS_URL, { cache: 'no-store' }).then((r) => r.json()),
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

  const monthlySeries = computeMonthlySeries(producaoData.meses || [], state.projects);
  const producaoPocos = producaoPocosJson.pocos || {};
  const ctx = { jazidaFeaturesByProject, pocosData, monthlySeries, producaoPocos, producaoPocosMesRef: producaoPocosJson.mesRef, pdData };

  // Ordem: mesmo agrupamento por status de pocos.js/analises.js (Produção,
  // Exploração, Devolvidos), cada grupo alfabético.
  const byGroup = {};
  for (const g of GROUP_ORDER) byGroup[g] = [];
  for (const p of state.projects) {
    if (byGroup[p.group]) byGroup[p.group].push(p);
  }
  for (const g of GROUP_ORDER) byGroup[g].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  const selector = buildProjectSelector(byGroup);
  content.appendChild(selector.wrap);

  const panelByProjectId = {};
  let activeProjectId = null;

  function activate(projectId) {
    if (activeProjectId === projectId) return;
    if (activeProjectId && panelByProjectId[activeProjectId]) panelByProjectId[activeProjectId].hidden = true;
    activeProjectId = projectId;
    const project = state.projects.find((p) => p.id === projectId);
    selector.setActive(project);
    let panel = panelByProjectId[projectId];
    if (!panel) {
      panel = buildProjectPanel(project, ctx);
      panelByProjectId[projectId] = panel;
      content.appendChild(panel);
    }
    panel.hidden = false;
    if (panel._miniMap) panel._miniMap.invalidateSize();
  }

  for (const [projectId, item] of Object.entries(selector.navItemByProjectId)) {
    item.addEventListener('click', () => { activate(projectId); selector.close(); });
  }

  if (selector.firstProjectId) activate(selector.firstProjectId);
}

init();
