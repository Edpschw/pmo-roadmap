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
// dos 30 projetos rastreados no roadmap — só pra dar noção de onde eles
// ficam em relação aos que rastreamos. Ver comentário em cima de
// EXTRA_PRESALT_FIELDS no script de geração para a lista e os critérios.
const PRESALT_FIELDS_URL = 'data/campos_presal.geojson';
const PRESALT_FIELD_STYLE = { color: '#9aa1ac', weight: 1.25, dashArray: '4 3', fillColor: '#9aa1ac', fillOpacity: 0.1 };

// Sumários executivos de Plano de Desenvolvimento (ANP) — só o sumário é
// público (Decreto 7.724/2012, art. 5º §2º: o PD completo dá vantagem
// competitiva a outros agentes, então fica restrito). Chave = nome do
// projeto rastreado (ex. "Búzios", "Libra") OU nome do campo de contexto
// (ex. "MERO", "SAPINHOÁ") — um mesmo campo pode ter os dois quando o
// projeto rastreado é o bloco/contrato (maior) e o campo de contexto é só
// a área do reservatório em si (menor); os dois usam a mesma entrada.
const PD_URL = 'data/planos_desenvolvimento.json';

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

// Todo popup (projeto, campo de contexto, poço) abre ancorado num ponto
// fixo e cresce PRA CIMA a partir dele (o triângulo de baixo aponta pro
// ponto) — com autoPan desligado de propósito em todo lugar que chama
// bindPopup (não pode mudar zoom/posição do mapa ao abrir, ver nota em
// popupHTML), um popup alto o bastante simplesmente vazava por cima da
// tela quando o ponto de ancoragem já estava perto do topo (comum logo
// depois de flyToProject, ancorado na borda norte do polígono). Um
// max-height fixo (ver CSS) não resolve isso: o espaço disponível ACIMA
// do ponto varia por popup, não por conteúdo. Aqui, a cada abertura, mede
// esse espaço de verdade (em pixels de tela, não de mapa) e limita a
// altura do conteúdo a ele — sobra rolagem interna em vez de vazamento.
map.on('popupopen', (e) => {
  const popup = e.popup;
  const content = popup.getElement() && popup.getElement().querySelector('.leaflet-popup-content');
  if (!content) return;
  const anchorY = map.latLngToContainerPoint(popup.getLatLng()).y;
  // Sobra de "moldura" do popup que não é o conteúdo em si (a margem de
  // 13px em cima/embaixo do .leaflet-popup-content, o triângulo debaixo,
  // a folga do wrapper) — sem descontar isso, o cálculo só olhando pro
  // conteúdo deixa a moldura inteira vazar por cima mesmo com a altura
  // "certa": ~13+13px de margem + ~20px de triângulo/wrapper.
  const chrome = 50;
  const margin = 16;
  content.style.maxHeight = Math.max(90, Math.round(anchorY - chrome - margin)) + 'px';
  popup.update();
});

// Adicionadas antes das camadas de projeto para ficarem visualmente por
// baixo delas (Leaflet empilha na ordem de addTo).
const presaltFieldsLayer = L.layerGroup().addTo(map);
let presaltFieldsVisible = true;
// Rótulo do nome de cada campo de contexto (ver laço em init()) — mesmo
// padrão do rótulo de projeto rastreado (projectLabelByProjectId), mas
// visibilidade segue presaltFieldsLayer (ver updateProjectLabels), não um
// grupo de projeto: campo de contexto não tem grupo nem projeto por trás.
const presaltFieldLabelMarkers = [];
// Campo de contexto colorido como um projeto rastreado por citar o mesmo
// PD (ver linkedProjectByFonte em init()) — guardado à parte (não em
// layerByProjectId, que é só pros 30 projetos) pra setColorMode saber
// repintar também quando o modo de cor muda.
const linkedPresaltLayers = [];
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
const WELLS_MIN_ZOOM_DEFAULT = 10;
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

// Nome de campo de contexto vem TUDO MAIÚSCULO no GeoJSON (MERO, SAPINHOÁ,
// OESTE DE ATAPU...) — certo pra distinguir de contrato rastreado nas
// tabelas/listas (convenção mantida em analises.js/pocos.js), mas errado
// no rótulo do mapa (ver presaltFieldLabelMarkers/projectLabelByProjectId),
// que é sempre Título Case ("Norte de Carcará") — só o rótulo do mapa usa
// isto, popup/tabela continuam mostrando o nome como veio da fonte.
const TITLE_CASE_LOWERCASE_WORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);
function titleCasePt(name) {
  return name.split(' ').map((word, i) => {
    const lower = word.toLowerCase();
    return i > 0 && TITLE_CASE_LOWERCASE_WORDS.has(lower) ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join(' ');
}

function formatAnpDate(s) {
  return s ? s.replaceAll('-', '/') : '—';
}

// escapeHtml vem de shared.js (compartilhada com app.js e analises.js).

function colorForProject(project) {
  if (colorMode === 'status') return GROUP_COLORS[project.group] || '#5c6470';
  if (colorMode === 'rodada') {
    const feat = featureByProject[project.name];
    const rodada = feat && feat.properties.rodada;
    return (rodada && rodadaColorMap[rodada]) || '#5c6470';
  }
  return project.color;
}

// Nome de exibição no mapa (rótulo sobre o polígono + título do popup)
// quando difere do nome do contrato — hoje só Norte de Carcará: o nome do
// CONTRATO não diz nada sobre a jazida (Bacalhau), mas o CAMPO da metade
// norte (BACALHAU NORTE, ver props.campos) sim, e é o mesmo nome que já
// aparece no campo de contexto ligado (BACALHAU, a metade sul — ver
// projectByPdFonte). O nome do contrato passa a aparecer como informação
// ("Contrato: ...") dentro do popup, não mais no título.
const MAP_DISPLAY_NAME_OVERRIDE = {
  'Norte de Carcará': 'Bacalhau Norte',
};
function mapDisplayName(project) {
  return MAP_DISPLAY_NAME_OVERRIDE[project.name] || project.name;
}

// HTML de cada selo (operador + parceiros do PD, ver companyBadgesFor em
// shared.js), sem o <div> em volta — a mesma lista de <span> alimenta
// tanto o popup (companyBadgesHTML, key = nome usado em pdSectionHTML)
// quanto o rótulo sobre o polígono (mapLabelBadgesHTML). key é o nome
// usado pra procurar o PD (pdData). String vazia sem operador nem
// parceiros (ex.: PD ainda não carregou).
function companyBadgeItemsHTML(operadorRaw, key) {
  const pd = byNameOrUpper(pdData, key);
  const badges = companyBadgesFor(operadorRaw, pd ? pd.participacao : null);
  return badges.map((b) => {
    const isOp = b.role === 'operador';
    const title = `${b.name}${isOp ? ' (operador)' : b.pct != null ? ` — ${b.pct.toLocaleString('pt-BR')}%` : ''}`;
    if (b.logo) {
      return `<span class="company-logo-chip ${isOp ? 'company-logo-chip-operador' : 'company-logo-chip-parceiro'}" title="${escapeHtml(title)}"><img src="${escapeHtml(b.logo)}" alt="${escapeHtml(b.name)}"/></span>`;
    }
    return `<span class="company-badge ${isOp ? 'company-badge-operador' : 'company-badge-parceiro'}" style="background:${b.color}" title="${escapeHtml(title)}">${escapeHtml(b.initials)}</span>`;
  }).join('');
}

function companyBadgesHTML(operadorRaw, key) {
  const items = companyBadgeItemsHTML(operadorRaw, key);
  if (!items) return '';
  return `<div class="map-popup-badges">${items}</div>`;
}

// Mesmos selos, agora pro rótulo fixo sobre o polígono (não só no popup) —
// ver projectLabelByProjectId/presaltFieldLabelMarkers mais abaixo.
function mapLabelBadgesHTML(operadorRaw, key) {
  const items = companyBadgeItemsHTML(operadorRaw, key);
  if (!items) return '';
  return `<div class="map-label-badges">${items}</div>`;
}

function popupHTML(project, props) {
  const groupLabel = (GROUP_DEFS.find((g) => g.id === project.group) || {}).label || project.group;
  const displayName = mapDisplayName(project);
  const renamed = displayName !== project.name;
  // Contrato de partilha por trás do projeto — normalmente o próprio
  // project.name, mas nem sempre (Mero cita "Libra", ver
  // projectContractName em shared.js: mesmo Leilão/Assinatura dos dois,
  // sem PD próprio pra Libra que permita derivar isso de outro jeito).
  // Independente de "renamed" (que só decide o TÍTULO do popup) — Mero
  // não tem o título trocado, mas ainda ganha a linha "Contrato".
  const contractName = projectContractName(project.name);
  const rows = [
    ['Grupo', groupLabel],
  ];
  if (contractName !== displayName) rows.push(['Contrato', contractName]);
  rows.push(['Bacia', props.bacia || '—'], ['Operador', props.operador || '—'], ['Rodada', props.rodada || '—']);
  if (props.fonte === 'bloco_exploratorio') {
    rows.push(['Assinatura', formatAnpDate(props.assinatura)]);
  } else {
    // Campo(s) ANP só entra quando ainda acrescenta informação — quando o
    // nome já virou o título (ver mapDisplayName), citá-lo nas duas linhas
    // é redundante.
    if (!renamed) rows.push(['Campo(s) ANP', props.campos || '—']);
    rows.push(['Início produção', formatAnpDate(props.inicio_producao)]);
  }
  rows.push(['Área', props.area_km2 ? Math.round(props.area_km2).toLocaleString('pt-BR') + ' km²' : '—']);
  const rowsHTML = rows.map(([k, v]) => `<tr><td class="k">${k}</td><td>${v}</td></tr>`).join('');
  return `<div class="map-popup">
    <h3 style="color:${colorForProject(project)}">${escapeHtml(displayName)}</h3>
    ${companyBadgesHTML(props.operador, project.name)}
    <table>${rowsHTML}</table>
    <p class="map-popup-source">Fonte: ANP — ${props.fonte === 'bloco_exploratorio' ? 'Blocos Exploratórios sob Contrato' : 'Campos de Produção'} (SIRGAS 2000)</p>
    ${pdSectionHTML(project.name)}
  </div>`;
}

// wellCategory (classifica um poço da base ANP/BDEP numa das situações que
// o mapa desenha com ícone próprio, ver WELL_SHAPES) agora vive em
// shared.js, compartilhada com app.js e analises.js.

// Um desenho por situação, todos no mesmo viewBox 16×16 (assim o mesmo
// iconAnchor serve pra todos). Vocabulário de símbolo de poço mais comum em
// mapas de E&P (o mesmo círculo/triângulo usado pelos basemaps de agências
// como a Texas RRC e a Colorado COGCC, e pelo estilo "Petroleum" do
// ArcGIS) em vez de pictogramas desenhados — mais reconhecível pra quem já
// viu um mapa de poços antes, e mais simples de manter legível pequeno:
// círculo = óleo, triângulo = gás, seta pra baixo = injeção (fluido volta
// pro reservatório), vazio = não achou nada (seco) ou achou pela metade
// (indício), X = abandonado.
const WELL_SHAPES = {
  producao: (c) => `
    <circle cx="8" cy="8" r="5.4" fill="${c}" stroke="#0b0d10" stroke-width="1.4"/>`,
  gas: (c) => `
    <path d="M8 2 L13.7 12.6 L2.3 12.6 Z" fill="${c}" stroke="#0b0d10" stroke-width="1.4" stroke-linejoin="round"/>`,
  injecao: (c) => `
    <path d="M6.2 2.2H9.8V7.4H12.8L8 13L3.2 7.4H6.2Z" fill="${c}" stroke="#0b0d10" stroke-width="1.4" stroke-linejoin="round"/>`,
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

// Selo no canto superior direito da seta de injeção, indicando o fluido
// injetado (os únicos dois valores de RECLASSIFICACAO observados na base
// são "INJEÇÃO DE ÁGUA" e "INJEÇÃO DE GÁS NATURAL" — ver wellInjectionType).
// Cor fixa (não a cor do projeto): assim o selo se reconhece à distância
// como "água" ou "gás" em qualquer contrato, igual o anel laranja de AnC.
const INJECTION_BADGES = {
  agua: `<path d="M13 0.6C14.6 2.9 15.5 4.5 15.5 5.7A2.5 2.5 0 1 1 10.5 5.7C10.5 4.5 11.4 2.9 13 0.6Z" fill="#3aa8ff" stroke="#0b0d10" stroke-width="0.6"/>`,
  gas: `<path d="M13.4 0.5C13.7 2.1 14.7 2.9 15.4 3.8A2.6 2.6 0 1 1 10.5 4.9C10.5 4.4 10.65 4.0 10.9 3.6C11.0 4.1 11.25 4.3 11.6 4.1C11.35 3.0 11.75 1.9 13.4 0.5Z" fill="#ff6b35" stroke="#0b0d10" stroke-width="0.6"/>`,
};

// wellInjectionType (qual fluido, pra escolher o selo em INJECTION_BADGES)
// agora vive em shared.js, compartilhada com analises.js.

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

function wellDivIcon(color, category, anc, injType) {
  const shape = WELL_SHAPES[category] || WELL_SHAPES.indefinido;
  const ring = anc ? `<circle cx="8" cy="8" r="7.2" fill="none" stroke="${ANC_RING_COLOR}" stroke-width="1.1" stroke-dasharray="2 1.4"/>` : '';
  const badge = category === 'injecao' && INJECTION_BADGES[injType] ? INJECTION_BADGES[injType] : '';
  return L.divIcon({
    className: 'map-well-icon',
    html: `<svg viewBox="0 0 16 16" width="13" height="13" style="filter:drop-shadow(0 1px 1px rgba(0,0,0,0.7))">${shape(color)}${badge}${ring}</svg>`,
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
// "Assinatura" quando não há leilão distinto) — os 30 projetos têm essa
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
// junto com o ano do poço mais antigo que ele representa, a lista de
// SITUACAO/CATEGORIA de cada poço real que ele agrupa (sits/cats — um
// marcador pode juntar vários poços do mesmo ponto, ver WELL_MERGE_GRID) —
// é o que applyWellFilters usa pra decidir mostrar/esconder cada um —, as
// entries originais (entries, nunca reordenadas — ver reorderEntriesByFilter)
// e qual delas está sendo exibida agora (primary, ver setMarkerContent).
// Marco de roadmap sem poço da ANP por trás (info null) não entra nem em
// sits nem em cats: não tem o que filtrar, então nunca é ele quem esconde
// o marcador (mesmo espírito do ano sem data — ver applyWellFilters).
const wellMarkerRegistry = [];
function registerWellMarker(marker, targetLayer, color, entries, year, sits, cats) {
  wellMarkerRegistry.push({ marker, targetLayer, color, entries, primary: entries[0], year, sits, cats });
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

// Filtro por SITUAÇÃO e CATEGORIA (campos brutos da ANP, ver wellPopupHTML)
// — dois eixos diferentes de wellCategory (que já colore/dá forma ao ícone
// a partir de RECLASSIFICACAO+SITUACAO, ver shared.js): aqui é o texto cru
// do cadastro, não o resultado apurado. Conjunto de EXCLUÍDOS (não de
// incluídos) pra o estado inicial — nada filtrado — ser um Set vazio, sem
// precisar populá-lo com todos os valores possíveis antes dos dados
// carregarem. Chave-sentinela pros ~2% dos poços sem SITUACAO no cadastro
// (nenhum poço observado está sem CATEGORIA, mas trata o caso mesmo assim).
const SIT_NONE_KEY = '(sem situação registrada)';
const CAT_NONE_KEY = '(sem categoria registrada)';
function normSit(w) { return (w && w.sit) || SIT_NONE_KEY; }
function normCat(w) { return (w && w.cat) || CAT_NONE_KEY; }
const situacaoFilterExcluded = new Set();
const categoriaFilterExcluded = new Set();
// [[valor, contagem], ...] ordenado do mais comum ao mais raro — calculado
// uma vez em init() depois que pocosData/outrosPocos carregam (ver
// computeFieldValueCounts), consultado só pra desenhar os chips do painel.
let situacaoValues = [];
let categoriaValues = [];

// Conta poços por valor normalizado (normSit ou normCat) em toda a base —
// pocosData (os 24 contratos/campos nomeados) + outrosPocos (o resto do
// play do pré-sal) — pra popular os chips do painel de filtro com a
// contagem real de cada valor.
function computeFieldValueCounts(normFn) {
  const counts = new Map();
  const bump = (w) => { const k = normFn(w); counts.set(k, (counts.get(k) || 0) + 1); };
  for (const arr of Object.values(pocosData)) for (const w of arr) bump(w);
  for (const w of outrosPocos) bump(w);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

// wellCodeOf (código do poço dentro do nome de um marco, pra casar com o
// registro da ANP) agora vive em shared.js, compartilhada com app.js e
// analises.js.

let pocosData = {};
let outrosPocos = [];
let pdData = {};

// "2015-03-10" -> "10/03/2015"; qualquer coisa que não seja uma data ISO
// completa (data parcial "2017-12", ou texto livre tipo "Previsão
// maio/2018") passa direto — nem todo campo do PD tem dia exato.
function formatMaybeISO(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? formatBR(s) : s;
}

// Bloco "Plano de Desenvolvimento" pra anexar num popup (contrato ou campo
// de contexto) — string vazia se não há sumário executivo pra essa chave,
// pra quem chama só fazer `${pdSectionHTML(key)}` sem checar antes.
function pdSectionHTML(key) {
  const pd = byNameOrUpper(pdData, key);
  if (!pd) return '';
  const rows = [
    ['Situação', pd.situacao],
    ['Resolução (PD)', pd.resolucao],
    ['Descoberta', pd.descoberta ? formatBR(pd.descoberta) + (pd.descobertaObs ? ` (${pd.descobertaObs})` : '') : null],
    ['Comercialidade', pd.comercialidade ? formatBR(pd.comercialidade) + (pd.comercialidadeObs ? ` (${pd.comercialidadeObs})` : '') : null],
    ['Início produção', formatMaybeISO(pd.inicioProducao)],
    ['Térm. previsto', formatMaybeISO(pd.previsaoTermino)],
    ['Lâmina d\'água', pd.laminaDagua],
  ];
  if (pd.pocos) {
    const p = pd.pocos;
    const parts = [];
    if (p.perfurados != null) parts.push(`${p.perfurados} perfurados`);
    if (p.produtores != null) parts.push(`${p.produtores} produtores`);
    if (p.injetores != null) parts.push(`${p.injetores} injetores`);
    if (p.abandonados != null) parts.push(`${p.abandonados} abandonados`);
    rows.push([`Poços (${p.dataRef || '—'})`, parts.join(', ') + (p.obs ? ` — ${p.obs}` : '')]);
  }
  if (pd.volumes) {
    const v = pd.volumes;
    const fmt = (n) => n.toLocaleString('pt-BR');
    if (v.oleoInSituMMbbl != null) rows.push([`STOIIP (${v.dataRef || '—'})`, `${fmt(v.oleoInSituMMbbl)} MMbbl`]);
    if (v.gasInSituMMm3 != null) rows.push([`GIIP (${v.dataRef || '—'})`, `${fmt(v.gasInSituMMm3)} MMm³`]);
    if (v.reservaProvada) {
      const r = v.reservaProvada;
      if (r.oleoMMbbl != null) rows.push([`Volume recuperável óleo (${r.dataRef || '—'})`, `${fmt(r.oleoMMbbl)} MMbbl`]);
      if (r.gasMMm3 != null) rows.push([`Volume recuperável gás (${r.dataRef || '—'})`, `${fmt(r.gasMMm3)} MMm³`]);
    }
  }
  const rowsHTML = rows.filter(([, v]) => v).map(([k, v]) => `<tr><td class="k">${k}</td><td>${escapeHtml(v)}</td></tr>`).join('');
  const participacaoHTML = pd.participacao && pd.participacao.length
    ? `<p class="map-popup-pd-text"><strong>Parceiros:</strong> ${pd.participacao.map((p) => `${escapeHtml(p.empresa)} ${p.pct.toLocaleString('pt-BR')}%`).join(' · ')}${pd.participacaoObs ? ` (${escapeHtml(pd.participacaoObs)})` : ''}</p>`
    : '';
  const composicao = jazidaComposicao(pd);
  const jazidaHTML = composicao
    ? `<p class="map-popup-pd-text"><strong>Jazida compartilhada:</strong> ${escapeHtml(composicao)}</p>`
    : '';
  return `<div class="map-popup-pd">
    <h4>Plano de Desenvolvimento${pd.titulo ? ` — ${escapeHtml(pd.titulo)}` : ''}</h4>
    <table>${rowsHTML}</table>
    ${jazidaHTML}
    ${participacaoHTML}
    ${pd.sistemaResumo ? `<p class="map-popup-pd-text"><strong>Sistema:</strong> ${escapeHtml(pd.sistemaResumo)}</p>` : ''}
    ${pd.geologiaResumo ? `<p class="map-popup-pd-text"><strong>Geologia:</strong> ${escapeHtml(pd.geologiaResumo)}</p>` : ''}
    ${pd.notaNome ? `<p class="map-popup-pd-text">${escapeHtml(pd.notaNome)}</p>` : ''}
    <p class="map-popup-source">Sumário executivo (PD completo é confidencial por lei) — <a href="${pd.fonte}" target="_blank" rel="noopener">PDF na ANP</a></p>
  </div>`;
}

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

// Ícone + tooltip + popup a partir da entrada "primária" (entries[0]) —
// extraído de addWellMarker pra ser reaproveitado também quando o filtro
// de Situação/Categoria muda (ver reorderEntriesByFilter em
// applyWellFilters): sem isso, um marcador mesclado que continuasse
// visível só por causa de um poço não-abandonado (ver sameWellhead) ficava
// com CARA de abandonado — ícone e popup do poço que o filtro tirou, que é
// quem entrou primeiro na lista — mesmo depois do usuário desmarcar
// "abandonado" no painel. Marca de novo o ícone/tooltip/popup do zero
// sempre que a entrada primária muda, não só na criação.
function setMarkerContent(marker, color, entries) {
  const first = entries[0];
  const anc = !!(first.info && first.info.anc);
  marker.setIcon(wellDivIcon(color, wellCategory(first.info), anc, wellInjectionType(first.info)));
  const when = first.date ? formatBR(first.date) : '';
  const extra = entries.length > 1 ? `<br>+ ${entries.length - 1} poço(s) no mesmo ponto` : '';
  const ancNote = anc ? '<br>Área não concedida (AnC)' : '';
  marker.setTooltipContent(
    `${escapeHtml(first.label)}${when ? '<br>' + when : ''}${first.approx ? ' (aprox.)' : ''}${extra}${ancNote}`,
  );
  marker.unbindPopup();
  if (first.info) marker.bindPopup(wellPopupHTML(first.label, first.info, color, entries.slice(1)));
}

function addWellMarker(targetLayer, latlng, color, entries) {
  const marker = L.marker(latlng, { zIndexOffset: 500 });
  marker.bindTooltip('', { direction: 'top', offset: [0, -6], className: 'map-well-tooltip' });
  setMarkerContent(marker, color, entries);
  targetLayer.addLayer(marker);
  const years = entries.map((e) => yearOf(e.date)).filter((y) => y != null);
  const infos = entries.map((e) => e.info).filter(Boolean);
  registerWellMarker(
    marker, targetLayer, color, entries, years.length ? Math.min(...years) : null,
    infos.map(normSit), infos.map(normCat),
  );
}

// Distância em metros entre duas coordenadas [lat, lng] (haversine) — usada
// só por splitCellByWellhead, pra decidir se duas entradas da mesma célula
// de WELL_MERGE_GRID são de fato o mesmo poço.
function haversineMeters(c1, c2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(c2[0] - c1[0]);
  const dLng = toRad(c2[1] - c1[1]);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(c1[0])) * Math.cos(toRad(c2[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// "7-BAC-4D-SPS" -> "BAC-4"; "3-BRSA-1216DA-SPS" -> "BRSA-1216" — código
// "base" do poço (prefixo do campo + número), sem a letra de sidetrack (D,
// DA, A, B, HP, HPA...) nem o slot inicial/UF final. Duas entradas com o
// mesmo base são perfuração original + sidetrack do mesmo poço.
const WELL_BASE_CODE_RE = /^\d+-([A-Za-z]+)-(\d+)[A-Za-z]*-[A-Za-z]+$/;
function wellBaseCode(n) {
  const m = WELL_BASE_CODE_RE.exec(n);
  return m ? `${m[1]}-${m[2]}` : n;
}

// Duas entradas caem na mesma célula da grade (~110 m, ver WELL_MERGE_GRID)
// sem necessariamente serem o mesmo poço — pode ser só coincidência de dois
// poços vizinhos, mas de perfurações INDEPENDENTES (caso real: BAC-4D a 70
// m de BRSA-1216DA, códigos sem nenhuma relação — antes disso, BAC-4D
// ficava escondido atrás do outro poço, só listado no popup como "mesmo
// ponto", nunca com marcador próprio). Considera mesmo poço quando:
// coordenada idêntica (mesmo registro), OU bem perto (<20 m — mesmo centro
// de perfuração/manifold, onde vários poços vizinhos legitimamente caem no
// mesmo ponto do mapa mesmo sendo perfurações diferentes), OU código-base
// igual (sidetrack do mesmo poço original, que pode ficar a até ~70 m do
// poço-mãe). Marco de roadmap sem poço real por trás (info null) sempre
// entra: não tem coordenada/código de poço pra comparar.
const WELL_CLUSTER_SMALL_RADIUS_M = 20;
function sameWellhead(a, b) {
  if (!a.info || !b.info) return true;
  if (a.info.c[0] === b.info.c[0] && a.info.c[1] === b.info.c[1]) return true;
  if (haversineMeters(a.info.c, b.info.c) <= WELL_CLUSTER_SMALL_RADIUS_M) return true;
  return wellBaseCode(a.info.n) === wellBaseCode(b.info.n);
}

// Refina uma célula da grade em 1+ grupos por sameWellhead — union-find
// simples (poucas entradas por célula, nunca vale a pena algo mais
// esperto). Praticamente sempre devolve o próprio array inteiro como grupo
// único; só separa nos ~2 casos reais de coincidência espacial encontrados
// na base (ver sameWellhead).
function splitCellByWellhead(entries) {
  const parent = entries.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (sameWellhead(entries[i], entries[j])) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  entries.forEach((e, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(e);
  });
  return [...groups.values()];
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
// popup do contrato abre. contractOwnWells desconta os poços de outro
// projeto rastreado com overlap conhecido (hoje só Mero dentro de Libra,
// ver CONTRACT_WELL_OVERLAP em shared.js) — sem isso, os mesmos poços
// apareciam desenhados duas vezes: uma como parte do bloco de Libra, outra
// como projeto Mero (as duas camadas ficam visíveis ao mesmo tempo por
// padrão).
function buildWellMarkers(key, project, bounds, color, targetLayer) {
  const anpWells = contractOwnWells(pocosData, key);
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
  for (const cell of cells.values()) {
    for (const group of splitCellByWellhead(cell.entries)) {
      // Coordenada do grupo: a do primeiro poço real dele (não a da célula
      // inteira — depois de separar, cada grupo pode legitimamente ficar
      // um pouco longe do ponto original da célula); só cai pra
      // cell.latlng se o grupo inteiro for marco aproximado sem poço real.
      const first = group.find((e) => e.info);
      const latlng = first ? first.info.c : cell.latlng;
      addWellMarker(targetLayer, latlng, color, group);
    }
  }
  return true;
}

// refBounds por contrato sem poligonal na ANP (ver PROJECTS_WITHOUT_SHAPE):
// única forma de flyToProject saber pra onde voar quando não há polígono.
const wellRefBoundsByProjectId = {};

function wellsOnlyBounds(key, project) {
  const coords = wellsForKey(pocosData, key).map((w) => w.c)
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
    <h3 style="color:${PRESALT_FIELD_STYLE.color}">${escapeHtml(props.nome)}</h3>
    ${companyBadgesHTML(props.operador, props.nome)}
    <table>${rowsHTML}</table>
    <p class="map-popup-source">Campo de contexto (fora dos 30 projetos rastreados) — Fonte: ANP, Campos de Produção (SIRGAS 2000)</p>
    ${pdSectionHTML(props.nome)}
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
  situacaoValues = computeFieldValueCounts(normSit);
  categoriaValues = computeFieldValueCounts(normCat);

  // Precisa carregar antes dos popups serem montados (popupHTML e
  // presaltFieldPopupHTML chamam pdSectionHTML na hora do bindPopup, não
  // na hora de abrir o popup — se pdData ainda estivesse vazio aqui, o
  // popup ficaria pra sempre sem a seção de Plano de Desenvolvimento).
  try {
    pdData = await (await fetch(PD_URL)).json();
  } catch (e) {
    // Camada opcional — segue sem a seção de Plano de Desenvolvimento.
  }

  // Campo de contexto cujo nome bate com um projeto rastreado (hoje só
  // MERO -> "Mero") empresta a própria poligonal do campo pro projeto:
  // contratos.geojson não tem uma poligonal própria pra Mero (só o bloco
  // inteiro de Libra), mas campos_presal.geojson tem a área declarada do
  // campo, mais precisa — melhor do que cair no fallback "sem poligonal"
  // (ver PROJECTS_WITHOUT_SHAPE). O campo correspondente é pulado no laço
  // abaixo: já vira o projeto rastreado (cor, popup e rótulo próprios, ver
  // laço de state.projects mais abaixo), não teria por que desenhar os
  // dois.
  const trackedProjectByUpperName = new Map(state.projects.map((p) => [p.name.toUpperCase(), p]));
  // Campo de contexto que cita o MESMO PD (pd.fonte) de um único projeto
  // rastreado (hoje Atapu <- OESTE DE ATAPU, Entorno de Sapinhoá <-
  // SAPINHOÁ) é a mesma jazida vista do lado do campo — colorido como o
  // projeto (não neutro) no laço abaixo, pra ficar visualmente "dentro"
  // dele em vez de um campo qualquer sem relação. Ver projectByPdFonte em
  // shared.js e a nota em jazidaComposicao/groupByPdFonte (mesmo critério
  // usado no card "Jazidas Compartilhadas" de analises.js).
  const linkedProjectByFonte = projectByPdFonte(state.projects, pdData);

  try {
    const presRes = await fetch(PRESALT_FIELDS_URL);
    const presGeojson = await presRes.json();
    for (const feat of presGeojson.features) {
      const props = feat.properties;
      const trackedProject = trackedProjectByUpperName.get(props.nome.toUpperCase());
      if (trackedProject) {
        featureByProject[trackedProject.name] = feat;
        continue;
      }
      const fieldPd = byNameOrUpper(pdData, props.nome);
      const linkedProject = fieldPd && fieldPd.fonte ? linkedProjectByFonte.get(fieldPd.fonte) : null;
      const color = linkedProject ? colorForProject(linkedProject) : PRESALT_FIELD_STYLE.color;
      const style = linkedProject
        ? { color, weight: 1.5, fillColor: color, fillOpacity: 0.22, dashArray: '4 3' }
        : PRESALT_FIELD_STYLE;
      const layer = L.geoJSON(feat, { style });
      layer.eachLayer((l) => l.bindPopup(presaltFieldPopupHTML(props), { maxWidth: 320 }));
      layer.addTo(presaltFieldsLayer);
      presaltFieldLabelMarkers.push(L.marker(layer.getBounds().getCenter(), {
        icon: L.divIcon({
          className: 'map-project-label-icon',
          html: `<div class="map-project-label-wrap">
            <span class="map-project-label">${escapeHtml(titleCasePt(props.nome))}</span>
            ${mapLabelBadgesHTML(props.operador, props.nome)}
          </div>`,
          iconSize: null,
        }),
        interactive: false,
        keyboard: false,
        zIndexOffset: -100,
      }));
      if (linkedProject) linkedPresaltLayers.push({ layer, project: linkedProject });
      registerWellSet(props.nome, null, layer.getBounds(), color, wellPresaltLayer);
    }
  } catch (e) {
    // Camada de contexto é opcional — segue sem ela se não carregar.
  }

  for (const feat of geojson.features) featureByProject[feat.properties.projeto] = feat;

  // A partir de featureByProject (não geojson.features cru) pra cobrir
  // também o projeto que empresta feature de campos_presal.geojson (hoje
  // só Mero, ver laço acima) — é exatamente o que colorForProject('rodada')
  // consulta.
  rodadaOrder = [...new Set(state.projects.map((p) => {
    const f = featureByProject[p.name];
    return f && f.properties.rodada;
  }).filter(Boolean))].sort();
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
    layer.eachLayer((l) => l.bindPopup(popupHTML(project, feat.properties), { autoPan: false, maxWidth: 320 }));
    const target = groupLayers[project.group] || groupLayers[GROUP_FALLBACK];
    layer.addTo(target);
    layerByProjectId[project.id] = layer;
    allBounds.push(bounds);

    projectLabelByProjectId[project.id] = L.marker(bounds.getCenter(), {
      icon: L.divIcon({
        className: 'map-project-label-icon',
        html: `<div class="map-project-label-wrap">
          <span class="map-project-label">${escapeHtml(mapDisplayName(project))}</span>
          ${mapLabelBadgesHTML(feat.properties.operador, project.name)}
        </div>`,
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

// Esconde contrato com data depois do ano escolhido no slider — "como era
// o mapa até esse ano". Sem data conhecida (projeto sem marco de contrato
// reconhecido) sempre aparece: melhor mostrar de mais do que esconder por
// engano algo que não sabemos datar.
function applyProjectYearFilter() {
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
}

function passesWellFilters(info) {
  if (!info) return true;
  return !situacaoFilterExcluded.has(normSit(info)) && !categoriaFilterExcluded.has(normCat(info));
}

// Poço mesclado no mesmo ponto (ver sameWellhead) pode ter uma entrada que
// passa no filtro atual e outra que não — bota a que passa primeiro, sem
// tirar a outra da lista (ela continua em "Mesmo ponto" no popup, só não é
// mais quem dá a cara do marcador). Sempre a partir de entries original
// (nunca do resultado de uma reordenação anterior — ver o campo `entries`
// em registerWellMarker), pra não "grudar" numa ordem só porque um filtro
// mais restritivo passou por ali antes. Se nenhuma entrada passa nas duas
// (SITUACAO e CATEGORIA podem aprovar entradas DIFERENTES — ver sitOk/catOk
// abaixo — sem nenhuma aprovar as duas ao mesmo tempo, caso raro) ou se
// todas passam, mantém a ordem original.
function reorderEntriesByFilter(entries) {
  const passing = entries.filter((e) => passesWellFilters(e.info));
  if (!passing.length || passing.length === entries.length) return entries;
  return [...passing, ...entries.filter((e) => !passesWellFilters(e.info))];
}

// Esconde poço pelos três filtros juntos — ano (slider "Mostrar até o
// ano"), SITUACAO e CATEGORIA (chips do painel, ver renderWellFilterSection)
// — cada um só esconde o que sabe classificar: sem ano conhecido, sem
// poço real por trás (sits/cats vazio, ver registerWellMarker), sempre
// aparece; com poço(s) real(is), basta UM dos que o marcador agrupa passar
// no filtro pra ele continuar visível (mesclar não deveria esconder um
// poço que sozinho apareceria — ver WELL_MERGE_GRID). Visível não é o
// bastante, porém: reordena a exibição pra mostrar uma entrada que passa
// (ver reorderEntriesByFilter) — senão o marcador ficava vivo mas com
// ícone/popup de um poço que o filtro tirou, parecendo que o filtro não
// funcionou.
function applyWellFilters() {
  for (const entry of wellMarkerRegistry) {
    const yearOk = yearFilterValue == null || entry.year == null || entry.year <= yearFilterValue;
    const sitOk = entry.sits.length === 0 || entry.sits.some((s) => !situacaoFilterExcluded.has(s));
    const catOk = entry.cats.length === 0 || entry.cats.some((c) => !categoriaFilterExcluded.has(c));
    const visible = yearOk && sitOk && catOk;
    if (visible && !entry.targetLayer.hasLayer(entry.marker)) entry.targetLayer.addLayer(entry.marker);
    else if (!visible && entry.targetLayer.hasLayer(entry.marker)) entry.targetLayer.removeLayer(entry.marker);
    if (visible) {
      const reordered = reorderEntriesByFilter(entry.entries);
      if (reordered[0] !== entry.primary) {
        entry.primary = reordered[0];
        setMarkerContent(entry.marker, entry.color, reordered);
      }
    }
  }
  updateProjectLabels();
}

function applyYearFilter() {
  applyProjectYearFilter();
  applyWellFilters();
}

function setColorMode(mode) {
  colorMode = mode;
  for (const project of state.projects) {
    const layer = layerByProjectId[project.id];
    if (!layer) continue;
    const c = colorForProject(project);
    layer.setStyle({ color: c, fillColor: c });
    const feat = featureByProject[project.name];
    if (feat) layer.eachLayer((l) => l.bindPopup(popupHTML(project, feat.properties), { autoPan: false, maxWidth: 320 }));
  }
  // Campo de contexto colorido como um projeto rastreado (ver
  // linkedPresaltLayers) segue a cor do projeto em qualquer modo — sem
  // isso, "Colorir por Status" repintava Atapu mas deixava OESTE DE ATAPU
  // parado na cor de Partilha original.
  for (const { layer, project } of linkedPresaltLayers) {
    const c = colorForProject(project);
    layer.setStyle({ color: c, fillColor: c });
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
  // Legenda dos tipos de poço só faz sentido quando há poço na tela pra
  // explicar — mesmo corte de zoom que revela os próprios poços.
  document.getElementById('mapWellLegendFixed').hidden = !zoomOk;
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
  // Rótulo de campo de contexto (ver presaltFieldLabelMarkers) — mesmo
  // corte de zoom, mas segue a visibilidade da camada de campos de
  // contexto (presaltFieldsLayer), não a de grupo de projeto: campo de
  // contexto não tem grupo nem projeto por trás.
  for (const marker of presaltFieldLabelMarkers) {
    showOrHide(marker, zoomOk && map.hasLayer(presaltFieldsLayer));
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

// Um grupo de chips (SITUACAO ou CATEGORIA) — chip ativo (cor) é valor
// visível, chip apagado é valor escondido; clique alterna sem re-render
// do painel inteiro (perderia a posição do scroll numa lista de até 15
// chips), só troca a classe do próprio botão. "Todos"/"Nenhum" mexem em
// vários de uma vez, aí sim precisam re-render pra refletir na classe de
// cada chip.
function renderAttributeFilterGroup(container, title, values, excludedSet) {
  const wrap = document.createElement('div');
  wrap.className = 'map-panel-section map-filter-group';

  const header = document.createElement('div');
  header.className = 'map-filter-group-header';
  const label = document.createElement('span');
  label.className = 'map-mode-label';
  label.style.marginBottom = '0';
  label.textContent = title;
  header.appendChild(label);

  const actions = document.createElement('span');
  actions.className = 'map-filter-actions';
  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.textContent = 'Todos';
  allBtn.addEventListener('click', () => { excludedSet.clear(); applyWellFilters(); renderPanel(); });
  const noneBtn = document.createElement('button');
  noneBtn.type = 'button';
  noneBtn.textContent = 'Nenhum';
  noneBtn.addEventListener('click', () => {
    for (const [value] of values) excludedSet.add(value);
    applyWellFilters();
    renderPanel();
  });
  actions.appendChild(allBtn);
  actions.appendChild(noneBtn);
  header.appendChild(actions);
  wrap.appendChild(header);

  const pills = document.createElement('div');
  pills.className = 'map-filter-pills';
  for (const [value, count] of values) {
    const isNone = value === SIT_NONE_KEY || value === CAT_NONE_KEY;
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'map-filter-pill' + (excludedSet.has(value) ? '' : ' active') + (isNone ? ' is-none' : '');
    pill.textContent = `${value} (${count})`;
    pill.addEventListener('click', () => {
      if (excludedSet.has(value)) excludedSet.delete(value); else excludedSet.add(value);
      pill.classList.toggle('active');
      applyWellFilters();
    });
    pills.appendChild(pill);
  }
  wrap.appendChild(pills);
  container.appendChild(wrap);
}

// Filtro de poço por SITUACAO e CATEGORIA — ver applyWellFilters. Só
// aparece depois que os dados carregam (situacaoValues/categoriaValues
// calculados em init(), ver computeFieldValueCounts); sem poço nenhuma
// base carregada os dois ficam vazios e a seção não teria o que mostrar.
function renderWellFilterSection(container) {
  if (!situacaoValues.length && !categoriaValues.length) return;
  const section = document.createElement('div');
  section.className = 'map-panel-section';
  const label = document.createElement('div');
  label.className = 'map-mode-label';
  label.textContent = 'Filtrar poços';
  section.appendChild(label);
  const note = document.createElement('p');
  note.className = 'map-panel-note';
  note.style.margin = '0 0 8px';
  note.textContent = 'Campos brutos do cadastro ANP/BDEP — diferente da forma do ícone (Resultado do poço, abaixo), que já é apurado. Poço mesclado no mesmo ponto some só se nenhum dos que ele agrupa passar no filtro.';
  section.appendChild(note);
  if (situacaoValues.length) renderAttributeFilterGroup(section, 'Situação', situacaoValues, situacaoFilterExcluded);
  if (categoriaValues.length) renderAttributeFilterGroup(section, 'Categoria', categoriaValues, categoriaFilterExcluded);
  container.appendChild(section);
}

// Ordem de exibição na legenda — do resultado mais positivo (achou e
// produz) ao mais neutro (sem registro), agrupando injeção/abandonado
// (intervenção/descontinuado) no meio.
const WELL_CATEGORY_LABELS = [
  ['producao', 'Produção (óleo)'],
  ['gas', 'Produção/indício de gás'],
  ['indicio', 'Indício de óleo (poço seco)'],
  ['seco', 'Seco, sem indícios'],
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
  for (const [injType, label] of [['agua', 'Injeção de água'], ['gas', 'Injeção de gás']]) {
    const row = document.createElement('div');
    row.className = 'map-legend-row';
    const icon = document.createElement('span');
    icon.className = 'map-legend-well-icon';
    icon.innerHTML = `<svg viewBox="0 0 16 16" width="15" height="15">${WELL_SHAPES.injecao(WELL_LEGEND_COLOR)}${INJECTION_BADGES[injType]}</svg>`;
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
// painel (com a lista dos 30 projetos) tampava boa parte dele logo na
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
  renderWellFilterSection(el);

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
  presaltNote.textContent = 'Contexto geográfico (tracejado cinza) — não fazem parte dos 30 projetos rastreados.';
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
  shapeHeader.textContent = 'Resultado do poço';
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
      li.appendChild(document.createTextNode(mapDisplayName(project)));
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
