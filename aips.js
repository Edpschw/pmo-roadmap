'use strict';

/* =========================================================================
   PMO Roadmap — AIPs. Lista os Acordos de Individualização da Produção
   (jazidas compartilhadas, ver data/planos_desenvolvimento.json) que têm
   Área Não Contratada (fatia da União/PPSA) mas NÃO têm nenhum contrato de
   Partilha de Produção na composição — só Concessão e/ou Cessão Onerosa.
   Critério calculado a partir do próprio dado (não uma lista fixa de nomes),
   pra continuar valendo se outra jazida entrar nesse caso no futuro:
     - tem ANC: participacao inclui "Pré-Sal Petróleo S.A." (mesmo alias
       usado em companyBadge, ver shared.js) — é como o blend da jazida
       marca a fatia da União desde a revisão de Mero/Atapu/Tupi/Sapinhoá.
     - não tem partilha: o texto de "contrato" não menciona "Partilha" nem
       as siglas de contrato de partilha (PP)/CPP.
   ========================================================================= */

const PD_URL = 'data/planos_desenvolvimento.json';
const ANC_EMPRESA = 'Pré-Sal Petróleo S.A.';

function temAnc(pd) {
  return (pd.participacao || []).some((p) => p.empresa === ANC_EMPRESA);
}

function temPartilha(pd) {
  return /partilha|\bPP\)|\bCPP\b/i.test(pd.contrato || '');
}

// Agrupa por jazida — várias chaves do arquivo podem ser a mesma jazida
// compartilhada (Tupi e Sul de Tupi, Atapu e Oeste de Atapu, Berbigão e
// Norte/Sul de Berbigão...), cada uma com a MESMA participação/blend salva
// (ver revisão de Tupi/Atapu/Berbigão). Agrupa por tracts (a fonte mais
// confiável de "é a mesma jazida", já que é o próprio TP oficial/estimado
// entre os tratos) quando existe; cai pro titulo do PD quando não tem
// tracts (ex.: Sapinhoá/Entorno de Sapinhoá, que não tem tracts salvo mas
// têm o mesmo titulo) — Tupi/Sul de Tupi por ex. têm titulo DIFERENTE
// ("Lula 2018" vs "Sul de Lula 2018", cada um o nome do PD original), por
// isso tracts (idênticos nos dois) é o critério primário, não o titulo.
function chaveJazida(nome, v) {
  if (v.tracts && v.tracts.length > 1) return 'tracts:' + JSON.stringify(v.tracts);
  return 'titulo:' + (v.titulo || nome);
}

function agrupaPorJazida(pd) {
  const porChave = new Map();
  for (const [nome, v] of Object.entries(pd)) {
    if (nome === '_fonte') continue;
    const chave = chaveJazida(nome, v);
    if (!porChave.has(chave)) porChave.set(chave, { titulos: new Set(), campos: [], data: v });
    const grupo = porChave.get(chave);
    grupo.titulos.add(v.titulo || nome);
    grupo.campos.push(nome);
  }
  // titulo de exibição: junta os distintos quando o PD original de cada
  // campo tem um titulo próprio (caso Tupi/Sul de Tupi, sem um titulo de
  // AIP unificado) — na maioria dos casos (Atapu/Oeste de Atapu etc.) é 1
  // titulo só, já compartilhado entre as chaves.
  return [...porChave.values()]
    .map((g) => ({ titulo: [...g.titulos].join(' / '), campos: g.campos, data: g.data }))
    .sort((a, b) => a.titulo.localeCompare(b.titulo, 'pt-BR'));
}

// Mesmo padrão de selo usado no Roadmap (ver app.js, bloco de
// company-badge-item logo abaixo do nome do projeto) — sem distinguir
// operador/parceiro aqui, já que o que importa nesta página é a fatia de
// cada um na jazida (incluindo a própria PPSA), não quem opera o contrato.
function renderBadges(container, participacao) {
  const row = document.createElement('div');
  row.className = 'project-badges-row';
  const ordenado = [...(participacao || [])].sort((a, b) => b.pct - a.pct);
  for (const p of ordenado) {
    const b = companyBadge(p.empresa);
    if (!b) continue;
    const item = document.createElement('span');
    item.className = 'company-badge-item';
    item.title = `${b.name} — ${p.pct.toLocaleString('pt-BR')}%`;
    const el = document.createElement('span');
    if (b.logo) {
      el.className = 'company-logo-chip company-logo-chip-parceiro';
      const img = document.createElement('img');
      img.src = b.logo;
      img.alt = b.name;
      el.appendChild(img);
    } else {
      el.className = 'company-badge company-badge-parceiro';
      el.style.background = b.color;
      el.textContent = b.initials;
    }
    item.appendChild(el);
    const pctEl = document.createElement('span');
    pctEl.className = 'company-badge-pct';
    pctEl.textContent = `${p.pct.toLocaleString('pt-BR')}%`;
    item.appendChild(pctEl);
    row.appendChild(item);
  }
  container.appendChild(row);
}

function renderFato(container, label, valor) {
  if (!valor) return;
  const p = document.createElement('p');
  p.style.cssText = 'font-size:12px;margin:2px 0';
  p.innerHTML = `<span style="color:var(--text-faint)">${escapeHtml(label)}:</span> ${escapeHtml(valor)}`;
  container.appendChild(p);
}

function renderJazidaCard(container, jazida) {
  const { titulo, campos, data } = jazida;
  const card = chartCard(
    titulo,
    `Campo(s)/chave(s) rastreados por esta jazida: ${campos.join(', ')}.`,
  );

  renderFato(card, 'Contrato', data.contrato);
  renderFato(card, 'Situação', data.situacao);
  renderFato(card, 'Resolução', data.resolucao);

  if (data.tracts && data.tracts.length > 1) {
    const tractsP = document.createElement('p');
    tractsP.style.cssText = 'font-size:12px;margin:2px 0 8px';
    tractsP.innerHTML = `<span class="muted">Tratos:</span> ${data.tracts
      .map((t) => `${escapeHtml(t.nome)} (${t.pct.toLocaleString('pt-BR')}%)`)
      .join(' + ')}`;
    card.appendChild(tractsP);
  }

  const badgesLabel = document.createElement('p');
  badgesLabel.style.cssText = 'font-size:11px;margin:10px 0 4px;color:var(--text-faint)';
  badgesLabel.textContent = 'Participação (blend da jazida):';
  card.appendChild(badgesLabel);
  renderBadges(card, data.participacao);

  if (data.participacaoObs) {
    const obs = document.createElement('p');
    obs.style.cssText = 'font-size:11.5px;color:var(--text-faint);margin:10px 0 0';
    obs.textContent = data.participacaoObs;
    card.appendChild(obs);
  }

  if (data.fonte) {
    const fonteP = document.createElement('p');
    fonteP.style.cssText = 'font-size:11.5px;margin:8px 0 0';
    fonteP.innerHTML = `<a href="${escapeHtml(data.fonte)}" target="_blank" rel="noopener">PDF do sumário executivo na ANP</a>`;
    card.appendChild(fonteP);
  }

  container.appendChild(card);
}

function renderComparacaoTable(container, comAnc) {
  const card = chartCard(
    'Todas as jazidas com Área Não Contratada',
    'Pra comparar: toda jazida rastreada com fatia da União (PPSA), tenha ou não contrato de Partilha na composição — as com Partilha ficam de fora da lista principal acima porque o critério pedido é ANC sem Partilha.',
  );
  const wrap = document.createElement('div');
  wrap.className = 'pocos-table-wrapper';
  const table = document.createElement('table');
  table.className = 'data-table analytics-table';
  table.innerHTML = `<thead><tr>
    <th>Jazida</th><th>Contrato</th><th>Tem Partilha?</th><th class="num">% PPSA (ANC)</th>
  </tr></thead>`;
  const tbody = document.createElement('tbody');
  for (const j of comAnc) {
    const pctPpsa = (j.data.participacao || []).find((p) => p.empresa === ANC_EMPRESA);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(j.titulo)}</td>
      <td class="muted" style="font-size:11.5px">${escapeHtml(j.data.contrato || '—')}</td>
      <td>${temPartilha(j.data) ? 'Sim' : 'Não'}</td>
      <td class="num">${pctPpsa ? pctPpsa.pct.toLocaleString('pt-BR', { maximumFractionDigits: 3 }) + '%' : '—'}</td>
    `;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  card.appendChild(wrap);
  container.appendChild(card);
}

async function init() {
  const wrapper = document.getElementById('aipsWrapper');
  let pd;
  try {
    pd = await fetch(PD_URL).then((r) => r.json());
  } catch (err) {
    console.error('Falha ao carregar dados', err);
    wrapper.innerHTML = '<p class="analytics-table-note" style="padding:20px">Falha ao carregar planos_desenvolvimento.json.</p>';
    return;
  }

  const jazidas = agrupaPorJazida(pd);
  const comAnc = jazidas.filter((j) => temAnc(j.data));
  const semPartilha = comAnc.filter((j) => !temPartilha(j.data));

  const kpiSection = document.createElement('section');
  kpiSection.className = 'analytics-section';
  const row = document.createElement('div');
  row.className = 'kpi-row';
  row.appendChild(statTile('Jazidas rastreadas', String(jazidas.length), 'no total, contando cada AIP uma vez só'));
  row.appendChild(statTile('Com Área Não Contratada', String(comAnc.length), 'jazidas com fatia da União/PPSA no blend'));
  row.appendChild(statTile('ANC sem Partilha', String(semPartilha.length), 'ANC + só Concessão/Cessão Onerosa, sem contrato de Partilha'));
  kpiSection.appendChild(row);
  wrapper.appendChild(kpiSection);

  const principal = document.createElement('section');
  principal.className = 'analytics-section';
  const h2 = document.createElement('h2');
  h2.className = 'analytics-section-title';
  h2.textContent = 'AIPs com Área Não Contratada, sem contrato de Partilha';
  principal.appendChild(h2);
  if (!semPartilha.length) {
    const p = document.createElement('p');
    p.style.cssText = 'color:var(--text-faint);font-size:13px';
    p.textContent = 'Nenhuma jazida rastreada bate com esse critério no momento.';
    principal.appendChild(p);
  } else {
    for (const j of semPartilha) renderJazidaCard(principal, j);
  }
  wrapper.appendChild(principal);

  if (comAnc.length) {
    const comparacaoSection = document.createElement('section');
    comparacaoSection.className = 'analytics-section';
    renderComparacaoTable(comparacaoSection, comAnc);
    wrapper.appendChild(comparacaoSection);
  }
}

init();
