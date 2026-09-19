'use strict';

/* =========================================================================
   PMO Roadmap — Notícias. Últimas notícias de cada operadora e parceira dos
   contratos do pré-sal rastreados neste app, pesquisadas manualmente nos
   sites de imprensa/institucionais de cada empresa (data/noticias.json) —
   não é um feed automático (sites de imprensa de cada empresa não liberam
   fetch direto do navegador pra outro domínio); pra atualizar, repetir a
   pesquisa por empresa e reescrever o arquivo de dados.
   O "papel" de cada empresa (operadora/parceira, e de qual contrato) vem
   dos mesmos dados usados nos selos do mapa/roadmap e na aba "Por operador/
   companhia" de Produção — data/contratos.geojson + data/
   planos_desenvolvimento.json, companyBadgesFor/buildFeatureByProject em
   shared.js — mas só é conhecido com precisão pros 7 contratos com
   produção rastreada (PROJECT_FIELD_BASE); as demais empresas (sócias só
   de blocos em exploração ou de campos fora da lista de 7) aparecem sem
   essa linha de contexto.
   ========================================================================= */

const NOTICIAS_URL = 'data/noticias.json';
const GEOJSON_URL = 'data/contratos.geojson';
const PRESALT_FIELDS_URL = 'data/campos_presal.geojson';
const PD_URL = 'data/planos_desenvolvimento.json';

// nome (companyBadge().name) -> { operaEm: [nome de exibição], parceiraEm:
// [{nome, pct}] } — só cobre os 7 contratos de PROJECT_FIELD_BASE (ver nota
// acima do arquivo); mesmo laço de computeCompanyRows (producao.js), mas
// junta por empresa em vez de somar produção.
function computeCompanyRoles(projects, featureByProject, pdData) {
  const roles = new Map();
  for (const p of projects) {
    const base = PROJECT_FIELD_BASE[p.name];
    if (!base) continue;
    const feature = featureByProject[p.name];
    const operadorRaw = feature ? feature.properties.operador : null;
    const pd = byNameOrUpper(pdData, p.name);
    const badges = companyBadgesFor(operadorRaw, pd ? pd.participacao : null);
    if (!badges.length) continue;
    const displayName = projectDisplayName(p.name);
    for (const b of badges) {
      if (!roles.has(b.name)) roles.set(b.name, { operaEm: [], parceiraEm: [] });
      const r = roles.get(b.name);
      if (b.role === 'operador') r.operaEm.push(displayName);
      else r.parceiraEm.push({ nome: displayName, pct: b.pct });
    }
  }
  return roles;
}

function roleSubtitle(role) {
  if (!role) return 'Sócia de contrato(s) do pré-sal fora dos 7 atualmente em produção rastreados nesta página.';
  const parts = [];
  if (role.operaEm.length) parts.push(`Operadora de ${role.operaEm.join(', ')}`);
  if (role.parceiraEm.length) {
    const txt = role.parceiraEm.map((p) => `${p.nome} (${p.pct.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%)`).join(', ');
    parts.push(`Parceira em ${txt}`);
  }
  return parts.join(' · ');
}

// "T12:00:00" (meio-dia, sem fuso) faz new Date() parsear no fuso LOCAL em
// vez de UTC — sem isso, uma data como "2026-09-18" (só o dia, sem hora)
// vira meia-noite UTC, que em qualquer fuso negativo (ex.: Brasil, UTC-3)
// exibe o dia ANTERIOR (17/09) depois do toLocaleDateString.
function newsDateHTML(item) {
  // completa pra "YYYY-MM-DD" antes do T12:00:00 — Date não aceita
  // "YYYY-MMT12:00:00" (mês sem dia) como string ISO válida.
  const full = item.data.length === 10 ? item.data
    : item.data.length === 7 ? `${item.data}-15`
    : `${item.data}-06-15`;
  const d = new Date(`${full}T12:00:00`);
  const opts = item.data.length === 7
    ? { month: 'long', year: 'numeric' }
    : item.data.length === 4
      ? { year: 'numeric' }
      : { day: '2-digit', month: 'long', year: 'numeric' };
  const txt = d.toLocaleDateString('pt-BR', opts);
  return item.dataAprox ? `~${txt}` : txt;
}

function buildCompanyLogoHTML(nome) {
  const badge = companyBadge(nome);
  if (badge && badge.logo) {
    return `<span class="news-company-logo news-company-logo-img"><img src="${escapeHtml(badge.logo)}" alt="${escapeHtml(nome)}"/></span>`;
  }
  const initials = (badge && badge.initials) || nome.split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();
  const color = (badge && badge.color) || colorForCompany(nome);
  return `<span class="news-company-logo news-company-logo-badge" style="background:${color}">${escapeHtml(initials)}</span>`;
}

function buildCompanyCard(empresa, role) {
  const card = document.createElement('div');
  card.className = 'chart-card news-company-card';

  const head = document.createElement('div');
  head.className = 'news-company-head';
  head.innerHTML = `
    ${buildCompanyLogoHTML(empresa.nome)}
    <div class="news-company-head-text">
      <h3 class="chart-card-title">${escapeHtml(empresa.nome)}</h3>
      <p class="chart-card-subtitle">${escapeHtml(roleSubtitle(role))}</p>
    </div>
  `;
  card.appendChild(head);

  const list = document.createElement('div');
  list.className = 'news-list';
  for (const item of empresa.noticias) {
    const el = document.createElement('article');
    el.className = 'news-item';
    el.innerHTML = `
      <a class="news-item-title" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.titulo)}</a>
      <div class="news-item-meta"><span class="news-item-date">${newsDateHTML(item)}</span><span class="news-item-source">${escapeHtml(item.fonteNome)}</span></div>
      <p class="news-item-summary">${escapeHtml(item.resumo)}</p>
    `;
    list.appendChild(el);
  }
  card.appendChild(list);

  return card;
}

async function init() {
  const wrapper = document.getElementById('noticiasWrapper');

  let noticiasData = null;
  try {
    noticiasData = await fetch(NOTICIAS_URL, { cache: 'no-store' }).then((r) => r.json());
  } catch (err) {
    console.error('Falha ao carregar notícias', err);
  }

  wrapper.innerHTML = '';

  if (!noticiasData || !noticiasData.empresas || !noticiasData.empresas.length) {
    const empty = document.createElement('p');
    empty.className = 'chart-card-subtitle';
    empty.textContent = 'Nenhuma notícia carregada ainda.';
    wrapper.appendChild(empty);
    return;
  }

  // Papel de cada empresa (operadora/parceira, ver computeCompanyRoles) é só
  // contexto — se os 3 arquivos não carregarem, a página segue funcionando
  // com as notícias mesmo assim, só sem essa linha (mesmo padrão de
  // tolerância a falha de producao.js).
  let roles = new Map();
  try {
    const [geojson, presal, pd] = await Promise.all([
      fetch(GEOJSON_URL).then((r) => r.json()),
      fetch(PRESALT_FIELDS_URL).then((r) => r.json()),
      fetch(PD_URL).then((r) => r.json()),
    ]);
    const featureByProject = buildFeatureByProject(geojson, presal, state.projects);
    roles = computeCompanyRoles(state.projects, featureByProject, pd);
  } catch (err) {
    console.error('Falha ao carregar dados de operador/participação', err);
  }

  const section = document.createElement('section');
  section.className = 'analytics-section';

  const row = document.createElement('div');
  row.className = 'kpi-row';
  const totalNoticias = noticiasData.empresas.reduce((s, e) => s + e.noticias.length, 0);
  row.appendChild(statTile('Empresas cobertas', String(noticiasData.empresas.length), 'Toda operadora/parceira dos contratos do pré-sal rastreados (ver selos do mapa e do roadmap)'));
  row.appendChild(statTile('Notícias', String(totalNoticias), 'Uma pesquisa manual por empresa — não é um feed automático'));
  row.appendChild(statTile('Atualizado em', new Date(`${noticiasData.fonte.atualizado}T12:00:00`).toLocaleDateString('pt-BR'), 'Data da última rodada de pesquisa (ver nota abaixo)'));
  section.appendChild(row);

  const note = document.createElement('p');
  note.className = 'analytics-table-note';
  note.textContent = noticiasData.fonte.nota;
  section.appendChild(note);

  const grid = document.createElement('div');
  grid.className = 'news-grid';
  for (const empresa of noticiasData.empresas) {
    grid.appendChild(buildCompanyCard(empresa, roles.get(empresa.nome)));
  }
  section.appendChild(grid);

  wrapper.appendChild(section);
}

init();
