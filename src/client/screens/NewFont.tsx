import { useMemo, useState } from 'react';
import type { Paper } from '../../shared/layout';
import { cellsPerPage } from '../../shared/layout';
import { LIMITS } from '../../shared/types';
import { PRESETS, dedupeKeys, keysToWrite, parseCustomList } from '../../shared/unicode';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { Button, Icon, Select } from '../ui';
import { errorMessage, toast } from '../ui/toast';

type Route = 'print' | 'upload' | 'screen';

export function NewFont() {
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [presets, setPresets] = useState<string[]>(['latin-basic', 'digits', 'punctuation']);
  const [custom, setCustom] = useState('');
  const [route, setRoute] = useState<Route>('print');
  const [paper, setPaper] = useState<Paper>(navigator.language === 'en-US' ? 'letter' : 'a4');
  const [samples, setSamples] = useState('1');
  const [busy, setBusy] = useState(false);

  const keys = useMemo(() => dedupeKeys([...PRESETS.filter((p) => presets.includes(p.id)).flatMap((p) => p.keys()), ...parseCustomList(custom)]), [presets, custom]);
  const toWrite = useMemo(() => keysToWrite(keys, true), [keys]);
  const perChar = Number(samples);
  const pages = Math.ceil((toWrite.write.length * perChar) / cellsPerPage(paper));
  const tooMany = keys.length > LIMITS.maxCharacters;

  const create = async () => {
    setBusy(true);
    try {
      // Include the plain letters and accents needed to compose accented letters.
      const d = await api.createProject({ name: name.trim() || 'My handwriting', keys: dedupeKeys([...keys, ...toWrite.write]), paper, samplesPerChar: perChar, settings: { familyName: name.trim() || 'My Handwriting' } });
      navigate(`/fonts/${d.project.id}/capture?route=${route}`, true);
    } catch (e) {
      toast.error('Could not create the font', errorMessage(e));
      setBusy(false);
    }
  };

  const groups = [...new Set(PRESETS.map((p) => p.group))];

  return (
    <div className="page page-narrow">
      <div className="steps" aria-hidden>
        {[0, 1, 2].map((i) => (
          <i key={i} className={i <= step ? 'on' : ''} />
        ))}
      </div>

      {step === 0 ? (
        <form
          className="stack gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            setStep(1);
          }}
        >
          <div className="stack gap-2">
            <div className="eyebrow">Step 1 of 3</div>
            <h1 className="display" style={{ fontSize: 48 }}>
              Name your font
            </h1>
            <p className="muted">This is the name you will pick from the font menu later.</p>
          </div>
          <input className="input" style={{ height: 56, fontSize: 20 }} autoFocus placeholder="My Handwriting" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button variant="primary" size="lg" type="submit">
              Continue <Icon name="arrowRight" />
            </Button>
          </div>
        </form>
      ) : null}

      {step === 1 ? (
        <div className="stack gap-6">
          <div className="stack gap-2">
            <div className="eyebrow">Step 2 of 3</div>
            <h1 className="display" style={{ fontSize: 48 }}>
              Choose characters
            </h1>
            <p className="muted">Accented letters are built automatically from the plain letter and its accent, so you write far fewer.</p>
          </div>
          {groups.map((g) => (
            <div key={g} className="stack gap-3">
              <div className="label">{g}</div>
              <div className="choice-grid">
                {PRESETS.filter((p) => p.group === g).map((p) => {
                  const on = presets.includes(p.id);
                  return (
                    <button key={p.id} className="choice" aria-pressed={on} onClick={() => setPresets((s) => (on ? s.filter((x) => x !== p.id) : [...s, p.id]))}>
                      <span className="row" style={{ justifyContent: 'space-between' }}>
                        <span className="title">{p.name}</span>
                        <span className="meta tabular">{p.keys().length}</span>
                      </span>
                      <span className="meta">{p.description}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="field">
            <label className="label" htmlFor="custom">
              Your own characters
            </label>
            <textarea id="custom" className="textarea" placeholder="Paste any characters, words or U+XXXX codes. For example: ſ ß ﬁ ✶" value={custom} onChange={(e) => setCustom(e.target.value)} />
            <span className="hint">Separate with spaces to keep sequences such as conjuncts together.</span>
          </div>
          <div className="card card-pad row gap-4 wrap" style={{ justifyContent: 'space-between' }}>
            <div className="stack">
              <span className="display" style={{ fontSize: 34 }}>
                {keys.length.toLocaleString()} characters
              </span>
              <span className="muted small">
                You write {toWrite.write.length.toLocaleString()}; {toWrite.composed.length.toLocaleString()} are composed for you.
              </span>
              {tooMany ? <span className="small" style={{ color: 'var(--danger)' }}>A font holds up to {LIMITS.maxCharacters.toLocaleString()} base characters.</span> : null}
            </div>
            <div className="row gap-2">
              <Button size="lg" onClick={() => setStep(0)}>
                Back
              </Button>
              <Button variant="primary" size="lg" disabled={!keys.length || tooMany} onClick={() => setStep(2)}>
                Continue <Icon name="arrowRight" />
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="stack gap-6">
          <div className="stack gap-2">
            <div className="eyebrow">Step 3 of 3</div>
            <h1 className="display" style={{ fontSize: 48 }}>
              How will you write?
            </h1>
            <p className="muted">You can switch at any time; every route feeds the same font.</p>
          </div>
          <div className="stack gap-3" role="radiogroup" aria-label="Input route">
            {(
              [
                ['print', 'printer', 'Print and photograph', 'Download a PDF, write with a pen, then take photos with your phone.'],
                ['upload', 'upload', 'Upload a scan', 'Already printed and filled in a sheet? Upload the scan or photo.'],
                ['screen', 'pen', 'Write on screen', 'Use a stylus or your finger. No printer needed.'],
              ] as const
            ).map(([id, icon, title, body]) => (
              <button key={id} role="radio" aria-checked={route === id} className="choice choice-lg row gap-4" style={{ flexDirection: 'row', alignItems: 'center' }} onClick={() => setRoute(id)}>
                <span style={{ display: 'grid', placeItems: 'center', width: 48, height: 48, borderRadius: 12, background: 'var(--g100)', flex: 'none' }}>
                  <Icon name={icon} size={22} />
                </span>
                <span className="stack gap-1">
                  <span className="title">{title}</span>
                  <span className="meta">{body}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="row gap-5 wrap">
            {route !== 'screen' ? (
              <div className="field">
                <span className="label">Paper</span>
                <Select<Paper> value={paper} onChange={setPaper} label="Paper size" options={[{ value: 'a4', label: 'A4' }, { value: 'letter', label: 'US Letter' }]} />
              </div>
            ) : null}
            <div className="field">
              <span className="label">Samples of each character</span>
              <Select
                value={samples}
                onChange={setSamples}
                label="Samples per character"
                options={[
                  { value: '1', label: 'One' },
                  { value: '2', label: 'Two, for natural variation' },
                  { value: '3', label: 'Three, for more variation' },
                ]}
              />
            </div>
          </div>
          <div className="card card-pad row gap-4 wrap" style={{ justifyContent: 'space-between' }}>
            <span className="muted">{route === 'screen' ? `${toWrite.write.length * perChar} cells to write on screen` : `${pages} ${pages === 1 ? 'page' : 'pages'} to print`}</span>
            <div className="row gap-2">
              <Button size="lg" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button variant="primary" size="lg" loading={busy} onClick={create}>
                Create font
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
