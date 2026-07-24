import { Explored } from './explored.js';
import { MapView } from './mapview.js';
import { store, setStoreGame } from './store.js';
import { locate, detectPlayerMarker, MARKER_MAP_HEIGHT, refinePlacement } from './match.js';
import { ocrLocate, loadLabels } from './ocr.js';
import { PinManager, SVG } from './pins.js';
import {
  categories, catById, customCategories, currentOrder, isCustom,
  setCustomCategories, addCustomCategory, removeCustomCategory, updateCustomCategory, setOrder,
} from './categories.js';
import {
  BUILTIN_GAME, WORLD_SIZES, DEFAULT_SIZE, allGames, gameById, loadGames,
  createGame, updateGame, removeGame, currentGameId, setCurrentGameId,
} from './games.js';

const $ = s => document.querySelector(s);

let view, explored, pins;
let mapImage = null;      // reference world map — only games that ship one
let world = null;         // { width, height } of this game's map space
let game = BUILTIN_GAME;  // which game is open
// A game without a reference map can't be matched against anything, so its
// pastes are positioned by hand (and its player pin is clicked, not detected).
const handPlaced = () => !game.builtin;
let newPinPending = null; // freshly created pin waiting for its area screenshot
let lastUndo = null;      // { snap, pinId } — one level of paste undo
let learnedScale = null;  // map-px per screenshot-px from past successes
let scaleTrusted = false; // learnedScale was verified against reference content
let scaleSamples = [];    // recent content-verified scales; learnedScale = median

// Placement is all-or-nothing: a paste is either confident enough to apply
// on its own, or it fails outright — no "does this look right?" middle step
// (if the match needs a human to vouch for it, it isn't good enough). A match
// is `certain` when it stands well clear of its runner-up (ratio, calibrated
// on real screenshots: correct 0.44-0.92, wrong 0.90-0.98). `plausible` is a
// looser gate used only internally to decide whether a wider re-search is
// worth trying.
const AUTO_RATIO = 0.85;
const MAX_RATIO = 0.985;
const MIN_SCORE = 0.15;
const certain = rect => rect && rect.score >= MIN_SCORE && (rect.ratio ?? 1) <= AUTO_RATIO;
const plausible = rect => rect && rect.score >= MIN_SCORE && (rect.ratio ?? 1) <= MAX_RATIO;

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

// dock the spinner to the bottom so it clears the floating paste ghost
function dockSpinner(on) { $('#spinner').classList.toggle('docked', on); }

// in-app confirm dialog (replaces the browser's confirm()). Resolves true/false.
function confirmDialog(text, { title = 'Are you sure?', okLabel = 'Delete', danger = true } = {}) {
  const dlg = $('#dlg-confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  const ok = $('#btn-confirm-yes'), no = $('#btn-confirm-no');
  ok.textContent = okLabel;
  ok.classList.toggle('danger', danger);
  ok.classList.toggle('primary', !danger);
  return new Promise(resolve => {
    const done = v => {
      ok.removeEventListener('click', onOk);
      no.removeEventListener('click', onNo);
      dlg.removeEventListener('cancel', onCancel);
      closeDialog(dlg);
      resolve(v);
    };
    const onOk = () => done(true);
    const onNo = () => done(false);
    const onCancel = e => { e.preventDefault(); done(false); };
    ok.addEventListener('click', onOk);
    no.addEventListener('click', onNo);
    dlg.addEventListener('cancel', onCancel);
    dlg.showModal();
  });
}

// close a <dialog> with a brief out-animation instead of snapping shut
function closeDialog(dlg) {
  if (typeof dlg === 'string') dlg = $(dlg);
  if (!dlg || !dlg.open) return;
  dlg.classList.remove('from-pin');
  if ((view && view.reduceMotion) || dlg.classList.contains('closing')) {
    dlg.classList.remove('closing');
    dlg.close();
    return;
  }
  dlg.classList.add('closing');
  const finish = () => {
    dlg.removeEventListener('animationend', finish);
    clearTimeout(timer);
    dlg.classList.remove('closing');
    dlg.close();
  };
  const timer = setTimeout(finish, 240);
  dlg.addEventListener('animationend', finish);
}

// float the just-pasted screenshot on the map while it's being located
function showPasteGhost(bitmap) {
  const cw = view.canvas.clientWidth, ch = view.canvas.clientHeight;
  const ar = bitmap.width / bitmap.height;
  const screenW = Math.min(cw * 0.44, ch * 0.5 * ar);
  view.showGhost(bitmap, screenW);
  dockSpinner(true);
  // a screenshot is on its way in — drop the "paste your first map" prompt now,
  // not only once it's composited (matching can take a moment)
  $('#empty-hint').classList.add('hidden');
}

// a zoom level that frames a pasted rect nicely — so a full-map paste that
// only covers a corner zooms to that corner instead of the whole world. A
// low frac leaves comfortable margin around the paste rather than filling
// the screen edge-to-edge.
function fitRectScale(rect, frac = 0.6) {
  const cw = view.canvas.clientWidth, ch = view.canvas.clientHeight;
  const s = Math.min(cw * frac / rect.w, ch * frac / rect.h);
  return Math.min(view.maxScale, Math.max(view.minScale, s));
}

// fly a just-attached screenshot from where it dropped into its pin, then
// flash the pin. Resolves when the animation finishes (or immediately if
// motion is reduced).
function flyImageToPin(blob, entry, fromRect = null) {
  return new Promise(resolve => {
    if (view.reduceMotion || !entry) { pins.flashPin(entry?.data.id); resolve(); return; }
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.className = 'attach-fly';
    const done = () => { img.remove(); URL.revokeObjectURL(url); pins.flashPin(entry.data.id); resolve(); };
    img.onerror = done;
    img.onload = () => {
      const pr = entry.el.getBoundingClientRect();
      const tx = pr.left + pr.width / 2, ty = pr.top + pr.height / 2;
      let start = fromRect;
      if (!start) {
        const w = Math.min(300, window.innerWidth * 0.5);
        const h = w * (img.naturalHeight / img.naturalWidth);
        start = { left: innerWidth / 2 - w / 2, top: innerHeight / 2 - h / 2, width: w };
      }
      img.style.left = (start.left ?? start.x) + 'px';
      img.style.top = (start.top ?? start.y) + 'px';
      img.style.width = start.width + 'px';
      document.body.appendChild(img);
      const fw = img.offsetWidth, fh = img.offsetHeight;
      const dx = tx - ((start.left ?? start.x) + fw / 2);
      const dy = ty - ((start.top ?? start.y) + fh / 2);
      requestAnimationFrame(() => {
        img.style.transform = `translate(${dx}px, ${dy}px) scale(.05)`;
        img.style.opacity = '.1';
      });
      let fired = false;
      const finish = () => { if (fired) return; fired = true; done(); };
      img.addEventListener('transitionend', finish, { once: true });
      setTimeout(finish, 720); // safety if transitionend is missed
    };
    img.src = url;
  });
}

function showAwaitDialog(title, sub, skipLabel) {
  $('#await-title').textContent = title;
  $('#await-sub').innerHTML = sub;
  $('#btn-await-skip').textContent = skipLabel;
  $('#dlg-await').showModal();
}

// one-level undo of the last paste (explored composite + created pin);
// the scale calibration is snapshotted too so undoing also restores it
function snapshotForUndo(pinId = null) {
  lastUndo = {
    snap: explored.snapshot(), pinId,
    scaleState: { learnedScale, scaleTrusted, scaleSamples: [...scaleSamples] },
  };
}

function undoLast() {
  if (!lastUndo) { toast('Nothing to undo.'); return; }
  explored.restore(lastUndo.snap);
  if (lastUndo.scaleState) {
    ({ learnedScale, scaleTrusted } = lastUndo.scaleState);
    scaleSamples = [...lastUndo.scaleState.scaleSamples];
    store.putMeta('scale', learnedScale);
    store.putMeta('scaleTrusted', scaleTrusted);
    store.putMeta('scaleSamples', scaleSamples);
  }
  if (lastUndo.pinId) {
    pins.remove(lastUndo.pinId);
    store.deletePin(lastUndo.pinId);
    if (newPinPending && newPinPending.id === lastUndo.pinId) newPinPending = null;
    closeDialog('#dlg-await');
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
  // one at a time; a modal <dialog> lands in the top layer so it sits above
  // the pin editor (also a modal dialog) instead of underneath it
  document.getElementById('lightbox')?.remove();
  const box = document.createElement('dialog');
  box.id = 'lightbox';
  const img = document.createElement('img');
  img.src = url;
  box.appendChild(img);
  box.addEventListener('click', () => box.close());
  box.addEventListener('close', () => box.remove());
  document.body.appendChild(box);
  box.showModal();
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

// ---------------------------------------------------------------- keyboard

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && placing) { stopPlacing(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z'
      && !document.querySelector('dialog[open]')) {
    e.preventDefault();
    // a pending or just-confirmed pin move takes priority over a paste undo
    if (!pins.undoLastMove()) undoLast();
  }
});
$('#btn-await-skip').addEventListener('click', () => skipAwaitingEnv());
$('#dlg-await').addEventListener('cancel', e => { e.preventDefault(); skipAwaitingEnv(); });

// ------------------------------------------------------------------- games

// everything on screen that depends on which game is open
function applyGameChrome() {
  document.title = `${game.name} — Map Companion`;
  $('.game-ico').textContent = game.icon || '🎮';
  $('.game-name').textContent = game.name;
  // the paste chooser offers different things with and without a reference map
  $('#dlg-paste').dataset.mode = handPlaced() ? 'custom' : 'builtin';
  // "Reveal map" lays the real world map over yours — there isn't one here.
  // "Clean map" is the same Silksong-tuned background fade, so it goes too.
  $('#btn-reveal').classList.toggle('hidden', handPlaced());
  $('#btn-clean').classList.toggle('hidden', handPlaced());
  if (handPlaced()) {
    $('#empty-hint h2').textContent = 'Paste your first screenshot';
    $('#empty-hint p').innerHTML =
      'Snip your in-game map with <span class="kbd">Shift + Win + S</span>, '
      + 'then paste it here and drag it into place.';
    $('#hint-text').textContent = 'paste a screenshot of your map';
  }
}

function closeGameMenu() {
  $('#game-menu').classList.add('hidden');
  document.removeEventListener('pointerdown', onGameMenuOutside, true);
}
function onGameMenuOutside(e) {
  if (!e.target.closest('#game-menu, #btn-game')) closeGameMenu();
}

function openGameMenu() {
  const menu = $('#game-menu');
  menu.innerHTML = '<div class="gm-head">GAMES</div>';
  for (const g of allGames()) {
    const row = document.createElement('button');
    row.className = 'gm-row' + (g.id === game.id ? ' on' : '');
    row.innerHTML =
      `<span class="gm-ico">${g.icon || '🎮'}</span>`
      + `<span class="gm-name">${escapeHtml(g.name)}</span>`;
    if (!g.builtin) {
      const tools = document.createElement('span');
      tools.className = 'gm-tools';
      const edit = document.createElement('button');
      edit.className = 'gm-tool';
      edit.textContent = '✎';
      edit.title = 'Rename this game';
      edit.addEventListener('click', e => { e.stopPropagation(); closeGameMenu(); openGameDialog(g); });
      const del = document.createElement('button');
      del.className = 'gm-tool del';
      del.textContent = '🗑';
      del.title = 'Delete this game';
      del.addEventListener('click', e => { e.stopPropagation(); closeGameMenu(); deleteGame(g); });
      tools.append(edit, del);
      row.appendChild(tools);
    } else {
      row.insertAdjacentHTML('beforeend', '<span class="gm-sub">auto&#8209;placed</span>');
    }
    row.addEventListener('click', () => switchGame(g.id));
    menu.appendChild(row);
  }
  menu.insertAdjacentHTML('beforeend', '<div class="gm-sep"></div>');
  const add = document.createElement('button');
  add.className = 'gm-row gm-new';
  add.innerHTML = '<span class="gm-ico">＋</span><span class="gm-name">New game…</span>';
  add.addEventListener('click', () => { closeGameMenu(); openGameDialog(null); });
  menu.appendChild(add);

  menu.classList.remove('hidden');
  document.addEventListener('pointerdown', onGameMenuOutside, true);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Switching game reloads the page: every game has its own map canvas, pins,
// pin types and calibration, and a reload is the one way to be certain none
// of the previous game's state leaks into the next one. Nothing is lost —
// the pending saves are flushed first.
async function switchGame(id) {
  closeGameMenu();
  if (id === game.id) return;
  spinner(true, 'Opening ' + gameById(id).name + '…');
  await flushSaves();
  await setCurrentGameId(id);
  location.reload();
}

// write the debounced state out now (a reload is coming)
async function flushSaves() {
  try {
    await store.putMeta('fog', await explored.toBlob());
    await store.putMeta('view', { scale: view.scale, ox: view.ox, oy: view.oy });
  } catch (e) {
    console.warn('[map] could not flush state:', e.message);
  }
}

let gameEditing = null;   // the custom game being edited, or null when creating
let gameSizeId = DEFAULT_SIZE;

function openGameDialog(g) {
  gameEditing = g;
  gameSizeId = DEFAULT_SIZE;
  $('#game-dlg-title').textContent = g ? 'Edit game' : 'New game';
  $('#btn-game-save').textContent = g ? 'Save changes' : 'Create game';
  $('#game-intro').classList.toggle('hidden', !!g);
  $('#game-icon').value = g ? (g.icon || '') : '';
  $('#game-name').value = g ? g.name : '';
  // the world size fixes the canvas every pin coordinate is relative to, so
  // it can only be chosen at creation
  $('#game-size-wrap').classList.toggle('hidden', !!g);
  renderGameSizes();
  $('#dlg-game').showModal();
  $('#game-name').focus();
}

function renderGameSizes() {
  const wrap = $('#game-sizes');
  wrap.innerHTML = '';
  for (const s of WORLD_SIZES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'game-size' + (s.id === gameSizeId ? ' on' : '');
    b.innerHTML = `<b>${s.label}</b><span>${s.hint}</span>`;
    b.addEventListener('click', () => { gameSizeId = s.id; renderGameSizes(); });
    wrap.appendChild(b);
  }
}

async function saveGameDialog() {
  const name = $('#game-name').value.trim();
  if (!name) { $('#game-name').focus(); return; }
  const icon = $('#game-icon').value.trim() || '🎮';
  if (gameEditing) {
    await updateGame(gameEditing.id, { name, icon });
    const edited = gameEditing.id;
    gameEditing = null;
    closeDialog('#dlg-game');
    if (edited === game.id) { game = gameById(game.id); applyGameChrome(); }
    toast('Game updated.', 'ok');
    return;
  }
  const size = WORLD_SIZES.find(s => s.id === gameSizeId) || WORLD_SIZES[1];
  const g = await createGame({ name, icon, w: size.w, h: size.h });
  closeDialog('#dlg-game');
  await switchGame(g.id);
}

async function deleteGame(g) {
  if (!await confirmDialog(
    `“${g.name}” and everything in it — its map, its pins, their pictures and notes — is erased. This cannot be undone.`,
    { title: 'Delete this game?', okLabel: 'Delete game' })) return;
  const wasCurrent = g.id === game.id;
  await removeGame(g.id);
  if (wasCurrent) { await setCurrentGameId(BUILTIN_GAME.id); location.reload(); return; }
  toast(`“${g.name}” deleted.`, 'ok');
}

// ------------------------------------------------------------- pin editing

// while the pin editor is open, its empty picture slot claims a paste (set in
// openPinEditor, read by routePaste) so Ctrl+V fills it just like an empty pin
let pinEditorAttach = null;

function openPinEditor(data, isNew) {
  const dlg = $('#dlg-pin');
  $('#pin-dlg-title').textContent = isNew ? 'New pin — what is here?' : 'Edit pin';
  const cats = $('#pin-cats');
  let selected = data.cat || 'other';

  const shot = $('#pin-shot');
  // reuse the pin's cached object URL (pins.update revokes/recreates it) so we
  // don't leak or double-decode the blob
  function shotUrl() {
    if (!data.img) return null;
    const entry = pins.pins.get(data.id);
    if (entry) {
      if (!entry.imgUrl) entry.imgUrl = URL.createObjectURL(data.img);
      return entry.imgUrl;
    }
    return URL.createObjectURL(data.img);
  }
  function renderShot() {
    const cat = catById(selected);
    shot.style.setProperty('--pc', cat.color || '#9e2b25');
    if (data.img) {
      // the attached area screenshot — cover-cropped preview, click to zoom,
      // corner ✕ to drop the picture (falls back to the empty well)
      shot.className = 'pin-shot';
      shot.innerHTML = '<div class="pc-img has-env"><img class="env" alt="">'
        + '<button type="button" class="pc-shot-x" title="Remove picture" aria-label="Remove picture">'
        + '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>'
        + '</button></div>';
      const img = shot.querySelector('img.env');
      img.src = shotUrl();
      img.addEventListener('click', () => showLightbox(shotUrl()));
      shot.querySelector('.pc-shot-x').addEventListener('click', () => {
        data.img = null;
        if (pins.pins.has(data.id)) { pins.update(data); persistPin(data); }
        renderShot();
      });
    } else {
      // no picture yet — the same paste well an empty pin shows, same hover
      shot.className = 'pin-shot';
      shot.innerHTML =
        '<div class="pc-img no-env">'
        + '<div class="pc-well">'
        + `<span class="wc">${SVG.camBig}</span>`
        + '<span class="wt"><b>No picture yet</b><br>'
        + 'Paste with <span class="pc-kbd">Ctrl</span> <span class="pc-kbd">V</span></span>'
        + '</div></div>';
    }
  }
  renderShot();
  // a Ctrl+V while the editor is open lands here (via routePaste)
  pinEditorAttach = blob => {
    data.img = blob;
    if (pins.pins.has(data.id)) { pins.update(data); persistPin(data); }
    renderShot();
    toast('Screenshot attached.', 'ok');
  };

  function renderCats() {
    cats.innerHTML = '';
    for (const c of categories()) {
      const b = document.createElement('button');
      b.className = 'cat-btn' + (c.id === selected ? ' on' : '');
      b.style.setProperty('--pc', c.color || '#9e2b25');
      b.innerHTML = `<span class="cb-ico">${c.icon}</span><span>${c.label}</span>`;
      b.addEventListener('click', () => {
        selected = c.id;
        cats.querySelectorAll('.cat-btn').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        shot.style.setProperty('--pc', c.color || '#9e2b25');
      });
      cats.appendChild(b);
    }
    // inline "create a new type" — opens the type dialog on top and selects
    // it; styled like the sidebar's "New type" row so it reads as "add"
    const add = document.createElement('button');
    add.className = 'cat-btn cat-btn-new';
    add.innerHTML =
      '<span class="cat-new-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg></span>'
      + '<span class="cat-new-name">New type…</span>';
    add.addEventListener('click', () => {
      catTypeCreatedCb = cat => { selected = cat.id; renderCats(); };
      openCatTypeDialog();
    });
    cats.appendChild(add);
  }
  renderCats();
  $('#pin-note').value = data.note || '';

  return new Promise(resolve => {
    const done = save => {
      pinEditorAttach = null;
      closeDialog(dlg);
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
    // grow the dialog out of the pin it belongs to, then settle to centre
    if (data.x != null && data.y != null) {
      const sp = view.mapToScreen(data.x, data.y);
      dlg.style.setProperty('--fx', (sp.x - window.innerWidth / 2) + 'px');
      dlg.style.setProperty('--fy', (sp.y - window.innerHeight / 2) + 'px');
      dlg.classList.add('from-pin');
    } else {
      dlg.classList.remove('from-pin');
    }
    dlg.showModal();
    $('#pin-note').focus();
  });
}

// ------------------------------------------------------------- paste flows

// Final alignment, in the background: the placement that just landed is good
// to a couple of pixels / a fraction of a percent of scale (the fast refine
// paths quantize their search). While the user is already editing the pin, a
// slower sub-pixel pass aligns the shot's room outlines to the reference
// exactly; if it finds a meaningfully better fit, the paste is silently
// re-composited on the corrected rect and its pin carried along. The
// pre-paste undo snapshot doubles as the base to re-composite from — if
// anything else touched the composite meanwhile (another paste, an undo, a
// clear), lastUndo has changed and the correction is dropped. Takes over
// ownership of `bitmap` and closes it when done.
async function finalizeAlignment(bitmap, rect, mode, pinId) {
  const undoRef = lastUndo;
  try {
    const r = await refinePlacement(bitmap, mapImage, rect, mode);
    console.log('[silksong-map] final align:', r && JSON.stringify(
      r.fail ? r : { moved: r.moved, dScale: r.dScale, startPx: r.startPx, dPx: r.dPx, inlier: r.inlier }));
    if (window.__ssmc) window.__ssmc.lastAlign = { rect, r }; // debug/testing hook
    if (!r || r.fail || lastUndo !== undoRef || undoRef === null) return;
    // apply only a real improvement that is actually visible
    const worthIt = r.startPx - r.dPx > 0.02
      && (r.moved > 0.6 || Math.abs(r.dScale) > 0.0015);
    if (!worthIt) return;
    explored.restore(undoRef.snap);
    explored.paste(bitmap, r.x, r.y, r.w, r.h);
    const entry = pinId && pins.pins.get(pinId);
    if (entry) {
      const s = r.w / rect.w;
      entry.data.x = r.x + (entry.data.x - rect.x) * s;
      entry.data.y = r.y + (entry.data.y - rect.y) * s;
      pins.syncPositions();
      persistPin(entry.data);
    }
    // a sub-pixel reference fit is the best scale measurement there is —
    // but only area screenshots share the one global zoom; a full-map
    // paste's scale says nothing about it
    if (mode === 'map') adoptScale({ ...r, refined: true, scaleMeasured: true }, bitmap);
  } catch (e) {
    console.warn('[silksong-map] final align failed:', e.message);
  } finally {
    bitmap.close?.();
  }
}

async function applyMapPlacement(bitmap, rect, marker) {
  if (rect.via === 'ocr' || rect.via === 'label') {
    // OCR/label placements align to the reference map itself — trust them,
    // pin them to the one global scale, then allow only a few-pixel nudge
    // onto already-pasted content so overlaps stitch without a visible seam.
    adoptScale(rect, bitmap);
    rect = forceGlobalScale(rect, bitmap);
    rect = explored.refineAlignment(bitmap, rect, { maxShift: 8 });
  } else {
    // shape-matched pastes lock to the first paste's scale so overlapping
    // shots line up by translation
    if (learnedScale) {
      const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
      const nw = bitmap.width * learnedScale, nh = bitmap.height * learnedScale;
      rect = { ...rect, x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh };
    }
    rect = explored.refineAlignment(bitmap, rect);
    if (!learnedScale) {
      learnedScale = rect.w / bitmap.width;
      store.putMeta('scale', learnedScale);
    }
  }
  // bring the spot into view, then fly the floating ghost onto its home rect
  // before compositing so the paste visibly lands where it belongs. Preserve
  // the ghost's on-screen spot across the recenter so it doesn't jump first.
  const held = view.ghostScreenRect();
  view.centerOn(rect.x + rect.w / 2, rect.y + rect.h / 2,
    Math.min(1, (window.innerWidth * 0.6) / rect.w));
  view.setGhostFromScreenRect(held);
  await view.flyGhostTo(rect);

  snapshotForUndo();
  explored.paste(bitmap, rect.x, rect.y, rect.w, rect.h);
  view.settleGhost();   // flash over the composite, then clears itself

  const data = {
    id: crypto.randomUUID(),
    x: rect.x + (marker ? marker.fx : 0.5) * rect.w,
    y: rect.y + (marker ? marker.fy : 0.5) * rect.h,
    cat: 'other', note: '', done: false,
    // a picture pasted before this pin existed comes along automatically
    img: takeHeldShot(),
    created: Date.now(),
  };
  lastUndo.pinId = data.id;
  pins.add(data, { select: true, pop: true });
  pins.lastPlacedId = data.id; // don't let a paste right after placing attach to it
  persistPin(data);
  if (data.img) toast('The picture you kept earlier is on this pin.', 'ok');

  // sub-pixel polish runs in the background while the pin editor is open;
  // it re-composites (and nudges the pin) if it beats this placement, and
  // closes the bitmap when done
  finalizeAlignment(bitmap, rect, 'map', data.id);

  // straight to the editor — its picture slot takes the paste, so there's no
  // separate "add a picture" step
  const edit = await openPinEditor(data, true);
  if (edit) {
    data.cat = edit.cat;
    data.note = edit.note;
    pins.update(data);
    persistPin(data);
    ensureCatVisible(data.cat);
  }
  // no player marker found means the pin is only a guess at the area's centre
  // — tell them to drag it onto where they actually are
  if (!marker) {
    toast("Couldn't find your player — drag the pin onto your actual spot.",
      'error', { label: 'Got it', fn: () => {} });
  }
}

// Read the area name(s) first — reliable even when the surrounding area is
// unexplored (black). Returns a plausible rect or null (then we shape-match).
async function tryOcr(bitmap, full, scaleHint, markerBox = null) {
  let r = null;
  try {
    spinner(true, 'Reading the area name…');
    r = await ocrLocate(bitmap, { full, scaleHint, lockedScale: learnedScale, onStatus: m => spinner(true, m) });
    if (r) console.log('[silksong-map] OCR match:', r.names, r);
  } catch (e) {
    console.warn('[silksong-map] OCR unavailable:', e.message);
    return null;
  }
  if (!r || !plausible(r)) return null;

  // overlay ink (matched name labels, the player marker) is drawn ON the map,
  // not part of it — the content verifier must not demand it lands on rooms.
  // On a small cropped shot these overlays dominate the drawn strokes and,
  // uncorrected, sank a perfectly placed shot below the fill-sanity gate.
  // 'text' still aligns with the reference's own label text, so it only
  // leaves the fill check; the marker exists nowhere on the reference, so
  // its edges are noise for the position search too
  const exclude = [
    ...(r.textBoxes || []).map(b => ({ ...b, kind: 'text' })),
    ...(markerBox ? [{ ...markerBox, kind: 'marker' }] : []),
  ];

  // OCR gives identity + a rough spot, but its bounding boxes are only
  // approximate (dropped words, names cut off at the edge) — snap the
  // prediction onto the reference's room structure to get exact position
  // AND scale. In unexplored (black) areas there is nothing to snap to;
  // the raw OCR rect is the best we have then.
  try {
    const prog = f => spinner(true, `Fine-tuning the position… ${Math.round(f * 100)}%`);
    const mode = full ? 'full' : 'map';
    const spread = r.scaleSource === 'locked' && scaleTrusted ? 'narrow'
      : r.scaleSource === 'height' ? 'wide' : 'normal';
    // an unexplored (near-black) area has no room structure to snap to, so a
    // confident name is the only signal there — trust it alone; a weak lone
    // name isn't enough, fall through so shape matching gets a try
    const sparseResult = () =>
      (r.names?.length >= 2 || r.score >= 0.72) ? { ...r, ratio: 0.4 } : null;

    let snapped = await locate(bitmap, mapImage, mode, prog, { rect: r, spread, exclude });
    let usedSpread = spread;
    if (snapped && snapped.sparse) return sparseResult();
    if (!snapped) {
      // one retry. With a content-verified scale the failure is almost
      // always POSITION (an imprecise OCR anchor), so widen the search
      // window and keep the scale pinned; without a trusted scale, widen
      // the scale band instead (stale save, resolution change).
      const retry = scaleTrusted
        ? { rect: r, spread: 'narrow', wideWindow: true, exclude }
        : { rect: r, spread: 'wide', exclude };
      if (!(spread === retry.spread && !retry.wideWindow)) {
        spinner(true, scaleTrusted ? 'Searching a wider area…' : 'Searching nearby scales…');
        snapped = await locate(bitmap, mapImage, mode, prog, retry);
        usedSpread = retry.spread;
        if (snapped && snapped.sparse) return sparseResult();
      }
    }
    if (snapped) {
      console.log('[silksong-map] OCR refined:', snapped);
      return {
        ...snapped, score: Math.max(r.score, snapped.score), names: r.names,
        via: 'ocr', refined: true,
        // a narrow search only re-found the locked scale — not a measurement
        scaleMeasured: usedSpread !== 'narrow',
      };
    }
    // a name was read but nothing under it matched the reference — the name
    // match is probably wrong. Give shape matching a chance instead of
    // applying an unverified guess.
    console.log('[silksong-map] OCR unverified, falling through:', r.names);
    return null;
  } catch (e) {
    console.warn('[silksong-map] OCR refine failed:', e.message);
  }
  return r;
}

// Keep the single global scale in sync. Content-verified placements (room
// structure matched against the reference) each contribute a sample and the
// global scale is their median — individual refinements jitter by ~1% and
// the median keeps every future paste locked to one consistent zoom. A raw
// OCR guess only seeds the scale while nothing better is known.
function adoptScale(rect, bitmap) {
  const verified = rect.refined || (rect.via === 'label' && !rect.unverified);
  if (verified) {
    // only genuine measurements feed the median — a narrow re-find of the
    // locked scale carries no new information
    const measured = rect.via === 'label' || rect.scaleMeasured !== false;
    if (measured || !scaleSamples.length) {
      scaleSamples.push(rect.w / bitmap.width);
      if (scaleSamples.length > 9) scaleSamples.shift();
      const s = [...scaleSamples].sort((a, b) => a - b);
      learnedScale = s[s.length >> 1];
      store.putMeta('scale', learnedScale);
      store.putMeta('scaleSamples', scaleSamples);
    }
    scaleTrusted = true;
    store.putMeta('scaleTrusted', true);
  } else if (rect.via === 'ocr' && rect.establishScale && !learnedScale) {
    learnedScale = rect.establishScale;
    scaleTrusted = false;
    store.putMeta('scale', learnedScale);
    store.putMeta('scaleTrusted', false);
  }
}

// Every screenshot is taken at the same in-game zoom, so once the global
// scale is trusted there is exactly ONE correct scale. Forcing it (about the
// placement's centre) makes overlapping pastes differ by translation only,
// which the stitch nudge then closes seamlessly.
function forceGlobalScale(rect, bitmap) {
  if (!(scaleTrusted && learnedScale)) return rect;
  const k = rect.w / bitmap.width;
  if (Math.abs(k / learnedScale - 1) >= 0.025) return rect; // too far off — keep measured
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  const nw = bitmap.width * learnedScale, nh = bitmap.height * learnedScale;
  return { ...rect, x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh };
}

async function handleMapScreenshot(blob) {
  const bitmap = await createImageBitmap(blob);
  const marker = detectPlayerMarker(bitmap);
  const markerScale = marker ? MARKER_MAP_HEIGHT / marker.h : null;

  showPasteGhost(bitmap); // float it on the map while we work out where it goes

  let rect = await tryOcr(bitmap, false, markerScale, marker && marker.box);

  if (!rect) {
    // fall back to shape matching. Every screenshot is at the same in-game
    // zoom, so once the first paste has fixed the scale, lock ALL later pastes
    // to that exact scale; before that, seed it from the player marker.
    spinner(true, 'Locating screenshot on the map…');
    const hint = learnedScale
      ? { k: learnedScale, tight: true }
      : (marker ? { k: MARKER_MAP_HEIGHT / marker.h, tight: true } : null);
    try {
      const prog = f => spinner(true, `Locating screenshot on the map… ${Math.round(f * 100)}%`);
      rect = await locate(bitmap, mapImage, 'map', prog, hint);
      if (hint && !(certain(rect) || rect?.via === 'label')) {
        spinner(true, 'Double-checking across all scales…');
        const wide = await locate(bitmap, mapImage, 'map', prog, null);
        if (wide && (!rect || wide.via === 'label' || wide.ratio < rect.ratio)) rect = wide;
      }
    } catch (err) {
      console.error(err);
      toast('Locating failed: ' + err.message, 'error');
    }
  }

  // a shape match whose scale disagrees with the established global scale
  // (all screenshots share one zoom) or with the player marker's size is
  // suspect — treat it as a non-match. Without this, a cold start with a
  // junk first match can seed a poisoned scale that breaks every paste.
  if (rect && !rect.via) {
    const k = rect.w / bitmap.width;
    const offLearned = learnedScale && Math.abs(k / learnedScale - 1) > 0.08;
    const offMarker = markerScale && Math.abs(k / markerScale - 1) > 0.15;
    if (offLearned || offMarker) rect = { ...rect, ratio: Math.max(rect.ratio ?? 1, 0.9) };
  }

  spinner(false);
  dockSpinner(false);
  console.log('[silksong-map] map locate:', rect, 'marker:', marker);

  if (!certain(rect)) {
    await view.rejectGhost();
    bitmap.close?.();
    updateEmptyHint(); // nothing landed — bring the prompt back if still blank
    toast("Couldn't place this screenshot confidently — nothing was revealed. Try one that clearly shows the area name, or a bit more of the map.", 'error');
    return;
  }

  // applyMapPlacement flies the ghost into place, composites, then closes the
  // bitmap once the fly is done
  await applyMapPlacement(bitmap, rect, marker);
}

// a paste while a pin is awaiting its screenshot attaches directly — no dialog
async function attachToAwaiting(blob) {
  const entry = pins.pins.get(pins.attachTarget());
  if (!entry) return;
  entry.data.img = blob;
  pins.update(entry.data);
  persistPin(entry.data);
  pins.setAwaiting(null);
  closeDialog('#dlg-await');
  // let the screenshot fly into the pin before anything else pops up
  await flyImageToPin(blob, entry);
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
  closeDialog('#dlg-await');
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
  flyImageToPin(blob, entry);
  toast('Screenshot attached — hover the pin to see it.', 'ok');
}

async function handleFullMap(blob) {
  const bitmap = await createImageBitmap(blob);
  const marker = detectPlayerMarker(bitmap);
  const markerScale = marker ? MARKER_MAP_HEIGHT / marker.h : null;

  showPasteGhost(bitmap);

  // read area names first — a big zoomed-out map has several, which pins the
  // scale from the distances between them (no per-paste drift)
  let rect = await tryOcr(bitmap, true, markerScale, marker && marker.box);

  if (!rect) {
    spinner(true, 'Aligning your map…');
    const hint = marker ? { k: MARKER_MAP_HEIGHT / marker.h, tight: true } : null;
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
  }

  spinner(false);
  dockSpinner(false);
  console.log('[silksong-map] full locate:', rect);

  if (!certain(rect)) {
    await view.rejectGhost();
    bitmap.close?.();
    updateEmptyHint(); // nothing landed — bring the prompt back if still blank
    toast("Couldn't align this map confidently — nothing was changed. Make sure an area name is visible, or zoom out a little more.", 'error');
    return;
  }

  if (rect.via === 'ocr' || rect.via === 'label') {
    // reference-aligned — trust it, pin to the global scale, then a tiny
    // stitch nudge onto what's already pasted
    adoptScale(rect, bitmap);
    rect = forceGlobalScale(rect, bitmap);
    rect = explored.refineAlignment(bitmap, rect, { maxShift: 8 });
  } else {
    rect = explored.refineAlignment(bitmap, rect);
  }
  // frame the update by how much it actually covers — a partial map zooms to
  // its region, a whole-world screenshot zooms right out
  const held = view.ghostScreenRect();
  view.centerOn(rect.x + rect.w / 2, rect.y + rect.h / 2, fitRectScale(rect));
  view.setGhostFromScreenRect(held);
  await view.flyGhostTo(rect);
  snapshotForUndo();
  explored.paste(bitmap, rect.x, rect.y, rect.w, rect.h);
  view.settleGhost();
  finalizeAlignment(bitmap, rect, 'full', null); // background; closes the bitmap
  toast('Map updated with everything you have explored.', 'ok', { label: 'Undo', fn: undoLast });
}

// ------------------------------------------- hand-placed pastes (custom games)

// The step bar at the bottom of the map. Both halves of the flow use it:
// positioning the screenshot, then clicking your player's spot.
function showPlaceBar(step, msgHtml, actions) {
  $('#place-step').textContent = step;
  $('#place-msg').innerHTML = msgHtml;
  const wrap = $('#place-actions');
  wrap.innerHTML = '';
  for (const a of actions) {
    if (a.el) { wrap.appendChild(a.el); continue; }
    const b = document.createElement('button');
    b.className = 'btn' + (a.primary ? ' primary' : '') + (a.icon ? ' icon' : '');
    b.textContent = a.label;
    if (a.title) b.title = a.title;
    b.addEventListener('click', a.fn);
    wrap.appendChild(b);
  }
  $('#place-bar').classList.remove('hidden');
  document.body.classList.add('placing-paste'); // clears the bottom paste pill
}
function hidePlaceBar() {
  $('#place-bar').classList.add('hidden');
  document.body.classList.remove('placing-paste');
}

// live size readout while the screenshot is being sized (MapView calls this)
let placeBaseWidth = 0;
function updatePlaceSize(rect) {
  const el = document.getElementById('place-size');
  if (el && rect && placeBaseWidth) el.textContent = Math.round(rect.w / placeBaseWidth * 100) + '%';
}

// Position a pasted screenshot by hand. Resolves with the chosen map rect, or
// null if it was cancelled.
function positionPaste(bitmap, rect, { snapped = false } = {}) {
  return new Promise(resolve => {
    placeBaseWidth = bitmap.width;
    view.setPlacement({ img: bitmap, x: rect.x, y: rect.y, w: rect.w });

    const size = document.createElement('span');
    size.className = 'pb-size';
    size.id = 'place-size';

    const finish = ok => {
      document.removeEventListener('keydown', onKey, true);
      const r = view.placementRect();
      view.setPlacement(null);
      hidePlaceBar();
      resolve(ok ? r : null);
    };

    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); return; }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); return; }
      const step = e.shiftKey ? 10 : 1;
      const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      // one map pixel per press, on the map's own pixel grid — the finest
      // step that can actually land the screenshot exactly
      if (nudge) { e.preventDefault(); view.nudgePlacement(nudge[0], nudge[1]); return; }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); view.scalePlacement(1.02); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); view.scalePlacement(1 / 1.02); }
      else if (e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        const btn = [...document.querySelectorAll('#place-actions .btn')].find(b => b.textContent === 'Difference');
        if (btn) btn.click();
      }
    };
    document.addEventListener('keydown', onKey, true);

    const actions = [
      { label: '−', icon: true, title: 'Smaller (or Shift+scroll)', fn: () => view.scalePlacement(1 / 1.04) },
      { el: size },
      { label: '+', icon: true, title: 'Bigger (or Shift+scroll)', fn: () => view.scalePlacement(1.04) },
    ];
    // both alignment aids need something already on the map to align to
    if (!explored.isBlank()) {
      const diff = document.createElement('button');
      diff.className = 'btn';
      diff.textContent = 'Difference';
      diff.title = 'Show the difference against the map underneath — nudge until the overlap goes black (D)';
      diff.addEventListener('click', () => diff.classList.toggle('active', view.togglePlacementDiff()));
      actions.push({ el: diff },
        { label: 'Auto-align', title: 'Snap it onto the screenshots already on the map', fn: runAutoAlign });
    }
    actions.push(
      { label: 'Place it', primary: true, fn: () => finish(true) },
      { label: 'Cancel', fn: () => finish(false) },
    );

    showPlaceBar('Step 1',
      snapped
        ? 'Lined up automatically — check it looks right. Arrow keys nudge it a pixel at a time.'
        : 'Drag the screenshot into place — hold <span class="kbd">Shift</span> and scroll to resize, arrow keys to nudge.',
      actions);
    updatePlaceSize(view.placementRect());
  });
}

// Image-only alignment against what's already pasted — no reference map, so
// it works for any game. It only ever MOVES the placement you made: the size
// you set is taken as correct (one in-game zoom per game), and the search
// stays around where you dropped it.
function runAutoAlign() {
  const rect = view.placementRect();
  const p = view.placement;
  if (!rect || !p) return;
  spinner(true, 'Lining it up with your map…');
  // let the spinner paint before the synchronous search blocks the thread
  setTimeout(() => {
    let r = null;
    try {
      r = explored.autoAlign(p.img, rect);
    } catch (e) {
      console.error(e);
    }
    spinner(false);
    console.log('[map] auto-align:', r);
    if (!r || r.score < 0.12) {
      toast("Couldn't find anything here to line it up with — place it by eye, or move it closer first.", 'error');
      return;
    }
    view.setPlacementRect(r);
    const moved = Math.hypot(r.x - rect.x, r.y - rect.y);
    toast(moved < 0.6 ? 'Already lined up.' : 'Lined up with the map you already have.', 'ok');
  }, 30);
}

// Custom-game paste: you place it, then you mark where you are.
async function handleManualPlace(blob) {
  const bitmap = await createImageBitmap(blob);
  $('#empty-hint').classList.add('hidden');

  // start it at the size the last paste ended up — every screenshot from the
  // same game is normally taken at the same zoom, so usually there's nothing
  // to resize. Otherwise, something that comfortably fits the viewport.
  const k = learnedScale || Math.min(
    1, (view.canvas.clientWidth * 0.45) / (bitmap.width * view.scale));
  const w = bitmap.width * k, h = bitmap.height * k;
  const c = view.screenToMap(view.canvas.clientWidth / 2, view.canvas.clientHeight / 2);
  let start = { x: Math.round(c.x - w / 2), y: Math.round(c.y - h / 2), w, h };

  // Give auto-align first crack at it: if the screenshot lands anywhere near
  // where it belongs, it arrives already lined up and there's nothing to do
  // but confirm. A stricter bar than the button's — this move wasn't asked
  // for, so weak evidence should leave the paste where it dropped.
  let snapped = false;
  if (!explored.isBlank()) {
    spinner(true, 'Lining it up with your map…');
    await new Promise(r => setTimeout(r, 30)); // let the spinner paint first
    try {
      const r = explored.autoAlign(bitmap, start);
      console.log('[map] auto-align on paste:', r);
      if (r && r.score >= 0.2) { start = { ...start, x: r.x, y: r.y }; snapped = true; }
    } catch (e) {
      console.warn('[map] auto-align on paste failed:', e.message);
    }
    spinner(false);
  }

  const rect = await positionPaste(bitmap, start, { snapped });
  if (!rect) {
    bitmap.close?.();
    updateEmptyHint();
    toast('Paste cancelled — nothing was added.');
    return;
  }

  snapshotForUndo();
  // land on the map's pixel grid: a drag ends on a fraction of a pixel, which
  // resamples the screenshot (softening it) and puts the next paste's stitch
  // half a pixel out. Auto-align and the arrow keys already work in whole
  // pixels, so this only ever moves a free-dragged paste by <1px.
  explored.paste(bitmap, Math.round(rect.x), Math.round(rect.y), rect.w, rect.h);
  bitmap.close?.();
  // remember the size for the next paste
  learnedScale = rect.w / (placeBaseWidth || 1);
  store.putMeta('scale', learnedScale);

  // step 2 — where are you?
  const spot = await askPlayerLocation();
  if (!spot) {
    toast('Screenshot added.', 'ok', { label: 'Undo', fn: undoLast });
    return;
  }
  const data = await createManualPin(spot.x, spot.y);
  if (data && lastUndo) lastUndo.pinId = data.id; // undo takes the pin with it
}

// the click-your-player step. Resolves with map coords, or null if skipped.
function askPlayerLocation() {
  return new Promise(resolve => {
    showPlaceBar('Step 2', 'Now click your player’s spot on the map to drop a pin there.',
      [{ label: 'Skip', fn: () => stopPlacing() }]);
    startPlacing(m => { hidePlaceBar(); resolve(m); }, { toast: false, onCancel: () => resolve(null) });
  });
}

// ------------------------------------------- a picture waiting for its pin

// You photograph the place, and only then remember to open the map — so the
// picture arrives before the pin it belongs to exists. Rather than making you
// go back for it, a paste can be parked here: the next pin you add picks it
// up automatically. Survives a reload (it's kept in the game's store), so
// stepping away and coming back doesn't lose it.
let heldShot = null;      // { blob, url }

function renderHeldShot() {
  const el = $('#held-shot');
  el.classList.toggle('hidden', !heldShot);
  if (heldShot) $('#held-shot-img').src = heldShot.url;
}

function setHeldShot(blob, { persist = true } = {}) {
  if (heldShot) URL.revokeObjectURL(heldShot.url);
  heldShot = { blob, url: URL.createObjectURL(blob) };
  if (persist) store.putMeta('heldShot', blob);
  renderHeldShot();
}

function clearHeldShot({ persist = true } = {}) {
  if (heldShot) URL.revokeObjectURL(heldShot.url);
  heldShot = null;
  if (persist) store.putMeta('heldShot', null);
  renderHeldShot();
}

// hand the waiting picture to a pin being created (null if there isn't one)
function takeHeldShot() {
  if (!heldShot) return null;
  const blob = heldShot.blob;
  clearHeldShot();
  return blob;
}

let currentPaste = null; // { blob, url } while the type chooser is open

function routePaste(blob) {
  // one screenshot at a time while one is being positioned by hand
  if (view.placement) {
    toast('Finish placing the current screenshot first.');
    return;
  }
  // the pin editor's empty picture slot takes a paste straight away
  if (pinEditorAttach && document.querySelector('#dlg-pin[open] #pin-shot .no-env')) {
    pinEditorAttach(blob);
    return;
  }
  // pasting abandons any pin move in progress
  pins.cancelPendingMove();
  // don't intercept pastes while choosing a pin type / editing a custom type
  if (document.querySelector('#dlg-pin[open], #dlg-cattype[open]')) return;
  // only a pin explicitly waiting for its picture (its 📷 button) takes a
  // paste directly — everything else goes through the chooser, so pasting a
  // map screenshot is never silently swallowed as a pin's area image
  if (pins.awaitingId && $('#dlg-await').open) {
    attachToAwaiting(blob);
    return;
  }
  // hovering an EMPTY pin (its marker or its open card) attaches the paste to
  // it directly — a filled pin is left alone so a fresh map screenshot isn't
  // hijacked by the last pin you looked at
  const hoverId = pins.pasteTarget();
  const hoverEntry = hoverId && pins.pins.get(hoverId);
  if (hoverEntry && !hoverEntry.data.img) {
    hoverEntry.data.img = blob;
    persistPin(hoverEntry.data);
    // keep the card open and slide the picture into it (no fly-into-marker)
    pins.insertImage(hoverEntry);
    toast('Screenshot attached.', 'ok');
    return;
  }
  currentPaste = { blob, url: URL.createObjectURL(blob) };
  $('#paste-preview').src = currentPaste.url;
  $('#dlg-paste').showModal();
}

// wired once at startup
for (const b of document.querySelectorAll('#dlg-paste button[data-type]')) {
  b.addEventListener('click', async () => {
    const paste = currentPaste;
    currentPaste = null;
    closeDialog('#dlg-paste');
    if (!paste) return;
    URL.revokeObjectURL(paste.url);
    const type = b.dataset.type;
    if (type === 'map') await handleMapScreenshot(paste.blob);
    else if (type === 'env') await handleEnvScreenshot(paste.blob);
    else if (type === 'full') await handleFullMap(paste.blob);
    else if (type === 'place') await handleManualPlace(paste.blob);
    else if (type === 'hold') {
      const replaced = !!heldShot;
      setHeldShot(paste.blob);
      toast(replaced
        ? 'Kept instead — the previous waiting picture was dropped.'
        : "Picture kept. The next pin you add gets it — paste your map screenshot when you're ready.", 'ok');
    }
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
    // which game this backup came from, so importing it somewhere else can
    // say so (pin coordinates only mean anything within the same world size)
    game: { id: game.id, name: game.name, icon: game.icon, w: world.width, h: world.height },
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
  const slug = game.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'map';
  a.download = `${slug}-map-backup-${new Date().toISOString().slice(0, 10)}.json`;
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
  // a backup made in another game is still importable, but its pin positions
  // were measured against that game's world — say so before it lands
  let warn = '';
  const from = data.game;
  if (from && from.id !== game.id) {
    warn = ` This backup is from “${from.name}”`
      + (from.w && (from.w !== world.width || from.h !== world.height)
        ? ', whose map is a different size — its pins and map will not line up here.'
        : '.');
  }
  if (!await confirmDialog(`Importing replaces “${game.name}”'s map progress and pins.${warn} Continue?`,
    { title: 'Import backup?', okLabel: 'Import', danger: false })) return;

  await store.clearPins();
  pins.removeAll();
  explored.clear();
  lastUndo = null; // the old undo snapshot no longer matches anything
  if (data.fog) await explored.loadFromBlob(await dataURLToBlob(data.fog));

  setCustomCategories(data.customCats || []);
  setOrder(data.catOrder || []);
  await persistCats();
  for (const c of categories()) pins.filter.add(c.id);
  soloReturn = null; soloedId = null;

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

// persist which types are checked (visible). During a temporary solo the real
// selection lives in soloReturn, so save that instead of the {soloed} view.
function persistFilter() {
  const base = soloedId ? soloReturn : pins.filter;
  store.putMeta('catFilter', [...(base || pins.filter)]);
}

function updateCatCounts() {
  const counts = {};
  for (const e of pins.pins.values()) {
    if (e.data.done) continue;            // completed pins don't count
    counts[e.data.cat] = (counts[e.data.cat] || 0) + 1;
  }
  for (const row of $('#cat-list').querySelectorAll('.cat-row')) {
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
  for (const row of $('#cat-list').querySelectorAll('.cat-row')) syncRow(row);
}

function renderCatList() {
  const list = $('#cat-list');
  list.innerHTML = '';
  for (const c of categories()) {
    const on = pins.filter.has(c.id);
    const row = document.createElement('div');
    row.className = 'cat-row' + (on ? '' : ' off');
    row.dataset.id = c.id;
    row.style.setProperty('--pc', c.color || '#9e2b25');
    // fixed del-slot on every row keeps the count column aligned whether or
    // not the type is deletable; checkbox lives on the right
    row.innerHTML =
      `<span class="cat-ico">${c.icon}</span>` +
      `<span class="cat-name">${c.label}</span>` +
      `<span class="cat-count"></span>` +
      `<span class="cat-del-slot"></span>` +
      `<label class="cat-check-wrap"><input type="checkbox" class="cat-check" title="Show / hide this type"${on ? ' checked' : ''}></label>`;

    // checkbox toggles visibility for just this type; a manual edit ends the
    // temporary solo and becomes the new base selection
    row.querySelector('.cat-check').addEventListener('change', e => {
      e.stopPropagation();
      if (soloedId !== null) { e.target.checked = pins.filter.has(c.id); return; } // locked while focused
      if (e.target.checked) pins.filter.add(c.id);
      else pins.filter.delete(c.id);
      row.classList.toggle('off', !e.target.checked);
      pins.applyFilter();
      persistFilter();
    });

    if (isCustom(c.id)) {
      const slot = row.querySelector('.cat-del-slot');
      const edit = document.createElement('button');
      edit.className = 'cat-edit';
      edit.textContent = '✎';
      edit.title = 'Edit symbol, colour or name';
      edit.addEventListener('click', e => { e.stopPropagation(); editCustomType(c.id); });
      const del = document.createElement('button');
      del.className = 'cat-del';
      del.textContent = '🗑';
      del.title = 'Delete this custom type';
      del.addEventListener('click', e => { e.stopPropagation(); deleteCustomType(c.id); });
      slot.append(edit, del);
    }

    wireCatRow(row, c.id);
    list.appendChild(row);
  }
  // the "New type" button rides at the end of the list, right under the last
  // category — shaped like a row but set apart (see .cat-new-row)
  const newBtn = document.createElement('button');
  newBtn.id = 'btn-cat-new';
  newBtn.className = 'cat-new-row';
  newBtn.title = 'Create your own pin type';
  newBtn.innerHTML =
    '<span class="cat-new-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg></span>' +
    '<span class="cat-new-name">New type</span>';
  newBtn.addEventListener('click', () => { catTypeCreatedCb = null; openCatTypeDialog(); });
  list.appendChild(newBtn);
  updateCatCounts();
  updateSoloUI();
}

// clicking a row shows only that type; clicking it again restores whatever
// was checked before (not everything). soloReturn remembers that base set.
let soloReturn = null;
let soloedId = null;
function toggleSolo(id) {
  if (soloedId === id) {
    pins.filter = new Set(soloReturn || pins.filter);
    soloReturn = null;
    soloedId = null;
  } else {
    if (!soloReturn) soloReturn = new Set(pins.filter);
    soloReturn.add(id);          // focusing a row keeps it visible on restore
    soloedId = id;
    pins.filter = new Set([id]);
  }
  pins.applyFilter();
  syncAllRows();
  updateSoloUI();
  persistFilter();
}

// reflect single-type focus: highlight the soloed row, show the restore hint,
// and lock the checkboxes (they mirror the focus, not a manual selection)
function updateSoloUI() {
  const list = $('#cat-list');
  list.classList.toggle('soloing', soloedId !== null);
  for (const row of list.querySelectorAll('.cat-row')) {
    const isSolo = soloedId !== null && row.dataset.id === soloedId;
    row.classList.toggle('solo', isSolo);
    row.title = isSolo ? 'Showing only this type — click it again to bring the rest back'
      : (soloedId !== null ? '' : 'Click to show only this type');
  }
}

// make sure a category's pins are visible (e.g. after adding a pin to a type
// that was hidden) — ends any single-type focus and checks the type on
function ensureCatVisible(catId) {
  if (soloedId === null && pins.filter.has(catId)) return;
  if (soloedId !== null) { pins.filter = new Set(soloReturn || pins.filter); soloReturn = null; soloedId = null; }
  pins.filter.add(catId);
  pins.applyFilter();
  syncAllRows();
  updateSoloUI();
  persistFilter();
}

function wireCatRow(row, id) {
  row.addEventListener('pointerdown', e => {
    if (e.target.closest('.cat-check-wrap, .cat-del, .cat-edit')) return; // let controls work
    e.preventDefault();
    const list = $('#cat-list');
    const startY = e.clientY;
    // where along the row we grabbed, so it stays under the cursor
    const grab = e.clientY - row.getBoundingClientRect().top;
    let dragging = false;

    const onMove = ev => {
      if (!dragging) {
        if (Math.abs(ev.clientY - startY) < 5) return;
        dragging = true;
        row.classList.add('dragging');
      }
      // 1) reorder against neighbours (they carry no transform, so their
      //    rects are the true layout positions)
      const others = [...list.querySelectorAll('.cat-row:not(.dragging)')];
      const before = others.find(r => {
        const b = r.getBoundingClientRect();
        return ev.clientY < b.top + b.height / 2;
      });
      if (before) list.insertBefore(row, before);
      else list.insertBefore(row, list.querySelector('.cat-new-row')); // stays above "New type"
      // 2) float the row under the cursor — clear the transform first so we
      //    measure the true (untransformed) layout position, no compounding
      row.style.transform = '';
      const top = row.getBoundingClientRect().top;
      row.style.transform = `translateY(${ev.clientY - grab - top}px)`;
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (dragging) {
        row.classList.remove('dragging');
        row.style.transform = '';
        setOrder([...list.querySelectorAll('.cat-row')].map(r => r.dataset.id));
        persistCats();
      } else {
        toggleSolo(id);
      }
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
}

let catTypeEditing = null;     // id of the custom type being edited, or null
let catTypeCreatedCb = null;   // set by the pin editor to receive a new type

function openCatTypeDialog() {
  catTypeEditing = null;
  $('#cattype-title').textContent = 'New pin type';
  $('#btn-cattype-save').textContent = 'Create type';
  $('#cattype-icon').value = '';
  $('#cattype-label').value = '';
  $('#cattype-color').value = '#e0c37e';
  $('#dlg-cattype').showModal();
  $('#cattype-label').focus();
}

function editCustomType(id) {
  const c = catById(id);
  catTypeEditing = id;
  $('#cattype-title').textContent = 'Edit pin type';
  $('#btn-cattype-save').textContent = 'Save changes';
  $('#cattype-icon').value = c.icon || '';
  $('#cattype-label').value = c.label || '';
  $('#cattype-color').value = c.color || '#e0c37e';
  $('#dlg-cattype').showModal();
  $('#cattype-label').focus();
}

function saveCatType() {
  const label = $('#cattype-label').value.trim();
  if (!label) { $('#cattype-label').focus(); return; }
  const icon = $('#cattype-icon').value.trim() || '📌';
  const color = $('#cattype-color').value;

  if (catTypeEditing) {
    updateCustomCategory(catTypeEditing, { icon, label, color });
    // re-decorate any pins already using this type
    for (const e of pins.pins.values()) if (e.data.cat === catTypeEditing) pins.update(e.data);
    catTypeEditing = null;
    persistCats();
    closeDialog('#dlg-cattype');
    renderCatList();
    toast('Pin type updated.', 'ok');
    return;
  }

  const cat = { id: 'c_' + crypto.randomUUID().slice(0, 8), icon, label, color };
  addCustomCategory(cat);
  pins.filter.add(cat.id);
  persistCats();
  persistFilter();
  $('#dlg-cattype').close();
  renderCatList();
  // if launched from the pin editor, hand the new type back to be selected
  if (catTypeCreatedCb) { const cb = catTypeCreatedCb; catTypeCreatedCb = null; cb(cat); }
  toast('New pin type added.', 'ok');
}

async function deleteCustomType(id) {
  if (!await confirmDialog('Any pins using it become “Other”.',
    { title: 'Delete this pin type?', okLabel: 'Delete' })) return;
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
  persistFilter();
  renderCatList();
}

// ------------------------------------------------- manual pin placement

let placing = false;
let ghostPin = null;
let placeClickCb = null;   // where the next map click goes (null = new pin)
let placeCancelCb = null;

function onPlacingMove(e) {
  if (!ghostPin) return;
  // over the Cancel button the ghost fades out (and smoothly back on leave)
  ghostPin.classList.toggle('ghost-hidden', !!e.target.closest('#btn-add-pin'));
  ghostPin.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
}

function onPlacingClick(e) {
  // clicks on chrome (toolbar, sidebar, dialogs, sliders) don't place a pin
  if (e.target.closest('#toolbar, #cat-bar, #map-opacity, #place-bar, dialog, .toast')) return;
  e.preventDefault();
  e.stopPropagation();
  const m = view.screenToMap(e.clientX, e.clientY);
  const cb = placeClickCb;
  placeClickCb = null;
  placeCancelCb = null;   // this is a completion, not a cancel
  stopPlacing();
  if (cb) cb(m); else createManualPin(m.x, m.y);
}

// `onPlace` takes over what a map click does (the custom-game "click your
// player" step); without it a click creates a pin as usual.
function startPlacing(onPlace = null, { toast: withToast = true, onCancel = null } = {}) {
  if (placing) return;
  placing = true;
  placeClickCb = onPlace;
  placeCancelCb = onCancel;
  pins.suppressHover = true; // don't pop other pins' cards while placing
  ghostPin = document.createElement('div');
  ghostPin.className = 'pin ghost-pin';
  ghostPin.style.setProperty('--pc', '#e0c37e');
  ghostPin.innerHTML = '<span class="pin-ico">📍</span>';
  document.body.appendChild(ghostPin);
  document.addEventListener('pointermove', onPlacingMove);
  // capture so the map's own handlers don't also react to the placing click
  document.addEventListener('click', onPlacingClick, true);
  document.body.classList.add('placing-mode');
  const btn = $('#btn-add-pin');
  btn.classList.add('active');
  btn.querySelector('.add-pin-ico').textContent = '✕';
  btn.querySelector('.add-pin-label').textContent = 'Cancel';
  btn.dataset.tip = 'Click the map to drop the pin — or click here to cancel (Esc)';
  if (withToast) toast('Click the spot on the map to drop your pin. Esc to cancel.');
}

function stopPlacing() {
  if (!placing) return;
  placing = false;
  const cancelled = placeCancelCb;
  placeClickCb = null;
  placeCancelCb = null;
  pins.suppressHover = false;
  document.removeEventListener('pointermove', onPlacingMove);
  document.removeEventListener('click', onPlacingClick, true);
  if (ghostPin) { ghostPin.remove(); ghostPin = null; }
  document.body.classList.remove('placing-mode');
  const btn = $('#btn-add-pin');
  btn.classList.remove('active');
  btn.querySelector('.add-pin-ico').textContent = '📍';
  btn.querySelector('.add-pin-label').textContent = 'Add pin';
  btn.dataset.tip = 'Add a pin — click, then click the spot on the map';
  hidePlaceBar();
  if (cancelled) cancelled();
}

// resolves with the pin's data, or null if the editor was cancelled
async function createManualPin(x, y) {
  const held = takeHeldShot();  // a picture pasted before this pin existed
  const data = {
    id: crypto.randomUUID(),
    x, y, cat: 'other', note: '', done: false, img: held,
    created: Date.now(),
  };
  pins.add(data, { select: true });
  pins.lastPlacedId = data.id;
  if (held) toast('The picture you kept earlier is on this pin.', 'ok');
  const edit = await openPinEditor(data, true);
  if (edit) {
    data.cat = edit.cat;
    data.note = edit.note;
    pins.update(data);
    persistPin(data);
    ensureCatVisible(data.cat);
    return data;
  }
  // cancelled — the pin was only provisional, so it shouldn't stick around.
  // The waiting picture goes back to waiting rather than vanishing with it
  // (unless the editor was used to swap it out for a different one).
  pins.remove(data.id);
  if (held && data.img === held) setHeldShot(held);
  return null;
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

// show the big "paste your first map" prompt only while nothing's revealed yet
function updateEmptyHint() {
  $('#empty-hint').classList.toggle('hidden', !explored.isBlank());
  positionEmptyHint();
}

// anchor the empty prompt to the map's centre so it pans/zooms with the map
// instead of floating fixed on screen
function positionEmptyHint() {
  const el = $('#empty-hint');
  if (!el || el.classList.contains('hidden')) return;
  const s = view.mapToScreen(world.width / 2, world.height / 2);
  el.style.left = s.x + 'px';
  el.style.top = s.y + 'px';
}

// the help dialog is a one-at-a-time stepper (Back / Next, Next -> "Got it"
// on the last slide closes it)
let helpGoto = () => {};
function wireHelpStepper() {
  const dlg = $('#dlg-help');
  // slides marked for the other kind of game don't apply here — automatic
  // placement and hand placement are different instructions
  const want = game.builtin ? 'builtin' : 'custom';
  const slides = [...dlg.querySelectorAll('.help-slide')].filter(s => {
    const only = s.dataset.for;
    if (only && only !== want) { s.remove(); return false; }
    return true;
  });
  // renumber the eyebrows so the steps read 1..n whichever set is showing
  slides.forEach((s, k) => {
    const eb = s.querySelector('.help-eyebrow');
    if (eb && !eb.classList.contains('tip')) eb.textContent = `Step ${k + 1}`;
  });
  // an example image that fails to load (e.g. an asset not added yet) hides its
  // figure rather than showing a broken-image icon — cover both a later error
  // and one that already failed before this ran
  for (const img of dlg.querySelectorAll('.help-fig img')) {
    const hide = () => { const f = img.closest('.help-fig'); if (f) f.style.display = 'none'; };
    img.addEventListener('error', hide);
    if (img.complete && img.naturalWidth === 0) hide();
  }
  const back = $('#help-back'), next = $('#help-next'), dotsWrap = $('#help-dots');
  dotsWrap.innerHTML = slides.map(() => '<span class="help-dot"></span>').join('');
  const dots = [...dotsWrap.children];
  let i = 0;
  helpGoto = n => {
    i = Math.max(0, Math.min(slides.length - 1, n));
    slides.forEach((s, k) => s.classList.toggle('on', k === i));
    dots.forEach((d, k) => d.classList.toggle('on', k === i));
    back.disabled = i === 0;
    next.textContent = i === slides.length - 1 ? 'Got it' : 'Next';
    dlg.scrollTop = 0;
  };
  back.addEventListener('click', () => helpGoto(i - 1));
  next.addEventListener('click', () => i === slides.length - 1 ? closeDialog(dlg) : helpGoto(i + 1));
  dots.forEach((d, k) => d.addEventListener('click', () => helpGoto(k)));
}
function openHelp() {
  helpGoto(0);
  $('#dlg-help').showModal();
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

// tell the user how to open their OS emoji keyboard in emoji-friendly fields
function emojiKeyboardTip() {
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  return isMac
    ? 'Tip: press Ctrl + Cmd + Space to open the emoji keyboard.'
    : 'Tip: press Win + . (period) to open the emoji keyboard.';
}

// the same tip as markup: key chips inside a highlighted callout (used where
// picking an emoji is the whole point, so it must not be overlooked)
function emojiKeyboardTipHtml() {
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  const keys = isMac
    ? '<span class="kbd">Ctrl</span> + <span class="kbd">Cmd</span> + <span class="kbd">Space</span>'
    : '<span class="kbd">Win</span> + <span class="kbd">.</span>';
  return `<span class="emoji-tip-ico">😀</span><span>Pick any emoji as the icon — press ${keys} to open the emoji keyboard.</span>`;
}

// ----------------------------------------------------------------- toolbar

function buildToolbar() {
  renderCatList();
  $('#btn-cat-all').addEventListener('click', () => {
    for (const c of categories()) pins.filter.add(c.id);
    soloReturn = null; soloedId = null;
    pins.applyFilter();
    syncAllRows();
    updateSoloUI();
    persistFilter();
  });
  $('#btn-cat-none').addEventListener('click', () => {
    pins.filter.clear();
    soloReturn = null; soloedId = null;
    pins.applyFilter();
    syncAllRows();
    updateSoloUI();
    persistFilter();
  });
  $('#pin-note-hint').textContent = emojiKeyboardTip();
  $('#cattype-hint').innerHTML = emojiKeyboardTipHtml();
  $('#cattype-hint').classList.add('emoji-tip');
  $('#btn-add-pin').addEventListener('click', () => placing ? stopPlacing() : startPlacing());

  $('#held-shot-x').addEventListener('click', () => {
    clearHeldShot();
    toast('Waiting picture thrown away.');
  });
  // click the thumbnail to see it full size — so you can check it's the right
  // one before it lands on a pin
  $('#held-shot-img').addEventListener('click', () => heldShot && showLightbox(heldShot.url));

  $('#btn-game').addEventListener('click', () => {
    $('#game-menu').classList.contains('hidden') ? openGameMenu() : closeGameMenu();
  });
  $('#game-hint').innerHTML = emojiKeyboardTipHtml();
  $('#game-hint').classList.add('emoji-tip');
  $('#btn-game-save').addEventListener('click', saveGameDialog);
  $('#btn-game-cancel').addEventListener('click', () => { gameEditing = null; closeDialog('#dlg-game'); });
  $('#dlg-game').addEventListener('cancel', e => { e.preventDefault(); gameEditing = null; closeDialog('#dlg-game'); });
  $('#game-name').addEventListener('keydown', e => { if (e.key === 'Enter') saveGameDialog(); });

  wireSidebarResize();
  wireOpacitySlider();
  $('#btn-cattype-save').addEventListener('click', saveCatType);
  $('#btn-cattype-cancel').addEventListener('click', () => { catTypeCreatedCb = null; closeDialog('#dlg-cattype'); });
  $('#dlg-cattype').addEventListener('cancel', e => { e.preventDefault(); catTypeCreatedCb = null; closeDialog('#dlg-cattype'); });
  $('#cattype-label').addEventListener('keydown', e => { if (e.key === 'Enter') saveCatType(); });

  $('#show-done').addEventListener('change', e => {
    pins.showDone = e.target.checked;
    pins.applyFilter();
    store.putMeta('showDone', e.target.checked);
  });

  $('#btn-reveal').addEventListener('click', e => {
    view.debugReveal = !view.debugReveal;
    e.currentTarget.classList.toggle('active', view.debugReveal);
    view.requestRender();
  });

  // fade all pasted backgrounds on the current composite (undoable)
  $('#btn-clean').addEventListener('click', () => {
    if (explored.isBlank()) { toast('Nothing to clean yet — paste a screenshot first.'); return; }
    snapshotForUndo();
    spinner(true, 'Cleaning the map…');
    // let the spinner paint before the synchronous pixel work blocks the thread
    setTimeout(() => {
      try {
        explored.cleanBackground();
        toast('Map cleaned — backgrounds faded, rooms and names kept.', 'ok', { label: 'Undo', fn: undoLast });
      } catch (e) {
        console.error(e);
        toast('Cleaning failed: ' + e.message, 'error');
      }
      spinner(false);
    }, 30);
  });

  $('#btn-export').addEventListener('click', exportAll);
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', e => {
    if (e.target.files[0]) importAll(e.target.files[0]);
    e.target.value = '';
  });

  $('#btn-help').addEventListener('click', openHelp);
  wireHelpStepper();

  // start the composited map over (e.g. after misaligned pastes) without
  // touching the pins — their pictures, notes and types all stay. The scale
  // calibration is cleared too: a bad calibration may be exactly why the
  // map needs redoing, and the first fresh paste re-measures it anyway.
  $('#btn-clear-map').addEventListener('click', async () => {
    if (!await confirmDialog('All pins (with their pictures and notes) are kept.',
      { title: 'Erase the revealed map?', okLabel: 'Clear map' })) return;
    snapshotForUndo();
    explored.clear();
    learnedScale = null;
    scaleTrusted = false;
    scaleSamples = [];
    store.putMeta('fog', null);
    store.putMeta('scale', null);
    store.putMeta('scaleTrusted', false);
    store.putMeta('scaleSamples', []);
    toast('Map cleared — pins kept. Paste screenshots to rebuild it.', 'ok', { label: 'Undo', fn: undoLast });
  });

  $('#btn-reset').addEventListener('click', async () => {
    if (!await confirmDialog('This erases ALL revealed map and pins. Consider exporting a backup first.',
      { title: 'Reset everything?', okLabel: 'Reset everything' })) return;
    await store.clearPins();
    await store.clearMeta();
    clearHeldShot({ persist: false }); // its key went with clearMeta
    pins.removeAll();
    explored.clear();
    lastUndo = null;
    setCustomCategories([]);
    setOrder([]);
    pins.filter = new Set(categories().map(c => c.id));
    soloReturn = null; soloedId = null;
    persistFilter();
    renderCatList();
    toast('Everything reset.');
  });
}

// -------------------------------------------------------------------- init

async function init() {
  // which game are we mapping? Everything below (pins, map, pin types,
  // calibration) is stored per game — see store.js.
  await loadGames();
  game = gameById(await currentGameId());
  setStoreGame(game.id);

  if (game.builtin) {
    mapImage = await loadImage('assets/map.png');
    world = { width: mapImage.width, height: mapImage.height };
  } else {
    world = { width: game.w, height: game.h };
  }
  explored = new Explored(world.width, world.height);
  // the background fade only knows what Silksong's map looks like — a game
  // added by hand keeps its screenshots exactly as they were taken
  explored.fadeBackground = !!game.builtin;
  if (mapImage) explored.setReference(mapImage); // guides the bg fade (never shown)
  view = new MapView($('#map-canvas'), world, explored, mapImage);
  view.onPlacementChanged = updatePlaceSize;

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
      ensureCatVisible(data.cat);
    },
    onDelete: async data => {
      if (!await confirmDialog('This removes the pin and its attached picture.',
        { title: 'Delete this pin?', okLabel: 'Delete' })) return;
      pins.remove(data.id);
      store.deletePin(data.id);
    },
  });

  explored.onChange = () => { view.requestRender(); saveFog(); updateEmptyHint(); };
  view.onViewChanged = () => { pins.syncPositions(); positionEmptyHint(); saveView(); };

  // restore saved state
  learnedScale = (await store.getMeta('scale')) || null;
  scaleTrusted = !!(await store.getMeta('scaleTrusted'));
  scaleSamples = (await store.getMeta('scaleSamples')) || [];
  const savedFog = await store.getMeta('fog');
  if (savedFog) await explored.loadFromBlob(savedFog);
  const savedHeld = await store.getMeta('heldShot');
  if (savedHeld) setHeldShot(savedHeld, { persist: false });
  const savedView = await store.getMeta('view');
  if (savedView) {
    view.scale = savedView.scale;
    view.ox = savedView.ox;
    view.oy = savedView.oy;
    view.requestRender();
  }
  for (const p of await store.getAllPins()) pins.add(p);

  // restore the show-done preference before the first filter pass
  const savedShowDone = await store.getMeta('showDone');
  if (savedShowDone != null) {
    pins.showDone = savedShowDone;
    $('#show-done').checked = savedShowDone;
  }
  // restore which types are checked (visible)
  const savedFilter = await store.getMeta('catFilter');
  if (Array.isArray(savedFilter)) {
    const valid = new Set(categories().map(c => c.id));
    pins.filter = new Set(savedFilter.filter(id => valid.has(id)));
  }
  pins.applyFilter();

  // restore sidebar width + map opacity
  const savedW = await store.getMeta('catBarWidth');
  if (savedW) $('#cat-bar').style.width = savedW + 'px';
  const savedOpacity = await store.getMeta('mapOpacity');
  if (savedOpacity != null) { $('#opacity-range').value = savedOpacity; applyMapOpacity(savedOpacity); }

  buildToolbar();
  applyGameChrome();
  if (game.builtin) loadLabels(); // warm the area-name table for OCR matching
  updateEmptyHint();

  if (!savedFog && !(await store.getMeta('helped'))) {
    openHelp();
    store.putMeta('helped', true);
  }

  // debug / testing hooks
  window.__ssmc = {
    view, explored, get pins() { return pins; }, mapImage, world,
    get game() { return game; },
    handleImageBlob: (blob, type) =>
      type === 'map' ? handleMapScreenshot(blob)
      : type === 'env' ? handleEnvScreenshot(blob)
      : type === 'place' ? handleManualPlace(blob)
      : handleFullMap(blob),
    routePaste,
    undoLast,
  };
}

init().catch(err => {
  console.error(err);
  toast('Failed to start: ' + err.message, 'error');
});
