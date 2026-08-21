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

// Exemplo temático de E&P (exploração e produção de petróleo e gás),
// inspirado no vocabulário de rodadas da ANP — blocos em regime de partilha
// de produção (polígono do pré-sal) e de concessão (bacias maduras). Nomes
// de blocos/campos são ilustrativos, não correspondem a contratos reais.
function seedState() {
  const t = (name, start, end, progress) => ({ id: uid('t'), type: 'task', name, start, end, progress });
  const m = (name, date, done) => ({ id: uid('m'), type: 'milestone', name, date, done: !!done });
  const ws = (name, items) => ({ id: uid('ws'), name, items });
  const proj = (name, color, workstreams) => ({ id: uid('p'), name, color, collapsed: false, workstreams });

  return {
    scale: 'month',
    pxPerDay: SCALE_PX_PER_DAY.month,
    projects: [
      proj('Búzios Norte — Partilha de Produção', PALETTE[0], [
        ws('Licitação & Contratos', [
          t('Estudos de viabilidade geológica', '2024-01-10', '2024-04-30', 100),
          m('Leilão ANP — Rodada de Partilha', '2024-06-12', true),
          t('Assinatura do contrato de partilha', '2024-06-20', '2024-08-15', 100),
        ]),
        ws('Exploração & Avaliação', [
          t('Perfuração de poços pioneiros', '2024-09-01', '2025-03-20', 100),
          t('Testes de formação (DST)', '2025-01-15', '2025-04-10', 100),
          m('Declaração de comercialidade', '2025-05-30', true),
        ]),
        ws('Desenvolvimento da Produção', [
          m('Início do Desenvolvimento', '2025-07-01', true),
          t('Contratação e construção do FPSO', '2025-07-15', '2027-02-28', 55),
          t('Perfuração de poços produtores e injetores', '2026-03-01', '2027-06-30', 30),
          m('Primeiro Óleo', '2027-03-15'),
          m('Platô de Produção', '2028-06-01'),
        ]),
      ]),
      proj('Marlim Sul — Concessão (Bacia de Campos)', PALETTE[1], [
        ws('Revitalização de Campo Maduro', [
          t('Reprocessamento sísmico 4D', '2025-02-01', '2025-07-15', 100),
          m('Aprovação do Plano de Desenvolvimento (PD)', '2025-08-20', true),
          t('Workover de poços existentes', '2025-09-01', '2026-10-30', 60),
        ]),
        ws('Infraestrutura de Produção', [
          t('Instalação de novo FPSO (revitalização)', '2026-01-10', '2027-05-31', 25),
          m('Primeiro Óleo', '2027-06-15'),
          m('Platô de Produção', '2028-01-20'),
        ]),
        ws('HSE & Licenciamento', [
          t('Licenciamento ambiental IBAMA', '2025-03-01', '2025-12-15', 100),
          m('Licença de Operação', '2025-12-20', true),
        ]),
      ]),
      proj('Sépia Sul — Partilha de Produção', PALETTE[2], [
        ws('Rodada de Licitação ANP', [
          t('Due diligence técnica do bloco', '2026-06-01', '2026-09-05', 80),
          m('Leilão ANP — Rodada de Partilha', '2026-09-10'),
          m('Assinatura do Contrato de Partilha', '2026-10-15'),
        ]),
        ws('Exploração', [
          t('Aquisição sísmica 3D', '2026-11-01', '2027-04-30', 0),
          t('Perfuração do poço pioneiro', '2027-05-01', '2027-11-30', 0),
          m('Declaração de comercialidade', '2028-01-15'),
        ]),
        ws('Desenvolvimento', [
          m('Início do Desenvolvimento', '2028-03-01'),
          t('FEED do sistema de produção', '2028-03-15', '2028-12-31', 0),
          m('Primeiro Óleo', '2029-06-01'),
          m('Platô de Produção', '2030-01-15'),
        ]),
      ]),

      // ---- Contratos reais de Partilha de Produção (CPP) do pré-sal ----
      // Nomes verificados junto à ANP/PPSA (presalpetroleo.gov.br), por
      // rodada de licitação. Adicionados sem tarefas/marcos/datas — cada um
      // é um projeto vazio pronto para ser preenchido com o cronograma real.
      // (Os 3 projetos acima são o exemplo ilustrativo original do app e
      // não são contratos reais, apesar de reaproveitarem nomes de campos.)
      proj('Libra — 1ª Rodada de Partilha (2013)', PALETTE[3], []),
      proj('Gato do Mato — 2ª Rodada de Partilha (2017)', PALETTE[4], []),
      proj('Carcará — 2ª Rodada de Partilha (2017)', PALETTE[5], []),
      proj('Tartaruga Verde — 2ª Rodada de Partilha (2017)', PALETTE[6], []),
      proj('Sapinhoá — 2ª Rodada de Partilha (2017)', PALETTE[7], []),
      proj('Pau Brasil — 3ª Rodada de Partilha (2017)', PALETTE[8], []),
      proj('Peroba — 3ª Rodada de Partilha (2017)', PALETTE[9], []),
      proj('Alto de Cabo Frio Oeste — 3ª Rodada de Partilha (2017)', PALETTE[0], []),
      proj('Alto de Cabo Frio Central — 3ª Rodada de Partilha (2017)', PALETTE[1], []),
      proj('Uirapuru — 4ª Rodada de Partilha (2018)', PALETTE[2], []),
      proj('Dois Irmãos — 4ª Rodada de Partilha (2018)', PALETTE[3], []),
      proj('Três Marias — 4ª Rodada de Partilha (2018)', PALETTE[4], []),
      proj('Saturno — 5ª Rodada de Partilha (2018)', PALETTE[5], []),
      proj('Titã — 5ª Rodada de Partilha (2018)', PALETTE[6], []),
      proj('Sudoeste de Tartaruga Verde — 5ª Rodada de Partilha (2018)', PALETTE[7], []),
      proj('Aram — 6ª Rodada de Partilha (2019)', PALETTE[8], []),
      proj('Búzios — Excedente da Cessão Onerosa (2019)', PALETTE[9], []),
      proj('Itapu — Excedente da Cessão Onerosa (2019)', PALETTE[0], []),
      proj('Sépia — Excedente da Cessão Onerosa (2021)', PALETTE[1], []),
      proj('Atapu — Excedente da Cessão Onerosa (2021)', PALETTE[2], []),
      proj('Água Marinha — Oferta Permanente (OPP)', PALETTE[3], []),
      proj('Norte de Brava — Oferta Permanente (OPP)', PALETTE[4], []),
      proj('Bumerangue — Oferta Permanente (OPP)', PALETTE[5], []),
      proj('Sudoeste de Sagitário — Oferta Permanente (OPP)', PALETTE[6], []),
      proj('Tupinambá — Oferta Permanente (OPP)', PALETTE[7], []),
      proj('Esmeralda — Oferta Permanente (OPP)', PALETTE[8], []),
      proj('Ametista — Oferta Permanente (OPP)', PALETTE[9], []),
      proj('Citrino — Oferta Permanente (OPP)', PALETTE[0], []),
      proj('Itaimbezinho — Oferta Permanente (OPP)', PALETTE[1], []),
      proj('Jaspe — Oferta Permanente (OPP)', PALETTE[2], []),
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
