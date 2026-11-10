# SDP brand asset contract

This directory is the source of truth for bundled brand assets. The Shindengen logo and browser mark are included. Keep the shared **SDP** text fallback for unavailable assets; do not request missing asset URLs or preload nonexistent files.

Artwork provenance (retrieved 2026-10-30):

- `sdp-logo.svg` is the unmodified [official website logo](https://www.shindengen.com/assets/svg/logo.svg), with intrinsic dimensions 244 × 70 and original fill `#003e6f`. SHA-256: `b95449e3b2cee54e06e510a3a995073fd85e923b8e8f83881b231e286d0c75d9`.
- `sdp-mark.png` is the 48 × 48 image decoded losslessly from the [official website favicon](https://www.shindengen.com/assets/images/favicon.ico). Its original blue square and white conversion line are preserved. SHA-256: `b81e4a59d3276537313741c5290cdc672dd4a0f9dd80aeb969f00223c93a0450`.
- No dark logo was supplied by the source. Use the original blue logo on the shared white backing plate in dark surfaces; never recolor the artwork. The supplied mark already has its own opaque background. Larger app icons scale this original 48 px raster; a higher-resolution official mark can replace it later.

Expected assets:

| File                               | Purpose                                                      |
| ---------------------------------- | ------------------------------------------------------------ |
| `sdp-logo.svg`                     | Full horizontal logo on light backgrounds                    |
| `sdp-logo-dark.svg`                | Optional approved full logo for dark backgrounds             |
| `sdp-mark.png`                     | Included official icon for collapsed navigation and favicons |
| `sdp-mark.svg`                     | Optional approved vector mark; takes precedence over PNG     |
| `sdp-mark-dark.svg`                | Optional approved icon for dark backgrounds                  |
| `favicon-16.png`, `favicon-32.png` | Browser icons                                                |
| `apple-touch-icon.png`             | 180 × 180 Apple touch icon                                   |
| `icon-192.png`, `icon-512.png`     | Manifest icons                                               |
| `icon-180.png`                     | Additional requested 180 × 180 PNG export                    |
| `manifest.webmanifest`             | Application name, theme color, and icon references           |

Generate PNGs from the supplied mark without distortion; verify raster dimensions. Manifest entries must reference files that actually exist. The generator retains provisional SDP text icons only as a fallback when both SVG and PNG marks are absent.

Brand use:

- Company display name: SHINDENGEN ELECTRIC MFG.CO.,LTD, fixed by the shared `COMPANY_NAME` constant. Application name: SDP Inventory. Company details cannot be edited; Admin logo replacement remains available.
- Image alternative text: `SDP logo`; decorative duplicates: empty alternative text. A home link must have a discernible `SDP Dashboard` accessible name.
- Full logo: preferred height 32 px, provisional minimum width 120 px. Mark: minimum 24 × 24 px. Preserve natural aspect ratio, increasing the container when needed.
- Clear space: at least half the rendered logo height on all sides. These provisional dimensions yield to supplied official brand guidelines.
- Never stretch, crop, or recolor approved artwork. Use an approved dark variant, or a neutral backing plate if none exists. Use currentColor only for artwork explicitly supplied for that purpose.
- Reserve intrinsic dimensions. Load above-the-fold brand images eagerly; preload the exact active header variant only when available. Lazy loading is allowed below the fold.
- Center the full logo above login, invitation activation, and password reset forms. Expanded navigation uses the full logo; collapsed navigation uses the mark. Both link to Dashboard.
- Page title: `SDP Inventory | {Page}`. Include the company name in login and report metadata.
- Include a logo and company name in PDF report, stock report, printed label, password reset email, and low-stock email headers. Offer an optional label logo toggle. CSV is plain text: provide company metadata in the export filename and an adjacent branded PDF instead of inserting an image into CSV.

Runtime replacements do not overwrite this directory. Admin uploads live in private object storage. A versioned brand settings record selects a validated runtime override; bundled assets, then the text wordmark, provide fallbacks. A shared brand resolver supplies web, email, report, and icon generation so there is one active brand configuration.

Upload pipeline (implemented in Phase 2): Admin authorization and CSRF check; maximum 2 MiB source; verified PNG/WebP signatures or restricted SVG parsing; maximum 4096 × 4096 raster dimensions and bounded decoder memory; reject animated or malformed images. Reject SVG DTD/entities, scripts, event attributes, foreignObject, embedded HTML, external resource references, CSS URLs/imports, and unsafe links. Decode or rasterize with resource/network access disabled, then re-encode to PNG/WebP without metadata. Do not serve user-supplied SVG. Use UUID object keys and private storage outside the web root.

An update commits the new asset pointer, brand version, and audit event together. Logo audit records include actor, previous/new asset IDs, checksum, request ID, and timestamp. Historical name-change audit records remain intact; new company-name changes are disabled. Do not log file contents or credentials. Keep the prior asset for rollback; remove orphaned uploads after a retention window. Regenerate brand-derived icons and invalidate cached configuration when publishing an update. Produce an email-safe raster derivative and short-lived report-access URLs; embed the validated raster in generated emails so expiring links do not break delivered messages.
