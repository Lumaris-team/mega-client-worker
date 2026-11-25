# Backend Structure

`mega/` — the whole MEGA integration. This worker owns the MEGA session
(megajs `Storage` login, 24h connection cache, rate limiting, retries) so
caller workers never touch MEGA credentials or the megajs client.

- `mega.js` — client factory + low-level ops (`getClient`, folder
  navigation, `megaRead`/`megaWrite`/`megaDelete` for small state files,
  `megaGetLink` for public download URLs).
- `files.js` — user files API: list, read (download URL), upload
  (buffer / remote URL streaming), folder, rename, delete.
- `state.js` — small internal JSON/text state files (`lumaris/pomodoro/…`,
  `lumaris/websites/…`).
- `stats.js` — storage usage per `lumaris/` folder.
