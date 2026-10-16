# 10 - Mobile Design

Version: 0.5. Date: 2026-10-05. Direction: requested by the owner. Implementation status: implemented in `apps/mobile`; this document is its design contract.

## 1. Design direction

A quiet messaging app for a small team of assistants. Use the layouts from the original mobile reference screenshots, which are not published: generous whitespace, circular avatars, flat conversation rows, rounded message bubbles, a compact composer, and grouped settings in a sheet. Colors come from Hermes's semantic theme system. Keep the main experience focused on conversations.

Home is a single screen, not a permanent multi-tab dashboard. The account avatar opens Settings, search opens a focused search view, and the plus button opens a compact creation menu. Routines, files, tools, model selection, and memory live behind the agent's name in chat. The board and catalog are secondary destinations when their phases ship.

## 2. Hermes theme source and resolution

Verified in the adjacent `hermes-agent` checkout at v0.21.6, commit `818c13be1dc4fd28987e1e881a9408224afd4535`:

| Source under that checkout | Role |
|---|---|
| `apps/desktop/src/themes/presets.ts` and `apps/shared/src/theme-presets.ts` | Built-in palettes; `DEFAULT_SKIN_NAME = 'nous'`; light `colors` and dark `darkColors` (the palette values live in the shared file) |
| `apps/desktop/src/themes/types.ts` | `DesktopThemeColors` semantic token contract |
| `apps/shared/src/skin.ts` | `HermesSkin` payload from the backend |
| `apps/desktop/src/themes/skin.ts`, `color.ts` and `apps/shared/src/color.ts` | Pure `skinToDesktopTheme` conversion and color helpers (the sRGB and contrast helpers live in the shared file) |
| `apps/desktop/src/themes/backend-sync.ts` | Built-in names retain their desktop palettes; `default` resolves to Nous; connect-time skin discovery does not overwrite a saved choice |

Port the pure palette data and conversion functions into the app's pinned vendor directory, retaining the upstream license and provenance. Adapt persistence and application to React Native; do not import desktop DOM, CSS, localStorage, or nanostore wiring. Components consume a typed mobile theme object rather than literal hex colors. Palette upgrades happen with the Hermes pin.

Initial appearance is **System**, using Nous light or dark as appropriate. Settings offers Appearance (System / Light / Dark) and Theme (Hermes built-ins, plus valid discovered skins). Cache the selected non-secret palette for first paint. A custom single-mode skin keeps its supplied palette in both appearances, matching Hermes's converter.

On `gateway.ready`, register discovered skins without replacing the saved mobile preference. On an explicit `skin.changed`, apply the valid active gateway skin using the desktop resolution rules; events from inactive connections must not repaint the app. A built-in name always resolves to its preset, and `default` means Nous. Invalid payloads retain the last valid palette. A mobile-only Appearance/Theme change does not write gateway config. Cross-device synchronization of local desktop preferences is not provided by these backend events.

## 3. Default palette and component mapping

These values are a reference snapshot of `nousTheme`, not a second independently maintained palette. Preview and eventual app code must use the vendored source tokens.

| Semantic token | Light | Dark | Mobile use |
|---|---|---|---|
| `background` | `#ffffff` | `#0d1117` | Home and chat canvas |
| `foreground` | `#1f2328` | `#e6edf3` | Names and body text |
| `card` | `#f6f8fa` | `#010409` | Secondary inset surfaces where separation remains clear |
| `muted` | `#f6f6f6` | `#1a1e24` | Assistant bubbles, grouped settings rows, title badges |
| `mutedForeground` | `#656d76` | `#7d8590` | Metadata, timestamps; verify contrast on the actual surface |
| `popover` | `#ffffff` | `#161b22` | Creation menu and settings sheet |
| `primary` / `midground` | `#0053fd` | `#4a84fe` | Send action, selection, unread dot, active switch |
| `primaryForeground` | `#ffffff` | `#161616` | Text/icon on filled primary controls |
| `accent` | `#e3edff` | `#17243a` | Quiet selected surfaces |
| `border` | `#d0d7de` | `#30363d` | Composer outline, sheet dividers |
| `input` | `#ffffff` | `#0d1117` | Composer and search input |
| `userBubble` | `#dae7fd` | `#07162c` | User messages, with `foreground` text |
| `destructive` | `#cf222e` | `#f85149` | Delete, sign-out, errors with text labels |

Use accent color sparingly. Regular row icons and navigation stay neutral; photos carry most of the visual variety. Use paired surface/foreground tokens for buttons. For small text, validate the resolved contrast rather than lowering opacity; promote metadata to `foreground` on a surface where its muted token fails the accessibility check. The screenshot's green switches and orange working mascot are not copied. Working state uses a small Hermes-accent indicator plus text; there is no new mascot asset.

## 4. Layout and interaction contract

All dimensions below are logical points/dp, not screenshot pixels. Reference screenshots are 1179 × 2556 physical pixels; do not reproduce that scale in React Native.

| Element | Initial design value | Behavior |
|---|---|---|
| Page padding | `SPACE.extraLarge` 20; `SPACE.large` 16 below `RULE.narrowScreen` (360) | Respect safe areas; never overlap content with the status bar. The Home list runs edge to edge instead: the list spans the screen width and each row and section header pads its own content by the page padding, so a row's tap highlight, a lifted row and the scroll bar reach the screen edges while the content stays in line with the rest of the page |
| Bottom safe area | Content padding, not a reserved inset | Scrolling content runs to the bottom edge of the phone: its own scroll view is never inset there, and its content container adds the device's bottom inset (the home indicator on iOS, the edge-to-edge navigation bar on Android) on top of whatever bottom padding the screen already wanted, so the last row can still scroll clear of it. A fixed bottom bar (Home Edit mode's bar, the chat composer, any fixed bottom button area) draws its own background to the screen edge and pads its content by the inset instead, so its buttons sit above it. Where a device reports no bottom inset, nothing changes. While the keyboard is open, a keyboard-avoiding view or (on a `Page`) the scroll view's keyboard inset already moves the content up by the full keyboard height measured to the physical bottom of the screen, covering the inset; padding is not added twice on top of it. |
| Spacing | The `SPACE` steps: `hairline` 2, `extraSmall` 4, `small` 8, `medium` 12, `large` 16, `extraLarge` 20, `huge` 24, `giant` 32 | Use whitespace to group content |
| Body and composer | Body text `TYPE.body` 17 with `LEADING.body` 24 line height; the composer input is `TYPE.body` 17 | Native system font, scalable with device text size |
| Row name | `TYPE.bodyStrong` 17, medium | One line normally; permit wrapping with larger text |
| Metadata | `TYPE.footnote` 13 to `TYPE.callout` 15 | Legible contrast; accessible full value for truncation |
| Controls | At least `RULE.touch` 44 × 44 hit area | Simple outline icons; screen-reader labels |
| Icon button | `RULE.touch` 44 × 44 hit area; no border and no outline circle | Icon in `foreground`; dims while pressed or disabled |
| Field | Label above, `TYPE.footnote` 13, `mutedForeground`; input on `muted`, no border, `RADIUS.medium` 12, padding `SPACE.medium` 12, minimum `SIZE.large` 48 high (`RULE.textAreaMinHeight` 128 when multiline), `TYPE.body` 17 text | `primary` selection color; an error shows as red text below, the input keeps its color |
| Button | Minimum `SIZE.large` 48 high; `RADIUS.large` 16; 600-weight label | Primary on `primary`; secondary on `muted` with `foreground` text |
| List avatar | `SIZE.large` 48 | Circular image or initials fallback |
| Pinned avatar | `SIZE.giant` 88 | Up to two prominent shortcuts; empty section hidden |
| Chat avatar | `SIZE.small` 28 | Part of the agent details button |
| Bubble | `RADIUS.extraLarge` 20; padding `SPACE.medium` 12 × `SPACE.large` 16; max width 88% | Natural content width; assistant left, user right |
| Composer | Minimum `SIZE.large` 48 high; `RADIUS.huge` 24 | Grows up to five lines, then scrolls within the input |
| Settings group | `muted` card, `RADIUS.extraLarge` 20, optional small caption above; row minimum `SIZE.extraLarge` 56 with a leading line icon, title, optional subtitle and a chevron when the row opens something | Hairline dividers inset past the icon to the text; labels wrap at large text sizes |
| Sheet | `RADIUS.giant` 28 at top | Close button, native dismissal and Android back support |

Every spacing, size, radius, icon size, type and opacity value in this table is a step or a named rule of section 4a, in `apps/mobile/src/theme/tokens.ts`.

Field, Card/Group and the secondary Button fill with whichever of `muted` or `background` reads more clearly against the surface they sit on — the page normally, a Sheet's `popover` inside one — so the fill stays visible in every theme's dark mode instead of nearly matching a sheet's own color.

### Home

- Top row: account avatar at left; Edit (a borderless text button on iOS, an icon on Android), Search and Add at right. No large marketing header, counts, charts, or permanent bottom tab bar.
- Optional pinned agents below. Which agents are pinned is shared with Hermes Desktop; the pin order is a device preference. On a new install the phone pins the concierge once, when Hermes has no pinned value for it; once pinned it has no fixed place, the same as any other pin.
- Rows keep the owner's order. A new message shows the unread dot and never moves the row; a new agent starts at the top of its group.
- Recent conversations: avatar, name, compact role badge when it fits, timestamp, one-line message or event preview. An unread dot includes an accessible unread label. Avoid cards or separators around each row. The list runs edge to edge: a row's tap highlight spans the screen width and the scroll bar sits at the screen edge.
- The Add menu contains New Agent; New Group Chat appears when Phase 2 rooms are available. Selecting an action closes the menu before opening its sheet.
- Search focuses its input. Phase 1 searches the loaded roster by name, role, and description; Phase 2 adds conversation-content search. State the selected scope in the input label. Closing search restores home position.

### Home sections and pinned members

Clarified by the owner on 2026-09-13; the original mobile reference screenshots are not published. A Home organization group is called a **section** in these docs; it does not create a shared conversation or a Hermes room.

- Show the section name, such as **Prive**, as small, regular-weight grey text with a chevron immediately beside it. Use Hermes `mutedForeground` with the contrast fallback above; avoid a card, filled badge or large heading. The whole heading has a minimum hit area of `RULE.touch` (44 points) and an accessible section name and expanded/collapsed state.
- The section of each agent is shared with Hermes Desktop (docs/05 "Bot metadata compatibility"); the list of sections, their order and their collapse state stay on this phone. A section the phone finds only on agents shows at the end, named from the agents, or "Untitled section" when none carries a name.
- Tap the heading to expand or collapse its conversation rows. Chevron down means expanded; right means collapsed. New sections start expanded; remember each section's state on this device.
- Long-press a heading, on Home and in Edit mode, to open the pushed **Section** page; screen readers get the same page through the heading's **Edit section** action. The page has a **Name** field with the current name and a **Save** button, disabled while the name is empty (after trimming) or unchanged; Save renames the section and goes back. Below it, **Delete section** asks first ("Delete section Prive? Its agents move to No section."), then moves the section's agents to the end of No section in their current order, removes the section and its collapse state, keeps every pin, and goes back. It works the same on iOS and Android.
- Section membership and pin state are independent. Pinning a member shows it in the pinned area above the sections and removes its duplicate row from the section list, while retaining its section assignment. Moving a pinned bot to another section preserves its pin.
- Unpinning returns the bot to its assigned section, at its place in the manual order. If that section is collapsed, leave it collapsed and reveal the returned row when the user expands it. Unassigned bots return to the ordinary ungrouped list.
- Collapsing a section never hides its pinned members. Keep its heading even when all members are pinned, so the section remains available. Removing a section clears its members' section assignment without changing their pin state.

**Example:** Linh and Kevin belong to Prive and are pinned. Their large avatars appear at the top, while Prive's expanded list contains its unpinned members. Unpin Linh: her avatar leaves the pinned area and her conversation appears under Prive. Kevin stays pinned and remains a Prive member. Pin Linh again: her row leaves the list, her avatar returns to the top, and her Prive membership is unchanged.

### Home edit mode

Edit mode lets the owner act on several agents at once and put rows in their own order. The order stays a device preference; pins and sections go to Hermes (docs/05 "Organization outbox").

- **Enter:** a borderless **Edit** text button (iOS) or edit icon (Android) left of Search, or **Select** in the long-press menu, which opens Edit mode with that agent already selected.
- **In place:** pressing Edit keeps the Home screen the owner is looking at. The pinned avatars, the rows (avatar, name, preview, time, unread dot) and the section headers keep their look; collapsed sections stay collapsed, and a tap on a header still collapses or expands it. There are no "Pinned" or "No section" captions. Selection circles, ≡ handles and badges animate in; Done plays the same animation in reverse.
- **Motion:** the top bar and the list read Edit mode's one progress value, 250 ms ease in-out. The bottom bar uses the same timing on its own value, because it follows the selection rather than Edit mode itself: it slides up while at least one agent is selected, whether or not Edit mode just started. A row's or a section header's static layout (the circle and the ≡ column's reserved space) switches once per toggle, not on every frame; everything that moves in between is a transform or an opacity change, never a size or a position that Yoga has to recompute. With the system setting Reduce motion on, every change is instant on entering; on leaving, the layout switch still lands only once the motion ends, a moment after it.
- **Top bar:** Settings, Edit, Search and Add cross-fade into Done on the left and "N selected" in the middle (iOS), or ✕ on the left and "N selected" as the title (Android). Done, ✕ and the Android Back button only leave Edit mode: every change applies at once and is saved on the phone, so there is no Cancel.
- **Rows:** a selection circle slides in from the left while the row content moves right, iOS Mail style: an empty thin ring (`mutedForeground`, softened) when not selected, a filled `primary` circle with a `primaryForeground` check when selected, the same in light and dark themes. Its touch area is the whole height of the row and wider than `RULE.touch` (44 pt). A ≡ handle fades in on the right; the time and unread dot stay visible, left of it. A tap toggles the selection; it does not open the chat. A screen reader announces "selected" or "not selected", and each row and section header offers **Move up** and **Move down** inside its own group.
- **Pinned avatars:** a small selection badge scales in at the top left of each avatar, and a small move handle at the top right, the same for every avatar, the concierge included; an unread dot moves down to the bottom right, clear of both. A tap toggles the selection. The move handle drags the avatar left and right inside the pinned area, across wrapped lines, and the pin order stays on this phone; dragged down and dropped over the rows list, the avatar is unpinned there (see **Dragging**). Screen readers get **Move left** and **Move right** with the same rules, and hear "selected" or "not selected".
- **Dragging:** only a handle starts a drag, and it starts at once, like the iOS reorder control, so a tap on a row still toggles it and a swipe on a row (or a very fast flick from a handle) scrolls the list. Drop a row inside its group to reorder it, or in another group to move it there: a section, No section (anywhere above the first section header), right under an empty section's header, or right under a collapsed section's header, where it joins that section at its top. Touching a section header's handle shows only the section headers, with the touched one still under the finger; after the drop the sections take their new order and the list comes back. The list scrolls by itself when a dragged item nears its top or bottom edge. A light tap marks the pick-up and the drop when Haptics is on. A drop that changes nothing writes nothing; an agent that disappears while it is dragged is not moved, and the list redraws without it. A row can also leave the list: dropped over the pinned area it is pinned at the spot under the finger, and a pin dropped over the rows list is unpinned and placed at that spot, joining the section the spot is in (right under a collapsed header: that section, at its top). For a pin, everything below the top of the rows list counts: dropped under the last row it lands at the end of the list, and with every agent pinned the empty list still takes it. Only the part of the list on screen counts: a release over the top bar or the Edit bar is no drop. While the finger is over the other area a small `primary` marker shows the spot: a thin vertical bar between two avatars, a thin horizontal line between two rows, or, on the empty pinned skeleton, its middle ghost avatar; it only moves and fades, and it hides as soon as the finger leaves that area and on the drop. While a row is over the pinned area the rows keep the gap where it came from, and the lifted row fades to about a quarter, its background clear and its shadow gone, so the avatars and the marker show through it; it comes back when the finger leaves the pins. At the drop the dragged item cross-fades into the new avatar or row at the drop spot. A row dragged up in a long, scrolled list scrolls it up to the very top, the pinned area included; a pin dragged down scrolls to the end of the list. Pin and Unpin go to Hermes; the section goes only when it changed. Rows and section headers have a fixed height in and out of Edit mode, so their text grows with the system text size only up to `RULE.maxFontScale` (1.4 times); the bottom bar's labels carry the same cap.
- **Drop skeletons:** in Edit mode, where an agent can be dropped but nothing is yet, a quiet dashed skeleton shows the spot. With nothing pinned, the pinned area shows three ghost avatars (`SIZE.giant`, 88 pt, a dashed `mutedForeground` ring at low strength, no fill), centered like real pins, with "Drag an agent here to pin it" under them in `mutedForeground`, exactly one line of pins high; screen readers hear "Pinned agents, empty. Drag an agent here, or select one and choose Pin." An expanded section without agents shows one ghost row under its header: a row-high dashed rounded outline inside the page padding, with "Drag agents here" in the middle; a row dropped right above or below it joins that section, and swipe to select skips it like a header. A collapsed empty section shows none (a row dropped right under its header still joins it). The skeletons fade in and out with Edit mode's progress; the rows below the pinned skeleton slide by its height as it comes and goes. Outside Edit mode neither shows.
- **Full-bleed rows:** the list runs edge to edge, with the page padding inside each row and section header: a lifted row is not clipped at the sides, the scroll bar sits at the screen edge, and a row's tap highlight spans the whole width, the ≡ column too. A tap on the ≡ column never toggles the row; it only drags.
- **Swipe to select** (the iOS Mail convention): a touch that starts on a row's selection circle belongs to selection, not to scrolling. Moving up or down from there selects one contiguous range, from the start row to the row under the finger; when the start row was already selected, the swipe deselects the range instead. A row the finger leaves again (moving back) returns to how it was before the swipe. Section headers are skipped. The pinned avatars above the rows list get the same swipe: a touch that starts on a pin's selection badge and moves selects or deselects a range in pin order, across wrapped lines; a swipe that starts on a pin stays within the pins, and a plain tap on the badge still toggles just that one. While the finger is within about 60 pt of the list's top or bottom edge, the list scrolls by itself, faster closer to the edge, and the range keeps growing with the rows that come under the finger; it stops at the list's ends. A swipe on a row's body still scrolls the list, and the ≡ handles still drag.
- **Bottom bar** slides up when at least one agent is selected and down when none is: **Move to…** opens the Move to Section page for all selected agents; **Pin** / **Unpin** says "Unpin" when every selected agent is pinned, and Pin appends the others to the pins in list order; **Hide** hides each agent with its own gateway call, and when some calls fail one alert names the agents that were not hidden; **Mark read** / **Mark unread** says "Mark read" when at least one selected agent is unread. After an action the selection clears and Edit mode stays open.
- A roster refresh keeps the selection for agents that are still shown and drops the rest; collapsing a section drops the selection of its rows for good, so expanding the section again does not restore it.

### Bot actions

Long-press a conversation or pinned avatar to open a compact action menu. Provide the same actions through the agent details overflow and native accessibility actions, so long-press is never the only route. Keep the highlighted row visible behind the menu; use an opaque `popover` surface and neutral icons. Dismiss on outside tap or Back, and return focus to the trigger.

One menu, mirroring the Hermes Desktop context menu: no "More" level, groups separated by thin hairlines instead. A separator never opens or closes the list, and never appears twice in a row (e.g. when Select is absent for a given screen, its group still reads right).

| Group | Action | Behavior | Phase |
|---|---|---|---|
| 1 | Pin / Unpin | Shared with Hermes Desktop (`pinned`). Preserve section membership; unpin returns to the assigned section | 1 |
| 1 | Move to › | Replaces the menu's content in place (same anchored card) with the Move level: a "‹ Move to" header back to the main level, then "No section" and every section in order, each with a check mark on the bot's current place (folder icon elsewhere). Tapping a row moves the bot there (to the end of that group) and closes the menu; tapping the current place just closes. A separator, then "Create section" opens the Create level: a "‹ Create section" header, a soft name field (placeholder "Section name", autofocused) and a primary **Create** button, disabled for a blank name; Create makes the section, moves the bot into it and closes. The keyboard never covers the field or the button | 1 |
| 1 | Mark as Unread / Mark as Read | Device-local reading marker; opening the conversation clears the manual unread flag | 1 |
| 2 | Edit Bot | Opens the editor below; also available directly from agent details | 1 |
| 2 | Select | Home only: opens Edit mode with this agent already selected | 1 |
| 3 | Copy ID | Copy the profile identifier with its gateway label; no URL credentials or access token | 1 |
| 4 | Hide / Unhide | Shared Hermes bot metadata; removes from the usual roster without pausing work or muting notifications. Settings > Hidden Bots provides recovery | 1 |
| 4 | Delete | Confirm the named bot and data affected; stop work, settle pending approvals, clean up owned routines/subscriptions, then delete. Not shown for the default concierge | 1 |
| — | Share as Template | Review a sanitized configuration snapshot before export; exclude credentials, conversation history, memory, files and active routines by default | 2 |
| — | Duplicate | New identity from a reviewed configuration snapshot, with fresh provisioning and separately approved tool access. Do not copy secrets, history, memory or active schedules | 2 |

Template and duplication actions are part of the design and remain absent until Phase 2 is implemented. Hide is reversible and neutral; Delete uses `destructive`. Deletion cleanup and failure recovery must pass the lifecycle gate in 11. Moving to a section is an organization feature, not a group chat. Pins and each agent's section are shared with Hermes Desktop through `ui_meta['hermes-bots']` (docs/05); saving any other field keeps them.

The Edit mode bottom bar's "Move to…" still opens the separate Move to Section page for several agents at once: No section and every section, with a check mark on a section only when every chosen agent is in it, and a soft "New section name" field with **Create section** (disabled while the name is empty). Tapping a row, or Create, moves every chosen agent to the end of that group and goes back. Collapsible sections (the collapse state stays on this phone); changing membership preserves pin state. Removing a section returns unpinned members to the ordinary list and keeps pinned members pinned.

### Chat

- Header: Back, compact avatar/name button, and an Activity button only when relevant. Agent name opens details. No Computer icon or model/usage toolbar in the default header.
- Header surface is opaque or sufficiently filled; scrolling messages never reduce its legibility. Insets keep the latest content clear of header and composer.
- Assistant and user bubbles use the mapped tokens. Event rows are smaller and unboxed. Timestamps appear at useful breaks and through message details rather than on every bubble.
- While working, show one short line such as “Linh is working” and a Stop action. Tool details, subagents, and available reasoning are behind Activity, collapsed by default. Do not fabricate reasoning content.
- Composer: separate Attach button, rounded “Ask Linh” input, Mic when empty and Send when text exists. Keyboard Return inserts a newline; Send is explicit. Voice recording requires a clear recording state and cancel control.
- Use native keyboard insets and safe-area handling. Preserve scroll position and drafts through backgrounding. Follow new output only when the user is already at the bottom; otherwise show a jump-to-latest control.
- Approval and creation cards appear inline with the same radius and typography, concise action descriptions, and explicit actions. Requests remain accessible from Activity after reconnect. Technical configuration and raw protocol errors stay in details/debug views.

### Settings and agent details

- The account avatar opens Settings, a modal sheet with a close ✕ and a centered title. From the top: a header with the connection's avatar, name and address; a group without a caption with **Gateway** (a sub-page with Sign-in, Connection, Backend and the connection id for push links); **Make it yours** with Notifications (for all agents), Appearance (its subtitle names the mode and theme, such as "System · Nous"; a sub-page with System, Light and Dark and the theme list, each with a check mark on the current choice), a Haptics switch and Hidden bots; **About** with the Ergates version, the Hermes pin and Privacy; then the **Sign out** button. Every row has a leading line icon. Usage appears here once the app can show it. Gateway and Appearance push inside the same modal, with the normal back chevron.
- Show measured usage and its unit. Do not invent a subscription percentage for providers that expose only tokens or cost estimates.
- Agent details puts **Edit Bot** first, followed by routines, tools/connectors, memory and files, with an overflow for the roster actions above. The editor contains model and instructions. Advanced holds approvals mode, terminal configuration and iteration settings; labels explain their actual scope.
- Permission switches distinguish “Applying…” from “Off”; do not claim a live connector is disabled until the enforcement transition in [04](04-security-and-compliance.md#5-least-privilege-tool-model) completes.
- Notification toggles are effective server subscription settings once the integration supports them; a phone-only preference cannot stop the ntfy service publishing.
- Timezone changes affect display by default. Editing a recurring routine's timezone shows its next run for confirmation; travel must not silently rewrite existing schedules.
- Offer only implemented destinations. Do not reproduce vendor subscription, legal, Computer, Auto-review Rules, or Help Center rows that have no Ergates implementation.

### Edit Bot on mobile

Mobile provides desktop-equivalent bot editing in a full-height sheet or pushed screen. A stable header contains Cancel as a soft grey pill on the left, **Edit Bot** centered, and Save as a primary pill on the right. The avatar sits centered with full-width soft **Choose photo** and **Remove photo** buttons below it; Name, Role and Description are soft fields; Instructions, Provider / Model and Capabilities are rows inside groups, each group with a small caption. The basic form is short; long instructions and capability lists open focused subpages that return to the same unsaved draft. Opening a picker does not save. Routines, memories and files remain separate destinations.

| Field | Mobile presentation / persistence |
|---|---|
| Name | Friendly display name, stored as `ui_meta['hermes-bots'].title`, matching desktop Bot Mode. The underlying profile identifier stays unchanged |
| Avatar | Preview, choose/replace/remove photo, or initials/shape fallback; existing desktop shape/color remains representable. Compress/convert before the 2,000,000-byte PNG/JPEG/WebP asset limit |
| Role | Optional short badge, e.g. “Dining scout”; proposed `ui_meta.ergates.role`, separate from Hermes's `title`, which is the display name |
| Description | Short purpose statement in Hermes profile metadata |
| Instructions | Multiline `SOUL.md` editor; preserve the existing text and any required messaging protocol, never silently replace it with the description |
| Provider / Model | Server-supported picker plus custom model name; show model-specific confirmation when required |
| Skills / Tools / Connectors | Searchable capability subpages with staged changes and accurate current/effective status; narrower tool access by default |
| Notifications | Per-agent subscription preference, saved through the server attention integration; show pending/unavailable state until confirmed |
| Advanced | Supported reasoning effort, approvals mode, terminal and iteration settings through separately verified config calls; do not send unknown fields to `profiles.configure` |

Source parity: `apps/desktop/src/plugins/hermes-bots/edit-profile-dialog.tsx` and `profile-config.tsx` at the pin support appearance/title/description plus model, SOUL, skills, toolsets and MCP. `labels.ts` confirms that desktop **Title** is a friendly name, not a separate role badge. The explicit mobile role and subscription fields are Ergates additions. User-initiated edits call authenticated profile/config operations directly; they do not require the concierge proposal flow.

Load current values and metadata revisions on entry, stage only changed fields, and enable Save only for a valid dirty form. Cancel discards the draft; closing a dirty form offers Keep Editing or Discard. Offline edits may remain an encrypted draft, but never report “Saved” or automatically apply stale configuration on reconnect. Refetch before saving after reconnect.

Save retains the screen while it runs. Use per-key `ui_meta_expected_revisions`, preserve unrelated/unknown metadata, and reconcile a conflict against the fresh server version before an explicit retry. These revisions protect metadata only: SOUL, model, capability and asset writes lack an established atomic cross-field/version contract. Compare fresh values before writing; require a serialized integration check if conflict-free concurrent editing is promised. Never label the whole form atomic.

Inspect each `applied` result, the separate avatar response, and notification save. On partial failure, show which sections saved and keep failed edits available for retry; Cancel cannot roll back sections already saved. A model-confirmation response resubmits only that section after the user's decision. Do not copy the desktop's immediate capability side effects into a form that promises Save/Cancel.

Refresh Home, search, pinned labels, chat identity and details after confirmed saves. Model/instruction changes apply between turns according to verified lifecycle behavior; tool revocation stays “Applying…” until stop/rebuild/verification finishes. Keep the profile id, chat, memories, files and routines intact when changing the display name. Actual profile-directory renaming is a separate migration operation, outside this editor.

## 4a. Design system

The app's look is three tiers. A screen points to a step or a named rule, never to a raw value.

| Tier | What it holds | Where it lives |
|---|---|---|
| Tokens | Colors (the vendored Hermes semantic palette, section 3), the step scales (`SPACE`, `RADIUS`, `ICON_SIZE`, `SIZE`, `OPACITY`), the named rules (`RULE`) and the type scale | `src/theme/` (`tokens.ts`, `color.ts`, `contrast.ts`) |
| Components | `Page`, `Screen`, `Sheet`, `Group`, `ListRow`, `Field`, `Button`, `IconButton`, `Avatar`, `RowContent` and the other shared pieces, built only from tokens | `src/ui/` (chat pieces such as `Bubble` in `src/ui/chat/`) |
| Screens | Routes that compose components | `app/` |

### Steps, not component sizes

1. Never name a token after a component. A component points to a step; the step does not know who uses it.
2. A value between two steps takes the nearest step. A value exactly halfway goes down, so nothing grows. A value below the smallest step takes the smallest step.
3. `0` is always allowed. Computed values (`size / 2`, `Math.round(size * 0.68)`, `progress.get()`) are allowed.
4. Drag and motion geometry (row offsets, item heights used by drag math, animation progress) is not a design value. It stays as named constants in its own module (`src/ui/home-list/`, `src/features/agents`).
5. A value that is neither a step nor geometry is a named rule in `RULE`, named by what it means, not by who uses it.

Colors keep their Hermes names (`background`, `primary`, `muted`, `userBubble` and the rest). They are roles that come from Hermes Desktop, so the app does not rename them.

### Scales

Each scale lists its steps from small to large, in points, except opacity: a fraction from 0 to 1, listed from the most to the least visible. A step name is a whole word, never a component.

| Scale | Steps |
|---|---|
| Space (`SPACE`): padding, margin and gap | `hairline` 2, `extraSmall` 4, `small` 8, `medium` 12, `large` 16, `extraLarge` 20, `huge` 24, `giant` 32 |
| Radius (`RADIUS`): corner radius | `small` 8, `medium` 12, `large` 16, `extraLarge` 20, `huge` 24, `giant` 28, `full` 9999 (a pill or a circle) |
| Icon size (`ICON_SIZE`): icon glyphs | `small` 16, `medium` 20, `large` 24 |
| Size (`SIZE`): width and height of avatars, controls and rows | `tiny` 8, `extraSmall` 20, `small` 28, `medium` 40, `large` 48, `extraLarge` 56, `huge` 64, `giant` 88 |
| Opacity (`OPACITY`), from the most to the least visible | `strong` 0.65, `medium` 0.45, `faint` 0.25 |

A pressed control uses `OPACITY.strong` and a disabled one `OPACITY.medium`. `SCRIM` (`rgba(0,0,0,0.25)`) stays: the backdrop behind the action menu, the one fixed color, the same on every theme.

An avatar takes a `SIZE` step from `extraSmall` up. The page padding is `SPACE.extraLarge`, and `SPACE.large` on a narrow screen.

### Type

Size and weight only. There is no line height in a role, because Home rows have fixed drag heights; the multi-line roles in the leading table set their own.

| Role | Size | Weight |
|---|---|---|
| `largeTitle` | 28 | 600 |
| `title` | 22 | 600 |
| `title3` | 20 | 600 |
| `headline` | 17 | 600 |
| `bodyStrong` | 17 | 500 |
| `body` | 17 | 400 |
| `calloutStrong` | 15 | 600 |
| `callout` | 15 | 400 |
| `footnote` | 13 | 400 |
| `footnoteStrong` | 13 | 600 |
| `caption` | 12 | 400 |

Line heights for wrapping text (`LEADING`): `body` 24, `callout` 22, `footnote` 18.

### Named rules

`RULE` holds the values that are neither a step nor drag geometry. Each is named by what it means.

| Rule | Value | Meaning |
|---|---|---|
| `touch` | 44 | The smallest hit area of a control. It is never snapped to a step: a control smaller than this lifts its hit area to it with hit slop |
| `narrowScreen` | 360 | Window width below which the page padding drops to `SPACE.large` |
| `maxFontScale` | 1.4 | How far text in a fixed-height row grows with the system text size (a multiplier, not points) |
| `panelWidth` | 240 | Width of a floating panel, such as the action menu |
| `textAreaMinHeight` | 128 | Minimum height of a multiline field |
| `stackedTableWidth` | 400 | Window width below which a Markdown table is drawn as stacked lines instead of columns |
| `labelMaxWidth` | 113 | The widest a short label, such as a role beside a name, grows before it truncates |
| `fileNameMaxWidth` | 200 | The widest a file name, such as an attachment waiting to be sent, grows before it truncates |
| `floatingBottom` | 96 | How high a floating control sits above the bottom of the screen, clear of a one-line input bar and the home indicator |

### Contrast

`contrastRatio` and `rate` (WCAG 2.x: AAA from 7, AA from 4.5, AA large from 3, otherwise Fail) measure the pairs the app paints, listed in `CONTRAST_PAIRS`: `foreground` on `background`, `muted`, `userBubble` and `popover`; `mutedForeground` on `background` and `muted`; `primaryForeground` on `primary`; `destructiveForeground` on `destructive`. A palette that fails a pair is reported on the design system page, not rejected.

### The guard

- Colors come only from `theme.colors`. No vendored palette value changes, and there is no mobile color fallback.
- A type role never carries a line height.
- Under `app/` and `src/ui/`, the guard rejects a numeric literal for `fontSize`, `fontWeight`, `lineHeight`, `letterSpacing`, `borderRadius` or `opacity` (except `0` and `1`), and any hex, `rgb(` or `rgba(` string.
- It also rejects a numeric literal other than `0` for a spacing key (`padding*`, `margin*`, `gap`, `rowGap`, `columnGap`) or a size key (`width`, `height`, the min and max forms, `top`, `right`, `bottom`, `left`), a numeric literal for the `size` prop of an element, and a module-level `const` with a numeric initializer other than `0` and `1` whose name says it is a size, radius, width, height, padding, gap, inset, spacing, margin, opacity, leading, line height, weight, font or touch value.
- Both branches of a conditional are checked. Computed values and `0` pass.
- `GEOMETRY` lists the few files that keep drag, motion or platform geometry in named UPPER_CASE constants: the native iOS switch frame in `SwitchRow` and the pin cell width in the Home list's pinned area. Each entry names its constants and gives its reason. Only those constants pass: an inline number or another constant in the same file is still reported, so a new design value cannot hide behind the entry.
- `borderWidth` and durations are not checked, because there is no stroke or duration scale yet.

`apps/mobile/test/design-tokens.test.ts` enforces this by parsing every `.tsx` file under `app/` and `src/ui/`. Each of its two checks lists every offender as the file, the line, the key and the text. The check for type, radius, opacity and color values says to use a step or a type role from `src/theme/tokens.ts`, or a color from the theme; the check for spacing and size values says to use a step from `src/theme/tokens.ts`, or a named rule for a length that is neither a step nor geometry. `src/theme/tokens.test.ts` pins every step and rule and fails when a key is named after a component.

### Design system page

Development builds have Settings › Developer tools › Design system. It opens on an index: a Preview group (Appearance, which opens the same System/Light/Dark and theme picker as Settings › Appearance, and Reset; the preview applies to every design-system page and does not change the owner's Appearance setting), then Foundations (Colors, Contrast, Type, Space and shape) and Components (Button, Icon button, Field, List row, Group, Avatar, Row body, Bubble). Each row shows a one-line summary, such as the number of contrast pairs below AA, and opens the section on its own page: the colors of the active theme (tap a row to copy the token name), the contrast pairs with their ratios and ratings, the type roles, every step scale with the named rules (space as bars, radius and size as squares, icon size as an icon at each step, opacity as a swatch at each level), or live samples of one shared component. The Avatar page shows an avatar at each size step from `extraSmall` up. The section list lives in `src/features/design-system/sections.ts`. The row and the routes exist only when `__DEV__` is true; in a release build the route redirects to Settings and the row is absent.

## 5. Essential states

| State | What stays simple and explicit |
|---|---|
| First launch | Connect a gateway, then open the concierge; no empty dashboard |
| Offline | Small connection line; preserve drafts; queued-unsent messages clearly marked |
| Delivery uncertain | “Delivery unconfirmed”; inspect history before a deliberate retry; never silently duplicate an action |
| Approval expired | Card says Expired; action buttons disabled; retry starts a fresh request |
| Agent provisioning interrupted | “Setup incomplete”; resume only after checking existing profile/receipt |
| Empty search | One explanatory line and a clear dismiss path |
| Large text | Wrap settings and message text; hide optional role badge before compressing names. A text-size change while the app is open re-lays out every page at once: page content remounts, so scroll position, focus, open menus and expanded rows reset, while typed drafts and clarify answers stay |
| Reduced motion | Static working indicator; native transitions reduced; no perpetual decorative animation |
| Server plugin missing, off, not loaded, waiting for a restart, outdated, updatable or unavailable | One short sentence and, when the user can fix it, a button to the screen that does (server plugin screens below). Chat keeps working |
| Server restarted during setup or an update | The Finish screen says "Your server restarted. Sign in again to continue." with a Sign in again button; the plugin's setup still runs after sign-in |
| Server address graded unsafe | One sentence says why, with the **How to stay private** link. The sign-in fields stay hidden and no password or token is sent. Connect and Sign in again follow the same rule |

### Connect and sign in

Before the app signs in, it grades the server address (03 section 4, ADR-045). The Connect screen (`app/connect.tsx`) asks for a name and a gateway URL. The Check button reads the server's status, and once the server has answered, a grade line appears under the button with a link to the server guide on middelkamp.dev. The sign-in fields and the Connect button come after the line, so the user reads the grade before typing a secret. Changing the URL clears the grade and any refusal.

In the first four lines, `{version}` is the Hermes version the server reported. A `*.ts.net` name gets the public line, because the app cannot tell a Tailscale Funnel name from a tailnet-only one (ADR-045).

| Grade | Line | Link |
|---|---|---|
| Private, on this device | Hermes {version}. Private: this server runs on this device. | Server guide (`#private-access`) |
| Private, a Tailscale IP address | Hermes {version}. Private: Tailscale encrypts this connection. | Server guide (`#private-access`) |
| Private, on the local network | Hermes {version}. Private: a server on your local network. | Server guide (`#private-access`) |
| Public, also a `*.ts.net` name | Hermes {version}. Ergates treats this address as public, so anyone on the internet may reach it. Use a password of at least 12 characters, or connect over Tailscale. | Server guide (`#public-access`) |
| Unsafe, a public address over `http` | This address may be on the public internet without encryption. Ergates connects to a public server only over https. | How to stay private (`#private-access`) |
| Unsafe, a public address that signs in without a password | This public server signs in without a password. Ergates connects to a public server only with a password. | How to stay private (`#private-access`) |

- The public line says what the app does with the address: it treats it as public.
- A public address over `http`, and a `*.ts.net` name over `http`, is refused when the user taps Check, before any request. The refusal shows in the error style with its link under it, and the screen shows no sign-in fields and no Connect button.
- A public address that signs in without a password shows its line and link. The sign-in fields stay hidden and the Connect button stays disabled.
- On a public server a password under 12 characters is refused before any login request, with "On a public server, use a password of at least 12 characters." in the error style. On Connect the message shows under the Connect button, with the Server guide link above it. The length counts Unicode code points and the password is not trimmed.
- A link that cannot open shows an alert titled "Could not open the guide" with the address.

Sign in again (`app/sign-in.tsx`) applies the same rules to a saved connection. A refusal shows its message in the error style, with the matching link under it ("How to stay private" for an unsafe grade, otherwise "Server guide").

Settings › Gateway has a Connection row with a shield icon between Sign-in and Backend. Its subtitle is the grade label: "Private (this device)", "Private (Tailscale)" (a Tailscale IP address), "Private (local network)", "Public, encrypted" (a `*.ts.net` name included) or "Unsafe". The app works it out from the saved address and the saved sign-in mode, with no request. The Sign-in row's subtitle is "Session token" or "Username and password".

### Server plugin screens

Home, Settings and every feature that needs the Ergates plugin read one server check (03 section 4, ADR-043) and say what it found in place, in the words of the table. A button opens the screen that fixes it. A new routine, notification settings and an agent proposal card in chat show the sentence where they would otherwise show "Not found". The form for a new routine disables Save while the plugin cannot take the routine.

| The server check finds | Sentence | Button |
|---|---|---|
| No plugin | Ergates is not set up on this server. | Set up |
| Plugin turned off | The Ergates plugin is turned off on this server. | Turn on |
| Plugin enabled, Hermes has not loaded it | Hermes has not loaded the Ergates plugin yet. | Show me how |
| Plugin files changed, Hermes still runs the old code | Restart Hermes to finish the plugin update. | Show me how |
| Plugin older than this app needs | The Ergates plugin on this server needs an update. | Update |
| Plugin works and this build carries a newer one | An update for the Ergates plugin is ready. | Update |
| Plugin needs a newer app | This server's Ergates plugin needs a newer version of this app. Update Ergates. | none |
| Plugin cannot open its data | The Ergates plugin cannot open its data on this server, followed by the server's own reason | none |

On Home the sentence is one tappable line in the style of the error line, and a tap anywhere on it opens the screen. When Home has an error line, that line is shown instead. A check that answers 401 makes it the sign-in line, even when the roster failed for another reason. The update line for a plugin that works is in the muted color, because it offers something and reports no fault. It shows only where the update neither opens a screen nor runs by itself. The Update button opens the Update ready screen. For an outdated plugin the app may not update (a deployment, a manual copy, or a build without a commit) it opens the Finish screen. In Settings › Gateway the Ergates plugin row shows the plugin's version, or the sentence, and opens the screen when there is a button. While an update is ready the version reads like "0.2.0 (update to 0.3.0 ready)", and the row opens Update ready. Under the plugin row, a row with the switch "Keep it up to date automatically" turns the automatic updates of this connection on or off. A check that could not reach the server shows no sentence, and the screen behaves as it did before the check. The Settings row then says "Could not check".

A new routine, notification settings and a proposal card call the plugin themselves. When their route answers 404 while the last check said ready, the screen checks again and shows "Checking your server…" in the muted color. Once the new check answers, it shows that check's sentence, or its own error when the server still says the plugin is ready.

After Connect and after Sign in again the app opens the screen itself. Update ready opens for an update the app has not asked about yet, once for each update, and never with the switch off. Set up your server opens for a missing or turned-off plugin. Finish on your server opens for a plugin that is not loaded, that waits for a restart, or that is outdated without an update the app can make. An outdated plugin whose update was asked about goes Home, where its sentence carries the Update button. Anything else goes Home.

The Set up your server page is pushed, with a back button. It says what the plugin is for ("Ergates needs its plugin on your Hermes server for routines, new agents from chat and notification settings. Chat works without it."). Under that, one source line names what gets installed and from where: the plugin version, `github.com/middelkampdev/hermes-ergates` and the first seven characters of the commit. A note below says that Hermes calls the source unreviewed, because the plugin is not in the Hermes plugin catalog yet, and that the server downloads it from GitHub and runs Hermes's security check before it installs. The buttons are **Set up this server** and **Not now**. A turned-off plugin gets "The Ergates plugin is on your server but turned off." and **Turn it on**. A Hermes older or newer than the tested versions, or one whose version the app cannot read, gets a note that says why and **Show me how**, which opens the Finish screen. A build without a commit gets "This build of Ergates does not know which plugin version to install." and **Not now** only. Under the note, a card holds the switch **Keep it up to date automatically**. It is on by default and applies to this connection.

While a run goes, the page shows four steps in a group: Installing the plugin, Turning it on, Starting it, Setting up your agents. Each has a leading icon: an empty circle while it waits or runs, a circled check when it is done, a plain check when it was not needed, and a cross in the destructive color when it failed. A running step also shows a spinner at the end of its row. A screen reader hears the step and one of "waiting", "in progress", "done", "not needed" or "failed". The run ends in one of four ways. When it is done, the page says "Your server is ready." and shows **Done**; a profile that could not be turned on is named under it. When Hermes refused the install, or the plugin needs a restart, the page opens the Finish screen. When something else failed, the page shows the message with **Try again**. When the server asks for a new sign-in, the page says so with **Sign in again**. A screen that opens while a run is going joins it and shows its steps.

The Update ready page is pushed, with a back button. It reads "Ergates server plugin <new version> is ready for your server. You have <installed version>." When the server has the same version in an older build, which the app replaces only when that build's API level is below the app's, it reads "This app needs a newer build of Ergates server plugin <version>. Your server has an older build." Under that, a source line gives the repository and the first seven characters of the commit, "From github.com/middelkampdev/hermes-ergates, commit <seven characters>.", and a note says "Hermes has to restart to finish the update. Ergates shows you how." The note is left out for a connection that learned its Hermes starts a new plugin without a restart. Under the note is the same card with the switch **Keep it up to date automatically**. The buttons are **Update now** and **Later**. Opening the page records that the user was asked, so with the switch on it opens by itself once for each update, and Back, **Later** and **Update now** all count as asked. After that the update shows as a line on Home. With the switch off, no screen opens by itself and the line on Home is the only offer.

While the update runs, the page shows four steps like the setup page: Turning the old version off, Installing the update, Starting it, Setting up your agents. The run ends in one of four ways. When it is done, the page says "The plugin on your server is up to date.", names a profile that could not be turned on, and shows **Done**. When Hermes refused the update or has to restart, the page opens the Finish screen; a restart to ask for leaves Starting it waiting, not failed. When something else failed, the page shows the message with **Try again** and **Later**. **Try again** asks the server again and installs only the update the new answer still offers. When the server asks for a new sign-in, the page says so with **Sign in again**. An update whose first look at the server finds that the offer changed (another phone updated the plugin, or Hermes waits for a restart) changes nothing, and the page shows what the server offers now. A page that opens when no update is left to make (another phone did it) says "The plugin on your server is up to date." with **Done**, and one that cannot reach the server says "Could not reach your server." with **Try again** and **Not now**. A page that opens while an update is running joins it.

A connection that learned its Hermes remounts a new plugin without a restart updates without asking. Home then shows one muted line, "Ergates updated the plugin on your server to <version>.", or "Ergates updated the plugin on your server to a newer build of <version>." when the version stayed the same, and the line goes when Home loses focus. A run without asking that fails leaves the Home line with the Update button.

The Finish on your server page serves every case where the user acts on the server. Its heading reads "Finish on your server", or "Update your Ergates deployment" for a deployment. The page shows:

- one or two sentences of why, for example that Hermes refused the install, that the plugin is on the server but turned off, or that it needs an update;
- the command to run on the server in a monospace box with a **Copy** button;
- the heading "Then restart Hermes:" and four ways to restart, when a restart is needed;
- a status line, "Checking…", "Waiting for your server…" or "Your server is ready.", set as a live region for screen readers;
- **Check now**, which becomes **Done** once the server answers and its setup went through, and **Sign in again** when the server asked for it;
- **Open the guide**, which opens `https://middelkamp.dev/ergates/server/` at the part that fits the case (`#manual`, `#restart` or `#deployment`).

The page asks the server every 5 seconds while it is in view. When the plugin answers, the page runs the plugin's setup by itself and clears the instructions. After a restart the page offers **Sign in again** in place of the command, and the guide button changes to **How to stay signed in** (`#stay-signed-in`).

After an update the page has more cases, and it asks the server the same way. When the files on the server are newer than the code that answers, whether the app or someone by hand installed them, the sentence reads "The update is installed. Restart Hermes to start the new version." with the four ways to restart and no command. A ready server whose pending setup waits for other code than the code that answers keeps these instructions and "Waiting for your server…" until that code answers. Once the page has seen a sign that Hermes restarted (the server did not answer, it asked for a new sign-in, or the old code stopped answering), a plugin that still does not come up reads "The new version did not start." The button then reads **Go back to the previous version**, and under the sentence "To go back yourself, run this on your server, as the user that runs Hermes:" the page shows the update command for the previous commit with a **Copy** button, then the restart lines. While the go back runs, the page shows four steps (Turning the new version off, Installing the previous version, Starting it, Setting up your agents) and "Going back to the previous version…", and offers no button. When the update changed how Ergates keeps its data and the previous version could no longer write it, the page instead says "The update changed how Ergates keeps its data, so the previous version cannot be put back." and shows no command. Once the go back's install is confirmed, the update is over, and the page offers no second go back. The connection keeps that the previous version is back, so the page says the same after a relaunch, as long as the server has that commit. A server that still runs the code of the failed version reads "The previous version is installed. Restart Hermes to start it." A ready one ends with "The previous version is back. Your server is ready." An outdated one reads "The previous version is back, but this app needs a newer plugin. The update did not start on your server." and "The guide shows what to check before you try again.", with **Open the guide** and no command; the Home notice keeps its **Update** button for a new try. A server whose plugin is outdated and cannot be updated by the app still gets the command with `--force`. The page keeps what it saw of the restart, and the highest store version the server named, for each connection, so it does not lose them when Sign in again replaces it.

The sign-in screen carries one line that says Hermes signs the user out after a restart unless the server has a fixed sign-in secret, and a **How to stay signed in** link to the same part of the guide.

## 6. Visual acceptance

Compare Home, Chat (keyboard open/closed), Search, Add menu, bot action menu/More, Edit Bot (basic and advanced), Settings and an approval card against the supplied reference layouts. Check on 320–430 logical-pixel widths, iPhone safe areas, Android, both Nous appearances, and large text. Verify screen-reader labels, focus return after sheets, non-color state indicators, and contrast on every mapped surface. Theme switching must recolor all surfaces and controls without changing layout or resetting the conversation. Exercise Save, Cancel, dirty dismissal, partial failure, concurrent metadata edits and a model/tool change during an active turn. Confirm a display-name edit appears across Home/search/chat while the same profile and transcript remain selected.

The conversation preview illustrates this direction with sample content. It is not a working mobile build; this document and the implementation checks remain authoritative.

Section acceptance: assign Linh and Kevin to Prive; pin both and verify no duplicate rows under Prive. Unpin each and verify it returns to Prive; repin and verify membership persists. Repeat with Prive collapsed and after an app restart. Verify moving a pinned member to another section preserves its pin, collapsing Prive leaves pinned avatars visible, and deleting the section clears membership without unpinning its members. These checks are required for Phase 1; the earlier preview check does not establish this behavior.
