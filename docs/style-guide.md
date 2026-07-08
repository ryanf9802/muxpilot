# Muxpilot Style Guide

Muxpilot uses a dark console palette with a bright green brand/action color. The
palette separates brand action from status meaning so primary controls, selected
states, success, warning, and error feedback stay visually distinct.

## Color Palette

Use these CSS custom properties as the source of truth. Do not add temporary
aliases for previous token names.

| Role | Token | Value | Usage |
| --- | --- | --- | --- |
| Brand | `--color-brand` | `#1ff989` | Logo, brand mark, rare brand accents |
| Primary action | `--color-action` | `#1ff989` | Primary buttons and direct action affordances |
| Primary action hover | `--color-action-hover` | `#35f998` | Hovered primary actions |
| Primary action active | `--color-action-active` | `#13d977` | Pressed primary actions |
| App background | `--color-bg` | `#1f1f21` | Page and app chrome background |
| Surface | `--color-surface` | `#28282b` | Cards, dialogs, panels |
| Surface raised | `--color-surface-raised` | `#303035` | Menus, popovers, elevated controls |
| Input/code surface | `--color-input` | `#18191a` | Text inputs, textareas, code blocks |
| Border | `--color-border` | `#424349` | Default borders and separators |
| Border strong | `--color-border-strong` | `#5a5c63` | Focus, active, dense form, and table boundaries |
| Text | `--color-text` | `#f3f6f4` | Primary text |
| Text muted | `--color-text-muted` | `#b3bbb6` | Secondary text and metadata |
| Text subtle | `--color-text-subtle` | `#7f8983` | Low-emphasis labels |
| Text inverse | `--color-text-inverse` | `#102017` | Text on bright fills |
| Secondary | `--color-secondary` | `#35d7ff` | Links, charts, information accents |
| Secondary soft | `--color-secondary-soft` | `#17333a` | Information-tinted surfaces |
| Tertiary | `--color-tertiary` | `#c7a6ff` | Rare highlight distinct from action/info/status |
| Tertiary soft | `--color-tertiary-soft` | `#30283f` | Subtle tertiary-tinted surfaces |
| Success | `--color-success` | `#4ade80` | Ready, success, positive validation, completed states |
| Success soft | `--color-success-soft` | `#173b29` | Success-tinted surfaces |
| Warning | `--color-warning` | `#f3c969` | Pending, waiting, attention, approval states |
| Warning soft | `--color-warning-soft` | `#3a301c` | Warning-tinted banners and cards |
| Error | `--color-error` | `#ff6b66` | Errors, destructive actions, failed states |
| Error soft | `--color-error-soft` | `#3b2220` | Error-tinted surfaces |
| Overlay | `--color-overlay` | `rgba(0, 0, 0, 0.58)` | Modal backdrops |
| Elevated shadow | `--shadow-elevated` | `0 18px 52px rgba(0, 0, 0, 0.46)` | Dialogs and popovers |

## Usage Rules

- Use `--color-action` for primary CTAs and direct action affordances only.
- Use `--color-success` for positive state, not for general brand emphasis.
- Use `--color-secondary` for links, charts, informational accents, and selected
  metadata that is not a primary action.
- Use `--color-tertiary` sparingly when a highlight needs to be distinct from
  action, info, and status colors.
- Use `--color-border-strong` for focus states, active controls, tables, code,
  and dense forms when the default border is too quiet.
- Keep QR-code surfaces white for scan reliability.
- Prefer `color-mix()` variants derived from these tokens instead of introducing
  one-off hex colors.

## Cutover Rule

The app must use the tokens above directly. Do not reintroduce legacy tokens
such as `--green`, `--teal`, `--yellow`, `--red`, `--blue`, `--panel`,
`--panel-2`, `--line`, `--muted`, or `--text`.
