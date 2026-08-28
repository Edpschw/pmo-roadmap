'use strict';

/* =========================================================================
   PMO Roadmap — Análises. Um único gráfico: STOIIP, participação (TP) e
   profit oil por jazida, calculado no navegador a partir do mesmo estado
   (shared.js) e de data/planos_desenvolvimento.json (STOIIP e "tracts" —
   só disponível pros projetos/campos com sumário executivo de PD
   publicado) + data/campos_presal.geojson (campos de contexto, fora dos
   30 projetos rastreados). Sem servidor: tudo é derivado desses arquivos
   estáticos a cada carga.
   ========================================================================= */

const PD_URL = 'data/planos_desenvolvimento.json';
// Campos de contexto do pré-sal (ver mapa.js) — regime de Concessão ou
// Cessão Onerosa, bem anterior à Lei da Partilha (2010); nenhum dos 30
// projetos rastreados (Mero, o único campo de contexto em Partilha, virou
// projeto próprio — ver seedState em shared.js).
const PRESALT_FIELDS_URL = 'data/campos_presal.geojson';

// Cor neutra pros campos de contexto — só os 30 projetos rastreados têm
// cor própria (a mesma do roadmap/mapa, project.color); campo de contexto
// usa este cinza.
const CONTEXT_FIELD_COLOR = '#7a828f';

let pdData = {};

/* -------------------------------- Helpers -------------------------------- */

function fmtNum(n, opts) {
  return n.toLocaleString('pt-BR', opts || { maximumFractionDigits: 0 });
}

// projectDisplayName (nome popular da jazida no lugar do nome do contrato,
// ver shared.js) espera um nome de projeto — este wrapper aceita a row
// (contrato ou campo de contexto) usada nesta tela.
function displayName(r) {
  return projectDisplayName(r.name);
}

/* --------------------------- Tooltip de hover ----------------------------- */
// Um só elemento reaproveitado por todo mark hoverável do gráfico (barras)
// — mostra a mesma informação acessível via foco de teclado, nunca só no
// hover (ver skill de dataviz).

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

/* ----------------------------- Cálculo por linha --------------------------- */

function computeProjectRow(project) {
  const pd = byNameOrUpper(pdData, project.name);
  const volumes = pd && pd.volumes ? pd.volumes : null;
  return {
    name: project.name,
    color: project.color,
    isContract: true,
    stoiip: volumes && volumes.oleoInSituMMbbl != null ? volumes.oleoInSituMMbbl : null,
    excedenteOleoPct: pd && pd.excedenteOleoPct != null ? pd.excedenteOleoPct : null,
    tracts: pd && pd.tracts ? pd.tracts : null,
    pdKey: pd ? pd.fonte : null,
    jazidaNome: jazidaNome(pd),
  };
}

function computeFieldRow(feature) {
  const props = feature.properties;
  const name = props.nome;
  const pd = pdData[name];
  const volumes = pd && pd.volumes ? pd.volumes : null;
  return {
    name,
    color: CONTEXT_FIELD_COLOR,
    isContract: false,
    stoiip: volumes && volumes.oleoInSituMMbbl != null ? volumes.oleoInSituMMbbl : null,
    excedenteOleoPct: pd && pd.excedenteOleoPct != null ? pd.excedenteOleoPct : null,
    tracts: pd && pd.tracts ? pd.tracts : null,
    pdKey: pd ? pd.fonte : null,
    jazidaNome: jazidaNome(pd),
  };
}

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
      color: contractMember ? contractMember.color : members[0].color,
      stoiip: members[0].stoiip,
      members,
    };
  });
}

// Uma linha por JAZIDA (não por contrato/campo separado) — contrato + campo
// de contexto ligados (ex.: Norte de Carcará + BACALHAU) viram uma linha
// só (ver groupByPdKey); STOIIP/tracts/profit oil não somam entre membros
// — é a mesma jazida, mesmo PD, já vem igual em cada membro que o publica.
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
      : (rep.jazidaNome || rep.name).split(/,| e /)[0].trim();
    return {
      name,
      color: g.color,
      stoiip: g.stoiip,
      excedenteOleoPct: rep.excedenteOleoPct,
      // Composição estruturada da jazida (ver "tracts" em data/planos_
      // desenvolvimento.json) — mesmo array em todo membro do grupo que a
      // publica (ex.: Norte de Carcará e BACALHAU citam o mesmo), então
      // o primeiro membro que tiver já serve.
      tracts: g.members.map((m) => m.tracts).find(Boolean) || null,
    };
  });
}

/* ------------------------------ Gráfico único ------------------------------ */

// Uma linha de barra dentro de um grupo de jazida — cada jazida monta
// várias dessas em sequência (uma por métrica/fatia).
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

// Uma seção de métrica dentro do cartão de uma jazida (rótulo + barras).
function metricSection(group, label) {
  const metric = document.createElement('div');
  metric.className = 'jazida-combo-metric';
  const metricLabel = document.createElement('p');
  metricLabel.className = 'jazida-combo-metric-label';
  metricLabel.textContent = label;
  metric.appendChild(metricLabel);
  group.appendChild(metric);
  return metric;
}

function metricNote(metric, text) {
  const note = document.createElement('p');
  note.className = 'jazida-combo-metric-note';
  note.textContent = text;
  metric.appendChild(note);
}

// Um único cartão com 5 métricas por jazida — STOIIP, Tract Participation
// (TP, a % de cada fatia/contrato dentro da jazida, só quando há mais de
// um — ver "tracts" em data/planos_desenvolvimento.json, decomposição
// estruturada de pd.areaObs), profit oil (% de excedente em óleo ofertado
// no leilão de cada fatia — só existe pra Partilha ou pro excedente da
// Cessão Onerosa; Concessão, Cessão Onerosa original e Área Não
// Contratada não têm esse mecanismo, ficam sem barra), STOIIP × TP (volume
// atribuído a cada fatia, só quando há mais de uma) e STOIIP × TP × profit
// oil (métrica ilustrativa, ver nota abaixo). Jazida sem "tracts"
// publicado vira uma fatia só (ela mesma, 100%).
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
  sub.textContent = `As ${withStoiip.length} jazidas com Plano de Desenvolvimento público. STOIIP (óleo in situ) por jazida; Tract Participation (TP) — % de cada fatia/contrato dentro da jazida — só onde o PD publica a composição e há mais de um contrato; profit oil — % de excedente em óleo ofertado no leilão de cada fatia, quando existe (Concessão e a fatia original da Cessão Onerosa não têm esse mecanismo, só a Partilha e o excedente da Cessão Onerosa); STOIIP × TP — volume atribuído a cada fatia; e STOIIP × TP × profit oil — métrica ilustrativa, não uma reserva técnica (ver nota abaixo).`;
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

    const stoiipMetric = metricSection(group, 'STOIIP');
    stoiipMetric.appendChild(comboBarRow(
      r.name, (r.stoiip / maxStoiip) * 100, fmtNum(r.stoiip) + ' MMbbl', r.color,
      () => `<strong>${escapeHtml(r.name)}</strong>` + tooltipRowHTML('STOIIP', `${fmtNum(r.stoiip)} MMbbl`),
    ));

    if (tracts.length > 1) {
      const tpMetric = metricSection(group, 'Participação (TP)');
      for (const t of tracts) {
        tpMetric.appendChild(comboBarRow(
          t.nome, t.pct, t.pct.toLocaleString('pt-BR') + '%', r.color,
          () => `<strong>${escapeHtml(t.nome)}</strong>` + tooltipRowHTML('Participação na jazida', `${t.pct.toLocaleString('pt-BR')}%`),
        ));
      }
    }

    const withPct = tracts.filter((t) => t.excedenteOleoPct != null);
    const profitMetric = metricSection(group, 'Profit oil');
    if (withPct.length) {
      for (const t of withPct) {
        const label = tracts.length > 1 ? t.nome : r.name;
        profitMetric.appendChild(comboBarRow(
          label, t.excedenteOleoPct, t.excedenteOleoPct.toLocaleString('pt-BR') + '%', r.color,
          () => `<strong>${escapeHtml(label)}</strong>` + tooltipRowHTML('Profit oil', `${t.excedenteOleoPct.toLocaleString('pt-BR')}%`),
        ));
      }
    } else {
      metricNote(profitMetric, 'Sem profit oil — regime de Concessão/Cessão Onerosa, sem esse mecanismo.');
    }

    if (tracts.length > 1) {
      const stoiipTpValues = tracts.map((t) => r.stoiip * (t.pct / 100));
      const maxStoiipTp = Math.max(...stoiipTpValues);
      const stoiipTpMetric = metricSection(group, 'STOIIP × TP (volume atribuído)');
      tracts.forEach((t, i) => {
        const value = stoiipTpValues[i];
        stoiipTpMetric.appendChild(comboBarRow(
          t.nome, (value / maxStoiipTp) * 100, fmtNum(value) + ' MMbbl', r.color,
          () => `<strong>${escapeHtml(t.nome)}</strong>`
            + tooltipRowHTML('STOIIP da jazida', `${fmtNum(r.stoiip)} MMbbl`)
            + tooltipRowHTML('TP', `${t.pct.toLocaleString('pt-BR')}%`)
            + tooltipRowHTML('STOIIP × TP', `${fmtNum(value)} MMbbl`),
        ));
      });
    }

    const withStoiipTpProfit = tracts
      .filter((t) => t.excedenteOleoPct != null)
      .map((t) => ({ t, value: r.stoiip * (t.pct / 100) * (t.excedenteOleoPct / 100) }));
    if (withStoiipTpProfit.length) {
      const maxCombo = Math.max(...withStoiipTpProfit.map((x) => x.value));
      const comboMetric = metricSection(group, 'STOIIP × TP × Profit oil (ilustrativo)');
      for (const { t, value } of withStoiipTpProfit) {
        const label = tracts.length > 1 ? t.nome : r.name;
        comboMetric.appendChild(comboBarRow(
          label, (value / maxCombo) * 100, fmtNum(value) + ' MMbbl', r.color,
          () => `<strong>${escapeHtml(label)}</strong>`
            + tooltipRowHTML('STOIIP da jazida', `${fmtNum(r.stoiip)} MMbbl`)
            + tooltipRowHTML('TP', `${t.pct.toLocaleString('pt-BR')}%`)
            + tooltipRowHTML('Profit oil', `${t.excedenteOleoPct.toLocaleString('pt-BR')}%`)
            + tooltipRowHTML('STOIIP × TP × Profit oil', `${fmtNum(value)} MMbbl`),
        ));
      }
      metricNote(comboMetric, 'Ilustrativo: assume 100% de recuperação do STOIIP. Profit oil de verdade incide sobre volume produzido/monetizado, não sobre o recurso in-place — não é uma reserva técnica.');
    }

    card.appendChild(group);
  }
  container.appendChild(card);
}

/* ---------------------------------- Init ----------------------------------- */

async function init() {
  const wrapper = document.getElementById('analyticsWrapper');
  let presalGeojson = null;
  try {
    const [pd, presal] = await Promise.all([
      fetch(PD_URL).then((r) => r.json()),
      fetch(PRESALT_FIELDS_URL).then((r) => r.json()),
    ]);
    pdData = pd;
    presalGeojson = presal;
  } catch (err) {
    console.error('Falha ao carregar dados de análise', err);
  }

  // Campo de contexto cujo nome bate com um projeto rastreado (hoje só
  // MERO -> "Mero") não entra na lista de campos de contexto — já vira o
  // projeto rastreado correspondente em computeProjectRow, contar os dois
  // duplicaria a jazida.
  const trackedProjectByUpperName = new Map(state.projects.map((p) => [p.name.toUpperCase(), p]));
  const presalFeatures = presalGeojson
    ? presalGeojson.features.filter((f) => !trackedProjectByUpperName.has(f.properties.nome.toUpperCase()))
    : [];

  const contractRows = state.projects.map(computeProjectRow);
  const fieldRows = presalFeatures.map(computeFieldRow);
  const jazidaRows = computeJazidaRows(contractRows, fieldRows);

  wrapper.innerHTML = '';
  const section = document.createElement('section');
  section.className = 'analytics-section';
  renderJazidaComboChart(section, jazidaRows);
  wrapper.appendChild(section);
}

init();
