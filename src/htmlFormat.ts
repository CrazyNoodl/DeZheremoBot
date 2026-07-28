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

// place is validated by isValidPlaceLink before it ever reaches here, but that pattern's trailing
// `(\?.*)?` accepts an arbitrary query string, which could still smuggle a `"` and break out of
// the href attribute — escaped the same way as any other untrusted text.
export function placeLink(place: string): string {
  const label = place.match(INSTAGRAM_USERNAME)?.[1] ?? 'заклад';
  return `<a href="${escapeHtml(place)}">${label}</a>`;
}
