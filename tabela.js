'use strict';

/* =========================================================================
   PMO Roadmap — visão em tabela. Usa o mesmo estado (shared.js) da visão
   Gantt (index.html/app.js), só leitura — nenhuma das duas páginas edita
   mais nada, ver nota em app.js. Assim como no app.js, a renderização
   reconstrói a tabela inteira a cada mudança de state (hoje só troca por
   uma migração automática de seed, ver seedMigrationHappened abaixo).
   ========================================================================= */

const tableContainer = document.getElementById('tableContainer');
const emptyStateEl = document.getElementById('emptyState');
const toastEl = document.getElementById('toast');

let toastTimer = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2200);
}

const COLUMN_COUNT = 9;

function renderTable() {
  const hasProjects = state.projects.length > 0;
  emptyStateEl.hidden = hasProjects;
  tableContainer.hidden = !hasProjects;
  tableContainer.innerHTML = '';
  if (!hasProjects) return;

  const table = document.createElement('table');
  table.className = 'data-table';

  const thead = document.createElement('thead');
  thead.innerHTML = `
    <tr>
      <th class="indent-cell"></th>
      <th>Tipo</th>
      <th>Item</th>
      <th>Início</th>
      <th>Fim</th>
      <th>Progresso</th>
      <th>Esperado</th>
      <th>Data</th>
      <th>Realizado</th>
    </tr>`;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const project of state.projects) {
    tbody.appendChild(buildProjectHeaderRow(project));
    if (!project.workstreams.length) {
      tbody.appendChild(buildPlaceholderRow('Nenhuma workstream neste projeto ainda.'));
    }
    for (const ws of project.workstreams) {
      tbody.appendChild(buildWorkstreamHeaderRow(ws));
      if (!ws.items.length) {
        tbody.appendChild(buildPlaceholderRow('Nenhum item nesta workstream ainda.'));
      }
      for (const item of ws.items) {
        tbody.appendChild(buildItemRow(item));
      }
    }
  }
  table.appendChild(tbody);
  tableContainer.appendChild(table);
}

function buildPlaceholderRow(text) {
  const tr = document.createElement('tr');
  tr.className = 'placeholder-row';
  const td = document.createElement('td');
  td.colSpan = COLUMN_COUNT;
  td.textContent = text;
  tr.appendChild(td);
  return tr;
}

function buildProjectHeaderRow(project) {
  const tr = document.createElement('tr');
  tr.className = 'project-header-row';
  const td = document.createElement('td');
  td.colSpan = COLUMN_COUNT;

  const wrap = document.createElement('div');
  wrap.className = 'group-header-content';

  const dot = document.createElement('span');
  dot.className = 'color-dot';
  dot.style.background = project.color;
  wrap.appendChild(dot);

  const name = document.createElement('span');
  name.className = 'group-name-text';
  name.textContent = projectDisplayName(project.name);
  wrap.appendChild(name);

  td.appendChild(wrap);
  tr.appendChild(td);
  return tr;
}

function buildWorkstreamHeaderRow(ws) {
  const tr = document.createElement('tr');
  tr.className = 'ws-header-row';
  const td = document.createElement('td');
  td.colSpan = COLUMN_COUNT;

  const wrap = document.createElement('div');
  wrap.className = 'group-header-content';

  const name = document.createElement('span');
  name.className = 'group-name-text';
  name.textContent = ws.name;
  wrap.appendChild(name);

  td.appendChild(wrap);
  tr.appendChild(td);
  return tr;
}

function buildItemRow(item) {
  const tr = document.createElement('tr');
  tr.className = 'item-row';

  tr.appendChild(document.createElement('td')); // coluna de indentação

  const typeTd = document.createElement('td');
  const badge = document.createElement('span');
  badge.className = 'type-badge type-' + item.type;
  badge.textContent = item.type === 'task' ? 'Tarefa' : 'Marco';
  typeTd.appendChild(badge);
  tr.appendChild(typeTd);

  tr.appendChild(textCell(item.name));

  if (item.type === 'task') {
    tr.appendChild(textCell(formatBR(item.start)));
    tr.appendChild(textCell(formatBR(item.end)));
    tr.appendChild(progressCell(item));
    tr.appendChild(expectedCell(item));
    tr.appendChild(emptyCell());
    tr.appendChild(emptyCell());
  } else {
    tr.appendChild(emptyCell());
    tr.appendChild(emptyCell());
    tr.appendChild(emptyCell());
    tr.appendChild(emptyCell());
    tr.appendChild(textCell(formatBR(item.date)));
    tr.appendChild(doneCell(item));
  }

  return tr;
}

function textCell(value) {
  const td = document.createElement('td');
  td.textContent = value;
  return td;
}

function progressCell(item) {
  const td = document.createElement('td');
  const actual = Math.min(100, Math.max(0, item.progress || 0));
  const expected = computeExpectedProgress(item);
  const span = document.createElement('span');
  span.className = 'progress-value status-' + progressStatusClass(actual, expected);
  span.textContent = actual + '%';
  td.appendChild(span);
  return td;
}

function expectedCell(item) {
  const td = document.createElement('td');
  td.className = 'expected-cell';
  td.textContent = computeExpectedProgress(item) + '%';
  return td;
}

function doneCell(item) {
  const td = document.createElement('td');
  td.className = 'done-cell';
  const label = document.createElement('span');
  label.className = 'done-status' + (item.done ? ' done-yes' : '');
  label.textContent = item.done ? 'Sim' : 'Não';
  td.appendChild(label);

  const isPast = parseDate(item.date) < parseDate(todayISO());
  if (isPast && !item.done) {
    const flag = document.createElement('span');
    flag.className = 'overdue-flag';
    flag.textContent = 'Atrasado';
    td.appendChild(flag);
  }
  return td;
}

function emptyCell() {
  const td = document.createElement('td');
  td.className = 'empty-cell';
  td.textContent = '—';
  return td;
}

/* ---------------------------------- Init ------------------------------------ */

renderTable();

// Estado salvo em versão antiga: shared.js já mesclou automaticamente as
// workstreams/marcos novos de seedState() (só o que faltava) — avisa aqui
// porque showToast só existe depois que este arquivo carrega.
if (seedMigrationHappened) {
  showToast('Roadmap atualizado com novos marcos (ex.: poços exploratórios).');
}
