'use strict';

/* =========================================================================
   PMO Roadmap — Dados. Inventário de todo arquivo em data/ usado pelo app,
   pra controle de qualidade: o que cada um é, de onde vem, quanto cobre,
   e onde tem buraco — sem recalcular nada que já existe em outra aba, só
   somando/tabelando o que os outros arquivos JS já leem. Cada entrada de
   DATASETS sabe fazer seu próprio parse() porque o "significado de um
   registro" varia por arquivo (mês, poço, campo, feature de mapa...) —
   não dá pra generalizar isso num contador só.
   ========================================================================= */

// noStore: mesmo critério do resto do app — arquivo reprocessado sem
// deploy de código junto (produção/poços/injeção) precisa de no-store;
// cadastro/geojson/PD mudam raro, cache normal serve.
const DATASETS = [
  {
    path: 'data/producao.json', label: 'Produção mensal por campo', noStore: true,
    parse(d) {
      // Só campo pré-sal fica no arquivo desde a limpeza feita em scripts/
      // parse_producao_zona.py (strip_pos_sal_only_fields, ver nota 4 no
      // topo do script) — antes disso o arquivo trazia ~380 campos 100%
      // pós-sal "de passagem" do mesmo dado aberto (9,2MB -> 960KB depois
      // de limpo). Ainda existem entradas campo×mês com oleoPosSalBbld/
      // gasPosSalMm3d > 0 (a fração pós-sal do MESMO campo pré-sal, num mês
      // específico) — só não existe mais campo que NUNCA teve pré-sal.
      const campos = new Set();
      for (const m of d.meses) for (const nome of Object.keys(m.campos)) campos.add(nome);
      return {
        fonte: (d.fonte && d.fonte.nome) || '—',
        registros: `${d.meses.length} meses, ${campos.size} campos distintos`,
        periodo: periodoDe(d.meses),
        gaps: findGaps(d.meses),
      };
    },
    table: {
      monthly: true,
      monthsOf: (d) => d.meses,
      columns: ['Campo', 'Óleo pré-sal (bbl/d)', 'Óleo pós-sal (bbl/d)', 'Gás pré-sal (Mm³/d)', 'Gás pós-sal (Mm³/d)', 'BOE pré-sal (boe/d)', 'BOE pós-sal (boe/d)', 'RGO pré-sal (m³/m³)'],
      rowsFor(d, key) {
        const mes = d.meses.find((m) => `${m.ano}-${m.mes}` === key);
        if (!mes) return [];
        return Object.entries(mes.campos).sort((a, b) => a[0].localeCompare(b[0], 'pt-BR')).map(([nome, v]) => [
          nome,
          fmtNum(v.oleoPreSalBbld), fmtNum(v.oleoPosSalBbld),
          fmtNum(v.gasPreSalMm3d, { maximumFractionDigits: 1 }), fmtNum(v.gasPosSalMm3d, { maximumFractionDigits: 1 }),
          fmtNum(v.boedPreSal), fmtNum(v.boedPosSal),
          fmtNum(computeRGO(v.oleoPreSalBbld, v.gasPreSalMm3d)),
        ]);
      },
    },
  },
  {
    path: 'data/producao_pocos_serie.json', label: 'Produção mensal por poço (óleo + gás)', noStore: true,
    parse(d) {
      const pocos = new Set();
      let comGas = 0;
      for (const m of d.meses) {
        for (const [nome, v] of Object.entries(m.pocos)) {
          pocos.add(nome);
          if (v.gasMm3d != null) comGas++;
        }
      }
      return {
        fonte: (d.fonte && d.fonte.nome) || '—',
        registros: `${d.meses.length} meses, ${pocos.size} poços distintos (${comGas} registros mês×poço com gás, pra RGO)`,
        periodo: periodoDe(d.meses),
        gaps: findGaps(d.meses),
      };
    },
    table: {
      monthly: true,
      monthsOf: (d) => d.meses,
      columns: ['Poço', 'Óleo (bbl/d)', 'Gás (Mm³/d)', 'RGO (m³/m³)'],
      rowsFor(d, key) {
        const mes = d.meses.find((m) => `${m.ano}-${m.mes}` === key);
        if (!mes) return [];
        return Object.entries(mes.pocos).sort((a, b) => a[0].localeCompare(b[0], 'pt-BR')).map(([nome, v]) => [
          nome,
          fmtNum(v.oleoBbld),
          v.gasMm3d != null ? fmtNum(v.gasMm3d, { maximumFractionDigits: 1 }) : '—',
          v.gasMm3d != null ? fmtNum(computeRGO(v.oleoBbld, v.gasMm3d)) : '—',
        ]);
      },
    },
  },
  {
    path: 'data/producao_injecao.json', label: 'Injeção mensal de água/gás por campo', noStore: true,
    parse(d) {
      const campos = new Set();
      for (const m of d.meses) for (const nome of Object.keys(m.campos)) campos.add(nome);
      return {
        fonte: (d.fonte && d.fonte.nome) || '—',
        registros: `${d.meses.length} meses, ${campos.size} campos distintos`,
        periodo: periodoDe(d.meses),
        gaps: findGaps(d.meses),
      };
    },
    table: {
      monthly: true,
      monthsOf: (d) => d.meses,
      columns: ['Campo', 'Água injetada (m³/d)', 'Gás injetado (Mil m³/d)'],
      rowsFor(d, key) {
        const mes = d.meses.find((m) => `${m.ano}-${m.mes}` === key);
        if (!mes) return [];
        return Object.entries(mes.campos).sort((a, b) => a[0].localeCompare(b[0], 'pt-BR')).map(([nome, v]) => [
          nome, fmtNum(v.aguaInjM3d), fmtNum(v.gasInjMm3d, { maximumFractionDigits: 1 }),
        ]);
      },
    },
  },
  {
    path: 'data/producao_pocos.json', label: 'Boletim de poços da ANP (snapshot + série RGO)', noStore: true,
    parse(d) {
      const mensal = d.pocosMensal || [];
      return {
        fonte: d.fonte || '—',
        registros: `Snapshot ${d.mesRef || '—'}: ${Object.keys(d.pocos || {}).length} produtores, `
          + `${Object.keys(d.injetoresAgua || {}).length} inj. água, ${Object.keys(d.injetoresGas || {}).length} inj. gás. `
          + `Série RGO: ${mensal.length} meses.`,
        periodo: mensal.length ? periodoDe(mensal) : '—',
        gaps: mensal.length ? findGaps(mensal) : [],
      };
    },
    // Só o snapshot (produtores + injetores do mês mais recente, ver
    // mesRef) — a série mensal (pocosMensal) tem o mesmo formato de poço-
    // >{oleoBbld,gasMm3d} de data/producao_pocos_serie.json acima, já
    // coberta por aquela tabela.
    table: {
      monthly: false,
      columns: ['Poço', 'Tipo', 'Campo', 'FPSO', 'Óleo (bbl/d)', 'Gás (Mm³/d)', 'Água (m³/d)'],
      rowsFor(d) {
        const rows = [];
        for (const [nome, v] of Object.entries(d.pocos || {})) {
          rows.push([nome, 'Produtor', v.campo || '—', v.fpso || '—', fmtNum(v.oleoBbld), v.gasMm3d != null ? fmtNum(v.gasMm3d, { maximumFractionDigits: 1 }) : '—', '—']);
        }
        for (const [nome, v] of Object.entries(d.injetoresAgua || {})) {
          rows.push([nome, 'Injetor água', v.campo || '—', v.fpso || '—', '—', '—', fmtNum(v.aguaM3d)]);
        }
        for (const [nome, v] of Object.entries(d.injetoresGas || {})) {
          rows.push([nome, 'Injetor gás', v.campo || '—', v.fpso || '—', '—', fmtNum(v.gasMm3d, { maximumFractionDigits: 1 }), '—']);
        }
        return rows.sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'));
      },
    },
  },
  {
    path: 'data/pocos.json', label: 'Cadastro de poços do pré-sal', noStore: false,
    parse(d) {
      let total = 0;
      for (const arr of Object.values(d.pocos || {})) total += arr.length;
      total += (d.outros || []).length;
      const comCoord = countWells(d, (w) => !!w.c);
      const comData = countWells(d, (w) => !!w.d);
      return {
        fonte: d.fonte || '—',
        registros: `${total} poços, ${Object.keys(d.pocos || {}).length} campos/contratos + ${(d.outros || []).length} sem campo nomeado`,
        periodo: '—',
        gaps: [],
        extra: `${comCoord} de ${total} com coordenada, ${comData} de ${total} com data de conclusão registrada`,
      };
    },
    table: {
      monthly: false,
      columns: ['Poço', 'Campo/Contrato', 'Operador', 'Situação', 'Categoria', 'Data conclusão', "Lâmina d'água (m)", 'Profundidade (m)'],
      rowsFor(d) {
        const rows = [];
        for (const [campo, arr] of Object.entries(d.pocos || {})) {
          for (const w of arr) {
            rows.push([w.n, campo, w.op || '—', w.sit || '—', w.cat || '—', w.d || '—', w.lam != null ? fmtNum(w.lam) : '—', w.prof != null ? fmtNum(w.prof) : '—']);
          }
        }
        for (const w of d.outros || []) {
          rows.push([w.n, '(sem campo nomeado)', w.op || '—', w.sit || '—', w.cat || '—', w.d || '—', w.lam != null ? fmtNum(w.lam) : '—', w.prof != null ? fmtNum(w.prof) : '—']);
        }
        return rows.sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'));
      },
    },
  },
  {
    path: 'data/planos_desenvolvimento.json', label: 'Sumários executivos de PD (STOIIP, tracts, profit oil)', noStore: false,
    parse(d) {
      const entries = Object.entries(d).filter(([k]) => k !== '_fonte');
      const comStoiip = entries.filter(([, v]) => v.volumes && v.volumes.oleoInSituMMbbl != null).length;
      const comTracts = entries.filter(([, v]) => v.tracts && v.tracts.length > 1).length;
      return {
        fonte: d._fonte || '—',
        registros: `${entries.length} jazidas/campos publicados`,
        periodo: '—',
        gaps: [],
        extra: `${comStoiip} de ${entries.length} com STOIIP, ${comTracts} com mais de 1 fatia (tracts)`,
      };
    },
    table: {
      monthly: false,
      columns: ['Jazida/Campo', 'Situação', 'Descoberta', 'Comercialidade', 'Início produção', 'STOIIP óleo (MMbbl)', 'Empresas (participação)'],
      rowsFor(d) {
        return Object.entries(d).filter(([k]) => k !== '_fonte').sort((a, b) => a[0].localeCompare(b[0], 'pt-BR')).map(([nome, v]) => [
          nome,
          v.situacao || '—',
          v.descoberta || '—',
          v.comercialidade || '—',
          v.inicioProducao || '—',
          v.volumes && v.volumes.oleoInSituMMbbl != null ? fmtNum(v.volumes.oleoInSituMMbbl) : '—',
          (v.participacao || []).map((p) => `${p.empresa} (${p.pct}%)`).join(', ') || '—',
        ]);
      },
    },
  },
  {
    path: 'data/fpso_capacidade.json', label: 'Capacidade nominal por FPSO (curado à mão)', noStore: false,
    parse(d) {
      return {
        fonte: d.fonte || '—',
        registros: `${Object.keys(d.capacidades || {}).length} FPSOs com capacidade publicada no PD`,
        periodo: '—',
        gaps: [],
      };
    },
    table: {
      monthly: false,
      columns: ['FPSO', 'Capacidade (bbl/d)', 'Obs.'],
      rowsFor(d) {
        return Object.entries(d.capacidades || {}).sort((a, b) => a[0].localeCompare(b[0], 'pt-BR')).map(([nome, v]) => [nome, fmtNum(v.bblD), v.obs || '—']);
      },
    },
  },
  {
    path: 'data/contratos.geojson', label: 'Polígonos dos 30 contratos rastreados', noStore: false,
    parse(d) {
      return { fonte: 'ANP — shapefiles públicos de blocos/contratos', registros: `${d.features.length} polígonos`, periodo: '—', gaps: [] };
    },
    table: {
      monthly: false,
      columns: ['Projeto', 'Fonte', 'Bacia', 'Operador', 'Rodada', 'Assinatura', 'Área (km²)'],
      rowsFor(d) {
        return d.features.map((f) => {
          const p = f.properties;
          return [p.projeto || '—', p.fonte || '—', p.bacia || '—', p.operador || '—', p.rodada || '—', p.assinatura || '—', p.area_km2 != null ? fmtNum(p.area_km2) : '—'];
        });
      },
    },
  },
  {
    path: 'data/campos_presal.geojson', label: 'Polígonos dos campos de contexto do pré-sal', noStore: false,
    parse(d) {
      return { fonte: 'ANP — shapefiles públicos de campos de produção', registros: `${d.features.length} polígonos`, periodo: '—', gaps: [] };
    },
    table: {
      monthly: false,
      columns: ['Nome', 'Bacia', 'Operador', 'Rodada', 'Etapa', 'Área (km²)'],
      rowsFor(d) {
        return d.features.map((f) => {
          const p = f.properties;
          return [p.nome || '—', p.bacia || '—', p.operador || '—', p.rodada || '—', p.etapa || '—', p.area_km2 != null ? fmtNum(p.area_km2) : '—'];
        });
      },
    },
  },
  {
    path: 'data/bacias.geojson', label: 'Contorno das bacias sedimentares', noStore: false,
    parse(d) {
      return { fonte: 'ANP — shapefiles públicos de bacias', registros: `${d.features.length} polígonos`, periodo: '—', gaps: [] };
    },
    table: {
      monthly: false,
      columns: ['Nome', 'Situação'],
      rowsFor(d) { return d.features.map((f) => [f.properties.nome || '—', f.properties.situacao || '—']); },
    },
  },
  {
    path: 'data/pre_sal_contorno.geojson', label: 'Contorno da área do pré-sal', noStore: false,
    parse(d) {
      return { fonte: 'ANP — shapefile público da área do pré-sal', registros: `${d.features.length} polígono(s)`, periodo: '—', gaps: [] };
    },
    table: {
      monthly: false,
      columns: ['Nome'],
      rowsFor(d) { return d.features.map((f) => [f.properties.nome || '—']); },
    },
  },
];

function countWells(pocosJson, pred) {
  let n = 0;
  for (const arr of Object.values(pocosJson.pocos || {})) n += arr.filter(pred).length;
  n += (pocosJson.outros || []).filter(pred).length;
  return n;
}

// "Outubro/2014 – Junho/2026" a partir de um array {ano,mes}[] já
// ordenado — mesmo formato usado em producao.js/analises.js.
function periodoDe(meses) {
  const first = meses[0];
  const last = meses[meses.length - 1];
  return `${MESES_PT[first.mes]}/${first.ano} – ${MESES_PT[last.mes]}/${last.ano}`;
}

// Meses "MMM/AAAA" faltando entre o primeiro e o último item do array —
// mesma ideia de gaps já calculada solta em producao.js/tabela.js, aqui
// devolvida como lista (não só contagem) pra dar pra listar na tabela.
function findGaps(meses) {
  if (meses.length < 2) return [];
  const seen = new Set(meses.map((m) => `${m.ano}-${m.mes}`));
  const first = meses[0];
  const last = meses[meses.length - 1];
  const gaps = [];
  let y = first.ano;
  let m = first.mes;
  while (y < last.ano || (y === last.ano && m <= last.mes)) {
    if (!seen.has(`${y}-${m}`)) gaps.push(`${MES_ABREV[m]}/${y}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return gaps;
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

/* ------------------------------ Tabela de fontes ---------------------------- */

function renderFontesTable(container, rows) {
  const card = chartCard(
    'Fontes de dados',
    'Todo arquivo em data/ que o app lê, com a fonte declarada nele mesmo (ver campo "fonte"/"_fonte" de cada um), quantos registros tem, período coberto e tamanho do arquivo — primeira coisa a olhar quando um número parecer estranho em qualquer outra aba: confirma se a fonte é a esperada e se o arquivo carregou de verdade.',
  );
  const wrap = document.createElement('div');
  wrap.className = 'pocos-table-wrapper';
  const table = document.createElement('table');
  table.className = 'data-table analytics-table';
  table.innerHTML = `<thead><tr>
    <th>Arquivo</th><th>Conteúdo</th><th>Fonte</th><th>Registros</th><th>Período</th><th class="num">Tamanho</th>
  </tr></thead>`;
  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${escapeHtml(r.path)}</code></td>
      <td>${escapeHtml(r.label)}</td>
      <td class="muted">${escapeHtml(r.fonte)}</td>
      <td>${escapeHtml(r.registros)}${r.extra ? `<br><span class="muted" style="font-size:11px">${escapeHtml(r.extra)}</span>` : ''}</td>
      <td>${escapeHtml(r.periodo)}</td>
      <td class="num">${escapeHtml(fmtBytes(r.size))}</td>
    `;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  card.appendChild(wrap);
  container.appendChild(card);
}

/* --------------------------- Cobertura mensal (gaps) ------------------------ */

function renderGapsSection(container, rows) {
  const withSeries = rows.filter((r) => r.periodo !== '—');
  if (!withSeries.length) return;
  const card = chartCard(
    'Cobertura mensal — buracos por dataset',
    'Mês que devia existir (entre o primeiro e o último do arquivo) mas não tem entrada nenhuma — sem isso, um gráfico de linha só "comprime" o buraco no eixo x (mesmo mês fica mais perto do vizinho do que devia) sem avisar visualmente. "Nenhum" é o resultado bom aqui.',
  );
  const list = document.createElement('div');
  list.className = 'hbar-list';
  for (const r of withSeries) {
    const row = document.createElement('div');
    row.style.cssText = 'padding:8px 0;border-bottom:1px solid var(--border)';
    const label = document.createElement('div');
    label.style.cssText = 'display:flex;justify-content:space-between;gap:10px;font-size:12.5px;margin-bottom:4px';
    label.innerHTML = `<strong>${escapeHtml(r.label)}</strong><span class="muted">${escapeHtml(r.periodo)}</span>`;
    row.appendChild(label);
    const detail = document.createElement('div');
    detail.style.cssText = 'font-size:11.5px;color:var(--text-faint)';
    detail.textContent = r.gaps.length
      ? `${r.gaps.length} mês(es) faltando: ${r.gaps.join(', ')}`
      : 'Nenhum mês faltando no período coberto.';
    detail.style.color = r.gaps.length ? 'var(--danger)' : 'var(--text-faint)';
    row.appendChild(detail);
    list.appendChild(row);
  }
  card.appendChild(list);
  container.appendChild(card);
}

/* ------------------------------ Tabela de dados crus ------------------------- */
// A tabela por trás de qualquer resumo acima — linha por linha, não só
// contagem/período. Cada dataset com `table` (ver DATASETS) sabe montar suas
// próprias colunas/linhas porque o "registro" varia por arquivo (mês, poço,
// campo, feature de mapa...), igual ao parse() de cada um pro resumo.

// Nenhum dataset hoje passa disso mesmo sem filtro (o maior é pocos.json,
// ~950 linhas) — cap defensivo só pra não travar o navegador se um arquivo
// crescer muito no futuro, não uma paginação de verdade.
const RAW_TABLE_MAX_ROWS = 2000;

function renderRawDataSection(container, files) {
  const withTable = files.filter((f) => f.table);
  if (!withTable.length) return;
  const card = chartCard(
    'Tabela de dados',
    'A tabela crua por trás de qualquer resumo acima — escolha o arquivo (e o mês, quando o dado é mensal) pra ver linha por linha, sem precisar abrir o JSON.',
  );
  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px';

  const dsSelect = document.createElement('select');
  dsSelect.className = 'dados-select';
  for (const f of withTable) {
    const opt = document.createElement('option');
    opt.value = f.path;
    opt.textContent = f.label;
    dsSelect.appendChild(opt);
  }
  const monthSelect = document.createElement('select');
  monthSelect.className = 'dados-select';
  monthSelect.hidden = true;
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'dados-search';
  searchInput.placeholder = 'Filtrar linhas…';
  const countNote = document.createElement('span');
  countNote.className = 'muted';
  countNote.style.cssText = 'font-size:11.5px;white-space:nowrap';
  controls.append(dsSelect, monthSelect, searchInput, countNote);
  card.appendChild(controls);
  const tableWrap = document.createElement('div');
  tableWrap.className = 'pocos-table-wrapper';
  card.appendChild(tableWrap);
  container.appendChild(card);

  function currentFile() { return withTable.find((f) => f.path === dsSelect.value); }

  // Refeito toda vez que o dataset muda — só datasets mensais mostram o
  // seletor de mês; o mais recente vem selecionado por padrão (o caso de
  // uso mais comum, "o que aconteceu no último mês").
  function populateMonths() {
    const t = currentFile().table;
    if (!t.monthly) {
      monthSelect.hidden = true;
      monthSelect.innerHTML = '';
      return;
    }
    const months = t.monthsOf(currentFile().data);
    monthSelect.innerHTML = '';
    for (const m of months) {
      const opt = document.createElement('option');
      opt.value = `${m.ano}-${m.mes}`;
      opt.textContent = `${MES_ABREV[m.mes]}/${m.ano}`;
      monthSelect.appendChild(opt);
    }
    monthSelect.value = `${months[months.length - 1].ano}-${months[months.length - 1].mes}`;
    monthSelect.hidden = false;
  }

  function renderTable() {
    const file = currentFile();
    const t = file.table;
    const rows = t.monthly ? t.rowsFor(file.data, monthSelect.value) : t.rowsFor(file.data);
    const q = searchInput.value.trim().toLowerCase();
    const filtered = q ? rows.filter((r) => r.some((c) => String(c).toLowerCase().includes(q))) : rows;
    const shown = filtered.slice(0, RAW_TABLE_MAX_ROWS);
    countNote.textContent = filtered.length > shown.length
      ? `mostrando ${shown.length} de ${filtered.length}`
      : `${filtered.length} linha${filtered.length === 1 ? '' : 's'}${q ? ` (de ${rows.length})` : ''}`;

    const table = document.createElement('table');
    table.className = 'data-table analytics-table';
    table.innerHTML = `<thead><tr>${t.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>`;
    const tbody = document.createElement('tbody');
    if (!shown.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="${t.columns.length}" class="muted">Nenhuma linha ${q ? 'bate com o filtro' : 'neste mês'}.</td>`;
      tbody.appendChild(tr);
    }
    for (const r of shown) {
      const tr = document.createElement('tr');
      tr.innerHTML = r.map((c) => `<td>${escapeHtml(String(c))}</td>`).join('');
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    tableWrap.innerHTML = '';
    tableWrap.appendChild(table);
  }

  dsSelect.addEventListener('change', () => { populateMonths(); renderTable(); });
  monthSelect.addEventListener('change', renderTable);
  searchInput.addEventListener('input', renderTable);

  populateMonths();
  renderTable();
}

/* ------------------------------ Campos — QC cruzado ------------------------- */

// Uma linha por jazida conhecida em QUALQUER fonte (união, não interseção
// — é justamente a diferença entre fontes que interessa aqui) — cada
// coluna "✓"/"—" indica se essa jazida aparece naquela fonte. Nome bate
// exato (não por substring/PROJECT_FIELD_BASE) de propósito: o objetivo é
// achar grafia divergente entre arquivos, então uma junção "esperta"
// escondia exatamente o que se quer ver aqui.
function renderCamposQcTable(container, { producaoData, pdData, presalGeojson, contratosGeojson }) {
  // Só campo com produção PRÉ-SAL > 0 em algum mês (defensivo — desde a
  // limpeza em scripts/parse_producao_zona.py/strip_pos_sal_only_fields,
  // data/producao.json já só traz campo pré-sal, mas o filtro aqui não
  // custa nada e protege contra o arquivo voltar a trazer campo pós-sal
  // solto no futuro).
  const nomesProducao = new Set();
  for (const m of producaoData.meses) {
    for (const [nome, v] of Object.entries(m.campos)) {
      if (v.oleoPreSalBbld > 0 || v.gasPreSalMm3d > 0) nomesProducao.add(nome);
    }
  }
  const nomesPd = new Set(Object.keys(pdData).filter((k) => k !== '_fonte'));
  const nomesPresal = new Set(presalGeojson.features.map((f) => f.properties.nome));
  const nomesContratos = new Set(contratosGeojson.features.map((f) => f.properties.projeto || f.properties.nome));
  const trackedNames = new Set(state.projects.map((p) => p.name));

  // Casa por nome em CAIXA ALTA, não por igualdade exata de string —
  // data/campos_presal.geojson vem tudo maiúsculo direto do shapefile da
  // ANP (convenção documentada em titleCasePt, mapa.js: "certo pra
  // distinguir de contrato rastreado nas tabelas/listas... mas errado no
  // rótulo do mapa"), então "BERBIGÃO" (polígono) e "Berbigão" (produção/
  // PD) são o MESMO campo — mesmo critério de cross-referência já usado
  // em toda parte do app (trackedByUpperName em app.js/mapa.js/campo.js/
  // pocos.js). Comparar bruto (só toLowerCase/toUpperCase, sem tirar
  // acento) inflava "só 1 fonte" com esse par pra CADA campo de contexto
  // — mascarava as divergências de nome de verdade (typo, apelido
  // diferente, sub-área só numa fonte) no meio desse ruído.
  const upper = (s) => s.toUpperCase();
  const bySet = {
    producao: new Set([...nomesProducao].map(upper)),
    pd: new Set([...nomesPd].map(upper)),
    presal: new Set([...nomesPresal].map(upper)),
    contrato: new Set([...nomesContratos, ...trackedNames].map(upper)),
  };
  // Nome canônico por chave maiúscula: prefere a grafia em Título Case
  // (produção/PD/contrato) sobre o polígono (sempre CAIXA ALTA) só pra
  // exibição — ordem de inserção no Map decide quem "ganha", último
  // sobrescreve.
  const displayName = new Map();
  for (const nome of [...nomesPresal, ...nomesContratos, ...trackedNames, ...nomesPd, ...nomesProducao]) {
    displayName.set(upper(nome), nome);
  }

  const todos = new Set([...bySet.producao, ...bySet.pd, ...bySet.presal, ...bySet.contrato]);
  const rows = [...todos].sort((a, b) => displayName.get(a).localeCompare(displayName.get(b), 'pt-BR')).map((chave) => ({
    nome: displayName.get(chave),
    producao: bySet.producao.has(chave),
    pd: bySet.pd.has(chave),
    presal: bySet.presal.has(chave),
    contrato: bySet.contrato.has(chave),
  }));
  const semNenhuma = rows.filter((r) => [r.producao, r.pd, r.presal, r.contrato].filter(Boolean).length <= 1);

  const card = chartCard(
    'Campos/jazidas — em quais fontes o nome aparece',
    `${rows.length} nomes distintos vistos em pelo menos uma fonte (produção mensal, PD, polígono de campo de contexto, ou contrato/projeto rastreado) — comparação por igualdade de string em CAIXA ALTA (mesmo critério do resto do app pra casar o polígono, sempre maiúsculo na fonte ANP, contra as outras fontes em Título Case), então só sobra divergência de nome de verdade (typo, apelido diferente, campo que uma fonte ainda não cobre), não a caixa da letra. ${semNenhuma.length} aparecem em só 1 fonte — provável ponto de atenção, listados primeiro.`,
  );
  const wrap = document.createElement('div');
  wrap.className = 'pocos-table-wrapper';
  const table = document.createElement('table');
  table.className = 'data-table analytics-table';
  table.innerHTML = `<thead><tr>
    <th>Nome</th><th class="num">Produção mensal</th><th class="num">PD (STOIIP)</th><th class="num">Polígono (contexto)</th><th class="num">Contrato/projeto rastreado</th>
  </tr></thead>`;
  const tbody = document.createElement('tbody');
  const ordered = [...semNenhuma, ...rows.filter((r) => !semNenhuma.includes(r))];
  for (const r of ordered) {
    const tr = document.createElement('tr');
    if (semNenhuma.includes(r)) tr.className = 'muted';
    const mark = (b) => (b ? '✓' : '—');
    tr.innerHTML = `
      <td>${escapeHtml(r.nome)}</td>
      <td class="num">${mark(r.producao)}</td>
      <td class="num">${mark(r.pd)}</td>
      <td class="num">${mark(r.presal)}</td>
      <td class="num">${mark(r.contrato)}</td>
    `;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  card.appendChild(wrap);
  container.appendChild(card);
}

/* ---------------------------------- Init ------------------------------------ */

async function init() {
  const wrapper = document.getElementById('dadosWrapper');
  let files;
  try {
    files = await Promise.all(DATASETS.map(async (ds) => {
      const res = await fetch(ds.path, ds.noStore ? { cache: 'no-store' } : undefined);
      const blob = await res.blob();
      const size = blob.size;
      const data = JSON.parse(await blob.text());
      const parsed = ds.parse(data);
      return { path: ds.path, label: ds.label, size, data, table: ds.table, ...parsed };
    }));
  } catch (err) {
    console.error('Falha ao carregar dados', err);
    wrapper.innerHTML = '<p class="analytics-table-note" style="padding:20px">Falha ao carregar um ou mais arquivos de dados.</p>';
    return;
  }

  const totalSize = files.reduce((s, f) => s + f.size, 0);
  const totalGaps = files.reduce((s, f) => s + f.gaps.length, 0);

  const kpiSection = document.createElement('section');
  kpiSection.className = 'analytics-section';
  const row = document.createElement('div');
  row.className = 'kpi-row';
  row.appendChild(statTile('Arquivos de dados', String(files.length), 'em data/, lidos por alguma página do app'));
  row.appendChild(statTile('Tamanho total', fmtBytes(totalSize), 'baixado a cada carga (sem cache nos reprocessados)'));
  row.appendChild(statTile('Meses faltando', String(totalGaps), totalGaps ? 'somado entre os datasets com série mensal' : 'nenhum buraco nos datasets com série mensal'));
  kpiSection.appendChild(row);
  wrapper.appendChild(kpiSection);

  const fontesSection = document.createElement('section');
  fontesSection.className = 'analytics-section';
  renderFontesTable(fontesSection, files);
  wrapper.appendChild(fontesSection);

  const rawSection = document.createElement('section');
  rawSection.className = 'analytics-section';
  renderRawDataSection(rawSection, files);
  wrapper.appendChild(rawSection);

  const gapsSection = document.createElement('section');
  gapsSection.className = 'analytics-section';
  renderGapsSection(gapsSection, files);
  wrapper.appendChild(gapsSection);

  const producaoFile = files.find((f) => f.path === 'data/producao.json');
  const pdFile = files.find((f) => f.path === 'data/planos_desenvolvimento.json');
  const presalFile = files.find((f) => f.path === 'data/campos_presal.geojson');
  const contratosFile = files.find((f) => f.path === 'data/contratos.geojson');
  if (producaoFile && pdFile && presalFile && contratosFile) {
    const camposSection = document.createElement('section');
    camposSection.className = 'analytics-section';
    renderCamposQcTable(camposSection, {
      producaoData: producaoFile.data,
      pdData: pdFile.data,
      presalGeojson: presalFile.data,
      contratosGeojson: contratosFile.data,
    });
    wrapper.appendChild(camposSection);
  }
}

init();
