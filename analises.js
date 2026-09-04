'use strict';

/* =========================================================================
   PMO Roadmap — Análises. Duas páginas (alternadas pelo seletor no topo,
   sem recarregar): Executivo (contratos, FPSOs, contratos por ano) e
   Portfolio (STOIIP por jazida, por contrato já ponderado pela TP, e
   ponderado também por profit oil). Calculado no navegador a partir do
   mesmo estado (shared.js) e de data/planos_desenvolvimento.json (STOIIP e
   "tracts" — só disponível pros projetos/campos com sumário executivo de
   PD publicado) + data/campos_presal.geojson (campos de contexto, fora dos
   30 projetos rastreados). Sem servidor: tudo é derivado desses arquivos
   estáticos a cada carga. Infra de gráfico (tooltip, fmtNum, chartCard,
   barRow, CONTEXT_FIELD_COLOR) vem de shared.js — compartilhada com
   producao.js.
   ========================================================================= */

const PD_URL = 'data/planos_desenvolvimento.json';
const POCOS_URL = 'data/pocos.json';
const PRODUCAO_POCOS_URL = 'data/producao_pocos.json';
// Campos de contexto do pré-sal (ver mapa.js) — regime de Concessão ou
// Cessão Onerosa, bem anterior à Lei da Partilha (2010); nenhum dos 30
// projetos rastreados (Mero, o único campo de contexto em Partilha, virou
// projeto próprio — ver seedState em shared.js).
const PRESALT_FIELDS_URL = 'data/campos_presal.geojson';

let pdData = {};

/* -------------------------------- Helpers -------------------------------- */

function yearOfISO(iso) {
  const y = parseInt(String(iso).slice(0, 4), 10);
  return Number.isFinite(y) ? y : null;
}

// projectDisplayName (nome popular da jazida no lugar do nome do contrato,
// ver shared.js) espera um nome de projeto — este wrapper aceita a row
// (contrato ou campo de contexto) usada nesta tela.
function displayName(r) {
  return projectDisplayName(r.name);
}

/* ----------------------------- Cálculo por linha --------------------------- */

// FPSO instalado (marco cumprido) vs. previsto (marco ainda não cumprido)
// na workstream "FPSO" do projeto — mesmo dado que o roadmap já mostra
// como marco, só contado aqui.
function fpsoInfo(project) {
  let installed = 0;
  let planned = 0;
  for (const ws of project.workstreams) {
    if (!ws.name.includes('FPSO')) continue;
    for (const it of ws.items) {
      if (it.type !== 'milestone' || it.icon !== 'fpso') continue;
      if (it.done) installed++;
      else planned++;
    }
  }
  return { installed, planned };
}

// Ano do leilão/arremate — marco "Leilão" da workstream "Marcos do
// Contrato" quando existe; senão o mais antigo marco com ícone "contract"
// dessa workstream (cobre os poucos projetos sem marco "Leilão" nomeado
// assim).
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

function computeProjectRow(project) {
  const pd = byNameOrUpper(pdData, project.name);
  const volumes = pd && pd.volumes ? pd.volumes : null;
  const fpso = fpsoInfo(project);
  return {
    name: project.name,
    color: project.color,
    isContract: true,
    group: project.group,
    leilaoYear: leilaoYearOf(project),
    fpsoInstalled: fpso.installed,
    fpsoPlanned: fpso.planned,
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

function computeAggregates(contractRows) {
  const byGroup = { exploracao: 0, producao: 0, devolvidos: 0 };
  let fpsoInstalled = 0;
  let fpsoPlanned = 0;
  for (const r of contractRows) {
    byGroup[r.group]++;
    fpsoInstalled += r.fpsoInstalled;
    fpsoPlanned += r.fpsoPlanned;
  }
  return { byGroup, totalProjects: contractRows.length, fpsoInstalled, fpsoPlanned };
}

// Todos os poços da base ANP/BDEP (data/pocos.json), um por nome — os 30
// contratos rastreados + campos de contexto + poços sem campo nomeado
// ("outros"), deduplicados (o mesmo poço pode aparecer sob mais de uma
// chave, ver CONTRACT_WELL_OVERLAP em shared.js). Universo completo, não
// só os 30 projetos, porque os dois números pedidos aqui (furados no ano +
// em perfuração agora) são sobre o play inteiro, não por projeto.
function allWells(pocosData, outrosPocos) {
  const byName = new Map();
  for (const wells of Object.values(pocosData)) {
    for (const w of wells) byName.set(w.n, w);
  }
  for (const w of outrosPocos) byName.set(w.n, w);
  return [...byName.values()];
}

// "d" é a data de conclusão (ver mapa.js/wellPopupHTML) — pros poços ainda
// em perfuração, é a data do último boletim, então "furados no ano" conta
// só quem já concluiu (sit !== EM PERFURAÇÃO); "em perfuração" é a
// situação atual, sem filtrar por ano (não teria sentido: perfurando agora
// é sempre "neste ano").
function computeWellAggregates(pocosData, outrosPocos) {
  const wells = allWells(pocosData, outrosPocos);
  const year = new Date().getFullYear();
  const yearStr = String(year);
  const emPerfuracao = wells.filter((w) => w.sit === 'EM PERFURAÇÃO');
  const furadosNoAno = wells.filter((w) => w.d && w.d.slice(0, 4) === yearStr && w.sit !== 'EM PERFURAÇÃO');
  return { year, furadosNoAno: furadosNoAno.length, emPerfuracao: emPerfuracao.length };
}

/* ------------------------------ Página Executivo ---------------------------- */

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

function renderExecutiveKpis(container, agg, wellAgg) {
  const row = document.createElement('div');
  row.className = 'kpi-row';
  row.appendChild(statTile(
    'Contratos rastreados', String(agg.totalProjects),
    `${agg.byGroup.exploracao} exploração · ${agg.byGroup.producao} produção · ${agg.byGroup.devolvidos} devolvidos`,
  ));
  row.appendChild(statTile(
    'FPSOs em operação', fmtNum(agg.fpsoInstalled),
    `+ ${agg.fpsoPlanned} previstos`,
  ));
  row.appendChild(statTile(
    `Poços furados em ${wellAgg.year}`, fmtNum(wellAgg.furadosNoAno),
    'Base ANP/BDEP, todo o play do pré-sal — concluídos neste ano',
  ));
  row.appendChild(statTile(
    'Poços em perfuração', fmtNum(wellAgg.emPerfuracao),
    `Situação atual (${wellAgg.year})`,
  ));
  container.appendChild(row);
}

// Uma barra por ano de leilão/arremate — ordem cronológica (não por
// contagem), pra ler como linha do tempo de licitações. leilaoYearOf só
// acha o ano em contratos com marco de leilão/assinatura registrado no
// roadmap; os sem essa data (poucos, ex. Cessão Onerosa original) ficam de
// fora — ver nota no rodapé do gráfico.
function renderContractsByYearChart(container, contractRows) {
  const withYear = contractRows.filter((r) => r.leilaoYear != null);
  if (!withYear.length) return;

  const byYear = new Map();
  for (const r of withYear) {
    if (!byYear.has(r.leilaoYear)) byYear.set(r.leilaoYear, []);
    byYear.get(r.leilaoYear).push(r.name);
  }
  const years = [...byYear.keys()].sort((a, b) => a - b);
  const max = Math.max(...years.map((y) => byYear.get(y).length));

  const card = chartCard(
    'Contratos por ano',
    `Os ${withYear.length} de ${contractRows.length} contratos rastreados com data de leilão/assinatura registrada, pelo ano de arremate — ordem cronológica.${withYear.length < contractRows.length ? ` ${contractRows.length - withYear.length} sem essa data no roadmap ficam de fora.` : ''}`,
  );
  const list = document.createElement('div');
  list.className = 'hbar-list';
  for (const year of years) {
    const names = byYear.get(year);
    list.appendChild(barRow(
      String(year), (names.length / max) * 100, String(names.length), 'var(--accent)',
      () => `<strong>${escapeHtml(String(year))}</strong>`
        + tooltipRowHTML('Contratos', String(names.length))
        + `<div class="viz-tooltip-row"><span>${escapeHtml(names.join(', '))}</span></div>`,
    ));
  }
  card.appendChild(list);
  container.appendChild(card);
}

function renderExecutivePage(container, contractRows, agg, wellAgg) {
  renderExecutiveKpis(container, agg, wellAgg);
  renderContractsByYearChart(container, contractRows);
}

/* ------------------------------ Página Portfolio ---------------------------- */

// Rótulo de uma fatia/contrato dentro de uma jazida — "Jazida — Fatia"
// quando há mais de uma e a fatia tem nome próprio diferente da jazida
// (evita ambiguidade entre fatias com nome genérico que se repete em
// jazidas diferentes, ex. "Área Não Contratada" em Mero e em Atapu); só o
// nome da jazida quando é fatia única ou quando a fatia principal já tem o
// mesmo nome dela (ex. "Mero" dentro da jazida Mero — "Mero — Mero" não
// acrescenta nada).
function tractLabel(jazidaRow, tract, hasMultiple) {
  if (!hasMultiple || tract.nome === jazidaRow.name) return jazidaRow.name;
  return `${jazidaRow.name} — ${tract.nome}`;
}

// Fatias/contratos de uma jazida — "tracts" publicado (ver data/planos_
// desenvolvimento.json) quando existe; senão uma fatia sintética única (a
// própria jazida, 100%, com o profit oil que ela já carregava).
function tractsOf(jazidaRow) {
  return jazidaRow.tracts && jazidaRow.tracts.length
    ? jazidaRow.tracts
    : [{ nome: jazidaRow.name, pct: 100, excedenteOleoPct: jazidaRow.excedenteOleoPct }];
}

// STOIIP (óleo in situ) por JAZIDA — o volume publicado no PD, sem dividir
// entre as fatias/contratos que a compartilham (ver computeJazidaRows).
function renderStoiipByJazidaChart(container, jazidaRows) {
  const rows = jazidaRows.filter((r) => r.stoiip != null).sort((a, b) => b.stoiip - a.stoiip);
  if (!rows.length) return;

  const card = chartCard(
    'STOIIP por jazida',
    `As ${rows.length} jazidas com Plano de Desenvolvimento público — óleo in situ (STOIIP) publicado, sem dividir entre contratos quando a jazida é compartilhada.`,
  );
  const list = document.createElement('div');
  list.className = 'hbar-list';
  const max = Math.max(...rows.map((r) => r.stoiip));
  for (const r of rows) {
    list.appendChild(barRow(
      r.name, (r.stoiip / max) * 100, fmtNum(r.stoiip) + ' MMbbl', r.color,
      () => `<strong>${escapeHtml(r.name)}</strong>` + tooltipRowHTML('STOIIP', `${fmtNum(r.stoiip)} MMbbl`),
    ));
  }
  card.appendChild(list);
  container.appendChild(card);
}

// STOIIP por CONTRATO já ponderado pela Tract Participation (TP) — a % de
// cada fatia/contrato dentro da jazida (ver "tracts" em data/planos_
// desenvolvimento.json). Jazida com um contrato só sai idêntica ao
// gráfico "por jazida" (fatia única, 100%); jazida compartilhada
// (Bacalhau/Norte de Carcará, Mero, Atapu/Oeste de Atapu) quebra em uma
// barra por contrato, cada uma já com o volume atribuído.
function renderStoiipByContractChart(container, jazidaRows) {
  const items = [];
  for (const r of jazidaRows) {
    if (r.stoiip == null) continue;
    const tracts = tractsOf(r);
    const multi = tracts.length > 1;
    for (const t of tracts) {
      items.push({
        label: tractLabel(r, t, multi),
        value: r.stoiip * (t.pct / 100),
        color: r.color,
        jazidaNome: r.name,
        jazidaStoiip: r.stoiip,
        pct: t.pct,
      });
    }
  }
  items.sort((a, b) => b.value - a.value);
  if (!items.length) return;

  const card = chartCard(
    'STOIIP por contrato (já com TP)',
    'STOIIP da jazida × Tract Participation (TP) — a % de cada contrato/fatia dentro da jazida, quando ela é compartilhada por mais de um. Volume atribuído a cada contrato, não o volume total da jazida.',
  );
  const list = document.createElement('div');
  list.className = 'hbar-list';
  const max = Math.max(...items.map((i) => i.value));
  for (const it of items) {
    list.appendChild(barRow(
      it.label, (it.value / max) * 100, fmtNum(it.value) + ' MMbbl', it.color,
      () => `<strong>${escapeHtml(it.label)}</strong>`
        + tooltipRowHTML('STOIIP da jazida', `${fmtNum(it.jazidaStoiip)} MMbbl`)
        + tooltipRowHTML('TP', `${it.pct.toLocaleString('pt-BR')}%`)
        + tooltipRowHTML('STOIIP × TP', `${fmtNum(it.value)} MMbbl`),
    ));
  }
  card.appendChild(list);
  container.appendChild(card);
}

// STOIIP ponderado por TP × profit oil — só pras fatias/contratos com
// profit oil publicado (Partilha ou excedente da Cessão Onerosa; Concessão
// e a fatia original da Cessão Onerosa não têm esse mecanismo, ficam de
// fora). Métrica ILUSTRATIVA: assume 100% de recuperação do STOIIP —
// profit oil de verdade incide sobre volume produzido/monetizado, não
// sobre o recurso in-place, então isto não é uma reserva técnica.
function renderStoiipWeightedChart(container, jazidaRows) {
  const items = [];
  for (const r of jazidaRows) {
    if (r.stoiip == null) continue;
    const tracts = tractsOf(r);
    const multi = tracts.length > 1;
    for (const t of tracts) {
      if (t.excedenteOleoPct == null) continue;
      items.push({
        label: tractLabel(r, t, multi),
        value: r.stoiip * (t.pct / 100) * (t.excedenteOleoPct / 100),
        color: r.color,
        jazidaNome: r.name,
        jazidaStoiip: r.stoiip,
        pct: t.pct,
        excedenteOleoPct: t.excedenteOleoPct,
      });
    }
  }
  items.sort((a, b) => b.value - a.value);
  if (!items.length) return;

  const card = chartCard(
    'STOIIP ponderado por TP × profit oil (ilustrativo)',
    'STOIIP × TP × profit oil, só pros contratos com esse mecanismo (Partilha ou excedente da Cessão Onerosa). Ilustrativo: assume 100% de recuperação do STOIIP — profit oil de verdade incide sobre volume produzido/monetizado, não sobre o recurso in-place, então isto não é uma reserva técnica.',
  );
  const list = document.createElement('div');
  list.className = 'hbar-list';
  const max = Math.max(...items.map((i) => i.value));
  for (const it of items) {
    list.appendChild(barRow(
      it.label, (it.value / max) * 100, fmtNum(it.value) + ' MMbbl', it.color,
      () => `<strong>${escapeHtml(it.label)}</strong>`
        + tooltipRowHTML('STOIIP da jazida', `${fmtNum(it.jazidaStoiip)} MMbbl`)
        + tooltipRowHTML('TP', `${it.pct.toLocaleString('pt-BR')}%`)
        + tooltipRowHTML('Profit oil', `${it.excedenteOleoPct.toLocaleString('pt-BR')}%`)
        + tooltipRowHTML('STOIIP × TP × Profit oil', `${fmtNum(it.value)} MMbbl`),
    ));
  }
  card.appendChild(list);
  container.appendChild(card);
}

// 10 poços com maior produção de óleo (bbl/d) no último boletim de poços da
// ANP (data/producao_pocos.json, ver scripts/build_producao_pocos.py) —
// granularidade de poço, não de campo/jazida (diferente dos gráficos de
// STOIIP acima, e cobre TODO o pré-sal do boletim, não só os 30 contratos
// rastreados). Cor da barra: cor do projeto rastreado quando o nome do
// campo no boletim bate com um (ex. "BÚZIOS_ECO" -> Búzios, tirando o
// prefixo AnC_/sufixo _ECO); senão cinza de contexto (mesmo CONTEXT_FIELD_COLOR
// dos campos fora dos 30, ver computeFieldRow acima).
function renderTopProducersChart(container, producaoPocosJson) {
  if (!producaoPocosJson || !producaoPocosJson.pocos) return;
  const projectColorByDisplayName = new Map(
    state.projects.map((p) => [projectDisplayName(p.name).toUpperCase(), p.color]),
  );
  function colorForCampo(campo) {
    const key = campo.toUpperCase().replace(/^ANC_/, '').replace(/_ECO$/, '').replace(/_/g, ' ').trim();
    return projectColorByDisplayName.get(key) || CONTEXT_FIELD_COLOR;
  }

  const rows = Object.entries(producaoPocosJson.pocos)
    .map(([nome, p]) => ({ nome, oleoBbld: p.oleoBbld, campo: p.campo, color: colorForCampo(p.campo) }))
    .sort((a, b) => b.oleoBbld - a.oleoBbld)
    .slice(0, 10);
  if (!rows.length) return;

  const [ano, mes] = producaoPocosJson.mesRef.split('-').map(Number);
  const card = chartCard(
    '10 maiores produtores (poço)',
    `Óleo por poço (bbl/d), ${MESES_PT[mes]}/${ano} — boletim de poços da ANP, todo o pré-sal (não só os 30 contratos rastreados). Cor do projeto rastreado quando o campo do boletim bate com um; cinza pros demais.`,
  );
  const list = document.createElement('div');
  list.className = 'hbar-list';
  const max = rows[0].oleoBbld;
  for (const r of rows) {
    list.appendChild(barRow(
      r.nome, (r.oleoBbld / max) * 100, fmtNum(r.oleoBbld) + ' bbl/d', r.color,
      () => `<strong>${escapeHtml(r.nome)}</strong>`
        + tooltipRowHTML('Campo/trato (boletim ANP)', r.campo)
        + tooltipRowHTML('Óleo', fmtNum(r.oleoBbld) + ' bbl/d'),
    ));
  }
  card.appendChild(list);
  container.appendChild(card);
}

function renderPortfolioPage(container, jazidaRows, producaoPocosJson) {
  renderStoiipByJazidaChart(container, jazidaRows);
  renderStoiipByContractChart(container, jazidaRows);
  renderStoiipWeightedChart(container, jazidaRows);
  renderTopProducersChart(container, producaoPocosJson);
}

/* ------------------------------- Seletor de página -------------------------- */

function buildTabSwitch(tabs, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'scale-switch analytics-tab-switch';
  tabs.forEach(([key, label], i) => {
    const btn = document.createElement('button');
    btn.className = 'scale-btn' + (i === 0 ? ' active' : '');
    btn.textContent = label;
    btn.dataset.tab = key;
    wrap.appendChild(btn);
  });
  wrap.addEventListener('click', (e) => {
    const btn = e.target.closest('.scale-btn');
    if (!btn) return;
    wrap.querySelectorAll('.scale-btn').forEach((b) => b.classList.toggle('active', b === btn));
    onChange(btn.dataset.tab);
  });
  return wrap;
}

/* ---------------------------------- Init ----------------------------------- */

async function init() {
  const wrapper = document.getElementById('analyticsWrapper');
  let presalGeojson = null;
  let pocosJson = null;
  let producaoPocosJson = null;
  try {
    const [pd, presal, pocos, producaoPocos] = await Promise.all([
      fetch(PD_URL).then((r) => r.json()),
      fetch(PRESALT_FIELDS_URL).then((r) => r.json()),
      fetch(POCOS_URL).then((r) => r.json()),
      // no-store: mesmo motivo de producao.js — reprocessado sem deploy de
      // código junto, o navegador não tem como saber que precisa buscar de
      // novo só pela URL.
      fetch(PRODUCAO_POCOS_URL, { cache: 'no-store' }).then((r) => r.json()),
    ]);
    pdData = pd;
    presalGeojson = presal;
    pocosJson = pocos;
    producaoPocosJson = producaoPocos;
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
  const agg = computeAggregates(contractRows);
  const wellAgg = computeWellAggregates(pocosJson ? pocosJson.pocos || {} : {}, pocosJson ? pocosJson.outros || [] : []);

  wrapper.innerHTML = '';

  const execSection = document.createElement('section');
  execSection.className = 'analytics-section';
  const portSection = document.createElement('section');
  portSection.className = 'analytics-section';
  portSection.hidden = true;

  const tabSwitch = buildTabSwitch(
    [['executivo', 'Executivo'], ['portfolio', 'Portfolio']],
    (tab) => {
      execSection.hidden = tab !== 'executivo';
      portSection.hidden = tab !== 'portfolio';
    },
  );
  wrapper.appendChild(tabSwitch);
  wrapper.appendChild(execSection);
  wrapper.appendChild(portSection);

  renderExecutivePage(execSection, contractRows, agg, wellAgg);
  renderPortfolioPage(portSection, jazidaRows, producaoPocosJson);
}

init();
