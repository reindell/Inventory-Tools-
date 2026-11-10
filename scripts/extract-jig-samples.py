"""Extract the supplied SIP workbook without Excel, macros, formulas or network access.

Uses only Python's standard library. Runtime imports use the generated catalog and
original embedded image bytes, so Python is not needed by the application/container.
"""
from __future__ import annotations

import argparse
from collections import Counter
from hashlib import sha256
import json
from pathlib import Path, PurePosixPath
import posixpath
import re
import xml.etree.ElementTree as ET
from zipfile import ZipFile

NS = {
    's': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'xdr': 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
    'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
    'rd': 'http://schemas.microsoft.com/office/spreadsheetml/2017/richdata',
}
RID = '{' + NS['r'] + '}id'


def clean(value: str | None) -> str:
    return re.sub(r'\s+', ' ', value or '').strip()


def extract(source: Path, destination: Path) -> dict:
    with ZipFile(source) as archive:
        entries = archive.infolist()
        if len(entries) > 2048 or sum(x.file_size for x in entries) > 256 * 1024 * 1024:
            raise ValueError('Workbook exceeds the extraction limits.')

        def xml(part: str):
            data = archive.read(part)
            if len(data) > 16 * 1024 * 1024 or b'<!DOCTYPE' in data or b'<!ENTITY' in data:
                raise ValueError('Unsafe or oversized XML part: ' + part)
            return ET.fromstring(data)

        def relationships(part: str):
            relpart = str(PurePosixPath(part).parent / '_rels' / (PurePosixPath(part).name + '.rels'))
            if relpart not in archive.namelist():
                return {}
            result = {}
            for rel in xml(relpart):
                if rel.attrib.get('TargetMode') == 'External':
                    continue
                target = posixpath.normpath(posixpath.join(posixpath.dirname(part), rel.attrib['Target']))
                if not target.startswith('xl/'):
                    raise ValueError('Unexpected workbook relationship path.')
                result[rel.attrib['Id']] = target
            return result

        strings = [''.join(t.text or '' for t in node.findall('.//s:t', NS)) for node in xml('xl/sharedStrings.xml')]
        workbook_rels = relationships('xl/workbook.xml')
        metadata = xml('xl/metadata.xml')
        value_metadata = metadata.find('s:valueMetadata', NS)
        future_metadata = metadata.find('s:futureMetadata[@name="XLRICHVALUE"]', NS)
        rich_values = list(xml('xl/richData/rdrichvalue.xml'))
        rich_links = list(xml('xl/richData/richValueRel.xml'))
        rich_rels = relationships('xl/richData/richValueRel.xml')
        structures = list(xml('xl/richData/rdrichvaluestructure.xml'))
        image_parts = {}
        items = []
        warnings = []

        def rich_picture(cell):
            if 'vm' not in cell.attrib:
                return None
            block = value_metadata[int(cell.attrib['vm']) - 1]
            record = block.find('s:rc', NS)
            rvb = future_metadata[int(record.attrib['v'])].find('.//rd:rvb', NS)
            value = rich_values[int(rvb.attrib['i'])]
            keys = [k.attrib['n'] for k in structures[int(value.attrib['s'])]]
            link_index = int(value[keys.index('_rvRel:LocalImageIdentifier')].text)
            return rich_rels[rich_links[link_index].attrib[RID]]

        def image(part):
            if not part.startswith('xl/media/') or PurePosixPath(part).suffix.lower() not in ['.png', '.jpg', '.jpeg']:
                raise ValueError('Only embedded PNG/JPEG photos are accepted.')
            content = archive.read(part)
            if len(content) > 10 * 1024 * 1024:
                raise ValueError('Embedded photo exceeds the application upload limit.')
            digest = sha256(content).hexdigest()
            filename = digest + PurePosixPath(part).suffix.lower()
            image_parts[filename] = content
            return 'images/' + filename

        for sheet in xml('xl/workbook.xml').findall('s:sheets/s:sheet', NS):
            name = clean(sheet.attrib['name'])
            part = workbook_rels[sheet.attrib[RID]]
            root = xml(part)
            cells = {c.attrib['r']: c for c in root.findall('s:sheetData/s:row/s:c', NS)}
            merges = {}
            for merged in root.findall('s:mergeCells/s:mergeCell', NS):
                first, last = merged.attrib['ref'].split(':')
                start = re.fullmatch(r'([A-Z]+)(\d+)', first)
                end = re.fullmatch(r'([A-Z]+)(\d+)', last)
                if start[1] == end[1]:
                    for row in range(int(start[2]), int(end[2]) + 1):
                        merges[f'{start[1]}{row}'] = first

            def raw(address):
                cell = cells.get(merges.get(address, address))
                if cell is None:
                    return ''
                value = cell.find('s:v', NS)
                if value is None:
                    return ''
                if cell.attrib.get('t') == 's':
                    return clean(strings[int(value.text)])
                return clean(value.text)

            headers = {raw(f'{column}2'): column for column in 'ABCDEFGHIJKL' if raw(f'{column}2')}
            required = ['IN-USE', 'SPARE', 'STOCK', 'TOTAL', 'PICTURE']
            if any(field not in headers for field in required):
                raise ValueError('Unrecognized inventory headers in sheet ' + name)
            series_sheet = raw('A2') == 'SERIES'
            groups = {}
            for row in sorted({int(re.search(r'\d+', key)[0]) for key in cells}):
                if row < 3:
                    continue
                if series_sheet:
                    if not raw(f'B{row}'):
                        continue
                    anchor = merges.get(f'{headers["IN-USE"]}{row}', f'{headers["IN-USE"]}{row}')
                    group = int(re.search(r'\d+', anchor)[0])
                else:
                    if not raw(f'A{row}') or not any(raw(f'{headers[field]}{row}') for field in ['IN-USE', 'SPARE', 'TOTAL']):
                        continue
                    group = row
                groups.setdefault(group, []).append(row)

            sheet_items = []
            for row, rows in groups.items():
                def quantity(field):
                    value = raw(f'{headers[field]}{row}') if field in headers else ''
                    if not value:
                        return None
                    if not re.fullmatch(r'\d+(?:\.0+)?', value) or int(float(value)) > 1000000000:
                        raise ValueError(f'Invalid {field} quantity in {name} row {row}.')
                    return int(float(value))

                model = ' / '.join(dict.fromkeys(raw(f'B{r}') for r in rows if raw(f'B{r}') not in ['', '-']))
                series = raw(f'A{row}') if series_sheet else name
                item_name = f'{name.title()} — {series} — {model}' if series_sheet else f'{raw(f"A{row}")} [{name}]'
                slug = re.sub(r'[^A-Z0-9]+', '-', name.upper()).strip('-')
                photos = []
                for r in rows:
                    photo_cell = cells.get(f'{headers["PICTURE"]}{r}')
                    if photo_cell is not None:
                        photo_part = rich_picture(photo_cell)
                        if photo_part:
                            photos.append(image(photo_part))
                record = {
                    'sku': f'SIP-{slug}-{row:03d}',
                    'name': item_name,
                    'category': 'Tools' if series_sheet else 'Jigs',
                    'sheet': name, 'rows': rows, 'series': series,
                    'chipSize': '' if series_sheet or model == '-' else model,
                    'article': '' if series_sheet else raw(f'{headers.get("ARTICLE", "D")}{row}'),
                    'inUse': quantity('IN-USE'), 'spare': quantity('SPARE'), 'stock': quantity('STOCK'),
                    'total': quantity('TOTAL'), 'minimum': quantity('MIN. INV.'), 'maximum': quantity('MAX. INV.'),
                    'remarks': raw(f'{headers.get("REMARKS", "K")}{row}'),
                    'setSize': raw(f'{"L" if series_sheet else "M"}{row}') if series_sheet or 'MIN. INV.' in headers else '',
                    'photos': list(dict.fromkeys(photos)),
                }
                if len(item_name) > 150 or len(record['sku']) > 64:
                    raise ValueError('Item identity exceeds the application limits.')
                counts = [record['inUse'], record['spare'], record['stock']]
                if record['total'] is not None and record['total'] != sum(x or 0 for x in counts):
                    warnings.append({'sku': record['sku'], 'issue': 'Workbook TOTAL differs from IN-USE + SPARE + STOCK.', 'total': record['total'], 'calculatedTotal': sum(x or 0 for x in counts)})
                sheet_items.append(record)

            for drawing in root.findall('s:drawing', NS):
                drawing_part = relationships(part)[drawing.attrib[RID]]
                drawing_rels = relationships(drawing_part)
                for anchor in xml(drawing_part):
                    start = anchor.find('xdr:from', NS)
                    picture = anchor.find('.//a:blip', NS)
                    if start is None or picture is None:
                        continue
                    first_row = int(start.find('xdr:row', NS).text) + 1
                    end = anchor.find('xdr:to', NS)
                    end_row = int(end.find('xdr:row', NS).text) + 1 if end is not None else first_row + 1
                    last_row = max(first_row, end_row - 1)
                    candidates = [(len(set(range(first_row, last_row + 1)) & set(item['rows'])), item) for item in sheet_items]
                    candidates = [(score, item) for score, item in candidates if score]
                    if not candidates:
                        warnings.append({'sheet': name, 'row': first_row, 'issue': 'Unmatched drawing anchor; photo not assigned.'})
                        continue
                    candidates.sort(key=lambda entry: entry[0], reverse=True)
                    if len(candidates) > 1 and candidates[0][0] == candidates[1][0]:
                        warnings.append({'sheet': name, 'row': first_row, 'issue': 'Ambiguous drawing anchor; photo not assigned.'})
                        continue
                    record = candidates[0][1]
                    embedded = picture.attrib['{' + NS['r'] + '}embed']
                    record['photos'].append(image(drawing_rels[embedded]))
                    record['photos'] = list(dict.fromkeys(record['photos']))
            items.extend(sheet_items)

        if len({x['sku'] for x in items}) != len(items):
            raise ValueError('Duplicate generated source SKU.')
        if any(len(x['photos']) > 5 for x in items):
            raise ValueError('A source item exceeds the five-photo limit.')
        catalog = {
            'source': source.name, 'sourceSha256': sha256(source.read_bytes()).hexdigest(),
            'notes': [
                'Original embedded photos are mapped through Excel rich-value metadata or drawing anchors.',
                'Merged quantity cells are imported once, with their part numbers combined.',
                'SPARE + STOCK is the sample available quantity; blank count cells add zero.',
                'Existing workbook IN-USE is a dated reference, not attributed to invented borrowers.',
                'TOTAL is reference-only; inconsistent totals are reported rather than used for availability.',
            ],
            'items': items, 'warnings': warnings,
        }
        destination.mkdir(parents=True, exist_ok=True)
        (destination / 'images').mkdir(exist_ok=True)
        for filename, content in image_parts.items():
            (destination / 'images' / filename).write_bytes(content)
        (destination / 'catalog.json').write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
        return {'items': len(items), 'sheets': dict(Counter(x['sheet'] for x in items)), 'uniquePhotos': len(image_parts), 'itemsWithPhotos': sum(bool(x['photos']) for x in items), 'warnings': warnings}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('workbook', nargs='?', default='Sample of tools and jigs/SIP Assembly Jigs.xlsx')
    parser.add_argument('--output', default='samples/sip-assembly-jigs')
    args = parser.parse_args()
    print(json.dumps(extract(Path(args.workbook), Path(args.output)), indent=2))
