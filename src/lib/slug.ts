// Lowercase, ascii-fold, replace runs of non-alphanum with "-", trim.
// Bounded length so a 200-char title doesn't blow out the URL.
export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return base || 'flyer';
}

// Append the last 8 chars of the flyer id (lowercased ulid) so the slug is
// guaranteed unique even if two flyers share a title.
export function slugWithSuffix(title: string, id: string): string {
  return `${slugify(title)}-${id.slice(-8).toLowerCase()}`;
}
