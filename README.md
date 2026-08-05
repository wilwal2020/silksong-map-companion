# Silksong Map Companion

A fog-of-war map tracker for **Hollow Knight: Silksong**. The world map starts
completely hidden — you reveal it by pasting screenshots of your own in-game
map, and drop pins on the places you want to come back to, each with a picture
of what's actually there.

No accounts, no server, no build step: everything runs in your browser and is
stored locally.

## How to use it

1. **In game:** open your map and screenshot it (`Shift + Win + S` and snip
   just the part you care about works great). Keep at least one **area name**
   ("Bone Bottom", "THE MARROW"…) in frame — the site reads that name to place
   your screenshot.
2. **On the site:** press `Ctrl+V` (or drag the image in). A chooser asks what
   you pasted, with two options:
   - **📍 Reveal this area, and pin your location** — the site auto-locates the
     screenshot on the world map, reveals that region, and drops a pin. If your
     **player marker** is visible (equip the **Compass** in game), the pin lands
     on your exact spot; otherwise it lands at the area's centre and you drag it
     into place.
   - **🗺 Update your map** — for a zoomed-out shot of a large area or the whole
     world. Reveals everything your map actually shows in one go; only rooms
     drawn on your in-game map appear, so unexplored areas stay hidden. No pin.
3. **Fill in the pin.** Pick a **type** (locked door, NPC/quest, vendor, or your
   own) and write a short note.
4. **Remember what's there.** With a pin's editor open — or while hovering an
   empty pin — paste a screenshot of the actual place (the sealed door, the NPC,
   the ledge you can't reach yet). It's attached to that pin, shown when you open
   it — **scroll over the picture to enlarge it** in place, or click it for the
   full-size lightbox.

   Took that picture *before* you opened the map? Paste it anyway and choose
   **📷 A picture of what's here**. It waits at the bottom of the screen (click
   the thumbnail to check it, ✕ to throw it away, or paste with the pointer over
   it to swap it for another) and the **next pin you add gets it automatically**
   — however that pin is made, and even if you reload in between. No second trip
   into the game.
5. **Came back and dealt with it?** Open the pin and check it off as done.

Pins, the revealed map, and your custom types all persist automatically in the
browser's IndexedDB. `Ctrl+Z` undoes the last paste (or the last pin move).

## Other games

Silksong is the game that ships with a reference world map, which is what makes
automatic placement possible. You can add **any other game** from the title in
the top-left: click it, pick **＋ New game…**, give it a name, an emoji and a
world size. Each game keeps its own map, pins, pin types and backups — switching
between them reloads the page and nothing is shared.

A game you add has no reference map to match against, so you place screenshots
yourself:

1. Paste as usual — nothing asks what you pasted here. The screenshot appears
   **under your mouse pointer**, so point roughly at where it belongs before
   pasting and it starts there. (Pasting a *picture of a place* instead? Hover
   the **📷 Picture for the next pin** field at the bottom of the screen and
   paste onto that — where you point is the whole answer, so there's no chooser
   to click through.)
2. **Drag** the screenshot where it belongs. `Shift`+scroll (or the − / +
   buttons) resizes it; arrow keys nudge it one map pixel at a time (`Shift`
   for ten), always snapping onto the map's own pixel grid so an exact fit is
   reachable however you dragged it. A plain scroll still zooms the map, and
   dragging off the screenshot still pans. `Ctrl+Z` steps back through where
   the screenshot has been — each drag, nudge, resize or auto-align is one
   step, and it undoes the *screenshot's* moves, never the previous paste.
3. Press **Place it**, then click **your player's spot** on the map to drop a
   pin there — or **Skip**. Dragging the map to look around first is free: only
   a click drops the pin, a pan never does.

   For a screenshot that's only more map — no player in it, nothing to mark —
   press **No pin** instead of **Place it**. Same button, minus the step.

Once there's something on the map to line up against, alignment is handled for
you where it can be:

- **On paste**, it immediately tries to line the screenshot up with what's
  already there. Point roughly at the right spot and it arrives exactly right —
  the step bar says so, and there's nothing to do but confirm. It searches
  closely around where you pointed and more coarsely out to about 1.5
  screenshot-widths. Beyond that it stays put rather than guessing; drag it
  nearer and press **Auto-align**. If it ever guesses wrong, `Ctrl+Z` puts it
  back where you dropped it.

  It does not need the screenshot to match what's on the map everywhere — only
  where the two actually overlap. Adding a screenshot of a big newly-explored
  region that touches your existing map along one edge works fine; the new
  ground has nothing to disagree with.
- **Auto-align** runs the same search again once you've dragged it closer.
- **Difference** (or `D`) draws the screenshot as its difference against the
  map underneath, so everything that already matches cancels to black. Nudge
  until the overlapping part goes dark and it's exactly right.

Neither ever resizes the screenshot: all of a game's screenshots come from the
same in-game zoom, so the size is taken as correct and only the position is
searched, around where you dropped it. If auto-align can't find a fit it says so
and leaves your placement untouched.

Each paste remembers the size you settled on, so after the first screenshot
there's usually nothing to resize. Everything else — pin types, notes, attached
pictures, done-checkoffs, export/import, `Ctrl+Z` — works exactly as it does for
Silksong.

The **background fading** below is the one thing that doesn't carry over:
deciding which pixels are "background" is calibrated on Silksong's own map, and
guessing wrong on a game it has never seen would wreck the screenshot. Your
screenshots composite exactly as you took them (only the snip's edge is
feathered), and **Clean map** isn't offered.

## Map layers

Plenty of games draw more than one map over the same ground — an upper and a
lower floor, an interior, a mirrored world. One composite can't hold that: each
new paste would simply paint over the last. So the map is a **stack of layers**.

**＋ Add map layer**, at the top left just outside the pin sidebar, gives you
another map to paste onto. With more than one, the button becomes a small panel
listing them:

- Click a layer to **open** it. It comes to the front at full strength and the
  others stay drawn behind it, dimmed — which is the point: the dim one is what
  you line the bright one up against.
- Every layer shares **one coordinate space**, so a spot on one is the same spot
  on all of them. Growing the world grows all of them together.
- A screenshot lands on **the layer you were on when you pasted it**, never on
  whichever one you switch to while dragging it into place. The floating toolbar
  says which (`Onto Upper floor`) and highlights it once the two differ. That's
  what makes "bring the floor below forward so I can see what I'm aligning to"
  a safe thing to do mid-placement.
- **Auto-align** and **Difference** work against the destination layer, not the
  one on top.
- **Pins belong to layers too.** A pin on a layer you're not on is dimmed with
  its map and sits behind the others; hover it and it comes back fully.
- **Clear map** erases only the layer you're looking at (and says so). **Export**
  carries the whole stack, and an import restores it.
- Layers cost memory and drawing time — each is a full-size canvas, redrawn
  every frame. **Halve detail** (below) is the release valve if a stacked map
  starts to feel heavy.
- Layer one is the **base layer** and can't be removed — it's the map every save
  has always been, stored under the same key, so a map made before layers
  existed simply opens as its base layer. Deleting any other layer takes its map
  and its pins with it.

## The toolbar

- **📍 Add pin** — drop a pin by hand: click, then click the spot on the map
  (right-click or `Esc` cancels). Carry it out to the **edge of the screen**
  instead and a grid of slots lights up along the rim: drop it in one and you
  get a **persistent** pin — square, and nailed to the screen rather than to
  the map, so it stays in sight however far you pan. The slots keep clear of
  the buttons, and two pins never share one. The pin's own menu has the same
  switch (**Keep on screen**) for changing your mind either way; moving a
  persistent pin needs no ✓/✗ confirmation, since it can only land in a slot.
- **Halve detail** — redraw the whole map (every layer) at half the size it is
  stored at. Nothing moves: map coordinates are untouched, so pins stay where
  they are and screenshots pasted afterwards are composited at the same reduced
  detail, which means auto-align keeps working exactly as it did.

  Worth doing for two reasons. A composite is a real canvas with a ceiling on
  how big it may get, so a map that has run out of room to grow gets **four
  times the ground back** for one press. And every frame has four times less to
  push around — on a large map with a few layers that is the difference between
  a pan that glides and one that doesn't. Undo, too, since the snapshot taken
  before each paste shrinks with it.

  It cannot be undone — the detail thrown away is gone — so it asks first. Two
  halvings (down to a quarter) is as far as it goes; past that a screenshot
  starts losing the outlines that make it a map.
- **Reveal map** — overlay the reference map to check your alignment (a testing
  aid; it's never part of your saved map). Silksong only — games you add have no
  reference map.
- **＋ Add map layer** (top left, beside the pin sidebar) — see **Map layers**
  above.
- **Lasso** (next to **Add pin**) — draw a loop around anything on the map:
  - Around **part of the map**: the pasted screenshots inside the loop *and* the
    pins standing on them lift off together and drop where you drag them — for
    when two areas you mapped separately turn out to connect, or a chunk went
    down in the wrong place. It behaves exactly like placing a screenshot (drag,
    arrow keys, Difference, `Ctrl+Z`).
  - Around **only pins**: you move just those pins as a group.
  - Either selection can be **🗑 Deleted** instead of moved — erasing that part
    of the screenshots (and any pins on it), or deleting the lassoed pins.

  Every lasso action is one **Undo** away, pin positions and deletions included.
- **Clean map** — fade every pasted screenshot's dark background to black so
  overlapping pastes blend into one seamless map. Room outlines, fills, area
  names and markers are kept; only the background void fades. Undoable.
  Silksong only — see *Other games*.
- **Export / Import** — download or restore a full JSON backup (revealed map +
  all pins with their pictures, notes and custom types). Clearing site data
  erases everything, so export now and then.
- **Clear map** — erase the revealed map but keep every pin. Use it after a run
  of misaligned pastes; the scale calibration resets too and the next paste
  re-measures it.
- **Reset** — erase everything (map and pins). Export a backup first.

On the left, the **Pin types** panel filters which pins show (with **All** /
**Hide all** and a **Show done pins** toggle), and lets you create your own
types — an emoji icon, a colour, and a name. Drag a row to reorder the list, or
press **Clean** to have it sorted for you: the types you have pins for stay
checked at the top, the ones showing nothing drop to the bottom unchecked.
Nothing is deleted, and with done pins hidden a type whose pins are all checked
off counts as empty too. The **map-opacity** slider dims the revealed map while
keeping pins fully visible.

Bottom right, **Background** sets the colour the canvas shows wherever nothing
has been pasted: a colour picker, six presets, and an **Eyedropper** that takes
the colour from anywhere on your screen — point it at a screenshot's own
background and your pastes stop reading as rectangles on a black void. It's per
game, kept across reloads and carried in backups; nothing you've pasted is
touched, so it's free to change back. (The eyedropper is a Chromium feature; in
other browsers the button isn't shown and the picker still works.)

## Running it

It's a static site — no build step.

- Locally: serve the folder with any static server, e.g. `npx serve .` or
  `python -m http.server`, then open it in a Chromium-based browser or Firefox.
- Or use the GitHub Pages deployment of this repo.

Screenshot auto-locating uses a bundled copy of
[OpenCV.js](https://docs.opencv.org/) (`vendor/opencv.js`), loaded on first use,
so everything works offline.

## How the matching works

Locating a screenshot on the world map uses three cooperating signals:

1. **Area-name labels** — region names are drawn at fixed positions and sizes on
   the map. Text lines are detected in your screenshot and matched against
   labels auto-extracted from the reference map: one label gives identity,
   position and scale in a single step (even a partly cut-off name works).
2. **The player marker** — the white Hornet icon has a known map height
   (~43.8 map px), so when it's visible it fixes the screenshot's scale exactly.
3. **Room shapes** — both images are reduced to content masks
   (drawn-vs-background, interiors flood-filled) whose boundaries are
   template-matched multi-scale, coarse-to-fine.

Every result is verified against the room structure and sorted into confidence
tiers: apply instantly, ask yes/no with a preview, or refuse. The heavy image
matching runs in a Web Worker so the UI stays responsive.

## Background fading

When screenshots overlap, each one's dark vignette would otherwise show as
rectangular seams. On paste — and on demand via **Clean map** — the background
is faded to black by flooding inward from the screenshot's edge: everything the
flood can reach is background and fades, everything it can't reach (enclosed
room interiors, outlines, text, markers) is kept. The full reference map is used
only to keep the flood from leaking through a doorway and blacking out a room
interior; it never adds anything you haven't pasted.

## Project layout

- `index.html`, `css/style.css` — shell and styling.
- `js/app.js` — app wiring: paste routing, toolbar, pins, persistence, tutorial.
- `js/match.js`, `js/matchworker.js`, `js/ocr.js` — screenshot location
  (labels, player marker, room-shape matching) and the worker it runs in.
- `js/explored.js` — the revealed-map canvas, compositing, and background fade.
- `js/layers.js` — the stack of map layers (one composite each, one world).
- `js/mapview.js`, `js/fog.js` — pan/zoom rendering and the fog overlay.
- `js/pins.js`, `js/categories.js` — pins and pin types.
- `js/games.js` — the game list (built-in Silksong + your own) and world sizes.
- `js/store.js` — IndexedDB persistence, scoped per game.
- `vendor/opencv.js` — bundled OpenCV.js.

## Credits

- Map image: community-assembled map of Hollow Knight: Silksong. All game
  content © Team Cherry — this is a fan-made tool, not affiliated with or
  endorsed by Team Cherry.
