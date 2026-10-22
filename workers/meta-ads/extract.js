/* global document, URL */
/* eslint-disable @typescript-eslint/no-unused-expressions -- Evaluated as a browser function by Playwright. */
() => {
  // Capture immutable card snapshots before the scrolling worker moves again.
  const cards = new Map();
  for (const anchor of document.querySelectorAll('a[href]')) {
    const name = anchor.innerText.trim();
    if (!name || name === '\u200b') continue;
    let u;
    try {
      u = new URL(anchor.href);
    } catch {
      continue;
    }
    if (!['www.facebook.com', 'facebook.com', 'm.facebook.com'].includes(u.hostname)) continue;
    if (
      /^\/(ads|privacy|policies|help|login|watch|reel|photo|share|groups|events)(\/|\.|$)/i.test(
        u.pathname,
      )
    )
      continue;
    let node = anchor.parentElement;
    for (let depth = 0; node && depth < 18; depth++, node = node.parentElement) {
      const text = node.innerText || '';
      const ids = [...text.matchAll(/Library ID:\s*(\d+)/g)];
      if (ids.length > 1) break;
      if (ids.length !== 1 || !/(?:^|\n)Sponsored(?:\n|\s|$)/.test(text)) continue;
      const lines = text
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s && s !== '\u200b');
      const status = lines.find((s) => s === 'Active' || s === 'Inactive');
      if (!status) break;
      const id = ids[0][1];
      if (!cards.has(id))
        cards.set(id, {
          adId: id,
          name,
          facebookUrl: anchor.href,
          status,
          dateText: lines[lines.findIndex((s) => s.startsWith('Library ID:')) + 1] || '',
          text,
          adUrl: `https://www.facebook.com/ads/library/?id=${id}`,
        });
      break;
    }
  }
  return [...cards.values()];
};
