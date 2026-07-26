# Retro Runner — Feature Checklist

Reference doc for every feature in the game — planned, in progress, or shipped — along with why it exists. The table below gives a quick status overview with jump links; full details for each feature live further down.

---

## Status Overview

| # | Feature | Status | Details |
|---|---------|--------|---------|
| 1 | Scoreboard with player name & cookie consent | Shipped | [Jump to details](#feature-1) |

---

## Feature Details

<a id="feature-1"></a>

### 1. Scoreboard with player name & cookie consent

**Status:** Shipped

**Description:**
Before a run starts, the game asks the player whether they want to join the scoreboard, and discloses that saying yes stores a cookie in their browser. This choice is **off / not selected by default** — the player must actively opt in.

1. **Consent prompt** — Shown once, on first visit, before the intro card becomes usable. Discloses cookie usage (name + recent scores, device-only, 90-day expiry) alongside a name field and two explicit buttons — nothing is pre-selected. Tapping the background while it's open does nothing; only the buttons resolve it (`consentPending` guard in `jump()`).
2. **Name capture** — Combined into the same one-time prompt: opting in requires typing a name (validated non-empty) before it can be saved.
3. **In-run display** — The stored name floats above the player character (`#playerNameTag`), shown only while `state === 'playing'`.
4. **End-of-run scoreboard** — After each run, a table on the game-over card lists up to the **5 most recent** {name, score} entries, newest first. The row just added is highlighted. The section is hidden entirely if the history is empty.
5. **Cookie behavior** — Three cookies (`rr_consent`, `rr_name`, `rr_scores`), 90-day expiry, `path=/`, `SameSite=Lax`. Nothing leaves the device.

**Why:** Gives returning players a light sense of continuity and friendly competition without forcing data collection on everyone who just wants to play. Opt-in + explicit cookie disclosure keeps it consent-based and privacy-respectful. Capping the table at 5 keeps the end screen simple and avoids needing a backend/leaderboard service — everything runs client-side.

**Points to address — resolved:**

1. **Opt-out data retention:** Keep previously stored entries as-is; opting out only stops new ones from being added. No dedicated "clear my data" UI was built for this pass — cookies expire on their own after 90 days, or can be cleared through the browser like any other cookie. *(Worth a follow-up if explicit in-game clearing turns out to matter.)*
2. **Scope of "5 most recent":** Per-browser only, via cookies — there's no backend, so cross-device aggregation was never on the table. Confirmed by the "Why" section above.
3. **Cookie expiry:** 90 days ("3 months at max").
4. **Repeat opt-ins:** Every completed run while opted in adds its own row — the same name can occupy more than one of the 5 slots. Also decided: the consent prompt itself is asked **once ever**, not before every run — changeable anytime after via a "🏆" row in the pause panel, which reopens the same card pre-filled with the current name.

**Implementation notes:**
- `game.js` — see the `SCOREBOARD` section (cookie helpers, state, `renderNameTag()`, `renderScoreboard()`).
- `index.html` — `#consentOverlay` (first-visit + pause-panel-reopened editor), `#playerNameTag`, `#scoreboardSection` on the game-over card, `#scoreboardSettingsBtn` in the pause panel.
- `game.css` §13 — `.scoreboard*` / `#consentNameInput` / `.consent-actions`; §9 — `.player-name-tag`.

---

<!--
TEMPLATE — copy this block for each new feature, then:
1. Add a row to the Status Overview table above (with a matching #feature-N link).
2. Paste the block below at the end of Feature Details, replacing N and the placeholders.

<a id="feature-N"></a>

### N. [Feature name]

**Status:** Planned

**Description:**
[What the feature does, broken into numbered sub-points if it has multiple parts/steps.]

**Why:**
[Why this feature is being added — the reasoning to preserve for later.]

**Points to address:**

1. [Open question or decision needed]
-->

## Notes

- To add a feature: copy the template above, give it the next number, add a row to the **Status Overview** table, and fill in Description / Why / Points to address.
- Status values: `Planned` → `In Progress` → `Shipped`. Update both the table and the detail section when it changes.
- Keep the **Why** even after shipping — it's the part that's easy to forget and hardest to reconstruct later.
- Resolved items under **Points to address** can be checked off or moved into the Description once decided.
