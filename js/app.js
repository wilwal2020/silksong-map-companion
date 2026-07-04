import { Fog } from './fog.js';
import { MapView } from './mapview.js';
import { store } from './store.js';
import { locate, computeExploredMask, detectPlayerMarker } from './match.js';
import { PinManager, CATEGORIES, catById } from './pins.js';

const $ = s => document.querySelector(s);

let view, fog, pins, mapImage;
let placing = null;      // active placement { resolve }
let newPinPending = null; // freshly created pin waiting for its area screenshot

// ---------------------------------------------------------------- utilities

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function spinner(show, msg) {
  $('#spinner').classList.toggle('hidden', !show);
  if (msg) $('#spinner-msg').textContent = msg;
}

const HINT_DEFAULT = 'paste a screenshot of your in-game map';
function setHint(text) {
  $('#hint-text').textContent = text || HINT_DEFAULT;
  $('#paste-hint').classList.toggle('highlight', !!text);
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
  store.putMeta('fog', await fog.toBlob());
}, 1500);

const saveView = debounce(() => {
  store.putMeta('view', { scale: view.scale, ox: view.ox, oy: view.oy });
}, 800);

function persistPin(data) {
  store.putPin(data);
}

// --------------------------------------------------------------- placement

// Show `bitmap` as a draggable/resizable overlay, starting at `rect`
// (map coords). Resolves with the final rect, or null if cancelled.
function placeOverlay(bitmap, rect, msg) {
  return new Promise(resolve => {
    placing = { resolve, bitmap };
    view.setPlacement({ img: bitmap, x: rect.x, y: rect.y, w: rect.w });
    $('#placement-msg').textContent = msg;
    $('#placement-bar').classList.remove('hidden');
    $('#paste-hint').classList.add('hidden');
  });
}

function endPlacement(confirmed) {
  if (!placing) return;
  const p = view.placement;
  const rect = confirmed && p
    ? { x: p.x, y: p.y, w: p.w, h: p.w * (p.img.height / p.img.width) }
    : null;
  view.setPlacement(null);
  $('#placement-bar').classList.add('hidden');
  $('#paste-hint').classList.remove('hidden');
  const { resolve } = placing;
  placing = null;
  resolve(rect);
}

$('#btn-place-ok').addEventListener('click', () => endPlacement(true));
$('#btn-place-cancel').addEventListener('click', () => endPlacement(false));
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && placing) { endPlacement(false); return; }
  if (e.key === 'Enter' && placing) { endPlacement(true); return; }
  if (e.key === 'Escape' && !document.querySelector('dialog[open]') && pins?.awaitingId) {
    skipAwaitingEnv();
  }
});

// ------------------------------------------------------------- pin editing

function openPinEditor(data, isNew) {
  const dlg = $('#dlg-pin');
  $('#pin-dlg-title').textContent = isNew ? 'New pin — what is here?' : 'Edit pin';
  const cats = $('#pin-cats');
  cats.innerHTML = '';
  let selected = data.cat || 'other';
  for (const c of CATEGORIES) {
    const b = document.createElement('button');
    b.className = 'cat-btn' + (c.id === selected ? ' on' : '');
    b.innerHTML = `<span>${c.icon}</span><span>${c.label}</span>`;
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

async function handleMapScreenshot(blob) {
  const bitmap = await createImageBitmap(blob);
  spinner(true, 'Locating screenshot on the map…');
  let rect = null;
  try {
    rect = await locate(bitmap, mapImage, 'map',
      f => spinner(true, `Locating screenshot on the map… ${Math.round(f * 100)}%`));
  } catch (err) {
    console.error(err);
    toast('Auto-locate failed (' + err.message + ') — place it manually.', 'error');
  }
  spinner(false);

  let msg = 'Check the position, then confirm';
  if (!rect || rect.score < 0.1) {
    // fallback: drop it in the middle of the current view at a plausible size
    const c = view.screenToMap(window.innerWidth / 2, window.innerHeight / 2);
    const w = mapImage.width * 0.25;
    rect = { x: c.x - w / 2, y: c.y - (w * bitmap.height / bitmap.width) / 2, w };
    msg = 'Could not auto-locate — drag it into place';
  } else if (rect.score < 0.22) {
    msg = 'Not fully sure about this spot — double-check before confirming';
  }
  view.centerOn(rect.x + rect.w / 2, rect.y + (rect.h || rect.w * bitmap.height / bitmap.width) / 2,
    Math.min(1, (window.innerWidth * 0.6) / rect.w));

  const final = await placeOverlay(bitmap, rect, msg);
  if (!final) { bitmap.close?.(); return; }

  // reveal only the rooms actually drawn in the screenshot — never a
  // rectangle or blur that would spoil the surroundings
  const mask = computeExploredMask(bitmap);
  fog.revealMask(mask, final.x, final.y, final.w, final.h);

  // drop the pin on the player marker (white Hornet icon) if we can find it
  const marker = detectPlayerMarker(bitmap);
  bitmap.close?.();
  const data = {
    id: crypto.randomUUID(),
    x: final.x + (marker ? marker.fx : 0.5) * final.w,
    y: final.y + (marker ? marker.fy : 0.5) * final.h,
    cat: 'other', note: '', done: false, img: null,
    created: Date.now(),
  };
  pins.add(data, { select: true });
  persistPin(data);
  pins.setAwaiting(data.id);
  newPinPending = data;
  setHint('now paste a screenshot of the area itself — Esc to skip');
  toast(marker
    ? 'Revealed — pin placed at your position. Paste the area screenshot now 📷'
    : 'Revealed — pin added (drag it onto your spot). Paste the area screenshot now 📷', 'ok');
}

// a paste while a pin is awaiting its screenshot attaches directly — no dialog
async function attachToAwaiting(blob) {
  const entry = pins.pins.get(pins.attachTarget());
  if (!entry) return;
  entry.data.img = blob;
  pins.update(entry.data);
  persistPin(entry.data);
  pins.setAwaiting(null);
  setHint(null);
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
  setHint(null);
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
  let rect = null;
  try {
    rect = await locate(bitmap, mapImage, 'full',
      f => spinner(true, `Aligning your map… ${Math.round(f * 100)}%`));
  } catch (err) {
    console.error(err);
    toast('Auto-align failed (' + err.message + ') — place it manually.', 'error');
  }
  spinner(false);

  let msg = 'Check the alignment, then confirm';
  if (!rect || rect.score < 0.1) {
    rect = { x: 0, y: 0, w: mapImage.width };
    msg = 'Could not auto-align — drag & resize to match the map';
  }
  view.fitToScreen();

  const final = await placeOverlay(bitmap, rect, msg);
  if (!final) { bitmap.close?.(); return; }

  spinner(true, 'Revealing explored rooms…');
  await new Promise(r => setTimeout(r, 30)); // let the spinner paint
  const mask = computeExploredMask(bitmap);
  fog.revealMask(mask, final.x, final.y, final.w, final.h);
  spinner(false);
  bitmap.close?.();
  toast('Map updated with everything you have explored.', 'ok');
}

let currentPaste = null; // { blob, url } while the type chooser is open

function routePaste(blob) {
  if (placing) {
    toast('Finish placing the current screenshot first.', 'error');
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
    fog: await blobToDataURL(await fog.toBlob()),
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
  fog.clear();
  if (data.fog) await fog.loadFromBlob(await dataURLToBlob(data.fog));
  for (const p of data.pins || []) {
    const pin = { ...p, img: p.img ? await dataURLToBlob(p.img) : null };
    await store.putPin(pin);
    pins.add(pin);
  }
  pins.applyFilter();
  toast(`Imported ${data.pins?.length ?? 0} pins.`, 'ok');
}

// ----------------------------------------------------------------- toolbar

function buildToolbar() {
  const filters = $('#filters');
  for (const c of CATEGORIES) {
    const chip = document.createElement('span');
    chip.className = 'chip on';
    chip.textContent = c.icon;
    chip.title = c.label;
    chip.addEventListener('click', () => {
      chip.classList.toggle('on');
      if (chip.classList.contains('on')) pins.filter.add(c.id);
      else pins.filter.delete(c.id);
      pins.applyFilter();
    });
    filters.appendChild(chip);
  }

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
    fog.clear();
    toast('Everything reset.');
  });
}

// -------------------------------------------------------------------- init

async function init() {
  mapImage = await loadImage('assets/map.png');
  fog = new Fog(mapImage.width, mapImage.height);
  view = new MapView($('#map-canvas'), mapImage, fog);

  pins = new PinManager($('#pin-layer'), view, {
    onChange: persistPin,
    onLightbox: showLightbox,
    onRequestAttach: data => {
      pins.setAwaiting(data.id);
      setHint('paste the screenshot for this pin — Esc to cancel');
      toast('Now paste (Ctrl+V) the screenshot for this pin.');
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

  fog.onChange = () => { view.requestRender(); saveFog(); };
  view.onViewChanged = () => { pins.syncPositions(); saveView(); };

  // restore saved state
  const savedFog = await store.getMeta('fog');
  if (savedFog) await fog.loadFromBlob(savedFog);
  const savedView = await store.getMeta('view');
  if (savedView) {
    view.scale = savedView.scale;
    view.ox = savedView.ox;
    view.oy = savedView.oy;
    view.requestRender();
  }
  for (const p of await store.getAllPins()) pins.add(p);
  pins.applyFilter();

  buildToolbar();

  if (!savedFog && !(await store.getMeta('helped'))) {
    $('#dlg-help').showModal();
    store.putMeta('helped', true);
  }

  // debug / testing hooks
  window.__ssmc = {
    view, fog, get pins() { return pins; }, mapImage,
    handleImageBlob: (blob, type) =>
      type === 'map' ? handleMapScreenshot(blob)
      : type === 'env' ? handleEnvScreenshot(blob)
      : handleFullMap(blob),
    routePaste,
    endPlacement,
  };
}

init().catch(err => {
  console.error(err);
  toast('Failed to start: ' + err.message, 'error');
});
