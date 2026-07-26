/* Shared branding — swaps the generic wordmark for this venue's, if any.
 *
 * Pages ship GENERIC text inline ("LAN GAMES"), so a public clone is correct
 * with no JS and no config. This module only *overrides* that at runtime from
 * the gitignored data/venue.json (via /api/venue).
 *
 * Markup contract — put the generic text inline as the fallback:
 *     <title>BINGO · LAN GAMES</title>
 *     <p data-brand-presents>LAN GAMES PRESENTS</p>
 *     <span data-brand>LAN GAMES</span>
 *
 * <title> is handled automatically: the trailing wordmark after the last
 * separator (· — -) is replaced, so "BINGO · LAN GAMES" -> "BINGO · SMITH FAMILY ARCADE".
 *
 * Include with: <script src="/shared/brand.js" defer></script>
 */
(() => {
  const DEFAULT_NAME = "LAN GAMES";
  const DEFAULT_PRESENTS = "LAN GAMES PRESENTS";

  // Deliberately NOT cached in sessionStorage: /api/venue is a local request,
  // and caching it means an edit to venue.json appears to do nothing until you
  // open a new tab. Correctness beats one saved millisecond on a LAN.
  function apply(brand) {
    if (!brand) return;
    const name = brand.name || DEFAULT_NAME;
    const presents = brand.presents || DEFAULT_PRESENTS;

    // Title: replace only the wordmark segment, keep the page's own name.
    if (document.title.includes("GAMEHUB")) {
      document.title = document.title.split("GAMEHUB").join(name);
    } else if (name !== DEFAULT_NAME && document.title.includes(DEFAULT_NAME)) {
      document.title = document.title.split(DEFAULT_NAME).join(name);
    }
    for (const el of document.querySelectorAll("[data-brand]")) {
      el.textContent = name;
    }
    for (const el of document.querySelectorAll("[data-brand-presents]")) {
      el.textContent = presents;
    }
    for (const el of document.querySelectorAll("[data-brand-logo]")) {
      const parts = [...el.querySelectorAll(".b1,.b2")];
      if (parts.length < 2) {
        el.textContent = name;
        continue;
      }
      const words = name.includes(".") ? name.split(/\.(.+)/) : name.split(/\s+(.+)/);
      parts[0].textContent = words[0] || name;
      parts[1].textContent = words[1] || "";
      el.setAttribute("aria-label", name);
    }

    // Per-game rename, e.g. {"famfeud": "SMITH FEUD"}. The page ships the
    // generic name inline; this swaps it only if venue.json overrides it.
    const titles = brand.titles || {};
    for (const el of document.querySelectorAll("[data-brand-title]")) {
      const over = titles[el.getAttribute("data-brand-title")];
      if (!over) continue;
      // Split wordmarks (<span>FAM</span> <span>FEUD</span>) keep their spans.
      const parts = [...el.children].filter((c) => c.nodeType === 1);
      if (parts.length === 2) {
        const cut = over.indexOf(" ");
        parts[0].textContent = cut === -1 ? over : over.slice(0, cut);
        parts[1].textContent = cut === -1 ? "" : over.slice(cut + 1);
      } else {
        el.textContent = over;
      }
    }
    // <meta name="brand-game" content="<slug>"> lets the tab title rename too.
    const meta = document.querySelector('meta[name="brand-game"]');
    if (meta) {
      const over = titles[meta.getAttribute("content")];
      const generic = meta.getAttribute("data-generic");
      if (over && generic && document.title.includes(generic)) {
        document.title = document.title.split(generic).join(over);
      }
    }
    // Let late-rendering clients (canvas/TV splashes built in JS) read it.
    window.BRAND = { name, presents, titles: brand.titles || {} };
    window.dispatchEvent(new CustomEvent("brandready", { detail: window.BRAND }));
  }

  // Expose a sync accessor for code that renders after load.
  window.brandName = () => (window.BRAND && window.BRAND.name) || DEFAULT_NAME;
  window.brandPresents = () =>
    (window.BRAND && window.BRAND.presents) || DEFAULT_PRESENTS;

  fetch("/api/venue")
    .then((r) => r.json())
    .then((v) => {
      const brand = (v && v.brand) || null;
      if (!brand) return;
      apply(brand);
    })
    .catch(() => { /* no venue config (public clone) — generic text stands */ });
})();
