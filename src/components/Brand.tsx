import { useEffect, useState } from 'react';
import { useBrand } from '../context';

export function Brand({
  compact = false,
  decorative = false,
  theme,
}: {
  compact?: boolean;
  decorative?: boolean;
  theme?: 'light' | 'dark';
}) {
  const { data } = useBrand();
  const [failed, setFailed] = useState<string | null>(null);
  const dark = (theme || document.documentElement.dataset.theme) === 'dark';
  const preferred = compact
    ? dark
      ? data?.darkMarkUrl || data?.markUrl
      : data?.markUrl
    : dark
      ? data?.darkLogoUrl || data?.fullLogoUrl
      : data?.fullLogoUrl;
  const source = preferred && failed !== preferred ? preferred : null;
  useEffect(() => {
    if (!source || compact) return;
    const existing = document.getElementById('sdp-logo-preload') as HTMLLinkElement | null;
    const link = existing || document.createElement('link');
    link.id = 'sdp-logo-preload';
    link.rel = 'preload';
    link.as = 'image';
    link.href = source;
    if (!existing) document.head.appendChild(link);
    return () => link.remove();
  }, [source, compact]);
  return (
    <span className={`brand ${compact ? 'compact' : ''}`}>
      {source ? (
        <img
          src={source}
          alt={decorative ? '' : 'SDP logo'}
          width={compact ? 32 : 244}
          height={compact ? 32 : 70}
          fetchPriority="high"
          loading="eager"
          onError={() => setFailed(source)}
          className={dark && !(compact ? data?.darkMarkUrl : data?.darkLogoUrl) ? 'logo-plate' : ''}
        />
      ) : (
        <span
          className="wordmark"
          aria-label={decorative ? undefined : 'SDP logo'}
          aria-hidden={decorative || undefined}
        >
          SDP
          <span className="wordmark-dot" aria-hidden="true" />
        </span>
      )}
      {!compact && !source && <span className="brand-caption">INVENTORY</span>}
    </span>
  );
}
export function BrandMetadata() {
  const { data } = useBrand();
  useEffect(() => {
    if (!data) return;
    const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (favicon) favicon.href = `/api/v1/settings/favicon/32.png?v=${data.version}`;
    const apple = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
    if (apple) apple.href = `/api/v1/settings/favicon/180.png?v=${data.version}`;
    const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (manifest) manifest.href = `/api/v1/settings/manifest?v=${data.version}`;
  }, [data]);
  return null;
}
