import * as RCheckbox from '@radix-ui/react-checkbox';
import * as RDialog from '@radix-ui/react-dialog';
import * as RMenu from '@radix-ui/react-dropdown-menu';
import * as RSelect from '@radix-ui/react-select';
import * as RSlider from '@radix-ui/react-slider';
import * as RSwitch from '@radix-ui/react-switch';
import * as RTooltip from '@radix-ui/react-tooltip';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './icons';

export { Icon };

// ---------------------------------------------------------------- Button

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'accent' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: boolean;
  loading?: boolean;
};
export function Button({ variant = 'default', size = 'md', icon, loading, className = '', children, disabled, ...rest }: BtnProps) {
  const cls = ['btn', variant !== 'default' && `btn-${variant}`, size !== 'md' && `btn-${size}`, icon && 'btn-icon', className].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <span className="spinner" aria-hidden /> : null}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- Tooltip

export function Tip({ label, children, side = 'top' }: { label: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <RTooltip.Root delayDuration={350}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content className="tooltip" side={side} sideOffset={6}>
          {label}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

// ---------------------------------------------------------------- Dialog

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  wide?: boolean;
}) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="overlay" />
        <RDialog.Content className={`dialog ${wide ? 'dialog-wide' : ''}`} aria-describedby={description ? undefined : undefined}>
          <RDialog.Title asChild>
            <h2>{title}</h2>
          </RDialog.Title>
          {description ? (
            <RDialog.Description asChild>
              <p className="muted">{description}</p>
            </RDialog.Description>
          ) : (
            <RDialog.Description className="sr-only">{typeof title === 'string' ? title : 'Dialog'}</RDialog.Description>
          )}
          {children}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

// ---------------------------------------------------------------- Confirm (replaces window.confirm)

type ConfirmOpts = { title: string; body?: ReactNode; confirm?: string; danger?: boolean };
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const ask = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      <Dialog open={!!state} onOpenChange={(o) => !o && close(false)} title={state?.title ?? ''} description={state?.body}>
        <div className="dialog-actions">
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant={state?.danger ? 'danger' : 'primary'} onClick={() => close(true)} autoFocus>
            {state?.confirm ?? 'Continue'}
          </Button>
        </div>
      </Dialog>
    </ConfirmCtx.Provider>
  );
}

// ---------------------------------------------------------------- Select

export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  placeholder,
}: {
  value: T | undefined;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
  label?: string;
  placeholder?: string;
}) {
  return (
    <RSelect.Root value={value} onValueChange={(v) => onChange(v as T)}>
      <RSelect.Trigger className="select-trigger" aria-label={label}>
        <RSelect.Value placeholder={placeholder} />
        <RSelect.Icon>
          <Icon name="chevron" size={14} />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content className="popover" position="popper" sideOffset={6}>
          <RSelect.Viewport>
            {options.map((o) => (
              <RSelect.Item key={o.value} value={o.value} className="item">
                <RSelect.ItemText>{o.label}</RSelect.ItemText>
                <RSelect.ItemIndicator style={{ marginLeft: 'auto' }}>
                  <Icon name="check" size={14} />
                </RSelect.ItemIndicator>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}

// ---------------------------------------------------------------- Menu

export function Menu({ trigger, items }: { trigger: ReactNode; items: ({ label: string; onSelect: () => void; danger?: boolean; disabled?: boolean } | 'sep')[] }) {
  return (
    <RMenu.Root>
      <RMenu.Trigger asChild>{trigger}</RMenu.Trigger>
      <RMenu.Portal>
        <RMenu.Content className="popover" align="end" sideOffset={6} style={{ minWidth: 200 }}>
          {items.map((it, i) =>
            it === 'sep' ? (
              <RMenu.Separator key={i} className="menu-sep" />
            ) : (
              <RMenu.Item key={i} className={`item ${it.danger ? 'danger' : ''}`} onSelect={it.onSelect} disabled={it.disabled}>
                {it.label}
              </RMenu.Item>
            ),
          )}
        </RMenu.Content>
      </RMenu.Portal>
    </RMenu.Root>
  );
}

// ---------------------------------------------------------------- Switch / Checkbox

export function Switch({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  const id = useRef(`sw-${Math.random().toString(36).slice(2)}`).current;
  return (
    <div className="row gap-3" style={{ justifyContent: 'space-between' }}>
      <label htmlFor={id} className="stack" style={{ cursor: 'pointer' }}>
        <span style={{ fontSize: 14, fontWeight: 500 }}>{label}</span>
        {hint ? <span className="hint">{hint}</span> : null}
      </label>
      <RSwitch.Root id={id} className="switch" checked={checked} onCheckedChange={onChange}>
        <RSwitch.Thumb className="switch-thumb" />
      </RSwitch.Root>
    </div>
  );
}

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="check-row">
      <RCheckbox.Root className="checkbox" checked={checked} onCheckedChange={(v) => onChange(v === true)}>
        <RCheckbox.Indicator>
          <Icon name="check" size={13} />
        </RCheckbox.Indicator>
      </RCheckbox.Root>
      <span style={{ fontSize: 14 }}>{label}</span>
    </label>
  );
}

// ---------------------------------------------------------------- Slider

export function Slider({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  format = (v) => String(v),
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
}) {
  return (
    <div className="control">
      <span className="label">{label}</span>
      <span className="value">{format(value)}</span>
      <RSlider.Root className="slider" value={[value]} min={min} max={max} step={step} onValueChange={(v) => onChange(v[0]!)} aria-label={label}>
        <RSlider.Track className="slider-track">
          <RSlider.Range className="slider-range" />
        </RSlider.Track>
        <RSlider.Thumb className="slider-thumb" />
      </RSlider.Root>
    </div>
  );
}

// ---------------------------------------------------------------- Progress / states

export function Progress({ value }: { value: number | null }) {
  return (
    <div className={`progress ${value === null ? 'indeterminate' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : Math.round(value * 100)}>
      <i style={value === null ? undefined : { width: `${Math.max(2, Math.min(100, value * 100))}%` }} />
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" role="status" aria-label="Loading" />;
}

export function Empty({ title, body, action, icon = 'pen' }: { title: string; body?: ReactNode; action?: ReactNode; icon?: Parameters<typeof Icon>[0]['name'] }) {
  return (
    <div className="empty">
      <div className="dropzone-icon" style={{ display: 'grid', placeItems: 'center', width: 56, height: 56, borderRadius: 16, background: 'var(--g100)' }}>
        <Icon name={icon} size={24} />
      </div>
      <h3>{title}</h3>
      {body ? <p>{body}</p> : null}
      {action}
    </div>
  );
}

export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="error-box row gap-3" role="alert" style={{ justifyContent: 'space-between' }}>
      <span>{msg}</span>
      {retry ? (
        <Button size="sm" onClick={retry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- DropZone

export function DropZone({ onFiles, accept, title, hint, multiple = true }: { onFiles: (f: File[]) => void; accept: string; title: string; hint?: string; multiple?: boolean }) {
  const [active, setActive] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  return (
    <div
      className="dropzone"
      data-active={active}
      role="button"
      tabIndex={0}
      onClick={() => input.current?.click()}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), input.current?.click())}
      onDragEnter={(e) => {
        e.preventDefault();
        depth.current++;
        setActive(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        depth.current--;
        if (depth.current <= 0) setActive(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        depth.current = 0;
        setActive(false);
        const files = [...e.dataTransfer.files];
        if (files.length) onFiles(files);
      }}
    >
      <div className="icon">
        <Icon name="upload" size={22} />
      </div>
      <div style={{ fontWeight: 500 }}>{title}</div>
      {hint ? <div className="hint">{hint}</div> : null}
      <input
        ref={input}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- misc hooks

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
