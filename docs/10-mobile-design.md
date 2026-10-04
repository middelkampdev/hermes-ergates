# 10 - Mobile Design

Version: 0.4. Date: 2026-10-04. Direction: requested by Jop. Implementation status: specification; no mobile app exists yet.

## 1. Design direction

A quiet messaging app for a small team of assistants. Use the layouts from the original mobile reference screenshots, which are not published: generous whitespace, circular avatars, flat conversation rows, rounded message bubbles, a compact composer, and grouped settings in a sheet. Colors come from Hermes's semantic theme system. Keep the main experience focused on conversations.

Home is a single screen, not a permanent multi-tab dashboard. The account avatar opens Settings, search opens a focused search view, and the plus button opens a compact creation menu. Routines, files, tools, model selection, and memory live behind the agent's name in chat. The board and catalog are secondary destinations when their phases ship.

## 2. Hermes theme source and resolution

Verified in the adjacent `hermes-agent` checkout at commit `d76856cc6971b6e0e1903b5369498bcc4bb83a60`:

| Source under that checkout | Role |
|---|---|
| `apps/desktop/src/themes/presets.ts` | Built-in palettes; `DEFAULT_SKIN_NAME = 'nous'`; light `colors` and dark `darkColors` |
| `apps/desktop/src/themes/types.ts` | `DesktopThemeColors` semantic token contract |
| `apps/shared/src/skin.ts` | `HermesSkin` payload from the backend |
| `apps/desktop/src/themes/skin.ts` and `color.ts` | Pure `skinToDesktopTheme` conversion and color helpers |
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
| Page padding | 20; 16 on narrow devices | Respect safe areas; never overlap content with the status bar. The Home list runs edge to edge instead: the list spans the screen width and each row and section header pads its own content by the page padding, so a row's tap highlight, a lifted row and the scroll bar reach the screen edges while the content stays in line with the rest of the page |
| Bottom safe area | Content padding, not a reserved inset | Scrolling content runs to the bottom edge of the phone: its own scroll view is never inset there, and its content container adds the device's bottom inset (the home indicator on iOS, the edge-to-edge navigation bar on Android) on top of whatever bottom padding the screen already wanted, so the last row can still scroll clear of it. A fixed bottom bar (Home Edit mode's bar, the chat composer, any fixed bottom button area) draws its own background to the screen edge and pads its content by the inset instead, so its buttons sit above it. Where a device reports no bottom inset, nothing changes. While the keyboard is open, a `KeyboardAvoidingView` already pushes the view up by the full keyboard height measured to the physical bottom of the screen, covering the inset; padding is not added twice on top of it. |
| Spacing scale | 4, 8, 12, 16, 24, 32 | Use whitespace to group content |
| Body and composer | 17 / 24 line height | Native system font, scalable with device text size |
| Row name | 17, medium | One line normally; permit wrapping with larger text |
| Metadata | 13–15 | Legible contrast; accessible full value for truncation |
| Controls | At least 44 × 44 hit area | Simple outline icons; screen-reader labels |
| Icon button | 44 × 44 hit area; no border and no outline circle | Icon in `foreground`; dims while pressed or disabled |
| Field | Label above, 13, `mutedForeground`; input on `muted`, no border, radius 14, padding 14 × 13, minimum 50 high (128 when multiline), 17 text | `primary` selection color; an error shows as red text below, the input keeps its color |
| Button | Minimum 50 high; radius 16; 600-weight label | Primary on `primary`; secondary on `muted` with `foreground` text |
| List avatar | 48 | Circular image or initials fallback |
| Pinned avatar | 80–88 | Up to two prominent shortcuts; empty section hidden |
| Chat avatar | 28–32 | Part of the agent details button |
| Bubble | Radius 22; padding 12 × 16; max width 88% | Natural content width; assistant left, user right |
| Composer | Minimum 48 high; radius 24 | Grows up to five lines, then scrolls within the input |
| Settings group | `muted` card, radius 20, optional small caption above; row minimum 56 with a leading line icon, title, optional subtitle and a chevron when the row opens something | Hairline dividers inset past the icon to the text; labels wrap at large text sizes |
| Sheet | Radius 28 at top | Close button, native dismissal and Android back support |

Every size, radius, type and opacity value in this table is a named role in section 4a, `apps/mobile/src/theme/tokens.ts`.

Field, Card/Group and the secondary Button fill with whichever of `muted` or `background` reads more clearly against the surface they sit on — the page normally, a Sheet's `popover` inside one — so the fill stays visible in every theme's dark mode instead of nearly matching a sheet's own color.

### Home

- Top row: account avatar at left; Edit (a borderless text button on iOS, an icon on Android), Search and Add at right. No large marketing header, counts, charts, or permanent bottom tab bar.
- Optional pinned agents below. Which agents are pinned is shared with Hermes Desktop; the pin order is a device preference. On a new install the phone pins the concierge once, when Hermes has no pinned value for it; once pinned it has no fixed place, the same as any other pin.
- Rows keep the owner's order. A new message shows the unread dot and never moves the row; a new agent starts at the top of its group.
- Recent conversations: avatar, name, compact role badge when it fits, timestamp, one-line message or event preview. An unread dot includes an accessible unread label. Avoid cards or separators around each row. The list runs edge to edge: a row's tap highlight spans the screen width and the scroll bar sits at the screen edge.
- The Add menu contains New Agent; New Group Chat appears when Phase 2 rooms are available. Selecting an action closes the menu before opening its sheet.
- Search focuses its input. Phase 1 searches the loaded roster by name, role, and description; Phase 2 adds conversation-content search. State the selected scope in the input label. Closing search restores home position.

### Home sections and pinned members

Clarified by Jop on 2026-09-13; the original mobile reference screenshots are not published. A Home organization group is called a **section** in these docs; it does not create a shared conversation or a Hermes room.

- Show the section name, such as **Prive**, as small, regular-weight grey text with a chevron immediately beside it. Use Hermes `mutedForeground` with the contrast fallback above; avoid a card, filled badge or large heading. The whole heading has a minimum 44-point hit area and an accessible section name and expanded/collapsed state.
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
- **Rows:** a selection circle slides in from the left while the row content moves right, iOS Mail style: an empty thin ring (`mutedForeground`, softened) when not selected, a filled `primary` circle with a `primaryForeground` check when selected, the same in light and dark themes. Its touch area is the whole height of the row and wider than 44 pt. A ≡ handle fades in on the right; the time and unread dot stay visible, left of it. A tap toggles the selection; it does not open the chat. A screen reader announces "selected" or "not selected", and each row and section header offers **Move up** and **Move down** inside its own group.
- **Pinned avatars:** a small selection badge scales in at the top left of each avatar, and a small move handle at the top right, the same for every avatar, the concierge included; an unread dot moves down to the bottom right, clear of both. A tap toggles the selection. The move handle drags the avatar left and right inside the pinned area, across wrapped lines, and the pin order stays on this phone; dragged down and dropped over the rows list, the avatar is unpinned there (see **Dragging**). Screen readers get **Move left** and **Move right** with the same rules, and hear "selected" or "not selected".
- **Dragging:** only a handle starts a drag, and it starts at once, like the iOS reorder control, so a tap on a row still toggles it and a swipe on a row (or a very fast flick from a handle) scrolls the list. Drop a row inside its group to reorder it, or in another group to move it there: a section, No section (anywhere above the first section header), right under an empty section's header, or right under a collapsed section's header, where it joins that section at its top. Touching a section header's handle shows only the section headers, with the touched one still under the finger; after the drop the sections take their new order and the list comes back. The list scrolls by itself when a dragged item nears its top or bottom edge. A light tap marks the pick-up and the drop when Haptics is on. A drop that changes nothing writes nothing; an agent that disappears while it is dragged is not moved, and the list redraws without it. A row can also leave the list: dropped over the pinned area it is pinned at the spot under the finger, and a pin dropped over the rows list is unpinned and placed at that spot, joining the section the spot is in (right under a collapsed header: that section, at its top). For a pin, everything below the top of the rows list counts: dropped under the last row it lands at the end of the list, and with every agent pinned the empty list still takes it. Only the part of the list on screen counts: a release over the top bar or the Edit bar is no drop. While the finger is over the other area a small `primary` marker shows the spot: a thin vertical bar between two avatars, a thin horizontal line between two rows, or, on the empty pinned skeleton, its middle ghost avatar; it only moves and fades, and it hides as soon as the finger leaves that area and on the drop. While a row is over the pinned area the rows keep the gap where it came from, and the lifted row fades to about a third, its background clear and its shadow gone, so the avatars and the marker show through it; it comes back when the finger leaves the pins. At the drop the dragged item cross-fades into the new avatar or row at the drop spot. A row dragged up in a long, scrolled list scrolls it up to the very top, the pinned area included; a pin dragged down scrolls to the end of the list. Pin and Unpin go to Hermes; the section goes only when it changed. Rows and section headers have a fixed height in and out of Edit mode, so their text grows with the system text size only up to 1.4 times; the bottom bar's labels carry the same cap.
- **Drop skeletons:** in Edit mode, where an agent can be dropped but nothing is yet, a quiet dashed skeleton shows the spot. With nothing pinned, the pinned area shows three ghost avatars (84 pt, a dashed `mutedForeground` ring at low strength, no fill), centered like real pins, with "Drag an agent here to pin it" under them in `mutedForeground`, exactly one line of pins high; screen readers hear "Pinned agents, empty. Drag an agent here, or select one and choose Pin." An expanded section without agents shows one ghost row under its header: a row-high dashed rounded outline inside the page padding, with "Drag agents here" in the middle; a row dropped right above or below it joins that section, and swipe to select skips it like a header. A collapsed empty section shows none (a row dropped right under its header still joins it). The skeletons fade in and out with Edit mode's progress; the rows below the pinned skeleton slide by its height as it comes and goes. Outside Edit mode neither shows.
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

- The account avatar opens Settings, a modal sheet with a close ✕ and a centered title. From the top: a header with the connection's avatar, name and address; a group without a caption with **Gateway** (a sub-page with Sign-in, Backend and the connection id for push links); **Make it yours** with Notifications (for all agents), Appearance (its subtitle names the mode and theme, such as "System · Nous"; a sub-page with System, Light and Dark and the theme list, each with a check mark on the current choice), a Haptics switch and Hidden bots; **About** with the Ergates version, the Hermes pin and Privacy; then the **Sign out** button. Every row has a leading line icon. Usage appears here once the app can show it. Gateway and Appearance push inside the same modal, with the normal back chevron.
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

The app's look is three tiers. Screens use the roles, never raw values.

| Tier | What it holds | Where it lives |
|---|---|---|
| Tokens | Colors (the vendored Hermes semantic palette, section 3) and the geometry roles below | `src/theme/` (`tokens.ts`, `color.ts`, `contrast.ts`) |
| Components | `Page`, `Screen`, `Sheet`, `Group`, `ListRow`, `Field`, `Button`, `IconButton`, `Avatar`, `Bubble`, `RowContent` and the other shared pieces, built only from tokens | `src/ui/` |
| Screens | Routes that compose components | `app/` |

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

### Shape, space and size

| Group | Roles (points) |
|---|---|
| Radius (`RADIUS`) | `bubble` 22, `composer` 24, `group` 20, `sheet` 28, `button` 16, `field` 14, `chip` 14, `small` 12, `badge` 6 |
| Spacing (`SPACING`) | 4, 8, 12, 16, 24, 32 |
| Page padding (`PAGE_PADDING`) | 20 |
| Size (`SIZE`) | `hit` 44, `row` 56, `button` 50, `field` 50, `fieldMultiline` 128 |
| Icon (`ICON`) | `row` 22, `chevron` 17, `small` 18 |
| Avatar (`AVATAR`) | `inline` 18, `chat` 28, `chatHeader` 30, `list` 48, `identity` 60, `editor` 80, `pinned` 84, `profile` 88 |

### Opacity and scrim

| Role | Value | Use |
|---|---|---|
| `OPACITY.pressed` | 0.65 | A pressed control |
| `OPACITY.disabled` | 0.45 | A disabled control |
| `SCRIM` | `rgba(0,0,0,0.25)` | Backdrop behind the action menu; the one fixed color, the same on every theme |

### Contrast

`contrastRatio` and `rate` (WCAG 2.x: AAA from 7, AA from 4.5, AA large from 3, otherwise Fail) measure the pairs the app paints, listed in `CONTRAST_PAIRS`: `foreground` on `background`, `muted`, `userBubble` and `popover`; `mutedForeground` on `background` and `muted`; `primaryForeground` on `primary`; `destructiveForeground` on `destructive`. A palette that fails a pair is reported on the design system page, not rejected.

### The rule

- Colors come only from `theme.colors`. No vendored palette value changes, and there is no mobile color fallback.
- Under `app/` and `src/ui/`, no numeric literal for `fontSize`, `fontWeight`, `lineHeight`, `letterSpacing`, `borderRadius` or `opacity` (except `0` and `1`), and no hex, `rgb(` or `rgba(` string.
- A type role never carries a line height.
- Chat, bubbles, the composer, `MarkdownText`, the Home list and its edit motion, and the action menu keep their own look. Their off-scale values stay as named constants in the component instead of moving onto the scale.

`apps/mobile/test/design-tokens.test.ts` enforces this by parsing every `.tsx` file under `app/` and `src/ui/`, including values in conditional branches. Its message lists each offender as the file, the line, the key and the text, and says to use a role from `src/theme/tokens.ts`.

### Design system page

Development builds have Settings › Developer tools › Design system. It shows the colors of the active theme (tap a row to copy the token name), the contrast pairs with their ratios and ratings, the type roles, space and shape, and live samples of the shared components, with its own mode and theme preview that does not change the owner's Appearance setting. The row and the route exist only when `__DEV__` is true; in a release build the route redirects to Settings and the row is absent.

## 5. Essential states

| State | What stays simple and explicit |
|---|---|
| First launch | Connect a gateway, then open the concierge; no empty dashboard |
| Offline | Small connection line; preserve drafts; queued-unsent messages clearly marked |
| Delivery uncertain | “Delivery unconfirmed”; inspect history before a deliberate retry; never silently duplicate an action |
| Approval expired | Card says Expired; action buttons disabled; retry starts a fresh request |
| Agent provisioning interrupted | “Setup incomplete”; resume only after checking existing profile/receipt |
| Empty search | One explanatory line and a clear dismiss path |
| Large text | Wrap settings and message text; hide optional role badge before compressing names |
| Reduced motion | Static working indicator; native transitions reduced; no perpetual decorative animation |

## 6. Visual acceptance

Compare Home, Chat (keyboard open/closed), Search, Add menu, bot action menu/More, Edit Bot (basic and advanced), Settings and an approval card against the supplied reference layouts. Check on 320–430 logical-pixel widths, iPhone safe areas, Android, both Nous appearances, and large text. Verify screen-reader labels, focus return after sheets, non-color state indicators, and contrast on every mapped surface. Theme switching must recolor all surfaces and controls without changing layout or resetting the conversation. Exercise Save, Cancel, dirty dismissal, partial failure, concurrent metadata edits and a model/tool change during an active turn. Confirm a display-name edit appears across Home/search/chat while the same profile and transcript remain selected.

The conversation preview illustrates this direction with sample content. It is not a working mobile build; this document and the implementation checks remain authoritative.

Section acceptance: assign Linh and Kevin to Prive; pin both and verify no duplicate rows under Prive. Unpin each and verify it returns to Prive; repin and verify membership persists. Repeat with Prive collapsed and after an app restart. Verify moving a pinned member to another section preserves its pin, collapsing Prive leaves pinned avatars visible, and deleting the section clears membership without unpinning its members. These checks are required for Phase 1; the earlier preview check does not establish this behavior.
