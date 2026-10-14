export function validateSchedule(input) {
  if (!input || typeof input.enabled !== 'boolean')
    throw new Error('Schedule enabled must be a boolean.');
  if (typeof input.timeZone !== 'string') throw new Error('Choose an IANA timezone.');
  try {
    new Intl.DateTimeFormat('en', { timeZone: input.timeZone }).format();
  } catch {
    throw new Error('Use an IANA timezone such as America/New_York or UTC.');
  }
  if (!Array.isArray(input.windows) || input.windows.length > 21)
    throw new Error('Use at most 21 work windows.');
  const windows = input.windows.map((w) => {
    if (
      !w ||
      !Array.isArray(w.days) ||
      !w.days.length ||
      w.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
    )
      throw new Error('Select work days (Sunday = 0 through Saturday = 6).');
    if (
      ![w.start, w.end].every(
        (t) => typeof t === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t),
      ) ||
      w.start === w.end
    )
      throw new Error('Each window needs different start and end times in HH:MM format.');
    return { days: [...new Set(w.days)].sort(), start: w.start, end: w.end };
  });
  if (input.enabled && !windows.length)
    throw new Error('Add at least one work window before enabling.');
  return { enabled: input.enabled, timeZone: input.timeZone, windows };
}
export const defaultSchedule = {
  enabled: false,
  timeZone: 'UTC',
  windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }],
};
export function isWorkingTime(schedule, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: schedule.timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const minutes = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  return schedule.windows.some((w) => {
    const start = minutes(w.start),
      end = minutes(w.end);
    return start < end
      ? w.days.includes(day) && minute >= start && minute < end
      : (w.days.includes(day) && minute >= start) ||
          (w.days.includes((day + 6) % 7) && minute < end);
  });
}
export class Codespaces {
  constructor(
    db,
    {
      token = process.env.CODESPACES_TOKEN,
      name = process.env.CODESPACE_NAME,
      fetcher = fetch,
    } = {},
  ) {
    this.db = db;
    this.token = token;
    this.name = name;
    this.fetcher = fetcher;
  }
  async api(suffix = '', method = 'GET', body) {
    if (!this.token || !/^[a-zA-Z0-9-]+$/.test(this.name || ''))
      throw new Error('Set CODESPACES_TOKEN and CODESPACE_NAME in the server environment.');
    let r;
    try {
      r = await this.fetcher(
        `https://api.github.com/user/codespaces/${encodeURIComponent(this.name)}${suffix}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(20000),
        },
      );
    } catch {
      throw new Error('GitHub request timed out or failed. Refresh before retrying a change.');
    }
    if (!r.ok)
      throw new Error(
        `GitHub Codespaces request failed (${r.status}). Check permissions, quota, and machine availability. No automatic retry was made.`,
      );
    return r.status === 204 || r.status === 202 ? {} : r.json();
  }
  async schedule() {
    const doc = this.db ? await this.db.get('codespace-schedule') : { revision: 0, value: null };
    return {
      schedule: doc.value?.schedule || defaultSchedule,
      revision: doc.revision,
      target: doc.value?.target || this.name || null,
      persistent: !!this.db,
    };
  }
  async saveSchedule(p) {
    if (!this.db) throw new Error('Configure Turso before saving an external wake/sleep schedule.');
    if (!this.token || !this.name)
      throw new Error('Configure Codespaces credentials before enabling scheduling.');
    const schedule = validateSchedule(p.schedule);
    // Verify ownership/access before persisting an externally actionable target.
    await this.api();
    await this.db.put('codespace-schedule', { schedule, target: this.name }, p.revision);
    return {
      saved: true,
      notice:
        'Schedule saved in Turso. Enable the scheduler workflow on the default branch with matching Actions secrets. Runs are best-effort, approximately every 15 minutes.',
    };
  }
  async status() {
    const config = await this.schedule();
    config.lastCheck = this.db ? (await this.db.get('scheduler-status')).value : null;
    if (!this.token || !this.name)
      return {
        ...config,
        configured: false,
        notice:
          'Add CODESPACES_TOKEN to Codespaces secrets. Scheduling also requires matching Actions secrets.',
      };
    const [space, options] = await Promise.all([this.api(), this.api('/machines')]);
    return {
      ...config,
      configured: true,
      name: space.name,
      state: space.state,
      machine: space.machine
        ? {
            name: space.machine.name,
            cpus: space.machine.cpus,
            memory: space.machine.memory_in_bytes,
          }
        : null,
      machines: (options.machines || [])
        .filter((m) => [2, 4].includes(m.cpus))
        .map((m) => ({ name: m.name, cpus: m.cpus, displayName: m.display_name })),
    };
  }
  async resize(machine) {
    const { machines = [] } = await this.api('/machines');
    if (!machines.some((m) => m.name === machine && [2, 4].includes(m.cpus)))
      throw new Error('Select an available 2-core or 4-core machine from the live list.');
    await this.api('', 'PATCH', { machine });
    return {
      saved: true,
      notice:
        'Machine change accepted by GitHub. It takes effect the next time this Codespace starts. Save work, then stop and start it from GitHub. Four cores consume core-hours twice as fast as two.',
    };
  }
  async tick(now = new Date()) {
    if (!this.db) throw new Error('The scheduler requires Turso.');
    const doc = await this.db.get('codespace-schedule');
    if (!doc.value) return { action: 'none', reason: 'No schedule saved' };
    const schedule = validateSchedule(doc.value.schedule);
    if (!schedule.enabled) return { action: 'none', reason: 'Schedule disabled' };
    // Bind Actions to the explicitly configured target, not arbitrary names from storage.
    if (doc.value.target !== this.name)
      throw new Error('Scheduled target does not match CODESPACE_NAME.');
    const active = isWorkingTime(schedule, now);
    const space = await this.api();
    const action =
      active && space.state === 'Shutdown'
        ? 'start'
        : !active && space.state === 'Available'
          ? 'stop'
          : null;
    if (action) {
      // Do not act on a schedule edited while GitHub was being queried.
      if ((await this.db.get('codespace-schedule')).revision !== doc.revision)
        return { action: 'none', reason: 'Schedule changed; wait for next run' };
      await this.api(`/${action}`, 'POST');
    }
    const result = {
      action: action || 'none',
      state: space.state,
      workingTime: active,
      checkedAt: now.toISOString(),
    };
    const previous = await this.db.get('scheduler-status');
    await this.db.put('scheduler-status', result, previous.revision);
    return result;
  }
}
