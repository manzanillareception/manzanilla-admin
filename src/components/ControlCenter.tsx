'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Activity, AlertTriangle, ArrowDownToLine, ArrowRight, Check, CheckCheck, ChevronRight, CircleHelp, Clock3, Code2, Copy, GitPullRequest, Globe2, KeyRound, Languages, LayoutGrid, LoaderCircle, LockKeyhole, Monitor, Moon, Radio, RefreshCw, Search, ShieldCheck, ShieldOff, SlidersHorizontal, Wifi, X, Zap } from 'lucide-react';
import { filterDevices, filterIncidents, getConnection, summarizeTraffic, summarizeUsage } from '../domain/analytics';
import { DEFAULT_FILTERS, FEATURE_LABELS, type Access, type Device, type Filters, type Incident } from '../domain/types';
import { createDemoSource, type DemoSource } from './data/demo-source';
import { DashboardError, type CreateHotelInput, type CreateHotelResult, type DashboardDataSource, type DashboardRead, type RecoveryMode, type SnapshotDevice } from './data/types';
import { LIVE_POLL_MS } from './data/live-source';
import { describeUpdate } from './data/update-state';
import { SignOutButton } from './auth/SignOutButton';
import { createClient } from '../lib/supabase/browser';
import { forbiddenPresentation } from './forbidden-state';
import type { AssuranceLevel } from './auth/post-login';

type Tab = 'devices' | 'usage' | 'traffic' | 'failures';
const NAV: { id: Tab; label: string; icon: typeof Monitor }[] = [
  { id: 'devices', label: 'Devices', icon: Monitor },
  { id: 'usage', label: 'Feature usage', icon: LayoutGrid },
  { id: 'traffic', label: 'Traffic', icon: Activity },
  { id: 'failures', label: 'Failures', icon: AlertTriangle },
];
const TEXT: Record<Tab, { eyebrow: string; title: string; description: string }> = {
  devices: { eyebrow: 'FLEET CONTROL', title: 'Every device. In your control.', description: 'Approve access, check connectivity and see what needs attention.' },
  usage: { eyebrow: 'FEATURE ADOPTION', title: 'Know what gets used.', description: 'Understand translation and night receptionist usage. No conversations collected.' },
  traffic: { eyebrow: 'OPERATIONAL LOAD', title: 'A clear view of traffic.', description: 'Device API requests and voice connection load. No guest or website tracking.' },
  failures: { eyebrow: 'RELIABILITY', title: 'Catch it. Understand it. Fix it.', description: 'Group technical failures and prepare the right next step for each one.' },
};
const fmt = new Intl.NumberFormat('en-GB');
const num = (n: number) => fmt.format(Math.round(n));
const date = (s: string) => new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
const day = (s: string) => new Date(s).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
const sentence = (s: string) => s.replaceAll('_', ' ').replace(/^./, (v) => v.toUpperCase());

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) { return <span className={`badge badge-${tone}`}>{children}</span>; }
function ConnectionBadge({ device, asOf }: { device: Device; asOf: string }) { const c = getConnection(device, asOf); return <span className={`connection connection-${c}`}><i />{c === 'unknown' ? 'Never seen' : sentence(c)}</span>; }
function AccessBadge({ access }: { access: Access }) { return <Badge tone={access === 'approved' ? 'green' : access === 'blocked' ? 'neutral' : 'amber'}>{sentence(access)}</Badge>; }
function Metric({ label, value, note, icon: Icon, tone = '' }: { label: string; value: ReactNode; note: string; icon: typeof Monitor; tone?: string }) { return <article className={`metric ${tone}`}><div className="metric-top"><span>{label}</span><Icon size={17} strokeWidth={1.7} /></div><strong>{value}</strong><span className="metric-note">{note}</span></article>; }
function Empty({ children }: { children: ReactNode }) { return <div className="empty"><Search size={26} /><strong>No matching records</strong><p>{children}</p></div>; }
function Modal({ title, context, children, onClose, wide = false }: { title: string; context: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null); const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; closeRef.current?.focus(); const oldOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    if (e.key === 'Tab') { const nodes = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input,select,textarea,[tabindex="0"]'); if (!nodes?.length) return; const first = nodes[0], last = nodes[nodes.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }
  }; document.addEventListener('keydown', key); return () => { document.removeEventListener('keydown', key); document.body.style.overflow = oldOverflow; previous?.focus(); }; }, [onClose]);
  return <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}><div ref={ref} role="dialog" aria-modal="true" aria-label={title} className={`detail-panel ${wide ? 'detail-wide' : ''}`}><div className="detail-top"><span>{context}</span><button className="icon-button" onClick={onClose} ref={closeRef} aria-label="Close details"><X size={21} /></button></div>{children}</div></div>;
}

/**
 * 403 body: an enabled admin with an incomplete MFA step gets a calm next
 * step (enroll or challenge), never the harsher "No admin access"; that
 * heading is reserved for accounts without enabled admin membership.
 */
function ForbiddenBody({ error, onRetry }: { error: DashboardError; onRetry: () => void }) {
  const [aal, setAal] = useState<AssuranceLevel | null>(null);
  useEffect(() => {
    if (error.serverCode === 'MFA_SETUP_REQUIRED') return;
    const client = createClient();
    if (!client) return;
    let cancelled = false;
    client.auth.mfa.getAuthenticatorAssuranceLevel()
      .then(({ data }) => { if (!cancelled) setAal(data ?? null); })
      .catch(() => { /* no session or unavailable: stay with no-access */ });
    return () => { cancelled = true; };
  }, [error.serverCode]);
  const view = forbiddenPresentation(error.serverCode, error.message, aal);
  if (view === 'mfa-setup') return <>
    <h1>Finish two-factor setup</h1>
    <p>Your admin account is ready. Link an authenticator app to open fleet control - it takes about a minute.</p>
    <div className="status-actions"><a className="button button-primary" href="/mfa/enroll">Set up two-factor authentication</a><button className="button button-outline" onClick={onRetry}>Retry</button></div>
  </>;
  if (view === 'mfa-challenge') return <>
    <h1>Two-factor check needed</h1>
    <p>Your account is fine - this session just needs the 6-digit code from your authenticator app before fleet control opens.</p>
    <div className="status-actions"><a className="button button-primary" href="/mfa/challenge">Complete two-factor check</a><button className="button button-outline" onClick={onRetry}>Retry</button></div>
  </>;
  return <>
    <h1>No admin access</h1>
    <p>This account is not an enabled Manzanilla admin. Ask a team admin to review access.</p>
    <div className="status-actions"><a className="button button-primary" href="/login">Go to sign in</a><button className="button button-outline" onClick={onRetry}>Retry</button></div>
  </>;
}

type Status = 'loading' | 'ready' | 'unavailable' | 'unauthorized';

function LoadingShell() {
  return <main className="loading"><LoaderCircle className="spin" size={25} /><span>Opening fleet control…</span></main>;
}

function StatusShell({ error, onRetry }: { error: DashboardError; onRetry: () => void }) {
  const unauthorized = error.kind === 'unauthorized' || error.kind === 'forbidden';
  return <main className="status-shell">
    <div className="status-card">
      <div className={`detail-icon ${unauthorized ? '' : 'warning'}`}>{unauthorized ? <LockKeyhole size={26} /> : <AlertTriangle size={26} />}</div>
      {error.kind === 'forbidden' ? <ForbiddenBody error={error} onRetry={onRetry} /> : unauthorized ? <>
        <h1>Sign in required</h1>
        <p>The Manzanilla fleet dashboard needs an enabled admin account with MFA.</p>
        <div className="status-actions"><a className="button button-primary" href="/login">Go to sign in</a><button className="button button-outline" onClick={onRetry}>Retry</button></div>
      </> : <>
        <h1>{error.kind === 'setup-required' ? 'Backend not connected yet' : 'Dashboard unavailable'}</h1>
        <p>{error.kind === 'setup-required'
          ? 'The control API reports SETUP_REQUIRED: the database and device adapters are still being connected. Nothing here is simulated.'
          : error.message}</p>
        <div className="status-actions"><button className="button button-primary" onClick={onRetry}><RefreshCw size={15} />Retry now</button><a className="button button-outline" href="/demo">Open the labelled interface demo</a></div>
        <p className="microcopy">Live data never falls back to demo. The demo opens only when you choose it.</p>
      </>}
    </div>
  </main>;
}

export default function ControlCenter({ source: givenSource }: { source?: DashboardDataSource }) {
  const fallback = useRef<DemoSource | null>(null);
  if (!givenSource && !fallback.current) fallback.current = createDemoSource();
  const source = givenSource ?? fallback.current!;
  const demoSource = source.mode === 'demo' ? (source as DemoSource) : null;
  const isDemo = source.mode === 'demo';

  const [read, setReadState] = useState<DashboardRead | null>(null);
  const readRef = useRef<DashboardRead | null>(null);
  const setRead = (next: DashboardRead | null) => { readRef.current = next; setReadState(next); };
  const [status, setStatus] = useState<Status>('loading');
  const [failure, setFailure] = useState<DashboardError | null>(null);
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<Tab>('devices');
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [query, setQuery] = useState('');
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null);
  const [selectedIncident, setSelectedIncident] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [hotelOpen, setHotelOpen] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [packet, setPacket] = useState<unknown | null>(null);

  const load = useCallback(async (initial = false) => {
    if (!initial) setRefreshing(true);
    try {
      const next = await source.load();
      setRead(next); setStatus('ready'); setFailure(null); setStale(false);
      return next;
    } catch (error) {
      const known = error instanceof DashboardError ? error : new DashboardError('unavailable', error instanceof Error ? error.message : 'Dashboard data could not be loaded.', true);
      if (readRef.current) { setStale(true); setNotice(`Refresh failed (${known.message}). Showing the last good data.`); }
      else { setFailure(known); setStatus(known.kind === 'unauthorized' || known.kind === 'forbidden' ? 'unauthorized' : 'unavailable'); }
      return null;
    } finally { setRefreshing(false); }
  }, [source]);

  useEffect(() => { void load(true); }, [load]);
  useEffect(() => {
    if (isDemo) return;
    const tick = () => { if (!document.hidden) void load(); };
    const timer = setInterval(tick, LIVE_POLL_MS);
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', visible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [isDemo, load]);
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(''), 6500); return () => clearTimeout(t); }, [notice]);

  const activeFilters = useMemo(() => ({ ...filters, feature: tab === 'usage' ? filters.feature : 'all' as const }), [filters, tab]);

  if (status === 'unauthorized' && failure) return <StatusShell error={failure} onRetry={() => { setStatus('loading'); void load(true); }} />;
  if (status === 'unavailable' && failure) return <StatusShell error={failure} onRetry={() => { setStatus('loading'); void load(true); }} />;
  if (status === 'loading' || !read) return <LoadingShell />;

  const snapshot = read.snapshot;
  const asOf = read.asOf;
  const devices = filterDevices(snapshot, activeFilters);
  const rows: SnapshotDevice[] = devices.filter((d) => `${d.code} ${d.label} ${snapshot.hotels.find((h) => h.id === d.hotelId)?.name}`.toLowerCase().includes(query.toLowerCase()));
  const incidents = filterIncidents(snapshot, activeFilters);
  const usage = summarizeUsage(snapshot, activeFilters);
  const traffic = summarizeTraffic(snapshot, activeFilters);
  const openIncidents = incidents.filter((i) => i.status !== 'resolved');
  const pending = devices.filter((d) => d.access.desired === 'pending').length;
  const online = devices.filter((d) => getConnection(d, asOf) === 'online').length;
  const approved = devices.filter((d) => d.access.desired === 'approved').length;
  const selected = snapshot.devices.find((d) => d.id === selectedDevice);
  const selectedFailure = snapshot.incidents.find((i) => i.id === selectedIncident);
  const current = TEXT[tab];
  const setFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters((f) => ({ ...f, [key]: value, ...(key === 'hotelId' ? { deviceId: 'all' } : {}) }));
  const navigate = (value: Tab) => { setTab(value); setQuery(''); window.scrollTo({ top: 0, behavior: 'instant' }); };

  const run = async (op: () => Promise<DashboardRead>, success: string) => {
    try {
      const next = await op();
      setRead(next); setStale(false);
      if (success) setNotice(success);
      return true;
    } catch (error) {
      if (error instanceof DashboardError && (error.kind === 'conflict' || error.kind === 'invalid-state' || error.kind === 'not-found')) {
        setNotice(error.kind === 'not-found'
          ? 'That record no longer exists. Data refreshed.'
          : error.kind === 'invalid-state'
            ? `${error.message} Data refreshed.`
            : 'That record changed on the server. Data refreshed — review and try again.');
        void load();
      } else if (error instanceof DashboardError && (error.kind === 'unauthorized' || error.kind === 'forbidden')) {
        setFailure(error); setStatus('unauthorized');
      } else {
        setNotice(error instanceof Error ? error.message : 'The action failed.');
      }
      return false;
    }
  };

  const saveRepair = (incident: Incident) => {
    void run(async () => {
      const result = await source.prepareRepair(incident);
      setPacket(result.packet);
      return result.read;
    }, isDemo ? 'Sanitized brief prepared locally. No repository or pipeline was contacted.' : 'Sanitized repair brief requested on the server.');
  };

  return <div className="app-shell">
    <aside className="sidebar">
      <a href="#main" className="brand" aria-label="Manzanilla fleet control">manzanilla<span>✳</span></a>
      <span className="internal-label">INTERNAL ADMIN</span>
      <div className="nav-caption">WORKSPACE</div>
      <nav aria-label="Main navigation">{NAV.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${tab === id ? 'active' : ''}`} aria-label={label} aria-current={tab === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon size={19} strokeWidth={1.7} /><span>{label}</span>{id === 'failures' && <span className="nav-count">{snapshot.incidents.filter((i) => i.status !== 'resolved').length}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="privacy-card"><ShieldCheck size={20} /><strong>Operations, not conversations.</strong><p>Only technical activity belongs here.</p></div><button className="setup-button" aria-label="Connection setup" onClick={() => setSetupOpen(true)}><SlidersHorizontal size={17} /><span>{isDemo ? 'Connection setup' : 'Live connection'}</span><span className="setup-dot" /></button><div className="profile"><span className="avatar">M</span><div><strong>Manzanilla team</strong><small>{isDemo ? 'Local workspace' : 'Signed-in admin'}</small></div><LockKeyhole size={14} /></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb">Workspace <ChevronRight size={13} /><span>{NAV.find((n) => n.id === tab)?.label}</span></div><div className="topbar-right">{isDemo ? <span className="demo-label"><i />Local demo</span> : <span className={`demo-label ${stale ? 'demo-label-stale' : 'live-label'}`}><i />{stale ? 'Connection lost' : 'Live'}</span>}<button className="icon-button alert-button" aria-label="View failure alerts" onClick={() => navigate('failures')}><AlertTriangle size={18} />{snapshot.incidents.some((i) => i.severity === 'critical' && i.status !== 'resolved') && <i />}</button>{!isDemo && <SignOutButton />}<span className="avatar avatar-small">M</span></div></header>
      <main id="main" className="workspace">
        <div className="page-heading"><div><div className="eyebrow">{current.eyebrow}</div><h1>{current.title}</h1><p>{current.description}</p></div>{isDemo
          ? <button className="button button-outline reset-button" onClick={() => setResetConfirm(true)}><RefreshCw size={15} />Reset demo</button>
          : <button className="button button-outline reset-button" onClick={() => void load()} disabled={refreshing}><RefreshCw size={15} className={refreshing ? 'spin' : ''} />{refreshing ? 'Refreshing…' : 'Refresh'}</button>}</div>
        {isDemo && <div className="demo-banner"><div><span className="demo-indicator"><Radio size={15} /></span><span><strong>No devices connected.</strong> This is a working mockup with synthetic data. Actions stay in this browser.</span></div><button onClick={() => setSetupOpen(true)}>What connects later <ArrowRight size={14} /></button></div>}
        {!isDemo && stale && <div className="demo-banner stale-banner"><div><span className="demo-indicator"><AlertTriangle size={15} /></span><span><strong>Connection lost.</strong> Showing the last good data from {date(asOf)} UTC. Retrying every {LIVE_POLL_MS / 1000} seconds.</span></div><button onClick={() => void load()}>Retry now <RefreshCw size={14} /></button></div>}
        <section className="filters" aria-label="Reporting filters"><div className="filter-group"><label><Clock3 size={15} /><select aria-label="Reporting period" value={filters.periodDays} onChange={(e) => setFilter('periodDays', Number(e.target.value) as Filters['periodDays'])}><option value="1">Today</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option></select></label><label><Globe2 size={15} /><select aria-label="Hotel" value={filters.hotelId} onChange={(e) => setFilter('hotelId', e.target.value)}><option value="all">All hotels</option>{snapshot.hotels.map((h) => <option value={h.id} key={h.id}>{h.name}</option>)}</select></label><label><Monitor size={15} /><select aria-label="Device" value={filters.deviceId} onChange={(e) => setFilter('deviceId', e.target.value)}><option value="all">All devices</option>{snapshot.devices.filter((d) => filters.hotelId === 'all' || d.hotelId === filters.hotelId).map((d) => <option value={d.id} key={d.id}>{d.code} · {d.label}</option>)}</select></label>{tab === 'usage' && <label><LayoutGrid size={15} /><select aria-label="Feature" value={filters.feature} onChange={(e) => setFilter('feature', e.target.value as Filters['feature'])}><option value="all">Both features</option><option value="translation">Translation</option><option value="reception">Night receptionist</option></select></label>}</div><span className="snapshot-time">{isDemo ? 'Snapshot' : 'Data as of'} · {date(asOf)} UTC</span></section>
        {tab === 'devices' && <>
          <section className="metrics-grid" aria-label="Device summary"><Metric label="Devices in fleet" value={num(devices.length)} note={`${num(snapshot.hotels.filter((h) => devices.some((d) => d.hotelId === h.id)).length)} hotels in view`} icon={Monitor} /><Metric label="Awaiting approval" value={num(pending)} note="New installations to review" icon={Clock3} tone={pending ? 'metric-highlight' : ''} /><Metric label="Approved access" value={num(approved)} note="Desired service policy" icon={ShieldCheck} /><Metric label="Online devices" value={<>{online}<span className="metric-denominator"> / {devices.length}</span></>} note="Heartbeat within 90 seconds" icon={Wifi} /></section>
          <section className="panel device-table-panel"><div className="panel-heading"><div><h2>Device fleet <span className="count-pill">{rows.length}</span></h2><p>Access policy and connection status are tracked separately.</p></div><div className="panel-actions"><label className="search-input"><Search size={16} /><input aria-label="Search devices" placeholder="Search hotel or device" value={query} onChange={(e) => setQuery(e.target.value)} /></label>{!isDemo && <><button className="button button-outline button-small" onClick={() => setTokenOpen(true)}><KeyRound size={15} />Device setup</button><button className="button button-primary button-small" onClick={() => setHotelOpen(true)}>Add hotel</button></>}</div></div><div className="table-scroll"><table className="data-table device-table"><thead><tr><th>Device / hotel</th><th>Service policy</th><th>Connection</th><th>Build</th><th>Update status</th><th className="align-right">Details</th></tr></thead><tbody>{rows.map((d) => <tr key={d.id}><td><div className={`device-symbol ${d.access.desired === 'pending' ? 'device-symbol-pending' : ''}`}><Monitor size={19} /></div><div className="cell-stack"><strong>{d.label} <small>{d.code}</small></strong><span>{snapshot.hotels.find((h) => h.id === d.hotelId)?.name}</span></div></td><td><AccessBadge access={d.access.desired} />{d.access.revision !== d.access.ackRevision && <small className="cell-note">Device confirmation pending</small>}{!d.managed && <small className="cell-note">Legacy · integration needed</small>}</td><td><ConnectionBadge device={d} asOf={asOf} /><small className="cell-note">{d.lastSeenAt ? date(d.lastSeenAt) : 'No heartbeat received'}</small></td><td><span className="build-tag">{d.build}</span></td><td><div className="cell-stack"><span className={`update-state update-${describeUpdate(d.update).tone}`}>{describeUpdate(d.update).label}</span><small className="cell-note">{d.update ? `Reported ${date(d.update.reportedAt)} UTC` : 'No update status from this device'}</small></div></td><td className="align-right"><button className={`button button-small ${d.access.desired === 'pending' ? 'button-tint' : 'button-outline'}`} aria-label={`${d.access.desired === 'pending' ? 'Review' : 'Manage'} ${d.code}`} onClick={() => setSelectedDevice(d.id)}>{d.access.desired === 'pending' ? 'Review' : 'Manage'}<ChevronRight size={14} /></button></td></tr>)}</tbody></table></div>{!rows.length && (snapshot.hotels.length === 0 && !isDemo
            ? <div className="empty"><Monitor size={26} /><strong>No hotels yet</strong><p>Add the first hotel to send its sign-in credentials, then enroll devices from this dashboard.</p><button className="button button-primary button-small" onClick={() => setHotelOpen(true)}>Add the first hotel</button></div>
            : <Empty>Try another hotel, device or search term.</Empty>)}<div className="table-footer"><span><i className="legend-dot" />{pending} awaiting approval</span><span><LockKeyhole size={13} />Blocking service does not switch off a phone.</span></div></section>
          <div className="bottom-grid"><section className="panel note-panel"><div className="note-icon"><ShieldCheck size={22} /></div><div><h3>Approve once. Keep control.</h3><p>New installations start pending. Approved devices can use the service; blocked devices can still send technical diagnostics.</p><button className="text-button" onClick={() => setSetupOpen(true)}>See how enforcement will work <ArrowRight size={14} /></button></div></section><section className="panel attention-panel"><div className="panel-heading compact"><h2>Needs attention</h2><button className="text-button" onClick={() => navigate('failures')}>All failures <ArrowRight size={14} /></button></div>{openIncidents.slice(0, 2).map((i) => <button className="attention-row" key={i.id} onClick={() => setSelectedIncident(i.id)}><span className={`incident-dot severity-${i.severity}`} /><span>{i.title}<small>{i.deviceIds.length} device{i.deviceIds.length === 1 ? '' : 's'} · {sentence(i.component)}</small></span><ChevronRight size={16} /></button>)}{!openIncidents.length && <p className="subtle">No open failures in this view.</p>}</section></div>
        </>}
        {tab === 'usage' && <>
          <section className="metrics-grid"><Metric label="Connected sessions" value={num(usage.connectedSessions)} note="Unique sessions, counted once" icon={Monitor} /><Metric label="Session minutes" value={num(usage.minutes)} note={`${usage.estimatedSessions} sessions use estimated duration`} icon={Clock3} /><Metric label="Failed attempts" value={num(usage.failedAttempts)} note={`${num(usage.attempts)} connection attempts total`} icon={AlertTriangle} /><Metric label="First audio · p95" value={usage.firstAudioP95Ms === null ? '—' : <>{num(usage.firstAudioP95Ms)}<span className="metric-unit">ms</span></>} note={`${num(usage.timingSamples)} timing samples`} icon={Zap} /></section>
          <div className="charts-grid"><section className="panel"><div className="panel-heading"><div><h2>Which feature gets used?</h2><p>Share of connected sessions in this view.</p></div><LayoutGrid size={18} className="subtle" /></div><div className="feature-bars">{usage.byFeature.map((f) => { const percent = usage.connectedSessions ? Math.round(f.sessions / usage.connectedSessions * 100) : 0; const Icon = f.feature === 'translation' ? Languages : Moon; return <div className="feature-bar" key={f.feature}><div><span className={`feature-icon ${f.feature}`}><Icon size={18} /></span><strong>{FEATURE_LABELS[f.feature]}</strong><span>{num(f.sessions)} <small>· {percent}%</small></span></div><div className="progress-track"><span className={`progress-fill ${f.feature}`} style={{ width: `${percent}%` }} /></div><p>{num(f.minutes)} session minutes</p></div>; })}</div><div className="card-footnote"><ShieldCheck size={14} />Feature, time, duration and result. Nothing said.</div></section><section className="panel"><div className="panel-heading"><div><h2>Sessions by day</h2><p>UTC reporting days · connected sessions</p></div></div><div className="chart-legend"><span><i className="translation" />Translation</span><span><i className="reception" />Night receptionist</span></div><Bars data={usage.byDay.map((d) => ({ day: d.day, primary: d.translation, secondary: d.reception }))} /><ChartData headers={['UTC day', 'Translation', 'Night receptionist']} rows={usage.byDay.map((d) => [d.day, d.translation, d.reception])} /></section></div>
          <section className="panel definition-panel"><div><div className="definition-icon"><CheckCheck size={22} /></div><h3>One connected session, one count.</h3><p>Retry attempts never inflate connected sessions. This view contains feature counters, not conversation content.</p></div><div className="definition-numbers"><span><strong>{num(usage.attempts)}</strong>Connection attempts</span><span><strong>{num(usage.retries)}</strong>Retry attempts</span><span><strong>{usage.attempts ? `${(usage.failedAttempts / usage.attempts * 100).toFixed(1)}%` : '—'}</strong>Attempt failure rate</span></div></section>
        </>}
        {tab === 'traffic' && <>
          <section className="metrics-grid"><Metric label="API requests" value={num(traffic.requests)} note="Technical device requests only" icon={Activity} /><Metric label="Request failure rate" value={traffic.requests ? <>{(traffic.failureRate * 100).toFixed(1)}<span className="metric-unit">%</span></> : '—'} note={`${num(traffic.failedRequests)} / ${num(traffic.requests)} requests`} icon={AlertTriangle} /><Metric label="Peak voice sessions" value={num(traffic.peakConcurrent)} note="Overlapping connected sessions" icon={Radio} /><Metric label="API response · p95" value={traffic.latencyP95Ms === null ? '—' : <>{num(traffic.latencyP95Ms)}<span className="metric-unit">ms</span></>} note={`${num(traffic.timingSamples)} timing samples`} icon={Zap} /></section>
          <section className="panel traffic-chart-panel"><div className="panel-heading"><div><h2>Request volume</h2><p>Operational API load across selected devices.</p></div><div className="chart-legend"><span><i className="traffic" />Requests</span><span><i className="failed" />Failed requests</span></div></div><TrafficChart data={traffic.byDay} /><ChartData headers={['UTC day', 'API requests', 'Failed requests']} rows={traffic.byDay.map((d) => [d.day, d.requests, d.failedRequests])} /></section>
          <div className="bottom-grid"><section className="panel traffic-details"><h2>Load breakdown</h2><div><span>Retry requests</span><strong>{num(traffic.retryRequests)}</strong></div><div><span>Telemetry ingress</span><strong>{(traffic.ingressBytes / 1_000_000).toFixed(2)} MB</strong></div><div><span>Connection attempts</span><strong>{num(usage.attempts)}</strong></div><p>Ingress covers technical metadata uploads only. Voice audio goes directly to the voice provider.</p></section><section className="panel note-panel traffic-note"><div className="note-icon"><CircleHelp size={22} /></div><div><h3>What “traffic” means here</h3><p>API requests, retries and concurrent voice sessions. No visitor analytics, network packet inspection, audio bandwidth or provider billing.</p><span className="mini-label">CONTENT-FREE BY DESIGN</span></div></section></div>
        </>}
        {tab === 'failures' && <>
          <section className="metrics-grid"><Metric label="Open failure groups" value={num(openIncidents.length)} note="Grouped by code, component, build" icon={AlertTriangle} tone="metric-highlight" /><Metric label="Devices affected" value={num(new Set(openIncidents.flatMap((i) => i.deviceIds).filter((id) => devices.some((d) => d.id === id))).size)} note="Unique affected devices in this filter" icon={Monitor} /><Metric label="Critical groups" value={num(openIncidents.filter((i) => i.severity === 'critical').length)} note="Prioritize for same-day response" icon={Zap} /><Metric label="Repair briefs ready" value={num(snapshot.repairRequests.filter((r) => incidents.some((i) => i.id === r.incidentId)).length)} note={isDemo ? 'Prepared locally · pipeline not connected' : 'Requested on the server'} icon={GitPullRequest} /></section>
          <section className="panel"><div className="panel-heading"><div><h2>Failure inbox <span className="count-pill">{incidents.length}</span></h2><p>Technical signals with an actionable next step.</p></div><Badge tone="amber"><Clock3 size={12} />Same-day response target</Badge></div><div className="table-scroll"><table className="data-table incident-table"><thead><tr><th>Failure / build</th><th>Severity</th><th>Devices in view</th><th>Next step</th><th>Status</th><th /></tr></thead><tbody>{incidents.map((i) => <tr key={i.id}><td><div className="cell-stack"><strong>{i.title}</strong><span className="mono">{i.code} · {i.build}</span></div></td><td><Badge tone={i.severity === 'critical' ? 'red' : i.severity === 'high' ? 'amber' : 'neutral'}>{sentence(i.severity)}</Badge></td><td><strong>{i.deviceIds.filter((id) => devices.some((d) => d.id === id)).length} of {i.deviceIds.length}</strong><small className="cell-note">{i.occurrences} group occurrences · all devices</small></td><td><span className="next-step-label">{i.fixClass === 'code_candidate' ? 'Prepare code handoff' : i.fixClass === 'external' ? 'Check provider' : i.fixClass === 'hotel_action' ? 'Device setup' : 'Check configuration'}</span><small className="cell-note">{sentence(i.component)}</small></td><td><Badge tone={i.status === 'repair_requested' ? 'green' : 'neutral'}>{i.status === 'repair_requested' ? 'Brief ready' : sentence(i.status)}</Badge></td><td><button className="icon-button" aria-label={`Inspect ${i.title}`} onClick={() => { setPacket(null); setSelectedIncident(i.id); }}><ChevronRight size={18} /></button></td></tr>)}</tbody></table></div>{!incidents.length && <Empty>No failure groups for these filters.</Empty>}<div className="table-footer"><span><LockKeyhole size={13} />Sanitized error codes only. No raw logs or conversation content.</span></div></section>
          <section className="panel repair-pipeline"><div className="panel-heading"><div><h2>From failure to verified fix</h2><p>The repair workflow. No automatic production changes.</p></div><Badge>REVIEWED PRS ONLY</Badge></div><div className="pipeline-steps">{[{ icon: AlertTriangle, name: 'Triage', sub: 'Code, setup or outage?' }, { icon: Code2, name: 'Reproduce', sub: 'Isolated test case' }, { icon: GitPullRequest, name: 'Draft PR', sub: 'Patch + passing tests' }, { icon: ShieldCheck, name: 'Review & canary', sub: 'Approve a staged release' }, { icon: CheckCheck, name: 'Verify recovery', sub: 'Confirm device health' }].map(({ icon: Icon, name, sub }, index) => <div key={name}><span className="pipeline-step-icon"><Icon size={19} /></span><small>0{index + 1}</small><strong>{name}</strong><p>{sub}</p></div>)}</div><div className="card-footnote"><CircleHelp size={14} />Same-day is a response target. Provider outages and hotel Wi-Fi need their own runbooks.</div></section>
        </>}
        <footer className="workspace-footer"><span><ShieldCheck size={14} />No guest audio, transcripts, prompts or guest identifiers.</span><span>{isDemo ? 'Demo data · UTC reporting days' : 'Live control API · UTC reporting days'}</span></footer>
      </main>
    </div>
    {notice && <div className="toast" role="status"><Check size={17} /><span>{notice}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => setNotice('')}><X size={15} /></button></div>}
    {selected && <DeviceDetail device={selected} read={read} source={source} demoSource={demoSource} onClose={() => setSelectedDevice(null)} onChanged={(next) => setRead(next)} onNotice={setNotice} />}
    {selectedFailure && <Modal title={selectedFailure.title} context={isDemo ? 'FAILURE DETAIL · DEMO' : 'FAILURE DETAIL'} onClose={() => { setSelectedIncident(null); setPacket(null); }}><div className="detail-title"><div className="detail-icon warning"><AlertTriangle size={26} /></div><Badge tone={selectedFailure.severity === 'critical' ? 'red' : 'amber'}>{sentence(selectedFailure.severity)} priority</Badge><h2>{selectedFailure.title}</h2><p className="mono">{selectedFailure.code}</p></div><div className="detail-facts"><div><span>Component / build</span><strong>{sentence(selectedFailure.component)} · {selectedFailure.build}</strong></div><div><span>Affected devices · group-wide</span><strong>{selectedFailure.deviceIds.length} devices · {selectedFailure.occurrences} occurrences</strong></div><div><span>First seen · group-wide</span><strong>{date(selectedFailure.firstSeenAt)} UTC</strong></div><div><span>Last seen</span><strong>{date(selectedFailure.lastSeenAt)} UTC</strong></div><div><span>Response target</span><strong>{date(selectedFailure.dueAt)} UTC</strong></div><div><span>Status</span><strong>{selectedFailure.status === 'repair_requested' ? 'Brief prepared' : sentence(selectedFailure.status)}</strong></div></div><div className="inset-card"><h3>Recommended next step</h3><p>{selectedFailure.nextStep}</p></div><div className="detail-section"><h3>Prepare a safe repair handoff</h3><p>{selectedFailure.component === 'android' ? 'This is an Android failure. The sanitized brief targets the app project; this workspace never pushes to it.' : selectedFailure.fixClass === 'code_candidate' ? 'Prepare a reproduction brief for the admin project. Code changes, tests and review come after the development pipeline is connected.' : 'This signal needs an operational runbook first. A device or provider problem is not automatically a code defect.'}</p><button className="button button-primary full-width" onClick={() => saveRepair(selectedFailure)}><GitPullRequest size={16} />Prepare sanitized brief</button>{packet != null && isDemo && <div className="brief-ready"><CheckCheck size={18} /><div><strong>Brief ready · local only</strong><p>Prepared locally in the demo. No pipeline was triggered.</p><button className="text-button" onClick={() => download(`manzanilla-${selectedFailure.id}-repair.json`, packet)}><ArrowDownToLine size={15} />Download repair JSON</button></div></div>}{!isDemo && selectedFailure.status === 'repair_requested' && <div className="brief-ready"><CheckCheck size={18} /><div><strong>Brief requested on the server</strong><p>The server owns the sanitized brief content. No pipeline runs without review.</p></div></div>}<button className="button button-outline full-width space-top" onClick={() => { void run(() => source.triageIncident(selectedFailure.id), isDemo ? 'Marked triaged in the local demo.' : 'Marked triaged.'); }} disabled={selectedFailure.status !== 'open'}><Check size={15} />{selectedFailure.status === 'open' ? 'Mark triaged' : 'Triage recorded'}</button></div><p className="detail-disclaimer"><LockKeyhole size={13} />Device reports are data, never instructions. A person approves releases.</p></Modal>}
    {setupOpen && (isDemo
      ? <Modal title="Connection setup" context="CONNECTION · DEMO" onClose={() => setSetupOpen(false)}><div className="detail-title"><div className="detail-icon"><SlidersHorizontal size={26} /></div><h2>A separate control center.</h2><p>The local foundation is ready to connect to your new accounts when you choose.</p></div><div className="setup-list">{[{ name: 'GitHub repository', sub: 'Source code and reviewed repair PRs', icon: GitPullRequest }, { name: 'Vercel project', sub: 'Admin website and short HTTP requests', icon: Globe2 }, { name: 'Supabase · EU region', sub: 'Named admin sign-in and operational database', icon: LockKeyhole }, { name: 'Company email & domains', sub: 'Alerts and your own admin address', icon: ArrowRight }, { name: 'Android integration', sub: 'Device enrollment, policy checks and content-free telemetry', icon: Monitor }].map(({ name, sub, icon: Icon }) => <div key={name}><span className="setup-list-icon"><Icon size={19} /></span><div><strong>{name}</strong><p>{sub}</p></div><Badge>Later</Badge></div>)}</div><div className="inset-card"><h3>No live connections in this demo</h3><p>Nothing here is deployed. There are no provider credentials, email sends or changes to the app repository.</p></div><p className="detail-disclaimer">Real blocking requires a managed APK and server-side session admission. Legacy apps with independent keys remain outside that control.</p></Modal>
      : <Modal title="Live connection" context="CONNECTION · LIVE" onClose={() => setSetupOpen(false)}><div className="detail-title"><div className="detail-icon"><Radio size={26} /></div><h2>Connected to the control API.</h2><p>Real data only. If the API fails, this dashboard says so — it never falls back to demo data.</p></div><div className="detail-facts"><div><span>API base</span><strong className="mono">/api/v1</strong></div><div><span>Data as of</span><strong>{date(asOf)} UTC</strong></div><div><span>Refresh interval</span><strong>Every {LIVE_POLL_MS / 1000} s · pauses when hidden</strong></div><div><span>Sign-in</span><strong>Enabled admin + MFA, checked per request</strong></div><div><span>State</span><strong>{stale ? 'Connection lost — retrying' : 'Live'}</strong></div></div><div className="inset-card"><h3>Separate states, always</h3><p>Service block, credential revocation, connectivity, policy confirmation and provider termination are tracked separately. Blocking service never powers off a phone.</p></div></Modal>)}
    {resetConfirm && demoSource && <Modal title="Reset local demo" context="RESET · DEMO" onClose={() => setResetConfirm(false)}><div className="detail-title"><div className="detail-icon"><RefreshCw size={26} /></div><h2>Start fresh?</h2><p>Reset simulated approvals, acknowledgements and repair briefs in this browser. This affects no real devices.</p></div><button className="button button-primary full-width" onClick={() => { setRead(demoSource.reset()); setFilters(DEFAULT_FILTERS); setQuery(''); setResetConfirm(false); setNotice('Local demo reset with a new snapshot.'); }}>Reset demo</button><button className="button button-outline full-width space-top" onClick={() => setResetConfirm(false)}>Keep current demo</button></Modal>}
    {hotelOpen && !isDemo && <AddHotelModal hotels={snapshot.hotels.map((h) => h.name)} onClose={() => setHotelOpen(false)} onCreate={async (input: CreateHotelInput): Promise<CreateHotelResult | null> => {
      if (!source.createHotel) { setNotice('Hotel provisioning is not connected yet.'); return null; }
      try {
        const result = await source.createHotel(input);
        setRead(result.read); setStale(false);
        if (result.status === 'needs_attention' && result.nextStep === 'use_recovery') return result;
        setHotelOpen(false);
        setNotice(result.duplicate
          ? 'That hotel already exists. No duplicate was created.'
          : 'Hotel created. Provisioning is in progress — the durable job state is tracked server-side.');
        return null;
      } catch (error) {
        if (error instanceof DashboardError && (error.kind === 'unauthorized' || error.kind === 'forbidden')) { setFailure(error); setStatus('unauthorized'); return null; }
        setNotice(error instanceof Error ? error.message : 'The action failed.');
        return null;
      }
    }} onRecover={async (hotelId: string, mode: RecoveryMode): Promise<boolean> => {
      if (!source.sendRecovery) { setNotice('Recovery is not connected yet.'); return false; }
      const ok = await run(() => source.sendRecovery!(hotelId, mode), mode === 'guide'
        ? 'Sign-in guide queued for delivery to the hotel.'
        : 'Password reset link queued for delivery to the hotel.');
      return ok;
    }} />}
    {tokenOpen && !isDemo && <SetupTokenModal hotels={snapshot.hotels} onClose={() => setTokenOpen(false)} onMint={async (hotelId) => {
      if (!source.mintSetupToken) throw new Error('Device setup is not connected yet.');
      return source.mintSetupToken(hotelId);
    }} />}
  </div>;
}

function AddHotelModal({ hotels, onClose, onCreate, onRecover }: { hotels: string[]; onClose: () => void; onCreate: (input: CreateHotelInput) => Promise<CreateHotelResult | null>; onRecover: (hotelId: string, mode: RecoveryMode) => Promise<boolean> }) {
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [email, setEmail] = useState('');
  const [confirmEmail, setConfirmEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState<CreateHotelResult | null>(null);
  const [recoverySent, setRecoverySent] = useState('');
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const valid = name.trim().length >= 1 && name.length <= 120 && city.trim().length >= 1 && city.length <= 120 && emailValid && confirmEmail.trim() === email.trim();
  const submit = async () => {
    if (!valid || busy) return;
    if (hotels.some((h) => h.toLowerCase() === name.trim().toLowerCase())) { setError('A hotel with this name already exists.'); return; }
    setBusy(true); setError('');
    const result = await onCreate({ hotelName: name.trim(), city: city.trim(), email: email.trim(), confirmEmail: confirmEmail.trim() }).catch((e) => { setError(e instanceof Error ? e.message : 'Could not create the hotel.'); return null; });
    setBusy(false);
    if (result) setRecovery(result);
  };
  const recover = async (mode: RecoveryMode) => {
    if (!recovery || busy) return;
    setBusy(true); setError('');
    const ok = await onRecover(recovery.hotelId, mode);
    setBusy(false);
    if (ok) setRecoverySent(mode);
  };
  if (recovery) {
    return <Modal title="Provisioning needs attention" context="PROVISIONING · LIVE" onClose={onClose}><div className="detail-title"><div className="detail-icon warning"><AlertTriangle size={26} /></div><h2>{name} needs a recovery email.</h2><p>The hotel record was created, but the sign-in email could not be delivered and the generated password cannot be sent again. Choose exactly one recovery email:</p></div>
      {recoverySent ? <div className="brief-ready"><CheckCheck size={18} /><div><strong>{recoverySent === 'guide' ? 'Sign-in guide queued' : 'Password reset link queued'}</strong><p>The durable job state is tracked server-side.</p></div></div> : <div className="form-stack">
        <button className="button button-primary full-width" disabled={busy} onClick={() => void recover('guide')}>Email a sign-in guide (no password)</button>
        <button className="button button-outline full-width" disabled={busy} onClick={() => void recover('reset_link')}>Email a password reset link</button>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>}
      <p className="detail-disclaimer"><LockKeyhole size={13} />Each button sends only what it says — the guide carries no password, the reset link sets a new one.</p></Modal>;
  }
  return <Modal title="Add hotel" context="PROVISIONING · LIVE" onClose={onClose}><div className="detail-title"><div className="detail-icon"><Globe2 size={26} /></div><h2>Create a hotel account.</h2><p>The email pipeline sends the hotel its sign-in email and generated password. Device setup credentials are never emailed — they are minted here and shown once.</p></div>
    <div className="form-stack">
      <label className="field-label" htmlFor="hotel-name">Hotel name</label>
      <input id="hotel-name" className="text-field" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="Hotel Mar" />
      <label className="field-label" htmlFor="hotel-city">City</label>
      <input id="hotel-city" className="text-field" maxLength={120} value={city} onChange={(e) => setCity(e.target.value)} placeholder="Barcelona, ES" />
      <label className="field-label" htmlFor="hotel-email">Main hotel email</label>
      <input id="hotel-email" className="text-field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="reception@hotel.example" />
      <label className="field-label" htmlFor="hotel-email-confirm">Confirm email</label>
      <input id="hotel-email-confirm" className="text-field" type="email" value={confirmEmail} onChange={(e) => setConfirmEmail(e.target.value)} placeholder="reception@hotel.example" />
      {confirmEmail && confirmEmail.trim() !== email.trim() && <p className="form-error" role="alert">The email addresses do not match.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
    <button className="button button-primary full-width" disabled={!valid || busy} onClick={() => void submit()}>{busy ? 'Creating…' : 'Create hotel & send login'}</button>
    <p className="detail-disclaimer"><LockKeyhole size={13} />The password is usable immediately. No forced first-use reset and no confirmation-link gate.</p></Modal>;
}

function SetupTokenModal({ hotels, onClose, onMint }: { hotels: { id: string; name: string }[]; onClose: () => void; onMint: (hotelId: string) => Promise<{ setupToken: string; expiresAt: string }> }) {
  const [hotelId, setHotelId] = useState(hotels[0]?.id ?? '');
  const [token, setToken] = useState<{ setupToken: string; expiresAt: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const mint = async () => {
    if (!hotelId || busy) return;
    setBusy(true); setError(''); setCopied(false);
    try { setToken(await onMint(hotelId)); } catch (e) { setError(e instanceof Error ? e.message : 'Could not create a setup credential.'); } finally { setBusy(false); }
  };
  const copy = async () => {
    if (!token) return;
    try { await navigator.clipboard.writeText(token.setupToken); setCopied(true); } catch { setError('Copy failed. Select and copy the credential manually.'); }
  };
  return <Modal title="Device setup" context="ENROLLMENT · LIVE" onClose={onClose}><div className="detail-title"><div className="detail-icon"><KeyRound size={26} /></div><h2>Assisted device setup.</h2><p>Tablets normally enroll with the hotel's own sign-in. Use a one-use setup credential only for assisted installs. It starts the installation as pending — you still approve access here.</p></div>
    {!token ? <div className="form-stack">
      <label className="field-label" htmlFor="setup-hotel">Hotel</label>
      <select id="setup-hotel" className="text-field" value={hotelId} onChange={(e) => setHotelId(e.target.value)}>{hotels.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button button-primary full-width" disabled={!hotelId || busy} onClick={() => void mint()}>{busy ? 'Creating…' : 'Create one-use setup credential'}</button>
    </div> : <div className="form-stack">
      <div className="inset-card warning-card"><h3>Shown once. Never stored here.</h3><p>Copy it now and enter it on the tablet. It expires {date(token.expiresAt)} UTC and works exactly once.</p></div>
      <code className="token-box">{token.setupToken}</code>
      <button className="button button-primary full-width" onClick={() => void copy()}><Copy size={15} />{copied ? 'Copied' : 'Copy setup credential'}</button>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>}
    <p className="detail-disclaimer"><LockKeyhole size={13} />Only the credential hash is stored server-side. It never appears in email.</p></Modal>;
}

function DeviceDetail({ device: d, read, source, demoSource, onClose, onChanged, onNotice }: { device: Device; read: DashboardRead; source: DashboardDataSource; demoSource: DemoSource | null; onClose: () => void; onChanged: (r: DashboardRead) => void; onNotice: (message: string) => void }) {
  const [action, setAction] = useState<Access | null>(null);
  const [reason, setReason] = useState('Approved by the Manzanilla team');
  const isDemo = source.mode === 'demo';
  const snapshot = read.snapshot;
  const asOf = read.asOf;
  const online = getConnection(d, asOf) === 'online';
  const waiting = d.access.revision !== d.access.ackRevision;
  const canManage = d.managed && d.credential === 'valid';
  const change = async () => {
    if (!action) return;
    try {
      const next = await source.requestPolicy({ deviceId: d.id, desired: action, reason, expectedRevision: d.access.revision });
      onChanged(next);
      setAction(null);
      onNotice(isDemo ? 'Demo policy saved. Device confirmation is a separate step.' : next.recordedRetry
        ? 'This exact policy request was already recorded earlier. Showing the current state.'
        : 'Policy request recorded. The device confirms receipt separately.');
    } catch (e) {
      if (e instanceof DashboardError && (e.kind === 'conflict' || e.kind === 'invalid-state' || e.kind === 'not-found')) onNotice('Policy state changed on the server. Reopen the device and try again.');
      else onNotice(e instanceof Error ? e.message : 'Policy update failed.');
    }
  };
  const ack = () => {
    if (!demoSource) return;
    try { onChanged(demoSource.simulateDeviceAck(d.id)); onNotice('Simulated device receipt recorded. No real device was contacted.'); } catch (e) { onNotice(e instanceof Error ? e.message : 'Acknowledgement failed.'); }
  };
  return <Modal title={`${d.label} ${d.code}`} context={isDemo ? 'DEVICE OPERATIONS · DEMO' : 'DEVICE OPERATIONS'} onClose={onClose}><div className="detail-title"><div className="detail-icon"><Monitor size={27} /></div><span className="device-code">{d.code}</span><h2>{d.label}</h2><p>{snapshot.hotels.find((h) => h.id === d.hotelId)?.name}</p></div><div className="detail-statuses"><div><span>Desired policy</span><AccessBadge access={d.access.desired} /></div><div><span>Connection</span><ConnectionBadge device={d} asOf={asOf} /></div></div>{!canManage ? <div className="inset-card warning-card"><h3>{!d.managed ? 'Legacy device · integration needed' : 'Device credential revoked'}</h3><p>{!d.managed ? 'This installation is not integrated with the control API. The portal cannot enforce a block on an APK using independent provider credentials.' : 'Service approval cannot restore a revoked credential. Re-enroll this installation using the setup flow.'}</p></div> : <div className="detail-section"><h3>Service access</h3><p>Control Translation and Night receptionist together. Diagnostics remain available when service is blocked.</p>{action ? <div className="confirm-policy"><h4>{action === 'approved' ? 'Approve this installation?' : 'Block service on this device?'}</h4><label className="field-label" htmlFor="policy-reason">Reason for audit history</label><input id="policy-reason" className="text-field" maxLength={160} minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} /><div className="button-row"><button className={`button ${action === 'blocked' ? 'button-danger' : 'button-primary'}`} disabled={reason.trim().length < 3} onClick={() => void change()}>Confirm {action === 'approved' ? 'approval' : 'block'}</button><button className="button button-outline" onClick={() => setAction(null)}>Cancel</button></div><p className="microcopy">{action === 'blocked' ? 'The server denies new session admissions. Stopping existing calls requires separate provider and device confirmation.' : 'The server admits calls after approval and the device confirms receipt.'}</p></div> : <div className="button-row">{d.access.desired !== 'approved' && <button className="button button-primary" onClick={() => { setAction('approved'); setReason('Approved by the Manzanilla team'); }}><ShieldCheck size={16} />Approve access</button>}{d.access.desired !== 'blocked' && <button className="button button-outline danger-text" onClick={() => { setAction('blocked'); setReason('Service blocked for operational review'); }}><ShieldOff size={16} />Block service</button>}</div>}</div>}
    <div className={`receipt-card ${waiting ? 'receipt-pending' : ''}`}><div className="receipt-title">{waiting ? <Clock3 size={18} /> : <CheckCheck size={18} />}<strong>{waiting ? 'Device confirmation pending' : 'Device policy confirmed'}</strong></div><div className="receipt-grid"><span>Desired revision<strong>v{d.access.revision}</strong></span><span>Device acknowledged<strong>v{d.access.ackRevision}</strong></span><span>Last confirmed access<strong>{sentence(d.access.effective)}</strong></span></div>{waiting && <><p>{online ? 'The device has not confirmed this revision yet.' : 'This device is not online. Its last confirmed access may differ from the requested policy.'}</p>{isDemo && canManage && <button className="button button-outline full-width" disabled={!online} onClick={ack}><CheckCheck size={15} />Simulate device receipt</button>}{isDemo && !online && <small>Receipt simulation requires an online device.</small>}{!isDemo && <small>Confirmation is reported by the installation itself; it cannot be simulated here.</small>}</>}</div>
    <div className="detail-facts"><div><span>App build</span><strong>{d.build}</strong></div><div><span>Last seen</span><strong>{d.lastSeenAt ? `${date(d.lastSeenAt)} UTC` : 'Never seen'}</strong></div><div><span>Credential</span><strong>{sentence(d.credential)}</strong></div><div><span>Microphone permission</span><strong>{sentence(d.microphone)}</strong></div><div><span>Feature at snapshot</span><strong>{d.mode === 'idle' ? 'Idle' : FEATURE_LABELS[d.mode]}</strong></div></div>
    <div className="detail-section"><h3>Recent policy activity</h3><div className="event-list">{snapshot.policyHistory.filter((h) => h.deviceId === d.id).slice(0, 4).map((h) => <div key={h.id}><i /><div><strong>{sentence(h.desired)} requested · v{h.revision}</strong><p>{h.reason}</p><small>{date(h.at)} UTC</small></div></div>)}{!snapshot.policyHistory.some((h) => h.deviceId === d.id) && <p className="subtle">No policy changes recorded.</p>}</div></div><p className="detail-disclaimer"><LockKeyhole size={13} />A device receipt confirms app policy only. Provider termination is unconfirmed; its adapter is not connected. This does not power off a phone, erase data or revoke enrollment.</p>
  </Modal>;
}

function Bars({ data }: { data: { day: string; primary: number; secondary: number }[] }) {
  const max = Math.max(1, ...data.map((d) => Math.max(d.primary, d.secondary)));
  return <div className={`bar-chart ${data.length > 10 ? 'bar-chart-dense' : ''}`} role="img" aria-label="Daily connected sessions. Exact values in the data table below."><div className="chart-gridlines"><span /><span /><span /><span /></div><div className="bar-columns">{data.map((d) => <div className="bar-column" key={d.day}><div className="bar-pair"><span className="bar translation" style={{ height: `${d.primary / max * 100}%` }} title={`${d.day}: Translation ${d.primary}`} /><span className="bar reception" style={{ height: `${d.secondary / max * 100}%` }} title={`${d.day}: Night receptionist ${d.secondary}`} /></div><span className="bar-label">{data.length > 10 ? new Date(d.day).getUTCDate() : day(d.day)}</span></div>)}</div></div>;
}
function TrafficChart({ data }: { data: { day: string; requests: number; failedRequests: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.requests));
  const width = 1000, height = 178;
  const coords = data.map((d, i) => `${data.length < 2 ? width / 2 : i / (data.length - 1) * width},${height - d.requests / max * 142}`);
  return <div className="traffic-chart" role="img" aria-label="API requests by day. Exact values in the data table below."><div className="traffic-axis"><span>{num(max)}</span><span>{num(max / 2)}</span><span>0</span></div><div className="traffic-plot"><div className="chart-gridlines"><span /><span /><span /></div><svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="traffic-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#d56b3b" stopOpacity=".19" /><stop offset="100%" stopColor="#d56b3b" stopOpacity=".02" /></linearGradient></defs><polygon points={`0,${height} ${coords.join(' ')} ${width},${height}`} fill="url(#traffic-fill)" /><polyline points={coords.join(' ')} stroke="#c45b30" fill="none" strokeWidth="3" vectorEffect="non-scaling-stroke" />{data.map((d, i) => <rect key={d.day} x={(data.length < 2 ? width / 2 : i / (data.length - 1) * width) - 3} y={height - Math.max(1, d.failedRequests / max * 142)} width="6" height={Math.max(1, d.failedRequests / max * 142)} fill="#8ea77a" />)}</svg><div className="traffic-x-axis">{data.map((d, i) => <span key={d.day}>{data.length > 10 ? (i % 5 === 0 ? new Date(d.day).getUTCDate() : '') : day(d.day)}</span>)}</div></div></div>;
}
function ChartData({ headers, rows }: { headers: string[]; rows: (string | number)[][] }) { return <details className="chart-data"><summary>View exact data <ChevronRight size={12} /></summary><div className="table-scroll"><table><thead><tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{v}</td>)}</tr>)}</tbody></table></div></details>; }
