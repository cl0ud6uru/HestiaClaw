---
name: home-status
description: Check the current state of all smart home devices and systems — lights, climate, locks, sensors, and media players. Use when asked about what's on, what's off, temperature, or the general state of the home.
user-invocable: true
disable-model-invocation: false
---

Check the current state of the home and provide a concise status report covering:

1. **Lights** — which rooms have lights on and at what brightness
2. **Climate** — current temperature, target temperature, and HVAC mode for each zone
3. **Locks** — state of all door locks
4. **Security sensors** — any open doors/windows or motion alerts
5. **Media** — any active media players and what they're playing

Use the Home Assistant tools to query entity states. Present the results as a clean HUD-style summary. Flag anything unusual (a door left unlocked, a light left on in an unoccupied room, etc.).
