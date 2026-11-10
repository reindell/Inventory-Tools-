import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ImagePlus, ShieldCheck, Trash2, Upload } from 'lucide-react';
import type { Brand as BrandData } from '../../shared/contracts';
import { api, uploadFile } from '../api';
import { useBrand } from '../context';
import { Brand } from '../components/Brand';
import { Page } from '../components/Page';
import { Button, ConfirmDialog, ErrorBanner, Skeleton, useToast } from '../components/ui';

export function SettingsPage() {
  const query = useBrand();
  const client = useQueryClient();
  const toast = useToast();
  const [uploadError, setUploadError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [removeOpen, setRemoveOpen] = useState(false);
  const upload = async (file?: File) => {
    if (!file) return;
    setUploadError('');
    if (file.size > 2 * 1024 * 1024) {
      setUploadError('Logo must be 2 MiB or smaller.');
      return;
    }
    if (!['image/png', 'image/svg+xml', 'image/webp'].includes(file.type)) {
      setUploadError('Choose a PNG, SVG or WebP file.');
      return;
    }
    setUploading(true);
    setProgress(0);
    try {
      const data = await uploadFile<BrandData>('/settings/logo', file, setProgress);
      client.setQueryData(['brand'], data);
      await client.invalidateQueries({ queryKey: ['audit'] });
      toast('Company logo updated.');
    } catch (err) {
      setUploadError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };
  const remove = async () => {
    setUploading(true);
    setUploadError('');
    try {
      const data = await api<BrandData>('/settings/logo', { method: 'DELETE' });
      client.setQueryData(['brand'], data);
      setRemoveOpen(false);
      toast('Custom logo removed. Shindengen logo restored.');
    } catch (err) {
      setUploadError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };
  return (
    <Page
      title="Settings"
      eyebrow="ADMINISTRATION"
      description="Keep your company identity consistent across the workspace, reports and emails."
    >
      {query.isPending ? (
        <Skeleton rows={6} />
      ) : query.isError ? (
        <ErrorBanner message={query.error.message} retry={() => void query.refetch()} />
      ) : (
        <div className="settings-grid">
          <div className="settings-main">
            <section className="panel form-panel">
              <div className="section-label">
                <span className="section-icon">
                  <ImagePlus size={19} />
                </span>
                <div>
                  <h2>Company logo</h2>
                  <p>Used in navigation, reports, labels and transactional emails.</p>
                </div>
              </div>
              <div className="logo-preview-grid">
                <div className="logo-preview light-preview">
                  <span>Light background</span>
                  <Brand theme="light" />
                </div>
                <div className="logo-preview dark-preview">
                  <span>Dark background</span>
                  <Brand theme="dark" />
                </div>
              </div>
              <div
                className="upload-zone"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  if (!uploading) void upload(event.dataTransfer.files[0]);
                }}
              >
                <Upload size={27} />
                <strong>Drop your company logo here</strong>
                <p>PNG, SVG or WebP · Maximum 2 MiB</p>
                <label
                  className={`button neutral outline file-picker ${uploading ? 'disabled' : ''}`}
                >
                  Choose logo
                  <input
                    type="file"
                    accept="image/png,image/svg+xml,image/webp"
                    aria-label="Choose company logo"
                    disabled={uploading}
                    onChange={(event) => {
                      void upload(event.target.files?.[0]);
                      event.target.value = '';
                    }}
                  />
                </label>
              </div>
              {uploading && (
                <div className="upload-progress">
                  <progress aria-label="Logo upload progress" value={progress} max={100} />
                  <span role="status">
                    {progress < 100 ? `Uploading ${progress}%` : 'Validating and saving logo…'}
                  </span>
                </div>
              )}
              {uploadError && <ErrorBanner message={uploadError} />}
              {query.data?.logoUrl && (
                <Button
                  intent="danger"
                  emphasis="ghost"
                  disabled={uploading}
                  onClick={() => setRemoveOpen(true)}
                >
                  <Trash2 size={16} />
                  Remove custom logo
                </Button>
              )}
              <p className="muted settings-hint">
                The Shindengen logo is included by default. Custom logo uploads publish immediately
                and are recorded in the audit log.
              </p>
            </section>
          </div>
          <aside className="panel settings-guide">
            <ShieldCheck size={25} />
            <h2>Branding with a record</h2>
            <p>Only Admins can replace the logo. Every logo change records who made it and when.</p>
            <Link className="text-link" to="/audit?q=branding">
              View branding audit events
            </Link>
            <hr />
            <h3>Approved brand files</h3>
            <p>Use a clear horizontal company logo with space around the artwork.</p>
            <p>
              Uploaded logos override bundled files. Remove the custom logo to return to the bundled
              identity.
            </p>
            <p>
              The primary and accent colors remain provisional until approved brand colors are
              provided.
            </p>
          </aside>
        </div>
      )}
      <ConfirmDialog
        open={removeOpen}
        title="Remove the custom company logo?"
        description="The workspace, future emails and new reports will return to the bundled Shindengen logo."
        confirmLabel="Remove custom logo"
        onConfirm={() => void remove()}
        onClose={() => setRemoveOpen(false)}
        busy={uploading}
        error={uploadError}
      />
    </Page>
  );
}
