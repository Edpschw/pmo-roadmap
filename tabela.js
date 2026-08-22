'use strict';

/* =========================================================================
   PMO Roadmap — visão em tabela. Usa o mesmo estado (shared.js) da visão
   Gantt (index.html/app.js): qualquer edição aqui é salva em localStorage e
   aparece imediatamente na outra página ao recarregar. Assim como no
   app.js, a renderização reconstrói a tabela inteira a cada mudança.
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

const COLUMN_COUNT = 10;

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
      <th>Ações</th>
    </tr>`;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const project of state.projects) {
    tbody.appendChild(buildProjectHeaderRow(project));
    if (!project.workstreams.length) {
      tbody.appendChild(buildPlaceholderRow('Nenhuma workstream neste projeto ainda.'));
    }
    for (const ws of project.workstreams) {
      tbody.appendChild(buildWorkstreamHeaderRow(project, ws));
      if (!ws.items.length) {
        tbody.appendChild(buildPlaceholderRow('Nenhum item nesta workstream ainda.'));
      }
      for (const item of ws.items) {
        tbody.appendChild(buildItemRow(project, ws, item));
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

  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.className = 'color-input';
  colorInput.value = project.color;
  colorInput.title = 'Cor do projeto';
  colorInput.addEventListener('change', () => {
    project.color = colorInput.value;
    saveState();
    renderTable();
  });
  wrap.appendChild(colorInput);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'cell-input group-name-input';
  nameInput.value = project.name;
  nameInput.addEventListener('change', () => {
    const name = nameInput.value.trim();
    if (!name) { showToast('O nome do projeto não pode ficar vazio.'); renderTable(); return; }
    project.name = name;
    saveState();
    renderTable();
  });
  wrap.appendChild(nameInput);

  const actions = document.createElement('div');
  actions.className = 'group-header-actions';
  actions.appendChild(smallButton('+ Workstream', () => addWorkstream(project)));
  actions.appendChild(iconButton('✕', 'Excluir projeto', () => deleteProject(project)));
  wrap.appendChild(actions);

  td.appendChild(wrap);
  tr.appendChild(td);
  return tr;
}

function buildWorkstreamHeaderRow(project, ws) {
  const tr = document.createElement('tr');
  tr.className = 'ws-header-row';
  const td = document.createElement('td');
  td.colSpan = COLUMN_COUNT;

  const wrap = document.createElement('div');
  wrap.className = 'group-header-content';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'cell-input group-name-input';
  nameInput.value = ws.name;
  nameInput.addEventListener('change', () => {
    const name = nameInput.value.trim();
    if (!name) { showToast('O nome da workstream não pode ficar vazio.'); renderTable(); return; }
    ws.name = name;
    saveState();
    renderTable();
  });
  wrap.appendChild(nameInput);

  const actions = document.createElement('div');
  actions.className = 'group-header-actions';
  actions.appendChild(smallButton('+ Tarefa', () => addTask(project, ws)));
  actions.appendChild(smallButton('+ Marco', () => addMilestone(project, ws)));
  actions.appendChild(iconButton('✕', 'Excluir workstream', () => deleteWorkstream(project, ws)));
  wrap.appendChild(actions);

  td.appendChild(wrap);
  tr.appendChild(td);
  return tr;
}

function buildItemRow(project, ws, item) {
  const tr = document.createElement('tr');
  tr.className = 'item-row';

  tr.appendChild(document.createElement('td')); // coluna de indentação

  const typeTd = document.createElement('td');
  const badge = document.createElement('span');
  badge.className = 'type-badge type-' + item.type;
  badge.textContent = item.type === 'task' ? 'Tarefa' : 'Marco';
  typeTd.appendChild(badge);
  tr.appendChild(typeTd);

  tr.appendChild(textCell(item.name, (value) => {
    const name = value.trim();
    if (!name) { showToast('Informe um nome.'); return false; }
    item.name = name;
    return true;
  }));

  if (item.type === 'task') {
    tr.appendChild(dateCell(item.start, (value) => {
      if (value > item.end) { showToast('O início não pode ser depois do fim.'); return false; }
      item.start = value;
      return true;
    }));
    tr.appendChild(dateCell(item.end, (value) => {
      if (value < item.start) { showToast('O fim não pode ser antes do início.'); return false; }
      item.end = value;
      return true;
    }));
    tr.appendChild(progressCell(item));
    tr.appendChild(expectedCell(item));
    tr.appendChild(emptyCell());
    tr.appendChild(emptyCell());
  } else {
    tr.appendChild(emptyCell());
    tr.appendChild(emptyCell());
    tr.appendChild(emptyCell());
    tr.appendChild(emptyCell());
    tr.appendChild(dateCell(item.date, (value) => {
      item.date = value;
      return true;
    }));
    tr.appendChild(doneCell(item));
  }

  const actionsTd = document.createElement('td');
  actionsTd.appendChild(iconButton('✕', 'Excluir', () => deleteItem(project, ws, item)));
  tr.appendChild(actionsTd);

  return tr;
}

function commitField(input, getValue, apply) {
  input.addEventListener('change', () => {
    const value = getValue();
    const ok = apply(value);
    if (ok === false) {
      renderTable();
      return;
    }
    saveState();
    renderTable();
  });
}

function textCell(value, apply) {
  const td = document.createElement('td');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'cell-input';
  input.value = value;
  commitField(input, () => input.value, apply);
  td.appendChild(input);
  return td;
}

function dateCell(value, apply) {
  const td = document.createElement('td');
  const input = document.createElement('input');
  input.type = 'date';
  input.className = 'cell-input cell-date';
  input.value = value;
  commitField(input, () => input.value, (v) => {
    if (!v) { showToast('Informe uma data.'); return false; }
    return apply(v);
  });
  td.appendChild(input);
  return td;
}

function progressCell(item) {
  const td = document.createElement('td');
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.max = '100';
  input.step = '5';
  input.className = 'cell-input cell-number';
  const actual = Math.min(100, Math.max(0, item.progress || 0));
  input.value = actual;
  const expected = computeExpectedProgress(item);
  input.classList.add('status-' + progressStatusClass(actual, expected));
  commitField(input, () => Math.min(100, Math.max(0, Number(input.value) || 0)), (v) => {
    item.progress = v;
    return true;
  });
  td.appendChild(input);
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
  const label = document.createElement('label');
  label.className = 'done-checkbox-label';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = !!item.done;
  checkbox.addEventListener('change', () => {
    item.done = checkbox.checked;
    saveState();
    renderTable();
  });
  label.appendChild(checkbox);
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

function smallButton(label, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-ghost btn-small';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function iconButton(symbol, title, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-icon';
  btn.textContent = symbol;
  btn.title = title;
  btn.addEventListener('click', onClick);
  return btn;
}

/* ------------------------------- Ações ------------------------------- */

function addProjectPrompt() {
  const name = window.prompt('Nome do novo projeto:');
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) { showToast('Informe um nome para o projeto.'); return; }
  const color = PALETTE[state.projects.length % PALETTE.length];
  state.projects.push({ id: uid('p'), name: trimmed, color, collapsed: false, workstreams: [] });
  saveState();
  renderTable();
  showToast('Projeto criado.');
}

function addWorkstream(project) {
  const name = window.prompt('Nome da nova workstream:');
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) { showToast('Informe um nome para a workstream.'); return; }
  project.workstreams.push({ id: uid('ws'), name: trimmed, items: [] });
  saveState();
  renderTable();
  showToast('Workstream criada.');
}

function addTask(project, ws) {
  const start = todayISO();
  const end = toISO(addDays(parseDate(start), 14));
  ws.items.push({ id: uid('t'), type: 'task', name: 'Nova tarefa', start, end, progress: 0 });
  saveState();
  renderTable();
  showToast('Tarefa criada — edite os campos na tabela.');
}

function addMilestone(project, ws) {
  ws.items.push({ id: uid('m'), type: 'milestone', name: 'Novo marco', date: todayISO(), done: false });
  saveState();
  renderTable();
  showToast('Marco criado — edite os campos na tabela.');
}

function deleteProject(project) {
  if (!window.confirm(`Excluir o projeto "${project.name}" e todas as suas workstreams?`)) return;
  state.projects = state.projects.filter((p) => p.id !== project.id);
  saveState();
  renderTable();
  showToast('Projeto excluído.');
}

function deleteWorkstream(project, ws) {
  if (!window.confirm(`Excluir a workstream "${ws.name}" e todos os seus itens?`)) return;
  project.workstreams = project.workstreams.filter((w) => w.id !== ws.id);
  saveState();
  renderTable();
  showToast('Workstream excluída.');
}

function deleteItem(project, ws, item) {
  const kind = item.type === 'task' ? 'tarefa' : 'marco';
  if (!window.confirm(`Excluir ${kind} "${item.name}"?`)) return;
  ws.items = ws.items.filter((i) => i.id !== item.id);
  saveState();
  renderTable();
  showToast(kind[0].toUpperCase() + kind.slice(1) + ' excluído(a).');
}

/* ---------------------------------- Init ------------------------------------ */

document.getElementById('addProjectBtn').addEventListener('click', addProjectPrompt);
document.getElementById('emptyAddProjectBtn').addEventListener('click', addProjectPrompt);

renderTable();

// Estado salvo em versão antiga: shared.js já mesclou automaticamente as
// workstreams/marcos novos de seedState() (só o que faltava) — avisa aqui
// porque showToast só existe depois que este arquivo carrega.
if (seedMigrationHappened) {
  showToast('Roadmap atualizado com novos marcos (ex.: poços exploratórios).');
}
