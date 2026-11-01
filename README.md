# Game Hub

Upload classroom HTML games, send each one as its own link, and see every student's results in one dashboard.

- **Teacher** (`/admin`): drag and drop a game's `.html` file, choose a link name such as `puzzle`, and get `https://<your-site>/puzzle` with a Copy button and a QR code. Turn games on or off, rename them, replace the file, or delete them.
- **Students** (`/<link-name>`): enter full name, grade and section, then play. They can play as many times as they like; each play is saved as the 1st, 2nd, 3rd… attempt.
- **Dashboard** (`/admin/results`): the top 2 students in each game, every attempt with filters (game, grade, section, status, dates, name), each student's attempt history, and CSV export for Excel.

## How games send their results

Every uploaded game automatically gets a small `GameHub` script. When the student finishes, the game calls:

```js
GameHub.submit({
  score: 8,             // number (optional)
  max_score: 10,        // number (optional)
  duration_s: 95,       // seconds the student took (optional)
  status: "completed",  // or "not_finished" (optional, default "completed")
  details: { ... }      // anything else you want to see in the dashboard (optional)
});
```

If a game never calls `GameHub.submit`, the dashboard still shows that the student started it ("Started only").

**Making new games with AI:** add this sentence to your prompt:

> When the player finishes, call `window.GameHub && GameHub.submit({ score, max_score, duration_s, status: "completed" or "not_finished", details: {...} })`. The game must be one self-contained .html file.

Notes:
- Games run in a locked-down frame, so they cannot reach the teacher's login or data. `localStorage` still works inside a game, but only for that one play.
- Ranking for the top 2: highest score, then the shorter time, then whoever finished first. Each student appears once, with their best attempt.
- A student is recognised by full name + grade + section, ignoring capital letters and extra spaces.

## Run it on your computer

Needs Node.js 20.12 or newer.

```bash
npm install
cp .env.example .env      # then edit ADMIN_PASSWORD
npm start
```

Open http://localhost:3000/admin. With no `DATABASE_URL`, the app uses a built-in database saved in `./data`.

## Deploy (free): Neon + Render

1. **Database:** create a free project at https://neon.tech and copy its connection string (`postgresql://...?sslmode=require`).
2. **Render:** New → **Web Service** → connect this GitHub repo.
   - Build command: `npm install`
   - Start command: `npm start`
   - Environment variables:
     - `DATABASE_URL` = the Neon connection string
     - `ADMIN_PASSWORD` = the teacher's password
     - `SESSION_SECRET` = any long random text
3. Deploy, then open `https://<your-service>.onrender.com/admin`.

The tables are created automatically on first start, and the games in `games/` are added as starter games (`/mystery-picture`).

The old service at game-4i1b.onrender.com is a **Static Site** and can't run this server, so create a new Web Service. Once the new one works, you can delete the old one.

Render's free plan sleeps after 15 minutes with no visitors. The first person to open a link then waits about 30–50 seconds; after that it is fast. Open the site yourself a minute before class to wake it up.

## Files

| File | What it does |
|---|---|
| `server.js` | Express server: pages, teacher login, games, attempts, results, CSV |
| `db.js` | PostgreSQL connection (Neon), or the built-in local database |
| `schema.sql` | `games` and `results` tables |
| `public/sdk.js` | `GameHub.submit()`, added to every game |
| `public/play.html` | Student page: details form, the game, "Play again" |
| `public/admin.html` | Teacher page: upload and manage games |
| `public/results.html` | Dashboard: Top 2, attempts table, CSV |
| `games/` | Starter games added on first run |
