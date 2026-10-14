// Consistent, decorative 24px line icons; visible labels carry navigation meaning.
const paths = {
  overview:
    '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  chat: '<path d="M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 1 1 17-5Z"/><path d="M8 10h8m-8 4h5"/>',
  models: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  channels:
    '<rect x="3" y="4" width="12" height="10" rx="2"/><path d="m5 14-2 3m16-9h2v12l-4-3h-6v-3"/>',
  skills: '<path d="m14 2-3 8h8L9 22l3-9H5l9-11Z"/>',
  plugins: '<path d="M9 3H4v6a3 3 0 1 1 0 6v5h6a3 3 0 1 1 6 0h5V9h-6a3 3 0 1 0-6-6Z"/>',
  credentials:
    '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  operations: '<path d="m4 6 6 6-6 6m9 0h7"/>',
  settings:
    '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
  updates: '<path d="M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5m-4 6a8 8 0 0 0 14 5l3-3m-5 0h5v5"/>',
  sessions:
    '<rect x="6" y="3" width="14" height="15" rx="2"/><path d="M3 7v14h13M10 7h6m-6 4h6m-6 4h3"/>',
  cron: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h2m4 0h2m-8 3h2"/>',
  nodes:
    '<rect x="6" y="2" width="12" height="7" rx="1"/><path d="M12 9v5M4 17v-3h16v3"/><rect x="1" y="17" width="6" height="5" rx="1"/><rect x="17" y="17" width="6" height="5" rx="1"/>',
  codespaces:
    '<rect x="4" y="4" width="16" height="12" rx="2"/><path d="M2 20h20m-13-4v4m6-4v4m-5-13-2 3 2 3m4-6 2 3-2 3"/>',
  database:
    '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  agents:
    '<rect x="4" y="7" width="16" height="14" rx="4"/><path d="M12 3v4M8 12h1m6 0h1m-8 5h8M1 12v4m22-4v4"/>',
};
export const icons = Object.fromEntries(
  Object.entries(paths).map(([key, path]) => [
    key,
    `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`,
  ]),
);
