import { useSyncExternalStore } from 'react';

const subs = new Set<() => void>();
window.addEventListener('popstate', () => subs.forEach((f) => f()));

export function navigate(to: string, replace = false) {
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  subs.forEach((f) => f());
  window.scrollTo({ top: 0 });
}

export function usePath(): string {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => location.pathname + location.search,
  );
}

/** Match "/fonts/:id/:tab?" style patterns. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = path.split('?')[0]!.split('/').filter(Boolean);
  const parts = pattern.split('/').filter(Boolean);
  const out: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const optional = part.endsWith('?');
    const name = part.replace(/^:/, '').replace(/\?$/, '');
    const seg = p[i];
    if (seg === undefined) {
      if (optional) continue;
      return null;
    }
    if (part.startsWith(':')) out[name] = decodeURIComponent(seg);
    else if (part !== seg) return null;
  }
  if (p.length > parts.length) return null;
  return out;
}

export function Link({ to, children, className, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
