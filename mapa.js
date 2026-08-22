'use strict';

/* =========================================================================
   PMO Roadmap — visão em mapa. Usa o mesmo estado (shared.js) das outras
   páginas só para nome/cor/grupo de cada projeto; a geometria vem de
   data/contratos.geojson, gerado a partir dos shapefiles oficiais da ANP
   (Blocos Exploratórios sob Contrato + Campos de Produção, SIRGAS 2000 —
   equivalente a WGS84 para fins de exibição em mapa web) que o usuário
   baixou e enviou em 22/08/2026. Sem servidor: o GeoJSON é um arquivo
   estático, e os tiles de base vêm do OpenStreetMap (única chamada de rede
   desta página; o resto do app funciona offline).
   ========================================================================= */

const GEOJSON_URL = 'data/contratos.geojson';

// Projetos sem poligonal nos dois shapefiles fornecidos, com o motivo —
// ver comentário em cima de PLAN no script de geração (build_geojson.py,
// não versionado; a lista abaixo é o resultado dele).
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

const toastEl = document.getElementById('toast');
let toastTimer = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
}

const map = L.map('map', { zoomControl: true, minZoom: 3 }).setView([-25.3, -43], 6);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 18,
}).addTo(map);

const groupLayers = {};
for (const g of GROUP_DEFS) groupLayers[g.id] = L.layerGroup().addTo(map);

const layerByProjectId = {};

function formatAnpDate(s) {
  return s ? s.replaceAll('-', '/') : '—';
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function popupHTML(project, props) {
  const groupLabel = (GROUP_DEFS.find((g) => g.id === project.group) || {}).label || project.group;
  const rows = [
    ['Grupo', groupLabel],
    ['Bacia', props.bacia || '—'],
    ['Operador', props.operador || '—'],
  ];
  if (props.fonte === 'bloco_exploratorio') {
    rows.push(['Rodada', props.rodada || '—']);
    rows.push(['Assinatura', formatAnpDate(props.assinatura)]);
  } else {
    rows.push(['Campo(s) ANP', props.campos || '—']);
    rows.push(['Início produção', formatAnpDate(props.inicio_producao)]);
  }
  rows.push(['Área', props.area_km2 ? Math.round(props.area_km2).toLocaleString('pt-BR') + ' km²' : '—']);
  const rowsHTML = rows.map(([k, v]) => `<tr><td class="k">${k}</td><td>${v}</td></tr>`).join('');
  return `<div class="map-popup">
    <h3 style="color:${project.color}">${escapeHtml(project.name)}</h3>
    <table>${rowsHTML}</table>
    <p class="map-popup-source">Fonte: ANP — ${props.fonte === 'bloco_exploratorio' ? 'Blocos Exploratórios sob Contrato' : 'Campos de Produção'} (SIRGAS 2000)</p>
  </div>`;
}

async function init() {
  let geojson;
  try {
    const res = await fetch(GEOJSON_URL);
    geojson = await res.json();
  } catch (e) {
    showToast('Não foi possível carregar data/contratos.geojson.');
    renderSidebar();
    return;
  }

  const featureByProject = {};
  for (const feat of geojson.features) featureByProject[feat.properties.projeto] = feat;

  const allBounds = [];
  for (const project of state.projects) {
    const feat = featureByProject[project.name];
    if (!feat) continue;
    const layer = L.geoJSON(feat, {
      style: {
        color: project.color,
        weight: 1.5,
        fillColor: project.color,
        fillOpacity: 0.35,
      },
    });
    // bindPopup na camada externa (o grupo retornado por L.geoJSON) não
    // propaga pros filhos nem abre sozinho ao clicar no polígono no mapa —
    // precisa ligar em cada sub-camada individualmente.
    const popupHtml = popupHTML(project, feat.properties);
    layer.eachLayer((l) => l.bindPopup(popupHtml));
    const target = groupLayers[project.group] || groupLayers[GROUP_FALLBACK];
    layer.addTo(target);
    layerByProjectId[project.id] = layer;
    allBounds.push(layer.getBounds());
  }

  if (allBounds.length) {
    let bounds = allBounds[0];
    for (const b of allBounds.slice(1)) bounds = bounds.extend(b);
    map.fitBounds(bounds, { padding: [24, 24] });
  }

  renderSidebar();
}

function flyToProject(project) {
  const layer = layerByProjectId[project.id];
  if (!layer) {
    showToast(`Sem poligonal para "${project.name}": ${PROJECTS_WITHOUT_SHAPE[project.name] || 'não encontrada nos shapefiles fornecidos.'}`);
    return;
  }
  map.once('moveend', () => layer.eachLayer((l) => l.openPopup()));
  map.flyToBounds(layer.getBounds(), { padding: [40, 40], duration: 0.6 });
}

function toggleGroup(groupId, visible) {
  const layer = groupLayers[groupId];
  if (visible) map.addLayer(layer);
  else map.removeLayer(layer);
}

function renderSidebar() {
  const el = document.getElementById('mapSidebar');
  el.innerHTML = '';

  for (const g of GROUP_DEFS) {
    const projects = state.projects.filter((p) => p.group === g.id);
    if (!projects.length) continue;

    const section = document.createElement('div');
    section.className = 'map-sidebar-section';

    const header = document.createElement('label');
    header.className = 'map-sidebar-group-header';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.addEventListener('change', () => toggleGroup(g.id, checkbox.checked));
    header.appendChild(checkbox);
    header.appendChild(document.createTextNode(' ' + g.label));
    section.appendChild(header);

    const list = document.createElement('ul');
    list.className = 'map-sidebar-list';
    for (const project of projects) {
      const li = document.createElement('li');
      const hasShape = !!layerByProjectId[project.id];
      li.className = 'map-sidebar-item' + (hasShape ? '' : ' no-shape');
      const dot = document.createElement('span');
      dot.className = 'map-sidebar-dot';
      dot.style.background = project.color;
      li.appendChild(dot);
      li.appendChild(document.createTextNode(project.name));
      if (!hasShape) {
        const flag = document.createElement('span');
        flag.className = 'map-sidebar-flag';
        flag.textContent = 'sem shapefile';
        li.appendChild(flag);
      }
      li.addEventListener('click', () => flyToProject(project));
      list.appendChild(li);
    }
    section.appendChild(list);
    el.appendChild(section);
  }

  const missingCount = Object.keys(PROJECTS_WITHOUT_SHAPE).length;
  const note = document.createElement('p');
  note.className = 'map-sidebar-note';
  note.textContent = `${missingCount} projeto(s) sem poligonal disponível nos shapefiles da ANP fornecidos (clique no nome pra ver o motivo).`;
  el.appendChild(note);
}

init();
