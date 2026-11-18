export function paginate(items, page, pageSize) {
  const start = page * pageSize;
  return {
    page,
    pageSize,
    total: items.length,
    items: items.slice(start, start + pageSize),
  };
}
