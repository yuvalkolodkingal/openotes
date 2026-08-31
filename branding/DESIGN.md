# Openotes design system

Version 1.0

## The idea

Openotes is paper you own. Every visual decision follows from three words in the README: offline, encrypted, yours. The brand should feel like good stationery, not like a security product — calm, warm, and quiet, with the lock present but never shouting. Nothing in the interface should feel like a service: no marketing surfaces, no upgrade colors, no attention-seeking accents.

## Logo

The mark is a note sheet with a folded corner and a keyhole punched through the paper: notes that are encrypted by their nature, not by an add-on. The two ruled lines keep it reading as "notes" first, "lock" second — that order matters.

Files:

| File | Use |
|---|---|
| `openotes-mark.svg` | App icon, favicon, avatars. Scales 512 → 16 px. |
| `openotes-mark-mono.svg` | Toolbars, system tray, docs headers. Inherits `currentColor`. |
| `openotes-lockup.svg` | README header, website, about screen. |

Rules:

- Clear space around the mark equals the keyhole diameter (about 13% of the badge width). Nothing enters it.
- Minimum size 16 px for the mark, 120 px wide for the lockup. Below 24 px the second ruled line may be dropped.
- The mark sits on the teal badge or stands alone as the mono version — never recolor the badge, never add gradients, shadows, or outlines.
- The wordmark is set in Inter SemiBold with −1.5 letter-spacing, always lowercase after the capital O. Convert text to outlines before using the lockup anywhere the font stack may not resolve.

## Color

The palette is teal on warm paper. Teal is the color of the encryption layer and the only brand color; everything else is warm gray so notes and their content stay the loudest thing on screen.

| Token | Hex | Role |
|---|---|---|
| `--on-teal-900` | `#134e4a` | Wordmark, accent hover |
| `--on-teal-700` | `#0f766e` | Primary accent, badge, links, focused controls |
| `--on-teal-500` | `#14b8a6` | Progress, subtle highlights |
| `--on-teal-200` | `#99f6e4` | The fold; selected-item tint |
| `--on-paper` | `#f0fdfa` | The sheet; hero surfaces only |
| `--on-ink` | `#1c1917` | Text |
| `--on-gray-500` | `#78716c` | Secondary text |
| `--on-gray-300` | `#d6d3d1` | Borders |
| `--on-white` | `#fafaf9` | App background |

Sync status has a fixed vocabulary, matching the README's indicator table. These colors are reserved — never use them decoratively:

| State | Color | Hex (light) |
|---|---|---|
| ✓ Synced | teal | `#0f766e` |
| ↻ Syncing | blue | `#0369a1` |
| ○ Offline / ⋯ Pending | gray | `#78716c` |
| ! Error | red | `#b91c1c` |
| ⚠ Conflict | amber | `#b45309` |

Offline is gray, not red: working offline is a normal, supported state of the product, and the palette must say so.

Dark mode swaps warm-black surfaces for paper and brightens teal to `#2dd4bf` for contrast. Full token set in `tokens.css`. All text/background pairs above meet WCAG AA at their intended sizes.

## Typography

One family does everything: Inter (fall back to Segoe UI / system-ui — the app ships no bundled browser, so respect what the OS provides). Notes render at 15 px / 1.7; UI chrome at 13 px; note titles at 24 px SemiBold. JetBrains Mono (fall back to ui-monospace) for code blocks inside notes and for anything cryptographic — key fingerprints, digests, filenames — so ciphertext-adjacent material is visibly *material*, not prose.

Two weights only, 400 and 600. Sentence case everywhere, including buttons and settings headings. No all-caps labels.

## Shape and space

Corner radius 8 px on controls and cards, 4 px on inputs and tags, 12 px on dialogs — the same rounding family as the badge (117/512 ≈ 23%). Spacing runs on a 4 px scale; default gaps are 8 and 16. Borders are 1 px hairlines; depth comes from background steps (`--bg` → `--bg-raised`), not shadows. One shadow is permitted in the whole app: the floating conflict/restore dialog.

## Iconography

Outline icons, 1.5 px stroke, 20 px default (Tabler or Lucide both fit). The keyhole shape from the mark may be reused as the "encrypted" glyph in settings and status surfaces, and nowhere else.

## Voice

Plain verbs, no reassurance theater. "Test connection", not "Verify your secure sync configuration". Errors say what happened and what to do: "Server unreachable. Changes are queued and will sync when it's back." The passphrase warning is stated once, bluntly, at setup — the interface never nags about it afterward. Never use "cloud" for the user's own server; it's "your server".
