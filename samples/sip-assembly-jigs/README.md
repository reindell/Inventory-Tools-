# SIP Assembly Jigs sample catalog

Source: `Sample of tools and jigs/SIP Assembly Jigs.xlsx`, supplied by the user.
The original workbook is unchanged. `catalog.json` records its SHA-256, sheet/row
provenance, original counts, and source-data warnings. `images/` contains original
embedded picture bytes, named by SHA-256; these are private server assets, not
public web files.

The catalog has **135 entries across 12 worksheets**, **130 entries with photos**
and **126 distinct embedded pictures**. Every original embedded picture is mapped
through Excel rich-value metadata or its drawing anchor, including modern in-cell
images whose cached cell value reads `#VALUE!`. That cached error is not imported
as an item name or a picture URL.

Vertically merged quantity cells are counted once. Their part numbers are combined
in one catalog entry; separate rows with their own quantity cells stay separate.
Sheet-qualified names and deterministic `SIP-...` SKUs distinguish repeated jig names.

For sample opening stock, **SPARE + STOCK** is available; blank count cells add zero.
The workbook's existing **IN-USE** values remain historical reference in the item
description, since the workbook does not identify borrowers. They are not imported
as available stock or fabricated user loans. New Admin-confirmed handovers display
**In use**, and actual partial/full returns are recorded against those requests.

Four source TOTAL cells disagree with the other quantities. The importer preserves
the original values and lists warnings, rather than using TOTAL as availability:

| Sheet / row             | Source TOTAL | IN-USE + SPARE + STOCK |
| ----------------------- | -----------: | ---------------------: |
| SQUEEGEE / 9            |            0 |                     20 |
| DEBURRING BLADE / 9–10  |            0 |                     21 |
| DEBURRING BLADE / 12–13 |            0 |                     35 |
| DEBURRING PIN / 9–10    |            0 |                     12 |

## Generate and import

Regenerate from the supplied workbook using Python 3's standard library:

```powershell
py -3 scripts/extract-jig-samples.py
npx prettier --write samples/sip-assembly-jigs/catalog.json
```

Application startup/import needs no Python or Excel installation. A fresh development
seed uses this catalog; production still creates only the Admin unless sample data
is explicitly enabled. The legacy component fixtures are selected only by the browser
regression tests through `SEED_SAMPLE_SOURCE=legacy-components`.

For an existing database, stop the local development API first if it owns the embedded
database, then use the configured database/storage settings:

```powershell
npm run db:samples -- --dry-run
npm run db:samples -- --catalog-only
# Or explicitly include the sample spare/stock counts:
npm run db:samples -- --with-stock
```

Imports require an existing enabled Admin, add ledger-backed opening receipts and
audit records, and process pictures through the usual private upload pipeline.
Existing SKUs are skipped: later edits, quantities, loans and photos are preserved.
Rerunning is safe and completes remaining items after a failure. Each new item and
its opening receipt/photos commit together. Switching an already imported catalog-only
item to `--with-stock` does not top it up; enter verified receipts through stock controls.

Review all sample counts before live use. Old sample items are not deleted or overwritten.
These assets are copied into the Docker runtime under `samples/`; they are never served
by the public-assets route. Runtime item photos use random private storage keys and
signed URLs.
