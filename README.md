# Mafia

The classic party game for the web. One player creates a room and shares the link, and everyone joins with just a nickname.
The narrator is fully automatic: it deals roles, runs nights and days, counts votes and announces deaths.

## Run it locally

```
npm install
npm start          # http://localhost:3000
```

Play solo with bots: create a room, then run `node test/bots.js ROOMCODE 6`.
Engine tests: `npm test`.

## Roles
Civilian, Mafia, Don, Doctor, Detective, Bodyguard, Escort, Sheriff, Maniac, Jester.
The host picks the mix (or leaves it on automatic), the min/max player counts and the timers.

## Chats
- **Town**: everyone in the lobby. During the game, only the living can talk, and only in the day.
- **Family**: the Mafia's secret chat. Readable by the dead and after the game.
- **Graveyard**: only the dead can read and talk here until the game ends.

## Host it for free (Render)
1. Push this folder to a GitHub repo.
2. On render.com: New → Web Service → pick the repo.
3. Build command `npm install`, start command `npm start`, instance type **Free**.
4. Share the `https://<your-app>.onrender.com` link.

The free tier sleeps after about 15 minutes of no traffic, and the first visit after that takes about 30 seconds to wake it.
Game state lives in memory, so a restart or redeploy ends running games.

## Files
- `game.js`: rules engine (roles, night resolution, voting, win checks, per-player views)
- `server.js`: Express and Socket.IO, rooms, reconnect, cleanup
- `public/`: the web client (no build step)
- `test/`: scenario tests, a random-game simulator, and bots
