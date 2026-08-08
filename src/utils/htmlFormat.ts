const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

// Telegram's HTML parse_mode needs these escaped in any user-controlled text (a username falling
// back to first_name, or a group's chat title) and in the href attribute below — first_name and
// chat titles have no character restrictions, unlike a Telegram @username.
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => HTML_ESCAPES[ch]);
}

// Mirrors submissionService.ts's PLACE_LINK_PATTERNS' Instagram pattern, but captures the
// username so it can be shown as the link text — the only one of the three accepted providers
// whose URL contains anything human-readable at all (expz.menu's UUID and Maps' short code don't).
const INSTAGRAM_USERNAME = /^https:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]+)\/?(?:\?.*)?$/;

const GENERIC_PLACE_LABEL = 'заклад';

// Extracted out of placeLink below so a plain-text context (a Telegram inline button's label,
// which can't render HTML) can reuse the exact same "Instagram username, else a generic заклад"
// derivation — see commands/menu.ts's recent-places quick-pick keyboard.
export function placeLabel(place: string): string {
  return place.match(INSTAGRAM_USERNAME)?.[1] ?? GENERIC_PLACE_LABEL;
}

// Two different expz.menu/Maps links both fall back to the same generic "заклад" label, so
// listing several of them side by side (e.g. /admin's "🏆 Топ переможців") makes genuinely
// different venues look identical. This appends a short, stable tail of the raw URL as a
// distinguishing hint — stripped of any trailing query string first, so a resubmitted link that
// picked up a fresh tracking param doesn't grow a different-looking hint for the same place.
// Instagram links already get a real label from placeLabel and need no hint.
export function placeLabelWithHint(place: string): string {
  const label = placeLabel(place);
  if (label !== GENERIC_PLACE_LABEL) return label;
  const tail = place.split('?')[0].replace(/\/$/, '').slice(-4);
  return `${label} (…${tail})`;
}

// place is validated by isValidPlaceLink before it ever reaches here, but that pattern's trailing
// `(\?.*)?` accepts an arbitrary query string, which could still smuggle a `"` and break out of
// the href attribute — escaped the same way as any other untrusted text.
export function placeLink(place: string): string {
  return `<a href="${escapeHtml(place)}">${placeLabel(place)}</a>`;
}

// Same href as placeLink, but the visible text uses placeLabelWithHint instead of placeLabel — for
// a list of several *different* places shown together (e.g. /admin's "🏆 Топ переможців"), where
// two different generic-fallback places sitting right next to each other as identical-looking
// "заклад" links would still read as confusing even though each one is individually clickable.
export function placeLinkWithHint(place: string): string {
  return `<a href="${escapeHtml(place)}">${placeLabelWithHint(place)}</a>`;
}
