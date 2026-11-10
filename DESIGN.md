---
version: alpha
name: SDP Inventory
description: A production stock desk for one Shindengen production location.
colors:
  primary: '#1D4ED8'
  on-primary: '#FFFFFF'
  foreground: '#0F172A'
  background: '#FFFFFF'
  canvas: '#F4F6FA'
  muted: '#526078'
  border: '#DCE2EC'
  success: '#166534'
  warning: '#854D0E'
  danger: '#B91C1C'
typography:
  display:
    fontFamily: 'Bahnschrift, Aptos Display, system-ui, sans-serif'
  sans:
    fontFamily: 'Aptos, Segoe UI, system-ui, sans-serif'
  mono:
    fontFamily: 'Cascadia Code, Consolas, monospace'
rounded:
  DEFAULT: '0.5rem'
  lg: '0.875rem'
spacing:
  control: '0.75rem'
  panel: '1.5rem'
  section: '2rem'
components:
  button:
    rounded: '0.5rem'
    backgroundColor: '{colors.primary}'
    textColor: '{colors.on-primary}'
  card:
    rounded: '0.875rem'
    backgroundColor: '{colors.background}'
    textColor: '{colors.foreground}'
  dialog:
    rounded: '0.875rem'
    backgroundColor: '{colors.background}'
    textColor: '{colors.foreground}'
  page:
    backgroundColor: '{colors.canvas}'
  muted-text:
    textColor: '{colors.muted}'
  divider:
    backgroundColor: '{colors.border}'
  success-badge:
    textColor: '{colors.success}'
  warning-badge:
    textColor: '{colors.warning}'
  error-banner:
    textColor: '{colors.danger}'
---

# SDP Inventory design system

## Overview

The visual reference is a production supervisor's stock desk: labelled part records, readable quantities, and an unmistakable record of what moved. Audience: internal production staff, managers and viewers, primarily on desktop with barcode scanners; phone layouts support quick stock checks. The product is an English internal tool. A Japanese corporate identity does not establish Japanese locale or Japan-only deployment; no Japan-specific legal, payment or address flows are introduced. Language can be extended after audience confirmation.

The signature is a small production-status rail: the active production location appears beside a status dot and the current stock health. It expresses the single-location workflow without a location chooser. Product register takes precedence over marketing styling. Avoid oversized promotional heroes, decorative imagery and charts without underlying data.

Runtime ownership is Model B: `src/styles.css` owns semantic CSS variables and a Tailwind v4 `@theme inline` adapter. This document mirrors the accepted values and explains their use. Shared UI components consume variables. Contrast tests check the documented text pairs; browser tests inspect rendered themes. Application colors remain provisional. Bundled Shindengen artwork retains its original `#003e6f` fill and proportions; the full logo uses a white backing plate on dark surfaces. The original website favicon supplies the collapsed-navigation mark and app icons. Artwork provenance is recorded in `public/brand/README.md`.

## Colors

Light uses white surfaces on #F4F6FA with #0F172A foreground, #526078 muted text and #DCE2EC boundaries. Blue #1D4ED8 is the action color with white text. Dark uses #0F172A canvas, #172338 surface, #F8FAFC text, #AFBDD1 muted text, #34445E boundaries and #93C5FD action color with #0F172A text. Status colors always accompany text/icons. Dark status text uses pale semantic variants. Focus is a high-contrast primary outline; disabled controls retain labels and explanatory context.

## Typography

Bahnschrift/Aptos Display provide restrained industrial headings. Aptos/Segoe UI provide readable body and control text. Cascadia Code/Consolas distinguish SKUs and serials. All fonts are local system stacks, avoiding remote font loading and layout shifts. Use tabular numerals for quantities and item counts, 14–16 px body text, 1.5 line height and 26–32 px page titles. No invented condensed all-caps paragraphs.

## Layout

Desktop sidebar is 248 px expanded, 88 px collapsed. Main content is at most 1440 px wide, with 24–32 px gutters. At 900 px the navigation becomes a native-modal drawer; at 640 px tables become labelled cards. Forms retain natural document scrolling. Panel spacing is 24 px, field gap 16 px, control padding 12 px. Images reserve their aspect ratio; skeletons match rows/panels. One document scroll owner, with local horizontal table scrolling only where necessary.

## Elevation & Depth

Static cards use borders and tonal separation. Small shadows are reserved for dialogs and the navigation drawer. No glass effects, ambient gradients, or floating primary actions over table rows.

## Shapes

Controls use 8 px radius and cards/dialogs use 14 px. Badges may be pills. Icons use Lucide 18–20 px line icons, with visible action text for frequent operations. Approved logos preserve aspect ratio and clear space.

## Components

The owners are in `src/components/ui.tsx`: Button (primary/neutral/danger with solid/outline/ghost emphasis), Field, Select, Search, StatusBadge, Dialog, ConfirmDialog, Pagination, Skeleton and ToastProvider. Busy controls reserve width and expose aria-busy; invalid fields provide linked text. Native select and date-input popups intentionally use platform geometry. Native `<dialog>` owns modal focus/inert background and restores focus; no native alert/confirm/prompt UI. Destructive confirmation initially focuses Cancel.

All screens share loading, empty/no-results, retryable error and successful content states. Navigation uses links, mutations use buttons, and actionable rows expose explicit links. Transitions are 120 ms and disabled for reduced motion. Global scrollbar thumb/track and forced-color fallbacks apply to all owned scrolling surfaces. Reports retain white paper and dark ink regardless of theme.

Tool requests reuse the inventory's real item photos, SKU treatment and panel/table primitives. Monitoring keeps requested, issued, returned and outstanding quantities distinct with tabular numerals; status labels retain text in both themes. The regular-user workspace has only My requests and Tool catalog navigation. Admin monitoring adds requester identity and explicit review/issue/return buttons. The notification counter uses the primary/on-primary token pair, including dark mode. At narrow widths request totals stack and rows become the same labelled cards used by Inventory; actions remain visible without horizontal page scrolling.

## Do's and Don'ts

- Do keep the SKU, stock state and quantity visible together.
- Do label a confirmed tool handover as **In use**; keep requested, issued, returned and currently in-use quantities distinguishable.
- Do show actual server-backed records and preserve forms after failures.
- Don't add a location switcher or transfer workflow for this release.
- Don't label provisional artwork or colors as approved company branding.
