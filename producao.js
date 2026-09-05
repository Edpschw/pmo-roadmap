'use strict';

/* =========================================================================
   PMO Roadmap — Produção. Produção mensal de petróleo e gás natural dos
   campos do pré-sal (data/producao.json) — de out/2014 a jun/2025, do
   dado aberto "Produção por Zona" da ANP (scripts/parse_producao_zona.py,
   poço/zona geológica com pré-sal marcado linha a linha, conferido contra
   o boletim); de jul/2025 em diante, direto do boletim (PDF/Excel —
   scripts/parse_producao.py e parse_producao_xlsm.py, único disponível
   nesses meses). Ver o topo de parse_producao_zona.py pra atualizar com
   um mês novo, ou pra entender por que os dois formatos convivem.
   Diferente da aba Análises (que é STOIIP/volume in-place, do Plano de
   Desenvolvimento — um número fixo por jazida, não muda mês a mês): aqui
   é vazão de produção real, por mês.
   Cálculo da série mensal (UNITS, computeRGO, computeFieldRows,
   computeMonthlySeries) e o gráfico de linhas interativo (createLineChart)
   vêm de shared.js — compartilhados com campo.js (visão por projeto, um
   campo só). Infra de gráfico (tooltip, fmtNum, chartCard, barRow,
   CONTEXT_FIELD_COLOR) também vem de shared.js — compartilhada com
   analises.js.
   ========================================================================= */

const PRODUCAO_URL = 'data/producao.json';

/* -------------------------------- KPIs ------------------------------------ */

function renderProducaoKpis(container, rows, mesRef) {
  const totalBoed = rows.reduce((s, r) => s + r.boedPreSal, 0);
  const contratosBoed = rows.filter((r) => r.isContract).reduce((s, r) => s + r.boedPreSal, 0);
  const totalOleo = rows.reduce((s, r) => s + r.oleoPreSalBbld, 0);
  const totalGas = rows.reduce((s, r) => s + r.gasPreSalMm3d, 0);

  const row = document.createElement('div');
  row.className = 'kpi-row';
  row.appendChild(statTileP('Mês de referência', `${MESES_PT[mesRef.mes]}/${mesRef.ano}`, 'ANP — Boletim da Produção (pré-sal)'));
  row.appendChild(statTileP('Produção pré-sal total', fmtNum(totalBoed) + ' boe/d', `${fmtNum(totalOleo)} bbl/d óleo · ${fmtNum(totalGas, { maximumFractionDigits: 1 })} Mm³/d gás`));
  row.appendChild(statTileP('Nos contratos rastreados', fmtNum(contratosBoed) + ' boe/d', `${((contratosBoed / totalBoed) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% do pré-sal`));
  row.appendChild(statTileP('Campos no boletim', String(rows.length), `${rows.filter((r) => r.isContract).length} contratos rastreados · ${rows.filter((r) => !r.isContract).length} de contexto`));
  container.appendChild(row);
}

function statTileP(label, value, sub) {
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

/* ------------------------------- Gráfico de barras ------------------------- */
// barRow/attachTooltip/tooltipRowHTML/chartCard vêm de shared.js.

function renderProductionChart(container, rows, unitKey) {
  const unit = UNITS[unitKey];
  const sorted = [...rows].filter((r) => r[unit.key] > 0).sort((a, b) => b[unit.key] - a[unit.key]);
  if (!sorted.length) return;
  const max = Math.max(...sorted.map((r) => r[unit.key]));

  const list = document.createElement('div');
  list.className = 'hbar-list';
  for (const r of sorted) {
    const multi = r.parts.length > 1;
    list.appendChild(barRow(
      r.name, (r[unit.key] / max) * 100, unit.fmt(r[unit.key]), r.color,
      () => `<strong>${escapeHtml(r.name)}</strong>`
        + tooltipRowHTML('Petróleo', fmtNum(r.oleoPreSalBbld) + ' bbl/d')
        + tooltipRowHTML('Gás natural', fmtNum(r.gasPreSalMm3d, { maximumFractionDigits: 1 }) + ' Mm³/d')
        + tooltipRowHTML('Produção', fmtNum(r.boedPreSal) + ' boe/d')
        + tooltipRowHTML('RGO', fmtNum(r.rgo) + ' m³/m³')
        + (r.isContract ? '' : tooltipRowHTML('Contrato', 'Fora dos 30 rastreados (contexto)'))
        + (multi ? `<div class="viz-tooltip-row"><span>${escapeHtml(r.parts.map((p) => p.nome).join(' + '))}</span></div>` : ''),
    ));
  }
  container.appendChild(list);
}

/* -------------------------------- Seções ------------------------------ */

function buildMonthlySection(producaoData) {
  const mesRef = producaoData.meses[producaoData.meses.length - 1];
  // knownNames de TODO o histórico (não só mesRef) — mesmo motivo de
  // computeMonthlySeries: "Anc_X" precisa achar "X" mesmo quando o mês de
  // referência atual é um dos que só lista a área não contratada.
  const rows = computeFieldRows(mesRef.campos, state.projects, allFieldNames(producaoData.meses));

  const section = document.createElement('section');
  section.className = 'analytics-section';
  renderProducaoKpis(section, rows, mesRef);

  const card = chartCard(
    'Produção por campo — pré-sal',
    'Os contratos rastreados (cor do projeto) e os demais campos do pré-sal em produção fora desta lista (cinza, contexto). Só a fração pré-sal de cada campo — a fração pós-sal (quando existe) fica de fora. RGO (Razão Gás-Óleo, m³ de gás por m³ de óleo) é calculado aqui, não vem pronto do boletim.',
  );
  // keys explícito: sem isso, buildUnitSwitch mostra TODA UNITS
  // (shared.js) — inclui 'agua'/'gasInj', que esta seção não popula (são
  // só do gráfico de injeção por campo de campo.js), o que dava aba
  // clicável sem gráfico nenhum atrás.
  const unitSwitch = buildUnitSwitch((unitKey) => {
    const list = card.querySelector('.hbar-list');
    if (list) list.remove();
    renderProductionChart(card, rows, unitKey);
  }, ['oleo', 'gas', 'boe', 'rgo']);
  card.insertBefore(unitSwitch, card.querySelector('h3').nextSibling);
  renderProductionChart(card, rows, 'oleo');
  section.appendChild(card);

  const note = document.createElement('p');
  note.className = 'analytics-table-note';
  note.textContent = `Fonte: ${producaoData.fonte.nome}, edição de ${MESES_PT[mesRef.mes]}/${mesRef.ano}.`;
  section.appendChild(note);

  return section;
}

function buildEvolutionSection(producaoData) {
  const monthlySeries = computeMonthlySeries(producaoData.meses, state.projects);

  const section = document.createElement('section');
  section.className = 'analytics-section';

  const first = producaoData.meses[0];
  const last = producaoData.meses[producaoData.meses.length - 1];
  const seen = new Set(producaoData.meses.map((m) => `${m.ano}-${m.mes}`));
  let gaps = 0;
  for (let y = first.ano, m = first.mes; y < last.ano || (y === last.ano && m <= last.mes); m++) {
    if (m > 12) { m = 1; y++; }
    if (!seen.has(`${y}-${m}`)) gaps++;
  }
  const row = document.createElement('div');
  row.className = 'kpi-row';
  row.appendChild(statTileP('Período coberto', `${MESES_PT[first.mes]}/${first.ano} – ${MESES_PT[last.mes]}/${last.ano}`, `${producaoData.meses.length} boletins mensais${gaps ? ` · ${gaps} mês(es) sem boletim compatível no meio do período` : ''}`));
  section.appendChild(row);

  const card = chartCard(
    'Produção diária por mês, por campo',
    'Um ponto por mês do boletim, exatamente como a ANP publicou — sem agregar nem estimar nada entre meses (RGO é a exceção: calculado aqui a partir do óleo e gás do próprio mês, não vem pronto do boletim). Uma linha por contrato rastreado, mais uma linha por campo de contexto (fora dos 7 rastreados) — sub-áreas da mesma jazida ("Anc_X", "Sul de X"...) já somadas numa linha só, cada uma só aparece a partir do mês em que passou a ter produção no boletim. Role o mouse sobre a área do gráfico pra zoom no tempo (ancorado no cursor), ou sobre os números do eixo vertical pra zoom só no eixo y; arraste pra mover a janela visível; clique num campo na legenda pra isolar a linha; passe o mouse sobre qualquer ponto pra ver o valor de todos os campos naquele mês de uma vez; "Ver tudo" reseta os dois eixos.',
  );
  const controlsRow = document.createElement('div');
  controlsRow.style.display = 'flex';
  controlsRow.style.alignItems = 'center';
  controlsRow.style.gap = '8px';
  controlsRow.style.flexWrap = 'wrap';
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'btn-ghost';
  resetBtn.textContent = 'Ver tudo';
  controlsRow.appendChild(resetBtn);
  card.insertBefore(controlsRow, card.querySelector('h3').nextSibling);

  const chart = createLineChart(card, monthlySeries, {
    onZoomChange: (zoomed) => {
      resetBtn.classList.toggle('is-zoomed', zoomed);
      resetBtn.textContent = zoomed ? 'Ver tudo — zoom ativo' : 'Ver tudo';
    },
  });
  // Mesmo motivo do keys em buildMonthlySection acima — sem restringir,
  // mostrava aba de água/gás injetado sem dado nenhum atrás aqui.
  const unitSwitch = buildUnitSwitch((unitKey) => chart.setUnit(unitKey), ['oleo', 'gas', 'boe', 'rgo']);
  controlsRow.insertBefore(unitSwitch, resetBtn);
  resetBtn.addEventListener('click', () => chart.resetZoom());
  section.appendChild(card);

  const note = document.createElement('p');
  note.className = 'analytics-table-note';
  note.textContent = `Fonte: ${producaoData.fonte.nome}. De out/2014 a jun/2025, vem do dado aberto "Produção por Zona" da ANP (registro bruto por poço/zona geológica, com pré-sal já marcado linha a linha — soma por campo feita aqui, não pela ANP); cada mês só entra se bater com o boletim oficial dentro de 5% nos 7 contratos rastreados, senão fica com o boletim mesmo (aconteceu em 2 dos ~130 meses conferidos). De jul/2025 em diante, direto do boletim (PDF/Excel) — a ANP tirou a marcação de pré-sal desse dado aberto a partir desse mês, então não dá mais pra confiar nele sozinho.`;
  section.appendChild(note);

  return section;
}

/* ---------------------------------- Init ----------------------------------- */

async function init() {
  const wrapper = document.getElementById('producaoWrapper');
  let producaoData = null;
  try {
    // no-store: data/producao.json é reprocessado com frequência (novo mês,
    // correção de parser) sem nenhum deploy de código junto — o navegador
    // não tem como saber que precisa buscar de novo só olhando a URL
    // (diferente de shared.js/producao.js, versionados por ?v=N). Sem
    // isso, quem já abriu a página antes continua vendo os dados antigos
    // em cache até limpar o cache à mão, mesmo com o arquivo já atualizado
    // no servidor.
    producaoData = await fetch(PRODUCAO_URL, { cache: 'no-store' }).then((r) => r.json());
  } catch (err) {
    console.error('Falha ao carregar dados de produção', err);
  }

  wrapper.innerHTML = '';

  if (!producaoData || !producaoData.meses || !producaoData.meses.length) {
    const empty = document.createElement('p');
    empty.className = 'chart-card-subtitle';
    empty.textContent = 'Nenhum dado de produção carregado ainda.';
    wrapper.appendChild(empty);
    return;
  }

  const monthlySection = buildMonthlySection(producaoData);
  const evolutionSection = buildEvolutionSection(producaoData);
  evolutionSection.hidden = true;

  const pageSwitch = buildPageSwitch(
    [['mensal', 'Mês atual'], ['evolucao', 'Evolução mensal']],
    (page) => {
      monthlySection.hidden = page !== 'mensal';
      evolutionSection.hidden = page !== 'evolucao';
    },
  );
  wrapper.appendChild(pageSwitch);
  wrapper.appendChild(monthlySection);
  wrapper.appendChild(evolutionSection);
}

function buildPageSwitch(tabs, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'scale-switch analytics-tab-switch';
  tabs.forEach(([key, label], i) => {
    const btn = document.createElement('button');
    btn.className = 'scale-btn' + (i === 0 ? ' active' : '');
    btn.textContent = label;
    btn.dataset.page = key;
    wrap.appendChild(btn);
  });
  wrap.addEventListener('click', (e) => {
    const btn = e.target.closest('.scale-btn');
    if (!btn) return;
    wrap.querySelectorAll('.scale-btn').forEach((b) => b.classList.toggle('active', b === btn));
    onChange(btn.dataset.page);
  });
  return wrap;
}

init();
