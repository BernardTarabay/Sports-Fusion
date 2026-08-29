# Sports Fusion

Football operations platform. The website is the player-facing surface; the system
underneath runs registration, waitlists, teams, ratings, attendance, rewards and
communication.

A modular monolith: one Node process, one Postgres, one Redis, one worker. At 5,000
players and ~100 games a month this is the correct size. Module boundaries are enforced
by directory and by domain events, not by network calls.

---

## Running it

```bash
npm install
cp .env.example .env          # then set JWT_ACCESS_SECRET and JWT_REFRESH_SECRET
npm run db:up                 # postgres + redis via docker compose
npm run migrate
npm run seed                  # districts, venues, one admin. No players, no games.
```

Set `SEED_ADMIN_PHONE=+9613123456` and the admin can sign in with a WhatsApp code from
the first minute, instead of keeping the generated password around.

```bash
SEED_ADMIN_PHONE=+9613123456 npm run seed
```

The seed loads reference data only — Lebanon's districts, and the three pitches this
community books:

| Venue | District | |
|---|---|---|
| Eleven Football Pro Academy | Keserwan | Zouk Mosbeh · turf · 11-a-side |
| Sports Zone | Metn | Dbayeh · turf · mini pitches |
| Fouad Chehab Stadium | Keserwan | Jounieh · grass · 11-a-side |

No players and no games, though. Those are the admin's real data, and a database
pre-filled with plausible fakes is worse than an empty one — you cannot tell which rows
are yours, and the first real game is buried among invented ones. Venues are the exception
because they are not invented.

### Without Docker

`npm run db:up` needs virtualization enabled in BIOS/UEFI. Where that is not available,
`scripts/dev-db.js` serves the same PostgreSQL — PGlite, real Postgres compiled to
WebAssembly — over a TCP socket, so the backend connects with the ordinary `pg` driver
and cannot tell the difference. Every constraint, trigger, partial index and
`FOR UPDATE SKIP LOCKED` behaves exactly as it does in production.

```bash
npm run db:dev                # port 54329; data persists in database/.pgdata
npm run migrate && npm run seed
```

Two things it will not do. It serves queries one at a time, so `DATABASE_POOL_MAX=1` —
which is a feature during development, because it makes any pool-read-inside-a-transaction
deadlock immediately instead of at production load. And it cannot prove serialisation, so
the concurrency suite still needs a real multi-connection Postgres.

Verify the schema without any daemon at all — applies every migration to an in-process
Postgres and asserts the guarantees hold:

```bash
npm run verify:schema
```

Run the tests:

```bash
npm test
```

Preview the generated WhatsApp announcements:

```bash
npm run announcements
```

---

## Architecture

```
                          SPORTS FUSION
                                |
                +---------------+---------------+
                |               |               |
            WEBSITE          WHATSAPP        SHOPIFY
        source of truth    notifications      commerce
                |               |               |
        registration      1:1 messages     merchandise
        games             reminders        redemptions
        teams             confirmations
        ratings           waitlist promotion
        rewards
```

Three layers, in decreasing order of how much we should trust them:

| Layer | Handles | Why |
|---|---|---|
| **Deterministic code** | registration, waitlist, team generation, rewards, statistics | Correctness is provable and the answer is always explainable |
| **Statistical models** | skill ratings, attendance prediction, demand, churn | Genuine uncertainty that improves with data |
| **LLM (Gemini)** | match summaries, announcements, admin assistant, NL analytics | Language and interpretation only |

Admins override everything. The system recommends; humans decide.

---

## Layout

```
sports-fusion/
├── database/migrations/     numbered .sql, applied once, never edited after the fact
├── backend/src/
│   ├── config/              validated at boot; bad config fails fast
│   ├── database/            pool + transaction helper
│   ├── lib/                 logger, typed errors, domain event publisher
│   ├── modules/             auth, players, games, registrations, teams, ratings, ...
│   └── integrations/        whatsapp, shopify, gemini
├── worker/                  domain event dispatch, notifications, scheduled jobs
├── frontend/                React 19 + Vite 8 player app and admin console (own README)
└── scripts/                 migrate, verify-schema, seed, announcement preview
```

---

## The decisions that matter

### Capacity is enforced by the database

`games.confirmed_count` is trigger-maintained and guarded by
`CHECK (confirmed_count <= capacity)`. Two players tapping JOIN on the last slot at the
same millisecond both update the same `games` row; the second blocks on the row lock,
re-reads, and fails the check.

The application takes the same lock deliberately (`SELECT ... FOR UPDATE`) so the loser
of the race gets waitlist position #1 and a sensible message rather than an error. The
constraint is the seatbelt: no future code path, however buggy, can produce 23 confirmed
players in a 22-player game.

Waitlist promotion happens in the *same transaction* as the cancellation that freed the
slot. If it were a background job there would be a window in which the game shows 21/22
and someone else could take the spot ahead of the person who had been waiting.

### History is append-only

Ratings, points, and match results are ledgers. Nothing a future model will want to
learn from is ever `UPDATE`d in place.

This is what makes deferring the rating engine to V2 free rather than expensive.
Glicko-2 needs only `(roster, roster, outcome, date)` — all of which V1 already records
immutably — so when the rating engine ships it can **backfill the entire rating history
over every game ever played**. V1 seeds ratings by hand; the balancer reads a `mu`/`sigma`
pair and does not care where they came from.

Expensive-to-derive values (`confirmed_count`, `points_balance`, `rating_mu`) are cached
on the parent row by trigger. The ledger stays the source of truth, and
`SELECT * FROM reconcile_game_counts()` proves the cache has not drifted.

### Points are a liability, not a score

Every unredeemed point is a promise against Shopify margin. `point_transactions` carries
a signed `liability_value`, so `SELECT * FROM reward_liability` answers "what do we owe"
in one query. Earn rates and sink prices live in `reward_catalogue` rows, not in code,
because they will need retuning once real margin data exists and that must not require a
deploy.

### Reliability is a view, not a stored score

`player_reliability` is computed on read. The definition can be retuned without a
migration, and no player has a stale judgement stored against their name.

Per the registration policy, reliability does **not** displace anyone from a full game.
It informs waitlist promotion order, reminder aggressiveness, and admin recommendations
only. "The algorithm decided you were unreliable" is not a notification that builds a
community.

### Domain events are a transactional outbox

Events are inserted into `domain_events` in the same transaction as the state change
that produced them, then dispatched by the worker. Either the player is promoted *and*
the notification is queued, or neither happened.

This is the boring, correct version of the thing people reach for Kafka to get.

---

## Team generation

`backend/src/modules/teams/balancer.js`

For 22 players into two 11s there are **C(22,11)/2 = 352,716** distinct splits. Measured:
**113 ms to evaluate every one of them.** So the balancer is exhaustive, not heuristic,
and needs no solver dependency and no job queue.

That buys three things:

1. **Provable optimality** — the best split under the stated objective, not the best one
   a search happened to find.
2. **Explainability** — every candidate carries a score breakdown, so "why is George on
   Black" has an answer with numbers in it.
3. **Variety** — having ranked *all* splits, we deliberately pick from the near-optimal
   shortlist rather than the single optimum. Without this the optimiser finds the same
   answer every week and the league collapses into two fixed teams.

The objective (every term a penalty, lower is better):

```
score = 1.00 x |strength difference|
      + 0.15 x |uncertainty difference|      spread the unknown players evenly
      + 500  x goalkeeper imbalance          effectively a hard constraint
      + 12   x positional imbalance          DEF / MID / FWD
      + 6    x recent-pairing repetition     recency-weighted
      + 25   x relationship violations       declared play-with / avoid pairs
```

**Reproducibility is a first-class requirement.** `team_generation_runs` stores the seed,
the algorithm version, the exact weights, the rating snapshot, and the score breakdown.
Given that row the balancer produces byte-identical teams. Regenerating does not erase
the previous attempt. When an admin asks why a player ended up somewhere, the answer is
a stored breakdown, not a shrug.

Admin overrides are recorded on `team_players` (`is_manual_override`, `moved_from_team_id`).
That is the training signal for inferred relationships: when an admin repeatedly moves
two players together, the system learns a `play_with` preference with `origin='inferred'`,
which is weighted at half the strength of one a player actually asked for.

---

## WhatsApp

The WhatsApp Business Platform is a **1:1 business-to-customer channel. It cannot post
into groups or communities.** Anything that claims otherwise is driving an unofficial
client against a personal account — which risks the number the entire business currently
runs on.

So the integration splits in two:

| | Mechanism |
|---|---|
| **Group announcements** | Generated by `integrations/whatsapp/announcements.js`, copied by an admin, pasted into the existing community |
| **Individual messages** | Sent through the official API — registration confirmed, waitlist promotion, team sheet, reminders |

The admin's job goes from composing and maintaining every message to tapping Copy.

Outbound 1:1 messages must respect the 24-hour customer service window and use
pre-approved templates outside it, and each conversation costs money — `notifications`
records `provider_cost` per message so that spend is visible rather than discovered on
an invoice.

> **Verify against Meta's current documentation before this goes into a commercial
> proposal.** Platform capabilities and pricing change, and quoting a remembered number
> is how a fixed-price contract turns into a loss.

---

## API

All routes are under `/api`. Auth uses httpOnly cookies (`sf_access`, `sf_refresh`), with
`Authorization: Bearer` accepted as a fallback for non-browser clients.

| Method | Route | Who |
|---|---|---|
| `POST` | `/auth/signup` · `/auth/login` · `/auth/refresh` · `/auth/logout` | public |
| `GET` | `/auth/me` | signed in |
| `GET` | `/districts` · `/districts/:id/venues` | public |
| `POST`/`DELETE` | `/districts/:id/follow` | signed in |
| `GET` | `/games` · `/games/:id` · `/games/slug/:slug` | public |
| `POST` | `/games/:id/join` · `/games/:id/leave` | signed in |
| `GET`/`PATCH` | `/players/me` | signed in |
| `PUT`/`DELETE` | `/players/me/relationships` | signed in |
| `POST` | `/games` · `/games/:id/open` · `/games/:id/cancel` | admin |
| `POST` | `/games/:id/teams/generate` · `/games/:id/teams/override` | admin |
| `GET` | `/games/:id/teams/explain` | admin |
| `POST` | `/games/:id/announcement` | admin |
| `PUT` | `/players/:id/rating` | admin |

Admin routes are district-scoped: a `district_admin` for Beirut cannot touch a Keserwan
game. `admin` and `owner` are global.

Errors carry a stable machine code (`GAME_FULL`, `ALREADY_REGISTERED`,
`TOKEN_REUSE_DETECTED`, ...) so the frontend branches on the code, not on English prose a
designer will later rewrite.

### Session security

Access tokens are short-lived JWTs. Refresh tokens are opaque, stored hashed, and rotate
on every use within a *family*. Presenting an already-used token means it was replayed, so
the entire family is revoked and every device in that lineage is signed out.

---

## The worker

```bash
npm run worker          # run continuously
npm run worker:tick     # one pass and exit (cron, CI, debugging)
```

One tick is: **drain events → run due sweeps → send notifications.** That order is
deliberate — both the handlers and the sweeps *queue* notifications, so the sender runs
last or everything they queue waits an extra tick.

### Two dispatchers, two different guarantees

The event dispatcher claims, handles, and marks an event processed **in a single
transaction**. Handlers only write to the database, so a crash rolls the whole thing back
and the event is simply retried. Nothing is dropped and nothing is applied twice.

The notification sender **cannot** work that way — a sent WhatsApp message is not
rollback-able. So it claims (`pending → sending`, committed), sends, then settles. A
worker that dies mid-send leaves a row visibly stuck in `sending`, which `reclaimStale()`
returns to the queue after ten minutes. That risks a duplicate, and that is the right
trade: receiving "you're in" twice is an annoyance, never receiving it means missing the
game.

Both use `FOR UPDATE SKIP LOCKED`, so several workers run concurrently without
double-processing and without blocking each other.

### Idempotency is enforced by Postgres, not by checking first

Check-then-write races. Every automatic side effect is instead guarded by a constraint,
and handlers use `ON CONFLICT DO NOTHING`:

| Guard | Prevents |
|---|---|
| `notifications_dedupe_idx` | A second message for the same (user, channel, template, cause) |
| `point_transactions_once_per_reference` | Awarding the same player twice for one game |
| `game_pair_history_applied` | A replay inflating the balancer's pair counts |

Tested directly: the suite forces every processed event back into the queue — exactly what
a crashed worker does — and asserts that no notification and no point is duplicated.

### Failure handling

Events retry with exponential backoff (30s → 2m → 8m → 32m, capped at 1h) and
dead-letter after 5 attempts, with the error recorded. Notifications distinguish
**permanent** failures (no phone number, unapproved template, 4xx from Meta) from
transient ones — a permanent failure fails immediately instead of burning four retries
and quota.

The failure record is written in a *fresh* transaction after the rollback. Writing it in
the failed transaction would erase the record along with the work, and the event would
retry forever with `attempts` stuck at zero.

### Sweeps, not schedules

Periodic jobs look at current state and make it right, rather than relying on something
having been queued at the correct time earlier. A sweep survives the worker being down
for six hours; a queued timer does not.

| Job | Every | Does |
|---|---|---|
| `queue_reminders` | 5 min | 24-hour and 3-hour reminders for confirmed players |
| `advance_game_lifecycle` | 2 min | Past kickoff → `in_progress` |
| `reclaim_stale_notifications` | 5 min | Returns abandoned `sending` rows to the queue |
| `expire_points` | 1 h | Writes negative ledger entries for expired points |
| `prune_expired_tokens` | 24 h | Housekeeping |

Games are **never auto-completed**. A completed game means a result was recorded, and only
a human knows the score — a game sitting in `in_progress` is a prompt for the admin, not a
gap.

Due-ness lives in the `job_runs` table, not in memory, so several workers do not all run
the same sweep and a restart does not re-run everything at once.

### WhatsApp, again

`worker/src/notifications/templates.js` carries the **approved template name and variable
order** for each message, because outside the 24-hour customer service window the Cloud
API only accepts a pre-approved template — you cannot compose copy at send time. The
`body` field is the human rendering used for in-app, push, and the development log, so the
copy can be reviewed before it is submitted to Meta.

WhatsApp is off by default. Disabled, the adapter logs exactly what it would send with the
number masked, which means the whole pipeline is exercisable with no credentials and no
spend. Business messages also require an explicit `opted_in_at` — absence of a preference
row means *not* opted in, and the suite asserts that a player who never opted in receives
nothing on that channel.

---

## Match results

`POST /api/games/:id/result`

The whole post-match flow is a score line and three taps, because the admin is on the
touchline with 21 people waiting to leave:

```
Black 6 — 4 White
[ MOTM ]  [ Best ]  [ Worst ]
```

Everything else is optional. **Attendance defaults to "everyone confirmed turned up"** and
the admin flags only the exceptions — marking 22 people present is data entry that will
not happen past week three, whereas flagging the two who did not is a five-second job.

Recording a result completes the game and publishes `GameCompleted`, which is what awards
points, records pair history for the balancer's anti-repetition term, and produces the
`(rosters, outcome, date)` tuple Glicko-2 will replay.

Submitting twice is a **conflict, not an overwrite** — a second submission is nearly always
a double tap. Changing a score is a deliberate, separate act.

### Corrections supersede, they never overwrite

`PATCH /api/games/:id/result` requires a reason, marks the previous version
`is_current = false`, and inserts a new row pointing at it. `GET /result/history` returns
every version. When someone disputes a score six months later, the answer is a row.

### Point corrections reconcile to a net position

Attendance gets corrected: someone marked present who never showed, someone marked absent
who did play. The worker does not *add* points — it computes what each player is owed from
the current records, compares it with what has actually been paid, and writes only the
difference:

| Situation | Written |
|---|---|
| Owed, unpaid | The original award |
| Paid, no longer owed | A compensating `correction` row |
| Already correct | Nothing |

`corrects_reason` (migration 012) records which award a compensating row adjusts, so the
net per player per award is one `GROUP BY`. The original award is never edited or deleted,
so a player's points can be explained, not merely stated.

This means an attendance record can be revised repeatedly and always lands on the right
total. The suite proves the round trip: mark a player absent (points come back), reinstate
them (points return exactly once), re-run the event (nothing is written), and move MOTM to
a different player (250 moves across, total unchanged).

### Peer ratings, and the anomaly it is polite about

Players rate each other on structured dimensions — never free text. The brief is "rate
your teammates", not "tell us who was rubbish", and a comment box becomes the latter
within a fortnight.

`GET /api/games/:id/peer-ratings` is **admin-only**. Publishing "your teammates rated you
2.1" is how a community stops being one.

It flags where an award contradicts the consensus — MOTM given to someone the players
rated in the bottom third, or worst player to someone in the top third. That is a prompt
to look, not an accusation: an admin may have seen something the scoreboard did not, or
may be rating a friend, and the numbers say which without the system editorialising. It
stays silent below four raters, because silence is not evidence.

---

## Who can do what

Two roles that matter. An **admin** runs the league. A **player** joins a game, looks at
the stats, and edits their own profile. There is nothing in between and nothing else.

| | Player | Admin |
|---|---|---|
| Join and leave games, see the team sheet | yes | yes |
| Leaderboard and their own profile | yes | yes |
| Create, open, cancel a game | no | yes |
| Start the clock, record goals, take payments | no | yes |
| Generate teams, move players, set formations | no | yes |
| Record or correct a result | no | yes |
| Create players, mint invite links, add venues | no | yes |
| Set anyone's rating, replay the rating engine | no | yes |

`backend/src/authorization.test.js` holds every administrative route in one table and
asserts that a plain player and an anonymous caller are both refused all of them — over
real HTTP, with real cookies, against a real Postgres. It also asserts the mirror, that an
admin *can* reach them, because a guard that refuses everyone would otherwise pass.

It is written as a table rather than as prose tests deliberately. Authorisation
regressions do not arrive as a broken assertion in the route you were editing; they arrive
as a new endpoint nobody remembered to guard. A list makes the omission visible.

The frontend hides what a player cannot use, and that is **presentation only**. Every
guard is re-checked on the server, and the roles come from the database rather than from
anything the client says.

### Making someone an admin

Deliberately not an API. The first admin has to come from outside the application —
otherwise either the app ships with a way to escalate yourself, or the very first person
is stuck with nobody able to promote them.

```bash
node scripts/grant-role.js bernard@example.com admin
node scripts/grant-role.js +9613123456 district_admin metn
node scripts/grant-role.js --list
```

Roles are baked into the access token, so a promotion takes effect on the next sign-in.
There is a test for that, because it is exactly the kind of thing that reads as a bug.

---

## Signing in

A phone number, and six digits on WhatsApp. No password, for anyone who does not want one.

That is not a fashion: the identity in this community *is* the phone number. Everyone is
already in a WhatsApp group, nobody is going to remember a password for a football app,
and half of the sign-ins happen on a borrowed phone at the side of a pitch in the dark.

**A challenge is keyed by the number, not by a user.** When an unknown number asks for a
code there is no account yet, and creating one on request would let anyone fill the users
table by typing numbers — and would leak, through whether the reply said "signing in" or
"signing up", exactly which numbers are registered. The account is created only after a
correct code comes back, and `/auth/phone/start` returns a byte-identical response either
way. Signing in and signing up are the same two taps, which matters because most people
do not know which one they are doing.

```
POST /api/auth/phone/start    { phone }          -> { expiresInSeconds, delivered }
POST /api/auth/phone/verify   { phone, code }    -> session, or NAME_REQUIRED
```

`NAME_REQUIRED` is its own code rather than a generic 422, because it is a branch the UI
must *act* on — it reveals a name field — and the API client replaces server wording with
its own copy, so matching on the message text would silently stop working the day someone
edits a sentence.

**Three defences, at three different layers**, because each one covers what the others
cannot:

| Layer | Limit | Stops |
|---|---|---|
| Per IP | 60 codes / 15 min | Bulk spend from one host |
| Per number | 3 codes / 15 min | Using someone's phone as a message target — an attacker cannot dodge this by changing IP |
| Per challenge | 5 attempts, then burned | Guessing six digits |

The IP ceiling is deliberately loose. Lebanese carriers NAT heavily and the intended use
is a whole squad scanning one QR code on the same venue wifi; a limit tuned for password
guessing would have the twenty-second player locked out by the other twenty-one. The
per-number limit is the one that actually protects a person.

**Admins are not special here.** The seeded account keeps its email and password, and
`/auth/phone/link/start` attaches a number to it — after which an admin signs in the same
way as everyone else, and the roles still come from the database, never from the client.

The code arrives through the WhatsApp Business API directly rather than through the worker
queue. Every other message in the system is queued, and should be. A login code cannot
wait for a tick: somebody is holding a phone looking at an empty six-box input. With
`WHATSAPP_ENABLED=false` the code goes to the log and comes back in the response, so local
development needs no WhatsApp account.

---

## QR onboarding

The bootstrapping problem: an admin has four thousand players spread across WhatsApp
groups and an empty `players` table. Typing them in is not going to happen, and asking
each of them to find a website and register before the first game means there is no first
game.

So the admin generates one link, drops it in the group as a QR code, and each player fills
in their own name and position once. The people who know the data enter the data.

```
GET  /api/join/:token          what am I joining?   (public)
POST /api/join/:token/code     send me a code
POST /api/join/:token/claim    code, name, position -> account + session
```

The token is a **bearer credential** — anyone holding the link can add themselves — so it
is stored hashed and shown exactly once, at creation, the same reasoning as the seeded
admin password. The QR is rendered server-side as SVG, which means the raw token never
needs to leave that one response and the frontend needs no QR library at all. Error
correction level M rather than H: H survives more damage but packs the modules tighter,
and the failure mode here is not a torn poster, it is twenty people photographing a phone
screen across a dark car park.

**The number is verified before any account exists.** `claim` consumes a code first and
creates the player second. Without that, one leaked link plus a script is a few thousand
junk players with plausible Lebanese numbers. `player_invite_claims` records who came in
through which code, so a link that ends up somewhere it should not can be revoked with its
damage visible — and a second scan by the same person does not burn a use.

An invite can be pinned to a game, which drops the player straight onto that roster. That
join runs in its own transaction on purpose: `registerPlayer` owns the capacity race, and
inlining a bare INSERT would skip the waitlist positioning and violate the constraint the
moment a game filled up. It is also best effort — somebody who typed their name in should
not get an error page because the game turned out to be full. They are a player now either
way.

---

## Man of the Month

Derived, never stored. There is no table where somebody writes down who won August; the
answer is computed from what actually happened that month, so it cannot drift from the
record and it corrects itself if a result is corrected later.

**Most man-of-the-match awards that month wins, and average rating breaks the tie.**

Deliberately the simplest defensible rule. A weighted composite is more sophisticated and
much worse here: nobody can check it, and an argument about who deserved it becomes an
argument about a formula that is invisible. *"He was man of the match three times, you
were twice"* ends the argument in one sentence.

Average rating alone would not do either — someone who turns up twice, plays two quiet
games and drifts upward would beat a player who was the best on the pitch four times.
Hence MOTM first, and a minimum of two appearances so one lucky night cannot take a month.

When nobody qualifies the answer is `player: null`, and the card says *"Nobody has claimed
it yet — play 2 games this month to be in the running."* A new league is a real state,
not a reason to invent a winner.

---

## Recurring games

**Games are not created; they are scheduled.** There is one form, on `/admin/schedule`, and
it is the only way a fixture comes into existence.

There used to be two — a "create game" page and a "new schedule" dialog — and having both
was the mistake. They had different fields, and the one an admin reached for first could
not choose a venue at all. Two forms for one job means one of them is always the wrong
one, and it is always the one being used. `/admin/games/new` now redirects.

The single form carries everything: district, venue, day, kickoff, size, length, price per
player, waiting-list depth, how far ahead to create, and whether fixtures open for
registration on creation. Choosing a venue adopts its usual size, because a pitch knows
how many it holds — still a default, still editable.

**"Just once" is a tab in the same form**, for a friendly or a replacement night. It swaps
the weekday for a date, drops the fields that only mean something for a repeating fixture,
and writes a **game** rather than a schedule — a rule that fires once and then sits in the
list forever, pretending to be a weekly commitment, is a rule you have to remember to
delete. Creating one goes straight to its pitch, because it will not appear on this page.


"Every Tuesday at ten in Metn." A schedule is a **rule**, and real games are materialised
from it a few weeks ahead — so moving the fixture to nine o'clock changes one field, and
the games already played keep the time they were actually played at.

The date arithmetic happens in Postgres, deliberately. Lebanon observes daylight saving,
so "Tuesday 22:00 Asia/Beirut" is 19:00Z for half the year and 20:00Z for the other half.
Getting that wrong in JavaScript means every fixture silently shifts by an hour twice a
year; `(date + time) AT TIME ZONE zone` is exactly this calculation with the tz database
behind it.

Generation is idempotent — `games_one_per_schedule_slot` makes a repeat insert a no-op —
so it runs on create, on resume, and on every page load without anyone having to reason
about whether it already ran.

Deleting a schedule keeps the fixtures it already made, as ordinary one-off games. People
have signed up for them, and removing the rule is not a reason to cancel next Tuesday.
Deleting those too is a separate tick in the dialog.

---

## Deleting things

Cancelling and deleting answer different questions, and the app does both.

A game that was **called off** happened: people signed up, arranged their evening, and
were let down, and the reliability numbers depend on knowing that. A game **created by
mistake** — a duplicate, a typo, a test fixture — never happened and should leave no
trace.

One thing stops a delete: whether the record has already moved.

```
DELETE /api/games/:id   ->  409 GAME_SETTLED
"This game has already been rated and paid out, so deleting it would move every
 player's rating with no record of why. Cancel it instead."
```

The schema enforces it independently — `player_ratings.game_id` is `ON DELETE NO ACTION`,
so even a direct `DELETE` from psql is refused. The service checks first only so the
answer is a sentence rather than a foreign-key error. Everything else cascades:
registrations, teams, payments, events, results, invites.

Players follow the same rule and land on the other side of it more often: someone who has
played is **deactivated** rather than deleted, because their rating fed into the balance
of every team they were ever on. The response says which happened. Venues are retired
rather than deleted once they have hosted a game, for the same reason — an old fixture
with no venue is worse than a venue missing from the picker.

Whatever is deleted, the `admin_actions` row is written *before* the row goes, so the
audit trail keeps what was destroyed. It is the only record that survives.

---

## Matchday

What an admin touches while standing at the side of a pitch. `POST /api/games/:id/…` —
clock, payments, attendance, stats, formation, motm, roster — every one of them admin-only
and district-scoped, and every one returning the *complete* matchday state rather than the
field it changed. That costs one extra query and removes a class of bug: the pitch cannot
show a player as paid while the payment rail still says unpaid, because both read the same
response. It also halves the round trips on one bar of signal, which is the real operating
environment.

**The clock is timestamps, not a counter.** A counter has to be written by something, and
whatever writes it drifts on restart, double-counts with two tabs open, and is wrong for
every client that reloads. The server records when each period began; every client derives
the elapsed time itself:

```
elapsed = elapsed_ms_at_period_start + (now − period_started_at) − paused_ms
```

Two phones watching the same match agree because they are reading the same three
timestamps, not because anything is being synchronised. Halftime banks the first half and
stops counting. Stoppages accumulate into `paused_ms`, so an injury does not inflate the
minute a goal is recorded in.

**The clock on screen is derived, not counted.** The component holds no timer state: it
reads the three timestamps and recomputes, so a reload, a second device, or a tab that the
browser throttled to one repaint a minute all agree. It also corrects for a phone whose
own clock is wrong, using `serverNow` — without that, a device five minutes fast shows a
match that kicked off in the future and sits at 00:00 until real time catches up.

Halftime holds the play clock and counts the break down instead. Stoppages accumulate
separately, so pausing at 00:06 and restarting still reads 00:06. Past the scheduled
ninety it keeps counting rather than freezing, because that is what football does.

Players see the clock. They do not see the controls, and the server would refuse the
transitions anyway.

**Payments freeze during play, in the database.**

```sql
CREATE TRIGGER game_payments_window BEFORE INSERT OR UPDATE ON game_payments …
```

The admin is watching a game, not running a till, and a payment recorded at minute 60 is
almost always a misremembered tap. The frontend hides the buttons and the service layer
checks the state, but this is the seatbelt underneath both — same spirit as
`games_not_overbooked`. At the final whistle the table unlocks: that is the settlement
window, for whoever pays on the way to the car, and those rows are flagged `settled_late`
so "paid on the night" stays distinguishable.

**Unmarking voids, it does not delete.** An admin who taps the wrong face and corrects it
has produced two facts, not zero. When someone disputes a payment three weeks later the
sequence is the only useful answer, and this is the one table that is about money. The
unique index is partial (`WHERE voided_at IS NULL`) so a correction does not block
re-marking, and the trigger guards INSERT and UPDATE but not DELETE — otherwise
`ON DELETE CASCADE` would make a live game undeletable, which is a data-integrity rule
impersonating a business rule.

**The score is a fold, not a column.** `match_events` is append-only; `game_live_score`
sums it. A stored score plus a list of scorers is two representations of one fact and they
drift — tap +1, tap a scorer, undo one, and the header says 3–2 above four goals.
`setPlayerStat({ goals: 3 })` does not write a 3 anywhere; it reconciles that player's live
goal events to three, appending or voiding until the count matches. A match timeline comes
free.

---

## Venue badges

A logo per venue, shown on the game and — the reason it exists — on the team sheet that
goes into WhatsApp. Uploaded from `/admin/venues`.

**Stored inline, as a data URI, not as a link.** That is not a shortcut; it is what makes
the export work. The shared team sheet is produced by drawing onto a canvas, and a canvas
that has drawn a **cross-origin image is tainted**: `toBlob()` throws a `SecurityError` and
there is no picture at all. A logo hosted on the venue's own website would therefore break
the single feature the logo exists for. `venues_logo_is_inline` enforces it in the schema,
so a well-meaning `UPDATE` cannot reintroduce the problem later.

Inline also means no object storage, no CDN, no signed URLs, and nothing to clean up when
a venue is deleted. The cost is a wide column, which the upload path keeps small: the file
is downscaled to 256px in the browser before encoding, turning a 3MB phone export into
about 11KB. PNG rather than JPEG, because these are logos on flat colour — JPEG drops the
alpha channel and rings around lettering.

SVGs are passed through unrasterised, but scanned first: an inline `<svg>` becomes part of
our own document in the export, so a `<script>` or a remote `xlink:href` inside one would
run with our origin.

Venues without a badge get their initials, never a gap — a row with two logos and one
hole reads as a loading failure. The generic words are dropped ("Fouad Chehab Stadium"
→ FC) unless doing so leaves too little to work with ("Sports Zone" → SZ, not Z).

---

## Sending the pitch to WhatsApp

The workflow this replaces is an admin screenshotting their own screen, cropping it with
their thumb, and pasting it into the group. One button now renders the pitch to a PNG and
hands it to the system share sheet, which on a phone is WhatsApp. On a desktop browser
there is no file sharing, so it downloads and gets dragged into WhatsApp Web — detected
with `navigator.canShare({files})`, because `navigator.share` exists on desktop Chrome and
then rejects files, which would walk the admin into a dialog that cannot do the thing.

**It is not three lines, and the reason is instructive.** Serialising an `<svg>` into an
`<img>` produces a separate document with no stylesheet and no `:root`, so every
`var(--pitch-turf-a)` in it resolves to nothing. The fix is to walk the live nodes, read
what the browser actually computed, and write those values onto the clone.

The first version of that list omitted `stop-color`, and the failure is the interesting
part: it did not throw, and it did not produce a blank image. It produced a **valid,
correct-looking PNG that was 86% black**, because an unresolved gradient stop falls back
to black rather than failing, and the pitch surface is a gradient. Caught by measuring the
colour histogram of the output rather than by looking at it — at a glance on a dark
theme it was not obviously wrong.

Players can export too. The image holds nothing they cannot already see on screen, and a
player posting tonight's teams into the group is the sharing loop working.

---

## The rating engine

`backend/src/modules/ratings/glicko2.js` — pure maths, no database, no clock.

**Glicko-2, verified against Glickman's own worked example** from the published paper
(r' = 1464.06, RD' = 151.52, σ' = 0.05999, matched to 0.01). An implementation that is
really "Elo with extra steps" passes every property test and fails that one, which is why
it is the first test in the file.

### Why Glicko-2 rather than an Elo variant

Because it models **uncertainty** explicitly, and uncertainty is what this platform
actually needs. Two players on 1548 are not equivalent if one has a deviation of 42 and
the other 180: the first is a known quantity, the second is a guess. The balancer already
reads that deviation so it does not stack every unknown player on one side, and the
leaderboard ranks on a conservative estimate so nobody tops the table after one good
night. Elo gives a single number and no way to say *we don't know yet*.

Three numbers per player, and the naming is genuinely confusing, so: **rating** is the
estimate, **deviation** is how unsure we are of it, **volatility** is how erratic the
player's results are — how fast the deviation should grow between games.

### The team adaptation, and its honest limitation

Glicko-2 is a one-on-one system. Each player is rated against a single composite opponent:
the opposing side's mean rating, with a root-mean-square deviation (one complete unknown
makes a side less predictable than the plain average suggests).

The limitation is real and worth stating: **a passenger on a strong team gains rating they
did not earn.** What rescues it is teammate variety — over many games with different
teammates the individual signal separates from the team signal. And the balancer's
anti-repetition penalty actively drives that variety. It exists to stop the league becoming
two fixed sides; a side effect is that it keeps the rating data informative. If the same
eleven played together every week, no rating system could tell them apart.

Margin of victory is deliberately ignored. In casual football a 10–0 usually means someone
left early or went in goal, not that the gap is five times wider.

### The replay is the payoff

```bash
POST /api/ratings/replay          # optionally { "dryRun": true }
```

Every rating is **derived**. The irreplaceable inputs are admin seeds and overrides, match
rosters, results, and attendance — all recorded immutably since V1. So the engine can
recompute the entire history of the league from nothing, and the first replay backfills
ratings over **every game ever played** rather than starting from today.

That is what made deferring this engine free, and the tests are where that claim is
either true or not:

- A replay reproduces exactly what was computed incrementally, game by game
- Admin seeds and overrides **survive untouched** — only rows this engine produced are
  discarded, because human judgement cannot be reconstructed
- An override anchors the timeline from its own point forward
- Changing `tau` and replaying applies the new setting to **all of history**, so parameters
  can be retuned without leaving a discontinuity in the middle of the league
- Every replay is recorded with the parameters that produced it

A dry run reports what would change and writes nothing.

### Ranking

The leaderboard orders by `rating − 2 × deviation` — the bottom of the ~95% interval, i.e.
*we are fairly sure they are at least this good*. A newcomer on 1600 ± 350 sits below a
regular on 1500 ± 40, which is correct: one of them has proved it. Provisional players are
hidden unless explicitly requested, because ranking someone the system barely knows is how
a leaderboard loses credibility.

### Decay

A daily sweep widens the deviation of players who have not appeared in 30 days. **Their
rating does not move** — absence is not evidence of getting worse — but confidence in it
fades. Someone last seen in March is not still known to within 40 points in September, and
pretending otherwise makes the balancer overconfident about a player nobody has watched.

---

## Rewards and redemption

This is the only part of the system where a bug costs real money, so the design is built
around the expensive failure modes rather than the happy path.

### Redemption is synchronous, fulfilment is not

Deducting points is a write we control. Issuing a Shopify discount code is an external
call we do not. Doing both in one transaction means either holding a transaction open
across a network call, or being unable to roll back the half that already happened.

So it splits:

1. **`redeem()`** locks the player row, checks balance and stock, deducts the points,
   reserves the stock, and creates a `pending` redemption — one transaction. The player
   cannot spend those points again the instant it commits.
2. **The worker** claims the pending row, calls Shopify, and settles it to `fulfilled`
   with a code. If Shopify permanently refuses, it **refunds the points and returns the
   stock** automatically.

The failure mode this rules out is the expensive one: points taken, nothing delivered, no
record of what was owed.

### What the database refuses outright

| Constraint | Makes impossible |
|---|---|
| `players_points_non_negative` | Spending points you do not have |
| `reward_catalogue_stock_non_negative` | Selling the 51st of 50 shirts |
| `reward_redemptions_idempotency` | A double-tapped button charging twice |
| `reward_redemptions_discount_code` | Two players issued the same code |

The service checks all of these first and returns a useful error; the constraints are the
seatbelt for the code path nobody has written yet.

### Nothing is ever edited

A refund is a **new positive transaction**, not a deleted charge. The ledger shows
charged-then-refunded and why. A code is only revealed once the redemption is actually
fulfilled, and never for a refunded one.

Codes avoid `O`, `0`, `I` and `1` — someone reads this off a phone and types it on a
laptop.

### Shopify stays on its own side of the line

Sports Fusion does not rebuild commerce. Shopify handles the store; this platform handles
community, football, identity and loyalty. The only thing crossing the boundary is a
discount code.

Disabled by default: with `SHOPIFY_ENABLED=false` the client returns a deterministic
dry-run code and logs what it would have created, so the entire redemption pipeline is
exercisable with no store, no credentials, and no risk of issuing real money off.

> **Verify the mutation shape and API version against Shopify's current Admin API docs
> before enabling this against a live store.** Shopify versions quarterly and deprecates
> old versions. Note in particular that `discountCodeBasicCreate` expects a *fraction* for
> percentage discounts — sending `10` rather than `0.1` gives every player 1000% off,
> which is the single most expensive typo available here.

### The number the owners actually need

`GET /api/rewards/admin/liability` reports outstanding points, outstanding value,
issue-to-spend ratio, redemption rate, and **concentration**. That last one matters as much
as the total: 400,000 outstanding points spread over 2,000 players is a marketing cost;
the same total held by nine people is an ambush.

Every catalogue write returns `impliedPointValue` and `gamesPerRedemption`, so whoever
sets a price sees what it means before anyone redeems it. A 2,500-point shirt costing
$12.50 is half a cent per point and twenty games of football.

### A modelling gap this exposed, and how it is handled

Adding `players_points_non_negative` made an existing latent bug sharp: a player who earns
100 points, spends them, and then sees the original 100 expire would go to −100.

Without lot tracking there is no way to know which specific points a redemption consumed,
so **expiry is capped at what the player still holds**. Proper FIFO lot consumption would
be more correct and is the right fix if points ever get an expiry policy that matters;
until then the cap is honest, documented in `expirePoints()`, and tested.

---

## Status

**Done and verified — 176 tests + 24 schema guarantees, all passing**

```bash
npm test
```

- 20 migrations, 41 tables
- Nothing in the app is mocked: every screen reads the database
- Match clock, payment freeze, post-match settlement, and PNG export to WhatsApp
- Authorisation proven by table: 38 admin routes, refused to players and to anonymous
- Phone sign-in over WhatsApp, and QR invites that let a community add itself
- Matchday operations: the clock, payments, live goals, attendance, formation, MOTM
- Glicko-2 rating engine, verified against the specification's worked example
- Exhaustive team balancer — 352,716 splits in ~115 ms, reproducible from a stored seed
- Full HTTP API: auth, RBAC, games, registrations, waitlist, teams, results, ratings, rewards, matchday
- Worker: event dispatch, notifications, fulfilment, periodic sweeps, retry, dead-lettering
- Every suite runs the real code against a real Postgres engine, no mocks

The economy is closed: **play → earn → redeem → Shopify**, with the liability visible at
every step.

**Six real bugs the tests caught**

| Bug | Consequence had it shipped |
|---|---|
| `z.coerce.boolean()` on `"false"` returns `true` | Every integration flag in `.env` silently enabled |
| Pool-level reads inside an open transaction (4 sites) | Total deadlock once concurrent requests reach pool size |
| Reuse detection revoked the token family *inside* the transaction it threw from | Rollback undid the revocation — a stolen token family stayed alive |
| `claimOne()` called `pool.query()` while holding a pooled client | Same deadlock, in the notification sender |
| `runDueJobs()` leaked a connection on every not-due job | Pool permanently exhausted after ~20 idle ticks |
| `tick()` sent notifications before running the sweeps that queue them | Every reminder delayed a full tick |
| OTP attempt counter incremented inside the transaction it threw from | The rollback undid the increment, so the five-attempt cap never bit and a six-digit code could be guessed forever. Identical in shape to the refresh-token bug two rows up, and invisible in review — the only way to catch it is to make five wrong guesses and then a right one. |
| Nothing ever called `/auth/refresh` | The backend had rotation and reuse detection built and tested; no client used it. The access cookie lives 15 minutes, so the app signed people out a quarter of an hour after signing in — an admin running a 90-minute match was bounced to the login screen twice, mid-game, holding a session that was still valid. The renewal is single-flight, because rotation plus parallel requests would trip the reuse detector and revoke the whole family. |
| The rewards screen destructured five fields from a response with one | The mock returned `{balance, rewards, history, redemptions, achievements}` from a single call; the real API returned only the catalogue, so `achievements.filter` threw and took out every page rendered after it. Switching a domain from mock to live is not a flag flip — the shapes have to be reconciled, and the crash surfaced three pages away from the cause. |
| `stop-color` missing from the export's inlined properties | The pitch surface is a linearGradient whose stops are CSS variables. Leaving one property out did not throw and did not produce a blank file — it produced a valid PNG that was 86% black, because an unresolved gradient stop falls back to black. Found by measuring the colour histogram of the output; on a dark theme it did not look obviously wrong. |
| The public game endpoint returned teams only at `teams_generated` | A player's pitch went blank the moment the match kicked off, and stayed blank afterwards — exactly the two hours they most want to look at it. |
| `ON CONFLICT DO NOTHING` on a table with nothing to conflict on | Venues had no unique constraint, so the clause was silently a no-op and running the seed twice produced two of every pitch. An admin picking from a list with the same name in it twice cannot tell which one their old games hang off. Fixed with the unique index that should have existed (district plus normalised name), and a migration that folds duplicates into the oldest row — repointing games and schedules first, because both columns are `ON DELETE SET NULL` and would have orphaned them silently. |
| A data URI inside a Tailwind arbitrary value | The select's chevron was `bg-[url("data:image/svg+xml,%3Csvg xmlns=...")]`, and a data URI contains literal spaces. A `class` attribute is split on whitespace, so the browser tore that one class into fragments and took the neighbouring `bg-[var(--bg-surface)]` with it. The control ended up with **no background and no arrow**, and its options inherited near-white text onto nothing — which is why venue names were there but unreadable. Moved to a real CSS class, where a URI can be percent-encoded and `option` can be styled at all. |
| `Segmented` read `option.key`; two call sites passed `option.value` | It fell back to the whole option object and handed that to `onChange`, so the state became `{value, label}` — matching neither branch. No throw, no warning, and the control looked dead: the login page's Phone/Password toggle could switch to Password and never back. Fixed in the component (`option.value ?? option.key ?? option`) rather than at the call sites, because the trap is the component silently accepting one shape of two reasonable ones. |

**Written, gated on a real Postgres**

`backend/src/modules/registrations/concurrency.test.js` — 20 callers racing for the last
slot, simultaneous cancellations, and a direct attempt to overbook past the CHECK
constraint. It **skips loudly** without `SF_TEST_DATABASE_URL` rather than passing by
accident: PGlite serves one connection at a time and cannot demonstrate serialisation.

The same gap applies to redemption. The row-lock reasoning is identical to registration
and the constraints are proven, but two real connections racing for the last shirt has not
been demonstrated. Worth adding to that suite once Docker runs.

**Frontend — entirely on the real backend**

`frontend/` — the player app and the admin command centre. React 19, Vite 8, React Router 8,
TanStack Query, Tailwind 4. **160 KB gzipped first paint.**

`VITE_USE_MOCK=false` and it talks to this API through the Vite proxy, so the httpOnly
session cookie stays same-origin and nothing is tempted to put a token in localStorage.

Every domain is live: auth, districts, games, matchday, players, invites, schedules,
awards, admin statistics, the audit trail, leaderboards and rewards. The `LIVE` map in
`src/api/services.js` is the one place that says so, and it is now all `true`.

The mock survives behind `VITE_USE_MOCK=true`, for an offline demo or for working on a
screen that needs a full fixture. Its 140-player dataset is a dynamic import, so
production never fetches it — checked against the built bundle rather than assumed.


See [frontend/README.md](frontend/README.md) for the stack justification, the design
system, and the audit log.

**Not started**

- Gemini: match summaries, admin assistant, natural-language analytics
- Achievements engine (the tables exist; nothing awards them)
- Attendance prediction and demand forecasting
- Shopify order webhooks (signature verification is written; no route consumes it yet)
- Admin create-game form; internationalisation

**Blocked on a firmware setting**

Docker cannot start. WSL2 is installed but reports:

> WSL2 is unable to start since virtualization is not enabled on this machine.

Hardware virtualisation (Intel VT-x / AMD-V) must be enabled in the BIOS/UEFI, and the
"Virtual Machine Platform" Windows feature turned on. Both need a reboot and are outside
what the toolchain can change. Until then everything is verified through PGlite — the real
Postgres engine compiled to WebAssembly — and the concurrency suite stays skipped.
