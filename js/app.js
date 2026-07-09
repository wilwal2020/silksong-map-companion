import { Explored } from './explored.js';
import { MapView } from './mapview.js';
import { store } from './store.js';
import { locate, detectPlayerMarker, MARKER_MAP_HEIGHT } from './match.js';
import { ocrLocate, loadLabels } from './ocr.js';
import { PinManager, SVG } from './pins.js';
import {
  categories, catById, customCategories, currentOrder, isCustom,
  setCustomCategories, addCustomCategory, removeCustomCategory, updateCustomCategory, setOrder,
} from './categories.js';

const $ = s => document.querySelector(s);

let view, explored, pins, mapImage;
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
    undoLast();
  }
});
$('#btn-await-skip').addEventListener('click', () => skipAwaitingEnv());
$('#dlg-await').addEventListener('cancel', e => { e.preventDefault(); skipAwaitingEnv(); });

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
    // inline "create a new type" — opens the type dialog on top and selects it
    const add = document.createElement('button');
    add.className = 'cat-btn cat-btn-new';
    add.innerHTML = `<span class="cb-ico">＋</span><span>New type…</span>`;
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
  bitmap.close?.();

  const data = {
    id: crypto.randomUUID(),
    x: rect.x + (marker ? marker.fx : 0.5) * rect.w,
    y: rect.y + (marker ? marker.fy : 0.5) * rect.h,
    cat: 'other', note: '', done: false, img: null,
    created: Date.now(),
  };
  lastUndo.pinId = data.id;
  pins.add(data, { select: true, pop: true });
  pins.lastPlacedId = data.id; // don't let a paste right after placing attach to it
  persistPin(data);

  // straight to the editor — its picture slot takes the paste, so there's no
  // separate "add a picture" step
  const edit = await openPinEditor(data, true);
  if (edit) {
    data.cat = edit.cat;
    data.note = edit.note;
    pins.update(data);
    persistPin(data);
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
async function tryOcr(bitmap, full, scaleHint) {
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

    let snapped = await locate(bitmap, mapImage, mode, prog, { rect: r, spread });
    let usedSpread = spread;
    if (snapped && snapped.sparse) return sparseResult();
    if (!snapped) {
      // one retry. With a content-verified scale the failure is almost
      // always POSITION (an imprecise OCR anchor), so widen the search
      // window and keep the scale pinned; without a trusted scale, widen
      // the scale band instead (stale save, resolution change).
      const retry = scaleTrusted
        ? { rect: r, spread: 'narrow', wideWindow: true }
        : { rect: r, spread: 'wide' };
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

  let rect = await tryOcr(bitmap, false, markerScale);

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
  let rect = await tryOcr(bitmap, true, markerScale);

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
  bitmap.close?.();
  view.settleGhost();
  toast('Map updated with everything you have explored.', 'ok', { label: 'Undo', fn: undoLast });
}

let currentPaste = null; // { blob, url } while the type chooser is open

function routePaste(blob) {
  // the pin editor's empty picture slot takes a paste straight away
  if (pinEditorAttach && document.querySelector('#dlg-pin[open] #pin-shot .no-env')) {
    pinEditorAttach(blob);
    return;
  }
  // don't intercept pastes while choosing a pin type / editing a custom type
  if (document.querySelector('#dlg-pin[open], #dlg-cattype[open]')) return;
  // only a pin explicitly waiting for its picture (its 📷 button) takes a
  // paste directly — everything else goes through the chooser, so pasting a
  // map screenshot is never silently swallowed as a pin's area image
  if (pins.awaitingId && $('#dlg-await').open) {
    attachToAwaiting(blob);
    return;
  }
  // ...except when the pointer is on a pin card's empty screenshot square
  // RIGHT NOW (live :hover check — tracked hover state went stale when the
  // card moved under a zoom or pan and swallowed unrelated pastes)
  const hoverSquare = document.querySelector('.pin-card .no-env:hover');
  const hoverEntry = hoverSquare && pins.pins.get(hoverSquare.dataset.pinId);
  if (hoverEntry) {
    const fromRect = hoverSquare.getBoundingClientRect(); // capture before update rebuilds the card
    hoverEntry.data.img = blob;
    pins.update(hoverEntry.data);
    persistPin(hoverEntry.data);
    flyImageToPin(blob, hoverEntry, fromRect);
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
  if (!await confirmDialog('Importing replaces your current map progress and pins. Continue?',
    { title: 'Import backup?', okLabel: 'Import', danger: false })) return;

  await store.clearPins();
  pins.removeAll();
  explored.clear();
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
      if (e.target.checked) pins.filter.add(c.id);
      else pins.filter.delete(c.id);
      soloReturn = null; soloedId = null;
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
  updateCatCounts();
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
      else list.appendChild(row);
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

function onPlacingMove(e) {
  if (!ghostPin) return;
  // over the Cancel button the ghost fades out (and smoothly back on leave)
  ghostPin.classList.toggle('ghost-hidden', !!e.target.closest('#btn-add-pin'));
  ghostPin.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
}

function onPlacingClick(e) {
  // clicks on chrome (toolbar, sidebar, dialogs, sliders) don't place a pin
  if (e.target.closest('#toolbar, #cat-bar, #map-opacity, dialog, .toast')) return;
  e.preventDefault();
  e.stopPropagation();
  const m = view.screenToMap(e.clientX, e.clientY);
  stopPlacing();
  createManualPin(m.x, m.y);
}

function startPlacing() {
  if (placing) return;
  placing = true;
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
  toast('Click the spot on the map to drop your pin. Esc to cancel.');
}

function stopPlacing() {
  if (!placing) return;
  placing = false;
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
}

async function createManualPin(x, y) {
  const data = {
    id: crypto.randomUUID(),
    x, y, cat: 'other', note: '', done: false, img: null,
    created: Date.now(),
  };
  pins.add(data, { select: true });
  pins.lastPlacedId = data.id;
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
  const s = view.mapToScreen(mapImage.width / 2, mapImage.height / 2);
  el.style.left = s.x + 'px';
  el.style.top = s.y + 'px';
}

// the help dialog is a one-at-a-time stepper (Back / Next, Next -> "Got it"
// on the last slide closes it)
let helpGoto = () => {};
function wireHelpStepper() {
  const dlg = $('#dlg-help');
  const slides = [...dlg.querySelectorAll('.help-slide')];
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

// ----------------------------------------------------------------- toolbar

function buildToolbar() {
  renderCatList();
  $('#btn-cat-all').addEventListener('click', () => {
    for (const c of categories()) pins.filter.add(c.id);
    soloReturn = null; soloedId = null;
    pins.applyFilter();
    syncAllRows();
    persistFilter();
  });
  const tip = emojiKeyboardTip();
  $('#pin-note-hint').textContent = tip;
  $('#cattype-hint').textContent = tip;
  $('#btn-add-pin').addEventListener('click', () => placing ? stopPlacing() : startPlacing());
  wireSidebarResize();
  wireOpacitySlider();
  $('#btn-cat-new').addEventListener('click', () => { catTypeCreatedCb = null; openCatTypeDialog(); });
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
    pins.removeAll();
    explored.clear();
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
  loadLabels(); // warm the area-name table for OCR matching
  updateEmptyHint();

  if (!savedFog && !(await store.getMeta('helped'))) {
    openHelp();
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
