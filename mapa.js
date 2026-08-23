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
// Poços da base cadastral da ANP/BDEP (ver scripts/build_pocos.py), em duas
// partes: "pocos" tem os poços de cada um dos 24 contratos/campos nomeados
// (rótulo curado quando o poço também é marco do roadmap), "outros" tem o
// resto do play do pré-sal — poços offshore de Santos/Campos com pré-sal
// confirmado pela ANP (ATINGIU_PRESAL='S') que não pertencem a nenhum
// desses contratos, ~280 poços. Fica fora do seed do roadmap de propósito:
// os campos em produção têm de dezenas a mais de cem poços cada (Búzios
// 153, Tupi 159, Mero 74) — como marco de Gantt isso inviabilizaria a
// leitura do roadmap, mas no mapa é exatamente o que se quer ver.
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

// Adicionadas antes das camadas de projeto para ficarem visualmente por
// baixo delas (Leaflet empilha na ordem de addTo).
const presaltFieldsLayer = L.layerGroup().addTo(map);
let presaltFieldsVisible = true;
const outrosPocosLayer = L.layerGroup();
let outrosPocosVisible = true;
// Zoom mínimo pra QUALQUER poço aparecer no mapa — mesma regra pros
// nomeados (dos 24 contratos/campos) e pros genéricos ("todos os poços do
// pré-sal"): na visão geral do Brasil inteiro (zoom inicial, ~6-7), um
// poço é só um pontinho sem contexto, e com centenas deles a tela vira uma
// nuvem. Um zoom intermediário — nem tão baixo quanto essa visão geral nem
// tão alto quanto focar um contrato específico — é o ponto em que já dá
// pra ver a região (Santos, Campos) sem poluir. Ajustável pelo usuário
// (ver painel "Controles"), por isso variável em vez de const.
const WELLS_MIN_ZOOM_DEFAULT = 8;
const WELLS_MIN_ZOOM_RANGE = [3, 14];
let wellsMinZoom = WELLS_MIN_ZOOM_DEFAULT;

const groupLayers = {};
for (const g of GROUP_DEFS) groupLayers[g.id] = L.layerGroup().addTo(map);
// Poços dos contratos rastreados, um layer por grupo — separado do
// groupLayers dos polígonos (que ficam visíveis em qualquer zoom) porque a
// visibilidade destes depende também do zoom (ver updateWellsVisibility).
const wellGroupLayers = {};
for (const g of GROUP_DEFS) wellGroupLayers[g.id] = L.layerGroup();
// Poços dos campos de contexto (ver presaltFieldsLayer) — mesma separação.
const wellPresaltLayer = L.layerGroup();

const layerByProjectId = {};
const featureByProject = {};
// Rótulo com o nome do projeto sobre o centro do polígono — só aparece
// no zoom em que os poços ainda não apareceram (ver updateProjectLabels),
// pra dar contexto de qual projeto é qual sem precisar clicar em cada
// polígono. Adicionado direto no mapa (não num layerGroup), então
// showOrHide funciona nele igual funciona nos outros.
const projectLabelByProjectId = {};

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

// Classifica um poço da base ANP/BDEP numa das 6 situações que o mapa
// desenha com ícone próprio (ver WELL_SHAPES) — prioridade em cima de
// RECLASSIFICACAO (o resultado apurado do poço), caindo pra SITUACAO (o
// estado atual, "produzindo"/"injetando"/etc.) só quando não há
// reclassificação confiável (poço muito antigo, ou sob confidencialidade).
// 'indefinido' é o poço sem nenhum registro de resultado — a maioria dos
// marcos curados do roadmap (ver addWellMarker), que carregam o resultado
// no próprio nome em vez de num campo separado.
//
// Produtor/injetor SÓ conta se o poço ainda estiver ativo: RECLASSIFICACAO
// é um veredito histórico (o que o poço chegou a ser um dia) e não muda
// quando ele é desativado depois — SITUACAO, sim. Sem checar isso, um
// poço que produziu por anos e foi abandonado continua com ícone de
// "produção" pra sempre (quase metade dos poços marcados como produtor na
// base tinham SITUACAO abandonado/fechado — foi reportado como "poço
// abandonado aparecendo como poço de óleo" e é exatamente essa a causa).
// Os outros resultados (seco/indício/gás) não sofrem essa correção: já
// são, por definição, poços que não viraram produtor nem injetor, então
// não têm o mesmo risco de "parecer ativo" indevidamente.
function wellCategory(info) {
  if (!info) return 'indefinido';
  const rec = info.rec || '';
  const sit = info.sit || '';
  const sitAbandoned = sit.includes('ABANDONADO') || sit === 'ARRASADO' || sit === 'FECHADO' || sit === 'DEVOLVIDO';
  if (rec.includes('INJEÇÃO')) return sitAbandoned ? 'abandonado' : 'injecao';
  if (rec.includes('ABANDONADO')) return 'abandonado';
  if (rec === 'SECO SEM INDÍCIOS') return 'seco';
  if (rec.includes('INDÍCIOS')) return rec.includes('PETRÓLEO') ? 'indicio' : 'gas';
  if (rec.includes('GÁS') && !rec.includes('PETRÓLEO')) return 'gas';
  if (rec.includes('PRODUTOR') || rec.includes('PORTADOR') || rec.includes('DESCOBRIDOR') || rec.includes('EXTENSÃO')) {
    return sitAbandoned ? 'abandonado' : 'producao';
  }
  if (sit === 'PRODUZINDO') return 'producao';
  if (sit === 'INJETANDO') return 'injecao';
  if (sitAbandoned) return 'abandonado';
  return 'indefinido';
}

// Um desenho por situação, todos no mesmo viewBox 16×16 (assim o mesmo
// iconAnchor serve pra todos). Vocabulário de símbolo de poço mais comum em
// mapas de E&P (o mesmo círculo/triângulo/quadrado usado pelos basemaps de
// agências como a Texas RRC e a Colorado COGCC, e pelo estilo "Petroleum"
// do ArcGIS) em vez de pictogramas desenhados — mais reconhecível pra quem
// já viu um mapa de poços antes, e mais simples de manter legível pequeno:
// círculo = óleo, triângulo = gás, quadrado = injeção, vazio = não achou
// nada (seco) ou achou pela metade (indício), X = abandonado.
const WELL_SHAPES = {
  producao: (c) => `
    <circle cx="8" cy="8" r="5.4" fill="${c}" stroke="#0b0d10" stroke-width="1.4"/>`,
  gas: (c) => `
    <path d="M8 2 L13.7 12.6 L2.3 12.6 Z" fill="${c}" stroke="#0b0d10" stroke-width="1.4" stroke-linejoin="round"/>`,
  injecao: (c) => `
    <rect x="3" y="3" width="10" height="10" fill="${c}" stroke="#0b0d10" stroke-width="1.4"/>`,
  indicio: (c) => `
    <circle cx="8" cy="8" r="5.4" fill="none" stroke="#0b0d10" stroke-width="1.4"/>
    <path d="M8 2.6 A5.4 5.4 0 0 0 8 13.4 Z" fill="${c}"/>`,
  seco: (c) => `
    <circle cx="8" cy="8" r="4.2" fill="none" stroke="#0b0d10" stroke-width="1.6"/>
    <circle cx="8" cy="8" r="4.2" fill="none" stroke="${c}" stroke-width="0.9"/>`,
  abandonado: (c) => `
    <circle cx="8" cy="8" r="5.4" fill="none" stroke="#0b0d10" stroke-width="1.4"/>
    <path d="M5 5 L11 11 M11 5 L5 11" stroke="#0b0d10" stroke-width="2.4" stroke-linecap="round"/>
    <path d="M5 5 L11 11 M11 5 L5 11" stroke="${c}" stroke-width="1.3" stroke-linecap="round"/>`,
  indefinido: (c) => `
    <circle cx="8" cy="8" r="2.6" fill="${c}" stroke="#0b0d10" stroke-width="1" fill-opacity="0.55"/>`,
};

// Ícone de poço no mapa: uma silhueta por situação (ver WELL_SHAPES e
// wellCategory), como divIcon do Leaflet (contorno escuro pra destacar
// tanto sobre o tile escuro quanto sobre o preenchimento colorido do
// polígono). Pequeno de propósito: contratos densos (Búzios chega a 137
// marcadores) já ficam cheios mesmo assim — um ícone maior só empilharia
// mais um em cima do outro.
// Anel tracejado laranja em volta do símbolo normal — não troca o símbolo
// (a categoria do poço continua valendo), só avisa que ele fica numa Área
// Não Concedida (AnC): a ANP ainda não deu um nome/contrato formal a essa
// área específica, então ela não tem polígono nenhum no mapa (ver
// CAMPOS_CONTEXTO_ALIASES em build_pocos.py) — o anel é a única pista
// visual de que aquele ponto está fora de qualquer contorno desenhado.
const ANC_RING_COLOR = '#e8a33d';

function wellDivIcon(color, category, anc) {
  const shape = WELL_SHAPES[category] || WELL_SHAPES.indefinido;
  const ring = anc ? `<circle cx="8" cy="8" r="7.2" fill="none" stroke="${ANC_RING_COLOR}" stroke-width="1.1" stroke-dasharray="2 1.4"/>` : '';
  return L.divIcon({
    className: 'map-well-icon',
    html: `<svg viewBox="0 0 16 16" width="13" height="13" style="filter:drop-shadow(0 1px 1px rgba(0,0,0,0.7))">${shape(color)}${ring}</svg>`,
    iconSize: [13, 13],
    iconAnchor: [6.5, 6.5],
  });
}

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

// Ano (número) de uma data ISO "AAAA-MM-DD", ou null se não houver data —
// usado pelo filtro de ano (ver applyYearFilter).
function yearOf(iso) {
  if (!iso) return null;
  const y = parseInt(String(iso).slice(0, 4), 10);
  return Number.isFinite(y) ? y : null;
}

// Ano do contrato de um projeto: o marco mais antigo com icon 'contract'
// na workstream "Marcos do Contrato" (normalmente "Leilão", às vezes só
// "Assinatura" quando não há leilão distinto) — os 29 projetos têm essa
// workstream, então cobre até os 8 sem poligonal na ANP. null se por
// algum motivo não achar nenhum marco de contrato.
function projectContractYear(project) {
  for (const ws of project.workstreams) {
    if (ws.name !== 'Marcos do Contrato') continue;
    const years = ws.items
      .filter((item) => item.type === 'milestone' && item.icon === 'contract')
      .map((item) => yearOf(item.date))
      .filter((y) => y != null);
    if (years.length) return Math.min(...years);
  }
  return null;
}

// Todo marcador de poço colocado no mapa (ver addWellMarker) entra aqui
// junto com o ano do poço mais antigo que ele representa — é o que
// applyYearFilter usa pra decidir mostrar/esconder cada um.
const wellMarkerRegistry = [];
function registerWellMarker(marker, targetLayer, year) {
  wellMarkerRegistry.push({ marker, targetLayer, year });
}

// Ano do contrato de cada projeto, por id — calculado uma vez em init()
// (ver projectContractYear) e consultado por applyYearFilter a cada
// movimento do slider, sem recalcular toda vez.
const projectYearById = {};

// Intervalo [min, max] e valor atual do filtro de ano — null até init()
// carregar os dados e calcular o intervalo real (ver o fim de init()); até
// lá o filtro fica inativo (tudo visível). yearFilterValue começa igual a
// yearFilterMax: nada fica escondido até o usuário mexer no slider.
let yearFilterMin = null;
let yearFilterMax = null;
let yearFilterValue = null;

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
let outrosPocos = [];

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
  const ancNote = w.anc
    ? '<p class="map-popup-source">Registrado numa Área Não Concedida (AnC) — sem contrato/nome formal específico ainda no cadastro da ANP.</p>'
    : '';
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
    ${ancNote}
    <p class="map-popup-source">Fonte: ANP/BDEP — cadastro de poços</p>
  </div>`;
}

function addWellMarker(targetLayer, latlng, color, entries) {
  const first = entries[0];
  const anc = !!(first.info && first.info.anc);
  const marker = L.marker(latlng, { icon: wellDivIcon(color, wellCategory(first.info), anc), zIndexOffset: 500 });
  const when = first.date ? formatBR(first.date) : '';
  const extra = entries.length > 1 ? `<br>+ ${entries.length - 1} poço(s) no mesmo ponto` : '';
  const ancNote = anc ? '<br>Área não concedida (AnC)' : '';
  marker.bindTooltip(
    `${escapeHtml(first.label)}${when ? '<br>' + when : ''}${first.approx ? ' (aprox.)' : ''}${extra}${ancNote}`,
    { direction: 'top', offset: [0, -6], className: 'map-well-tooltip' },
  );
  if (first.info) marker.bindPopup(wellPopupHTML(first.label, first.info, color, entries.slice(1)));
  targetLayer.addLayer(marker);
  const years = entries.map((e) => yearOf(e.date)).filter((y) => y != null);
  registerWellMarker(marker, targetLayer, years.length ? Math.min(...years) : null);
}

// Monta e adiciona (direto em targetLayer — a mesma camada do polígono do
// contrato, ou presaltFieldsLayer pra um campo de contexto) os marcadores
// de poço de um contrato. Todos os poços aparecem sempre, em qualquer
// zoom: mostrar tudo de uma vez é o ponto — não há mais um "zoom que
// revela". A base da ANP manda na posição e nas informações; quando o
// poço também é um marco do roadmap, o rótulo curado do marco prevalece —
// é ele que conta o resultado ("descoberta", "poço seco", "sem indícios
// de pré-sal"). Marco sem correspondente na base (só o poço previsto do
// Tupinambá hoje) entra pelo fallback: posição real se tiver coords,
// senão uma aproximação dentro do polígono do contrato, espalhada em
// círculo pra não empilhar e deslocada pro sul do centro, que é onde o
// popup do contrato abre.
function buildWellMarkers(key, project, bounds, color, targetLayer) {
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

  if (!cells.size) return false;
  for (const cell of cells.values()) addWellMarker(targetLayer, cell.latlng, color, cell.entries);
  return true;
}

// refBounds por contrato sem poligonal na ANP (ver PROJECTS_WITHOUT_SHAPE):
// única forma de flyToProject saber pra onde voar quando não há polígono.
const wellRefBoundsByProjectId = {};

function wellsOnlyBounds(key, project) {
  const coords = (pocosData[key] || []).map((w) => w.c)
    .concat(project ? wellItemsOf(project).filter((i) => i.coords).map((i) => i.coords) : []);
  if (!coords.length) return null;
  const b = L.latLngBounds(coords);
  const p = WELL_ONLY_BOUNDS_PAD;
  return L.latLngBounds([b.getSouth() - p, b.getWest() - p], [b.getNorth() + p, b.getEast() + p]);
}

// A visibilidade dos marcadores é toda controlada pelo targetLayer (toggle
// de grupo + zoom, ver updateWellsVisibility) — só guardamos, à parte, a
// área de referência de um contrato sem poligonal, pro caso de precisar
// voar até ele sem um polígono pra enquadrar (ver flyToProject).
function registerWellSet(key, project, bounds, color, targetLayer) {
  const built = buildWellMarkers(key, project, bounds, color, targetLayer);
  if (!built || !project || bounds) return;
  const refBounds = wellsOnlyBounds(key, project);
  if (refBounds) wellRefBoundsByProjectId[project.id] = refBounds;
}

// Poço genérico da base ANP/BDEP sem vínculo com nenhum dos 24
// contratos/campos nomeados, mas com pré-sal confirmado pela ANP — "todos
// os poços do pré-sal" (ver campo "outros" em data/pocos.json, filtrado em
// build_pocos.py). Mesmo ícone dos poços nomeados, numa cor neutra — só
// não tem rótulo curado (nesse volume não há marco de roadmap pra casar).
const OUTROS_POCOS_COLOR = '#9099a8';
function addOutrosPocoMarker(targetLayer, w) {
  addWellMarker(targetLayer, w.c, OUTROS_POCOS_COLOR, [{ label: w.n, info: w, date: w.d, approx: false }]);
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
  // Legenda discreta e sempre visível dos tipos de poço — fora do painel
  // "Camadas" (que começa recolhido, ver panelCollapsed), pra quem só
  // quer lembrar o que cada ícone significa sem abrir o painel inteiro.
  document.getElementById('mapWellLegendFixed').appendChild(buildWellShapeLegend());

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
    const pocosJson = await (await fetch(POCOS_URL)).json();
    pocosData = pocosJson.pocos || {};
    outrosPocos = pocosJson.outros || [];
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
      registerWellSet(feat.properties.nome, null, layer.getBounds(), PRESALT_FIELD_STYLE.color, wellPresaltLayer);
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
    // autoPan desligado: o popup já abre ancorado na borda norte do bloco
    // (ver anchor em flyToProject) bem longe de onde ele tamparia os
    // poços — o auto-pan do Leaflet, se ligado, iria "corrigir" isso
    // puxando o mapa de volta pra baixo do popup, exatamente pra cima dos
    // poços que acabaram de ser revelados.
    layer.eachLayer((l) => l.bindPopup(popupHTML(project, feat.properties), { autoPan: false }));
    const target = groupLayers[project.group] || groupLayers[GROUP_FALLBACK];
    layer.addTo(target);
    layerByProjectId[project.id] = layer;
    allBounds.push(bounds);

    projectLabelByProjectId[project.id] = L.marker(bounds.getCenter(), {
      icon: L.divIcon({
        className: 'map-project-label-icon',
        html: `<span class="map-project-label">${escapeHtml(project.name)}</span>`,
        iconSize: null,
      }),
      interactive: false,
      keyboard: false,
      zIndexOffset: -100,
    });
  }
  for (const project of state.projects) projectYearById[project.id] = projectContractYear(project);

  // Poços de TODOS os contratos que tenham poço cadastrado — inclusive os
  // campos em produção (Búzios, Mero/Libra, Bacalhau/Norte de Carcará…) e
  // os 8 sem poligonal na ANP (blocos devolvidos e Sul de Gato do Mato),
  // que ficavam completamente fora do mapa: com a coordenada real de cada
  // poço, o polígono deixou de ser necessário pra posicioná-los. Vão pra
  // wellGroupLayers[grupo do projeto] — separado do groupLayers do
  // polígono porque a visibilidade destes também depende do zoom (ver
  // updateWellsVisibility), diferente do polígono, que fica sempre visível.
  for (const project of state.projects) {
    const layer = layerByProjectId[project.id];
    const targetLayer = wellGroupLayers[project.group] || wellGroupLayers[GROUP_FALLBACK];
    registerWellSet(project.name, project, layer ? layer.getBounds() : null, project.color, targetLayer);
  }

  // "Todos os poços do pré-sal": todo poço offshore de Santos/Campos que
  // não é de nenhum dos 24 contratos/campos acima (ver scripts/build_pocos.py)
  // — pontos genéricos, sem o casamento com marco do roadmap dos outros.
  for (const w of outrosPocos) addOutrosPocoMarker(outrosPocosLayer, w);

  if (allBounds.length) {
    let bounds = allBounds[0];
    for (const b of allBounds.slice(1)) bounds = bounds.extend(b);
    map.fitBounds(bounds, { padding: [24, 24] });
  }

  map.on('zoomend', updateWellsVisibility);
  updateWellsVisibility();

  const years = [
    ...Object.values(projectYearById),
    ...wellMarkerRegistry.map((e) => e.year),
  ].filter((y) => y != null);
  if (years.length) {
    yearFilterMin = Math.min(...years);
    yearFilterMax = Math.max(...years);
    yearFilterValue = yearFilterMax;
  }

  renderPanel();
}

// Esconde contrato/poço com data depois do ano escolhido no slider — "como
// era o mapa até esse ano". Sem data conhecida (poço sem data no cadastro,
// ou projeto sem marco de contrato reconhecido) sempre aparece: melhor
// mostrar de mais do que esconder por engano algo que não sabemos datar.
function applyYearFilter() {
  if (yearFilterValue == null) return;
  for (const project of state.projects) {
    const layer = layerByProjectId[project.id];
    if (!layer) continue;
    const year = projectYearById[project.id];
    const target = groupLayers[project.group] || groupLayers[GROUP_FALLBACK];
    const visible = year == null || year <= yearFilterValue;
    if (visible && !target.hasLayer(layer)) target.addLayer(layer);
    else if (!visible && target.hasLayer(layer)) target.removeLayer(layer);
  }
  for (const entry of wellMarkerRegistry) {
    const visible = entry.year == null || entry.year <= yearFilterValue;
    if (visible && !entry.targetLayer.hasLayer(entry.marker)) entry.targetLayer.addLayer(entry.marker);
    else if (!visible && entry.targetLayer.hasLayer(entry.marker)) entry.targetLayer.removeLayer(entry.marker);
  }
  updateProjectLabels();
}

function setColorMode(mode) {
  colorMode = mode;
  for (const project of state.projects) {
    const layer = layerByProjectId[project.id];
    if (!layer) continue;
    const c = colorForProject(project);
    layer.setStyle({ color: c, fillColor: c });
    const feat = featureByProject[project.name];
    if (feat) layer.eachLayer((l) => l.bindPopup(popupHTML(project, feat.properties), { autoPan: false }));
  }
  renderPanel();
}

// Basta enquadrar o alvo (como flyToBounds faria): focar um contrato
// específico sempre passa do zoom mínimo dos poços (ver wellsMinZoom),
// então não precisa de nenhum ajuste extra pra garantir que eles apareçam
// — a menos que o usuário tenha subido o slider além do zoom do próprio
// contrato, caso em que nem voar resolve (fica assim mesmo).
function flyToProject(project) {
  const layer = layerByProjectId[project.id];
  if (layer) {
    const bounds = layer.getBounds();
    // Ancorado na borda norte, não no centro: um popup no meio do bloco
    // tamparia poços que estejam por ali (o balão do Leaflet sobe a partir
    // do ponto).
    const anchor = L.latLng(bounds.getNorth(), bounds.getCenter().lng);
    // Filtro de ano pode ter tirado esse polígono do grupo (ver
    // applyYearFilter) — abrir popup nele daria um marcador fantasma sem
    // contorno visível, então só avisa em vez de tentar.
    const target = groupLayers[project.group] || groupLayers[GROUP_FALLBACK];
    if (target.hasLayer(layer)) {
      map.once('moveend', () => layer.eachLayer((l) => l.openPopup(anchor)));
    } else {
      showToast(`"${project.name}" está fora do filtro de ano atual (Controles → Mostrar até o ano).`);
    }
    map.flyToBounds(bounds, { padding: [40, 40], duration: 0.6 });
    return;
  }
  // Sem poligonal, mas com poços cadastrados: vale a pena voar até eles em
  // vez de só avisar que não há shapefile.
  const refBounds = wellRefBoundsByProjectId[project.id];
  if (refBounds) {
    showToast(`Sem poligonal para "${project.name}" (${PROJECTS_WITHOUT_SHAPE[project.name] || 'não encontrada nos shapefiles fornecidos.'}) — mostrando os poços do contrato.`);
    map.flyToBounds(refBounds, { padding: [40, 40], duration: 0.6 });
    return;
  }
  showToast(`Sem poligonal para "${project.name}": ${PROJECTS_WITHOUT_SHAPE[project.name] || 'não encontrada nos shapefiles fornecidos.'}`);
}

function toggleGroup(groupId, visible) {
  groupVisible[groupId] = visible;
  const layer = groupLayers[groupId];
  if (visible) map.addLayer(layer);
  else map.removeLayer(layer);
  updateWellsVisibility();
}

function togglePresaltFields(visible) {
  presaltFieldsVisible = visible;
  if (visible) map.addLayer(presaltFieldsLayer);
  else map.removeLayer(presaltFieldsLayer);
  updateWellsVisibility();
}

function toggleOutrosPocos(visible) {
  outrosPocosVisible = visible;
  updateWellsVisibility();
}

// Um único lugar decidindo a visibilidade de TODO poço no mapa — nomeado
// ou genérico —, com a mesma regra pros dois: zoom >= wellsMinZoom E a
// camada correspondente ligada no painel (grupo do contrato, campos de
// contexto, ou "todos os poços do pré-sal"). O polígono do contrato não
// entra aqui — esse continua visível em qualquer zoom (o filtro de ano,
// não o de zoom, é quem decide se ele aparece — ver applyYearFilter).
function showOrHide(layer, visible) {
  const shown = map.hasLayer(layer);
  if (visible && !shown) map.addLayer(layer);
  else if (!visible && shown) map.removeLayer(layer);
}

function updateWellsVisibility() {
  const zoomOk = map.getZoom() >= wellsMinZoom;
  for (const g of GROUP_DEFS) showOrHide(wellGroupLayers[g.id], zoomOk && groupVisible[g.id]);
  showOrHide(wellPresaltLayer, zoomOk && presaltFieldsVisible);
  showOrHide(outrosPocosLayer, zoomOk && outrosPocosVisible);
  updateProjectLabels();
}

// Nome do projeto sobre o polígono só no zoom em que os poços ainda não
// aparecem (zoom < wellsMinZoom — o oposto exato da regra de
// updateWellsVisibility acima): é o zoom em que só dá pra distinguir os
// polígonos coloridos clicando um por um, sem essa pista. Some assim que
// os poços entram, pra não sobrepor o rótulo aos marcadores. Respeita o
// grupo (Exploração/Produção/Devolvidos) ligado/desligado e o filtro de
// ano — usa target.hasLayer(layer) como fonte da verdade de se o
// polígono está mesmo visível agora (já calculado por applyYearFilter),
// em vez de duplicar aquela lógica aqui.
function updateProjectLabels() {
  const zoomOk = map.getZoom() < wellsMinZoom;
  for (const project of state.projects) {
    const marker = projectLabelByProjectId[project.id];
    const layer = layerByProjectId[project.id];
    if (!marker || !layer) continue;
    const groupId = groupLayers[project.group] ? project.group : GROUP_FALLBACK;
    const target = groupLayers[groupId];
    showOrHide(marker, zoomOk && groupVisible[groupId] && target.hasLayer(layer));
  }
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

function buildSliderRow(labelText, valueText, min, max, value, step, onInput) {
  const row = document.createElement('div');
  row.className = 'map-slider-row';
  const label = document.createElement('div');
  label.className = 'map-slider-label';
  const nameEl = document.createElement('span');
  nameEl.textContent = labelText;
  const valueEl = document.createElement('span');
  valueEl.textContent = valueText;
  label.appendChild(nameEl);
  label.appendChild(valueEl);
  row.appendChild(label);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener('input', () => onInput(Number(input.value), valueEl));
  row.appendChild(input);
  return row;
}

// "Controles": dois sliders independentes — zoom mínimo dos poços (sempre
// disponível) e ano do filtro (só depois que init() calcular o intervalo
// real a partir dos dados — ver yearFilterMin/Max no fim de init()).
function renderControlsSection(container) {
  const wrap = document.createElement('div');
  wrap.className = 'map-panel-section';
  const label = document.createElement('div');
  label.className = 'map-mode-label';
  label.textContent = 'Controles';
  wrap.appendChild(label);

  wrap.appendChild(buildSliderRow(
    'Zoom mínimo dos poços', String(wellsMinZoom),
    WELLS_MIN_ZOOM_RANGE[0], WELLS_MIN_ZOOM_RANGE[1], wellsMinZoom, 1,
    (value, valueEl) => {
      wellsMinZoom = value;
      valueEl.textContent = String(value);
      updateWellsVisibility();
    },
  ));

  if (yearFilterMin != null && yearFilterMax != null) {
    if (yearFilterMin === yearFilterMax) {
      const note = document.createElement('p');
      note.className = 'map-panel-note';
      note.textContent = `Todos os dados são de ${yearFilterMin} — nada pra filtrar por ano.`;
      wrap.appendChild(note);
    } else {
      wrap.appendChild(buildSliderRow(
        'Mostrar até o ano', String(yearFilterValue),
        yearFilterMin, yearFilterMax, yearFilterValue, 1,
        (value, valueEl) => {
          yearFilterValue = value;
          valueEl.textContent = String(value);
          applyYearFilter();
        },
      ));
      const note = document.createElement('p');
      note.className = 'map-panel-note';
      note.style.marginTop = '0';
      note.textContent = 'Esconde contrato (pelo ano do leilão) e poço (pelo ano de conclusão) mais recente que o ano escolhido. Sem data conhecida, sempre aparece.';
      wrap.appendChild(note);
    }
  }

  container.appendChild(wrap);
}

// Ordem de exibição na legenda — do resultado mais positivo (achou e
// produz) ao mais neutro (sem registro), agrupando injeção/abandonado
// (intervenção/descontinuado) no meio.
const WELL_CATEGORY_LABELS = [
  ['producao', 'Produção (óleo)'],
  ['gas', 'Produção/indício de gás'],
  ['indicio', 'Indício de óleo (poço seco)'],
  ['seco', 'Seco, sem indícios'],
  ['injecao', 'Injeção (água, vapor ou gás)'],
  ['abandonado', 'Abandonado'],
  ['indefinido', 'Sem resultado registrado'],
];
const WELL_LEGEND_COLOR = '#c7cad1';

function buildWellShapeLegend() {
  const legend = document.createElement('div');
  legend.className = 'map-legend';
  for (const [category, label] of WELL_CATEGORY_LABELS) {
    const row = document.createElement('div');
    row.className = 'map-legend-row';
    const icon = document.createElement('span');
    icon.className = 'map-legend-well-icon';
    icon.innerHTML = `<svg viewBox="0 0 16 16" width="15" height="15">${WELL_SHAPES[category](WELL_LEGEND_COLOR)}</svg>`;
    row.appendChild(icon);
    row.appendChild(document.createTextNode(label));
    legend.appendChild(row);
  }
  const ancRow = document.createElement('div');
  ancRow.className = 'map-legend-row';
  const ancIcon = document.createElement('span');
  ancIcon.className = 'map-legend-well-icon';
  ancIcon.innerHTML = `<svg viewBox="0 0 16 16" width="15" height="15">${WELL_SHAPES.indefinido(WELL_LEGEND_COLOR)}<circle cx="8" cy="8" r="7.2" fill="none" stroke="${ANC_RING_COLOR}" stroke-width="1.1" stroke-dasharray="2 1.4"/></svg>`;
  ancRow.appendChild(ancIcon);
  ancRow.appendChild(document.createTextNode('Anel laranja: área não concedida (AnC), sem contrato formal'));
  legend.appendChild(ancRow);
  return legend;
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
// pra não reabrir/refechar o painel sozinho toda vez que o usuário interage
// com ele. Começa fechado: o mapa é o conteúdo principal da página, e o
// painel (com a lista dos 29 contratos) tampava boa parte dele logo na
// abertura — melhor deixar o usuário abrir quando quiser mexer nas camadas.
let panelCollapsed = true;

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
  renderControlsSection(el);

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

  const outrosSection = document.createElement('div');
  outrosSection.className = 'map-panel-section';
  const outrosHeader = document.createElement('label');
  outrosHeader.className = 'map-panel-group-header';
  const outrosCheckbox = document.createElement('input');
  outrosCheckbox.type = 'checkbox';
  outrosCheckbox.checked = outrosPocosVisible;
  outrosCheckbox.addEventListener('change', () => toggleOutrosPocos(outrosCheckbox.checked));
  outrosHeader.appendChild(outrosCheckbox);
  outrosHeader.appendChild(document.createTextNode(` Todos os poços do pré-sal (${outrosPocos.length})`));
  outrosSection.appendChild(outrosHeader);
  const outrosNote = document.createElement('p');
  outrosNote.className = 'map-panel-note';
  outrosNote.style.marginTop = '0';
  outrosNote.textContent = 'Poços com pré-sal confirmado pela ANP, fora dos contratos rastreados (pontos cinza).';
  outrosSection.appendChild(outrosNote);
  el.appendChild(outrosSection);

  const shapeSection = document.createElement('div');
  shapeSection.className = 'map-panel-section';
  const shapeHeader = document.createElement('div');
  shapeHeader.className = 'map-mode-label';
  shapeHeader.textContent = 'Situação do poço';
  shapeSection.appendChild(shapeHeader);
  shapeSection.appendChild(buildWellShapeLegend());
  el.appendChild(shapeSection);

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
  wellsNote.textContent = 'Poços (de qualquer camada) só aparecem a partir de um zoom intermediário, pra não poluir a visão geral — o polígono do contrato continua visível em qualquer zoom.';
  el.appendChild(wellsNote);

  const missingCount = Object.keys(PROJECTS_WITHOUT_SHAPE).length;
  const note = document.createElement('p');
  note.className = 'map-panel-note';
  note.textContent = `${missingCount} projeto(s) sem poligonal disponível nos shapefiles da ANP fornecidos (clique no nome pra ver o motivo e ir até os poços).`;
  el.appendChild(note);
}

init();
