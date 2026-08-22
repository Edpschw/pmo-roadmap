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

// Mesma classificação usada no seed (por prefixo do nome oficial do
// contrato), reaproveitada no preenchimento retroativo de estados salvos
// antes deste agrupamento existir — sem isso, todo projeto antigo cairia
// sempre em GROUP_FALLBACK em vez do grupo real do contrato.
const KNOWN_PROJECT_GROUPS = {
  'Libra': 'producao',
  'Sul de Gato do Mato': 'exploracao',
  'Norte de Carcará': 'producao',
  'Entorno de Sapinhoá': 'producao',
  'Pau-Brasil': 'devolvidos',
  'Peroba': 'exploracao',
  'Alto de Cabo Frio Oeste': 'exploracao',
  'Alto de Cabo Frio Central': 'exploracao',
  'Uirapuru': 'exploracao',
  'Dois Irmãos': 'exploracao',
  'Três Marias': 'devolvidos',
  'Saturno': 'devolvidos',
  'Titã': 'devolvidos',
  'Sudoeste de Tartaruga Verde': 'exploracao',
  'Aram': 'exploracao',
  'Búzios': 'producao',
  'Itapu': 'producao',
  'Sépia': 'producao',
  'Atapu': 'producao',
  'Água Marinha': 'exploracao',
  'Norte de Brava': 'producao',
  'Bumerangue': 'exploracao',
  'Sudoeste de Sagitário': 'exploracao',
  'Tupinambá': 'exploracao',
  'Esmeralda': 'exploracao',
  'Ametista': 'exploracao',
  'Citrino': 'exploracao',
  'Itaimbezinho': 'exploracao',
  'Jaspe': 'exploracao',
};
function inferProjectGroup(name) {
  const key = Object.keys(KNOWN_PROJECT_GROUPS).find((k) => name.startsWith(k));
  return key ? KNOWN_PROJECT_GROUPS[key] : GROUP_FALLBACK;
}

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
  // icon: 'contract' (documento) | 'fpso' (navio) | 'well' (torre de
  // perfuração) | undefined (losango genérico). approx: true quando só o
  // mês/ano da data era conhecido (o dia usa 01 como placeholder) — some
  // visualmente do nome (que fica curto) mas continua exposto no tooltip,
  // para não esconder a incerteza.
  const m = (name, date, done, icon, approx) => ({ id: uid('m'), type: 'milestone', name, date, done: !!done, icon, approx: !!approx });
  const ws = (name, items) => ({ id: uid('ws'), name, items });
  const proj = (name, color, group, workstreams) => ({ id: uid('p'), name, color, group, collapsed: false, workstreams });

  return {
    scale: 'month',
    pxPerDay: SCALE_PX_PER_DAY.month,
    groupCollapsed: {},
    projects: [
      // Os 29 contratos de Partilha de Produção (CPP) em vigor no pré-sal,
      // conforme presalpetroleo.gov.br/contratos-de-partilha-e-producao/
      // contratos-em-vigor/ (consultado em 21/08/2026). Nomes de projeto e
      // marco ficam só com o essencial (o ícone e a workstream já dizem o
      // tipo) — a rodada/ano de cada contrato e o motivo de cada devolução
      // saíram do texto visível, mas continuam no histórico do repositório.
      // "FID" raramente é divulgada publicamente por bloco — a maioria não
      // tem essa data. Em Búzios, Itapu, Sépia, Atapu e Entorno de Sapinhoá,
      // o campo já produzia sob o regime anterior (Cessão Onerosa/
      // unitização) antes da assinatura do próprio CPP.
      // Workstreams "Poços Exploratórios" (blocos em exploração): reunidas
      // de notícias públicas (imprensa especializada, PPSA, Agência Brasil),
      // não de boletins oficiais da ANP por poço — datas sem dia divulgado
      // usam 01 como placeholder (approx: true). Blocos exploratórios sem
      // poço perfurado ou com resultado ainda não divulgado publicamente
      // (Sul de Gato do Mato, Esmeralda, Ametista, Citrino, Itaimbezinho,
      // Jaspe) ficam sem essa workstream até haver dado concreto.
      proj('Libra', PALETTE[3], 'producao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2013-10-21', true, 'contract'),
          m('Assinatura', '2013-12-02', true, 'contract'),
        ]),
        ws('Primeiro Óleo por FPSO (campo de Mero)', [
          m('Pioneiro (EWT)', '2017-11-26', true, 'fpso'),
          m('Guanabara (Mero-1)', '2022-04-30', true, 'fpso'),
          m('Sepetiba (Mero-2)', '2023-12-31', true, 'fpso'),
          m('Duque de Caxias (Mero-3)', '2024-10-30', true, 'fpso'),
          m('Alexandre de Gusmão (Mero-4)', '2025-05-26', true, 'fpso'),
        ]),
      ]),
      proj('Sul de Gato do Mato', PALETTE[4], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2017-10-27', true, 'contract'),
          m('Assinatura', '2018-01-31', true, 'contract'),
          m('FID', '2025-03-21', true, 'contract'),
        ]),
        ws('Primeiro Óleo por FPSO', [
          m('FPSO Gato do Mato (previsto)', '2029-01-01', false, 'fpso', true),
        ]),
      ]),
      proj('Norte de Carcará', PALETTE[5], 'producao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2017-10-27', true, 'contract'),
          m('Assinatura', '2018-01-31', true, 'contract'),
          m('FID', '2021-06-01', true, 'contract', true),
        ]),
        ws('Primeiro Óleo por FPSO', [
          m('Bacalhau', '2025-10-16', true, 'fpso'),
        ]),
      ]),
      proj('Entorno de Sapinhoá', PALETTE[7], 'producao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2017-10-27', true, 'contract'),
          m('Assinatura (unitização)', '2018-01-31', true, 'contract'),
        ]),
        ws('Primeiro Óleo por FPSO', [
          m('Cidade de São Paulo (regime anterior)', '2013-01-01', true, 'fpso', true),
        ]),
      ]),
      proj('Pau-Brasil', PALETTE[8], 'devolvidos', [
        ws('Marcos do Contrato', [
          m('Leilão', '2018-09-28', true, 'contract'),
          m('Assinatura', '2018-12-17', true, 'contract'),
          m('Devolução', '2024-08-01', true, 'contract', true),
        ]),
      ]),
      // Peroba e Alto de Cabo Frio Oeste: chegamos a marcar como "status
      // contestado" (a página da PPSA os listava como ativos), mas pesquisa
      // adicional confirmou a devolução com múltiplas fontes independentes
      // e consistentes entre si (consórcio, data e motivo batendo) — por
      // isso migraram para o grupo "Devolvidos".
      proj('Peroba', PALETTE[9], 'devolvidos', [
        ws('Marcos do Contrato', [
          m('Leilão', '2017-10-27', true, 'contract'),
          m('Assinatura', '2018-01-31', true, 'contract'),
          m('Devolução', '2021-01-01', true, 'contract', true),
        ]),
        ws('Poços Exploratórios', [
          m('Poço pioneiro (gás com CO2, sem viabilidade)', '2019-02-01', true, 'well', true),
        ]),
      ]),
      proj('Alto de Cabo Frio Oeste', PALETTE[0], 'devolvidos', [
        ws('Marcos do Contrato', [
          m('Leilão', '2017-10-27', true, 'contract'),
          m('Assinatura', '2018-01-31', true, 'contract'),
          m('Devolução', '2024-09-01', true, 'contract', true),
        ]),
        ws('Poços Exploratórios', [
          m('Poço pioneiro (navio Brava Star)', '2019-10-01', true, 'well', true),
        ]),
      ]),
      proj('Alto de Cabo Frio Central', PALETTE[1], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2017-10-27', true, 'contract'),
          m('Assinatura', '2018-01-31', true, 'contract'),
        ]),
        ws('Poços Exploratórios', [
          m('Poço pioneiro 1-BRSA-1383A-RJS (teste de formação)', '2022-07-01', true, 'well', true),
        ]),
      ]),
      proj('Uirapuru', PALETTE[2], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2018-06-07', true, 'contract'),
          m('Assinatura', '2018-12-17', true, 'contract'),
        ]),
        ws('Poços Exploratórios', [
          m('Poço pioneiro (descoberta)', '2020-04-01', true, 'well', true),
        ]),
      ]),
      proj('Dois Irmãos', PALETTE[3], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2018-06-07', true, 'contract'),
          m('Assinatura', '2018-12-17', true, 'contract'),
        ]),
        ws('Poços Exploratórios', [
          m('Poço pioneiro (poço seco, navio Ocean Courage) — bloco devolvido', '2022-01-01', true, 'well', true),
        ]),
      ]),
      proj('Três Marias', PALETTE[4], 'devolvidos', [
        ws('Marcos do Contrato', [
          m('Leilão', '2018-06-07', true, 'contract'),
          m('Assinatura', '2018-12-17', true, 'contract'),
          m('Devolução', '2023-10-01', true, 'contract', true),
        ]),
      ]),
      proj('Saturno', PALETTE[5], 'devolvidos', [
        ws('Marcos do Contrato', [
          m('Leilão', '2018-09-28', true, 'contract'),
          m('Assinatura', '2018-12-17', true, 'contract'),
          m('Devolução', '2020-05-01', true, 'contract', true),
        ]),
      ]),
      proj('Titã', PALETTE[6], 'devolvidos', [
        ws('Marcos do Contrato', [
          m('Leilão', '2018-09-28', true, 'contract'),
          m('Assinatura', '2018-12-17', true, 'contract'),
          m('Devolução', '2025-09-30', true, 'contract'),
        ]),
      ]),
      proj('Sudoeste de Tartaruga Verde', PALETTE[7], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2018-09-28', true, 'contract'),
          m('Assinatura', '2018-12-17', true, 'contract'),
        ]),
        ws('Poços Exploratórios', [
          m('Poço 4-BRSA-1403D-RJS (descoberta)', '2025-11-01', true, 'well', true),
        ]),
      ]),
      proj('Aram', PALETTE[8], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2019-11-07', true, 'contract'),
          m('Assinatura', '2020-03-30', true, 'contract'),
        ]),
        ws('Poços Exploratórios', [
          m('Poço pioneiro "Curaçao" 1-BRSA-1381-SPS (descoberta)', '2021-11-01', true, 'well', true),
          m('Poço 4-BRSA-1395-SPS (óleo e gás)', '2025-03-01', true, 'well', true),
          m('Poço 3-BRSA-1396D-SPS (óleo de alta qualidade)', '2025-05-01', true, 'well', true),
        ]),
      ]),
      proj('Búzios', PALETTE[9], 'producao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2019-11-06', true, 'contract'),
          m('Assinatura', '2020-03-30', true, 'contract'),
        ]),
        ws('Primeiro Óleo por FPSO', [
          m('P-74', '2018-04-24', true, 'fpso'),
          m('P-75', '2018-11-11', true, 'fpso'),
          m('P-76', '2019-02-20', true, 'fpso'),
          m('P-77', '2019-03-19', true, 'fpso'),
          m('Almirante Barroso', '2023-05-31', true, 'fpso'),
          m('Almirante Tamandaré', '2025-02-15', true, 'fpso'),
          m('P-78', '2025-12-31', true, 'fpso'),
          m('P-79', '2026-05-01', true, 'fpso'),
          m('P-80 (previsto)', '2027-01-01', false, 'fpso', true),
          m('P-82 (previsto)', '2027-04-01', false, 'fpso', true),
          m('P-83 (previsto)', '2027-07-01', false, 'fpso', true),
        ]),
      ]),
      proj('Itapu', PALETTE[0], 'producao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2019-11-06', true, 'contract'),
          m('Assinatura', '2020-03-30', true, 'contract'),
        ]),
        ws('Primeiro Óleo por FPSO', [
          m('P-71', '2022-12-21', true, 'fpso'),
        ]),
      ]),
      proj('Sépia', PALETTE[1], 'producao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2021-12-17', true, 'contract'),
          m('Assinatura', '2022-04-27', true, 'contract'),
          m('FID Sépia-2', '2024-05-27', true, 'contract'),
        ]),
        ws('Primeiro Óleo por FPSO', [
          m('Carioca (regime anterior)', '2021-08-23', true, 'fpso'),
          m('P-85 (previsto)', '2029-01-01', false, 'fpso', true),
        ]),
      ]),
      proj('Atapu', PALETTE[2], 'producao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2021-12-17', true, 'contract'),
          m('Assinatura', '2022-04-27', true, 'contract'),
          m('FID Atapu-2', '2024-05-27', true, 'contract'),
        ]),
        ws('Primeiro Óleo por FPSO', [
          m('P-70 (regime anterior)', '2020-06-25', true, 'fpso'),
          m('P-84 (previsto)', '2029-01-01', false, 'fpso', true),
        ]),
      ]),
      proj('Água Marinha', PALETTE[3], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2022-12-16', true, 'contract'),
          m('Assinatura', '2023-05-31', true, 'contract'),
        ]),
        ws('Poços Exploratórios', [
          m('Início da perfuração (poço 1-BRSA-1401D/DA-RJS) — resultado ainda não divulgado', '2025-06-01', true, 'well', true),
        ]),
      ]),
      proj('Norte de Brava', PALETTE[4], 'producao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2022-12-16', true, 'contract'),
          m('Assinatura', '2023-07-05', true, 'contract'),
        ]),
        ws('Primeiro Óleo por FPSO', [
          m('Anita Garibaldi', '2023-08-16', true, 'fpso'),
        ]),
      ]),
      proj('Bumerangue', PALETTE[5], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2022-12-16', true, 'contract'),
          m('Assinatura', '2023-07-05', true, 'contract'),
        ]),
        ws('Poços Exploratórios', [
          m('Poço pioneiro 1-BP-13-SPS (descoberta)', '2025-08-01', true, 'well', true),
        ]),
      ]),
      proj('Sudoeste de Sagitário', PALETTE[6], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2022-12-16', true, 'contract'),
          m('Assinatura', '2023-07-05', true, 'contract'),
        ]),
        ws('Poços Exploratórios', [
          m('Poço de extensão 3-BRSA-1388DA-SPS (resultado abaixo do esperado)', '2024-01-01', true, 'well', true),
        ]),
      ]),
      proj('Tupinambá', PALETTE[7], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2023-12-13', true, 'contract'),
          m('Assinatura (data prevista)', '2024-05-31', false, 'contract'),
        ]),
        ws('Poços Exploratórios', [
          m('Poço exploratório (previsto)', '2026-01-01', false, 'well', true),
        ]),
      ]),
      proj('Esmeralda', PALETTE[8], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2025-10-22', true, 'contract'),
          m('Assinatura', '2026-08-05', true, 'contract'),
        ]),
      ]),
      proj('Ametista', PALETTE[9], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2025-10-22', true, 'contract'),
          m('Assinatura', '2026-08-05', true, 'contract'),
        ]),
      ]),
      proj('Citrino', PALETTE[0], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2025-10-22', true, 'contract'),
          m('Assinatura', '2026-08-05', true, 'contract'),
        ]),
      ]),
      proj('Itaimbezinho', PALETTE[1], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2025-10-22', true, 'contract'),
          m('Assinatura', '2026-08-05', true, 'contract'),
          m('Petrobras compra 50% (Equinor)', '2026-06-01', true, 'contract'),
        ]),
      ]),
      proj('Jaspe', PALETTE[2], 'exploracao', [
        ws('Marcos do Contrato', [
          m('Leilão', '2025-10-22', true, 'contract'),
          m('Assinatura', '2026-08-05', true, 'contract'),
        ]),
      ]),
    ],
  };
}

/* -------------------------------- State -------------------------------- */

// Incrementar sempre que seedState() ganhar workstreams/marcos novos, ou
// corrigir dados existentes, que devem chegar automaticamente a quem já
// tem estado salvo no navegador (ver mergeSeedUpdates). Estado salvo sem
// "seedVersion" é tratado como 0.
// v2: workstreams "Poços Exploratórios". v3: FPSOs previstos (Búzios,
// Sul de Gato do Mato, Sépia-2, Atapu-2) + Peroba/Alto de Cabo Frio Oeste
// confirmados como devolvidos (grupo e nome do marco de status). v4:
// corrige a data da Anita Garibaldi (ver FIELD_CORRECTIONS) e passa a
// travar o arraste de item em zoom muito baixo (ver MIN_PX_PER_DAY_FOR_DRAG
// em app.js) — a causa provável do erro: nessa escala poucos pixels de
// mouse já representam anos, e um clique impreciso vira arraste enorme.
const SEED_VERSION = 4;

// Nomes antigos de marco que migraram para um nome novo em seedState() —
// sem isso, o merge abaixo (que só adiciona, nunca substitui) deixaria o
// marco antigo e o novo lado a lado. Chave: nome do projeto; valor: nomes
// de marco antigos a remover ao mesclar.
const RENAMED_MILESTONES = {
  'Peroba': ['Status contestado (PPSA: ativo / imprensa: devolvido)'],
  'Alto de Cabo Frio Oeste': ['Status contestado (PPSA: ativo / imprensa: devolvido)'],
};

// Correções pontuais de um campo que já se sabe estar errado (bug de
// arraste em zoom baixo, erro de digitação etc.) — diferente do resto do
// merge (que só adiciona), isto SOBRESCREVE o valor salvo do usuário. Usar
// só para erros confirmados com fonte, nunca para forçar preferência.
const FIELD_CORRECTIONS = [
  {
    project: 'Norte de Brava', workstream: 'Primeiro Óleo por FPSO', item: 'Anita Garibaldi',
    field: 'date', value: '2023-08-16',
  },
];

// Aplica ao estado salvo do usuário só o que existe em seedState() e ainda
// não existe localmente — nunca sobrescreve nem remove nada que o usuário
// já tenha editado ou adicionado por conta própria. Casa projeto por nome
// e, dentro dele, workstream por nome; workstream nova é adicionada
// inteira, workstream já existente ganha apenas os itens (por nome) que
// faltarem. Projetos que o usuário não tem salvos (removidos ou nunca
// importados) não são recriados. O grupo (Exploração/Produção/Devolvidos)
// é sincronizado com a referência, já que reflete a situação real do
// contrato (não uma preferência pessoal) — se você reclassificou um
// projeto de propósito, ajuste de novo depois de uma migração.
function mergeSeedUpdates(saved) {
  const reference = seedState();
  for (const refProj of reference.projects) {
    const savedProj = saved.projects.find((p) => p.name === refProj.name);
    if (!savedProj) continue;
    savedProj.group = refProj.group;
    const renamed = RENAMED_MILESTONES[refProj.name];
    for (const refWs of refProj.workstreams) {
      const savedWs = savedProj.workstreams.find((w) => w.name === refWs.name);
      if (!savedWs) {
        savedProj.workstreams.push(refWs);
        continue;
      }
      if (renamed) {
        savedWs.items = savedWs.items.filter((i) => !renamed.includes(i.name));
      }
      for (const refItem of refWs.items) {
        const exists = savedWs.items.some((i) => i.name === refItem.name);
        if (!exists) savedWs.items.push(refItem);
      }
    }
  }
  for (const fix of FIELD_CORRECTIONS) {
    const p = saved.projects.find((pr) => pr.name === fix.project);
    const w = p && p.workstreams.find((ws) => ws.name === fix.workstream);
    const i = w && w.items.find((it) => it.name === fix.item);
    if (i) i[fix.field] = fix.value;
  }
  saved.seedVersion = SEED_VERSION;
  return saved;
}

// Sinaliza para app.js/tabela.js, depois do carregamento, se algo foi
// adicionado automaticamente — para mostrar um toast avisando o usuário.
let seedMigrationHappened = false;

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
        // Se o nome bater com um dos 29 contratos oficiais, usa o grupo
        // real dele (inferProjectGroup) em vez de cair sempre no fallback.
        for (const p of parsed.projects) {
          if (!p.group) p.group = inferProjectGroup(p.name);
        }
        if ((parsed.seedVersion || 0) < SEED_VERSION) {
          mergeSeedUpdates(parsed);
          seedMigrationHappened = true;
          localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
        }
        return parsed;
      }
    }
  } catch (e) {
    console.warn('Falha ao carregar estado salvo, usando dados de exemplo.', e);
  }
  const fresh = seedState();
  fresh.seedVersion = SEED_VERSION;
  return fresh;
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
