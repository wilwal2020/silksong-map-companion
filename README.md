# Silksong Map Companion

A fog-of-war map tracker for **Hollow Knight: Silksong**. The world map starts
completely hidden — you reveal it with screenshots of your own in-game map, and
pin the places you want to come back to, each with a screenshot of what's
actually there.

No accounts, no server: everything runs in your browser and is stored locally.

## How to use it

1. **In game:** open your map at a spot you want to remember and screenshot it
   (`Win+Shift+S` and snip just the map works great).
2. **On the site:** press `Ctrl+V`. Choose **Map screenshot** — the site
   auto-locates it on the world map (edge-based image matching, in-browser),
   shows you the match so you can drag/scroll to adjust, then reveals that
   region and drops a pin. Drag the pin onto your exact spot.
3. Pick a **category** (locked door, needs ability, vendor, bench, boss…) and
   write a short note.
4. **In game:** screenshot the actual place (the sealed door, the NPC, the
   ledge you can't reach yet) and paste it as an **Area screenshot**. Hovering
   the pin now shows it.
5. Came back and dealt with it? Open the pin and hit **✓ done**.
6. Zoom your in-game map all the way out and paste it as **Full map** to update
   everything you've explored in one go — only rooms that are actually drawn on
   your map get revealed, so unexplored areas stay hidden.

Filter pins by category from the toolbar, and use **Export** / **Import** to
back up or move your progress between machines (progress lives in the
browser's IndexedDB, so clearing site data erases it — export now and then!).

## Running it

It's a static site — no build step.

- Locally: serve the folder with any static server, e.g. `npx serve .` or
  `python -m http.server`, and open it in a Chromium-based browser or Firefox.
- Or use the GitHub Pages deployment of this repo.

The screenshot auto-locating uses a bundled copy of
[OpenCV.js](https://docs.opencv.org/) (`vendor/opencv.js`), loaded on first
use — everything works offline.

## How the matching works

Three cooperating signals, tried in order:

1. **Area-name labels** — region names ("Bone Bottom", "THE MARROW"…) are
   drawn at fixed positions and sizes on the map. Text lines are detected in
   your screenshot and matched against labels auto-extracted from the
   reference map: one label gives identity, position and scale in a single
   step (even partially cut-off labels work).
2. **The player marker** — the white Hornet icon is drawn on the map, so its
   pixel height reveals the screenshot's scale exactly (~43.8 map px).
3. **Room shapes** — both images are reduced to content masks
   (drawn-vs-background, interiors flood-filled) whose boundaries are
   template-matched multi-scale, coarse-to-fine.

Every result is verified against the room structure and classified into
three confidence tiers: apply instantly, ask yes/no with a preview, or
refuse. Ctrl+Z undoes the last paste.

## Credits

- Map image: community-assembled map of Hollow Knight: Silksong. All game
  content © Team Cherry — this is a fan-made tool, not affiliated with or
  endorsed by Team Cherry.
