# Playtest presentation

The slide deck for the in-person Playtest product talk. Eleven slides, driven
from the keyboard, with speaker notes and a live window onto the locally running
platform.

This is a **standalone package**. It is not an npm workspace member, it has its
own `package-lock.json`, and it never touches the repository root
`package.json`. Install and run everything from inside this directory.

Content comes from `docs/PRESENTATION.md`. On-slide text lives on the slides;
the talk track lives in each slide's `notes`.

## Install and run

```sh
cd tools/presentation
npm install
npm run dev        # http://127.0.0.1:4190
```

Build and preview the static deck:

```sh
npm run build      # writes dist/
npm run preview    # serves dist/ at http://127.0.0.1:4190
```

Present from `npm run dev` or `npm run preview` — either is fine. Press `f` for
fullscreen once the deck has focus.

## Keyboard

| Key | Action |
|---|---|
| `→` `↓` `Space` `Enter` `PageDown` · click | Next reveal, then next slide |
| `←` `↑` `Backspace` `PageUp` | Previous reveal, then previous slide |
| `Home` | First slide |
| `End` | Last slide, fully revealed |
| `n` | Toggle speaker notes (hidden by default) |
| `Escape` | Close speaker notes |
| `f` | Toggle fullscreen |

Clicking anywhere advances the deck, except on buttons, links and the demo
frame — those carry `data-no-advance`.

## The slides

One file per slide in `src/slides/`. The visible text sits near the top of each
file as plain JSX.

| # | File | Beat |
|---|---|---|
| 1 | `01-does-it-work.jsx` | "Does it work?" |
| 2 | `02-asymmetry.jsx` | Generation is cheap, verification is not |
| 3 | `03-status-quo.jsx` | Four practices today, one line each |
| 4 | `04-dont-make-me-click.jsx` | The humour beat |
| 5 | `05-story.jsx` | Persona · Goal · Assertions · Target |
| 6 | `06-loop.jsx` | The feedback-loop diagram |
| 7 | `07-demo.jsx` | Live platform + the cost line |
| 8 | `08-web-study.jsx` | Web detection study |
| 9 | `09-api-study.jsx` | API detection study and the scope boundary |
| 10 | `10-callback.jsx` | An afternoon vs a study |
| 11 | `11-questions.jsx` | Q&A |

## Editing

Every slide module exports the same four things:

```jsx
export const label = 'why';        // the eyebrow in the top-left chrome
export const fragments = 1;        // extra key presses this slide takes
export default function Slide() {} // the visible content
export const notes = `…`;          // speaker notes, shown with `n`
```

**Change wording** — edit the JSX in the slide file. Line breaks in the big
statements are deliberate `<br />` tags, so you control where a line lands.
Use `<span className="b">` to make a phrase heavy: emphasis in this deck is
carried by weight, never by colour.

**Add a progressive reveal** — wrap the content in `<Reveal at={n}>` and raise
`fragments` to the highest `n` you used. Revealed content already occupies its
space, so nothing on screen jumps when a beat appears.

**Reorder or add slides** — `src/slides/index.js` holds one array; the running
order, the slide numbers and the progress rail all follow it. To add a slide,
copy any existing file, then import it and insert it in that array.

**Restyle** — `src/styles.css` holds the tokens (colours, the two type
families, the stage size) and the shared type roles: `mega`, `statement`,
`headline`, `line`, `sub`, plus `b` / `thin` for weight. The stage is a fixed
1280 × 720 canvas scaled to the window, so every size in a slide file is an
exact, predictable pixel value.

## The demo slide

Slide 7 shows the hosted platform at `http://127.0.0.1:4177`. Start it first,
from the repository root:

```sh
npm run hosted
```

The deck probes that address only when slide 7 becomes active, and mounts the
iframe only if the platform answers — it never preloads, and it unmounts the
frame when you leave the slide. If the platform is not running you get a
placeholder with a **Reconnect** button instead of a broken frame. **Open in new
tab** is always available above the frame, and driving the demo in a real
browser tab is a perfectly good way to present it.

To point the demo somewhere else, edit `TARGET` at the top of
`src/slides/07-demo.jsx`.

## Design notes

The deck is dressed as one of the product's own artifacts. Structural furniture
is set in mono like run output; statements are set in Archivo, with emphasis
carried by weight rather than colour. The two accent colours are semantic, not
decorative: mint is Playtest, ember is the coding agent, and they mean the same
thing on slide 3, slide 6 and slide 8. The progress bar is a trajectory rail —
one segment per slide, the live segment filling as its fragments are revealed.

Fonts (Archivo and IBM Plex Mono, both SIL Open Font License) are bundled in
`src/fonts/`, so the deck needs no network at presentation time.
