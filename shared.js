'use strict';

/* =========================================================================
   Núcleo de dados compartilhado entre as páginas do Roadmap PMO (visão
   Gantt em index.html e visão em tabela em tabela.html). Sem dependências
   externas. Carregar antes de app.js / tabela.js.
   ========================================================================= */

const STORAGE_KEY = 'pmo-roadmap-state-v1';

const PALETTE = [
  '#3457d5', '#1c9e6b', '#e0762f', '#a24bd6', '#d64545',
  '#0aa3a3', '#c9a227', '#5b6ee1', '#2f9ed6', '#c14f8a'
];

// Cor do texto de marcos já passados e marcados como realizados — mesmo tom
// usado no número de progresso de uma tarefa concluída (.actual.complete).
const MILESTONE_PAST_LABEL_COLOR = '#9aa4b2';
// Cor do texto de marcos já passados e NÃO realizados — mesmo tom de
// "atrasado" usado no número de progresso das tarefas (.actual.behind).
const MILESTONE_OVERDUE_LABEL_COLOR = '#d64545';

const SCALE_PX_PER_DAY = { month: 6, quarter: 2.3, year: 1.0 };

// Nível de agrupamento acima dos projetos (colapsável), por fase/situação
// do contrato. GROUP_FALLBACK é usado para projetos antigos salvos sem
// campo "group" (compatibilidade com dados de antes deste agrupamento).
const GROUP_DEFS = [
  { id: 'exploracao', label: 'Exploração' },
  { id: 'producao', label: 'Produção' },
  { id: 'devolvidos', label: 'Devolvidos' },
];
const GROUP_FALLBACK = 'exploracao';

let uidCounter = 0;
function uid(prefix) {
  uidCounter += 1;
  return prefix + '_' + Date.now().toString(36) + '_' + uidCounter;
}

/* ---------------------------- Date helpers ---------------------------- */

function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function toISO(date) {
  return date.toISOString().slice(0, 10);
}
function addDays(date, n) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}
function diffDays(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}
function todayISO() {
  const now = new Date();
  return toISO(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
}
function formatBR(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
// Progresso que a tarefa deveria ter hoje, assumindo avanço linear entre
// início e fim — usado para comparar com o progresso real informado.
function computeExpectedProgress(item) {
  const start = parseDate(item.start);
  const end = parseDate(item.end);
  const today = parseDate(todayISO());
  if (today <= start) return 0;
  if (today >= end) return 100;
  const span = diffDays(start, end);
  if (span <= 0) return 100;
  return Math.round((diffDays(start, today) / span) * 100);
}
// Classificação usada para colorir o número de progresso real: verde (em
// dia/adiantado), laranja (até 10% atrasado), vermelho (mais atrasado) ou
// cinza claro quando já está 100% concluído.
function progressStatusClass(actualProgress, expectedProgress) {
  if (actualProgress === 100) return 'complete';
  if (actualProgress >= expectedProgress) return 'on-track';
  if (expectedProgress - actualProgress <= 10) return 'slightly-behind';
  return 'behind';
}

/* ------------------------------- Seed data ------------------------------ */

// Contratos reais de Partilha de Produção (CPP) do polígono do pré-sal,
// administrados pela PPSA e licitados pela ANP.
function seedState() {
  const t = (name, start, end, progress) => ({ id: uid('t'), type: 'task', name, start, end, progress });
  const m = (name, date, done) => ({ id: uid('m'), type: 'milestone', name, date, done: !!done });
  const ws = (name, items) => ({ id: uid('ws'), name, items });
  const proj = (name, color, group, workstreams) => ({ id: uid('p'), name, color, group, collapsed: false, workstreams });

  return {
    scale: 'month',
    pxPerDay: SCALE_PX_PER_DAY.month,
    groupCollapsed: {},
    projects: [
      // Os 29 contratos de Partilha de Produção (CPP) em vigor no pré-sal,
      // conforme presalpetroleo.gov.br/contratos-de-partilha-e-producao/
      // contratos-em-vigor/ (consultado em 21/08/2026). Marcos de leilão,
      // assinatura, FID, FPSO e primeiro óleo vêm de fontes oficiais
      // (PPSA/ANP/MME) e de imprensa especializada (TN Petróleo,
      // Petronotícias, epbr) — sem dado inventado: onde só o mês era
      // conhecido (não o dia exato), o marco usa o dia 01 e diz isso no
      // próprio nome. "Decisão de investimento" raramente é divulgada
      // publicamente por bloco — a maioria não tem essa data.
      // Em Búzios, Itapu, Sépia, Atapu e Entorno de Sapinhoá, o campo já
      // produzia sob o regime anterior (Cessão Onerosa/unitização) antes da
      // assinatura do próprio CPP — os dois marcos aparecem separados.
      // Pau-Brasil, Saturno, Três Marias e Titã foram devolvidos à ANP.
      proj('Libra — 1ª Rodada de Partilha (2013)', PALETTE[3], 'producao', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 1ª Rodada de Partilha', '2013-10-21', true),
          m('Assinatura do Contrato de Partilha', '2013-12-02', true),
          m('Primeiro óleo — FPSO Pioneiro de Libra (teste de longa duração, campo de Mero)', '2017-11-26', true),
          m('Primeiro óleo comercial — FPSO Guanabara (Mero-1)', '2022-04-30', true),
        ]),
      ]),
      proj('Sul de Gato do Mato — 2ª Rodada de Partilha (2017)', PALETTE[4], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 2ª Rodada de Partilha', '2017-10-27', true),
          m('Assinatura do Contrato de Partilha', '2018-01-31', true),
          m('Decisão de Investimento (FID) — Shell', '2025-03-21', true),
        ]),
      ]),
      proj('Norte de Carcará — 2ª Rodada de Partilha (2017)', PALETTE[5], 'producao', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 2ª Rodada de Partilha', '2017-10-27', true),
          m('Assinatura do Contrato de Partilha', '2018-01-31', true),
          m('Decisão de Investimento (FID) — Bacalhau Fase 1, Equinor (mês aprox.)', '2021-06-01', true),
          m('Primeiro óleo — FPSO Bacalhau', '2025-10-16', true),
        ]),
      ]),
      proj('Entorno de Sapinhoá — 2ª Rodada de Partilha (2017)', PALETTE[7], 'producao', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 2ª Rodada de Partilha', '2017-10-27', true),
          m('Assinatura do Contrato de Partilha (unitização com Sapinhoá)', '2018-01-31', true),
          m('Primeiro óleo do campo — FPSO Cidade de São Paulo (mês aprox., regime anterior)', '2013-01-01', true),
        ]),
      ]),
      proj('Pau-Brasil — 5ª Rodada de Partilha (2018)', PALETTE[8], 'devolvidos', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 5ª Rodada de Partilha', '2018-09-28', true),
          m('Assinatura do Contrato de Partilha', '2018-12-17', true),
          m('Devolução do bloco à ANP — poço seco, BP (mês aprox.)', '2024-08-01', true),
        ]),
      ]),
      proj('Peroba — 3ª Rodada de Partilha (2017)', PALETTE[9], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 3ª Rodada de Partilha', '2017-10-27', true),
          m('Assinatura do Contrato de Partilha', '2018-01-31', true),
          m('Status em aberto: PPSA lista como ativo (Petrobras 40% / BP 40% / CNODC 20%), mas imprensa (2021) reporta devolução à ANP — verificar antes de decidir', '2021-01-01', false),
        ]),
      ]),
      proj('Alto de Cabo Frio Oeste — 3ª Rodada de Partilha (2017)', PALETTE[0], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 3ª Rodada de Partilha', '2017-10-27', true),
          m('Assinatura do Contrato de Partilha', '2018-01-31', true),
          m('Status em aberto: PPSA lista Shell 55% como ativo, mas imprensa (jul/2024) reporta devolução; ANP mostra prorrogação vencida em 30/10/2025 — verificar', '2024-07-01', false),
        ]),
      ]),
      proj('Alto de Cabo Frio Central — 3ª Rodada de Partilha (2017)', PALETTE[1], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 3ª Rodada de Partilha', '2017-10-27', true),
          m('Assinatura do Contrato de Partilha', '2018-01-31', true),
        ]),
      ]),
      proj('Uirapuru — 4ª Rodada de Partilha (2018)', PALETTE[2], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 4ª Rodada de Partilha', '2018-06-07', true),
          m('Assinatura do Contrato de Partilha', '2018-12-17', true),
        ]),
      ]),
      proj('Dois Irmãos — 4ª Rodada de Partilha (2018)', PALETTE[3], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 4ª Rodada de Partilha', '2018-06-07', true),
          m('Assinatura do Contrato de Partilha', '2018-12-17', true),
        ]),
      ]),
      proj('Três Marias — 4ª Rodada de Partilha (2018)', PALETTE[4], 'devolvidos', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 4ª Rodada de Partilha', '2018-06-07', true),
          m('Assinatura do Contrato de Partilha', '2018-12-17', true),
          m('Devolução do bloco à ANP — Petrobras (mês aprox.)', '2023-10-01', true),
        ]),
      ]),
      proj('Saturno — 5ª Rodada de Partilha (2018)', PALETTE[5], 'devolvidos', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 5ª Rodada de Partilha', '2018-09-28', true),
          m('Assinatura do Contrato de Partilha', '2018-12-17', true),
          m('Devolução do bloco à ANP — poço seco, Shell (mês aprox.)', '2020-05-01', true),
        ]),
      ]),
      proj('Titã — 5ª Rodada de Partilha (2018)', PALETTE[6], 'devolvidos', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 5ª Rodada de Partilha', '2018-09-28', true),
          m('Assinatura do Contrato de Partilha', '2018-12-17', true),
          m('Devolução formal do bloco à ANP — ExxonMobil', '2025-09-30', true),
        ]),
      ]),
      proj('Sudoeste de Tartaruga Verde — 5ª Rodada de Partilha (2018)', PALETTE[7], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 5ª Rodada de Partilha', '2018-09-28', true),
          m('Assinatura do Contrato de Partilha', '2018-12-17', true),
        ]),
      ]),
      proj('Aram — 6ª Rodada de Partilha (2019)', PALETTE[8], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 6ª Rodada de Partilha', '2019-11-07', true),
          m('Assinatura do Contrato de Partilha', '2020-03-30', true),
        ]),
      ]),
      proj('Búzios — Excedente da Cessão Onerosa (2019)', PALETTE[9], 'producao', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 1ª Rodada de Excedente da Cessão Onerosa', '2019-11-06', true),
          m('Assinatura do Contrato de Partilha', '2020-03-30', true),
          m('Primeiro óleo do campo — FPSO P-74 (mês aprox., regime anterior)', '2018-04-01', true),
          m('Primeiro óleo — FPSO Almirante Tamandaré (Búzios 7)', '2025-02-15', true),
        ]),
      ]),
      proj('Itapu — Excedente da Cessão Onerosa (2019)', PALETTE[0], 'producao', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 1ª Rodada de Excedente da Cessão Onerosa', '2019-11-06', true),
          m('Assinatura do Contrato de Partilha', '2020-03-30', true),
          m('Primeiro óleo — FPSO P-71', '2022-12-21', true),
        ]),
      ]),
      proj('Sépia — Excedente da Cessão Onerosa (2021)', PALETTE[1], 'producao', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 2ª Rodada de Excedente da Cessão Onerosa', '2021-12-17', true),
          m('Assinatura do Contrato de Partilha', '2022-04-27', true),
          m('Primeiro óleo do campo — FPSO Carioca (regime anterior)', '2021-08-23', true),
        ]),
      ]),
      proj('Atapu — Excedente da Cessão Onerosa (2021)', PALETTE[2], 'producao', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 2ª Rodada de Excedente da Cessão Onerosa', '2021-12-17', true),
          m('Assinatura do Contrato de Partilha', '2022-04-27', true),
          m('Primeiro óleo do campo — FPSO P-70 (regime anterior)', '2020-06-25', true),
        ]),
      ]),
      proj('Água Marinha — Oferta Permanente (OPP), 1º Ciclo', PALETTE[3], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 1º Ciclo da Oferta Permanente', '2022-12-16', true),
          m('Assinatura do Contrato de Partilha', '2023-05-31', true),
        ]),
      ]),
      proj('Norte de Brava — Oferta Permanente (OPP), 1º Ciclo', PALETTE[4], 'producao', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 1º Ciclo da Oferta Permanente', '2022-12-16', true),
          m('Assinatura do Contrato de Partilha', '2023-07-05', true),
          m('Primeiro óleo — FPSO Anita Garibaldi', '2023-08-16', true),
        ]),
      ]),
      proj('Bumerangue — Oferta Permanente (OPP), 1º Ciclo', PALETTE[5], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 1º Ciclo da Oferta Permanente', '2022-12-16', true),
          m('Assinatura do Contrato de Partilha', '2023-07-05', true),
        ]),
      ]),
      proj('Sudoeste de Sagitário — Oferta Permanente (OPP), 1º Ciclo', PALETTE[6], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 1º Ciclo da Oferta Permanente', '2022-12-16', true),
          m('Assinatura do Contrato de Partilha', '2023-07-05', true),
        ]),
      ]),
      proj('Tupinambá — Oferta Permanente (OPP), 2º Ciclo', PALETTE[7], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 2º Ciclo da Oferta Permanente', '2023-12-13', true),
          m('Assinatura do Contrato de Partilha (data prevista, não confirmada em fonte)', '2024-05-31', false),
        ]),
      ]),
      proj('Esmeralda — Oferta Permanente (OPP), 3º Ciclo', PALETTE[8], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 3º Ciclo da Oferta Permanente', '2025-10-22', true),
          m('Assinatura do Contrato de Partilha', '2026-08-05', true),
        ]),
      ]),
      proj('Ametista — Oferta Permanente (OPP), 3º Ciclo', PALETTE[9], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 3º Ciclo da Oferta Permanente', '2025-10-22', true),
          m('Assinatura do Contrato de Partilha', '2026-08-05', true),
        ]),
      ]),
      proj('Citrino — Oferta Permanente (OPP), 3º Ciclo', PALETTE[0], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 3º Ciclo da Oferta Permanente', '2025-10-22', true),
          m('Assinatura do Contrato de Partilha', '2026-08-05', true),
        ]),
      ]),
      proj('Itaimbezinho — Oferta Permanente (OPP), 3º Ciclo', PALETTE[1], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 3º Ciclo da Oferta Permanente', '2025-10-22', true),
          m('Assinatura do Contrato de Partilha', '2026-08-05', true),
          m('Petrobras adquire 50% do bloco da Equinor', '2026-06-01', true),
        ]),
      ]),
      proj('Jaspe — Oferta Permanente (OPP), 3º Ciclo', PALETTE[2], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão ANP — 3º Ciclo da Oferta Permanente', '2025-10-22', true),
          m('Assinatura do Contrato de Partilha', '2026-08-05', true),
        ]),
      ]),
    ],
  };
}

/* -------------------------------- State -------------------------------- */

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.projects)) {
        if (!parsed.pxPerDay) parsed.pxPerDay = SCALE_PX_PER_DAY[parsed.scale] || SCALE_PX_PER_DAY.month;
        if (!parsed.groupCollapsed) parsed.groupCollapsed = {};
        // Compatibilidade: projetos salvos antes do agrupamento por
        // fase/situação (Exploração/Produção/Devolvidos) não têm "group".
        for (const p of parsed.projects) {
          if (!p.group) p.group = GROUP_FALLBACK;
        }
        return parsed;
      }
    }
  } catch (e) {
    console.warn('Falha ao carregar estado salvo, usando dados de exemplo.', e);
  }
  return seedState();
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function findProject(projectId) {
  return state.projects.find((p) => p.id === projectId);
}
function findWorkstream(projectId, wsId) {
  const p = findProject(projectId);
  return p && p.workstreams.find((w) => w.id === wsId);
}
function findItem(projectId, wsId, itemId) {
  const w = findWorkstream(projectId, wsId);
  return w && w.items.find((i) => i.id === itemId);
}

let state = loadState();
