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
    const janelaPontos = pontos.length >= 24 ? pontos.slice(-24) : pontos;
    const oleoTrend = trendPctAoAno(janelaPontos.map((p) => p.oleo));
    const rgoTrend = trendPctAoAno(janelaPontos.map((p) => p.rgo));
    if (oleoTrend == null || rgoTrend == null) {
      linhas.push({ nome, isContract, color, meses: pontos.length, janela: janelaPontos.length, pontosJanela: janelaPontos, oleoTrend: null, rgoTrend: null });
      continue;
    }
    const alerta = oleoTrend < TREND_OLEO_QUEDA && rgoTrend > TREND_RGO_ALTA;
    linhas.push({
      nome, isContract, color,
      meses: pontos.length, janela: janelaPontos.length, pontosJanela: janelaPontos,
      oleoTrend, rgoTrend,
      oleoIni: janelaPontos[0].oleo, oleoFim: janelaPontos[janelaPontos.length - 1].oleo,
      rgoIni: janelaPontos[0].rgo, rgoFim: janelaPontos[janelaPontos.length - 1].rgo,
      alerta,
      observar: !alerta && (oleoTrend < 0 || rgoTrend > TREND_RGO_ALTA),
    });
  }
  // Alerta primeiro (pior tendência de óleo primeiro dentro do alerta),
  // depois "observar", depois o resto ordenado pela tendência de óleo (quem
  // mais cai por último a se preocupar vem primeiro) — sem histórico
  // suficiente vai pro final, já que não dá pra dizer nada sobre esses.
  return linhas.sort((a, b) => {
    if (a.oleoTrend == null && b.oleoTrend == null) return 0;
    if (a.oleoTrend == null) return 1;
    if (b.oleoTrend == null) return -1;
    if (a.alerta !== b.alerta) return a.alerta ? -1 : 1;
    if (a.observar !== b.observar) return a.observar ? -1 : 1;
    return a.oleoTrend - b.oleoTrend;
  });
}

// Comentário curto por campo — leitura de engenharia do gráfico (por que a
// tendência é ou não é sinal de maturidade de verdade), não dá pra derivar
// só do número da regressão. Escrito a partir do boletim de jun/2026 — como
// qualquer observação pontual neste app (ex.: participacaoObs), revisar
// quando a tendência mudar de forma perceptível.
const TREND_NOTES = {
  'Sapinhoá': 'Campo maduro (1º óleo em 2010, o mais antigo do pré-sal em produção). RGO no maior nível da série, subindo de forma consistente enquanto o óleo cai — o padrão clássico de reservatório perdendo pressão e "quebrando gás" (capa de gás avançando sobre a zona de óleo). Único ativo com os dois sinais juntos de forma sustentada, não um mês ruim isolado.',
  'Atapu': 'RGO subindo de forma real e visível mês a mês. O óleo ainda não caiu de forma estrutural — boa parte do número negativo da regressão vem de uma parada de manutenção no meio da janela (ver o ponto a ponto na aba "Evolução mensal"); fora esse buraco, a produção fica estável. Vale monitorar: se a RGO continuar subindo nesse ritmo, a queda de óleo pode aparecer de verdade.',
  'Itapu': 'RGO subiu bastante e depois reverteu dentro da própria janela — não é uma tendência sustentada, mais provável ajuste operacional (gas lift/choke) do que depleção. Óleo estável o tempo todo, sem nenhum sinal de queda.',
  'Sépia': 'Óleo e RGO caem juntos — não é o padrão de maturidade (RGO caindo é bom sinal, não ruim). Mais provável ajuste operacional do que declínio de reservatório.',
};

function trendStatusPillHTML(l) {
  if (l.oleoTrend == null) return `<span class="trend-pill trend-pill-neutral">Histórico curto</span>`;
  if (l.alerta) return `<span class="trend-pill trend-pill-critical">Queda + RGO subindo</span>`;
  if (l.observar) return `<span class="trend-pill trend-pill-warning">Observar</span>`;
  return `<span class="trend-pill trend-pill-neutral">Estável/crescendo</span>`;
}

// Óleo e RGO indexados a 100 no início de `pontosJanela` e plotados no MESMO
// eixo (ver nota grande no topo do bloco de CSS .trend-*) — dá pra comparar
// a direção das duas tendências de forma direta, sem inventar um eixo
// secundário. endLabels desenha o valor real (bbl/d, m³/m³) ao lado do
// último ponto — só cabe nos gráficos maiores (destaque/observar); nos
// mini-gráficos da grade os valores reais ficam no HTML abaixo, não no SVG.
function renderTrendChartSVG(pontosJanela, { width, height, margin, endLabels }) {
  const base = { oleo: pontosJanela[0].oleo, rgo: pontosJanela[0].rgo };
  const oleoIdx = pontosJanela.map((p) => (p.oleo / base.oleo) * 100);
  const rgoIdx = pontosJanela.map((p) => (p.rgo / base.rgo) * 100);
  const all = oleoIdx.concat(rgoIdx);
  let yMin = Math.min(100, ...all);
  let yMax = Math.max(100, ...all);
  const pad = (yMax - yMin) * 0.15 || 10;
  yMin -= pad; yMax += pad;

  const xw = width - margin.left - margin.right;
  const yh = height - margin.top - margin.bottom;
  const n = pontosJanela.length;
  const xAt = (i) => margin.left + (n > 1 ? (i / (n - 1)) * xw : 0);
  const yAt = (v) => margin.top + yh - ((v - yMin) / (yMax - yMin)) * yh;
  const pathFor = (idxArr) => idxArr.map((v, i) => (i === 0 ? 'M' : 'L') + xAt(i).toFixed(1) + ',' + yAt(v).toFixed(1)).join(' ');

  const baseY = yAt(100);
  const lastX = xAt(n - 1);
  const oleoLastY = yAt(oleoIdx[n - 1]);
  const rgoLastY = yAt(rgoIdx[n - 1]);
  const first = pontosJanela[0], last = pontosJanela[n - 1];

  const endLabelsSvg = endLabels ? `
    <text x="${(lastX + 8).toFixed(1)}" y="${(oleoLastY + 4).toFixed(1)}" class="trend-end-label trend-end-label-oleo">${fmtNum(last.oleo / 1000)} kbbl/d</text>
    <text x="${(lastX + 8).toFixed(1)}" y="${(rgoLastY + 4).toFixed(1)}" class="trend-end-label trend-end-label-rgo">${fmtNum(last.rgo)} m³/m³</text>
  ` : '';

  return `<svg viewBox="0 0 ${width} ${height}" class="trend-svg" role="img" aria-label="Óleo e RGO indexados a 100, ${MESES_PT[first.mes]}/${first.ano} a ${MESES_PT[last.mes]}/${last.ano}">
    <line x1="${margin.left}" y1="${baseY.toFixed(1)}" x2="${lastX.toFixed(1)}" y2="${baseY.toFixed(1)}" class="trend-baseline" stroke-dasharray="2,3"/>
    <path d="${pathFor(oleoIdx)}" class="trend-line-oleo"/>
    <path d="${pathFor(rgoIdx)}" class="trend-line-rgo"/>
    <circle cx="${lastX.toFixed(1)}" cy="${oleoLastY.toFixed(1)}" r="${endLabels ? 4 : 3}" class="trend-dot-oleo"/>
    <circle cx="${lastX.toFixed(1)}" cy="${rgoLastY.toFixed(1)}" r="${endLabels ? 4 : 3}" class="trend-dot-rgo"/>
    <text x="${margin.left}" y="${height - 4}" class="trend-axis-label">${MES_ABREV[first.mes]}/${String(first.ano).slice(2)}</text>
    <text x="${lastX.toFixed(1)}" y="${height - 4}" text-anchor="end" class="trend-axis-label">${MES_ABREV[last.mes]}/${String(last.ano).slice(2)}</text>
    ${endLabelsSvg}
  </svg>`;
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
        <td>${trendStatusPillHTML(l)}</td>
      `;
      tbody.appendChild(tr);
      continue;
    }
    tr.innerHTML = `
      <td>${escapeHtml(l.nome)}</td>
      <td class="num">${l.meses}</td>
      <td class="num" style="${l.oleoTrend < 0 ? 'color:var(--danger)' : ''}">${l.oleoTrend >= 0 ? '+' : ''}${l.oleoTrend.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</td>
      <td class="num" style="${l.rgoTrend > TREND_RGO_ALTA ? 'color:var(--danger)' : ''}">${l.rgoTrend >= 0 ? '+' : ''}${l.rgoTrend.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</td>
      <td class="num">${fmtNum(l.oleoIni / 1000)} → ${fmtNum(l.oleoFim / 1000)}</td>
      <td class="num">${fmtNum(l.rgoIni, { maximumFractionDigits: 1 })} → ${fmtNum(l.rgoFim, { maximumFractionDigits: 1 })}</td>
      <td>${trendStatusPillHTML(l)}</td>
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
  const comObservar = linhas.filter((l) => l.observar);
  const estaveis = linhas.filter((l) => l.oleoTrend != null && !l.alerta && !l.observar);

  const section = document.createElement('section');
  section.className = 'analytics-section';

  const row = document.createElement('div');
  row.className = 'kpi-row';
  row.appendChild(statTile('Campos analisados', String(linhas.filter((l) => l.oleoTrend != null).length), 'com pelo menos 4 meses de produção, nos últimos 2 anos (24 meses) mais recentes'));
  row.appendChild(statTile('Queda + RGO subindo', String(comAlerta.length), comAlerta.length ? comAlerta.map((l) => l.nome).join(', ') : 'nenhum no momento'));
  row.appendChild(statTile('Observar', String(comObservar.length), comObservar.length ? comObservar.map((l) => l.nome).join(', ') : 'nenhum no momento'));
  row.appendChild(statTile('Estável/crescendo', String(estaveis.length), 'ramp-up de FPSO/poços novos'));
  section.appendChild(row);

  // ---- Destaque: o(s) campo(s) em alerta (ou, sem alerta nenhum, o pior
  // caso de "observar") — gráfico maior + comentário de engenharia ao lado.
  const destaque = comAlerta[0] || comObservar[0];
  if (destaque) {
    const destaqueCard = chartCard(destaque.alerta ? 'Alerta — o caso mais claro' : 'Destaque — o mais próximo de um alerta');
    const head = document.createElement('div');
    head.className = 'trend-featured-head';
    head.innerHTML = `<h4>${escapeHtml(destaque.nome)}</h4>${trendStatusPillHTML(destaque)}`;
    destaqueCard.appendChild(head);
    const legend = document.createElement('div');
    legend.className = 'trend-legend';
    legend.innerHTML = `
      <span class="trend-legend-item"><span class="trend-legend-swatch" style="background:var(--trend-oleo)"></span>Óleo (bbl/d)</span>
      <span class="trend-legend-item"><span class="trend-legend-swatch" style="background:var(--trend-rgo)"></span>RGO (m³/m³)</span>
      <span style="margin-left:auto;color:var(--text-faint)">ambos indexados a 100 no início da janela</span>
    `;
    destaqueCard.appendChild(legend);
    const body = document.createElement('div');
    body.className = 'trend-featured-body';
    const chartPane = document.createElement('div');
    chartPane.innerHTML = renderTrendChartSVG(destaque.pontosJanela, { width: 620, height: 280, margin: { top: 16, right: 96, bottom: 28, left: 6 }, endLabels: true });
    body.appendChild(chartPane);
    const notePane = document.createElement('div');
    notePane.className = 'trend-featured-note';
    const statRow = document.createElement('div');
    statRow.className = 'trend-stat-row';
    statRow.innerHTML = `
      <div class="trend-stat"><span class="n oleo">${destaque.oleoTrend >= 0 ? '+' : ''}${destaque.oleoTrend.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</span><span class="l">óleo, %/ano</span></div>
      <div class="trend-stat"><span class="n rgo">${destaque.rgoTrend >= 0 ? '+' : ''}${destaque.rgoTrend.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</span><span class="l">RGO, %/ano</span></div>
    `;
    notePane.appendChild(statRow);
    const noteP = document.createElement('p');
    noteP.textContent = TREND_NOTES[destaque.nome] || 'Sem comentário cadastrado pra este campo ainda.';
    notePane.appendChild(noteP);
    body.appendChild(notePane);
    destaqueCard.appendChild(body);
    section.appendChild(destaqueCard);
  }

  // ---- Observar: os demais campos com RGO subindo ou óleo caindo, mas sem
  // bater os dois limiares do alerta ao mesmo tempo.
  const watchList = comObservar.filter((l) => l !== destaque);
  if (watchList.length) {
    const watchCard = chartCard('Observar', 'RGO subindo ou óleo caindo, mas ainda sem os dois sinais juntos o bastante pra virar alerta.');
    const watchRow = document.createElement('div');
    watchRow.className = 'trend-watch-row';
    for (const l of watchList) {
      const card = document.createElement('div');
      card.className = 'trend-watch-card';
      card.innerHTML = `
        <div class="trend-watch-card-head"><h5>${escapeHtml(l.nome)}</h5>${trendStatusPillHTML(l)}</div>
        ${renderTrendChartSVG(l.pontosJanela, { width: 440, height: 160, margin: { top: 10, right: 84, bottom: 20, left: 4 }, endLabels: true })}
        <p>${escapeHtml(TREND_NOTES[l.nome] || '')}</p>
      `;
      watchRow.appendChild(card);
    }
    watchCard.appendChild(watchRow);
    section.appendChild(watchCard);
  }

  // ---- Painel completo: mini-gráfico por campo, mesma ordem da tabela.
  const gridCard = chartCard(
    'Painel completo — todos os campos',
    'Mesmo gráfico indexado, em miniatura, pra todos os campos analisados — inclusive os já destacados acima, pra comparar todo mundo lado a lado. Números reais abaixo de cada mini-gráfico.',
  );
  const grid = document.createElement('div');
  grid.className = 'trend-mini-grid';
  for (const l of linhas) {
    const card = document.createElement('div');
    card.className = 'trend-mini-card';
    if (l.oleoTrend == null) {
      card.innerHTML = `
        <div class="trend-mini-card-head"><h6>${escapeHtml(l.nome)}</h6>${trendStatusPillHTML(l)}</div>
        <p style="font-size:11px;color:var(--text-faint);margin:0">Só ${l.meses} mês(es) de produção — histórico curto demais.</p>
      `;
      grid.appendChild(card);
      continue;
    }
    card.innerHTML = `
      <div class="trend-mini-card-head"><h6>${escapeHtml(l.nome)}</h6>${trendStatusPillHTML(l)}</div>
      ${renderTrendChartSVG(l.pontosJanela, { width: 280, height: 100, margin: { top: 8, right: 4, bottom: 16, left: 4 }, endLabels: false })}
      <div class="trend-mini-figures">
        <div class="trend-mini-figure"><span class="n oleo">${l.oleoTrend >= 0 ? '+' : ''}${l.oleoTrend.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</span><span class="l">Óleo/ano</span></div>
        <div class="trend-mini-figure"><span class="n rgo">${l.rgoTrend >= 0 ? '+' : ''}${l.rgoTrend.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</span><span class="l">RGO/ano</span></div>
      </div>
    `;
    grid.appendChild(card);
  }
  gridCard.appendChild(grid);
  renderRgoTrendTable(gridCard, linhas);
  section.appendChild(gridCard);

  const note = document.createElement('p');
  note.className = 'analytics-table-note';
  note.textContent = `Fonte: ${producaoData.fonte.nome}. RGO calculado aqui a partir de óleo e gás pré-sal do próprio boletim, não vem pronto da ANP. Tendência = inclinação da reta de mínimos quadrados sobre os últimos 2 anos (24 meses) com óleo pré-sal > 0 — campo com menos de 2 anos de produção usa o histórico inteiro que tiver —, normalizada em %/ano em relação à média da própria série (compara campo grande e pequeno). Alerta = queda de óleo > ${Math.abs(TREND_OLEO_QUEDA)}%/ano E alta de RGO > ${TREND_RGO_ALTA}%/ano ao mesmo tempo — uma tendência negativa isolada pode vir de manutenção de FPSO no meio da janela, não de declínio real; ver o ponto a ponto na aba "Evolução mensal" antes de agir sobre um número só daqui.`;
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
