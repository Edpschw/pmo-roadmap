'use strict';

/* =========================================================================
   PMO Roadmap — visão em mapa. Usa o mesmo estado (shared.js) das outras
   páginas só para nome/cor/grupo de cada projeto; a geometria vem de
   data/contratos.geojson, gerado a partir dos shapefiles oficiais da ANP
   (Blocos Exploratórios sob Contrato + Campos de Produção, SIRGAS 2000 —
   equivalente a WGS84 para fins de exibição em mapa web) que o usuário
   baixou e enviou em 22/08/2026. Sem servidor: o GeoJSON é um arquivo
   estático, e os tiles de base vêm do CARTO (única chamada de rede desta
   página; o resto do app funciona offline).
   ========================================================================= */

const GEOJSON_URL = 'data/contratos.geojson';
// Todos os poços de cada contrato/campo, da base cadastral da ANP/BDEP
// (ver scripts/build_pocos.py). Fica fora do seed do roadmap de propósito:
// os campos em produção têm de dezenas a mais de cem poços cada (Búzios
// 153, Tupi 159, Mero 74) — como marco de Gantt isso inviabilizaria a
// leitura do roadmap, mas no mapa é justamente o que se quer ver ao
// aproximar num contrato.
const POCOS_URL = 'data/pocos.json';
// Camada de contexto: outros campos do polígono do pré-sal que não são um
// dos 29 contratos rastreados no roadmap — só pra dar noção de onde eles
// ficam em relação aos que rastreamos. Ver comentário em cima de
// EXTRA_PRESALT_FIELDS no script de geração para a lista e os critérios.
const PRESALT_FIELDS_URL = 'data/campos_presal.geojson';
const PRESALT_FIELD_STYLE = { color: '#9aa1ac', weight: 1.25, dashArray: '4 3', fillColor: '#9aa1ac', fillOpacity: 0.1 };

// Projetos sem poligonal nos dois shapefiles fornecidos, com o motivo —
// ver comentário em cima de PLAN no script de geração (scripts/build_geojson.py).
const PROJECTS_WITHOUT_SHAPE = {
  'Sul de Gato do Mato': 'FID recente (2025); área ainda não aparece nos cadastros públicos de bloco ou campo.',
  'Peroba': 'Bloco devolvido — não consta mais no cadastro de blocos ativos da ANP.',
  'Alto de Cabo Frio Oeste': 'Bloco devolvido — não consta mais no cadastro de blocos ativos da ANP.',
  'Pau-Brasil': 'Bloco devolvido — não consta mais no cadastro de blocos ativos da ANP.',
  'Dois Irmãos': 'Bloco devolvido — não consta mais no cadastro de blocos ativos da ANP.',
  'Três Marias': 'Bloco devolvido — não consta mais no cadastro de blocos ativos da ANP.',
  'Saturno': 'Bloco devolvido — não consta mais no cadastro de blocos ativos da ANP.',
  'Titã': 'Bloco devolvido — não consta mais no cadastro de blocos ativos da ANP.',
};

// Modos de coloração do mapa. 'projeto' usa a cor de cada projeto (mesma do
// Gantt/tabela); 'status' usa o grupo (Exploração/Produção/Devolvidos);
// 'rodada' usa a rodada/regime de origem do contrato, como vem da ANP no
// GeoJSON (props.rodada) — inclui valores fora do padrão "Partilha N"/
// "OPPN" para os campos que nasceram na Cessão Onerosa de 2010 (Búzios,
// Itapu, Sépia, Atapu) e só viraram partilha no leilão do excedente.
const COLOR_MODES = [
  { id: 'projeto', label: 'Projeto' },
  { id: 'status', label: 'Status' },
  { id: 'rodada', label: 'Rodada' },
];
let colorMode = 'projeto';

const GROUP_COLORS = { exploracao: '#2f9ed6', producao: '#1c9e6b', devolvidos: '#d64545' };
// Paleta do resto do app (10 cores) + reforço, para cobrir todas as
// rodadas/regimes distintos encontrados nos 21 contratos com shapefile.
const CATEGORY_PALETTE = PALETTE.concat(['#7a5cff', '#00b3a4', '#8a6d3b']);
let rodadaColorMap = {};
let rodadaOrder = [];

const groupVisible = {};
for (const g of GROUP_DEFS) groupVisible[g.id] = true;

const toastEl = document.getElementById('toast');
let toastTimer = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
}

const map = L.map('map', { zoomControl: true, minZoom: 3 }).setView([-25.3, -43], 6);
// CARTO Dark Matter: base escura (visual "executivo"), sem chave de API.
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  subdomains: 'abcd',
  maxZoom: 20,
}).addTo(map);

// Adicionada antes das camadas de projeto para ficar visualmente por baixo
// delas (Leaflet empilha na ordem de addTo).
const presaltFieldsLayer = L.layerGroup().addTo(map);
let presaltFieldsVisible = true;

const groupLayers = {};
for (const g of GROUP_DEFS) groupLayers[g.id] = L.layerGroup().addTo(map);

const layerByProjectId = {};
const featureByProject = {};

function formatAnpDate(s) {
  return s ? s.replaceAll('-', '/') : '—';
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function colorForProject(project) {
  if (colorMode === 'status') return GROUP_COLORS[project.group] || '#5c6470';
  if (colorMode === 'rodada') {
    const feat = featureByProject[project.name];
    const rodada = feat && feat.properties.rodada;
    return (rodada && rodadaColorMap[rodada]) || '#5c6470';
  }
  return project.color;
}

function popupHTML(project, props) {
  const groupLabel = (GROUP_DEFS.find((g) => g.id === project.group) || {}).label || project.group;
  const rows = [
    ['Grupo', groupLabel],
    ['Bacia', props.bacia || '—'],
    ['Operador', props.operador || '—'],
    ['Rodada', props.rodada || '—'],
  ];
  if (props.fonte === 'bloco_exploratorio') {
    rows.push(['Assinatura', formatAnpDate(props.assinatura)]);
  } else {
    rows.push(['Campo(s) ANP', props.campos || '—']);
    rows.push(['Início produção', formatAnpDate(props.inicio_producao)]);
  }
  rows.push(['Área', props.area_km2 ? Math.round(props.area_km2).toLocaleString('pt-BR') + ' km²' : '—']);
  const rowsHTML = rows.map(([k, v]) => `<tr><td class="k">${k}</td><td>${v}</td></tr>`).join('');
  return `<div class="map-popup">
    <h3 style="color:${colorForProject(project)}">${escapeHtml(project.name)}</h3>
    <table>${rowsHTML}</table>
    <p class="map-popup-source">Fonte: ANP — ${props.fonte === 'bloco_exploratorio' ? 'Blocos Exploratórios sob Contrato' : 'Campos de Produção'} (SIRGAS 2000)</p>
  </div>`;
}

// Ícone de poço no mapa: mesmo desenho de torre de perfuração do
// wellIconSVG em app.js, como divIcon do Leaflet (contorno escuro pra
// destacar tanto sobre o tile escuro quanto sobre o preenchimento colorido
// do polígono).
function wellDivIcon(color) {
  return L.divIcon({
    className: 'map-well-icon',
    html: `<svg viewBox="0 0 16 16" width="15" height="15" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,0.6))">
      <path d="M8 1L3.2 13.5h1.7L8 4.6l3.1 8.9h1.7z" fill="${color}" stroke="#0b0d10" stroke-width="0.6"/>
      <rect x="2.6" y="13.5" width="10.8" height="1.3" rx="0.3" fill="${color}" stroke="#0b0d10" stroke-width="0.4"/>
    </svg>`,
    iconSize: [15, 15],
    iconAnchor: [7.5, 13],
  });
}

// Fração do mapa que o contrato precisa ocupar (na maior das duas
// dimensões — largura ou altura da tela) pros poços dele aparecerem
// sozinhos. Comparar por dimensão, e não por área, é de propósito: os
// blocos são quase quadrados e a tela é panorâmica, então um bloco que
// preenche 90% da altura ainda ficaria abaixo de 50% *de área* — ou seja,
// pela área os poços não apareceriam nem no zoom que enquadra o bloco
// inteiro, que é justamente quando o usuário está olhando pra ele.
const WELL_MAP_COVERAGE = 0.5;

// Só a regra de ocupação não basta depois que entraram os campos em
// produção: Búzios (153 poços) e Tupi (159) atingem metade da tela num zoom
// em que os marcadores ficam a ~10 px um do outro, ou seja, uma mancha
// ilegível. Então um conjunto denso só acende quando seus marcadores também
// estiverem a pelo menos esta distância na tela (o ícone tem 15 px).
const WELL_MIN_SPACING_PX = 14;

// ...mas há conjuntos que nunca vão separar, por mais que se aproxime: são
// poços perfurados praticamente do mesmo ponto (sondas de um mesmo módulo,
// e desvios do tipo 1373/1373A/1373B). Pra eles não sumirem pra sempre, a
// exigência de espaçamento é abandonada depois de 2 níveis de zoom além do
// limiar de ocupação — daí o 4 = 2².
const WELL_SPACING_GIVE_UP_RATIO = WELL_MAP_COVERAGE * 4;

// Poços a menos disto um do outro (em graus, ~110 m) viram um marcador só.
// Além de limpar a mancha, é o mais honesto: são o mesmo ponto no mapa.
const WELL_MERGE_GRID = 1000;

// Contratos sem poligonal na ANP (ver PROJECTS_WITHOUT_SHAPE) não têm bloco
// pra medir, mas têm poços com coordenada real — nesses casos a referência
// é uma caixa em volta dos próprios poços, com esta folga em graus de cada
// lado (~0,2° de lado no total, ≈ 20 km, ordem de grandeza de um bloco do
// pré-sal) pra que o zoom em que os poços aparecem fique parecido com o dos
// contratos que têm poligonal.
const WELL_ONLY_BOUNDS_PAD = 0.1;

function wellItemsOf(project) {
  const wells = [];
  for (const ws of project.workstreams) {
    if (ws.name !== 'Poços Exploratórios') continue;
    for (const item of ws.items) {
      if (item.type === 'milestone' && item.icon === 'well') wells.push(item);
    }
  }
  return wells;
}

// Código do poço dentro do nome do marco no roadmap ("Poço pioneiro
// 1-BRSA-1363-RJS (gás com CO2...)" -> "1-BRSA-1363-RJS"), pra casar o
// marco com o registro da ANP e manter o rótulo curado do roadmap, que
// carrega o resultado do poço. Marco sem código (ex.: "Poço exploratório
// (previsto)") não casa com nada e é desenhado à parte.
const WELL_CODE_RE = /\b\d+-[A-Z]{2,6}-\d+[A-Z]*-[A-Z]{3}\b/;
function wellCodeOf(name) {
  const m = String(name).match(WELL_CODE_RE);
  return m ? m[0] : null;
}

let pocosData = {};

function wellPopupHTML(label, w, color, others) {
  const rows = [];
  if (w.d) rows.push(['Conclusão', formatBR(w.d)]);
  if (w.op) rows.push(['Operador', w.op]);
  if (w.cat) rows.push(['Categoria', w.cat]);
  if (w.rec) rows.push(['Resultado', w.rec]);
  if (w.sit) rows.push(['Situação', w.sit]);
  if (w.lam) rows.push(['Lâmina d\'água', w.lam.toLocaleString('pt-BR') + ' m']);
  if (w.prof) rows.push(['Profundidade', w.prof.toLocaleString('pt-BR') + ' m']);
  if (w.ps) rows.push(['Atingiu o pré-sal', w.ps === 'S' ? 'Sim' : 'Não']);
  if (w.sonda) rows.push(['Sonda', w.sonda]);
  const rowsHTML = rows.map(([k, v]) => `<tr><td class="k">${k}</td><td>${escapeHtml(v)}</td></tr>`).join('');
  const sub = label !== w.n ? `<p class="map-popup-source">Poço ${escapeHtml(w.n)}</p>` : '';
  let merged = '';
  if (others && others.length) {
    const list = others.map((e) => {
      const code = (e.info && e.info.n) || e.label;
      return `<li>${escapeHtml(code)}${e.date ? ' — ' + formatBR(e.date) : ''}</li>`;
    }).join('');
    merged = `<p class="map-popup-source">Mesmo ponto (${others.length}):</p><ul class="map-popup-list">${list}</ul>`;
  }
  return `<div class="map-popup">
    <h3 style="color:${color}">${escapeHtml(label)}</h3>
    ${sub}
    <table>${rowsHTML}</table>
    ${merged}
    <p class="map-popup-source">Fonte: ANP/BDEP — cadastro de poços</p>
  </div>`;
}

function addWellMarker(group, latlng, color, entries) {
  const marker = L.marker(latlng, { icon: wellDivIcon(color), zIndexOffset: 500 });
  const first = entries[0];
  const when = first.date ? formatBR(first.date) : '';
  const extra = entries.length > 1 ? `<br>+ ${entries.length - 1} poço(s) no mesmo ponto` : '';
  marker.bindTooltip(
    `${escapeHtml(first.label)}${when ? '<br>' + when : ''}${first.approx ? ' (aprox.)' : ''}${extra}`,
    { direction: 'top', offset: [0, -10], className: 'map-well-tooltip' },
  );
  if (first.info) marker.bindPopup(wellPopupHTML(first.label, first.info, color, entries.slice(1)));
  group.addLayer(marker);
}

// Distância mediana de cada marcador ao vizinho mais próximo, em pixels no
// zoom 0 — como a escala do Leaflet dobra a cada nível, dá pra converter
// pro zoom atual com uma multiplicação (sep0 * 2^zoom) em vez de refazer a
// conta O(n²) a cada movimento do mapa. Infinito quando há 0 ou 1 marcador:
// sem vizinho, não há sobreposição possível.
function medianNeighborSpacing(latlngs) {
  if (latlngs.length < 2) return Infinity;
  const pts = latlngs.map((ll) => map.project(L.latLng(ll), 0));
  const nearest = pts.map((p, i) => {
    let best = Infinity;
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue;
      const d = Math.hypot(p.x - pts[j].x, p.y - pts[j].y);
      if (d < best) best = d;
    }
    return best;
  }).sort((a, b) => a - b);
  return nearest[Math.floor(nearest.length / 2)];
}

// Monta os marcadores de poço de um contrato (ou de um campo da camada de
// contexto, quando project é nulo). A base da ANP manda na posição e nas
// informações; quando o poço também é um marco do roadmap, o rótulo curado
// do marco prevalece — é ele que conta o resultado ("descoberta", "poço
// seco", "sem indícios de pré-sal"). Marco sem correspondente na base (só
// o poço previsto do Tupinambá hoje) entra pelo fallback: posição real se
// tiver coords, senão uma aproximação dentro do polígono do contrato,
// espalhada em círculo pra não empilhar e deslocada pro sul do centro,
// que é onde o popup do contrato abre.
function buildWellMarkers(key, project, bounds, color) {
  const anpWells = pocosData[key] || [];
  const milestones = project ? wellItemsOf(project) : [];
  const byCode = new Map();
  for (const item of milestones) {
    const code = wellCodeOf(item.name);
    if (code) byCode.set(code, item);
  }

  // Agrupa por célula de ~110 m: poços do mesmo ponto viram um marcador só.
  // Marco do roadmap na frente da lista, pra ser ele o rótulo do marcador.
  const cells = new Map();
  const addEntry = (latlng, entry, curated) => {
    const k = `${Math.round(latlng[0] * WELL_MERGE_GRID)}|${Math.round(latlng[1] * WELL_MERGE_GRID)}`;
    let cell = cells.get(k);
    if (!cell) {
      cell = { latlng, entries: [] };
      cells.set(k, cell);
    }
    if (curated) cell.entries.unshift(entry);
    else cell.entries.push(entry);
  };

  const matched = new Set();
  for (const w of anpWells) {
    const item = byCode.get(w.n);
    if (item) matched.add(item);
    addEntry(w.c, {
      label: item ? item.name : w.n,
      info: w,
      date: item ? item.date : w.d,
      approx: false,
    }, !!item);
  }

  const leftovers = milestones.filter((item) => !matched.has(item));
  const approxWells = leftovers.filter((item) => !item.coords);
  let baseLat, baseLng, radiusLat, radiusLng;
  if (bounds) {
    const center = bounds.getCenter();
    const latSpan = bounds.getNorth() - bounds.getSouth();
    const lngSpan = bounds.getEast() - bounds.getWest();
    baseLat = center.lat - Math.max(latSpan * 0.32, 0.02);
    baseLng = center.lng;
    radiusLat = Math.max(latSpan * 0.12, 0.01);
    radiusLng = Math.max(lngSpan * 0.12, 0.01);
  }
  leftovers.forEach((item) => {
    let lat, lng;
    if (item.coords) {
      [lat, lng] = item.coords;
    } else {
      if (!bounds) return;
      lat = baseLat;
      lng = baseLng;
      if (approxWells.length > 1) {
        const i = approxWells.indexOf(item);
        const angle = (2 * Math.PI * i) / approxWells.length;
        lat += Math.sin(angle) * radiusLat;
        lng += Math.cos(angle) * radiusLng;
      }
    }
    addEntry([lat, lng], { label: item.name, info: null, date: item.date, approx: item.approx }, true);
  });

  if (!cells.size) return null;
  const group = L.layerGroup();
  const positions = [];
  for (const cell of cells.values()) {
    addWellMarker(group, cell.latlng, color, cell.entries);
    positions.push(cell.latlng);
  }
  return { group, spacing0: medianNeighborSpacing(positions), count: positions.length };
}

// Um registro por contrato/campo que tem poço no mapa. refBounds é a área
// usada pela regra de visibilidade: a poligonal quando existe, ou uma caixa
// em volta dos próprios poços quando o contrato não tem poligonal na ANP.
const wellSets = [];
const wellSetByProjectId = {};

function wellsOnlyBounds(key, project) {
  const coords = (pocosData[key] || []).map((w) => w.c)
    .concat(project ? wellItemsOf(project).filter((i) => i.coords).map((i) => i.coords) : []);
  if (!coords.length) return null;
  const b = L.latLngBounds(coords);
  const p = WELL_ONLY_BOUNDS_PAD;
  return L.latLngBounds([b.getSouth() - p, b.getWest() - p], [b.getNorth() + p, b.getEast() + p]);
}

function registerWellSet(key, project, bounds, color, contexto) {
  const built = buildWellMarkers(key, project, bounds, color);
  if (!built) return;
  const refBounds = bounds || wellsOnlyBounds(key, project);
  if (!refBounds) return;
  const set = {
    key,
    group: built.group,
    spacing0: built.spacing0,
    refBounds,
    groupId: project ? project.group : null,
    contexto: !!contexto,
  };
  wellSets.push(set);
  if (project) wellSetByProjectId[project.id] = set;
}

// Quanto do mapa (na maior das duas dimensões) o retângulo ocuparia no zoom
// dado. Passa de 1 quando o contrato é maior que a tela — é o caso de estar
// com o zoom "dentro" do bloco, em que os poços devem aparecer.
function boundsScreenRatio(bounds, zoom) {
  const nw = map.project(bounds.getNorthWest(), zoom);
  const se = map.project(bounds.getSouthEast(), zoom);
  const size = map.getSize();
  return Math.max(Math.abs(se.x - nw.x) / size.x, Math.abs(se.y - nw.y) / size.y);
}

// Poços aparecem sozinhos conforme o zoom: sem clique nenhum, para todos os
// contratos que tenham poço cadastrado. Critério: o contrato precisa estar
// visível na tela e ocupar pelo menos WELL_MAP_COVERAGE dela — assim a
// visão geral fica limpa e, ao aproximar num contrato, só os poços dele
// aparecem. Grupo desmarcado no painel esconde os poços junto com os
// polígonos.
// As duas condições de zoom (ocupação da tela e espaçamento dos
// marcadores), separadas da checagem de visibilidade pra que flyToProject
// possa perguntar "em que zoom este conjunto acenderia?".
function wellsFitAtZoom(set, zoom) {
  const ratio = boundsScreenRatio(set.refBounds, zoom);
  if (ratio < WELL_MAP_COVERAGE) return false;
  return set.spacing0 * Math.pow(2, zoom) >= WELL_MIN_SPACING_PX
    || ratio >= WELL_SPACING_GIVE_UP_RATIO;
}

function updateWellVisibility() {
  const mapBounds = map.getBounds();
  const zoom = map.getZoom();
  for (const set of wellSets) {
    const layerOn = set.contexto
      ? presaltFieldsVisible
      : (groupVisible[set.groupId] !== undefined ? groupVisible[set.groupId] : groupVisible[GROUP_FALLBACK] !== false);
    const show = layerOn && set.refBounds.intersects(mapBounds) && wellsFitAtZoom(set, zoom);
    const shown = map.hasLayer(set.group);
    if (show && !shown) set.group.addTo(map);
    else if (!show && shown) map.removeLayer(set.group);
  }
}

function presaltFieldPopupHTML(props) {
  const rows = [
    ['Bacia', props.bacia || '—'],
    ['Operador', props.operador || '—'],
    ['Rodada', props.rodada || '—'],
    ['Etapa', props.etapa || '—'],
    ['Área', props.area_km2 ? Math.round(props.area_km2).toLocaleString('pt-BR') + ' km²' : '—'],
  ];
  const rowsHTML = rows.map(([k, v]) => `<tr><td class="k">${k}</td><td>${v}</td></tr>`).join('');
  return `<div class="map-popup">
    <h3 style="color:#9aa1ac">${escapeHtml(props.nome)}</h3>
    <table>${rowsHTML}</table>
    <p class="map-popup-source">Campo de contexto (fora dos 29 contratos rastreados) — Fonte: ANP, Campos de Produção (SIRGAS 2000)</p>
  </div>`;
}

async function init() {
  let geojson;
  try {
    const res = await fetch(GEOJSON_URL);
    geojson = await res.json();
  } catch (e) {
    showToast('Não foi possível carregar data/contratos.geojson.');
    renderPanel();
    return;
  }

  try {
    const pocosRes = await fetch(POCOS_URL);
    pocosData = (await pocosRes.json()).pocos || {};
  } catch (e) {
    // Sem a base de poços o mapa segue mostrando só as poligonais.
    showToast('Não foi possível carregar data/pocos.json — mapa sem poços.');
  }

  try {
    const presRes = await fetch(PRESALT_FIELDS_URL);
    const presGeojson = await presRes.json();
    for (const feat of presGeojson.features) {
      const layer = L.geoJSON(feat, { style: PRESALT_FIELD_STYLE });
      layer.eachLayer((l) => l.bindPopup(presaltFieldPopupHTML(feat.properties)));
      layer.addTo(presaltFieldsLayer);
      registerWellSet(feat.properties.nome, null, layer.getBounds(), PRESALT_FIELD_STYLE.color, true);
    }
  } catch (e) {
    // Camada de contexto é opcional — segue sem ela se não carregar.
  }

  for (const feat of geojson.features) featureByProject[feat.properties.projeto] = feat;

  rodadaOrder = [...new Set(geojson.features.map((f) => f.properties.rodada).filter(Boolean))].sort();
  rodadaColorMap = {};
  rodadaOrder.forEach((r, i) => { rodadaColorMap[r] = CATEGORY_PALETTE[i % CATEGORY_PALETTE.length]; });

  const allBounds = [];
  for (const project of state.projects) {
    const feat = featureByProject[project.name];
    if (!feat) continue;
    const layer = L.geoJSON(feat, {
      style: {
        color: colorForProject(project),
        weight: 2,
        fillColor: colorForProject(project),
        fillOpacity: 0.42,
      },
    });
    // bindPopup na camada externa (o grupo retornado por L.geoJSON) não
    // propaga pros filhos nem abre sozinho ao clicar no polígono no mapa —
    // precisa ligar em cada sub-camada individualmente.
    const bounds = layer.getBounds();
    layer.eachLayer((l) => l.bindPopup(popupHTML(project, feat.properties)));
    const target = groupLayers[project.group] || groupLayers[GROUP_FALLBACK];
    layer.addTo(target);
    layerByProjectId[project.id] = layer;
    allBounds.push(bounds);
  }

  // Poços de TODOS os contratos que tenham poço cadastrado — inclusive os
  // campos em produção (Búzios, Mero/Libra, Bacalhau/Norte de Carcará…) e
  // os 8 sem poligonal na ANP (blocos devolvidos e Sul de Gato do Mato),
  // que ficavam completamente fora do mapa: com a coordenada real de cada
  // poço, o polígono deixou de ser necessário pra posicioná-los.
  for (const project of state.projects) {
    const layer = layerByProjectId[project.id];
    registerWellSet(project.name, project, layer ? layer.getBounds() : null, project.color, false);
  }

  if (allBounds.length) {
    let bounds = allBounds[0];
    for (const b of allBounds.slice(1)) bounds = bounds.extend(b);
    map.fitBounds(bounds, { padding: [24, 24] });
  }

  map.on('moveend zoomend', updateWellVisibility);
  updateWellVisibility();

  renderPanel();
}

function setColorMode(mode) {
  colorMode = mode;
  for (const project of state.projects) {
    const layer = layerByProjectId[project.id];
    if (!layer) continue;
    const c = colorForProject(project);
    layer.setStyle({ color: c, fillColor: c });
    const feat = featureByProject[project.name];
    if (feat) layer.eachLayer((l) => l.bindPopup(popupHTML(project, feat.properties)));
  }
  renderPanel();
}

// Zoom que enquadra o alvo (como flyToBounds faria) mas nunca abaixo do
// necessário pros poços daquele contrato aparecerem — focar um contrato e
// não ver poço nenhum é justamente o que se quer evitar. Sobe no máximo 3
// níveis além do enquadramento pra não sair voando pra um zoom em que o
// contrato virou um detalhe; nos campos densos (Búzios, Norte de Carcará)
// são os 2 níveis que separam "mancha" de "poços distinguíveis".
const FOCUS_MAX_EXTRA_ZOOM = 3;

function zoomToFocus(bounds, set) {
  const fit = map.getBoundsZoom(bounds, false, L.point(40, 40));
  let zoom = fit;
  const limit = Math.min(map.getMaxZoom(), fit + FOCUS_MAX_EXTRA_ZOOM);
  while (zoom < limit) {
    if (set ? wellsFitAtZoom(set, zoom) : boundsScreenRatio(bounds, zoom) >= WELL_MAP_COVERAGE) break;
    zoom += 1;
  }
  return zoom;
}

function flyToProject(project) {
  const layer = layerByProjectId[project.id];
  const wellSet = wellSetByProjectId[project.id];
  if (layer) {
    const bounds = layer.getBounds();
    // Ancorado na borda norte, não no centro: nesse zoom os poços do
    // contrato já estão visíveis, e um popup no meio do bloco taparia
    // justamente eles (o balão do Leaflet sobe a partir do ponto).
    const anchor = L.latLng(bounds.getNorth(), bounds.getCenter().lng);
    map.once('moveend', () => layer.eachLayer((l) => l.openPopup(anchor)));
    map.flyTo(bounds.getCenter(), zoomToFocus(bounds, wellSet), { duration: 0.6 });
    return;
  }
  // Sem poligonal, mas com poços cadastrados: vale a pena voar até eles em
  // vez de só avisar que não há shapefile.
  const ref = wellSet && wellSet.refBounds;
  if (ref) {
    showToast(`Sem poligonal para "${project.name}" (${PROJECTS_WITHOUT_SHAPE[project.name] || 'não encontrada nos shapefiles fornecidos.'}) — mostrando os poços do contrato.`);
    map.flyTo(ref.getCenter(), zoomToFocus(ref, wellSet), { duration: 0.6 });
    return;
  }
  showToast(`Sem poligonal para "${project.name}": ${PROJECTS_WITHOUT_SHAPE[project.name] || 'não encontrada nos shapefiles fornecidos.'}`);
}

function toggleGroup(groupId, visible) {
  groupVisible[groupId] = visible;
  const layer = groupLayers[groupId];
  if (visible) map.addLayer(layer);
  else map.removeLayer(layer);
  updateWellVisibility();
}

function togglePresaltFields(visible) {
  presaltFieldsVisible = visible;
  if (visible) map.addLayer(presaltFieldsLayer);
  else map.removeLayer(presaltFieldsLayer);
  updateWellVisibility();
}

function renderColorModeControl(container) {
  const wrap = document.createElement('div');
  wrap.className = 'map-mode-control';
  const label = document.createElement('div');
  label.className = 'map-mode-label';
  label.textContent = 'Colorir por';
  wrap.appendChild(label);

  const group = document.createElement('div');
  group.className = 'map-mode-buttons';
  for (const m of COLOR_MODES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'map-mode-btn' + (colorMode === m.id ? ' active' : '');
    btn.textContent = m.label;
    btn.addEventListener('click', () => setColorMode(m.id));
    group.appendChild(btn);
  }
  wrap.appendChild(group);
  container.appendChild(wrap);

  if (colorMode === 'status') {
    container.appendChild(buildLegend(GROUP_DEFS.map((g) => [g.label, GROUP_COLORS[g.id]])));
  } else if (colorMode === 'rodada') {
    container.appendChild(buildLegend(rodadaOrder.map((r) => [r, rodadaColorMap[r]])));
  }
}

function buildLegend(entries) {
  const legend = document.createElement('div');
  legend.className = 'map-legend';
  for (const [label, color] of entries) {
    const row = document.createElement('div');
    row.className = 'map-legend-row';
    const dot = document.createElement('span');
    dot.className = 'map-panel-dot';
    dot.style.background = color;
    row.appendChild(dot);
    row.appendChild(document.createTextNode(label));
    legend.appendChild(row);
  }
  return legend;
}

// Preservado entre re-renders (troca de modo de cor, toggle de grupo etc.)
// pra não reabrir o painel sozinho toda vez que o usuário interage com ele.
let panelCollapsed = false;

function renderPanel() {
  const panelEl = document.getElementById('mapPanel');
  panelEl.innerHTML = '';
  panelEl.classList.toggle('collapsed', panelCollapsed);

  const header = document.createElement('div');
  header.className = 'map-panel-header';
  const title = document.createElement('h2');
  title.textContent = 'Camadas';
  const toggle = document.createElement('span');
  toggle.className = 'map-panel-toggle';
  toggle.textContent = '▾';
  header.appendChild(title);
  header.appendChild(toggle);
  header.addEventListener('click', () => {
    panelCollapsed = !panelCollapsed;
    renderPanel();
  });
  panelEl.appendChild(header);

  const el = document.createElement('div');
  el.className = 'map-panel-body';
  panelEl.appendChild(el);

  renderColorModeControl(el);

  const presaltSection = document.createElement('div');
  presaltSection.className = 'map-panel-section';
  const presaltHeader = document.createElement('label');
  presaltHeader.className = 'map-panel-group-header';
  const presaltCheckbox = document.createElement('input');
  presaltCheckbox.type = 'checkbox';
  presaltCheckbox.checked = presaltFieldsVisible;
  presaltCheckbox.addEventListener('change', () => togglePresaltFields(presaltCheckbox.checked));
  presaltHeader.appendChild(presaltCheckbox);
  presaltHeader.appendChild(document.createTextNode(' Outros campos do pré-sal'));
  presaltSection.appendChild(presaltHeader);
  const presaltNote = document.createElement('p');
  presaltNote.className = 'map-panel-note';
  presaltNote.style.marginTop = '0';
  presaltNote.textContent = 'Contexto geográfico (tracejado cinza) — não fazem parte dos 29 contratos rastreados.';
  presaltSection.appendChild(presaltNote);
  el.appendChild(presaltSection);

  for (const g of GROUP_DEFS) {
    const projects = state.projects.filter((p) => p.group === g.id);
    if (!projects.length) continue;

    const section = document.createElement('div');
    section.className = 'map-panel-section';

    const header = document.createElement('label');
    header.className = 'map-panel-group-header';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = groupVisible[g.id];
    checkbox.addEventListener('change', () => toggleGroup(g.id, checkbox.checked));
    header.appendChild(checkbox);
    header.appendChild(document.createTextNode(' ' + g.label));
    section.appendChild(header);

    const list = document.createElement('ul');
    list.className = 'map-panel-list';
    for (const project of projects) {
      const li = document.createElement('li');
      const hasShape = !!layerByProjectId[project.id];
      li.className = 'map-panel-item' + (hasShape ? '' : ' no-shape');
      const dot = document.createElement('span');
      dot.className = 'map-panel-dot';
      dot.style.background = hasShape ? colorForProject(project) : 'transparent';
      dot.style.borderColor = hasShape ? 'transparent' : 'var(--map-text-faint)';
      li.appendChild(dot);
      li.appendChild(document.createTextNode(project.name));
      if (!hasShape) {
        const flag = document.createElement('span');
        flag.className = 'map-panel-flag';
        flag.textContent = 'sem shapefile';
        li.appendChild(flag);
      }
      li.addEventListener('click', () => flyToProject(project));
      list.appendChild(li);
    }
    section.appendChild(list);
    el.appendChild(section);
  }

  const wellsNote = document.createElement('p');
  wellsNote.className = 'map-panel-note';
  wellsNote.textContent = 'Os poços de cada contrato aparecem sozinhos ao aproximar o zoom, quando o contrato ocupa pelo menos metade do mapa.';
  el.appendChild(wellsNote);

  const missingCount = Object.keys(PROJECTS_WITHOUT_SHAPE).length;
  const note = document.createElement('p');
  note.className = 'map-panel-note';
  note.textContent = `${missingCount} projeto(s) sem poligonal disponível nos shapefiles da ANP fornecidos (clique no nome pra ver o motivo e ir até os poços).`;
  el.appendChild(note);
}

init();
