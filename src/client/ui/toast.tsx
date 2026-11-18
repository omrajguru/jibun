import * as RToast from '@radix-ui/react-toast';
import { useSyncExternalStore, type ReactNode } from 'react';

export interface ToastItem {
  id: number;
  kind: 'info' | 'success' | 'error';
  title: string;
  body?: string;
  progress?: number | null;
  sticky?: boolean;
}

let items: ToastItem[] = [];
let seq = 1;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

function push(t: Omit<ToastItem, 'id'>): number {
  const id = seq++;
  items = [...items, { ...t, id }];
  emit();
  return id;
}

export const toast = {
  info: (title: string, body?: string) => push({ kind: 'info', title, body }),
  success: (title: string, body?: string) => push({ kind: 'success', title, body }),
  error: (title: string, body?: string) => push({ kind: 'error', title, body }),
  /** A sticky progress toast; update it with toast.update and close with toast.dismiss. */
  progress: (title: string, progress: number | null = null) => push({ kind: 'info', title, progress, sticky: true }),
  update: (id: number, patch: Partial<ToastItem>) => {
    items = items.map((t) => (t.id === id ? { ...t, ...patch } : t));
    emit();
  },
  dismiss: (id: number) => {
    items = items.filter((t) => t.id !== id);
    emit();
  },
};

export function errorMessage(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

export function Toaster({ children }: { children: ReactNode }) {
  const list = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => items,
  );
  return (
    <RToast.Provider swipeDirection="right" duration={4500}>
      {children}
      {list.map((t) => (
        <RToast.Root key={t.id} className={`toast ${t.kind}`} duration={t.sticky ? Infinity : t.kind === 'error' ? 8000 : 4500} onOpenChange={(o) => !o && toast.dismiss(t.id)}>
          <span className="dot" aria-hidden />
          <div className="grow">
            <RToast.Title style={{ fontWeight: 500 }}>{t.title}</RToast.Title>
            {t.body ? <RToast.Description style={{ opacity: 0.75, marginTop: 2 }}>{t.body}</RToast.Description> : null}
            {t.progress !== undefined ? (
              <div className="toast-progress">
                <i style={{ width: t.progress === null ? '30%' : `${Math.round(t.progress * 100)}%` }} />
              </div>
            ) : null}
          </div>
          {!t.sticky ? (
            <RToast.Close aria-label="Dismiss" className="btn btn-ghost btn-sm btn-icon" style={{ color: 'inherit', marginRight: -8, marginTop: -4 }}>
              ×
            </RToast.Close>
          ) : null}
        </RToast.Root>
      ))}
      <RToast.Viewport className="toast-viewport" />
    </RToast.Provider>
  );
}
