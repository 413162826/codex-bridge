export function normalizeStaticPathname(pathname, rootPath) {
  const value = pathname === '/' ? rootPath : pathname;
  if (value === '/m/index.htm') return '/m/index.html';
  return value;
}
