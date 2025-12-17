# Obsidian Telegram Notifier

A simple and useful plugin for Obsidian that sends notifications to your Telegram bot based on deadlines in your notes. Supports recurring reminders, inline tasks, and scheduled working hours.

## Features

- **Single Reminders:** Set a date and time in the note's properties (`review_date`).
- **Recurring Presets:** Configure notification cycles (e.g., for payments: 7 days before, on the due date, and 1 day after).
- **Inline Tasks:** Track deadlines for specific tasks using `[check:: YYYY-MM-DD HH:mm]`.
- **Smart Logic:** If a date is removed or a checkbox is checked, notifications for that item will stop.
- **Snippet Generator:** A built-in tool to generate YAML code for your notes without memorizing the syntax.
- **Context Menu:** Right-click anywhere in a note to insert a reminder template instantly.
- **Timezone & Schedule:** Set your timezone and "working hours" (e.g., 9:00 - 21:00) to avoid nighttime alerts.

## Installation

### Via BRAT (Recommended)
1. Install **BRAT** from the Community Plugins list in Obsidian.
2. In BRAT's settings, add a "beta plugin" with this repository's URL.
3. BRAT will handle the installation and future updates.

### Manual Installation
1. Download `main.js`, `manifest.json`, and `styles.css` from the **Releases** page of this repository.
2. Create a folder named `obsidian-telegram-notifier` inside your vault's `.obsidian/plugins/` directory.
3. Move the downloaded files into that new folder.
4. Go to **Obsidian Settings -> Community Plugins**, and enable the plugin.

## Configuration

### 1. Telegram Setup
1. Create a bot via [@BotFather](https://t.me/BotFather) on Telegram to get your **Bot Token**.
2. Find your **Chat ID** by sending a message to a bot like [@userinfobot](https://t.me/userinfobot).
3. Enter these credentials in the plugin settings within Obsidian.
4. Click the **Send Test Message** button to verify the connection.

### 2. Usage Examples

#### A. Single Reminder
Add this to the top of your note (YAML Frontmatter):
---
review_date: 2025-12-20 14:00
priority: High
---

#### B. Recurring Reminder (Preset)
First, configure a preset named `finance` in the plugin settings. Then, use it in a note:
---
due_date: 2025-12-25
reminder_preset: finance
payment_sum: 500$
---

#### C. Inline Task
Write this anywhere in your note:
---
 - [ ] Submit report [check:: 2025-12-20 10:00]
---

## Field naming and compatibility

This plugin is designed to work together with Dataview and Metadata Menu.

### Fields used by the plugin

The plugin relies on the following metadata fields:

- YAML frontmatter:
  - `review_date` – single reminder date/time for the whole note.
  - `due_date` – base date for recurring reminders.
  - `reminder_preset` – name of the preset to apply.
  - Custom fields for single reminders (configured in **Allowed Fields (Single)**).
  - Custom fields for presets (configured in **Allowed Fields (Preset)**).
- Inline field:
  - `check::` – used inside tasks for per-line deadlines, e.g.  
    `- [ ] Task name [check:: 2025-12-20 10:00]`.

All of these use standard YAML and Dataview-style inline syntax and can be safely queried from Dataview or managed via Metadata Menu.

### Recommended custom field names

You are free to define any additional fields in the plugin settings, for example:

- `payment_sum`
- `client`
- `project_link`
- `priority`
- `type`

These fields will be:

- Inserted automatically into generated YAML snippets.
- Available for use in message templates as `{payment_sum}`, `{client}`, etc.

### Names to avoid

To reduce the risk of edge cases with Dataview, it is recommended **not** to use the following words as field names in your custom configuration:

- `where`
- `group`
- `position`
- `tag`
- `tags`

These words are often used in Dataview queries or internal logic and may cause confusing behavior if reused as field keys.

If you follow these guidelines, the plugin should remain compatible with Dataview, Metadata Menu, and other metadata-based workflows in your vault.```


## Development

1. Clone this repository.
2. Run `npm install` to install dependencies.
3. Run `npm run dev` to start compilation in watch mode.
