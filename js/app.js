import { Explored } from './explored.js';
import { MapView } from './mapview.js';
import { store } from './store.js';
import { locate, detectPlayerMarker, MARKER_MAP_HEIGHT } from './match.js';
import { PinManager } from './pins.js';
import {
  categories, catById, customCategories, currentOrder, isCustom,
  setCustomCategories, addCustomCategory, removeCustomCategory, setOrder,
} from './categories.js';

const $ = s => document.querySelector(s);

let view, explored, pins, mapImage;
let newPinPending = null; // freshly created pin waiting for its area screenshot
let lastUndo = null;      // { snap, pinId } — one level of paste undo
let learnedScale = null;  // map-px per screenshot-px from past successes

// three-tier confidence, calibrated on 25 real screenshots: correct matches
// have ratio (runner-up/best peak) 0.44-0.92, wrong ones 0.90-0.98.
// Certain matches apply instantly; the overlap zone gets a yes/no check;
// only clear junk is refused outright.
const AUTO_RATIO = 0.85;
const MAX_RATIO = 0.985;
const MIN_SCORE = 0.15;
const certain = rect => rect && rect.score >= MIN_SCORE && (rect.ratio ?? 1) <= AUTO_RATIO;
const plausible = rect => rect && rect.score >= MIN_SCORE && (rect.ratio ?? 1) <= MAX_RATIO;
const confStr = rect => rect
  ? `match ${rect.score.toFixed(2)}, uniqueness ${(1 - (rect.ratio ?? 1)).toFixed(2)}`
  : 'no match';

// ---------------------------------------------------------------- utilities

function toast(msg, kind = '', action = null) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = action.label;
    b.addEventListener('click', () => { el.remove(); action.fn(); });
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), action ? 8000 : 4200);
}

function spinner(show, msg) {
  $('#spinner').classList.toggle('hidden', !show);
  if (msg) $('#spinner-msg').textContent = msg;
}

function showAwaitDialog(title, sub, skipLabel) {
  $('#await-title').textContent = title;
  $('#await-sub').innerHTML = sub;
  $('#btn-await-skip').textContent = skipLabel;
  $('#dlg-await').showModal();
}

// one-level undo of the last paste (explored composite + created pin)
function snapshotForUndo(pinId = null) {
  lastUndo = { snap: explored.snapshot(), pinId };
}

function undoLast() {
  if (!lastUndo) { toast('Nothing to undo.'); return; }
  explored.restore(lastUndo.snap);
  if (lastUndo.pinId) {
    pins.remove(lastUndo.pinId);
    store.deletePin(lastUndo.pinId);
    if (newPinPending && newPinPending.id === lastUndo.pinId) newPinPending = null;
    if ($('#dlg-await').open) $('#dlg-await').close();
  }
  lastUndo = null;
  toast('Undone.', 'ok');
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function blobToDataURL(blob) {
  return new Promise(res => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(blob);
  });
}

async function dataURLToBlob(url) {
  return (await fetch(url)).blob();
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Could not load ' + src));
    img.src = src;
  });
}

function showLightbox(url) {
  const box = document.createElement('div');
  box.id = 'lightbox';
  const img = document.createElement('img');
  img.src = url;
  box.appendChild(img);
  box.addEventListener('click', () => box.remove());
  document.body.appendChild(box);
}

// ------------------------------------------------------------- persistence

const saveFog = debounce(async () => {
  store.putMeta('fog', await explored.toBlob());
}, 1500);

const saveView = debounce(() => {
  store.putMeta('view', { scale: view.scale, ox: view.ox, oy: view.oy });
}, 800);

function persistPin(data) {
  store.putPin(data);
}

// ------------------------------------------------- uncertain-match confirm

let confirmActive = null; // resolve fn while the yes/no bar is up

// Show the screenshot pinned at the proposed spot (not movable) and ask
// yes/no. Resolves true to apply, false to cancel.
function previewConfirm(bitmap, rect) {
  return new Promise(resolve => {
    confirmActive = resolve;
    view.setPlacement({ img: bitmap, x: rect.x, y: rect.y, w: rect.w, locked: true });
    view.centerOn(rect.x + rect.w / 2, rect.y + rect.h / 2,
      Math.min(1, (window.innerWidth * 0.55) / rect.w));
    $('#confirm-bar').classList.remove('hidden');
    $('#paste-hint').classList.add('hidden');
  });
}

function endConfirm(apply) {
  if (!confirmActive) return;
  view.setPlacement(null);
  $('#confirm-bar').classList.add('hidden');
  $('#paste-hint').classList.remove('hidden');
  const resolve = confirmActive;
  confirmActive = null;
  resolve(apply);
}

$('#btn-confirm-ok').addEventListener('click', () => endConfirm(true));
$('#btn-confirm-cancel').addEventListener('click', () => endConfirm(false));

// ---------------------------------------------------------------- keyboard

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && placing) { stopPlacing(); return; }
  if (confirmActive && !document.querySelector('dialog[open]')) {
    if (e.key === 'Enter') { endConfirm(true); return; }
    if (e.key === 'Escape') { endConfirm(false); return; }
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z'
      && !document.querySelector('dialog[open]')) {
    e.preventDefault();
    undoLast();
  }
});
$('#btn-await-skip').addEventListener('click', () => skipAwaitingEnv());
$('#dlg-await').addEventListener('cancel', e => { e.preventDefault(); skipAwaitingEnv(); });

// ------------------------------------------------------------- pin editing

function openPinEditor(data, isNew) {
  const dlg = $('#dlg-pin');
  $('#pin-dlg-title').textContent = isNew ? 'New pin — what is here?' : 'Edit pin';
  const cats = $('#pin-cats');
  cats.innerHTML = '';
  let selected = data.cat || 'other';
  for (const c of categories()) {
    const b = document.createElement('button');
    b.className = 'cat-btn' + (c.id === selected ? ' on' : '');
    b.style.setProperty('--pc', c.color || '#9e2b25');
    b.innerHTML = `<span class="cb-ico">${c.icon}</span><span>${c.label}</span>`;
    b.addEventListener('click', () => {
      selected = c.id;
      cats.querySelectorAll('.cat-btn').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
    });
    cats.appendChild(b);
  }
  $('#pin-note').value = data.note || '';

  return new Promise(resolve => {
    const done = save => {
      dlg.close();
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onDlgCancel);
      resolve(save ? { cat: selected, note: $('#pin-note').value.trim() } : null);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onDlgCancel = e => { e.preventDefault(); done(false); };
    const okBtn = $('#btn-pin-save'), cancelBtn = $('#btn-pin-cancel');
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onDlgCancel);
    dlg.showModal();
    $('#pin-note').focus();
  });
}

// ------------------------------------------------------------- paste flows

function applyMapPlacement(bitmap, rect, marker) {
  // Lock scale to the first paste: force this screenshot to the exact same
  // map-px-per-screenshot-px as everything before it (keeping the matched
  // centre), so overlapping pastes differ only by translation and line up
  // cleanly. Per-image scale wobble from reference matching was the cause of
  // the misalignment.
  if (learnedScale) {
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    const nw = bitmap.width * learnedScale, nh = bitmap.height * learnedScale;
    rect = { ...rect, x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh };
  }
  // fine-tune position against already-explored content (translation only)
  rect = explored.refineAlignment(bitmap, rect);
  snapshotForUndo();
  explored.paste(bitmap, rect.x, rect.y, rect.w, rect.h);

  // the first paste defines the locked scale for every following paste
  if (!learnedScale) {
    learnedScale = rect.w / bitmap.width;
    store.putMeta('scale', learnedScale);
  }

  const data = {
    id: crypto.randomUUID(),
    x: rect.x + (marker ? marker.fx : 0.5) * rect.w,
    y: rect.y + (marker ? marker.fy : 0.5) * rect.h,
    cat: 'other', note: '', done: false, img: null,
    created: Date.now(),
  };
  lastUndo.pinId = data.id;
  pins.add(data, { select: true });
  persistPin(data);
  pins.setAwaiting(data.id);
  newPinPending = data;

  view.centerOn(data.x, data.y, Math.min(1, (window.innerWidth * 0.6) / rect.w));
  showAwaitDialog('Step 2 — screenshot the area itself',
    (marker
      ? 'Map revealed and pin placed at your position. '
      : 'Map revealed and pin added — drag it onto your exact spot afterwards. ')
    + 'Now go back to the game, screenshot what\'s actually there, and paste it with <span class="kbd">Ctrl+V</span>. This dialog waits for your paste. (<span class="kbd">Ctrl+Z</span> afterwards undoes everything.)',
    'Skip this step');
}

async function handleMapScreenshot(blob) {
  const bitmap = await createImageBitmap(blob);
  spinner(true, 'Locating screenshot on the map…');

  // Every screenshot is at the same in-game zoom, so once the first paste
  // has fixed the scale, lock ALL later pastes to that exact scale — they
  // then line up by translation alone (like matching them by hand). Before
  // that, seed the scale from the player marker if one is visible.
  const marker = detectPlayerMarker(bitmap);
  const hint = learnedScale
    ? { k: learnedScale, tight: true }
    : (marker ? { k: MARKER_MAP_HEIGHT / marker.h, tight: true } : null);

  let rect = null;
  try {
    const prog = f => spinner(true, `Locating screenshot on the map… ${Math.round(f * 100)}%`);
    rect = await locate(bitmap, mapImage, 'map', prog, hint);
    // hint may be stale or wrong — whenever the hinted result isn't
    // rock-solid, also search unconstrained and keep the better answer
    if (hint && !(certain(rect) || rect?.via === 'label')) {
      spinner(true, 'Double-checking across all scales…');
      const wide = await locate(bitmap, mapImage, 'map', prog, null);
      if (wide && (!rect || wide.via === 'label' || wide.ratio < rect.ratio)) rect = wide;
    }
  } catch (err) {
    console.error(err);
    toast('Locating failed: ' + err.message, 'error');
  }
  spinner(false);
  console.log('[silksong-map] map locate:', rect, 'marker:', marker, 'hint:', hint);

  if (!plausible(rect)) {
    bitmap.close?.();
    toast(`Couldn't find this spot (${confStr(rect)}) — nothing was revealed. Try a screenshot showing a bit more of the map.`, 'error');
    return;
  }

  if (!certain(rect)) {
    $('#confirm-msg').textContent = 'Not fully sure about this spot — does it look right?';
    const apply = await previewConfirm(bitmap, rect);
    if (!apply) {
      bitmap.close?.();
      toast('Cancelled — nothing was revealed.');
      return;
    }
  }

  applyMapPlacement(bitmap, rect, marker);
  bitmap.close?.();
}

// a paste while a pin is awaiting its screenshot attaches directly — no dialog
async function attachToAwaiting(blob) {
  const entry = pins.pins.get(pins.attachTarget());
  if (!entry) return;
  entry.data.img = blob;
  pins.update(entry.data);
  persistPin(entry.data);
  pins.setAwaiting(null);
  if ($('#dlg-await').open) $('#dlg-await').close();
  if (newPinPending && newPinPending.id === entry.data.id) {
    newPinPending = null;
    const edit = await openPinEditor(entry.data, true);
    if (edit) {
      entry.data.cat = edit.cat;
      entry.data.note = edit.note;
      pins.update(entry.data);
      persistPin(entry.data);
    }
    toast('Pin complete — hover it to see the area.', 'ok');
  } else {
    toast('Screenshot attached — hover the pin to see it.', 'ok');
  }
}

// Esc skips the "waiting for area screenshot" step
function skipAwaitingEnv() {
  const wasNew = newPinPending;
  pins.setAwaiting(null);
  if ($('#dlg-await').open) $('#dlg-await').close();
  if (wasNew) {
    newPinPending = null;
    openPinEditor(wasNew, true).then(edit => {
      if (!edit) return;
      wasNew.cat = edit.cat;
      wasNew.note = edit.note;
      pins.update(wasNew);
      persistPin(wasNew);
    });
  }
}

async function handleEnvScreenshot(blob) {
  const targetId = pins.attachTarget();
  const entry = targetId && pins.pins.get(targetId);
  if (!entry) {
    toast('No pin selected — click a pin (or its 📷 button) first.', 'error');
    return;
  }
  entry.data.img = blob;
  pins.update(entry.data);
  persistPin(entry.data);
  pins.setAwaiting(null);
  toast('Screenshot attached — hover the pin to see it.', 'ok');
}

async function handleFullMap(blob) {
  const bitmap = await createImageBitmap(blob);
  spinner(true, 'Aligning your map…');
  const marker = detectPlayerMarker(bitmap);
  const hint = marker ? { k: MARKER_MAP_HEIGHT / marker.h, tight: true } : null;
  let rect = null;
  try {
    const prog = f => spinner(true, `Aligning your map… ${Math.round(f * 100)}%`);
    rect = await locate(bitmap, mapImage, 'full', prog, hint);
    if (!plausible(rect) && hint) {
      const wide = await locate(bitmap, mapImage, 'full', prog, null);
      if (wide && (!rect || wide.ratio < rect.ratio)) rect = wide;
    }
  } catch (err) {
    console.error(err);
    toast('Aligning failed: ' + err.message, 'error');
  }

  spinner(false);
  console.log('[silksong-map] full locate:', rect);

  if (!plausible(rect)) {
    bitmap.close?.();
    toast(`Couldn't align your map (${confStr(rect)}) — nothing was changed. Zoom the in-game map out and include all of it in the screenshot.`, 'error');
    return;
  }

  if (!certain(rect)) {
    $('#confirm-msg').textContent = 'Not fully sure about this alignment — does it look right?';
    const apply = await previewConfirm(bitmap, rect);
    if (!apply) {
      bitmap.close?.();
      toast('Cancelled — nothing was changed.');
      return;
    }
  }

  spinner(true, 'Compositing your map…');
  await new Promise(r => setTimeout(r, 30)); // let the spinner paint
  rect = explored.refineAlignment(bitmap, rect);
  snapshotForUndo();
  explored.paste(bitmap, rect.x, rect.y, rect.w, rect.h);
  spinner(false);
  bitmap.close?.();
  view.fitToScreen();
  toast('Map updated with everything you have explored.', 'ok', { label: 'Undo', fn: undoLast });
}

let currentPaste = null; // { blob, url } while the type chooser is open

function routePaste(blob) {
  if (confirmActive) {
    toast('Answer the yes/no check first.', 'error');
    return;
  }
  // a pin is waiting for its area screenshot → attach without asking
  if (pins.awaitingId) {
    attachToAwaiting(blob);
    return;
  }
  currentPaste = { blob, url: URL.createObjectURL(blob) };
  $('#paste-preview').src = currentPaste.url;

  const envBtn = $('#dlg-paste').querySelector('[data-type="env"]');
  envBtn.disabled = !pins.attachTarget();
  envBtn.style.opacity = envBtn.disabled ? 0.4 : 1;

  $('#dlg-paste').showModal();
}

// wired once at startup
for (const b of document.querySelectorAll('#dlg-paste button[data-type]')) {
  b.addEventListener('click', async () => {
    const paste = currentPaste;
    currentPaste = null;
    $('#dlg-paste').close();
    if (!paste) return;
    URL.revokeObjectURL(paste.url);
    const type = b.dataset.type;
    if (type === 'map') await handleMapScreenshot(paste.blob);
    else if (type === 'env') await handleEnvScreenshot(paste.blob);
    else if (type === 'full') await handleFullMap(paste.blob);
  });
}

window.addEventListener('paste', e => {
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  routePaste(item.getAsFile());
});

// drag & drop image files work too
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  const file = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith('image/'));
  if (file) routePaste(file);
});

// ---------------------------------------------------------- export / import

async function exportAll() {
  const allPins = await store.getAllPins();
  const out = {
    app: 'silksong-map-companion',
    version: 1,
    exported: new Date().toISOString(),
    fog: await blobToDataURL(await explored.toBlob()),
    customCats: customCategories(),
    catOrder: currentOrder(),
    pins: await Promise.all(allPins.map(async p => ({
      ...p,
      img: p.img ? await blobToDataURL(p.img) : null,
    }))),
  };
  const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `silksong-map-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Backup downloaded.', 'ok');
}

async function importAll(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
    if (data.app !== 'silksong-map-companion') throw new Error('not a backup file');
  } catch (err) {
    toast('Could not read that file: ' + err.message, 'error');
    return;
  }
  if (!confirm('Importing replaces your current map progress and pins. Continue?')) return;

  await store.clearPins();
  pins.removeAll();
  explored.clear();
  if (data.fog) await explored.loadFromBlob(await dataURLToBlob(data.fog));

  setCustomCategories(data.customCats || []);
  setOrder(data.catOrder || []);
  await persistCats();
  for (const c of categories()) pins.filter.add(c.id);

  for (const p of data.pins || []) {
    const pin = { ...p, img: p.img ? await dataURLToBlob(p.img) : null };
    await store.putPin(pin);
    pins.add(pin);
  }
  renderCatList();
  pins.applyFilter();
  toast(`Imported ${data.pins?.length ?? 0} pins.`, 'ok');
}

// ------------------------------------------------------------- category bar

function persistCats() {
  return Promise.all([
    store.putMeta('customCats', customCategories()),
    store.putMeta('catOrder', currentOrder()),
  ]);
}

function updateCatCounts() {
  const counts = {};
  for (const e of pins.pins.values()) counts[e.data.cat] = (counts[e.data.cat] || 0) + 1;
  for (const row of $('#cat-list').children) {
    const n = counts[row.dataset.id] || 0;
    row.querySelector('.cat-count').textContent = n || '';
  }
}

// reflect the filter set into a row's checkbox + dimmed state
function syncRow(row) {
  const on = pins.filter.has(row.dataset.id);
  row.classList.toggle('off', !on);
  const cb = row.querySelector('.cat-check');
  if (cb) cb.checked = on;
}
function syncAllRows() {
  for (const row of $('#cat-list').children) syncRow(row);
}

function renderCatList() {
  const list = $('#cat-list');
  list.innerHTML = '';
  for (const c of categories()) {
    const row = document.createElement('div');
    row.className = 'cat-row' + (pins.filter.has(c.id) ? '' : ' off');
    row.dataset.id = c.id;
    row.style.setProperty('--pc', c.color || '#9e2b25');
    row.innerHTML =
      `<input type="checkbox" class="cat-check" title="Show / hide this type"${pins.filter.has(c.id) ? ' checked' : ''}>` +
      `<span class="cat-grip" title="Drag to reorder">⋮⋮</span>` +
      `<span class="cat-ico">${c.icon}</span>` +
      `<span class="cat-name">${c.label}</span>` +
      `<span class="cat-count"></span>`;

    // checkbox toggles visibility for just this type
    row.querySelector('.cat-check').addEventListener('change', e => {
      e.stopPropagation();
      if (e.target.checked) pins.filter.add(c.id);
      else pins.filter.delete(c.id);
      row.classList.toggle('off', !e.target.checked);
      pins.applyFilter();
    });

    // clicking the row shows ONLY this type
    row.addEventListener('click', e => {
      if (e.target.closest('.cat-check, .cat-grip, .cat-del')) return;
      if (row._suppressClick) return;
      soloCategory(c.id);
    });

    if (isCustom(c.id)) {
      const del = document.createElement('button');
      del.className = 'cat-del';
      del.textContent = '🗑';
      del.title = 'Delete this custom type';
      del.addEventListener('click', e => { e.stopPropagation(); deleteCustomType(c.id); });
      row.appendChild(del);
    }

    wireCatDrag(row);
    list.appendChild(row);
  }
  updateCatCounts();
}

// show only one type
function soloCategory(id) {
  pins.filter.clear();
  pins.filter.add(id);
  pins.applyFilter();
  syncAllRows();
}

function wireCatDrag(row) {
  const grip = row.querySelector('.cat-grip');
  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    e.stopPropagation();
    const list = $('#cat-list');
    const startY = e.clientY;
    let dragging = false;
    const onMove = ev => {
      if (!dragging && Math.abs(ev.clientY - startY) < 4) return;
      dragging = true;
      row.classList.add('dragging');
      const others = [...list.querySelectorAll('.cat-row:not(.dragging)')];
      const after = others.find(r => {
        const box = r.getBoundingClientRect();
        return ev.clientY < box.top + box.height / 2;
      });
      if (after) list.insertBefore(row, after);
      else list.appendChild(row);
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (!dragging) return;
      row.classList.remove('dragging');
      setOrder([...list.querySelectorAll('.cat-row')].map(r => r.dataset.id));
      persistCats();
      // swallow the click that fires right after a drag
      row._suppressClick = true;
      setTimeout(() => { row._suppressClick = false; }, 0);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
}

function openCatTypeDialog() {
  $('#cattype-icon').value = '';
  $('#cattype-label').value = '';
  $('#cattype-color').value = '#e0c37e';
  $('#dlg-cattype').showModal();
  $('#cattype-label').focus();
}

function saveCatType() {
  const label = $('#cattype-label').value.trim();
  if (!label) { $('#cattype-label').focus(); return; }
  const cat = {
    id: 'c_' + crypto.randomUUID().slice(0, 8),
    icon: $('#cattype-icon').value.trim() || '📌',
    label,
    color: $('#cattype-color').value,
  };
  addCustomCategory(cat);
  pins.filter.add(cat.id);
  persistCats();
  $('#dlg-cattype').close();
  renderCatList();
  toast('New pin type added.', 'ok');
}

async function deleteCustomType(id) {
  if (!confirm('Delete this custom type? Any pins using it become “Other”.')) return;
  for (const e of [...pins.pins.values()]) {
    if (e.data.cat === id) {
      e.data.cat = 'other';
      pins.update(e.data);
      persistPin(e.data);
    }
  }
  removeCustomCategory(id);
  pins.filter.delete(id);
  pins.filter.add('other');
  await persistCats();
  renderCatList();
}

// ------------------------------------------------- manual pin placement

let placing = false;
let ghostPin = null;

function onPlacingMove(e) {
  if (ghostPin) ghostPin.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
}

function onPlacingClick(e) {
  // clicks on chrome (toolbar, sidebar, dialogs, sliders) don't place a pin
  if (e.target.closest('#toolbar, #cat-bar, #map-opacity, dialog, .toast, #confirm-bar')) return;
  e.preventDefault();
  e.stopPropagation();
  const m = view.screenToMap(e.clientX, e.clientY);
  stopPlacing();
  createManualPin(m.x, m.y);
}

function startPlacing() {
  if (placing) return;
  placing = true;
  ghostPin = document.createElement('div');
  ghostPin.className = 'pin ghost-pin';
  ghostPin.style.setProperty('--pc', '#e0c37e');
  ghostPin.innerHTML = '<span class="pin-ico">📍</span>';
  document.body.appendChild(ghostPin);
  document.addEventListener('pointermove', onPlacingMove);
  // capture so the map's own handlers don't also react to the placing click
  document.addEventListener('click', onPlacingClick, true);
  document.body.classList.add('placing-mode');
  $('#btn-add-pin').classList.add('active');
  toast('Click the spot on the map to drop your pin. Esc to cancel.');
}

function stopPlacing() {
  if (!placing) return;
  placing = false;
  document.removeEventListener('pointermove', onPlacingMove);
  document.removeEventListener('click', onPlacingClick, true);
  if (ghostPin) { ghostPin.remove(); ghostPin = null; }
  document.body.classList.remove('placing-mode');
  $('#btn-add-pin').classList.remove('active');
}

async function createManualPin(x, y) {
  const data = {
    id: crypto.randomUUID(),
    x, y, cat: 'other', note: '', done: false, img: null,
    created: Date.now(),
  };
  pins.add(data, { select: true });
  persistPin(data);
  const edit = await openPinEditor(data, true);
  if (edit) {
    data.cat = edit.cat;
    data.note = edit.note;
    pins.update(data);
    persistPin(data);
  }
}

// ------------------------------------------------- sidebar resize / opacity

function wireSidebarResize() {
  const bar = $('#cat-bar');
  const handle = $('#cat-bar-resize');
  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    const startX = e.clientX, startW = bar.offsetWidth;
    const onMove = ev => {
      const w = Math.max(176, Math.min(560, startW + (ev.clientX - startX)));
      bar.style.width = w + 'px';
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      store.putMeta('catBarWidth', bar.offsetWidth);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
}

function applyMapOpacity(pct) {
  $('#map-canvas').style.opacity = pct / 100;
  $('.op-val').textContent = pct + '%';
}

function wireOpacitySlider() {
  const range = $('#opacity-range');
  range.addEventListener('input', () => applyMapOpacity(+range.value));
  range.addEventListener('change', () => store.putMeta('mapOpacity', +range.value));
}

// ----------------------------------------------------------------- toolbar

function buildToolbar() {
  renderCatList();
  $('#btn-cat-all').addEventListener('click', () => {
    for (const c of categories()) pins.filter.add(c.id);
    pins.applyFilter();
    syncAllRows();
  });
  $('#btn-add-pin').addEventListener('click', () => placing ? stopPlacing() : startPlacing());
  wireSidebarResize();
  wireOpacitySlider();
  $('#btn-cat-new').addEventListener('click', openCatTypeDialog);
  $('#btn-cattype-save').addEventListener('click', saveCatType);
  $('#btn-cattype-cancel').addEventListener('click', () => $('#dlg-cattype').close());
  $('#dlg-cattype').addEventListener('cancel', e => { e.preventDefault(); $('#dlg-cattype').close(); });
  $('#cattype-label').addEventListener('keydown', e => { if (e.key === 'Enter') saveCatType(); });

  $('#show-done').addEventListener('change', e => {
    pins.showDone = e.target.checked;
    pins.applyFilter();
  });

  $('#btn-export').addEventListener('click', exportAll);
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', e => {
    if (e.target.files[0]) importAll(e.target.files[0]);
    e.target.value = '';
  });

  $('#btn-help').addEventListener('click', () => $('#dlg-help').showModal());
  $('#btn-help-close').addEventListener('click', () => $('#dlg-help').close());

  $('#btn-reset').addEventListener('click', async () => {
    if (!confirm('Erase ALL revealed map and pins? Consider exporting a backup first.')) return;
    await store.clearPins();
    await store.clearMeta();
    pins.removeAll();
    explored.clear();
    setCustomCategories([]);
    setOrder([]);
    pins.filter = new Set(categories().map(c => c.id));
    renderCatList();
    toast('Everything reset.');
  });
}

// -------------------------------------------------------------------- init

async function init() {
  mapImage = await loadImage('assets/map.png');
  explored = new Explored(mapImage.width, mapImage.height);
  view = new MapView($('#map-canvas'), mapImage, explored);

  // category config must be loaded before the filter set is built
  setCustomCategories((await store.getMeta('customCats')) || []);
  setOrder((await store.getMeta('catOrder')) || []);

  pins = new PinManager($('#pin-layer'), view, {
    onChange: persistPin,
    onLightbox: showLightbox,
    onPinsChanged: () => updateCatCounts(),
    onRequestAttach: data => {
      pins.setAwaiting(data.id);
      showAwaitDialog('Paste the screenshot for this pin',
        'Paste it with <span class="kbd">Ctrl+V</span> — it replaces the pin\'s current picture. This dialog waits for your paste.',
        'Cancel');
    },
    onEdit: async data => {
      const edit = await openPinEditor(data, false);
      if (!edit) return;
      data.cat = edit.cat;
      data.note = edit.note;
      pins.update(data);
      persistPin(data);
    },
    onDelete: data => {
      if (!confirm('Delete this pin?')) return;
      pins.remove(data.id);
      store.deletePin(data.id);
    },
  });

  explored.onChange = () => { view.requestRender(); saveFog(); };
  view.onViewChanged = () => { pins.syncPositions(); saveView(); };

  // restore saved state
  learnedScale = (await store.getMeta('scale')) || null;
  const savedFog = await store.getMeta('fog');
  if (savedFog) await explored.loadFromBlob(savedFog);
  const savedView = await store.getMeta('view');
  if (savedView) {
    view.scale = savedView.scale;
    view.ox = savedView.ox;
    view.oy = savedView.oy;
    view.requestRender();
  }
  for (const p of await store.getAllPins()) pins.add(p);
  pins.applyFilter();

  // restore sidebar width + map opacity
  const savedW = await store.getMeta('catBarWidth');
  if (savedW) $('#cat-bar').style.width = savedW + 'px';
  const savedOpacity = await store.getMeta('mapOpacity');
  if (savedOpacity != null) { $('#opacity-range').value = savedOpacity; applyMapOpacity(savedOpacity); }

  buildToolbar();

  if (!savedFog && !(await store.getMeta('helped'))) {
    $('#dlg-help').showModal();
    store.putMeta('helped', true);
  }

  // debug / testing hooks
  window.__ssmc = {
    view, explored, get pins() { return pins; }, mapImage,
    handleImageBlob: (blob, type) =>
      type === 'map' ? handleMapScreenshot(blob)
      : type === 'env' ? handleEnvScreenshot(blob)
      : handleFullMap(blob),
    routePaste,
    undoLast,
  };
}

init().catch(err => {
  console.error(err);
  toast('Failed to start: ' + err.message, 'error');
});
