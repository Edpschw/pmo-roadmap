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

// Campo(s) do boletim da ANP que compõem cada projeto rastreado com
// produção própria. Nomes batem exatamente com as chaves de
// data/producao.json (nome do campo como a ANP publica). Norte de Carcará
// soma os dois lados da jazida (Bacalhau Norte, dentro do CPP rastreado
// aqui, + Bacalhau, Concessão anterior e fora dele) — mesmo critério já
// usado no roadmap para "Poços Perfurados" desse contrato (ver v11 em
// shared.js: a jazida inteira é o que importa acompanhar, não só a metade
// sob partilha). Os demais projetos em produção (Libra) não têm campo
// próprio no boletim — a produção de Libra/Mero sai inteira sob "Mero".
const PROJECT_FIELDS = {
  'Búzios': ['Búzios'],
  'Mero': ['Mero'],
  'Itapu': ['Itapu'],
  'Sépia': ['Sépia'],
  'Atapu': ['Atapu'],
  'Entorno de Sapinhoá': ['Sapinhoá'],
  'Norte de Carcará': ['Bacalhau Norte', 'Bacalhau'],
};

const UNITS = {
  oleo: { label: 'Petróleo (bbl/d)', key: 'oleoPreSalBbld', fmt: (n) => fmtNum(n) + ' bbl/d' },
  gas: { label: 'Gás natural (Mm³/d)', key: 'gasPreSalMm3d', fmt: (n) => fmtNum(n, { maximumFractionDigits: 1 }) + ' Mm³/d' },
  boe: { label: 'Produção (boe/d)', key: 'boedPreSal', fmt: (n) => fmtNum(n) + ' boe/d' },
};

/* ------------------------------ Linhas por campo -------------------------- */

// Um projeto rastreado por campo (ou soma de campos, ver PROJECT_FIELDS)
// mapeado; os demais campos do boletim (Tupi, Berbigão, Jubarte, Lapa...)
// entram como contexto — mesmo campo pré-sal, mas fora dos 30 contratos de
// partilha rastreados neste app (Concessão/Cessão Onerosa sem CPP próprio
// nesta lista), mesmo padrão de contexto usado em analises.js.
function computeFieldRows(campos, projects) {
  const usedFieldNames = new Set();
  const rows = [];

  for (const p of projects) {
    const fieldNames = PROJECT_FIELDS[p.name];
    if (!fieldNames) continue;
    const parts = fieldNames.filter((n) => campos[n]).map((n) => ({ nome: n, dados: campos[n] }));
    if (!parts.length) continue;
    parts.forEach((part) => usedFieldNames.add(part.nome));
    const sum = { oleoPreSalBbld: 0, oleoPosSalBbld: 0, gasPreSalMm3d: 0, gasPosSalMm3d: 0, boedPreSal: 0, boedPosSal: 0 };
    for (const part of parts) {
      for (const k of Object.keys(sum)) sum[k] += part.dados[k];
    }
    rows.push({
      name: projectDisplayName(p.name),
      color: p.color,
      isContract: true,
      parts,
      ...sum,
    });
  }

  for (const [nome, dados] of Object.entries(campos)) {
    if (usedFieldNames.has(nome)) continue;
    rows.push({ name: nome, color: CONTEXT_FIELD_COLOR, isContract: false, parts: [{ nome, dados }], ...dados });
  }

  return rows;
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

/* ---------------------------------- Init ----------------------------------- */

async function init() {
  const wrapper = document.getElementById('producaoWrapper');
  let producaoData = null;
  try {
    producaoData = await fetch(PRODUCAO_URL).then((r) => r.json());
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

  const mesRef = producaoData.meses[producaoData.meses.length - 1];
  const rows = computeFieldRows(mesRef.campos, state.projects);

  const section = document.createElement('section');
  section.className = 'analytics-section';
  renderProducaoKpis(section, rows, mesRef);

  const card = chartCard(
    'Produção por campo — pré-sal',
    'Os contratos rastreados (cor do projeto) e os demais campos do pré-sal em produção fora desta lista (cinza, contexto). Só a fração pré-sal de cada campo — a fração pós-sal (quando existe) fica de fora.',
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

  wrapper.appendChild(section);
}

init();
