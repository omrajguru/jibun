import { api } from '../lib/api';
import { Link } from '../lib/router';
import { Empty, ErrorBox, Icon } from '../ui';
import { relTime, useLoad } from './Library';

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function History() {
  const { data, error, reload } = useLoad(() => api.builds());
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">History</div>
          <h1 className="display">Exports</h1>
        </div>
      </div>
      {error ? <ErrorBox error={error} retry={reload} /> : null}
      {data && !data.length ? (
        <div className="card">
          <Empty icon="download" title="No exports yet" body="When you export a font, every version is kept here so you can download it again." />
        </div>
      ) : null}
      {data?.length ? (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Font</th>
                <th>When</th>
                <th>Glyphs</th>
                <th>Status</th>
                <th>Files</th>
              </tr>
            </thead>
            <tbody>
              {data.map((b) => (
                <tr key={b.id}>
                  <td>
                    <Link to={`/fonts/${b.projectId}/export`}>{b.projectName}</Link>
                  </td>
                  <td className="muted">{relTime(b.createdAt)}</td>
                  <td className="tabular">{b.glyphCount ?? '–'}</td>
                  <td>{b.status === 'done' ? <span className="pill green">Ready</span> : b.status === 'failed' ? <span className="pill red">Failed</span> : <span className="pill blue">Building</span>}</td>
                  <td>
                    <div className="row gap-2 wrap">
                      {b.files.map((f) => (
                        <a key={f.format} className="btn btn-sm" href={api.fileUrl(b.id, f.format)} download>
                          <Icon name="download" size={14} /> {f.format.toUpperCase()} <span className="muted">{formatBytes(f.size)}</span>
                        </a>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
