# Foundry Yard — Browser Multiplayer FPS

A browser-based 3D FPS using Three.js in the browser and a Node.js/WebSocket authoritative game server.

**Project provenance:** the original browser prototype ZIP/source was not available among the files attached to this conversation. The files in this package are a reconstructed, runnable implementation based on the previously described browser architecture; they are not a verified patch against the unavailable original source. The available older files were Roblox Luau map-generator files and were not used as browser-game source.

## Requirements

- Node.js 20 or newer
- Internet access for the Three.js and font CDN assets in the browser
- npm access to install the `ws` server dependency

## Run locally

In a terminal opened in this folder:

```bash
npm install
npm test
npm start
```

Then open `http://localhost:3000` in two separate browser tabs/windows to join the same local match. Each tab uses its own session reconnect token. The server binds to `0.0.0.0`, so a second device on the same LAN can connect to `http://YOUR-COMPUTER-LAN-IP:3000` if the host firewall permits it. Change the port with `PORT=3001 npm start`.

On Windows, `start.bat` installs dependencies if needed and starts the server. To run automated checks without starting the game, use `npm test`.

## Controls

Click **ENTER ARENA**, then click the game view to lock the mouse. Use **WASD** to move, **Space** to jump, **mouse** to aim, **left-click** to fire, and **Esc** to release the mouse.

## Authority and networking

The client sends movement input, aim angles, jump requests and fire requests only. The server simulates movement, gravity, collision, jump validation, weapon cooldown, line-of-sight hit validation, damage, health, kills, deaths, teams, round results and scores. The client cannot submit health, damage, kills or score values.

The server broadcasts player positions, rotations, health, alive/dead state, team, score and round phase. It uses WebSocket ping/pong heartbeats, a reconnect token held in per-tab session storage, replacement of duplicate sockets for the same token, a reconnect grace period, and stale-player cleanup.

## Included systems

- Original Foundry Yard industrial arena and title screen/HUD styling
- Server-side movement physics, arena boundaries, obstacle collision and elevated flank ramp/platform ground heights
- Two teams, multiple players, server-validated hitscan firing, weapon cooldown and spawn protection
- Health, kills, deaths, round transitions, respawn on next round, guarded round scoring and first-to-five match completion
- Automated tests for movement/collision helpers, shot validation and static server event-flow/authority contracts

## Validation and limitations

The generation environment passed JavaScript syntax checks and all included Node.js tests. The WebSocket package could not be installed in this environment because the package installation attempt timed out, so the HTTP/WebSocket server was not launched here and browser-to-browser multiplayer has **not** been runtime-tested. Run `npm install` locally before starting the game.

This is a prototype, not a production anti-cheat solution. Server state is authoritative for gameplay outcomes, but clients can still automate legal-looking inputs. There is no account system, matchmaking, persistent stats, dedicated lobby, voice chat, or production hosting configuration.
