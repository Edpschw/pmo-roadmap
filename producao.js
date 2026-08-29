'use strict';

/* =========================================================================
   PMO Roadmap — Produção. Produção mensal de petróleo e gás natural dos
   campos do pré-sal, direto do Boletim da Produção de Petróleo e Gás
   Natural (BMP) da ANP (data/producao.json, gerado por
   scripts/parse_producao.py a partir do PDF oficial — ver esse script para
   atualizar com um mês novo). Diferente da aba Análises (que é STOIIP/
   volume in-place, do Plano de Desenvolvimento — um número fixo por
   jazida, não muda mês a mês): aqui é vazão de produção real, por mês.
   Infra de gráfico (tooltip, fmtNum, chartCard, barRow,
   CONTEXT_FIELD_COLOR) vem de shared.js — compartilhada com analises.js.
   ========================================================================= */

const PRODUCAO_URL = 'data/producao.json';

const MESES_PT = [
  '', 'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

const METRIC_KEYS = ['oleoPreSalBbld', 'oleoPosSalBbld', 'gasPreSalMm3d', 'gasPosSalMm3d', 'boedPreSal', 'boedPosSal'];

// Campo-base do boletim da ANP de cada projeto rastreado com produção
// própria — casado por SUBSTRING contra as chaves de data/producao.json
// (nome do campo como a ANP publica), não por igualdade exata. Motivo: a
// granularidade da tabela varia por edição do boletim — meses mais
// recentes trazem só "Atapu", outros trazem "Atapu" + "Oeste de Atapu" +
// "Anc_Norte_Atapu" (Área Não Contratada) como linhas separadas da MESMA
// jazida/contrato (confirmado pela ligação de poço->campo já usada no
// roadmap, ver contractOwnWells em shared.js: poços de Atapu citam
// "Atapu / Atapu_Eco / Anc_Norte_Atapu / Oeste De Atapu" juntos). Casar por
// substring soma essas sub-áreas automaticamente em qualquer mês, sem
// precisar listar cada variante à mão. Norte de Carcará é o único caso
// que soma duas jazidas por nome DIFERENTE ("Bacalhau Norte", dentro do
// CPP rastreado aqui, + "Bacalhau", Concessão anterior e fora dele) — "
// Bacalhau" como base já casa as duas por conter a substring, mesmo
// critério já usado no roadmap para "Poços Perfurados" desse contrato (ver
// v11 em shared.js: a jazida inteira é o que importa acompanhar). Os
// demais projetos em produção (Libra) não têm campo próprio no boletim —
// a produção de Libra/Mero sai inteira sob "Mero".
const PROJECT_FIELD_BASE = {
  'Búzios': 'Búzios',
  'Mero': 'Mero',
  'Itapu': 'Itapu',
  'Sépia': 'Sépia',
  'Atapu': 'Atapu',
  'Entorno de Sapinhoá': 'Sapinhoá',
  'Norte de Carcará': 'Bacalhau',
};

const UNITS = {
  oleo: { label: 'Petróleo (bbl/d)', key: 'oleoPreSalBbld', fmt: (n) => fmtNum(n) + ' bbl/d' },
  gas: { label: 'Gás natural (Mm³/d)', key: 'gasPreSalMm3d', fmt: (n) => fmtNum(n, { maximumFractionDigits: 1 }) + ' Mm³/d' },
  boe: { label: 'Produção (boe/d)', key: 'boedPreSal', fmt: (n) => fmtNum(n) + ' boe/d' },
  rgo: { label: 'RGO (m³/m³)', key: 'rgo', fmt: (n) => fmtNum(n) + ' m³/m³' },
};

function emptyMetrics() {
  const m = {};
  for (const k of METRIC_KEYS) m[k] = 0;
  return m;
}

// RGO (Razão Gás-Óleo) = volume de gás produzido / volume de óleo
// produzido, os dois em m³ — mesma unidade que a indústria usa pra
// caracterizar um campo (Búzios ~270 m³/m³, por exemplo). O boletim vem
// em bbl/d (óleo) e "Mm³/d" (gás) — aqui "M" é "mil" (milhares de m³/dia),
// não "mega" (milhões): dá pra confirmar pelo total do pré-sal no
// boletim (~150 mil m³/d em dez/2025) — se fosse milhão, seria mais gás
// só no pré-sal brasileiro do que o mundo inteiro produz. Por isso o
// fator aqui é ×1.000 (não ×1.000.000) pra converter gás pra m³/d puro;
// óleo usa a conversão padrão de 1 bbl = 0,158987 m³. Sempre calculado a
// partir dos volumes JÁ somados (nunca soma/média de RGO direto — RGO é
// uma razão, não dá pra somar razão entre campos ou meses).
const BBL_TO_M3 = 0.158987;
function computeRGO(oleoBbld, gasMm3d) {
  const oleoM3 = oleoBbld * BBL_TO_M3;
  if (oleoM3 <= 0) return 0;
  return (gasMm3d * 1000) / oleoM3;
}

// Fusão de campo de CONTEXTO fragmentado em mais de uma linha pelo próprio
// boletim — mesma ideia de "a jazida inteira é o que importa acompanhar"
// já usada em PROJECT_FIELD_BASE (contratos rastreados), aqui por
// igualdade de nome já normalizado (ver scripts/producao_common.py
// normalize_field_name — data/producao.json já chega limpo de sufixo de
// regime/nota de rodapé, então essa função só cuida de fusão de JAZIDA,
// não de variação de grafia):
//   - "Anc_X" (Área Não Contratada) funde no campo "X" (primeiro pedaço
//     depois de "Anc_") — mesmo padrão já usado pra Anc_Norte_Atapu/
//     Anc_Mero nos contratos rastreados (esses dois já caem no contrato
//     certo por substring, antes de chegar aqui) — só quando "X" já é
//     nome de outro campo em ALGUM mês do boletim inteiro (não só do mês
//     sendo processado agora: "Tupi" e "Anc_Tupi" nem sempre aparecem
//     juntos no mesmo mês — de jan/2024 a jun/2025 o boletim só lista
//     "Anc_Tupi", sem "Tupi" separado naquele período — então o alvo
//     precisa vir do conjunto de nomes de TODO o histórico, ver
//     allFieldNames, senão "Anc_Tupi" vira linha própria só nesses meses).
//     Sem alvo confirmado em nenhum mês (ex.: Anc_Brava/Anc_Forno, sem
//     campo "Brava"/"Forno" avulso no boletim inteiro), fica como está.
//   - Sul de Berbigão funde em Berbigão — mesmo PD (berbigao.pdf,
//     "Berbigão, Norte de Berbigão e Sul de Berbigão 2025" em data/
//     planos_desenvolvimento.json), Sul de Tupi NÃO funde em Tupi (PD
//     próprio, sul-de-lula.pdf — campo satélite diferente, só o nome
//     mudou junto quando Lula virou Tupi em 2019, ver normalize_field_name).
const CONTEXT_JAZIDA_ALIAS = {
  'Sul de Berbigão': 'Berbigão',
};
function contextJazidaBase(name, knownNames) {
  if (CONTEXT_JAZIDA_ALIAS[name]) return CONTEXT_JAZIDA_ALIAS[name];
  if (name.startsWith('Anc_')) {
    const base = name.slice(4).split('_')[0];
    if (knownNames.has(base)) return base;
  }
  return name;
}

/* ------------------------------ Linhas por campo -------------------------- */

// Um projeto rastreado por campo-base (soma por substring, ver
// PROJECT_FIELD_BASE) mapeado; os demais campos do boletim (Tupi,
// Berbigão, Jubarte, Lapa...) entram como contexto — mesmo campo pré-sal,
// mas fora dos 30 contratos de partilha rastreados neste app
// (Concessão/Cessão Onerosa sem CPP próprio nesta lista), mesmo padrão de
// contexto usado em analises.js, com fusão por jazida (ver
// contextJazidaBase) quando o próprio boletim traz mais de um nome pra
// mesma jazida. "campos" tem o mesmo formato num mês só (data/
// producao.json) ou já com métricas médias de um ano (ver averageCampos)
// — esta função não distingue os dois.
// Nomes de campo (já normalizados, ver data/producao.json) vistos em
// QUALQUER mês do boletim — usado por contextJazidaBase pra achar o alvo
// de fusão de um "Anc_X" mesmo em meses onde "X" não aparece sozinho.
function allFieldNames(meses) {
  const names = new Set();
  for (const mes of meses) {
    for (const nome of Object.keys(mes.campos)) names.add(nome);
  }
  return names;
}

function computeFieldRows(campos, projects, knownNames) {
  const usedFieldNames = new Set();
  const rows = [];

  for (const p of projects) {
    const base = PROJECT_FIELD_BASE[p.name];
    if (!base) continue;
    const parts = Object.keys(campos).filter((n) => n.includes(base)).map((n) => ({ nome: n, dados: campos[n] }));
    if (!parts.length) continue;
    parts.forEach((part) => usedFieldNames.add(part.nome));
    const sum = emptyMetrics();
    for (const part of parts) {
      for (const k of METRIC_KEYS) sum[k] += part.dados[k];
    }
    rows.push({
      name: projectDisplayName(p.name),
      color: p.color,
      isContract: true,
      parts,
      ...sum,
      rgo: computeRGO(sum.oleoPreSalBbld, sum.gasPreSalMm3d),
    });
  }

  const contextGroups = new Map();
  for (const [nome, dados] of Object.entries(campos)) {
    if (usedFieldNames.has(nome)) continue;
    const jazida = contextJazidaBase(nome, knownNames);
    if (!contextGroups.has(jazida)) contextGroups.set(jazida, []);
    contextGroups.get(jazida).push({ nome, dados });
  }
  for (const [jazida, parts] of contextGroups) {
    // Um grupo com UM SÓ pedaço, e esse pedaço é só a Área Não Contratada
    // ("Anc_X", renomeada pra "X" por contextJazidaBase) sem o campo "X"
    // em si nem nenhuma outra sub-área junto: a ANC sozinha é sempre só
    // uma fração do campo (por definição, é a parte FORA do contrato) —
    // um mês assim não tem o total do campo publicado no boletim, só esse
    // fragmento. Mostrar isso com o nome do campo inteiro ("Tupi") daria
    // a impressão de produção quase zero num mês em que na verdade o
    // boletim simplesmente não trouxe o total (ex.: jan/2024 — só
    // "Anc_Tupi", ~3 mil bbl/d, contra os ~750-850 mil bbl/d normais de
    // Tupi) — melhor não ter o ponto nesse mês (linha corta ali, ver
    // buildSegments) do que ter um número enganoso.
    if (parts.length === 1 && parts[0].nome.toLowerCase().startsWith('anc_') && jazida !== parts[0].nome) {
      continue;
    }
    const sum = emptyMetrics();
    for (const part of parts) {
      for (const k of METRIC_KEYS) sum[k] += part.dados[k];
    }
    rows.push({
      name: jazida,
      color: CONTEXT_FIELD_COLOR,
      isContract: false,
      parts,
      ...sum,
      rgo: computeRGO(sum.oleoPreSalBbld, sum.gasPreSalMm3d),
    });
  }

  return rows;
}

/* ------------------------------ Série mensal -------------------------------- */
// "produção diária por mês" — sem agregação nenhuma: um ponto por mês do
// boletim, com o valor exatamente como a ANP publicou naquele mês (bbl/d,
// Mm³/d ou boe/d — já é uma vazão diária, não precisa converter nada).
// Campos de contexto (fora dos 7 contratos rastreados) ficam SEPARADOS,
// uma linha por campo, cada um com cor própria (hash do nome, ver
// colorForCompany em shared.js — não é cor de marca, só um jeito
// determinístico de dar uma cor distinta pra cada nome sem expandir a
// paleta) — diferente do gráfico "Mês atual" (barras), que já mostrava
// cada campo de contexto separado desde o início.
function computeMonthlySeries(meses, projects) {
  const knownNames = allFieldNames(meses);
  return meses.map((mes) => {
    const rows = computeFieldRows(mes.campos, projects, knownNames).map((r) => (
      r.isContract ? r : { ...r, color: colorForCompany(r.name) }
    ));
    return { ano: mes.ano, mes: mes.mes, rows };
  });
}

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

/* ------------------------------ Seletor de unidade ------------------------- */

function buildUnitSwitch(onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'scale-switch analytics-tab-switch';
  Object.entries(UNITS).forEach(([key, u], i) => {
    const btn = document.createElement('button');
    btn.className = 'scale-btn' + (i === 0 ? ' active' : '');
    btn.textContent = u.label;
    btn.dataset.unit = key;
    wrap.appendChild(btn);
  });
  wrap.addEventListener('click', (e) => {
    const btn = e.target.closest('.scale-btn');
    if (!btn) return;
    wrap.querySelectorAll('.scale-btn').forEach((b) => b.classList.toggle('active', b === btn));
    onChange(btn.dataset.unit);
  });
  return wrap;
}

/* ------------------------------ Gráfico de linhas --------------------------- */
// Uma linha por campo — eixo x é o mês do boletim, eixo y é a vazão diária
// na unidade escolhida. Interativo:
//  - roda do mouse: zoom no eixo x, ancorado no cursor (mesmo padrão do
//    roadmap principal, ver app.js);
//  - arrastar: move a janela visível (só depois de já ter dado zoom);
//  - clicar num campo na legenda: isola aquela linha (as outras ficam
//    esmaecidas) — clicar de novo no mesmo campo, ou num campo diferente,
//    troca/limpa o isolamento;
//  - passar o mouse sobre o gráfico: mostra o valor de TODOS os campos
//    daquele mês de uma vez (não só o campo sob o cursor), com uma linha
//    vertical marcando o mês.

const MES_ABREV = ['', 'jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const LINE_W = 900;
const LINE_H = 460;
const LINE_MARGIN = { top: 16, right: 16, bottom: 62, left: 64 };
const MIN_VIEW_SPAN = 2; // menor janela de zoom, em nº de meses - 1

function niceMax(v) {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

// Ordem fixa das linhas (mesma cor sempre no mesmo campo entre trocas de
// unidade) — projeto rastreado por ordem de aparição em state.projects
// (mesma ordem do roadmap/análises), depois os campos de contexto por
// ordem de primeira aparição no boletim.
function seriesOrder(monthlySeries) {
  const seen = new Map();
  for (const m of monthlySeries) {
    for (const r of m.rows) {
      if (!seen.has(r.name)) seen.set(r.name, r);
    }
  }
  const names = [...seen.keys()];
  const contract = names.filter((n) => seen.get(n).isContract);
  const context = names.filter((n) => !seen.get(n).isContract);
  return [...contract, ...context];
}

// Quebra os pontos de uma série em trechos contínuos, cortando onde o mês
// não tem dado (campo de contexto que só aparece em algumas edições, ver
// nota em computeMonthlySeries) — sem isso um <polyline> ligaria os dois
// lados do buraco com uma reta enganosa.
function buildSegments(monthlySeries, loIdx, hiIdx, name, xAt, yAt, unitKey) {
  const segments = [];
  let current = [];
  for (let i = loIdx; i <= hiIdx; i++) {
    const r = monthlySeries[i].rows.find((row) => row.name === name);
    if (!r) {
      if (current.length) segments.push(current);
      current = [];
      continue;
    }
    current.push(`${xAt(i)},${yAt(r[unitKey])}`);
  }
  if (current.length) segments.push(current);
  return segments;
}

function createLineChart(container, monthlySeries) {
  const n = monthlySeries.length;
  const order = seriesOrder(monthlySeries);
  const meta = new Map(order.map((name) => {
    const sample = monthlySeries.map((m) => m.rows.find((r) => r.name === name)).find(Boolean);
    return [name, { color: sample.color, isContract: sample.isContract }];
  }));

  let unitKey = 'oleo';
  let viewStart = 0;
  let viewEnd = n - 1;
  let yMaxOverride = null; // null = auto-ajusta ao máximo visível (ver draw)
  let highlighted = null;
  // Estado do arraste (pan) precisa sobreviver a um redraw no meio do
  // próprio arraste — draw() troca svgWrap.innerHTML a cada pointermove
  // durante o drag, o que recria #lc-capture do zero e derruba a captura
  // de ponteiro do elemento antigo (removido do DOM). Por isso mora aqui
  // fora, não redeclarado dentro de draw(): dragPointerId é reusado logo
  // depois de cada redraw pra recapturar o ponteiro no elemento novo (ver
  // final de draw()), e um pointerup/pointercancel na window (não só no
  // elemento de captura, que pode já ter sido trocado) garante que
  // isDragging sempre volta a false, mesmo se a recaptura falhar.
  let isDragging = false;
  let dragPointerId = null;
  let dragStartClientX = 0;
  let dragStartView = [0, 0];
  window.addEventListener('pointerup', () => { isDragging = false; dragPointerId = null; });
  window.addEventListener('pointercancel', () => { isDragging = false; dragPointerId = null; });

  const svgWrap = document.createElement('div');
  svgWrap.style.position = 'relative';
  const legendWrap = document.createElement('div');
  legendWrap.style.marginTop = '10px';

  function clampView(start, end) {
    let span = Math.max(end - start, MIN_VIEW_SPAN);
    span = Math.min(span, n - 1);
    if (start < 0) { start = 0; end = start + span; }
    if (end > n - 1) { end = n - 1; start = end - span; }
    return [start, end];
  }

  function draw() {
    const unit = UNITS[unitKey];
    const plotW = LINE_W - LINE_MARGIN.left - LINE_MARGIN.right;
    const plotH = LINE_H - LINE_MARGIN.top - LINE_MARGIN.bottom;
    const span = Math.max(viewEnd - viewStart, 0.001);
    const xAt = (i) => LINE_MARGIN.left + ((i - viewStart) / span) * plotW;
    const idxAt = (px) => viewStart + ((px - LINE_MARGIN.left) / plotW) * span;
    const loIdx = Math.max(0, Math.floor(viewStart));
    const hiIdx = Math.min(n - 1, Math.ceil(viewEnd));

    let rawMax = 0;
    for (let i = loIdx; i <= hiIdx; i++) {
      for (const r of monthlySeries[i].rows) rawMax = Math.max(rawMax, r[unit.key]);
    }
    const autoMax = niceMax(rawMax);
    // yMaxOverride persiste entre trocas de unidade/pan/zoom em x até o
    // usuário resetar ("Ver tudo") — dar zoom em x não desfaz um zoom em y
    // já ajustado, e vice-versa (são eixos independentes).
    const maxVal = yMaxOverride !== null ? yMaxOverride : autoMax;
    const yAt = (v) => LINE_MARGIN.top + plotH - (v / maxVal) * plotH;

    const yTicks = 5;
    let gridSvg = '';
    for (let i = 0; i <= yTicks; i++) {
      const v = (maxVal / yTicks) * i;
      const y = yAt(v);
      gridSvg += `<line x1="${LINE_MARGIN.left}" y1="${y}" x2="${LINE_W - LINE_MARGIN.right}" y2="${y}" stroke="var(--border)" stroke-width="1" />`;
      gridSvg += `<text x="${LINE_MARGIN.left - 10}" y="${y + 4}" text-anchor="end" font-size="11" style="fill:var(--text-faint)">${fmtNum(v)}</text>`;
    }

    // Rótulo do eixo x: se a janela visível já é curta (zoom), rotula todo
    // mês visível; senão só janeiro de cada ano (+ o último mês) — mesmo
    // motivo de antes (>100 pontos no zoom "tudo" ficaria ilegível mês a
    // mês), mas dando zoom o usuário já pediu pra ver o detalhe mensal.
    const dense = span <= 15;
    let xLabelsSvg = '';
    for (let i = loIdx; i <= hiIdx; i++) {
      const m = monthlySeries[i];
      const isLast = i === n - 1;
      if (!dense && m.mes !== 1 && !isLast) continue;
      const x = xAt(i);
      const label = (!dense && m.mes === 1) ? String(m.ano) : `${MES_ABREV[m.mes]}/${String(m.ano).slice(2)}`;
      const y = LINE_MARGIN.top + plotH + 14;
      if (!dense && m.mes === 1) {
        xLabelsSvg += `<line x1="${x}" y1="${LINE_MARGIN.top}" x2="${x}" y2="${LINE_MARGIN.top + plotH}" stroke="var(--border)" stroke-width="1" stroke-dasharray="2,3" />`;
      }
      xLabelsSvg += `<text x="0" y="0" transform="translate(${x} ${y}) rotate(-45)" text-anchor="end" font-size="${dense ? 10 : 11}" style="fill:var(--text-muted)">${escapeHtml(label)}</text>`;
    }

    let linesSvg = '';
    const dotR = span > 40 ? 1.6 : span > 15 ? 2.2 : 3;
    for (const name of order) {
      const { color, isContract } = meta.get(name);
      const dimmed = highlighted && highlighted !== name;
      const opacity = dimmed ? 0.12 : 1;
      const width = highlighted === name ? 3 : 2;
      const segments = buildSegments(monthlySeries, loIdx, hiIdx, name, xAt, yAt, unit.key);
      for (const seg of segments) {
        linesSvg += `<polyline points="${seg.join(' ')}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round" opacity="${opacity}" data-series="${escapeHtml(name)}" />`;
        if (seg.length === 1) {
          const [px, py] = seg[0].split(',');
          linesSvg += `<circle cx="${px}" cy="${py}" r="${dotR}" fill="${color}" opacity="${opacity}" />`;
        }
      }
      void isContract;
    }

    const axisSvg = `<line x1="${LINE_MARGIN.left}" y1="${LINE_MARGIN.top + plotH}" x2="${LINE_W - LINE_MARGIN.right}" y2="${LINE_MARGIN.top + plotH}" stroke="var(--border-strong)" stroke-width="1" />`;
    const captureSvg = `<rect id="lc-capture" x="${LINE_MARGIN.left}" y="${LINE_MARGIN.top}" width="${plotW}" height="${plotH}" fill="transparent" style="cursor:crosshair" />`;
    // Faixa invisível sobre os rótulos do eixo y — só pra indicar com o
    // cursor (ns-resize) que rolar o mouse ali zoom o eixo y, não o x; o
    // zoom em si é tratado no wheel handler abaixo (checa a posição do
    // cursor, não depende de qual elemento recebeu o evento).
    const yAxisHintSvg = `<rect x="0" y="${LINE_MARGIN.top}" width="${LINE_MARGIN.left}" height="${plotH}" fill="transparent" style="cursor:ns-resize" />`;
    const crosshairSvg = `<line id="lc-crosshair" x1="0" y1="${LINE_MARGIN.top}" x2="0" y2="${LINE_MARGIN.top + plotH}" stroke="var(--text-faint)" stroke-width="1" hidden />`;

    svgWrap.innerHTML = `<svg viewBox="0 0 ${LINE_W} ${LINE_H}" style="width:100%;height:auto;display:block;touch-action:none">${gridSvg}${axisSvg}${xLabelsSvg}${linesSvg}${crosshairSvg}${captureSvg}${yAxisHintSvg}</svg>`;
    const svgEl = svgWrap.firstElementChild;
    const capture = svgEl.querySelector('#lc-capture');
    const crosshair = svgEl.querySelector('#lc-crosshair');

    // Redraw no meio de um arraste (ver isDragging lá em cima) troca este
    // elemento por um novo — recaptura o ponteiro nele pra continuar
    // seguindo o cursor fora da área do gráfico sem esperar o mouse voltar
    // pra cima do retângulo.
    if (isDragging && dragPointerId != null) {
      try { capture.setPointerCapture(dragPointerId); } catch (err) { /* elemento novo, ponteiro pode já ter soltado — arraste some, próximo pointerup na window ainda limpa isDragging */ }
    }

    // Zoom: roda do mouse sobre a área do gráfico dá zoom no eixo x
    // (tempo), ancorado no cursor (mesma ideia do zoom do roadmap
    // principal — ver MIN_PX_PER_DAY/wheel handler em app.js); roda sobre
    // a faixa de rótulos do eixo y (à esquerda da área do gráfico) dá
    // zoom só no eixo y — a base (0) fica fixa, só o teto visível muda,
    // pra não inventar uma linha de base que não é zero num gráfico de
    // vazão. Os dois eixos são independentes: zoom em um não reseta o
    // outro (só "Ver tudo" reseta os dois). Não deixa a página rolar
    // enquanto o mouse está sobre o gráfico.
    svgEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      const pt = svgPoint(svgEl, e.clientX, e.clientY);
      const factor = e.deltaY > 0 ? 1.25 : 1 / 1.25;
      if (pt.x < LINE_MARGIN.left) {
        const base = yMaxOverride !== null ? yMaxOverride : autoMax;
        const floor = Math.max(rawMax * 0.02, 1);
        yMaxOverride = Math.max(floor, base * factor);
        draw();
        return;
      }
      const cursorIdx = clampIdx(idxAt(pt.x));
      let newSpan = span * factor;
      newSpan = Math.max(MIN_VIEW_SPAN, Math.min(n - 1, newSpan));
      const frac = span > 0 ? (cursorIdx - viewStart) / span : 0.5;
      let newStart = cursorIdx - frac * newSpan;
      let newEnd = newStart + newSpan;
      [viewStart, viewEnd] = clampView(newStart, newEnd);
      draw();
    }, { passive: false });

    // Arrastar: move a janela visível — só ativa dentro da área do
    // gráfico, com pointer capture pra continuar recebendo o movimento
    // mesmo se o cursor sair da área durante o arraste (recapturada a
    // cada redraw no elemento novo, ver logo acima). dragStartClientX/
    // dragStartView moram fora de draw() (topo de createLineChart) pra
    // não resetar a cada um desses redraws no meio do próprio arraste.
    capture.addEventListener('pointerdown', (e) => {
      isDragging = true;
      dragPointerId = e.pointerId;
      dragStartClientX = e.clientX;
      dragStartView = [viewStart, viewEnd];
      try { capture.setPointerCapture(e.pointerId); } catch (err) { /* ponteiro sintético (ex.: teste automatizado) sem sessão ativa pra capturar — arraste ainda funciona sem, só não segue o cursor fora da área do gráfico */ }
      hideTooltip();
      if (crosshair) crosshair.hidden = true;
    });
    capture.addEventListener('pointermove', (e) => {
      if (isDragging) {
        const dxPx = e.clientX - dragStartClientX;
        const dxIdx = -(dxPx / plotW) * (dragStartView[1] - dragStartView[0]);
        [viewStart, viewEnd] = clampView(dragStartView[0] + dxIdx, dragStartView[1] + dxIdx);
        draw();
        return;
      }
      const pt = svgPoint(svgEl, e.clientX, e.clientY);
      const idx = clampIdx(Math.round(idxAt(pt.x)));
      showCrosshair(idx, xAt, unit);
    });
    capture.addEventListener('pointerup', (e) => {
      isDragging = false;
      dragPointerId = null;
      try { capture.releasePointerCapture(e.pointerId); } catch (err) { /* idem — nada a liberar se a captura não pegou */ }
    });
    capture.addEventListener('pointerleave', () => {
      if (!isDragging) {
        hideTooltip();
        if (crosshair) crosshair.hidden = true;
      }
    });

    function showCrosshair(idx, xAtFn, unitObj) {
      if (!crosshair) return;
      const x = xAtFn(idx);
      crosshair.setAttribute('x1', x);
      crosshair.setAttribute('x2', x);
      crosshair.hidden = false;
      const m = monthlySeries[idx];
      const rows = [...m.rows].sort((a, b) => b[unitObj.key] - a[unitObj.key]);
      const html = `<strong>${escapeHtml(MESES_PT[m.mes])}/${m.ano}</strong>`
        + rows.map((r) => `<div class="viz-tooltip-row"><span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${r.color};margin-right:5px;vertical-align:middle"></span>${escapeHtml(r.name)}</span><strong>${escapeHtml(unitObj.fmt(r[unitObj.key]))}</strong></div>`).join('');
      const t = ensureTooltip();
      t.innerHTML = html;
      t.hidden = false;
      const rect = svgEl.getBoundingClientRect();
      const scale = rect.width / LINE_W;
      positionTooltip(rect.left + x * scale, rect.top + LINE_MARGIN.top * scale);
    }
  }

  function svgPoint(svgEl, clientX, clientY) {
    const rect = svgEl.getBoundingClientRect();
    const scale = LINE_W / rect.width;
    return { x: (clientX - rect.left) * scale, y: (clientY - rect.top) * scale };
  }
  function clampIdx(i) {
    return Math.max(0, Math.min(n - 1, i));
  }

  // Legenda em dois grupos — contratos de Partilha da Produção rastreados
  // (isContract: true) separados dos demais campos do pré-sal (contexto,
  // fora dos 7 rastreados) — mesma distinção que já colore as linhas
  // (cor do projeto x cor por hash do nome), só deixando explícito na
  // legenda pra não misturar contrato com campo de contexto na mesma
  // lista corrida.
  function legendGroup(title, names) {
    const group = document.createElement('div');
    if (!names.length) return group;
    const label = document.createElement('div');
    label.className = 'stat-tile-label';
    label.style.margin = '10px 0 4px';
    label.textContent = title;
    group.appendChild(label);
    const row = document.createElement('div');
    row.className = 'kpi-row';
    row.style.rowGap = '6px';
    for (const name of names) {
      const { color } = meta.get(name);
      const item = document.createElement('button');
      item.type = 'button';
      item.style.display = 'inline-flex';
      item.style.alignItems = 'center';
      item.style.gap = '6px';
      item.style.fontSize = '12px';
      item.style.background = 'none';
      item.style.border = 'none';
      item.style.padding = '2px 4px';
      item.style.cursor = 'pointer';
      item.style.color = highlighted && highlighted !== name ? 'var(--text-faint)' : 'var(--text-muted)';
      item.style.opacity = highlighted && highlighted !== name ? '0.5' : '1';
      item.innerHTML = `<span style="width:16px;height:2px;background:${color};flex:0 0 auto"></span>${escapeHtml(name)}`;
      item.addEventListener('click', () => {
        highlighted = highlighted === name ? null : name;
        drawLegend();
        draw();
      });
      row.appendChild(item);
    }
    group.appendChild(row);
    return group;
  }

  function drawLegend() {
    legendWrap.innerHTML = '';
    const contractNames = order.filter((name) => meta.get(name).isContract);
    const contextNames = order.filter((name) => !meta.get(name).isContract);
    legendWrap.appendChild(legendGroup('Partilha da Produção', contractNames));
    legendWrap.appendChild(legendGroup('Outros projetos', contextNames));
  }

  draw();
  drawLegend();
  container.appendChild(svgWrap);
  container.appendChild(legendWrap);

  return {
    setUnit(key) { unitKey = key; draw(); },
    resetZoom() { viewStart = 0; viewEnd = n - 1; yMaxOverride = null; draw(); },
    isZoomed() { return viewStart > 0 || viewEnd < n - 1 || yMaxOverride !== null; },
  };
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
  const unitSwitch = buildUnitSwitch((unitKey) => {
    const list = card.querySelector('.hbar-list');
    if (list) list.remove();
    renderProductionChart(card, rows, unitKey);
  });
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

  const chart = createLineChart(card, monthlySeries);
  const unitSwitch = buildUnitSwitch((unitKey) => chart.setUnit(unitKey));
  controlsRow.insertBefore(unitSwitch, resetBtn);
  resetBtn.addEventListener('click', () => chart.resetZoom());
  section.appendChild(card);

  const note = document.createElement('p');
  note.className = 'analytics-table-note';
  note.textContent = `Fonte: ${producaoData.fonte.nome}. De out/2017 a jun/2025, vem da planilha Excel oficial que acompanha o boletim (número de célula exato, sem risco de extração de texto); de jul/2025 em diante, do PDF (a ANP ainda não publicou o Excel desses meses). Antes de out/2017 a ANP não publicava essa tabela por campo. Meses faltando no meio do período são edições sem o arquivo correspondente disponível no site da ANP.`;
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
