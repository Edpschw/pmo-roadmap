'use strict';

/* =========================================================================
   PMO Roadmap — Poços. Lista bruta de todo poço da base ANP/BDEP, agrupado
   por contrato/campo (o mesmo agrupamento de data/pocos.json, ver
   scripts/build_pocos.py), com todas as colunas do cadastro por poço — sem
   agregação nem filtro por padrão (isso é o que analises.js já faz). Só
   navegação (busca + atalhos) por cima de uma tabela por campo.
   ========================================================================= */

const POCOS_URL = 'data/pocos.json';
const PRESALT_FIELDS_URL = 'data/campos_presal.geojson';
const PRODUCAO_POCOS_URL = 'data/producao_pocos.json';

// CONTEXT_FIELD_COLOR (cinza neutro pra campo sem contrato próprio) vem de
// shared.js — compartilhada com analises.js e producao.js.

const GROUP_BADGES = {
  producao: 'Produção',
  exploracao: 'Exploração',
  devolvidos: 'Devolvido',
};

// Mesma leitura do campo "rodada" do GeoJSON usada em analises.js —
// "(PP)" é Partilha de Produção; "Cessão Onerosa" é regime próprio (2010);
// qualquer outra rodada numerada é Concessão, de antes da Lei do Partilha.
function regimeOf(rodada) {
  if (!rodada) return null;
  if (rodada.includes('(PP)')) return 'Partilha';
  if (rodada === 'Cessão Onerosa') return 'Cessão Onerosa';
  return 'Concessão';
}

function slug(name) {
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function fmtCoord(c) {
  if (!Array.isArray(c) || c.length !== 2) return '—';
  return `${c[0].toFixed(4)}, ${c[1].toFixed(4)}`;
}

// w.di/w.dur (data de início e duração da perfuração em dias, ver
// scripts/build_pocos.py) só existem quando o cadastro da ANP traz início E
// término com datas diferentes — poço com só uma das duas datas preenchida
// mostra "Início" e "Duração" em branco mesmo tendo "Conclusão" preenchida
// (o valor de w.d ali pode ser o término real ou, na falta dele, o próprio
// início usado como fallback — não dá pra saber qual dos dois sem o outro
// lado, então não adianta reaproveitar w.d na coluna de início).
function wellRowHTML(w) {
  return `<tr>
    <td>${escapeHtml(w.n)}${w.anc ? ' <span class="pocos-anc">(AnC)</span>' : ''}</td>
    <td class="${w.di ? '' : 'muted'}">${w.di ? formatBR(w.di) : '—'}</td>
    <td class="${w.d ? '' : 'muted'}">${w.d ? formatBR(w.d) : '—'}</td>
    <td class="num ${w.dur != null ? '' : 'muted'}">${w.dur != null ? `${w.dur.toLocaleString('pt-BR')} dias` : '—'}</td>
    <td class="${w.op ? '' : 'muted'}">${escapeHtml(w.op || '—')}</td>
    <td class="${w.cat ? '' : 'muted'}">${escapeHtml(w.cat || '—')}</td>
    <td class="${w.rec ? '' : 'muted'}">${escapeHtml(w.rec || '—')}</td>
    <td class="${w.sit ? '' : 'muted'}">${escapeHtml(w.sit || '—')}</td>
    <td class="num ${w.lam != null ? '' : 'muted'}">${w.lam != null ? w.lam.toLocaleString('pt-BR') : '—'}</td>
    <td class="num ${w.prof != null ? '' : 'muted'}">${w.prof != null ? w.prof.toLocaleString('pt-BR') : '—'}</td>
    <td class="${w.ps ? '' : 'muted'}">${w.ps === 'S' ? 'Sim' : w.ps === 'N' ? 'Não' : '—'}</td>
    <td class="${w.form ? '' : 'muted'}">${escapeHtml(w.form || '—')}</td>
    <td class="${w.sonda ? '' : 'muted'}">${escapeHtml(w.sonda || '—')}</td>
    <td class="muted">${fmtCoord(w.c)}</td>
  </tr>`;
}

/* ---------------------------- Distribuições -------------------------------- */
// Visão agregada NACIONAL (não por campo — isso já é o resto da página),
// logo abaixo da busca: 4 histogramas (buildHistogram, shared.js) + 3
// contagens de poço por FPSO. Duração vem do próprio cadastro de poços
// (data/pocos.json, só contratos/campos do pré-sal — é a base desta
// página); produção/injeção vêm de data/producao_pocos.json, o boletim de
// POÇOS da ANP, que cobre todo poço offshore do país (não só pré-sal) —
// por isso os dois grupos de gráfico citam fontes diferentes na legenda.

function fpsoCounts(dataMap) {
  const counts = new Map();
  for (const key in dataMap) {
    const fpso = dataMap[key].fpso;
    counts.set(fpso, (counts.get(fpso) || 0) + 1);
  }
  return counts;
}

function buildFpsoCountChart(container, dataMap, opts) {
  const counts = fpsoCounts(dataMap);
  if (!counts.size) return;
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const max = entries[0][1];
  const card = chartCard(opts.title, opts.subtitle);
  const list = document.createElement('div');
  list.className = 'hbar-list';
  for (const [fpso, count] of entries) {
    const valueText = `${count} poço${count === 1 ? '' : 's'}`;
    list.appendChild(barRow(
      fpso, (count / max) * 100, valueText, opts.color,
      () => `<strong>${escapeHtml(fpso)}</strong>` + tooltipRowHTML(opts.tooltipLabel, valueText),
    ));
  }
  card.appendChild(list);
  container.appendChild(card);
}

function buildDistribuicoesSection(pocosData, outrosPocos, producaoPocosJson) {
  const section = document.createElement('div');
  section.className = 'pocos-distribuicoes';

  const allWells = [];
  for (const wells of Object.values(pocosData)) allWells.push(...wells);
  allWells.push(...outrosPocos);
  const durations = allWells.filter((w) => w.dur != null).map((w) => w.dur);
  buildHistogram(section, durations, {
    title: 'Duração da perfuração por poço',
    subtitle: 'Dias corridos entre início e término (cadastro ANP/BDEP, só poços do pré-sal com as duas datas registradas)',
    unit: 'dias',
    color: '#5b8def',
  });

  const [ano, mes] = (producaoPocosJson.mesRef || '').split('-').map(Number);
  const mesLabel = ano && mes ? `${MESES_PT[mes]}/${ano}` : '';
  const pocosMap = producaoPocosJson.pocos || {};
  const aguaMap = producaoPocosJson.injetoresAgua || {};
  const gasMap = producaoPocosJson.injetoresGas || {};

  buildHistogram(section, Object.values(pocosMap).map((p) => p.oleoBbld), {
    title: 'Produção por poço',
    subtitle: `Óleo por poço produtor — boletim de poços da ANP, todo o litoral (não só pré-sal), ${mesLabel}`,
    unit: 'bbl/d',
    color: '#e0762f',
  });
  buildHistogram(section, Object.values(aguaMap).map((p) => p.aguaM3d), {
    title: 'Injeção de água por poço',
    subtitle: `Água injetada por poço — boletim de poços da ANP, todo o litoral, ${mesLabel}`,
    unit: 'm³/d',
    color: '#3fa7d6',
  });
  buildHistogram(section, Object.values(gasMap).map((p) => p.gasMm3d), {
    title: 'Injeção de gás por poço',
    subtitle: `Gás injetado por poço — boletim de poços da ANP, todo o litoral, ${mesLabel}`,
    unit: 'Mm³/d',
    color: '#e0a83f',
  });

  buildFpsoCountChart(section, pocosMap, {
    title: 'Poços produtores por FPSO',
    subtitle: `Nº de poços produzindo óleo em cada FPSO/instalação — boletim de poços da ANP, ${mesLabel}`,
    tooltipLabel: 'Poços produtores',
    color: '#e0762f',
  });
  buildFpsoCountChart(section, aguaMap, {
    title: 'Injetores de água por FPSO',
    subtitle: `Nº de poços injetando água em cada FPSO/instalação — boletim de poços da ANP, ${mesLabel}`,
    tooltipLabel: 'Poços injetores',
    color: '#3fa7d6',
  });
  buildFpsoCountChart(section, gasMap, {
    title: 'Injetores de gás por FPSO',
    subtitle: `Nº de poços injetando gás em cada FPSO/instalação — boletim de poços da ANP, ${mesLabel}`,
    tooltipLabel: 'Poços injetores',
    color: '#e0a83f',
  });

  return section;
}

function buildFieldSection(id, name, color, badge, wells) {
  const section = document.createElement('div');
  section.className = 'chart-card pocos-field-card';
  section.id = id;

  const header = document.createElement('div');
  header.className = 'pocos-field-header';
  header.innerHTML = `
    <h3 class="chart-card-title"><span class="proj-dot" style="background:${color}"></span>${escapeHtml(name)}</h3>
    <div class="pocos-field-meta">
      ${badge ? `<span class="pocos-badge">${escapeHtml(badge)}</span>` : ''}
      <span class="pocos-count">${wells.length} poço${wells.length === 1 ? '' : 's'}</span>
    </div>
  `;
  section.appendChild(header);

  if (!wells.length) {
    const note = document.createElement('p');
    note.className = 'analytics-table-note';
    note.style.margin = '0';
    note.textContent = 'Nenhum poço perfurado registrado na base ANP/BDEP.';
    section.appendChild(note);
    return section;
  }

  const wrap = document.createElement('div');
  wrap.className = 'table-wrapper pocos-table-wrapper';
  const table = document.createElement('table');
  table.className = 'data-table analytics-table';
  table.innerHTML = `
    <thead><tr>
      <th>Poço</th>
      <th>Início</th>
      <th>Conclusão</th>
      <th class="num">Duração</th>
      <th>Operador</th>
      <th>Categoria</th>
      <th>Resultado (reclassificação)</th>
      <th>Situação</th>
      <th class="num">Lâmina d'água (m)</th>
      <th class="num">Profundidade (m)</th>
      <th>Atingiu pré-sal</th>
      <th>Formação</th>
      <th>Sonda</th>
      <th>Coordenadas</th>
    </tr></thead>
    <tbody>${wells.map(wellRowHTML).join('')}</tbody>
  `;
  wrap.appendChild(table);
  section.appendChild(wrap);
  return section;
}

function buildNavPill(id, name, color) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pocos-nav-pill';
  btn.dataset.target = id;
  btn.innerHTML = `<span class="pocos-nav-dot" style="background:${color}"></span>${escapeHtml(name)}`;
  btn.addEventListener('click', () => {
    document.getElementById(id).scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  return btn;
}

function applyFilter(query) {
  const q = query.trim().toLowerCase();
  let totalVisible = 0;
  let totalWells = 0;
  for (const section of document.querySelectorAll('.pocos-field-card')) {
    const rows = section.querySelectorAll('tbody tr');
    totalWells += rows.length;
    let visible = 0;
    for (const tr of rows) {
      const match = !q || tr.textContent.toLowerCase().includes(q);
      tr.hidden = !match;
      if (match) visible++;
    }
    section.hidden = rows.length > 0 && visible === 0;
    const countEl = section.querySelector('.pocos-count');
    if (countEl && rows.length) {
      countEl.textContent = q
        ? `${visible} de ${rows.length} poço${rows.length === 1 ? '' : 's'}`
        : `${rows.length} poço${rows.length === 1 ? '' : 's'}`;
    }
    const pill = document.querySelector(`.pocos-nav-pill[data-target="${section.id}"]`);
    if (pill) pill.hidden = rows.length > 0 && visible === 0;
    totalVisible += visible;
  }
  const resultEl = document.getElementById('pocosFilterResult');
  if (resultEl) resultEl.textContent = q ? `${totalVisible} de ${totalWells} poços correspondem a "${query.trim()}"` : '';
}

async function init() {
  const wrapper = document.getElementById('pocosWrapper');
  let pocosJson = null;
  let presalGeojson = null;
  let producaoPocosJson = null;
  try {
    [pocosJson, presalGeojson, producaoPocosJson] = await Promise.all([
      fetch(POCOS_URL).then((r) => r.json()),
      fetch(PRESALT_FIELDS_URL).then((r) => r.json()),
      fetch(PRODUCAO_POCOS_URL).then((r) => r.json()),
    ]);
  } catch (err) {
    console.error('Falha ao carregar dados de poços', err);
    wrapper.innerHTML = '<p class="analytics-table-note">Falha ao carregar os dados de poços.</p>';
    return;
  }

  const pocosData = pocosJson.pocos || {};
  const outrosPocos = pocosJson.outros || [];

  // Campo de contexto cujo nome bate com um projeto rastreado (hoje só
  // MERO -> "Mero") já vira uma seção própria no laço de state.projects
  // logo abaixo — filtrado da lista de campos de contexto pra não
  // aparecer duas vezes.
  const trackedNamesUpper = new Set(state.projects.map((p) => p.name.toUpperCase()));
  const contextFeatures = presalGeojson
    ? presalGeojson.features.filter((f) => !trackedNamesUpper.has(f.properties.nome.toUpperCase()))
    : [];

  const content = document.createElement('div');
  content.className = 'pocos-content';

  const toolbar = document.createElement('div');
  toolbar.className = 'pocos-toolbar';
  const searchRow = document.createElement('div');
  searchRow.className = 'pocos-search-row';
  searchRow.innerHTML = `
    <input type="text" class="pocos-search" id="pocosSearch" placeholder="Filtrar por poço, operador, categoria, situação, sonda..." />
    <span class="pocos-filter-result" id="pocosFilterResult"></span>
  `;
  const nav = document.createElement('div');
  nav.className = 'pocos-nav';
  toolbar.appendChild(searchRow);
  toolbar.appendChild(nav);
  content.appendChild(toolbar);

  content.appendChild(buildDistribuicoesSection(pocosData, outrosPocos, producaoPocosJson));

  // Ordem: contratos rastreados (produção primeiro, depois exploração,
  // depois devolvidos — mesmo agrupamento de status usado em analises.js),
  // cada grupo alfabético; depois os campos de contexto do pré-sal
  // (Concessão/Cessão Onerosa); por fim o balde de poços sem campo
  // nomeado.
  const groupOrder = ['producao', 'exploracao', 'devolvidos'];
  const trackedByGroup = {};
  for (const g of groupOrder) trackedByGroup[g] = [];
  for (const p of state.projects) {
    if (trackedByGroup[p.group]) trackedByGroup[p.group].push(p);
  }
  for (const g of groupOrder) trackedByGroup[g].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  for (const g of groupOrder) {
    for (const p of trackedByGroup[g]) {
      const id = 'campo-' + slug(p.name);
      const wells = contractOwnWells(pocosData, p.name);
      nav.appendChild(buildNavPill(id, p.name, p.color));
      content.appendChild(buildFieldSection(id, p.name, p.color, GROUP_BADGES[p.group], wells));
    }
  }

  const contextFields = contextFeatures
    .map((f) => f.properties)
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  for (const props of contextFields) {
    const id = 'campo-' + slug(props.nome);
    const wells = pocosData[props.nome] || [];
    nav.appendChild(buildNavPill(id, props.nome, CONTEXT_FIELD_COLOR));
    content.appendChild(buildFieldSection(id, props.nome, CONTEXT_FIELD_COLOR, regimeOf(props.rodada), wells));
  }

  if (outrosPocos.length) {
    const id = 'campo-outros';
    const name = 'Outros poços do pré-sal (sem campo nomeado)';
    nav.appendChild(buildNavPill(id, 'Outros', CONTEXT_FIELD_COLOR));
    content.appendChild(buildFieldSection(id, name, CONTEXT_FIELD_COLOR, 'Sem campo nomeado', outrosPocos));
  }

  wrapper.innerHTML = '';
  wrapper.appendChild(content);

  document.getElementById('pocosSearch').addEventListener('input', (e) => applyFilter(e.target.value));
}

init();
