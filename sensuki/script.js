/* ---------- STATE ---------- */
let uidCounter = 1;
function uid(){ return 'n' + (uidCounter++) + '_' + Math.random().toString(36).slice(2,7); }

const state = {
  settings: {
    aName: 'Alpha', aShort: 'A', aSex: 'Male',
    bName: 'Beta',  bShort: 'B', bSex: 'Female'
  },
  main: [ mkPara() ]
};

function mkPara(text){ return { type:'para', id: uid(), text: text||'' }; }
function mkTag(name){ return { type:'tag', id: uid(), name: name||'Tag' }; }
function mkEnd(){ return { type:'end', id: uid() }; }
function mkChoice(options, mergeHeader){
  return { type:'choice', id: uid(), options: options, mergeHeader: mergeHeader || ('Merged'+uidCounter) };
}

let selectedId = null;
let previousTabBeforeEdit = 'project';
let currentTab = 'project';

/* ---------- TREE HELPERS ---------- */
function walk(items, cb){
  for(let i=0;i<items.length;i++){
    const item = items[i];
    cb(item, items, i);
    if(item.type === 'choice'){
      item.options.forEach(opt => walk(opt.items, cb));
    }
  }
}
function findById(id){
  let found = null;
  walk(state.main, (item, arr, idx) => { if(item.id === id) found = { item, arr, idx }; });
  return found;
}
function isMainBranch(items){ return items === state.main; }

/* ============================================================
   TEXT RESOLUTION (template rendering)
   ============================================================ */
const GENDER_RE = /\{\[SEX\]\[(a|b)\]-\[Male\]([\s\S]*?)\[Female\]([\s\S]*?)\[\]([\s\S]*?)\}/g;

function escapeHtml(s){
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Pretty HTML for the flowchart cell display (settings-aware)
function prettify(raw){
  if(!raw) return '';
  let s = escapeHtml(raw);
  s = s.replace(GENDER_RE, (m, who, male, female, other) => {
    const label = who === 'a' ? (state.settings.aShort || 'A') : (state.settings.bShort || 'B');
    return `<span class="tpl tpl-cond">⚥ ${label}: ♂${male.trim()||'—'} / ♀${female.trim()||'—'} / ⚧${other.trim()||'—'}</span>`;
  });
  s = s.replace(/\{A\}/g, `<span class="tpl">${escapeHtml(state.settings.aName||'Character A')}</span>`);
  s = s.replace(/\{a\}/g, `<span class="tpl">${escapeHtml(state.settings.aShort||'A')}</span>`);
  s = s.replace(/\{B\}/g, `<span class="tpl">${escapeHtml(state.settings.bName||'Character B')}</span>`);
  s = s.replace(/\{b\}/g, `<span class="tpl">${escapeHtml(state.settings.bShort||'B')}</span>`);
  return s;
}

// Fully resolved plain text, for preview execution
function resolveText(raw){
  if(!raw) return '';
  let s = raw.replace(GENDER_RE, (m, who, male, female, other) => {
    const sex = who === 'a' ? state.settings.aSex : state.settings.bSex;
    if(sex === 'Male') return male;
    if(sex === 'Female') return female;
    return other;
  });
  s = s.split('{A}').join(state.settings.aName || 'Character A');
  s = s.split('{a}').join(state.settings.aShort || 'A');
  s = s.split('{B}').join(state.settings.bName || 'Character B');
  s = s.split('{b}').join(state.settings.bShort || 'B');
  return s;
}

/* ============================================================
   SERIALIZATION  (tree -> guide.txt-style script)
   ============================================================ */
function serialize(items, indent){
  indent = indent || '';
  const out = [];
  items.forEach(item => {
    if(item.type === 'para'){
      out.push(indent + (item.text||'').replace(/\n/g, ' ').trim());
    } else if(item.type === 'tag'){
      out.push(indent + '@Tag@' + item.name);
    } else if(item.type === 'end'){
      out.push(indent + '->结束');
    } else if(item.type === 'choice'){
      out.push(indent + '@Choice Branch Start');
      item.options.forEach(opt => {
        out.push(indent + '  ' + opt.label + '->' + opt.header);
      });
      out.push(indent + '@Choice Branch End');
      item.options.forEach((opt, idx) => {
        out.push('==' + opt.header);
        out.push(...serialize(opt.items, '  '));
        if(idx < item.options.length - 1){
          out.push('  ->' + item.mergeHeader);
        }
      });
      out.push('==' + item.mergeHeader);
    }
  });
  return out;
}
function serializeProject(){
  return serialize(state.main, '').join('\n');
}

/* ============================================================
   PARSING  (guide.txt-style script -> tree)
   Indentation-agnostic: classification is based on line prefix markers.
   ============================================================ */
function parseProject(text){
  const lines = text.split('\n');
  let idx = 0;

  function peekTrim(){ return idx < lines.length ? lines[idx].trim() : null; }

  function parseSeq(){
    const items = [];
    while(idx < lines.length){
      const line = lines[idx].trim();
      if(line === ''){ idx++; continue; }
      if(line.startsWith('#')){ idx++; continue; } // comment
      if(line.startsWith('==')){ break; } // header boundary — stop, let caller consume

      if(line === '@Choice Branch Start'){
        idx++;
        const options = [];
        while(idx < lines.length && lines[idx].trim() !== '@Choice Branch End'){
          const l = lines[idx].trim();
          if(l){
            const m = l.match(/^(.*)->(.+)$/);
            if(m) options.push({ id: uid(), label: m[1].trim(), header: m[2].trim(), items: [] });
          }
          idx++;
        }
        if(idx < lines.length) idx++; // consume Branch End

        options.forEach((opt) => {
          while(idx < lines.length && lines[idx].trim() === '') idx++;
          const expected = '==' + opt.header;
          if(idx < lines.length && lines[idx].trim() === expected){
            idx++;
            opt.items = parseSeq();
            // strip trailing merge-jump marker line if present
            if(opt.items.length && opt.items[opt.items.length-1].type === '__jump'){
              opt.items.pop();
            }
          }
        });

        let mergeHeader = 'Merged' + uidCounter;
        while(idx < lines.length && lines[idx].trim() === '') idx++;
        if(idx < lines.length && lines[idx].trim().startsWith('==')){
          mergeHeader = lines[idx].trim().slice(2);
          idx++;
        }
        items.push(mkChoiceFromParsed(options, mergeHeader));
        continue;
      }

      if(line.startsWith('@Tag@')){
        items.push(mkTag(line.slice(5).trim()));
        idx++; continue;
      }
      if(line === '->结束'){
        items.push(mkEnd());
        idx++; continue;
      }
      const jm = line.match(/^->(.+)$/);
      if(jm){
        items.push({ type:'__jump', id: uid(), target: jm[1].trim() });
        idx++; continue;
      }
      items.push(mkPara(line));
      idx++;
    }
    return items;
  }

  const main = parseSeq();
  // drop any stray jump markers that leaked to top level
  return main.filter(i => i.type !== '__jump');
}
function mkChoiceFromParsed(options, mergeHeader){
  options.forEach(o => { o.items = o.items.filter(i => i.type !== '__jump'); });
  return { type:'choice', id: uid(), options, mergeHeader };
}

/* ============================================================
   RENDERING — FLOWCHART
   ============================================================ */
const flowCanvas = document.getElementById('flow-canvas');

function rerenderAll(){
  flowCanvas.innerHTML = '';
  flowCanvas.appendChild(renderBranch(state.main));
  if(currentTab === 'project') refreshProjectText();
}

function renderBranch(items){
  const wrap = document.createElement('div');
  wrap.className = 'flow-branch';
  const onlySlot = items.length === 0;

  wrap.appendChild(renderSlot(items, 0, onlySlot));
  items.forEach((item, i) => {
    wrap.appendChild(renderItem(item, items, i));
    wrap.appendChild(renderSlot(items, i+1, false));
  });
  return wrap;
}

function renderSlot(items, i, isOnlySlot){
  const slot = document.createElement('div');
  slot.className = 'slot';
  const line = document.createElement('div');
  line.className = 'slot-line';
  slot.appendChild(line);

  const btn = document.createElement('button');
  btn.className = 'slot-add';
  btn.type = 'button';
  btn.textContent = '+';
  slot.appendChild(btn);

  const isBottomish = isOnlySlot || i > 0;
  const allowChoice = isBottomish;
  const allowEnd = !isMainBranch(items) && (isOnlySlot || i === items.length);

  const menu = document.createElement('div');
  menu.className = 'slot-menu';
  menu.appendChild(menuBtn('✎', 'New Paragraph', () => {
    const p = mkPara();
    items.splice(i, 0, p);
    rerenderAll();
    selectItem(p.id);
  }));
  if(allowChoice){
    menu.appendChild(menuBtn('⑂', 'New Choice', () => {
      openChoiceModal(items, i);
    }));
  }
  menu.appendChild(menuBtn('🏷', 'New Tag', () => {
    openTagModal(items, i);
  }));
  if(allowEnd){
    menu.appendChild(menuBtn('✕', 'End of Story', () => {
      items.splice(i, 0, mkEnd());
      rerenderAll();
    }));
  }
  slot.appendChild(menu);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = menu.classList.contains('open');
    closeAllSlotMenus();
    if(!wasOpen){ menu.classList.add('open'); btn.classList.add('menu-open'); }
  });

  return slot;
}
function menuBtn(icon, label, onClick){
  const b = document.createElement('button');
  b.innerHTML = `<span class="menu-icon">${icon}</span> ${label}`;
  b.addEventListener('click', (e) => { e.stopPropagation(); closeAllSlotMenus(); onClick(); });
  return b;
}
function closeAllSlotMenus(){
  document.querySelectorAll('.slot-menu.open').forEach(m => m.classList.remove('open'));
  document.querySelectorAll('.slot-add.menu-open').forEach(b => b.classList.remove('menu-open'));
}
document.addEventListener('click', closeAllSlotMenus);

function renderItem(item, items, idx){
  if(item.type === 'para') return renderParaCell(item, items, idx);
  if(item.type === 'tag') return renderTagCell(item, items, idx);
  if(item.type === 'end') return renderEndCell(item, items, idx);
  if(item.type === 'choice') return renderChoiceBlock(item, items, idx);
}

function makeDraggableWrapper(el, item){
  el.draggable = true;
  el.dataset.itemId = item.id;
  el.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    e.dataTransfer.setData('text/plain', item.id);
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(()=> el.classList.add('dragging'), 0);
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  el.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
  el.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    const sourceId = e.dataTransfer.getData('text/plain');
    if(sourceId && sourceId !== item.id){
      const before = e.clientY < (el.getBoundingClientRect().top + el.getBoundingClientRect().height/2);
      moveItem(sourceId, item.id, before);
    }
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, item.id);
  });
}

function moveItem(sourceId, targetId, before){
  const src = findById(sourceId);
  const tgt = findById(targetId);
  if(!src || !tgt) return;
  if(src.arr !== tgt.arr) return; // only reorder within the same branch
  const sourceItem = src.item;
  src.arr.splice(src.arr.indexOf(sourceItem), 1);
  let newIdx = tgt.arr.indexOf(tgt.item);
  if(!before) newIdx += 1;
  src.arr.splice(newIdx, 0, sourceItem);
  rerenderAll();
}

function renderParaCell(item, items, idx){
  const el = document.createElement('div');
  el.className = 'cell';
  if(item.id === selectedId) el.classList.add('selected');
  const label = document.createElement('div');
  label.className = 'cell-label';
  label.textContent = 'Paragraph';
  const text = document.createElement('div');
  text.className = 'cell-text' + (item.text ? '' : ' empty');
  text.innerHTML = prettify(item.text);
  el.appendChild(label);
  el.appendChild(text);
  el.addEventListener('click', () => selectItem(item.id));
  makeDraggableWrapper(el, item);
  return el;
}

function renderTagCell(item, items, idx){
  const el = document.createElement('div');
  el.className = 'tag-cell';
  if(item.id === selectedId) el.style.outline = '2px solid var(--orange-deep)';
  el.innerHTML = `<span class="tag-icon">🏷</span> ${escapeHtml(item.name)}`;
  el.addEventListener('click', () => selectItem(item.id));
  makeDraggableWrapper(el, item);
  return el;
}

function renderEndCell(item, items, idx){
  const el = document.createElement('div');
  el.className = 'end-cell';
  el.textContent = '✕ End of Story';
  makeDraggableWrapper(el, item);
  return el;
}

function renderChoiceBlock(item, items, idx){
  const block = document.createElement('div');
  block.className = 'choice-block';
  makeDraggableWrapper(block, item);

  const badge = document.createElement('div');
  badge.className = 'choice-header-badge';
  badge.textContent = '⑂ CHOICE';
  block.appendChild(badge);

  const lanes = document.createElement('div');
  lanes.className = 'choice-lanes';
  item.options.forEach(opt => {
    const lane = document.createElement('div');
    lane.className = 'lane';
    const laneLabel = document.createElement('div');
    laneLabel.className = 'lane-label';
    laneLabel.textContent = (opt.label || 'Choice') + '  ·  ' + opt.header;
    lane.appendChild(laneLabel);
    lane.appendChild(renderBranch(opt.items));
    lanes.appendChild(lane);
  });
  block.appendChild(lanes);

  const merge = document.createElement('div');
  merge.className = 'merge-badge';
  merge.textContent = '⇢ ' + item.mergeHeader;
  block.appendChild(merge);

  return block;
}

/* ---------- CONTEXT MENU ---------- */
const contextMenu = document.getElementById('context-menu');
let contextTargetId = null;
function openContextMenu(x, y, itemId){
  contextTargetId = itemId;
  contextMenu.style.left = x + 'px';
  contextMenu.style.top = y + 'px';
  contextMenu.classList.add('open');
}
document.addEventListener('click', () => contextMenu.classList.remove('open'));
contextMenu.querySelector('[data-action="delete"]').addEventListener('click', () => {
  if(contextTargetId){
    const found = findById(contextTargetId);
    if(found){
      found.arr.splice(found.idx, 1);
      if(selectedId === contextTargetId) closeEditor();
      rerenderAll();
    }
  }
  contextMenu.classList.remove('open');
});

/* ============================================================
   TABS / PANEL SWITCHING
   ============================================================ */
const tabButtons = document.querySelectorAll('.tab');
const panelViews = document.querySelectorAll('.panel-view');

function setTab(name){
  currentTab = name;
  tabButtons.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  panelViews.forEach(v => v.classList.toggle('active', v.dataset.view === name));
  if(name === 'project') refreshProjectText();
  if(name === 'settings') loadSettingsForm();
}
tabButtons.forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));

function showEditorView(){
  panelViews.forEach(v => v.classList.toggle('active', v.dataset.view === 'editor'));
  tabButtons.forEach(b => b.classList.remove('active'));
}
function closeEditor(){
  selectedId = null;
  setTab(previousTabBeforeEdit);
  rerenderAll();
}
document.getElementById('btn-close-editor').addEventListener('click', () => {
  saveCurrentEditor();
  closeEditor();
});

/* ============================================================
   SELECTION / EDITOR
   ============================================================ */
const editorTitle = document.getElementById('editor-title');
const editorParagraphBox = document.getElementById('editor-paragraph');
const editorTagBox = document.getElementById('editor-tag');
const editorTextarea = document.getElementById('editor-textarea');
const editorTagInput = document.getElementById('editor-tag-input');

function selectItem(id){
  const found = findById(id);
  if(!found) return;
  if(found.item.type === 'end' || found.item.type === 'choice') return; // not directly editable
  if(selectedId !== id){
    previousTabBeforeEdit = (currentTab === 'editor') ? previousTabBeforeEdit : currentTab;
  }
  selectedId = id;
  rerenderAll();
  showEditorView();

  if(found.item.type === 'para'){
    editorTitle.textContent = 'Edit Paragraph';
    editorParagraphBox.style.display = '';
    editorTagBox.style.display = 'none';
    editorTextarea.value = found.item.text;
    setTimeout(() => editorTextarea.focus(), 30);
  } else if(found.item.type === 'tag'){
    editorTitle.textContent = 'Edit Tag';
    editorParagraphBox.style.display = 'none';
    editorTagBox.style.display = '';
    editorTagInput.value = found.item.name;
    setTimeout(() => editorTagInput.focus(), 30);
  }
}

function saveCurrentEditor(){
  if(!selectedId) return;
  const found = findById(selectedId);
  if(!found) return;
  if(found.item.type === 'para'){
    found.item.text = editorTextarea.value;
  } else if(found.item.type === 'tag'){
    found.item.name = editorTagInput.value.trim() || 'Tag';
  }
}

document.getElementById('btn-save-cell').addEventListener('click', () => {
  saveCurrentEditor();
  closeEditor();
});

function insertAtCursor(textarea, text){
  const start = textarea.selectionStart, end = textarea.selectionEnd;
  const val = textarea.value;
  textarea.value = val.slice(0, start) + text + val.slice(end);
  const pos = start + text.length;
  textarea.selectionStart = textarea.selectionEnd = pos;
  textarea.focus();
}
document.querySelectorAll('.chip[data-insert]').forEach(chip => {
  chip.addEventListener('click', () => insertAtCursor(editorTextarea, chip.dataset.insert));
});

/* ---------- Gender-conditional magic button ---------- */
const modalGender = document.getElementById('modal-gender');
document.getElementById('btn-magic-gender').addEventListener('click', () => {
  document.getElementById('gender-male-text').value = '';
  document.getElementById('gender-female-text').value = '';
  document.getElementById('gender-other-text').value = '';
  openModal(modalGender);
});
document.getElementById('btn-confirm-gender').addEventListener('click', () => {
  const who = document.querySelector('input[name="gender-target"]:checked').value;
  const male = document.getElementById('gender-male-text').value || '';
  const female = document.getElementById('gender-female-text').value || '';
  const other = document.getElementById('gender-other-text').value || '';
  const token = `{[SEX][${who}]-[Male]${male}[Female]${female}[]${other}}`;
  insertAtCursor(editorTextarea, token);
  closeModal(modalGender);
});

/* ============================================================
   MODALS (generic open/close)
   ============================================================ */
function openModal(el){ el.classList.add('open'); }
function closeModal(el){ el.classList.remove('open'); }
document.querySelectorAll('[data-close-modal]').forEach(btn => {
  btn.addEventListener('click', () => btn.closest('.modal-backdrop').classList.remove('open'));
});
document.querySelectorAll('.modal-backdrop').forEach(bd => {
  bd.addEventListener('click', (e) => { if(e.target === bd) bd.classList.remove('open'); });
});

/* ---------- Tag modal ---------- */
const modalTag = document.getElementById('modal-tag');
let pendingTagInsert = null;
function openTagModal(items, i){
  pendingTagInsert = { items, i };
  document.getElementById('tag-name-input').value = '';
  openModal(modalTag);
  setTimeout(()=> document.getElementById('tag-name-input').focus(), 30);
}
document.getElementById('btn-confirm-tag').addEventListener('click', () => {
  if(!pendingTagInsert) return;
  const name = document.getElementById('tag-name-input').value.trim() || 'Tag';
  pendingTagInsert.items.splice(pendingTagInsert.i, 0, mkTag(name));
  closeModal(modalTag);
  rerenderAll();
  pendingTagInsert = null;
});

/* ---------- Choice modal ---------- */
const modalChoice = document.getElementById('modal-choice');
const choiceOptionsList = document.getElementById('choice-options-list');
let pendingChoiceInsert = null;
let choiceOptionCounter = 0;

function openChoiceModal(items, i){
  pendingChoiceInsert = { items, i };
  choiceOptionsList.innerHTML = '';
  choiceOptionCounter = 0;
  addChoiceOptionRow('Choice 1', 'Node1');
  addChoiceOptionRow('Choice 2', 'Node2');
  document.getElementById('choice-merge-name').value = 'Merged' + (uidCounter);
  openModal(modalChoice);
}
function addChoiceOptionRow(label, header){
  choiceOptionCounter++;
  const row = document.createElement('div');
  row.className = 'choice-option-row';
  row.innerHTML = `
    <input type="text" class="opt-label" placeholder="Choice text" value="${escapeHtml(label||'')}">
    <input type="text" class="opt-header" placeholder="Header, e.g. Node${choiceOptionCounter}" value="${escapeHtml(header||'')}">
    <button type="button" title="Remove">✕</button>`;
  row.querySelector('button').addEventListener('click', () => {
    if(choiceOptionsList.children.length > 2) row.remove();
  });
  choiceOptionsList.appendChild(row);
}
document.getElementById('btn-add-choice-option').addEventListener('click', () => {
  addChoiceOptionRow('Choice ' + (choiceOptionsList.children.length+1), 'Node' + (choiceOptionsList.children.length+1));
});
document.getElementById('btn-confirm-choice').addEventListener('click', () => {
  if(!pendingChoiceInsert) return;
  const rows = [...choiceOptionsList.querySelectorAll('.choice-option-row')];
  if(rows.length < 2){ alert('Add at least two choices.'); return; }
  const options = rows.map((row, idx) => ({
    id: uid(),
    label: row.querySelector('.opt-label').value.trim() || ('Choice ' + (idx+1)),
    header: row.querySelector('.opt-header').value.trim() || ('Node' + (idx+1) + '_' + uid().slice(0,4)),
    items: [ mkPara() ]
  }));
  const mergeHeader = document.getElementById('choice-merge-name').value.trim() || ('Merged' + uidCounter);
  const choice = mkChoice(options, mergeHeader);
  pendingChoiceInsert.items.splice(pendingChoiceInsert.i, 0, choice);
  closeModal(modalChoice);
  rerenderAll();
  pendingChoiceInsert = null;
});

/* ============================================================
   PROJECT TAB (text sync)
   ============================================================ */
const projectTextarea = document.getElementById('project-text');
const parseStatus = document.getElementById('parse-status');

function refreshProjectText(){
  if(document.activeElement === projectTextarea) return; // don't clobber active typing
  projectTextarea.value = serializeProject();
  parseStatus.textContent = '';
  parseStatus.classList.remove('error');
}
document.getElementById('btn-apply-text').addEventListener('click', () => {
  try{
    const parsed = parseProject(projectTextarea.value);
    state.main = parsed.length ? parsed : [ mkPara() ];
    selectedId = null;
    rerenderAll();
    parseStatus.textContent = '✓ Applied';
    parseStatus.classList.remove('error');
  }catch(err){
    parseStatus.textContent = 'Parse error: ' + err.message;
    parseStatus.classList.add('error');
  }
});

/* ============================================================
   SETTINGS TAB
   ============================================================ */
function loadSettingsForm(){
  document.getElementById('set-a-name').value = state.settings.aName;
  document.getElementById('set-a-short').value = state.settings.aShort;
  document.getElementById('set-b-name').value = state.settings.bName;
  document.getElementById('set-b-short').value = state.settings.bShort;
  document.querySelector(`input[name="a-sex"][value="${state.settings.aSex}"]`).checked = true;
  document.querySelector(`input[name="b-sex"][value="${state.settings.bSex}"]`).checked = true;
}
document.getElementById('btn-save-settings').addEventListener('click', () => {
  state.settings.aName = document.getElementById('set-a-name').value.trim() || 'Character A';
  state.settings.aShort = document.getElementById('set-a-short').value.trim() || 'A';
  state.settings.bName = document.getElementById('set-b-name').value.trim() || 'Character B';
  state.settings.bShort = document.getElementById('set-b-short').value.trim() || 'B';
  state.settings.aSex = document.querySelector('input[name="a-sex"]:checked').value;
  state.settings.bSex = document.querySelector('input[name="b-sex"]:checked').value;
  rerenderAll();
});

/* ============================================================
   PREVIEW
   ============================================================ */
const previewLog = document.getElementById('preview-log');
const previewChoicesEl = document.getElementById('preview-choices');
const previewWindow = document.getElementById('preview-window');
const previewAdvance = document.getElementById('preview-advance');
let previewStack = [];
let waitingChoice = false;

function startPreview(){
  previewLog.innerHTML = '';
  previewChoicesEl.innerHTML = '';
  waitingChoice = false;
  previewStack = [{ items: state.main, idx: 0 }];
  previewAdvance.style.display = '';
  previewStep();
}
function printLine(text){
  const div = document.createElement('div');
  div.className = 'preview-line';
  div.textContent = text;
  previewLog.appendChild(div);
  previewLog.scrollTop = previewLog.scrollHeight;
}
function printTag(name){
  const div = document.createElement('div');
  div.className = 'preview-tag';
  div.textContent = '@' + name + '';
  previewLog.appendChild(div);
  previewLog.scrollTop = previewLog.scrollHeight;
}
function printEnd(){
  const div = document.createElement('div');
  div.className = 'preview-tag';
  div.textContent = '— End of Story —';
  previewLog.appendChild(div);
  previewAdvance.style.display = 'none';
}
function previewStep(){
  while(previewStack.length && previewStack[previewStack.length-1].idx >= previewStack[previewStack.length-1].items.length){
    previewStack.pop();
  }
  if(!previewStack.length){ printEnd(); return; }
  const frame = previewStack[previewStack.length-1];
  const item = frame.items[frame.idx];

  if(item.type === 'para'){
    frame.idx++;
    printLine(resolveText(item.text) || '…');
    waitingChoice = false;
  } else if(item.type === 'tag'){
    frame.idx++;
    printTag(item.name);
    previewStep();
  } else if(item.type === 'end'){
    frame.idx = frame.items.length;
    printEnd();
  } else if(item.type === 'choice'){
    frame.idx++; // consume choice once resolved
    renderPreviewChoices(item, frame);
    waitingChoice = true;
  }
}
function renderPreviewChoices(choiceItem, parentFrame){
  previewChoicesEl.innerHTML = '';
  previewAdvance.style.display = 'none';
  choiceItem.options.forEach(opt => {
    const b = document.createElement('button');
    b.className = 'preview-choice-btn';
    b.textContent = resolveText(opt.label);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      previewChoicesEl.innerHTML = '';
      previewAdvance.style.display = '';
      previewStack.push({ items: opt.items, idx: 0 });
      previewStep();
    });
    previewChoicesEl.appendChild(b);
  });
}
previewWindow.addEventListener('click', () => { if(!waitingChoice) previewStep(); });
previewWindow.addEventListener('keydown', (e) => {
  if(e.key === 'Enter' && !waitingChoice){ e.preventDefault(); previewStep(); }
});
document.getElementById('btn-restart-preview').addEventListener('click', startPreview);

const _baseSetTab = setTab;
setTab = function(name){
  _baseSetTab(name);
  if(name === 'preview') startPreview();
};

/* ============================================================
   IMPORT / EXPORT
   ============================================================ */
document.getElementById('btn-export').addEventListener('click', () => {
  const settingsComment = '# sensuki-settings: ' + JSON.stringify(state.settings) + '\n';
  const blob = new Blob([serializeProject()], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'story.txt';
  a.click();
  URL.revokeObjectURL(url);
});
document.getElementById('btn-import').addEventListener('click', () => document.getElementById('file-input').click());
document.getElementById('file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const text = reader.result;
    const settingsMatch = text.match(/^#\s*sensuki-settings:\s*(\{.*\})\s*$/m);
    if(settingsMatch){
      try{ Object.assign(state.settings, JSON.parse(settingsMatch[1])); }catch(err){}
    }
    try{
      const parsed = parseProject(text);
      state.main = parsed.length ? parsed : [ mkPara() ];
      selectedId = null;
      rerenderAll();
      setTab('project');
    }catch(err){
      alert('Could not import file: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

/* ============================================================
   INIT
   ============================================================ */
rerenderAll();
setTab('project');