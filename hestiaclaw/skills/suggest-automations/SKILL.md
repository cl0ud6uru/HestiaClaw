---
name: suggest-automations
description: Mine Hestia's long-term memory for patterns and habits, then create disabled Home Assistant automations under the "AI Suggested" category for the user to review and enable.
user-invocable: true
disable-model-invocation: false
webhook-safe: false
tags: [automation, memory, home]
---

You are going to analyze everything you know about the user's habits and home, then turn those patterns into real (but disabled) Home Assistant automations. Work through the following steps in order.

---

## Step 1 — Mine memory for patterns

Call `graphiti__search_nodes` five times with these queries to gather a broad picture:

1. `"daily routine schedule morning evening night"`
2. `"lights temperature climate thermostat preferences"`
3. `"device usage patterns when who occupancy"`
4. `"location presence away home arrival departure"`
5. `"media music entertainment TV habits"`

Read all results carefully. Extract every concrete behavioral pattern you find — things like "user arrives home around 6 PM", "kitchen lights are often left on overnight", "temperature is preferred at 68°F when sleeping", etc.

Synthesize these into a list of **specific, actionable automation ideas**. Aim for 3–8 ideas. Each idea must have:
- A clear trigger (time, state change, event)
- Optional conditions (who's home, time of day, etc.)
- A concrete action (turn on/off a device, set a temperature, send a notification)
- The memory evidence that inspired it (quote the relevant memory fragment)

Discard vague ideas. Only keep ideas that can be expressed as a real HA automation right now with the information available.

---

## Step 2 — Ensure the "AI Suggested" category exists

Call `ha_config_get_category` with `scope: automation` to list all existing automation categories.

- If a category named **"AI Suggested"** already exists, note its `category_id`.
- If it does not exist, call `ha_config_set_category` with `name: "AI Suggested"` and `scope: automation`. Capture the `category_id` from the response.

---

## Step 3 — Check for existing AI-suggested automations

Call `ha_config_get_automation` to retrieve the current automation list. Identify any automations whose alias starts with `[AI] ` — these are previously suggested automations. Do not recreate automations for ideas that are already covered by an existing `[AI] ` automation.

---

## Step 4 — Create each new automation (disabled)

For each new idea that isn't already covered, call `ha_config_set_automation` with these top-level parameters:

- `category`: the category_id from Step 2 — pass this as a top-level parameter, not inside `config`
- `config`: a dict containing:
  - `alias`: `[AI] <short descriptive name>` (e.g. `[AI] Evening Welcome Lights`)
  - `description`: A sentence explaining what this automation does and which memory evidence suggested it. Be specific — quote the memory fragment.
  - `initial_state`: `false` — this is the correct field to create an automation in disabled state. Do NOT use `enabled`.
  - `mode`: `single`
  - `trigger`: array of trigger objects
  - `condition`: array of condition objects (omit if none needed)
  - `action`: array of action objects

Triggers, conditions, and actions must be arrays of objects — not YAML strings. Example structure:
```
trigger: [{"platform": "state", "entity_id": "binary_sensor.front_door", "to": "on"}]
action:  [{"service": "light.turn_on", "target": {"entity_id": "light.hallway"}}]
```

The `category` top-level parameter automatically places the automation in the "AI Suggested" category — no separate `ha_set_entity` call is needed.

---

## Step 5 — Report results

Present a clean summary:

```
## Automation Suggestions Created

[AI] Evening Welcome Lights
  → Turns on living room lights at 50% when you arrive home after 5 PM.
  → Memory: "User typically arrives between 6–7 PM on weekdays"
  → Status: disabled — review in HA → Automations → AI Suggested

[AI] Overnight Kitchen Light Alert
  → Sends a notification if the kitchen light is still on after midnight.
  → Memory: "Kitchen lights were frequently left on after 11 PM"
  → Status: disabled — review in HA → Automations → AI Suggested
```

End with: "All automations are disabled. Review them in Home Assistant under **Automations → AI Suggested**, then enable any you'd like to activate."

If no new patterns were found or all ideas were already created, say so clearly and suggest running `/suggest-automations` again after more conversations to build up more memory.
