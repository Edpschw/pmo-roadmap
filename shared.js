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

function seedState() {
  const t = (name, start, end, progress) => ({ id: uid('t'), type: 'task', name, start, end, progress });
  const m = (name, date) => ({ id: uid('m'), type: 'milestone', name, date });
  const ws = (name, items) => ({ id: uid('ws'), name, items });
  const proj = (name, color, workstreams) => ({ id: uid('p'), name, color, collapsed: false, workstreams });

  return {
    scale: 'month',
    pxPerDay: SCALE_PX_PER_DAY.month,
    projects: [
      proj('Transformação Digital', PALETTE[0], [
        ws('Arquitetura & Plataforma', [
          t('Levantamento de requisitos', '2026-05-04', '2026-05-29', 100),
          t('Desenho da arquitetura alvo', '2026-06-01', '2026-07-10', 80),
          m('Aprovação do comitê', '2026-07-15'),
          t('Migração para nuvem', '2026-07-16', '2026-10-30', 25),
        ]),
        ws('Dados & Integrações', [
          t('Mapeamento de fontes de dados', '2026-05-18', '2026-06-26', 100),
          t('Construção de pipelines ETL', '2026-06-29', '2026-09-18', 40),
          m('Go-live do data lake', '2026-09-25'),
        ]),
        ws('Change Management', [
          t('Plano de comunicação', '2026-06-08', '2026-07-03', 60),
          t('Treinamento de usuários-chave', '2026-09-01', '2026-10-16', 0),
        ]),
      ]),
      proj('Expansão Comercial', PALETTE[1], [
        ws('Novos Mercados', [
          t('Estudo de viabilidade — LATAM', '2026-04-06', '2026-05-15', 100),
          m('Decisão go/no-go', '2026-05-20'),
          t('Registro legal e fiscal', '2026-05-21', '2026-07-31', 55),
          t('Contratação de time local', '2026-07-01', '2026-09-11', 20),
        ]),
        ws('Parcerias Estratégicas', [
          t('Negociação com distribuidores', '2026-06-15', '2026-08-28', 45),
          m('Assinatura de contrato-âncora', '2026-09-02'),
        ]),
      ]),
      proj('Eficiência Operacional', PALETTE[2], [
        ws('Automação de Processos', [
          t('Mapeamento AS-IS', '2026-05-11', '2026-06-05', 100),
          t('Implantação de RPA — Financeiro', '2026-06-08', '2026-08-14', 65),
          t('Implantação de RPA — Suprimentos', '2026-08-17', '2026-10-23', 5),
        ]),
        ws('Qualidade & Governança', [
          m('Auditoria interna', '2026-07-10'),
          t('Padronização de KPIs', '2026-07-13', '2026-08-21', 30),
          t('Revisão de políticas de compliance', '2026-09-07', '2026-10-30', 0),
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
