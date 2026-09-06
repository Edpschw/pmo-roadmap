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
      // campos: TODO nome visto (inclui fração pós-sal de campo fora do
      // pré-sal, ver nota grande em renderCamposQcTable); comPresal: só
      // quem teve oleoPreSalBbld/gasPreSalMm3d > 0 em algum mês — a
      // diferença entre os dois é o quanto do arquivo é fração pós-sal
      // "de passagem" (não usada em nenhum outro lugar do app).
      const campos = new Set();
      const comPresal = new Set();
      for (const m of d.meses) {
        for (const [nome, v] of Object.entries(m.campos)) {
          campos.add(nome);
          if (v.oleoPreSalBbld > 0 || v.gasPreSalMm3d > 0) comPresal.add(nome);
        }
      }
      return {
        fonte: (d.fonte && d.fonte.nome) || '—',
        registros: `${d.meses.length} meses, ${campos.size} campos distintos (${comPresal.size} com produção pré-sal > 0 em algum mês — o resto é fração pós-sal "de passagem" do mesmo dado aberto, ver nota na tabela de campos abaixo)`,
        periodo: periodoDe(d.meses),
        gaps: findGaps(d.meses),
      };
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
  },
  {
    path: 'data/contratos.geojson', label: 'Polígonos dos 30 contratos rastreados', noStore: false,
    parse(d) {
      return { fonte: 'ANP — shapefiles públicos de blocos/contratos', registros: `${d.features.length} polígonos`, periodo: '—', gaps: [] };
    },
  },
  {
    path: 'data/campos_presal.geojson', label: 'Polígonos dos campos de contexto do pré-sal', noStore: false,
    parse(d) {
      return { fonte: 'ANP — shapefiles públicos de campos de produção', registros: `${d.features.length} polígonos`, periodo: '—', gaps: [] };
    },
  },
  {
    path: 'data/bacias.geojson', label: 'Contorno das bacias sedimentares', noStore: false,
    parse(d) {
      return { fonte: 'ANP — shapefiles públicos de bacias', registros: `${d.features.length} polígonos`, periodo: '—', gaps: [] };
    },
  },
  {
    path: 'data/pre_sal_contorno.geojson', label: 'Contorno da área do pré-sal', noStore: false,
    parse(d) {
      return { fonte: 'ANP — shapefile público da área do pré-sal', registros: `${d.features.length} polígono(s)`, periodo: '—', gaps: [] };
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

/* ------------------------------ Campos — QC cruzado ------------------------- */

// Uma linha por jazida conhecida em QUALQUER fonte (união, não interseção
// — é justamente a diferença entre fontes que interessa aqui) — cada
// coluna "✓"/"—" indica se essa jazida aparece naquela fonte. Nome bate
// exato (não por substring/PROJECT_FIELD_BASE) de propósito: o objetivo é
// achar grafia divergente entre arquivos, então uma junção "esperta"
// escondia exatamente o que se quer ver aqui.
function renderCamposQcTable(container, { producaoData, pdData, presalGeojson, contratosGeojson }) {
  // Só campo com produção PRÉ-SAL > 0 em algum mês — data/producao.json
  // também traz a fração PÓS-SAL de qualquer campo do litoral brasileiro
  // que cruza com uma zona pré-sal em algum poço (ver parse_zona_csv,
  // scripts/parse_producao_zona.py: sim = pré-sal e não = pós-sal do
  // MESMO campo entram na mesma entrada), o que incluiria ~380 campos
  // 100% pós-sal (Alto do Rodrigues, Enchova...) sem relação nenhuma com
  // o pré-sal — comparar esses contra fontes só-pré-sal (PD, polígono)
  // não seria uma comparação de igual pra igual, só ruído.
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

  const todos = new Set([...nomesProducao, ...nomesPd, ...nomesPresal, ...nomesContratos, ...trackedNames]);
  const rows = [...todos].sort((a, b) => a.localeCompare(b, 'pt-BR')).map((nome) => ({
    nome,
    producao: nomesProducao.has(nome),
    pd: nomesPd.has(nome),
    presal: nomesPresal.has(nome),
    contrato: nomesContratos.has(nome) || trackedNames.has(nome),
  }));
  const semNenhuma = rows.filter((r) => [r.producao, r.pd, r.presal, r.contrato].filter(Boolean).length <= 1);

  const card = chartCard(
    'Campos/jazidas — em quais fontes o nome aparece',
    `${rows.length} nomes distintos vistos em pelo menos uma fonte (produção mensal, PD, polígono de campo de contexto, ou contrato/projeto rastreado) — comparação por igualdade exata de string, de propósito: o objetivo é achar nome que só existe numa fonte (typo, apelido diferente, campo que uma fonte ainda não cobre), então uma junção "inteligente" por substring escondia isso. ${semNenhuma.length} aparecem em só 1 fonte — provável ponto de atenção, listados primeiro.`,
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
      return { path: ds.path, label: ds.label, size, data, ...parsed };
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
