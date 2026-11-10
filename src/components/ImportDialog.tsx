import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Download, FileSpreadsheet, Upload } from 'lucide-react';
import { api, download, jsonBody, uploadFile } from '../api';
import { Button, Dialog, ErrorBanner, useToast } from './ui';
interface Preview {
  id: string;
  validRows: number;
  errors: { row: number; field: string; message: string }[];
  preview: { row: number; data: { sku: string; name: string } }[];
}
export function ImportDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const client = useQueryClient();
  const toast = useToast();
  const close = () => {
    if (busy) return;
    setPreview(null);
    setError('');
    onClose();
  };
  const choose = async (file?: File) => {
    if (!file) return;
    setError('');
    setPreview(null);
    if (file.size > 1024 * 1024) {
      setError('CSV files must be 1 MiB or smaller.');
      return;
    }
    setBusy(true);
    try {
      setPreview(await uploadFile<Preview>('/imports/items', file, setProgress));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const template = () => {
    const blob = new Blob(
      [
        'name,sku,barcode,category,supplier,description,reorder_level,serialized\nSample part,PART-001,,Semiconductors,,,10,false\n',
      ],
      { type: 'text/csv' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'SDP-item-import-template.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ accepted: number; rejected: number }>(
        `/imports/${preview.id}/commit`,
        { method: 'POST', body: jsonBody({}) },
      );
      await client.invalidateQueries();
      toast(`${result.accepted} items imported. ${result.rejected} rows rejected.`);
      setPreview(null);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      title="Import items from CSV"
      description="Review validated rows before adding them. Stock quantities are recorded separately through stock movements."
      onClose={close}
      busy={busy}
    >
      <div className="form-stack">
        {error && <ErrorBanner message={error} />}
        <Button onClick={template}>
          <Download size={16} />
          Download CSV template
        </Button>
        <div
          className="upload-zone"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            if (!busy) void choose(event.dataTransfer.files[0]);
          }}
        >
          <FileSpreadsheet size={28} />
          <strong>Drop a CSV file here</strong>
          <p>Up to 1,000 rows · 1 MiB maximum</p>
          <label className="button neutral outline file-picker">
            <Upload size={16} />
            Choose CSV
            <input
              type="file"
              accept=".csv,text/csv"
              disabled={busy}
              aria-label="Choose CSV file"
              onChange={(event) => void choose(event.target.files?.[0])}
            />
          </label>
        </div>
        {busy && (
          <div className="upload-progress">
            <progress value={progress} max={100} aria-label="CSV upload progress" />
            <span role="status">{progress < 100 ? `Uploading ${progress}%` : 'Processing…'}</span>
          </div>
        )}
        {preview && (
          <div className="import-preview">
            <h3>{preview.validRows} valid rows ready to import</h3>
            <p className="muted">
              {preview.errors.length} validation issues. Invalid rows will be skipped.
            </p>
            {preview.errors.length > 0 && (
              <>
                <ul className="import-errors">
                  {preview.errors.slice(0, 5).map((error, i) => (
                    <li key={i}>
                      Row {error.row} · {error.field}: {error.message}
                    </li>
                  ))}
                </ul>
                <Button
                  onClick={async () => {
                    try {
                      await download(`/imports/${preview.id}/errors`, 'SDP-import-errors.csv');
                    } catch (err) {
                      setError((err as Error).message);
                    }
                  }}
                >
                  Download error report
                </Button>
              </>
            )}
            <ul className="import-rows">
              {preview.preview.map((row) => (
                <li key={row.row}>
                  <span className="mono">{row.data.sku}</span>
                  <span>{row.data.name}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="dialog-actions">
          <Button disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button
            intent="primary"
            disabled={!preview?.validRows}
            busy={busy}
            onClick={() => void commit()}
          >
            Import {preview?.validRows || 0} valid rows
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
