
// Appended to the original 1.1.0 Updates module; g is its settings section.
function GrokLocalVersion() {
  return (0, S.jsx)(g, { children: (0, S.jsxs)('div', { style: {
    display: 'flex', alignItems: 'center', gap: 16, padding: '22px 20px', minWidth: 0,
  }, children: [
    (0, S.jsx)('img', { src: new URL('../../../local-client/icon.png', import.meta.url).href, alt: '', style: { width: 48, height: 48, flexShrink: 0 } }),
    (0, S.jsxs)('div', { style: { display: 'grid', gap: 5, flex: 1, minWidth: 0 }, children: [
      (0, S.jsx)('strong', { style: { fontWeight: 550, fontSize: 16 }, children: 'Grok Bot' }),
      (0, S.jsx)('span', { style: { opacity: .55, fontSize: 13 }, children: '1.1.0' }),
    ] }),
    (0, S.jsx)('span', { style: { fontSize: 12, opacity: .55, whiteSpace: 'nowrap' }, children: grokText('本地版', 'Local') }),
  ] }) });
}
