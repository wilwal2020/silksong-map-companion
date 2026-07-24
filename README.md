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
   it.

   Took that picture *before* you opened the map? Paste it anyway and choose
   **📷 A picture of what's here**. It waits in the bottom-right corner (click
   the thumbnail to check it, ✕ to throw it away) and the **next pin you add
   gets it automatically** — however that pin is made, and even if you reload in
   between. No second trip into the game.
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

1. Paste as usual and choose **🧩 Add this to your map — you place it**.
2. **Drag** the screenshot where it belongs. `Shift`+scroll (or the − / +
   buttons) resizes it; arrow keys nudge it one map pixel at a time (`Shift`
   for ten), always snapping onto the map's own pixel grid so an exact fit is
   reachable however you dragged it. A plain scroll still zooms the map, and
   dragging off the screenshot still pans.
3. Press **Place it**, then click **your player's spot** on the map to drop a
   pin there — or **Skip**.

Once there's something on the map to line up against, alignment is handled for
you where it can be:

- **On paste**, it immediately tries to line the screenshot up with what's
  already there. Drop it anywhere within about half a screenshot of its real
  home and it arrives exactly right — the step bar says so, and there's nothing
  to do but confirm. Beyond that it stays where you dropped it rather than
  guessing.
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

## The toolbar

- **📍 Add pin** — drop a pin by hand: click, then click the spot on the map.
- **Reveal map** — overlay the reference map to check your alignment (a testing
  aid; it's never part of your saved map). Silksong only — games you add have no
  reference map.
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
types — an emoji icon, a colour, and a name. The **map-opacity** slider dims the
revealed map while keeping pins fully visible.

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
- `js/mapview.js`, `js/fog.js` — pan/zoom rendering and the fog overlay.
- `js/pins.js`, `js/categories.js` — pins and pin types.
- `js/games.js` — the game list (built-in Silksong + your own) and world sizes.
- `js/store.js` — IndexedDB persistence, scoped per game.
- `vendor/opencv.js` — bundled OpenCV.js.

## Credits

- Map image: community-assembled map of Hollow Knight: Silksong. All game
  content © Team Cherry — this is a fan-made tool, not affiliated with or
  endorsed by Team Cherry.
