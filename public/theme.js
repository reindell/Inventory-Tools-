try {
  const stored = localStorage.getItem('sdp-theme');
  document.documentElement.dataset.theme =
    stored || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
} catch {
  document.documentElement.dataset.theme = 'light';
}
