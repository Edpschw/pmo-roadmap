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
   statTile, CONTEXT_FIELD_COLOR) também vem de shared.js — compartilhada
   com analises.js e dados.js.
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
  row.appendChild(statTile('Mês de referência', `${MESES_PT[mesRef.mes]}/${mesRef.ano}`, 'ANP — Boletim da Produção (pré-sal)'));
  row.appendChild(statTile('Produção pré-sal total', fmtNum(totalBoed) + ' boe/d', `${fmtNum(totalOleo)} bbl/d óleo · ${fmtNum(totalGas, { maximumFractionDigits: 1 })} Mm³/d gás`));
  row.appendChild(statTile('Nos contratos rastreados', fmtNum(contratosBoed) + ' boe/d', `${((contratosBoed / totalBoed) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% do pré-sal`));
  row.appendChild(statTile('Campos no boletim', String(rows.length), `${rows.filter((r) => r.isContract).length} contratos rastreados · ${rows.filter((r) => !r.isContract).length} de contexto`));
  container.appendChild(row);
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
  row.appendChild(statTile('Período coberto', `${MESES_PT[first.mes]}/${first.ano} – ${MESES_PT[last.mes]}/${last.ano}`, `${producaoData.meses.length} boletins mensais${gaps ? ` · ${gaps} mês(es) sem boletim compatível no meio do período` : ''}`));
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
  // Linhas individuais (padrão) ou somadas e preenchidas (empilhado, ver
  // setStacked/buildStackToggle em shared.js) — nasce em "individuais"
  // (2º arg false), igual ao createLineChart acima (initialStacked
  // omitido = false).
  const stackToggle = buildStackToggle((stacked) => chart.setStacked(stacked), false);
  controlsRow.insertBefore(stackToggle, resetBtn);
  resetBtn.addEventListener('click', () => chart.resetZoom());
  section.appendChild(card);

  const note = document.createElement('p');
  note.className = 'analytics-table-note';
  note.textContent = `Fonte: ${producaoData.fonte.nome}. De out/2014 a jun/2025, vem do dado aberto "Produção por Zona" da ANP (registro bruto por poço/zona geológica, com pré-sal já marcado linha a linha — soma por campo feita aqui, não pela ANP); cada mês só entra se bater com o boletim oficial dentro de 5% nos 7 contratos rastreados, senão fica com o boletim mesmo (aconteceu em 2 dos ~130 meses conferidos). De jul/2025 em diante, direto do boletim (PDF/Excel) — a ANP tirou a marcação de pré-sal desse dado aberto a partir desse mês, então não dá mais pra confiar nele sozinho.`;
  section.appendChild(note);

  return section;
}

/* ------------------------- Tendência RGO x produção ------------------------ */
// Sinal clássico de reservatório maduro perdendo pressão/"quebrando gás":
// óleo em queda E RGO subindo ao mesmo tempo, de forma sustentada — não só
// dois pontos, um mês de manutenção/parada isolado já derruba óleo e não
// significa declínio. Por isso usa regressão linear sobre uma janela (até
// 24 meses) em vez de comparar só o primeiro e o último ponto, e reaproveita
// a MESMA série que a aba "Evolução mensal" já calcula (computeMonthlySeries,
// shared.js) — mesmo agrupamento por jazida (contratos rastreados por
// PROJECT_FIELD_BASE, contexto por contextJazidaBase), sem duplicar essa
// lógica aqui.

// Inclinação da reta de mínimos quadrados de `valores` (1 ponto por mês),
// normalizada como %/ano em relação à média da série — normalizar deixa
// campo grande e pequeno comparáveis na mesma tabela (um b em bbl/d bruto
// não diz nada sozinho).
function trendPctAoAno(valores) {
  const n = valores.length;
  if (n < 4) return null;
  const mx = (n - 1) / 2;
  const my = valores.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  valores.forEach((y, x) => { num += (x - mx) * (y - my); den += (x - mx) ** 2; });
  if (den === 0 || my === 0) return null;
  const b = num / den;
  return (b * 12 / my) * 100;
}

// Limiares do "alerta": queda de óleo e alta de RGO precisam ser as duas
// reais (não ruído perto de zero) pra contar como sinal de maturidade —
// abaixo disso é só "estável" (nem crescendo nem sinalizando declínio).
const TREND_OLEO_QUEDA = -1; // %/ano
const TREND_RGO_ALTA = 1; // %/ano

function computeRgoTrend(monthlySeries) {
  const porNome = new Map();
  for (const m of monthlySeries) {
    for (const r of m.rows) {
      if (!(r.oleoPreSalBbld > 0) || r.rgo == null) continue;
      if (!porNome.has(r.name)) porNome.set(r.name, { isContract: r.isContract, color: r.color, pontos: [] });
      porNome.get(r.name).pontos.push({ ano: m.ano, mes: m.mes, oleo: r.oleoPreSalBbld, rgo: r.rgo });
    }
  }
  const linhas = [];
  for (const [nome, { isContract, color, pontos }] of porNome) {
    const janela = pontos.length >= 24 ? pontos.slice(-24) : pontos;
    const oleoTrend = trendPctAoAno(janela.map((p) => p.oleo));
    const rgoTrend = trendPctAoAno(janela.map((p) => p.rgo));
    if (oleoTrend == null || rgoTrend == null) {
      linhas.push({ nome, isContract, color, meses: pontos.length, janela: janela.length, oleoTrend: null, rgoTrend: null });
      continue;
    }
    linhas.push({
      nome, isContract, color,
      meses: pontos.length, janela: janela.length,
      oleoTrend, rgoTrend,
      oleoIni: janela[0].oleo, oleoFim: janela[janela.length - 1].oleo,
      rgoIni: janela[0].rgo, rgoFim: janela[janela.length - 1].rgo,
      alerta: oleoTrend < TREND_OLEO_QUEDA && rgoTrend > TREND_RGO_ALTA,
    });
  }
  // Alerta primeiro (pior tendência de óleo primeiro dentro do alerta),
  // depois o resto ordenado pela tendência de óleo (quem mais cai por
  // último a se preocupar vem primeiro) — sem histórico suficiente vai pro
  // final, já que não dá pra dizer nada sobre esses.
  return linhas.sort((a, b) => {
    if (a.oleoTrend == null && b.oleoTrend == null) return 0;
    if (a.oleoTrend == null) return 1;
    if (b.oleoTrend == null) return -1;
    if (a.alerta !== b.alerta) return a.alerta ? -1 : 1;
    return a.oleoTrend - b.oleoTrend;
  });
}

function renderRgoTrendTable(container, linhas) {
  const wrap = document.createElement('div');
  wrap.className = 'pocos-table-wrapper';
  const table = document.createElement('table');
  table.className = 'data-table analytics-table';
  table.innerHTML = `<thead><tr>
    <th>Campo</th><th class="num">Meses c/ produção</th>
    <th class="num">Tendência óleo (%/ano)</th><th class="num">Tendência RGO (%/ano)</th>
    <th class="num">Óleo (kbbl/d)</th><th class="num">RGO (m³/m³)</th><th>Sinal</th>
  </tr></thead>`;
  const tbody = document.createElement('tbody');
  for (const l of linhas) {
    const tr = document.createElement('tr');
    if (l.oleoTrend == null) {
      tr.innerHTML = `
        <td>${escapeHtml(l.nome)}</td>
        <td class="num">${l.meses}</td>
        <td class="num" colspan="4">Histórico curto demais (menos de 4 meses de produção) pra calcular tendência.</td>
        <td class="muted">—</td>
      `;
      tbody.appendChild(tr);
      continue;
    }
    const sinalTexto = l.alerta ? 'Queda de óleo + RGO subindo' : (l.oleoTrend < 0 || l.rgoTrend > TREND_RGO_ALTA ? 'Observar' : 'Estável/crescendo');
    const sinalCor = l.alerta ? 'var(--danger)' : (l.oleoTrend < 0 || l.rgoTrend > TREND_RGO_ALTA ? 'var(--warning, #c17817)' : 'var(--text-faint)');
    tr.innerHTML = `
      <td>${escapeHtml(l.nome)}</td>
      <td class="num">${l.meses}</td>
      <td class="num" style="${l.oleoTrend < 0 ? 'color:var(--danger)' : ''}">${l.oleoTrend >= 0 ? '+' : ''}${l.oleoTrend.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</td>
      <td class="num" style="${l.rgoTrend > TREND_RGO_ALTA ? 'color:var(--danger)' : ''}">${l.rgoTrend >= 0 ? '+' : ''}${l.rgoTrend.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</td>
      <td class="num">${fmtNum(l.oleoIni / 1000)} → ${fmtNum(l.oleoFim / 1000)}</td>
      <td class="num">${fmtNum(l.rgoIni, { maximumFractionDigits: 1 })} → ${fmtNum(l.rgoFim, { maximumFractionDigits: 1 })}</td>
      <td style="color:${sinalCor};font-size:12px">${escapeHtml(sinalTexto)}</td>
    `;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
}

function buildRgoTrendSection(producaoData) {
  const monthlySeries = computeMonthlySeries(producaoData.meses, state.projects);
  const linhas = computeRgoTrend(monthlySeries);
  const comAlerta = linhas.filter((l) => l.alerta);

  const section = document.createElement('section');
  section.className = 'analytics-section';

  const row = document.createElement('div');
  row.className = 'kpi-row';
  row.appendChild(statTile('Campos analisados', String(linhas.filter((l) => l.oleoTrend != null).length), 'com pelo menos 4 meses de produção, na janela de até 24 meses mais recente'));
  row.appendChild(statTile('Queda de óleo + RGO subindo', String(comAlerta.length), comAlerta.length ? comAlerta.map((l) => l.nome).join(', ') : 'nenhum no momento'));
  section.appendChild(row);

  const card = chartCard(
    'Tendência de óleo x RGO por campo',
    `Regressão linear sobre a janela de até 24 meses mais recentes com produção de óleo > 0 (mesmo agrupamento por jazida da aba "Evolução mensal" — sub-áreas somadas numa linha só), normalizada em %/ano em relação à média da própria série pra comparar campo grande com pequeno. Sinal de maturidade (RGO subindo enquanto o óleo cai) é o clássico de reservatório perdendo pressão e "quebrando gás" — mas um trecho negativo isolado pode só ser uma parada de manutenção de FPSO no meio da janela, não declínio de verdade; vale conferir o gráfico da aba "Evolução mensal" antes de tirar conclusão de um número só aqui. Queda >${Math.abs(TREND_OLEO_QUEDA)}%/ano de óleo E alta >${TREND_RGO_ALTA}%/ano de RGO ao mesmo tempo = alerta.`,
  );
  renderRgoTrendTable(card, linhas);
  section.appendChild(card);

  const note = document.createElement('p');
  note.className = 'analytics-table-note';
  note.textContent = `Fonte: ${producaoData.fonte.nome}. RGO calculado aqui a partir de óleo e gás pré-sal do próprio boletim, não vem pronto da ANP.`;
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
  const rgoTrendSection = buildRgoTrendSection(producaoData);
  evolutionSection.hidden = true;
  rgoTrendSection.hidden = true;

  const pageSwitch = buildPageSwitch(
    [['mensal', 'Mês atual'], ['evolucao', 'Evolução mensal'], ['tendencia', 'Tendência RGO x produção']],
    (page) => {
      monthlySection.hidden = page !== 'mensal';
      evolutionSection.hidden = page !== 'evolucao';
      rgoTrendSection.hidden = page !== 'tendencia';
    },
  );
  wrapper.appendChild(pageSwitch);
  wrapper.appendChild(monthlySection);
  wrapper.appendChild(evolutionSection);
  wrapper.appendChild(rgoTrendSection);
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
