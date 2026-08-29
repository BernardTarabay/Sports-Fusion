# Sports Fusion — frontend

The player-facing surface and the admin command centre.

```bash
npm install
npm run dev              # http://localhost:5173, mock backend
npm run build            # production build
VITE_USE_MOCK=false npm run build   # build against the real API
```

`/api` is proxied to `http://localhost:4000` in development, so the session cookie is
same-origin and nothing is ever tempted to put a token in `localStorage`.

---

## The stack, and why each piece is here

Versions were checked against the npm registry rather than recalled, because three of the
obvious choices turned out to be stale or pre-1.0.

| | Why |
|---|---|
| **React 19 + Vite 8** | Vite 8 runs Rolldown; the whole app builds in ~450ms. Note `manualChunks` must be a *function*, not a map. |
| **React Router 8** | Declarative routing, route-level code splitting. No SSR need — this is a cookie-authenticated app behind a separate Express API, so Next.js would add a second server for nothing. |
| **TanStack Query 5** | Server state. Query keys are centralised in `hooks/index.js` so a mutation invalidates exactly what changed — that is how a roster avoids saying 21/22 right after you joined. |
| **Tailwind 4** | CSS-first config. The whole design system is `@theme` tokens in one file. |
| **Radix** (dialog, tabs, tooltip) | Focus trapping and ARIA wiring for dialogs is precisely what you should not hand-roll. Three packages, not the whole suite. |
| **sonner** | Toasts. Small, maintained, good defaults. |
| **react-hook-form + zod** | Form validation. Lazy-loaded with the auth routes, so the 28KB never touches first paint. |
| **lucide-react** | Icons, tree-shaken per icon. |

### Four things deliberately *not* installed

**No drag-and-drop library.** `@dnd-kit/core` has not shipped since December 2024,
`@dnd-kit/react` is 0.5.0, and Pragmatic Drag and Drop is built on the HTML5 DnD API,
which does not fire on touch. The team builder is used standing at the side of a pitch on
a phone. Pointer Events handle mouse, touch and stylus in one code path in about eighty
lines — plus a keyboard path (select, then select again to swap) that no drag library
gives you for free.

**No chart library.** Recharts is 7.2MB unpacked. Every visualisation here is a
sparkline, a bar series, a ring, or a rating band — hand-rolled SVG in `components/charts`
costs nothing to ship and gives exact control over the broadcast look.

**No map library.** `components/districts/LebanonMap.jsx` traces the real coastline and
eastern border in SVG, with district shapes tiling it. Leaflet plus tile requests to show
six labelled regions would have been a dependency chosen because maps look impressive —
and a hand-drawn outline is both lighter and more distinctly Sports Fusion.

**No animation library.** `motion` was installed, then removed: every transition in the
app turned out to be CSS — card entrances, pitch markers building position by position,
capacity meters filling, the team-generation sequence. That is 21.7KB gzipped saved off
first paint, and the compositor runs it off the main thread.

---

## Bundle

**162 KB gzipped on first paint**, of which React is 69 KB. The matchday workspace —
pitch, controls, assistant — is a 18 KB gzipped route chunk.

Everything else is split by route: the landing page does not download the team builder,
and a player on a phone never pays for the admin analytics.

The mock backend is a **dynamic** import. It used to be static, which meant the 140-player
fixture shipped to production even with `VITE_USE_MOCK=false` — caught by grepping the
built bundle for a fake venue name. Two pages were also importing constants *from* mock
modules, which dragged the same fixture in; those now live in `lib/catalogue.js`.

Verify it stays out:

```bash
VITE_USE_MOCK=false npm run build && grep -rl "Byblos Sporting" dist/assets/*.js
```

---

## Design system

`src/styles/index.css` — one file, two moods.

**Light** is daytime admin: clean, high contrast, gets out of the way.
**Dark** is match night. Not "everything is black": the base is a green-black `#0A0F0D`
borrowed from a floodlit pitch, surfaces lift with light rather than grey, and a
`--floodlight` radial wash sits behind hero sections. The accent brightens from `#009E57`
to `#00C06A` in the dark so it holds its weight.

Colour is meaning, never decoration:

- **Green** is the pitch — availability, confirmation, identity.
- **Amber** is the trophy — MOTM, achievements, records. Used sparingly, because if
  everything is gold nothing is.
- **Red** is urgency — almost full, cancelled, destructive.

Components reference semantic tokens (`--bg-surface`, `--fg-secondary`, `--accent`), never
the raw scale, so a theme change is one file. Three theme states, not two: light, dark, and
follow-the-system, which is the default — someone whose phone goes dark at sunset expects
this to as well, and this app is used at 9pm.

Type is **Barlow Condensed** for anything a broadcast graphic would set (scores, team
names, stat numbers) and **Inter** for everything a person reads. All changing numbers are
tabular so counters and scorelines do not jitter.

---

## The pitch

Two of them, for two jobs.

`components/football/FootballPitch.jsx` is the read-only pitch on public game pages.
`components/football/MatchPitch.jsx` is the operational one described under
[the matchday workspace](#the-matchday-workspace): formation-driven, payment-aware, and
draggable.

Positions are percentages of a half-pitch; one formation map drives every team size and
the two sides mirror around halfway. Nothing is hard-coded to 11-a-side. Desktop shows
both halves side by side like a tactical board; mobile stacks them vertically — not a
fallback, a better use of a tall screen.

An SVG of dots means nothing to a screen reader, so the same team sheet is also rendered
as an ordered list (`GK — Nabil Douaihy (rating 7.2)`), which is what assistive tech reads
and what prints for the touchline.

---

## Architecture

```
src/
├── api/            client.js (fetch + error mapping) · services.js (the ONLY file that
│   └── mock/       knows mock vs real) · mock backend with realistic seed data
├── ai/             tools.js (registry + LLM schema) · interpreter.js (dev stand-in)
├── components/     ui · football · matchday · ai · districts · rankings · games ·
│                   players · teams · rewards · charts · admin
├── pages/          public, player, matchday, and admin routes
├── layouts/        AppLayout (bottom nav on mobile) · AdminLayout (denser, quieter)
├── hooks/          server state + query keys, countdown, count-up, copy, media queries
├── state/          session (httpOnly cookie) · theme
└── lib/            cn, format, catalogue, formations
```

No component fetches. Everything goes through `api/services.js`, so swapping the mock for
the real backend is one environment variable and zero component changes. Route paths there
already match the real Express API.

### Auth

The backend issues httpOnly cookies. There is deliberately no `setToken()` to reach for.
`credentials: 'include'` on every request; JavaScript never sees the token.

Role awareness in the UI is **UX only** — it hides a nav link that would 403 anyway. Every
admin route re-checks on the server. Anyone can edit `roles` in devtools and all they get
is a broken link.

### Errors

The API client maps stable machine codes to human copy in one place. `GAME_FULL` becomes
*"This game just filled up. You can join the waiting list instead."* No raw API error ever
reaches a person.

---

## The matchday workspace

**The game is the application.** An admin signing in lands on `/admin`, which *is* the
pitch for the fixture happening next — no dashboard in front of it, no district to pick
first. `/matchday` with no id resolves the relevant game itself: in progress, else next
upcoming, else most recent.

### What lives on the pitch

Every marker carries the operational truth, so nothing needs a second screen:

| On the marker | Why there |
|---|---|
| Dashed red ring | Not paid — reads across 22 markers on both team colours |
| Green badge | Goals, the number updated most during a match |
| Amber badge | Match rating |
| Number + surname | Identity at a glance |

Tapping one opens the player control panel: payment as the top button, goals and assists
as 56px steppers, a rating slider, MOTM, and removal. One sheet, no navigation.

Teams and roster are separate projections on the server, so the page marries them —
otherwise a marker knows a player's rating but not whether they have paid, which is the
one thing this screen exists to show.

### Temporal navigation

A date rail of every fixture, past and future, in one sequence. Arrow keys move between
games; the rail scrolls and snaps on touch; the selected fixture scrolls itself into view
when the AI or a keystroke changes it.

### Formations

`lib/formations.js` is a reusable slot system — nine shapes at 11-a-side, plus sets for
5, 6, 7, 8, 9 and 10. A formation is a list of slots with a role and a half-pitch
coordinate; adding 3-4-2-1 is one entry and no component changes.

Switching formation **refits both sides**, keeping anyone whose slot survives where they
are. An admin who has hand-placed nine players does not lose that by trying a shape.

### Creating games

`/admin/games/new` is one form with two modes, because the fields are nearly identical
and an admin arriving there wants one of two things:

- **One-off** — a single fixture, for a friendly or to replace a cancelled night. Can be
  saved as a draft nobody can join yet, because a pitch is often booked before it is
  announced.
- **Repeats weekly** — writes a *schedule* rather than a game. That is the point of having
  schedules: nobody should be recreating Sunday every Sunday.

Both preview exactly what will be created before you commit, and the weekly mode lists the
first five fixtures the rule produces. Venues filter to the chosen district, and a
capacity larger than the venue usually holds is flagged without being blocked — the admin
knows their pitches better than the record does.

Creating a one-off lands you on **the new game's pitch**, not back on a list. The game is
the application.

### Drag, and undo

Pointer Events, not a library — the research is in the header of `MatchPitch.jsx`.
Re-checked at build time: react-dnd last published 2022, `@dnd-kit/core` Dec 2024,
`@dnd-kit/react` still 0.5.0, Pragmatic DnD is built on HTML5 DnD which does not fire on
touch, and `@neodrag/react` (the one genuinely good option) does free positioning with no
drop targets — which is the entire problem here.

Drop targets are the formation slots themselves. They appear only while dragging, so the
pitch stays clean, and hit testing is in viewBox space so it survives any scale.

**Undo** covers every path that reshapes the teams — a drag, a formation change, a
regenerate — via a ten-deep stack of raw `game.teams` snapshots. There is a button, a
`Ctrl/Cmd+Z` shortcut, and an inline **Undo** on the toast that confirms each move, which
is the fastest correction because you do not have to go looking for it. The stack clears
when the fixture changes, so undo can never apply one game's teams to another.

### Attendance

The default is **everyone turned up** — matching the backend, where a result posted
without an attendance list assumes a full roster. The panel leads with a single
**"Everyone was here"** button and the admin then flags the two or three exceptions,
rather than confirming twenty-two people one at a time.

Three states per player — **Here / Late / No show** — as a radio group, so a screen reader
announces the current one and tapping the active state clears it back to unrecorded. The
header reads `20 here · 1 late · 1 no-show`, and unrecorded players are counted separately
from present ones, because "not yet asked" and "did not come" are different facts and only
one of them should touch a reliability score.

It lives in three places, all on the same service call:

- The game's **Players** tab, next to the waiting list, for recording the whole roster.
- The **pitch control panel**, directly under the payment button — the admin is already
  tapping a player there to mark them paid.
- The **assistant**: *"everyone turned up"*, *"Karim was late"*, *"Sami didn't turn up"*.
  Low risk, so it executes without a confirmation gate, and it is reversible.

A search box appears once the roster passes ten, and before kickoff the panel says so
rather than pretending attendance is knowable yet.

`/admin/players` is the aggregate view: a reliability bar per player and a sort across
**Rating / Reliability / No-shows**. Players with fewer than three games sort last instead
of showing a meaningless 100% — a single appearance is not a reliability record.

---

## The assistant

Not a chatbot. It runs the same tools the buttons run, through the same service layer,
under the same authorisation.

```
admin message → intent → tool + args → services.js → API → database
```

`ai/tools.js` is the registry: name, description, parameters and a **risk level**. It is
also the schema an LLM receives, so the contract cannot drift from what the UI implements.

**Low risk executes. High risk asks.** "Cancel the game, the venue is unavailable" parses
the reason, executes nothing, and renders:

```
CANCEL THIS GAME?
Beirut · Tonight 9:00 PM
22 registered players
Reason: Venue unavailable
[ No, stop ]  [ Cancel the game ]
```

**Every mutation is audited** — tool name, summary, actor, timestamp, "via assistant" —
readable from the panel's history tab. An AI that can change production data invisibly is
not acceptable.

It knows what is on screen, so "mark everyone paid except Nabil" needs no game named.

> `ai/interpreter.js` does not exist in production. There, the message goes to the backend,
> which calls Gemini with `toolSchema` and the game context and returns a tool call. The
> interpreter is a deterministic stand-in so the whole loop is demonstrable without an API
> key; swapping in the real model changes one function.

---

## Also new

- **Recurring schedules** (`/admin/schedule`) — define "every Sunday 9pm at Jounieh" once.
  Each rule shows the next five fixtures it produces.
- **Man of the Month** — leads the rankings page, with the reward and previous winners.
- **A real Lebanon map** — the outline follows the actual coastline and eastern border,
  with district shapes tiling it and roadmap districts shown dimmed. Not an abstract blob;
  Lebanese players would spot the difference immediately.
- **Game lifecycle rail** — Scheduled → Registration → Full → Teams ready → In progress →
  Completed, with cancellation as a distinct state.

---

## Audit findings



Everything below was found by running the app, not by reading it.

| Found | Fix |
|---|---|
| Stat counters stuck at 0 | `requestAnimationFrame` does not fire in a hidden or non-composited tab, so a page opened in a background tab never animated. Now snaps to the value, with a timeout guard. |
| Leaderboard read as broken: 8.1, 7.7, 8.3 | Ranked by confidence-adjusted rating but *displayed* the raw one. Now the pool is filtered to players the system knows, then ordered by the number shown. |
| "You're in" above a "Sign in to join" button | The mock reported registration state without a session. Now gated, matching the real API. |
| `BLACK 16993.9 v WHITE 17028.2` | Raw summed Glicko leaking into the admin UI. Now `74.6 v 75.0` on the same 0–10 scale as the player cards. |
| 140 fake players in the production bundle | Mock made a dynamic import; shared constants moved out of mock modules. |
| `motion` shipped but never used | Removed. −21.7 KB gzipped. |
| Every past game seeded at 100% occupancy | Flattened the analytics the admin dashboard exists to surface. Now varied. |
| `useState(() => …)` used as an effect in two places | Ran during render and never cleaned up. Now `useEffect`. |
| Pitch markers were **11×14px** on a phone | The interaction this screen exists for was unusable. Pitch now renders **portrait** on mobile (343×566 rather than 343×242) with transparent hit areas — markers are 32×32. |
| Team strength shown as `16993.9 v 17028.2` | Raw summed Glicko leaking into the admin UI. Now `74.6 v 75.0` on the same scale as the player cards. |
| Pitch markers had no payment state | Teams and roster are separate projections; the pitch never received `paid`. Now merged at render. |
| AI missed "Who hasn't paid?" | Phones insert a typographic apostrophe (U+2019); the patterns only matched the straight one, so it fell through to *mark paid*. Now normalised. |
| "Mark everyone paid except Nabil Douaihy" excluded **two** Douaihys | Surname matching over-matched when a full name was given. Full-name matches now win outright — over-matching a payment is a real mistake with no visible trace. |
| Matchday action buttons at 32px | Pressed with a thumb, outdoors, in the dark. Now full size. |
| **Pitch markers flew in from the pitch corner** | For SVG, the `transform` presentation attribute and the CSS `transform` property are the same property — and CSS wins. A `scale()` entrance keyframe on the positioned `<g>` wiped out its translate for the whole animation. Position and animation now live on separate groups. Affected both pitches. |
| `pointerup` read the drop target from inside a state updater | Nested `setHoverSlot` inside a `setDrag` updater to get current values. Updaters must be pure and React runs them twice in StrictMode, so a drop could fire twice or not at all. Now a ref. |
| Attendance mutations succeeded but the UI never moved | The toast fired, the request resolved, and the count stayed `0 here · 22 not recorded`. The mock mutates roster entries in place and `publicGame` returned a shallow `{...g}` — so the `roster` array came back with the same reference and the same objects inside it, and every `useMemo` keyed on it skipped. A real HTTP response is fresh JSON every time; the mock now clones its nested collections, at the boundary rather than in the components. |

**Verified working:** landing, games grouped by day, game detail, districts with the
Lebanon map, leaderboards with Man of the Month, rewards, login → **admin lands on the
pitch**, the 20-fixture timeline, all nine formations, score control, payment rings,
waitlist, team generation, attendance (bulk, per-player exceptions, and clearing back
to unrecorded), reliability sorting, and the assistant end to end — question, mutation, high-risk
confirmation, decline, and audit trail. Zero console errors on a clean load.

**Responsive:** no horizontal overflow at 320px or 375px. On mobile the matchday pitch
turns portrait (343×566) and every button clears 36px. The 22 pitch markers sit at 32×32
with transparent hit areas — under the 44px ideal, but they are dense tactical elements
with generous spacing, and the alternative is a pitch too small to read.

> One caveat on the console: `useSession must be used inside a SessionProvider` appears in
> a tab that has accumulated Vite Fast Refresh updates, and the devtools buffer keeps it
> across reloads. Verified three times in clean tabs with a live `error` listener: nothing is
> thrown on a fresh load. An HMR artifact, not a bug in the provider tree.

---

## Not done

- **Pair-history insight** — `PlayerControlPanel` renders it and the service exists
  (`matchdayService.pairHistory`), but nothing fetches it yet, so the panel never shows it.
- **Redo.** Undo is one-directional; there is no redo stack.
- **Editing an existing game** — date, venue and capacity cannot be changed after creation.
- **Real share-image generation.** The shareable player and match cards are components
  designed to be screenshotted; rendering them to PNG server-side is not wired up.
- **Internationalisation.** No hardcoded RTL-hostile layouts (logical spacing, no
  left/right-only assumptions), but no i18n framework and no Arabic or French copy.
- **`useMyGames`, `Segmented` keyboard arrow navigation, and the notifications surface**
  are built but not yet reachable from any screen.
