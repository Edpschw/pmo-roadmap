'use strict';

/* =========================================================================
   PMO Roadmap — Análises. Três páginas (alternadas pelo seletor no topo,
   sem recarregar): Executivo (contratos, FPSOs, contratos por ano, reservas
   VOIP dos 7 contratos com produção própria), Portfolio (STOIIP por
   jazida, por contrato já ponderado pela TP, e ponderado também por profit
   oil) e Poços (histogramas de duração de perfuração/produção/injeção por
   poço + contagem de poço por FPSO — visão nacional, não por campo).
   Calculado no navegador a partir do mesmo estado (shared.js) e de
   data/planos_desenvolvimento.json (STOIIP e "tracts" — só disponível pros
   projetos/campos com sumário executivo de PD publicado) + data/campos_
   presal.geojson (campos de contexto, fora dos 30 projetos rastreados) +
   data/pocos.json (cadastro de poços do pré-sal) + data/producao_pocos.json
   (boletim de poços da ANP, produção/injeção, todo o litoral) + data/
   reservas_bar.json (Boletim Anual de Reservas da ANP — VOIP/produção
   acumulada, ver scripts/parse_reservas_bar.py). Sem servidor: tudo é
   derivado desses arquivos estáticos a cada carga. Infra de gráfico
   (tooltip, fmtNum, chartCard, barRow, statTile, buildHistogram,
   CONTEXT_FIELD_COLOR, extractReservasSeries, buildReservasChart) vem de
   shared.js — compartilhada com producao.js, campo.js e dados.js.
   ========================================================================= */

const PD_URL = 'data/planos_desenvolvimento.json';
const POCOS_URL = 'data/pocos.json';
const PRODUCAO_POCOS_URL = 'data/producao_pocos.json';
const RESERVAS_BAR_URL = 'data/reservas_bar.json';
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

// Reservas (VOIP) — data/reservas_bar.json (Boletim Anual de Reservas da
// ANP, ver scripts/parse_reservas_bar.py), só pros 7 contratos com
// produção própria (PROJECT_FIELD_BASE, shared.js) — os outros 23
// rastreados não têm campo próprio nesse boletim (produção/reserva sai
// inteira sob a jazida compartilhada, ex. Libra sob "Mero"). extractReservasSeries/
// buildReservasChart vêm de shared.js, compartilhadas com o gráfico
// equivalente por projeto em campo.js.
function computeReservasRows(reservasBarJson, contractRows) {
  const anos = reservasBarJson.anos.map((a) => a.ano);
  const firstAno = anos[0];
  const lastAno = anos[anos.length - 1];
  const rows = [];
  for (const [projectName, base] of Object.entries(PROJECT_FIELD_BASE)) {
    const project = state.projects.find((p) => p.name === projectName);
    const contractRow = contractRows.find((r) => r.name === projectName);
    const series = extractReservasSeries(reservasBarJson, (nome) => nome.includes(base));
    if (!series.some((s) => s.voipMMbbl > 1e-9)) continue;
    const first = series[0];
    const last = series[series.length - 1];
    rows.push({
      name: projectDisplayName(projectName),
      color: project ? project.color : CONTEXT_FIELD_COLOR,
      voipLast: last.voipMMbbl,
      acumLast: last.acumMMbbl,
      stoiip: contractRow ? contractRow.stoiip : null,
      voipChangePct: first.voipMMbbl > 0 ? (last.voipMMbbl - first.voipMMbbl) / first.voipMMbbl * 100 : 0,
      // Fração recuperada = produção acumulada ÷ VOIP daquele mesmo ano —
      // proxy de maturidade do campo (quanto do óleo original já saiu),
      // NÃO um fator de recuperação final projetado (ver nota grande em
      // scripts/parse_reservas_bar.py).
      fracaoLast: last.voipMMbbl > 0 ? (last.acumMMbbl / last.voipMMbbl) * 100 : 0,
      fracaoSeries: series.map((s) => ({ x: s.ano, y: s.voipMMbbl > 0 ? (s.acumMMbbl / s.voipMMbbl) * 100 : 0 })),
    });
  }
  return { rows, firstAno, lastAno };
}

function renderReservasSection(container, reservasBarJson, contractRows) {
  if (!reservasBarJson) return;
  const { rows, firstAno, lastAno } = computeReservasRows(reservasBarJson, contractRows);
  if (!rows.length) return;

  const totalVoip = rows.reduce((s, r) => s + r.voipLast, 0);
  const totalAcum = rows.reduce((s, r) => s + r.acumLast, 0);
  const biggest = rows.reduce((a, b) => (b.voipChangePct > a.voipChangePct ? b : a));

  const kpiRow = document.createElement('div');
  kpiRow.className = 'kpi-row';
  kpiRow.appendChild(statTile(
    `VOIP total, ${rows.length} contratos (${lastAno})`, fmtNum(totalVoip / 1000, 1) + ' Bbbl',
    'Volume original in place — ANP/BAR, não é reserva 1P/2P/3P',
  ));
  kpiRow.appendChild(statTile(
    'Produção acumulada', fmtNum(totalAcum) + ' MMbbl',
    `Óleo já produzido, ${firstAno}–${lastAno}`,
  ));
  kpiRow.appendChild(statTile(
    'Maior revisão de VOIP', biggest.name,
    `${biggest.voipChangePct >= 0 ? '+' : ''}${biggest.voipChangePct.toFixed(1)}% desde ${firstAno}`,
  ));
  container.appendChild(kpiRow);

  const nationalSeries = extractReservasSeries(
    reservasBarJson,
    (nome) => Object.values(PROJECT_FIELD_BASE).some((base) => nome.includes(base)),
  );
  const reservasChartCard = chartCard(
    'Reservas — VOIP e produção acumulada (7 contratos com produção própria)',
    `Soma dos 7 contratos rastreados com produção própria no boletim (Búzios, Mero, Itapu, Sépia, Atapu, Entorno de Sapinhoá, Norte de Carcará) — volume original de óleo in place (VOIP) e produção acumulada, ${firstAno}–${lastAno}. Não é a reserva 1P/2P/3P remanescente (essa só no Painel Dinâmico de Recursos e Reservas da ANP, fora deste app).`,
  );
  buildReservasChart(reservasChartCard, nationalSeries, 'var(--accent)');
  container.appendChild(reservasChartCard);

  const barCard = chartCard(
    `STOIIP, VOIP e volume recuperado por contrato (${lastAno})`,
    'STOIIP (Plano de Desenvolvimento) ao lado de VOIP e óleo já produzido (Boletim Anual de Reservas da ANP) — 2 fontes/metodologias diferentes lado a lado de propósito, pra comparar a mesma ordem de grandeza. A fração entre parênteses do volume recuperado é produção acumulada ÷ VOIP do mesmo ano; não é fator de recuperação final projetado. Contrato sem PD publicado fica sem barra de STOIIP.',
  );
  const list = document.createElement('div');
  list.className = 'hbar-list';
  const headers = document.createElement('div');
  headers.className = 'hbar-row hbar-row-3col hbar-col-headers';
  headers.innerHTML = '<span></span><span class="hbar-col-label">STOIIP</span><span class="hbar-col-label">VOIP</span><span class="hbar-col-label">Volume recuperado</span>';
  list.appendChild(headers);
  const sorted = [...rows].sort((a, b) => b.voipLast - a.voipLast);
  const max = Math.max(...sorted.flatMap((r) => [r.voipLast, r.stoiip || 0, r.acumLast]));
  for (const r of sorted) {
    const row = document.createElement('div');
    row.className = 'hbar-row hbar-row-3col';
    const name = document.createElement('div');
    name.className = 'hbar-name';
    name.textContent = r.name;
    name.title = r.name;
    const tooltip = () => `<strong>${escapeHtml(r.name)}</strong>`
      + (r.stoiip != null ? tooltipRowHTML('STOIIP', `${fmtNum(r.stoiip)} MMbbl`) : '')
      + tooltipRowHTML('VOIP', `${fmtNum(r.voipLast)} MMbbl`)
      + tooltipRowHTML(`Revisão desde ${firstAno}`, `${r.voipChangePct >= 0 ? '+' : ''}${r.voipChangePct.toFixed(1)}%`)
      + tooltipRowHTML('Volume recuperado', `${fmtNum(r.acumLast)} MMbbl`)
      + tooltipRowHTML('Fração recuperada', `${r.fracaoLast.toFixed(1)}%`);
    const makeTrack = (value, text, opacity) => {
      const track = document.createElement('div');
      track.className = 'hbar-track';
      if (value == null) {
        const valueLabel = document.createElement('div');
        valueLabel.className = 'hbar-value';
        valueLabel.textContent = '—';
        valueLabel.style.color = 'var(--text-faint)';
        track.appendChild(valueLabel);
        return track;
      }
      const fill = document.createElement('div');
      fill.className = 'hbar-fill';
      fill.style.width = Math.max(3, (value / max) * 100) + '%';
      fill.style.background = r.color;
      fill.style.opacity = opacity;
      fill.tabIndex = 0;
      attachTooltip(fill, tooltip);
      const valueLabel = document.createElement('div');
      valueLabel.className = 'hbar-value';
      valueLabel.textContent = text;
      track.append(fill, valueLabel);
      return track;
    };
    row.append(
      name,
      makeTrack(r.stoiip, r.stoiip != null ? `${fmtNum(r.stoiip)} MMbbl` : null, '0.85'),
      makeTrack(r.voipLast, `${fmtNum(r.voipLast)} MMbbl`, '1'),
      makeTrack(r.acumLast, `${fmtNum(r.acumLast)} MMbbl (${r.fracaoLast.toFixed(1)}%)`, '0.58'),
    );
    list.appendChild(row);
  }
  barCard.appendChild(list);
  container.appendChild(barCard);

  const fracaoCard = chartCard(
    'Fração recuperada por contrato',
    `Produção acumulada ÷ VOIP daquele mesmo ano, ${firstAno}–${lastAno} — quanto do óleo original já saiu de cada campo. Não é fator de recuperação final projetado (essa projeção a ANP não publica em planilha, só no Painel Dinâmico de Recursos e Reservas). O volume recuperado absoluto aparece no gráfico de barras anterior.`,
  );
  buildMultiLineChart(
    fracaoCard,
    rows.map((r) => ({ name: r.name, color: r.color, points: r.fracaoSeries })),
    {
      formatY: (v) => v.toFixed(0) + '%',
    },
  );
  container.appendChild(fracaoCard);

  const stoiipRows = rows.filter((r) => r.stoiip != null);
  if (stoiipRows.length) {
    const stoiipPieCard = chartCard(
      'STOIIP por campo',
      `Óleo in situ publicado no sumário executivo de PD de cada contrato (${stoiipRows.length} de ${rows.length} com produção própria têm PD publicado) — volume total do reservatório, não o volume recuperável nem o VOIP do BAR (fonte/metodologia diferente, ver Portfolio).`,
    );
    buildPieChart(stoiipPieCard, stoiipRows.map((r) => ({ name: r.name, value: r.stoiip, color: r.color })), { valueLabel: 'MMbbl' });
    container.appendChild(stoiipPieCard);
  }

  const acumPieCard = chartCard(
    `Volume produzido por campo (${lastAno})`,
    `Produção acumulada de óleo declarada no Boletim Anual de Reservas mais recente, por contrato — ${fmtNum(totalAcum)} MMbbl no total.`,
  );
  buildPieChart(acumPieCard, rows.map((r) => ({ name: r.name, value: r.acumLast, color: r.color })), { valueLabel: 'MMbbl' });
  container.appendChild(acumPieCard);
}

function renderExecutivePage(container, contractRows, agg, wellAgg, reservasBarJson) {
  renderExecutiveKpis(container, agg, wellAgg);
  renderReservasSection(container, reservasBarJson, contractRows);
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

// Nome de fatia usado pela ANP pra "dentro da jazida, mas fora de
// qualquer contrato" (ver anel laranja de AnC no mapa/mini-mapa, shared.js
// WELL_LEGEND) — string exata, conferida contra as 13 fatias hoje
// publicadas em data/planos_desenvolvimento.json (nenhuma variação de
// grafia/acento encontrada).
const TRACT_NAO_CONTRATADA = 'Área Não Contratada';

// Lista de barras genérica pra um grupo de fatias (contratadas OU AnC) —
// mesmo corpo que renderStoiipByContractChart usava antes de virar dois
// gráficos separados (ver logo abaixo); título/nota variam por grupo.
function renderStoiipItemsChart(container, title, note, items) {
  if (!items.length) return;
  const card = chartCard(title, note);
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

// STOIIP por CONTRATO já ponderado pela Tract Participation (TP) — a % de
// cada fatia dentro da jazida (ver "tracts" em data/planos_
// desenvolvimento.json). Jazida com um contrato só sai idêntica ao
// gráfico "por jazida" (fatia única, 100%, cai no grupo "campos de
// partilha" abaixo); jazida compartilhada (Bacalhau/Norte de Carcará,
// Mero, Atapu/Oeste de Atapu) quebra em uma barra por fatia, cada uma já
// com o volume atribuído. Dois gráficos, não um só: fatia "Área Não
// Contratada" (AnC — dentro da jazida, mas sem contrato formal, mesmo
// anel laranja do mapa) mistura MMbbl que ninguém detém com MMbbl de
// contrato de verdade se ficasse na mesma lista/escala — separar deixa
// claro que "campos de partilha" é só a parte já concedida.
function renderStoiipByContractChart(container, jazidaRows) {
  const partilha = [];
  const naoContratada = [];
  for (const r of jazidaRows) {
    if (r.stoiip == null) continue;
    const tracts = tractsOf(r);
    const multi = tracts.length > 1;
    for (const t of tracts) {
      const item = {
        label: tractLabel(r, t, multi),
        value: r.stoiip * (t.pct / 100),
        color: r.color,
        jazidaNome: r.name,
        jazidaStoiip: r.stoiip,
        pct: t.pct,
      };
      (t.nome === TRACT_NAO_CONTRATADA ? naoContratada : partilha).push(item);
    }
  }
  partilha.sort((a, b) => b.value - a.value);
  naoContratada.sort((a, b) => b.value - a.value);

  renderStoiipItemsChart(
    container,
    'STOIIP por contrato — campos de partilha (já com TP)',
    'STOIIP da jazida × Tract Participation (TP), só as fatias já concedidas (Partilha da Produção, Cessão Onerosa, excedente da CO) — a Área Não Contratada de cada jazida fica no gráfico seguinte. Volume atribuído a cada contrato, não o volume total da jazida.',
    partilha,
  );
  renderStoiipItemsChart(
    container,
    'STOIIP — áreas não contratadas (AnC)',
    'STOIIP × TP só da fatia "Área Não Contratada" de cada jazida — parte do reservatório ainda sem contrato formal (mesmo anel laranja de AnC do mapa/mini-mapa), quando o Plano de Desenvolvimento publica essa fatia separada.',
    naoContratada,
  );
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

function renderPortfolioPage(container, jazidaRows) {
  renderStoiipByJazidaChart(container, jazidaRows);
  renderStoiipByContractChart(container, jazidaRows);
  renderStoiipWeightedChart(container, jazidaRows);
}

/* ---------------------------------- Poços ----------------------------------- */
// Visão agregada NACIONAL (não por campo/contrato — isso já é o resto da
// aba Poços, pocos.js), 4 histogramas (buildHistogram, shared.js) + 3
// contagens de poço por FPSO. Duração vem do cadastro de poços
// (data/pocos.json, só contratos/campos do pré-sal); produção/injeção vêm
// de data/producao_pocos.json, o boletim de POÇOS da ANP, que cobre todo
// poço offshore do país (não só pré-sal) — por isso os dois grupos de
// gráfico citam fontes diferentes na legenda.

// Por FPSO: contagem de poço + a jazida mais comum entre eles (ver
// presalJazidaBase mais abaixo) — o mesmo FPSO pode ter poço de mais de
// uma jazida em tese (ex.: FPSO Frade citado no comentário de
// isPresalCampo, água/gás injetado; aqui só entram poços já pré-sal, ver
// filterPresal, então na prática quase sempre é uma jazida só), usa a
// maioria pra decidir o grupo/cor do FPSO no gráfico.
function fpsoCounts(dataMap) {
  const counts = new Map();
  const jazidaVotes = new Map(); // fpso -> Map(jazida -> nº de poços)
  for (const key in dataMap) {
    const { fpso, campo } = dataMap[key];
    counts.set(fpso, (counts.get(fpso) || 0) + 1);
    const jazida = presalJazidaBase(campo) || '?';
    if (!jazidaVotes.has(fpso)) jazidaVotes.set(fpso, new Map());
    const votes = jazidaVotes.get(fpso);
    votes.set(jazida, (votes.get(jazida) || 0) + 1);
  }
  const jazidaByFpso = new Map();
  for (const [fpso, votes] of jazidaVotes) {
    const [topJazida] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    jazidaByFpso.set(fpso, topJazida);
  }
  return { counts, jazidaByFpso };
}

// Agrupado por jazida (cor consistente com o resto do app pros 7
// contratos rastreados — ver jazidaColorMap — e uma cor estável por hash
// pras demais, mesmo critério de colorForCompany) — jazida com mais poço
// no total primeiro, FPSO mais poço primeiro dentro da própria jazida
// (mesmo critério de ordenação de buildWellProductionChart em campo.js).
// Cartão genérico "agrupado por jazida, com legenda + filtro dinâmico +
// cabeçalho de seção entre as linhas" — separado de buildFpsoProducaoInjecaoChart
// (único chamador hoje) só pra isolar essa montagem (legenda/filtro/
// cabeçalho de grupo) de "como desenhar uma linha", que fica a cargo de
// buildRow. keys: lista de FPSO; jazidaByKey/totalByKey: Map(fpso ->
// jazida) e Map(fpso -> total pra ordenar/agrupar); buildRow(fpso, color,
// jazidaLabel) devolve o elemento .hbar-row já pronto.
// columnHeaders: [label1, label2] opcional — rotula as 2 colunas da linha
// (ver hbar-row-2col/twoColumnFpsoRow) acima da lista.
function buildGroupedFpsoChart(container, opts, keys, jazidaByKey, totalByKey, jazidaColors, buildRow, columnHeaders) {
  if (!keys.length) return;

  const totalByJazida = new Map();
  const fpsoCountByJazida = new Map();
  for (const key of keys) {
    const jazida = jazidaByKey.get(key);
    totalByJazida.set(jazida, (totalByJazida.get(jazida) || 0) + totalByKey.get(key));
    fpsoCountByJazida.set(jazida, (fpsoCountByJazida.get(jazida) || 0) + 1);
  }
  const jazidaOrder = [...totalByJazida.keys()].sort((a, b) => totalByJazida.get(b) - totalByJazida.get(a));
  const colorByJazida = new Map(jazidaOrder.map((j) => [j, jazidaColors(j)]));

  const entries = [...keys].sort((a, b) => {
    const jazidaCmp = jazidaOrder.indexOf(jazidaByKey.get(a)) - jazidaOrder.indexOf(jazidaByKey.get(b));
    return jazidaCmp || totalByKey.get(b) - totalByKey.get(a);
  });

  const card = chartCard(opts.title, opts.subtitle);
  // Ocupa as 2 colunas do grid de histogramas (ver .chart-card-span-2 em
  // style.css) — linha de FPSO já tem 2 barras lado a lado dentro dela
  // (produtores/injetores, ver twoColumnFpsoRow), ficava espremida numa
  // coluna só; abaixo de 1000px (grid já é 1 coluna) não muda nada.
  card.classList.add('chart-card-span-2');
  const legend = document.createElement('div');
  legend.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px 16px;margin-bottom:10px;font-size:12px;color:var(--text-muted)';
  for (const jazida of jazidaOrder) {
    const item = document.createElement('span');
    item.style.cssText = 'display:inline-flex;align-items:center;gap:6px';
    item.innerHTML = `<span style="width:9px;height:9px;border-radius:2px;background:${colorByJazida.get(jazida)};display:inline-block;flex:none"></span>${escapeHtml(jazida === '?' ? 'Jazida não identificada' : jazida)}`;
    legend.appendChild(item);
  }
  card.appendChild(legend);

  // Filtro dinâmico — por nome de FPSO OU de jazida, ao vivo (mesmo
  // padrão de applyNavFilter em campo.js: busca sem precisar apertar
  // Enter, contagem "X de Y" logo abaixo do campo). Esconde a linha que
  // não bate E o cabeçalho de grupo (abaixo) de uma jazida cujas linhas
  // sumiram todas — sem isso um cabeçalho "órfão" (sem nenhuma linha
  // visível embaixo) ficaria sozinho no meio da lista filtrada.
  const filterInput = document.createElement('input');
  filterInput.type = 'text';
  filterInput.className = 'campo-search';
  filterInput.placeholder = 'Filtrar por FPSO ou jazida...';
  filterInput.style.marginBottom = '2px';
  card.appendChild(filterInput);
  const filterResult = document.createElement('span');
  filterResult.className = 'campo-nav-filter-result';
  card.appendChild(filterResult);

  if (columnHeaders) {
    const colHeaderRow = document.createElement('div');
    colHeaderRow.className = 'hbar-row hbar-row-2col hbar-col-headers';
    colHeaderRow.appendChild(document.createElement('div'));
    for (const label of columnHeaders) {
      const col = document.createElement('div');
      col.className = 'hbar-col-label';
      col.textContent = label;
      colHeaderRow.appendChild(col);
    }
    card.appendChild(colHeaderRow);
  }

  const list = document.createElement('div');
  list.className = 'hbar-list';
  // Nome da jazida como cabeçalho de seção ENTRE as linhas (não só na
  // legenda do topo) — um por grupo, na primeira linha dele (entries já
  // vem ordenado por jazida, ver jazidaOrder acima); rowsByJazida guarda
  // as próprias linhas pra applyFilter decidir se o cabeçalho fica visível
  // sem precisar reconsultar o DOM.
  let lastJazida = null;
  const groupHeaderByJazida = new Map();
  const rowsByJazida = new Map();
  for (const key of entries) {
    const jazida = jazidaByKey.get(key);
    const jazidaLabel = jazida === '?' ? 'Jazida não identificada' : jazida;
    if (jazida !== lastJazida) {
      const header = document.createElement('div');
      header.className = 'hbar-group-header';
      header.innerHTML = `<span style="width:9px;height:9px;border-radius:2px;background:${colorByJazida.get(jazida)};display:inline-block;flex:none"></span><span class="stat-tile-label">${escapeHtml(jazidaLabel)} (${fpsoCountByJazida.get(jazida)})</span>`;
      list.appendChild(header);
      groupHeaderByJazida.set(jazida, header);
      lastJazida = jazida;
    }
    const row = buildRow(key, colorByJazida.get(jazida), jazidaLabel);
    row.dataset.fpso = key.toLowerCase();
    row.dataset.jazida = jazidaLabel.toLowerCase();
    list.appendChild(row);
    if (!rowsByJazida.has(jazida)) rowsByJazida.set(jazida, []);
    rowsByJazida.get(jazida).push(row);
  }
  card.appendChild(list);

  const totalFpsos = entries.length;
  function applyFilter(query) {
    const q = query.trim().toLowerCase();
    let visible = 0;
    for (const rows of rowsByJazida.values()) {
      for (const row of rows) {
        const match = !q || row.dataset.fpso.includes(q) || row.dataset.jazida.includes(q);
        row.hidden = !match;
        if (match) visible++;
      }
    }
    for (const [jazida, header] of groupHeaderByJazida) {
      header.hidden = !rowsByJazida.get(jazida).some((r) => !r.hidden);
    }
    filterResult.textContent = q ? `${visible} de ${totalFpsos} instalações correspondem a "${query.trim()}"` : '';
  }
  filterInput.addEventListener('input', (e) => applyFilter(e.target.value));

  container.appendChild(card);
}

// Preenche UM track (barra) com 1+ segmentos somados, cada um com sua
// própria cor de fundo (a mesma da jazida em todos — só a listra de
// .hbar-fill-hatched diferencia "gás" de "água"/"produção") e tooltip —
// usado tanto pra coluna de 1 métrica só (produtores, 1 segmento) quanto
// pra de 2 (injetores água+gás, ver twoColumnFpsoRow/buildFpsoProducaoInjecaoChart
// abaixo). segments: [{count, tooltipLabel, shortLabel, hatched?}].
// Track fica vazio (só o "—", sem barra) quando a soma é 0 — mais claro
// que uma barra de 3% mínimo que pareceria ter algum valor.
function buildStackedFill(track, segments, max, color, fpso, jazidaLabel) {
  const total = segments.reduce((sum, seg) => sum + seg.count, 0);
  const value = document.createElement('div');
  value.className = 'hbar-value';
  if (total > 0) {
    const present = segments.filter((seg) => seg.count > 0);
    const fillWrap = document.createElement('div');
    fillWrap.style.cssText = `display:flex;height:100%;width:${Math.max(3, (total / max) * 100)}%;border-radius:4px;overflow:hidden`;
    present.forEach((seg, i) => {
      const fill = document.createElement('div');
      fill.className = 'hbar-fill' + (seg.hatched ? ' hbar-fill-hatched' : '');
      const isLast = i === present.length - 1;
      // background-color (não o atalho "background") — "background: cor"
      // reseta background-image pro valor inicial (none) JUNTO, e por ser
      // inline sempre vence a regra de .hbar-fill-hatched no style.css
      // (background-image: repeating-linear-gradient), apagando a listra
      // do segmento de gás mesmo com a classe certa aplicada.
      fill.style.cssText = `width:${(seg.count / total) * 100}%;background-color:${color};border-radius:0;flex:none${!isLast ? ';border-right:1px solid var(--bg)' : ''}`;
      fill.tabIndex = 0;
      attachTooltip(fill, () => `<strong>${escapeHtml(fpso)}</strong>` + tooltipRowHTML('Jazida', jazidaLabel) + tooltipRowHTML(seg.tooltipLabel, `${seg.count} poço${seg.count === 1 ? '' : 's'}`));
      fillWrap.appendChild(fill);
    });
    track.appendChild(fillWrap);
    value.textContent = present.length > 1
      ? `${total} (${present.map((seg) => `${seg.count} ${seg.shortLabel}`).join(' + ')})`
      : `${total} poço${total === 1 ? '' : 's'}`;
  } else {
    value.textContent = '—';
  }
  track.appendChild(value);
}

// Uma linha por FPSO, duas colunas lado a lado (grid, ver .hbar-row-2col
// em style.css): produtores (óleo, 1 segmento) e injetores (água + gás
// somados, água sólido + gás listrado — mesma ideia de antes, agora numa
// coluna ao lado da de produção em vez de gráfico à parte). FPSO sem
// nenhum poço numa das duas colunas mostra só "—" ali (ver
// buildStackedFill), não uma barra vazia de tamanho mínimo.
function twoColumnFpsoRow(fpso, prodCount, maxProd, aguaCount, gasCount, maxInj, color, jazidaLabel) {
  const row = document.createElement('div');
  row.className = 'hbar-row hbar-row-2col';
  const name = document.createElement('div');
  name.className = 'hbar-name';
  // Total de poços da instalação (produtores + injetores de água + de
  // gás somados) entre parênteses — mesma ideia da contagem de FPSO por
  // jazida no cabeçalho de grupo, aqui um nível abaixo. title com o MESMO
  // texto (nome + contagem), não só o nome — nome de FPSO longo já corta
  // com "..." (text-overflow:ellipsis) antes mesmo de chegar no "(N)", e
  // o tooltip existe justamente pra mostrar o texto inteiro nesse caso.
  const totalPocos = prodCount + aguaCount + gasCount;
  const fullLabel = `${fpso} (${totalPocos})`;
  name.textContent = fullLabel;
  name.title = fullLabel;
  row.appendChild(name);

  const prodTrack = document.createElement('div');
  prodTrack.className = 'hbar-track';
  buildStackedFill(prodTrack, [{ count: prodCount, tooltipLabel: 'Poços produtores' }], maxProd, color, fpso, jazidaLabel);
  row.appendChild(prodTrack);

  const injTrack = document.createElement('div');
  injTrack.className = 'hbar-track';
  buildStackedFill(injTrack, [
    { count: aguaCount, tooltipLabel: 'Injetores de água', shortLabel: 'água' },
    { count: gasCount, tooltipLabel: 'Injetores de gás', shortLabel: 'gás', hatched: true },
  ], maxInj, color, fpso, jazidaLabel);
  row.appendChild(injTrack);

  return row;
}

// Substitui os dois gráficos separados (produtores / injetores) por um só
// — uma linha por FPSO com as duas colunas lado a lado (pedido explícito:
// mais fácil comparar produção e injeção da MESMA instalação numa linha
// só do que rolar dois gráficos). União dos 3 mapas (produção + água +
// gás) pro universo de FPSO — uma instalação só injetora (sem produtor
// nenhum) ou só produtora continua aparecendo, com "—" na coluna que não
// se aplica. maxProd/maxInj SEPARADOS (cada coluna com sua própria escala
// de 100%) — produção e injeção não são comparáveis na mesma régua.
function buildFpsoProducaoInjecaoChart(container, pocosMap, aguaMap, gasMap, opts, jazidaColors) {
  const { counts: prodCounts, jazidaByFpso: prodJazida } = fpsoCounts(pocosMap);
  const { counts: aguaCounts, jazidaByFpso: aguaJazida } = fpsoCounts(aguaMap);
  const { counts: gasCounts, jazidaByFpso: gasJazida } = fpsoCounts(gasMap);
  const allFpsos = new Set([...prodCounts.keys(), ...aguaCounts.keys(), ...gasCounts.keys()]);
  if (!allFpsos.size) return;
  const jazidaByFpso = new Map();
  const totalByFpso = new Map();
  for (const fpso of allFpsos) {
    jazidaByFpso.set(fpso, prodJazida.get(fpso) || aguaJazida.get(fpso) || gasJazida.get(fpso));
    totalByFpso.set(fpso, (prodCounts.get(fpso) || 0) + (aguaCounts.get(fpso) || 0) + (gasCounts.get(fpso) || 0));
  }
  const maxProd = Math.max(1, ...prodCounts.values());
  const maxInj = Math.max(1, ...[...allFpsos].map((f) => (aguaCounts.get(f) || 0) + (gasCounts.get(f) || 0)));

  buildGroupedFpsoChart(container, opts, [...allFpsos], jazidaByFpso, totalByFpso, jazidaColors, (fpso, color, jazidaLabel) => {
    return twoColumnFpsoRow(
      fpso,
      prodCounts.get(fpso) || 0, maxProd,
      aguaCounts.get(fpso) || 0, gasCounts.get(fpso) || 0, maxInj,
      color, jazidaLabel,
    );
  }, ['Produtores (óleo)', 'Injetores (água + gás)']);
}

// data/producao_pocos.json (boletim de poços da ANP/BDEP) não separa
// pré-sal de pós-sal por POÇO — só data/producao.json (por campo, ver
// parse_producao_zona.py) tem essa marcação linha a linha. Pra filtrar os
// 3 gráficos "por poço"/"por FPSO" desta aba pro pré-sal, usa o mesmo
// universo de campo já validado lá: os 20 nomes (7 contratos rastreados +
// 13 de contexto) que já aparecem com produção pré-sal em data/
// producao.json — busca aqui é só por SUBSTRING do nome em CAIXA ALTA
// (campo dessa base vem sempre em maiúsculo, às vezes com prefixo
// "AnC_"/"NORTE DE"/"SUL DE"/etc. — mesma ideia de PROJECT_FIELD_BASE em
// shared.js, sem precisar importar de lá por causa da caixa diferente).
// EXCLUI de propósito um punhado de campos históricos do pós-sal (Campos
// Basin, anos 80-90) que tiveram uma fração PONTUAL de produção pré-sal
// em algum mês do boletim por campo (poço mais fundo alcançando um
// reservatório mais raso categorizado como pré-sal) — incluir esses aqui
// misturaria poço majoritariamente pós-sal com o pré-sal de verdade, já
// que este boletim não diz QUAL poço específico é a fração pré-sal.
const PRESAL_FIELD_BASES = ['BÚZIOS', 'TUPI', 'MERO', 'ITAPU', 'SÉPIA', 'ATAPU', 'BERBIGÃO', 'JUBARTE', 'SAPINHOÁ', 'BACALHAU', 'LAPA', 'WAHOO', 'TAMBUATÁ', 'VOADOR', 'ARGONAUTA'];
const PRESAL_EXCLUDE_LEGACY = ['MARLIM', 'BARRACUDA', 'CARATINGA', 'ALBACORA', 'PAMPO'];
// Base (jazida) que bateu por substring em PRESAL_FIELD_BASES, ou null se
// não é pré-sal (ver PRESAL_EXCLUDE_LEGACY) ou não bate em nenhuma base
// conhecida — usada tanto pro filtro (isPresalCampo, abaixo) quanto pro
// agrupamento por jazida do gráfico "por FPSO" (ver buildFpsoProducaoInjecaoChart).
function presalJazidaBase(campo) {
  const up = (campo || '').toUpperCase();
  if (PRESAL_EXCLUDE_LEGACY.some((n) => up.includes(n))) return null;
  return PRESAL_FIELD_BASES.find((base) => up.includes(base)) || null;
}
function isPresalCampo(campo) {
  return presalJazidaBase(campo) != null;
}
// Cor por jazida pro gráfico "por FPSO" (buildFpsoProducaoInjecaoChart) — os 7
// contratos rastreados usam a MESMA cor do projeto (PROJECT_FIELD_BASE,
// shared.js), pra bater com o resto do app (mapa, campo, roadmap); as ~8
// jazidas de contexto (Tupi, Berbigão, Jubarte...) não têm uma cor de
// projeto própria — usa colorForCompany (hash estável por nome, mesmo
// critério já usado pra empresa/selo) em vez de inventar uma paleta nova
// só pra isso, ou de deixar todas cinzas (o resto do app já faz isso pra
// campo de contexto — mas aqui o objetivo é justamente diferenciar jazida
// de jazida, cinza uniforme não ajudaria).
function jazidaColorLookup() {
  const trackedColor = new Map();
  for (const project of state.projects) {
    const base = PROJECT_FIELD_BASE[project.name];
    if (base) trackedColor.set(base.toUpperCase(), project.color);
  }
  return (jazida) => trackedColor.get(jazida) || colorForCompany(jazida);
}
// Recorta um mapa poço->{campo,...} (pocos/injetoresAgua/injetoresGas de
// data/producao_pocos.json) só pros poços de campo pré-sal (ver
// isPresalCampo acima).
function filterPresal(dataMap) {
  const out = {};
  for (const [nome, dados] of Object.entries(dataMap)) {
    if (isPresalCampo(dados.campo)) out[nome] = dados;
  }
  return out;
}

function renderPocosPage(container, pocosJson, producaoPocosJson) {
  const grid = document.createElement('div');
  grid.className = 'analytics-histograms-grid';
  container.appendChild(grid);

  const pocosData = pocosJson ? pocosJson.pocos || {} : {};
  const outrosPocos = pocosJson ? pocosJson.outros || [] : [];
  const allWells = [];
  for (const wells of Object.values(pocosData)) allWells.push(...wells);
  allWells.push(...outrosPocos);
  const durations = allWells.filter((w) => w.dur != null).map((w) => w.dur);
  buildHistogram(grid, durations, {
    title: 'Duração da perfuração por poço',
    subtitle: 'Dias corridos entre início e término (cadastro ANP/BDEP, só poços do pré-sal com as duas datas registradas)',
    unit: 'dias',
    color: '#5b8def',
  });

  if (!producaoPocosJson) return;
  const [ano, mes] = (producaoPocosJson.mesRef || '').split('-').map(Number);
  const mesLabel = ano && mes ? `${MESES_PT[mes]}/${ano}` : '';
  // Filtrado pro pré-sal (ver isPresalCampo/filterPresal acima) — o
  // boletim de poços da ANP cobre todo o litoral (Campos, Santos,
  // Espírito Santo, Sergipe-Alagoas...), mas esta aba é sobre o pré-sal
  // rastreado no resto do app, não o play offshore inteiro.
  const pocosMap = filterPresal(producaoPocosJson.pocos || {});
  const aguaMap = filterPresal(producaoPocosJson.injetoresAgua || {});
  const gasMap = filterPresal(producaoPocosJson.injetoresGas || {});

  buildHistogram(grid, Object.values(pocosMap).map((p) => p.oleoBbld), {
    title: 'Produção por poço',
    subtitle: `Óleo por poço produtor, só pré-sal — boletim de poços da ANP, ${mesLabel}`,
    unit: 'bbl/d',
    color: '#e0762f',
  });
  buildHistogram(grid, Object.values(aguaMap).map((p) => p.aguaM3d), {
    title: 'Injeção de água por poço',
    subtitle: `Água injetada por poço, só pré-sal — boletim de poços da ANP, ${mesLabel}`,
    unit: 'm³/d',
    color: '#3fa7d6',
  });
  buildHistogram(grid, Object.values(gasMap).map((p) => p.gasMm3d), {
    title: 'Injeção de gás por poço',
    subtitle: `Gás injetado por poço, só pré-sal — boletim de poços da ANP, ${mesLabel}`,
    unit: 'Mm³/d',
    color: '#e0a83f',
  });

  const jazidaColors = jazidaColorLookup();
  buildFpsoProducaoInjecaoChart(grid, pocosMap, aguaMap, gasMap, {
    title: 'Produção e injeção por FPSO',
    subtitle: `Nº de poços em cada FPSO/instalação, agrupado por jazida, só pré-sal — boletim de poços da ANP, ${mesLabel}. Duas colunas por linha: produtores (óleo) e injetores (água sólido + gás listrado, somados); "—" quando a instalação não tem poço naquela coluna.`,
  }, jazidaColors);
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
    const [pd, presal, pocos] = await Promise.all([
      fetch(PD_URL).then((r) => r.json()),
      fetch(PRESALT_FIELDS_URL).then((r) => r.json()),
      fetch(POCOS_URL).then((r) => r.json()),
    ]);
    pdData = pd;
    presalGeojson = presal;
    pocosJson = pocos;
  } catch (err) {
    console.error('Falha ao carregar dados de análise', err);
  }
  // Fetch à parte (não crítico pro resto da página, ver renderPocosPage
  // acima) — falha aqui não deve derrubar Executivo/Portfolio, só deixa os
  // 3 gráficos de produção/injeção/FPSO da aba Poços em branco.
  try {
    producaoPocosJson = await fetch(PRODUCAO_POCOS_URL).then((r) => r.json());
  } catch (err) {
    console.error('Falha ao carregar produção por poço', err);
  }
  // Mesmo critério: falha aqui só deixa a seção de Reservas do Executivo em
  // branco (ver renderReservasSection), não derruba o resto da página.
  let reservasBarJson = null;
  try {
    reservasBarJson = await fetch(RESERVAS_BAR_URL).then((r) => r.json());
  } catch (err) {
    console.error('Falha ao carregar reservas BAR', err);
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
  const pocosSection = document.createElement('section');
  pocosSection.className = 'analytics-section';
  pocosSection.hidden = true;

  const tabSwitch = buildTabSwitch(
    [['executivo', 'Executivo'], ['portfolio', 'Portfolio'], ['pocos', 'Poços']],
    (tab) => {
      execSection.hidden = tab !== 'executivo';
      portSection.hidden = tab !== 'portfolio';
      pocosSection.hidden = tab !== 'pocos';
    },
  );
  wrapper.appendChild(tabSwitch);
  wrapper.appendChild(execSection);
  wrapper.appendChild(portSection);
  wrapper.appendChild(pocosSection);

  renderExecutivePage(execSection, contractRows, agg, wellAgg, reservasBarJson);
  renderPortfolioPage(portSection, jazidaRows);
  renderPocosPage(pocosSection, pocosJson, producaoPocosJson);
}

init();
