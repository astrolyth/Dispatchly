import { useState } from 'react';
import { useFetcher, useLoaderData } from 'react-router-dom';
import { PageHeader } from '../components/layout/Layout';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PRIORITIES = ['P1', 'P2', 'P3', 'P4'];
const CATEGORIES = ['Network', 'Clinical Application', 'Hardware', 'Software', 'Account Access'];
const TYPES = ['SLA', 'OLA', 'UC'];

const TYPE_COLORS = {
  SLA: 'bg-blue-100 text-blue-700',
  OLA: 'bg-purple-100 text-purple-700',
  UC: 'bg-orange-100 text-orange-700',
};

function formatMinutes(m) {
  if (m < 60) return `${m}m`;
  if (m % 60 === 0) return `${m / 60}h`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ─── Loader ──────────────────────────────────────────────────────────────────

export async function slaSettingsLoader() {
  const [hoursRes, defsRes] = await Promise.all([
    fetch('/api/dashboard/business-hours', { credentials: 'include' }),
    fetch('/api/dashboard/sla-definitions', { credentials: 'include' }),
  ]);
  if (!hoursRes.ok || !defsRes.ok) throw new Response('Failed to load SLA settings', { status: 500 });
  const [{ config }, { definitions }] = await Promise.all([hoursRes.json(), defsRes.json()]);
  return { config, definitions };
}

// ─── Action ──────────────────────────────────────────────────────────────────

async function send(url, method, body, intent) {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, intent } : { error: result.error || 'Request failed', intent };
}

export async function slaSettingsAction({ request }) {
  const fd = await request.formData();
  const intent = fd.get('_intent');

  if (intent === 'hours') {
    return send(
      '/api/dashboard/business-hours',
      'PATCH',
      {
        start_hour: Number(fd.get('start_hour')),
        end_hour: Number(fd.get('end_hour')),
        work_days: fd.getAll('work_days').map(Number),
        timezone: fd.get('timezone'),
      },
      intent
    );
  }

  if (intent === 'create' || intent === 'update') {
    const priorities = fd.getAll('priority_filter');
    const categories = fd.getAll('category_filter');
    const body = {
      name: fd.get('name'),
      type: fd.get('type'),
      description: fd.get('description') || null,
      target_minutes: Number(fd.get('target_minutes')),
      // Empty filter = applies to every ticket
      priority_filter: priorities.length ? priorities : null,
      category_filter: categories.length ? categories : null,
      applies_business_hours: fd.get('applies_business_hours') === 'on',
    };
    return intent === 'create'
      ? send('/api/dashboard/sla-definitions', 'POST', body, intent)
      : send(`/api/dashboard/sla-definitions/${fd.get('id')}`, 'PATCH', body, intent);
  }

  if (intent === 'toggle') {
    return send(
      `/api/dashboard/sla-definitions/${fd.get('id')}`,
      'PATCH',
      { is_active: fd.get('is_active') === 'true' },
      intent
    );
  }

  return { error: 'Unknown action' };
}

// ─── Business hours card ─────────────────────────────────────────────────────

function BusinessHoursCard({ config }) {
  const fetcher = useFetcher();
  const busy = fetcher.state !== 'idle';
  const c = config ?? { start_hour: 9, end_hour: 17, work_days: [1, 2, 3, 4, 5], timezone: 'UTC' };

  return (
    <div className="card p-6">
      <h2 className="text-base font-semibold text-gray-900">Business Hours</h2>
      <p className="text-sm text-gray-500 mt-0.5 mb-4">
        Timers on definitions marked “business hours” only count time inside this window.
      </p>

      <fetcher.Form method="post" className="space-y-4">
        <input type="hidden" name="_intent" value="hours" />

        {fetcher.data?.intent === 'hours' && fetcher.data.error && (
          <p className="text-sm text-red-600 bg-red-50 rounded px-3 py-2">{fetcher.data.error}</p>
        )}
        {fetcher.data?.intent === 'hours' && fetcher.data.ok && !busy && (
          <p className="text-sm text-emerald-700 bg-emerald-50 rounded px-3 py-2">Saved.</p>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="label" htmlFor="start_hour">Start hour</label>
            <input id="start_hour" className="input" name="start_hour" type="number" min={0} max={23} required defaultValue={c.start_hour} />
          </div>
          <div>
            <label className="label" htmlFor="end_hour">End hour</label>
            <input id="end_hour" className="input" name="end_hour" type="number" min={1} max={24} required defaultValue={c.end_hour} />
          </div>
          <div>
            <label className="label" htmlFor="timezone">Time zone</label>
            <input id="timezone" className="input" name="timezone" required defaultValue={c.timezone} placeholder="America/Chicago" />
          </div>
        </div>

        <fieldset>
          <legend className="label">Working days</legend>
          <div className="flex flex-wrap gap-2">
            {DAYS.map((d, i) => (
              <label key={d} className="inline-flex items-center gap-1.5 text-sm text-gray-700 border border-gray-200 rounded-lg px-3 py-1.5 cursor-pointer has-[:checked]:bg-blue-50 has-[:checked]:border-blue-300">
                <input type="checkbox" name="work_days" value={i} defaultChecked={c.work_days.includes(i)} />
                {d}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex justify-end">
          <button type="submit" disabled={busy} className="btn btn-primary">
            {busy ? 'Saving…' : 'Save Business Hours'}
          </button>
        </div>
      </fetcher.Form>
    </div>
  );
}

// ─── Create / edit modal ─────────────────────────────────────────────────────

function DefinitionModal({ def, onClose }) {
  const fetcher = useFetcher();
  const busy = fetcher.state !== 'idle';
  const intent = def ? 'update' : 'create';

  if (fetcher.data?.ok && fetcher.data.intent === intent) setTimeout(onClose, 0);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="card w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
        <h2 className="text-base font-semibold text-gray-900 mb-4">
          {def ? 'Edit Definition' : 'New SLA Definition'}
        </h2>
        <fetcher.Form method="post" className="space-y-4">
          <input type="hidden" name="_intent" value={intent} />
          {def && <input type="hidden" name="id" value={def.id} />}

          {fetcher.data?.error && (
            <p className="text-sm text-red-600 bg-red-50 rounded px-3 py-2">{fetcher.data.error}</p>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="label" htmlFor="def_name">Name</label>
              <input id="def_name" className="input" name="name" required defaultValue={def?.name} placeholder="P2 High Response SLA" />
            </div>
            <div>
              <label className="label" htmlFor="def_type">Type</label>
              <select id="def_type" className="input" name="type" defaultValue={def?.type ?? 'SLA'}>
                {TYPES.map((t) => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="def_target">Target (minutes)</label>
              <input id="def_target" className="input" name="target_minutes" type="number" min={1} required defaultValue={def?.target_minutes} />
            </div>
            <div className="col-span-2">
              <label className="label" htmlFor="def_desc">Description</label>
              <input id="def_desc" className="input" name="description" defaultValue={def?.description ?? ''} />
            </div>
          </div>

          <fieldset>
            <legend className="label">Priorities <span className="font-normal text-gray-400">(none = all)</span></legend>
            <div className="flex flex-wrap gap-3">
              {PRIORITIES.map((p) => (
                <label key={p} className="inline-flex items-center gap-1.5 text-sm text-gray-700">
                  <input type="checkbox" name="priority_filter" value={p} defaultChecked={def?.priority_filter?.includes(p)} />
                  {p}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="label">Categories <span className="font-normal text-gray-400">(none = all)</span></legend>
            <div className="flex flex-wrap gap-3">
              {CATEGORIES.map((c) => (
                <label key={c} className="inline-flex items-center gap-1.5 text-sm text-gray-700">
                  <input type="checkbox" name="category_filter" value={c} defaultChecked={def?.category_filter?.includes(c)} />
                  {c}
                </label>
              ))}
            </div>
          </fieldset>

          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" name="applies_business_hours" defaultChecked={def?.applies_business_hours} />
            Count business hours only (otherwise 24/7)
          </label>

          <div className="flex justify-end gap-3">
            <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
            <button type="submit" disabled={busy} className="btn btn-primary">
              {busy ? 'Saving…' : def ? 'Save Changes' : 'Create'}
            </button>
          </div>
        </fetcher.Form>
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

const TH = 'text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider';

export default function SlaSettingsPage() {
  const { config, definitions } = useLoaderData();
  const toggler = useFetcher();
  const [editing, setEditing] = useState(null); // null = closed, {} = new, def = edit

  return (
    <div>
      <PageHeader
        title="SLA Settings"
        subtitle="Business hours and SLA / OLA / UC definitions"
        actions={
          <button type="button" onClick={() => setEditing({})} className="btn btn-primary">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Definition
          </button>
        }
      />

      <div className="p-8 space-y-6">
        <BusinessHoursCard config={config} />

        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className={TH}>Name</th>
                <th className={TH}>Type</th>
                <th className={TH}>Target</th>
                <th className={TH}>Applies to</th>
                <th className={TH}>Clock</th>
                <th className={TH}>Met / Breached / Active</th>
                <th className={TH}>Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {definitions.map((d) => (
                <tr key={d.id} className={`hover:bg-gray-50 ${!d.is_active ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-900">{d.name}</p>
                    {d.description && <p className="text-xs text-gray-500">{d.description}</p>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${TYPE_COLORS[d.type]}`}>
                      {d.type}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-700">{formatMinutes(d.target_minutes)}</td>
                  <td className="px-4 py-3 text-gray-500">
                    {[d.priority_filter?.join(', '), d.category_filter?.join(', ')].filter(Boolean).join(' · ') || 'All tickets'}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{d.applies_business_hours ? 'Business hrs' : '24/7'}</td>
                  <td className="px-4 py-3 text-gray-500">
                    {d.met_count} / <span className={Number(d.breached_count) ? 'text-red-600 font-medium' : ''}>{d.breached_count}</span> / {d.active_count}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${d.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600'}`}>
                      {d.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button type="button" onClick={() => setEditing(d)} className="btn btn-ghost text-xs px-3 py-1">Edit</button>
                    <toggler.Form method="post" className="inline">
                      <input type="hidden" name="_intent" value="toggle" />
                      <input type="hidden" name="id" value={d.id} />
                      <input type="hidden" name="is_active" value={String(!d.is_active)} />
                      <button type="submit" disabled={toggler.state !== 'idle'} className="btn btn-ghost text-xs px-3 py-1">
                        {d.is_active ? 'Deactivate' : 'Activate'}
                      </button>
                    </toggler.Form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <DefinitionModal
          key={editing.id ?? 'new'}
          def={editing.id ? editing : null}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
