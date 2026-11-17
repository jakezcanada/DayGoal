/* DayGoal renderer — plain JS, no build step. */
(() => {
  'use strict';

  const cfg = window.DAYGOAL_CONFIG || {};
  const desk = window.desk || null; // Electron bridge (absent if ever run in a plain browser)
  const $app = document.getElementById('app');
  const $modal = document.getElementById('modal-root');

  // ---------- Helpers ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const ymd = (d = new Date()) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
  const prettyDay = (s, opts = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) =>
    parseYmd(s).toLocaleDateString(undefined, opts);
  const toMin = (hm) => { const [a, b] = (hm || '00:00').split(':').map(Number); return a * 60 + b; };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2200);
  }
  function fail(err) {
    console.error(err);
    toast(err?.message || String(err));
  }
  async function q(promise) {
    const { data, error } = await promise;
    if (error) throw error;
    return data;
  }

  // ---------- Config guard ----------
  if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes('YOUR-PROJECT') || !window.supabase) {
    $app.append(h('div', { class: 'auth' }, h('div', { class: 'card' },
      h('h1', {}, 'Setup needed'),
      h('p', { class: 'sub' }, 'Open renderer/config.js and paste your Supabase project URL and anon key, then restart DayGoal.'))));
    return;
  }

  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });

  // ---------- State ----------
  const S = {
    user: null,
    view: 'today',
    day: ymd(),
    settings: { morning_time: '06:00', evening_time: '21:00' },
    taskFilter: lsGet('taskFilter') || 'active',
    statsRange: lsGet('statsRange') || '30',
    search: { text: '', cs: false },
    channel: null
  };

  // ---------- Data access ----------
  const db = {
    goals: (day) => q(sb.from('goals').select('*').eq('day', day).order('position').order('created_at')),
    addGoals: (day, texts, start = 0) =>
      q(sb.from('goals').insert(texts.map((text, i) => ({ user_id: S.user.id, day, text, position: start + i })))),
    updGoal: (id, patch) => q(sb.from('goals').update(patch).eq('id', id)),
    delGoal: (id) => q(sb.from('goals').delete().eq('id', id)),

    recurring: () => q(sb.from('recurring_goals').select('*').order('position').order('created_at')),
    addRecurring: (r) => q(sb.from('recurring_goals').insert({ user_id: S.user.id, ...r })),
    updRecurring: (id, patch) => q(sb.from('recurring_goals').update(patch).eq('id', id)),
    delRecurring: (id) => q(sb.from('recurring_goals').delete().eq('id', id)),

    entry: async (day) => (await q(sb.from('day_entries').select('*').eq('day', day).limit(1)))[0] || null,
    saveEntry: (day, done_notes) =>
      q(sb.from('day_entries').upsert({ user_id: S.user.id, day, done_notes }, { onConflict: 'user_id,day' })),

    notesForDay: (day) => q(sb.from('notes').select('*').eq('day', day).order('created_at')),
    allNotes: () => q(sb.from('notes').select('*').order('day', { ascending: false }).order('created_at', { ascending: false }).limit(500)),
    note: async (id) => (await q(sb.from('notes').select('*').eq('id', id).limit(1)))[0] || null,
    saveNote: (n) => n.id
      ? q(sb.from('notes').update({ title: n.title, body: n.body, tags: n.tags, day: n.day }).eq('id', n.id))
      : q(sb.from('notes').insert({ user_id: S.user.id, title: n.title, body: n.body, tags: n.tags, day: n.day })),
    delNote: (id) => q(sb.from('notes').delete().eq('id', id)),

    tasks: () => q(sb.from('tasks').select('*').order('created_at')),
    addTask: (t) => q(sb.from('tasks').insert({ user_id: S.user.id, ...t })),
    updTask: (id, patch) => {
      if ('status' in patch) patch.completed_at = patch.status === 'done' ? new Date().toISOString() : null;
      return q(sb.from('tasks').update(patch).eq('id', id));
    },
    delTask: (id) => q(sb.from('tasks').delete().eq('id', id)),

    settings: async () => (await q(sb.from('user_settings').select('*').limit(1)))[0] || null,
    saveSettings: (s) => q(sb.from('user_settings').upsert({ user_id: S.user.id, ...s }, { onConflict: 'user_id' })),

    search: (text, cs) => q(sb.rpc('search_all', { q: text, case_sensitive: cs }))
  };

  // ---------- Auth (email + password) ----------
  function renderAuth() {
    let mode = 'signin'; // or 'signup'
    const draw = () => {
      $app.replaceChildren();
      const isUp = mode === 'signup';
      const err = h('div', { class: 'err' });
      const email = h('input', { class: 'input', type: 'email', placeholder: 'you@example.com', value: lsGet('lastEmail') || '', autocomplete: 'email' });
      const pass = h('input', { class: 'input', type: 'password', placeholder: isUp ? 'Password (min 6 characters)' : 'Password', autocomplete: isUp ? 'new-password' : 'current-password', style: 'margin-top:10px' });
      const pass2 = isUp && h('input', { class: 'input', type: 'password', placeholder: 'Confirm password', autocomplete: 'new-password', style: 'margin-top:10px' });
      const btn = h('button', { class: 'btn primary', style: 'width:100%;margin-top:14px' }, isUp ? 'Create account' : 'Sign in');

      const submit = async () => {
        const e = email.value.trim(), p = pass.value;
        err.textContent = '';
        if (!e || !p) { err.textContent = 'Enter your email and password.'; return; }
        if (isUp && p.length < 6) { err.textContent = 'Password must be at least 6 characters.'; return; }
        if (isUp && p !== pass2.value) { err.textContent = 'Passwords don\'t match.'; return; }
        btn.disabled = true;
        lsSet('lastEmail', e);
        const { data, error } = isUp
          ? await sb.auth.signUp({ email: e, password: p })
          : await sb.auth.signInWithPassword({ email: e, password: p });
        btn.disabled = false;
        if (error) { err.textContent = error.message; return; }
        if (isUp && !data.session) {
          // Happens only if "Confirm email" is still on in Supabase.
          err.style.color = 'var(--muted)';
          err.textContent = 'Account created. Check your email to confirm it, then sign in.';
          mode = 'signin';
        }
      };
      btn.onclick = submit;
      for (const i of [email, pass, pass2]) if (i) i.onkeydown = (ev) => { if (ev.key === 'Enter') submit(); };

      const card = h('div', { class: 'card' },
        h('div', { class: 'row', style: 'margin-bottom:14px' }, h('img', { src: '../assets/icon.png', width: 34, height: 34, style: 'border-radius:8px' })),
        h('h1', {}, 'DayGoal'),
        h('p', { class: 'sub' }, isUp ? 'Create your account.' : 'Sign in to sync across your devices.'),
        h('div', { style: 'margin-top:16px' }, email, pass, pass2),
        btn, err,
        h('button', { class: 'btn ghost sm', style: 'margin-top:10px', onclick: () => { mode = isUp ? 'signin' : 'signup'; draw(); } },
          isUp ? 'Have an account? Sign in' : 'New here? Create an account'));
      $app.append(h('div', { class: 'auth' }, card));
      (email.value ? pass : email).focus();
    };
    draw();
  }

  // ---------- Shell ----------
  const NAV = [
    ['today', 'Today', 'Ctrl+1'],
    ['journal', 'Journal', 'Ctrl+2'],
    ['tasks', 'Long-term goals', 'Ctrl+3'],
    ['notes', 'Knowledge bank', 'Ctrl+4'],
    ['stats', 'Your Performance', 'Ctrl+5'],
    ['search', 'Search', 'Ctrl+F'],
    ['settings', 'Settings', '']
  ];
  let $main = null;

  function renderShell() {
    $app.replaceChildren();
    const side = h('nav', { class: 'side' },
      h('div', { class: 'brand' }, h('img', { src: '../assets/icon.png' }), 'DayGoal'),
      NAV.map(([id, label, key]) => h('button', {
        class: 'nav' + (navId(S.view) === id ? ' active' : ''), 'data-view': id,
        onclick: () => go(id)
      }, label, key && h('span', { class: 'k' }, key))),
      h('div', { class: 'spacer' }),
      h('div', { class: 'who' }, S.user.email));
    $main = h('main', { class: 'main' });
    $app.append(h('div', { class: 'shell' }, side, $main));
  }

  // A single day opened from the journal highlights "Journal" in the sidebar.
  const navId = (view) => (view === 'day' ? 'journal' : view);
  function go(view, opts = {}) {
    if (view === 'today') S.day = ymd();
    if (opts.day) S.day = opts.day;
    S.view = view;
    document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('active', b.dataset.view === navId(view)));
    return render();
  }

  let renderSeq = 0;
  async function render() {
    if (!$main) return;
    const seq = ++renderSeq;
    hideTip();
    const views = { today: viewDay, day: viewDay, journal: viewJournal, tasks: viewTasks, notes: viewNotes, stats: viewStats, search: viewSearch, settings: viewSettings };
    try {
      const el = await views[S.view]();
      if (seq !== renderSeq) return; // a newer render started
      const scroll = $main.scrollTop;
      $main.replaceChildren(h('div', { class: 'main-inner' }, el));
      $main.scrollTop = scroll;
      el.querySelector?.('[data-autofocus]')?.focus();
    } catch (e) { fail(e); }
  }

  // Refresh after remote changes, but never while the user is typing in the page.
  let pendingRefresh = false;
  const refresh = debounce(() => {
    const a = document.activeElement;
    const typing = a && $main?.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName);
    if (typing || $modal.childElementCount) { pendingRefresh = true; return; }
    pendingRefresh = false;
    render();
  }, 400);
  document.addEventListener('focusout', () => setTimeout(() => pendingRefresh && refresh(), 50));

  // ---------- Day view (Today / Journal) ----------
  async function viewDay() {
    const day = S.day;
    const isToday = day === ymd();
    if (isToday) await addRecurringForToday();
    const [goals, entry, notes] = await Promise.all([db.goals(day), db.entry(day), db.notesForDay(day)]);
    const done = goals.filter((g) => g.completed).length;

    const dateInput = h('input', { class: 'input', type: 'date', value: day, onchange: (e) => e.target.value && go('day', { day: e.target.value }) });
    const head = h('div', { class: 'head' },
      h('div', {},
        S.view === 'day' && h('button', { class: 'btn ghost sm', style: 'margin:-6px 0 8px -9px', onclick: () => go('journal') }, '← Journal'),
        h('h1', {}, isToday ? 'Today' : prettyDay(day, { weekday: 'long', month: 'short', day: 'numeric' })),
        h('div', { class: 'sub' }, prettyDay(day))),
      h('div', { class: 'datebar' },
        h('button', { class: 'btn', title: 'Previous day', onclick: () => go('day', { day: addDays(day, -1) }) }, '‹'),
        dateInput,
        h('button', { class: 'btn', title: 'Next day', onclick: () => go('day', { day: addDays(day, 1) }) }, '›'),
        !isToday && h('button', { class: 'btn', onclick: () => go('today') }, 'Today')));

    // Goals
    const addInput = h('textarea', { class: 'input task-input goals-add', rows: 1, placeholder: 'Add a task and press Enter (Shift+Enter for a new line)' });
    autoGrow(addInput);
    addInput.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter' || e.shiftKey) return;
      e.preventDefault();
      const text = addInput.value.trim();
      if (!text) return;
      addInput.value = ''; addInput.style.height = '';
      try { await db.addGoals(day, [text], goals.length); await render(); document.querySelector('.goals-add')?.focus(); } catch (err) { fail(err); }
    });
    const goalsCard = h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', {}, 'What I want to accomplish'),
        h('div', { class: 'row' },
          goals.length > 0 && h('span', { class: 'muted small' }, `${done}/${goals.length} done`),
          h('button', { class: 'btn sm', title: 'Goals that come back every morning', onclick: recurringManager }, '↻ Repeating'),
          h('button', { class: 'btn sm', onclick: () => morningPrompt(day) }, 'Plan'))),
      goals.length > 0 && h('div', { class: 'progress', style: 'margin-bottom:10px' }, h('i', { style: `width:${(done / goals.length) * 100}%` })),
      goals.length === 0 && h('div', { class: 'empty' }, 'No goals set yet.'),
      goals.map((g) => h('div', { class: 'goal' + (g.completed ? ' done' : '') },
        h('input', { type: 'checkbox', class: 'check', checked: g.completed, onchange: async (e) => { try { await db.updGoal(g.id, { completed: e.target.checked }); render(); } catch (err) { fail(err); } } }),
        h('span', { class: 't', title: 'Double-click to edit', ondblclick: () => editGoal(g) }, g.text,
          g.recurring_id && h('span', { class: 'rep', title: 'Repeating goal' }, ' ↻')),
        h('button', { class: 'icon-btn', title: 'Delete', onclick: async () => { try { await db.delGoal(g.id); render(); } catch (err) { fail(err); } } }, '✕'))),
      h('div', { class: 'add-row' }, addInput));

    // Done notes (autosave)
    const saved = h('span', { class: 'saved' }, entry?.done_notes ? 'Saved' : '');
    const ta = h('textarea', { class: 'input', rows: 7, placeholder: 'Everything you actually got done today…', value: entry?.done_notes || '' });
    const save = debounce(async () => {
      try { await db.saveEntry(day, ta.value); saved.textContent = 'Saved'; } catch (err) { saved.textContent = 'Not saved'; fail(err); }
    }, 700);
    ta.oninput = () => { saved.textContent = 'Saving…'; save(); };
    const doneCard = h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'What I actually did'), saved), ta);

    // Knowledge for the day
    const notesCard = h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', {}, 'Knowledge bank'),
        h('button', { class: 'btn sm primary', onclick: () => noteEditor({ day }) }, '+ Add note')),
      notes.length === 0 && h('div', { class: 'empty' }, 'Nothing recorded for this day. Learned something? Write it down.'),
      notes.map(noteCard));

    return h('div', {}, head, goalsCard, doneCard, notesCard);
  }

  function editGoal(g) {
    const inp = h('textarea', { class: 'input task-input', rows: 1, value: g.text });
    autoGrow(inp);
    const save = async () => { if (inp.value.trim()) await db.updGoal(g.id, { text: inp.value.trim() }); render(); };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) { e.preventDefault(); save().then(() => activeClose?.(), fail); }
    });
    openModal('Edit task', inp, [['Cancel', null], ['Save', save, 'primary']], {
      subtitle: 'Enter to save · Shift+Enter for a new line' + (g.recurring_id ? ' · Changes this day only (edit the repeating goal under ↻ Repeating)' : '')
    });
    setTimeout(() => { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }, 0);
  }

  // Textarea that grows with its content.
  function autoGrow(ta) {
    const fit = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; };
    ta.addEventListener('input', fit);
    requestAnimationFrame(fit);
    return fit;
  }

  // Task-by-task composer: Enter confirms a task and moves to the next,
  // Shift+Enter adds a line inside the task, Ctrl+Enter is handled by the modal (save all).
  function taskComposer() {
    const list = h('div', { class: 'composer' });
    const rows = () => [...list.querySelectorAll('textarea')];
    const renumber = () => rows().forEach((ta, i) => (ta.parentElement.querySelector('.num').textContent = i + 1 + '.'));
    const focusEnd = (ta) => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); };

    function addRow(text = '', afterRow = null) {
      const ta = h('textarea', { class: 'input task-input', rows: 1, placeholder: 'What do you want to get done?', value: text });
      const row = h('div', { class: 'compose-row' + (text ? ' ok' : '') }, h('span', { class: 'num' }), ta);
      afterRow ? afterRow.after(row) : list.append(row);
      autoGrow(ta);
      ta.addEventListener('keydown', (e) => {
        const all = rows(), i = all.indexOf(ta);
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          if (!ta.value.trim()) return;
          row.classList.add('ok');
          const next = all[i + 1];
          if (next) focusEnd(next);
          else addRow('', row).focus();
        } else if (e.key === 'Backspace' && !ta.value && all.length > 1) {
          e.preventDefault();
          row.remove(); renumber();
          focusEnd(all[i - 1] || all[i + 1]);
        } else if (e.key === 'ArrowUp' && ta.selectionStart === 0 && ta.selectionEnd === 0 && i > 0) {
          e.preventDefault(); focusEnd(all[i - 1]);
        } else if (e.key === 'ArrowDown' && ta.selectionStart === ta.value.length && all[i + 1]) {
          e.preventDefault(); focusEnd(all[i + 1]);
        }
      });
      ta.addEventListener('input', () => { if (!ta.value.trim()) row.classList.remove('ok'); });
      renumber();
      return ta;
    }
    addRow();

    return {
      el: list,
      focus: () => focusEnd(rows().at(-1)),
      values: () => rows().map((ta) => ta.value.trim()).filter(Boolean),
      // Add text as its own task, keeping an empty task at the end to type into.
      add(text) {
        const last = rows().at(-1);
        if (!last.value.trim()) { last.value = text; last.dispatchEvent(new Event('input')); last.parentElement.classList.add('ok'); addRow('', last.parentElement).focus(); }
        else { const ta = addRow(text, last.parentElement); addRow('', ta.parentElement).focus(); }
      }
    };
  }

  // ---------- Repeating goals ----------
  // The first time the app looks at today, active repeating goals scheduled for today's
  // weekday are copied into today's goals. last_added stops a goal coming back after you
  // delete today's copy; a unique index stops duplicates if two devices do this at once.
  let recurringCheckedFor = null, recurringRun = null;
  function addRecurringForToday() {
    const today = ymd();
    if (recurringCheckedFor === today) return Promise.resolve();
    return recurringRun ||= (async () => {
      const wd = new Date().getDay();
      const due = (await db.recurring()).filter((r) => r.active && r.weekdays.includes(wd) && (!r.last_added || r.last_added < today));
      if (due.length) {
        await q(sb.from('goals').upsert(
          due.map((r) => ({ user_id: S.user.id, day: today, text: r.text, recurring_id: r.id, position: r.position - 1000 })),
          { onConflict: 'user_id,day,recurring_id', ignoreDuplicates: true }));
        await q(sb.from('recurring_goals').update({ last_added: today }).in('id', due.map((r) => r.id)));
      }
      recurringCheckedFor = today;
    })().catch((e) => console.error('Repeating goals:', e)).finally(() => { recurringRun = null; });
  }

  // Shown Monday-first; values are JS getDay() (0 = Sunday).
  const WEEK = [[1, 'M', 'Mon'], [2, 'T', 'Tue'], [3, 'W', 'Wed'], [4, 'T', 'Thu'], [5, 'F', 'Fri'], [6, 'S', 'Sat'], [0, 'S', 'Sun']];
  const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
  function weekdaysLabel(days) {
    const set = new Set(days);
    if (set.size === 7) return 'Every day';
    if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) return 'Weekdays';
    if (set.size === 2 && set.has(0) && set.has(6)) return 'Weekends';
    return WEEK.filter(([v]) => set.has(v)).map(([, , l]) => l).join(', ');
  }
  function weekdayPicker(days, onChange) {
    const set = new Set(days);
    return h('div', { class: 'wd-row', title: weekdaysLabel(days) }, WEEK.map(([v, l, full]) => h('button', {
      class: 'wd' + (set.has(v) ? ' on' : ''), title: full, type: 'button',
      onclick: () => {
        if (set.has(v) && set.size === 1) return toast('Pick at least one day');
        set.has(v) ? set.delete(v) : set.add(v);
        onChange([...set].sort());
      }
    }, l)));
  }

  async function recurringManager() {
    const body = h('div', {});
    let newDays = ALL_DAYS;
    const today = ymd();
    // Today's unchecked copy of a repeating goal (the one that follows edits/removal).
    const todaysCopy = (id) => ({ recurring_id: id, day: today, completed: false });

    // After any change: recheck today, refresh the page underneath and this list.
    const changed = async () => { recurringCheckedFor = null; await addRecurringForToday(); render(); await draw(); };
    const act = (fn) => async (...a) => { try { await fn(...a); await changed(); } catch (e) { fail(e); } };

    const editText = (r) => {
      const inp = h('input', { class: 'input grow', value: r.text });
      body.querySelector(`[data-id="${r.id}"] .t`).replaceWith(inp);
      inp.focus(); inp.select();
      let done = false;
      const save = act(async () => {
        if (done) return; done = true;
        const text = inp.value.trim();
        if (!text || text === r.text) return;
        await db.updRecurring(r.id, { text });
        await q(sb.from('goals').update({ text }).match(todaysCopy(r.id)));
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); save(); }
        if (e.key === 'Escape') { e.stopPropagation(); done = true; draw(); }
      }, true);
      inp.addEventListener('blur', () => save());
    };

    async function draw() {
      const list = await db.recurring();
      const input = h('input', { class: 'input grow', placeholder: 'New repeating goal, e.g. "Read 20 pages"' });
      const addBtn = h('button', { class: 'btn primary' }, 'Add');
      // Lock while saving so a second Enter/click can't add the same goal twice.
      let busy = false;
      const add = async () => {
        const text = input.value.trim();
        if (!text || busy) return;
        if (list.some((r) => r.text.trim().toLowerCase() === text.toLowerCase())) return toast('That goal already repeats');
        busy = input.disabled = addBtn.disabled = true;
        try {
          await db.addRecurring({ text, weekdays: newDays, position: list.length });
          newDays = ALL_DAYS;
          await changed();
        } catch (e) { fail(e); busy = input.disabled = addBtn.disabled = false; }
      };
      addBtn.onclick = add;
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); add(); } }, true);
      const picker = h('div', {});
      const drawPicker = () => picker.replaceChildren(weekdayPicker(newDays, (d) => { newDays = d; drawPicker(); }));
      drawPicker();

      body.replaceChildren(h('div', {},
        list.length === 0 && h('div', { class: 'empty' }, 'No repeating goals yet. Add habits you want on your list every morning.'),
        list.map((r) => h('div', { class: 'rec-row' + (r.active ? '' : ' paused'), 'data-id': r.id },
          h('input', { type: 'checkbox', class: 'check', checked: r.active, title: r.active ? 'On (uncheck to pause)' : 'Paused',
            onchange: act((e) => db.updRecurring(r.id, { active: e.target.checked })) }),
          h('span', { class: 't grow', title: 'Click to rename', onclick: () => editText(r) }, r.text,
            !r.active && h('span', { class: 'muted small' }, ' · paused')),
          weekdayPicker(r.weekdays, act((d) => db.updRecurring(r.id, { weekdays: d }))),
          h('button', { class: 'icon-btn', title: 'Stop repeating', onclick: act(async () => {
            if (!confirm(`Stop repeating "${r.text}"? Past days keep their history.`)) return;
            await q(sb.from('goals').delete().match(todaysCopy(r.id)));
            await db.delRecurring(r.id);
          }) }, '✕'))),
        h('div', { class: 'rec-add' }, input, picker, addBtn)));
      input.focus();
    }

    try { await draw(); } catch (e) { return fail(e); }
    openModal('Repeating goals', body, [['Done', null, 'primary']], {
      subtitle: 'Added to your list automatically each morning. Click a name to rename it, uncheck to pause.', ctrlEnter: false, enterSubmit: false
    });
    setTimeout(() => body.querySelector('.rec-add input')?.focus(), 0);
  }

  // ---------- Journal (history of days) ----------
  async function viewJournal() {
    const since = addDays(ymd(), -365);
    const [goals, entries, notes] = await Promise.all([
      q(sb.from('goals').select('day,text,completed').gte('day', since).order('position')),
      q(sb.from('day_entries').select('day,done_notes').gte('day', since)),
      q(sb.from('notes').select('day,title').gte('day', since))
    ]);
    const days = new Map();
    const get = (d) => days.get(d) || days.set(d, { goals: [], done: '', notes: 0 }).get(d);
    goals.forEach((g) => get(g.day).goals.push(g));
    entries.forEach((e) => { if (e.done_notes.trim()) get(e.day).done = e.done_notes; });
    notes.forEach((n) => get(n.day).notes++);
    const sorted = [...days.entries()].sort((a, b) => b[0].localeCompare(a[0]));

    const jump = h('input', { class: 'input', type: 'date', onchange: (e) => e.target.value && go('day', { day: e.target.value }) });
    return h('div', {},
      h('div', { class: 'head' },
        h('div', {}, h('h1', {}, 'Journal'), h('div', { class: 'sub' }, 'Past days: what you planned, did and learned.')),
        h('label', { class: 'row small muted' }, 'Jump to', jump)),
      sorted.length === 0 && h('div', { class: 'card empty' }, 'No days recorded yet. Start with Today.'),
      sorted.map(([day, d]) => {
        const doneCount = d.goals.filter((g) => g.completed).length;
        return h('div', { class: 'jday', onclick: () => go('day', { day }) },
          h('div', { class: 'row' },
            h('strong', { class: 'grow' }, day === ymd() ? 'Today' : prettyDay(day, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })),
            d.goals.length > 0 && h('span', { class: 'badge' }, `${doneCount}/${d.goals.length} tasks`),
            d.notes > 0 && h('span', { class: 'badge' }, `${d.notes} note${d.notes === 1 ? '' : 's'}`)),
          d.goals.length > 0 && h('div', { class: 'jgoals' }, d.goals.slice(0, 6).map((g) =>
            h('span', { class: g.completed ? 'ok' : '' }, (g.completed ? '✓ ' : '○ ') + g.text.split('\n')[0]))),
          d.done && h('div', { class: 'snippet' }, d.done.length > 240 ? d.done.slice(0, 240) + '…' : d.done));
      }));
  }

  // ---------- Notes ----------
  function noteCard(n) {
    return h('div', { class: 'note', onclick: () => noteEditor(n) },
      h('div', { class: 'title' }, n.title || (n.body || '').split('\n')[0].slice(0, 80) || 'Untitled'),
      n.body && h('div', { class: 'body' }, n.body),
      (n.tags || []).length > 0 && h('div', {}, n.tags.map((t) => h('span', {
        class: 'tag', onclick: (e) => { e.stopPropagation(); S.search.text = t; go('search'); }
      }, '#' + t))));
  }

  function noteEditor(n = {}) {
    const title = h('input', { class: 'input', placeholder: 'Title (optional)', value: n.title || '' });
    const body = h('textarea', { class: 'input', rows: 12, placeholder: 'What did you learn? Notes, links, snippets…', value: n.body || '' });
    const tags = h('input', { class: 'input', placeholder: 'tags, comma separated', value: (n.tags || []).join(', ') });
    const day = h('input', { class: 'input', type: 'date', value: n.day || S.day || ymd() });
    const form = h('div', {},
      h('label', { class: 'field' }, h('span', {}, 'Title'), title),
      h('label', { class: 'field' }, h('span', {}, 'Note'), body),
      h('div', { class: 'row' },
        h('label', { class: 'field grow' }, h('span', {}, 'Tags'), tags),
        h('label', { class: 'field' }, h('span', {}, 'Day'), day)));
    const actions = [];
    if (n.id) actions.push(['Delete', async () => { if (confirm('Delete this note?')) { await db.delNote(n.id); render(); } else return false; }, 'danger ghost']);
    actions.push(['Cancel', null]);
    actions.push(['Save', async () => {
      if (!title.value.trim() && !body.value.trim()) return;
      await db.saveNote({
        id: n.id, title: title.value.trim(), body: body.value,
        tags: tags.value.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean),
        day: day.value || ymd()
      });
      toast('Note saved');
      render();
    }, 'primary']);
    openModal(n.id ? 'Edit note' : 'New note', form, actions, { ctrlEnter: true });
    setTimeout(() => (n.id ? body : (n.title ? body : title)).focus(), 0);
  }

  async function viewNotes() {
    const notes = await db.allNotes();
    const groups = new Map();
    for (const n of notes) { if (!groups.has(n.day)) groups.set(n.day, []); groups.get(n.day).push(n); }
    return h('div', {},
      h('div', { class: 'head' },
        h('div', {}, h('h1', {}, 'Knowledge bank'), h('div', { class: 'sub' }, `${notes.length} note${notes.length === 1 ? '' : 's'}, newest first`)),
        h('button', { class: 'btn primary', onclick: () => noteEditor({ day: ymd() }) }, '+ New note')),
      notes.length === 0 && h('div', { class: 'card empty' }, 'Your knowledge bank is empty.'),
      [...groups.entries()].map(([day, list]) => [
        h('div', { class: 'day-label', style: 'cursor:pointer', onclick: () => go('day', { day }) }, prettyDay(day, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })),
        list.map(noteCard)
      ]));
  }

  // ---------- Long-term tasks ----------
  async function viewTasks() {
    const all = await db.tasks();
    const top = all.filter((t) => !t.parent_id);
    const subsOf = (id) => all.filter((t) => t.parent_id === id);
    const filtered = top.filter((t) => S.taskFilter === 'all' ? true : S.taskFilter === 'done' ? t.status === 'done' : t.status !== 'done');
    const order = { doing: 0, todo: 1, done: 2 };
    filtered.sort((a, b) => order[a.status] - order[b.status] || (a.due_date || '9999').localeCompare(b.due_date || '9999'));

    const title = h('input', { class: 'input', placeholder: 'New long-term goal…', 'data-autofocus': S.taskFilter !== 'done' ? true : null });
    const due = h('input', { class: 'input', type: 'date' });
    const add = async () => {
      if (!title.value.trim()) return;
      try { await db.addTask({ title: title.value.trim(), due_date: due.value || null }); render(); } catch (e) { fail(e); }
    };
    title.onkeydown = (e) => { if (e.key === 'Enter') add(); };

    const tab = (id, label) => h('button', { class: S.taskFilter === id ? 'on' : '', onclick: () => { S.taskFilter = id; lsSet('taskFilter', id); render(); } }, label);

    return h('div', {},
      h('div', { class: 'head' },
        h('div', {}, h('h1', {}, 'Long-term goals'), h('div', { class: 'sub' }, 'Bigger goals broken into steps.')),
        h('div', { class: 'tabs' }, tab('active', 'Active'), tab('done', 'Done'), tab('all', 'All'))),
      h('div', { class: 'card row' }, title, due, h('button', { class: 'btn primary', onclick: add }, 'Add')),
      filtered.length === 0 && h('div', { class: 'empty' }, S.taskFilter === 'done' ? 'Nothing completed yet.' : 'No active goals. Add one above.'),
      filtered.map((t) => taskCard(t, subsOf(t.id))));
  }

  function taskCard(t, subs) {
    const today = ymd();
    const subsDone = subs.filter((s) => s.status === 'done').length;
    const overdue = t.due_date && t.status !== 'done' && t.due_date < today;
    const subInput = h('input', { class: 'input', placeholder: 'Add a step and press Enter', style: 'padding:5px 9px' });
    subInput.onkeydown = async (e) => {
      if (e.key !== 'Enter' || !subInput.value.trim()) return;
      try { await db.addTask({ title: subInput.value.trim(), parent_id: t.id }); await render(); } catch (err) { fail(err); }
    };
    const status = h('select', { class: 'status', onchange: async (e) => { try { await db.updTask(t.id, { status: e.target.value }); render(); } catch (err) { fail(err); } } },
      [['todo', 'To do'], ['doing', 'In progress'], ['done', 'Done']].map(([v, l]) => h('option', { value: v, selected: t.status === v ? true : null }, l)));

    return h('div', { class: 'task' + (t.status === 'done' ? ' is-done' : '') },
      h('div', { class: 'row' },
        h('div', { class: 'title grow', onclick: () => taskEditor(t) }, t.title),
        status,
        h('button', { class: 'icon-btn', title: 'Edit', onclick: () => taskEditor(t) }, '✎')),
      h('div', { class: 'row', style: 'margin-top:4px' },
        t.due_date && h('span', { class: 'meta' + (overdue ? ' overdue' : '') }, (overdue ? 'Overdue · ' : 'Due ') + prettyDay(t.due_date, { month: 'short', day: 'numeric', year: 'numeric' })),
        subs.length > 0 && h('span', { class: 'meta' }, `${subsDone}/${subs.length} steps`)),
      t.description && h('div', { class: 'desc' }, t.description),
      subs.length > 0 && h('div', { class: 'progress', style: 'margin-top:10px' }, h('i', { style: `width:${(subsDone / subs.length) * 100}%` })),
      h('div', { class: 'subs' },
        subs.map((s) => h('div', { class: 'sub-item' + (s.status === 'done' ? ' done' : '') },
          h('input', { type: 'checkbox', class: 'check', checked: s.status === 'done', onchange: async (e) => { try { await db.updTask(s.id, { status: e.target.checked ? 'done' : 'todo' }); render(); } catch (err) { fail(err); } } }),
          h('span', { class: 'grow' }, s.title),
          h('button', { class: 'icon-btn', title: 'Delete step', onclick: async () => { try { await db.delTask(s.id); render(); } catch (err) { fail(err); } } }, '✕'))),
        t.status !== 'done' && h('div', { style: 'margin-top:6px' }, subInput)));
  }

  function taskEditor(t) {
    const title = h('input', { class: 'input', value: t.title });
    const desc = h('textarea', { class: 'input', rows: 6, placeholder: 'Why it matters, plan, notes…', value: t.description || '' });
    const due = h('input', { class: 'input', type: 'date', value: t.due_date || '' });
    openModal('Edit goal', h('div', {},
      h('label', { class: 'field' }, h('span', {}, 'Title'), title),
      h('label', { class: 'field' }, h('span', {}, 'Description'), desc),
      h('label', { class: 'field' }, h('span', {}, 'Due date'), due)), [
      ['Delete', async () => { if (!confirm('Delete this goal and its steps?')) return false; await db.delTask(t.id); render(); }, 'danger ghost'],
      ['Cancel', null],
      ['Save', async () => {
        if (!title.value.trim()) return false;
        await db.updTask(t.id, { title: title.value.trim(), description: desc.value, due_date: due.value || null });
        render();
      }, 'primary']
    ], { ctrlEnter: true });
  }

  // ---------- Stats ----------
  const RANGES = [['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['365', 'Year'], ['all', 'All time']];
  const pct = (v) => (v == null ? '—' : Math.round(v * 100) + '%');
  const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 864e5);
  const weekStart = (d) => addDays(d, -((parseYmd(d).getDay() + 6) % 7)); // Monday
  const words = (t) => (t.trim() ? t.trim().split(/\s+/).length : 0);

  // Supabase caps a select at 1000 rows; page through everything.
  async function fetchAll(table, cols) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const rows = await q(sb.from(table).select(cols).order('id').range(from, from + 999));
      out.push(...rows);
      if (rows.length < 1000) return out;
    }
  }

  // Hover/focus tooltip for any element with data-tip.
  const $tip = h('div', { class: 'tip' });
  document.body.append($tip);
  function hideTip() { $tip.classList.remove('show'); }
  function showTipFor(e) {
    const el = e.target.closest?.('[data-tip]');
    if (!el) return hideTip();
    $tip.textContent = el.dataset.tip;
    $tip.classList.add('show');
    const r = el.getBoundingClientRect(), t = $tip.getBoundingClientRect();
    const x = Math.max(8, Math.min(r.left + r.width / 2 - t.width / 2, innerWidth - t.width - 8));
    let y = r.top - t.height - 8;
    if (y < 8) y = r.bottom + 8;
    $tip.style.left = x + 'px'; $tip.style.top = y + 'px';
  }
  document.addEventListener('mouseover', showTipFor);
  document.addEventListener('focusin', showTipFor);
  document.addEventListener('scroll', hideTip, true);

  const tile = (label, value, sub, extra) => h('div', { class: 'stat' },
    h('div', { class: 'stat-label' }, label),
    h('div', { class: 'stat-value' }, value),
    sub && h('div', { class: 'stat-sub' }, sub), extra);

  // Single-series bar chart of rates (0..1); value null = nothing planned.
  function barChart(items, height = 140) {
    return h('div', { class: 'bars', style: `--h:${height}px` },
      h('div', { class: 'bars-y' }, [0, 50, 100].map((v) => h('span', { style: `bottom:${v}%` }, v + '%'))),
      h('div', { class: 'bars-plot' },
        [0, 50, 100].map((v) => h('div', { class: 'gl', style: `bottom:${v}%` })),
        items.map((it) => h('div', { class: 'bar-col' + (it.value == null ? ' none' : ''), 'data-tip': it.tip, tabindex: 0, onclick: it.onclick },
          it.value != null && h('i', { style: `height:${Math.max(it.value * 100, 1.5)}%` })))),
      h('div', { class: 'bars-x' }, items.map((it) => h('span', {}, it.short || ''))));
  }

  async function viewStats() {
    const [goals, entries, notes, tasks] = await Promise.all([
      fetchAll('goals', 'day,completed'),
      fetchAll('day_entries', 'day,done_notes'),
      fetchAll('notes', 'day,tags'),
      fetchAll('tasks', 'parent_id,status,due_date,created_at,completed_at')
    ]);
    const today = ymd();
    const dayOf = (ts) => (ts ? ymd(new Date(ts)) : null);

    const byDay = new Map(); // day -> { planned, done }
    for (const g of goals) {
      if (g.day > today) continue;
      const d = byDay.get(g.day) || byDay.set(g.day, { planned: 0, done: 0 }).get(g.day);
      d.planned++; if (g.completed) d.done++;
    }
    const logs = new Map(entries.filter((e) => e.day <= today && e.done_notes.trim()).map((e) => [e.day, e.done_notes]));
    const first = [...byDay.keys(), ...logs.keys(), ...notes.map((n) => n.day), ...tasks.map((t) => dayOf(t.created_at))]
      .filter((d) => d && d <= today).sort()[0];

    const head = h('div', { class: 'head' },
      h('div', {}, h('h1', {}, 'Your Performance'), h('div', { class: 'sub' }, 'How your days are actually going.')),
      h('div', { class: 'tabs' }, RANGES.map(([id, label]) => h('button', {
        class: S.statsRange === id ? 'on' : '', onclick: () => { S.statsRange = id; lsSet('statsRange', id); render(); }
      }, label))));
    if (!first) return h('div', {}, head, h('div', { class: 'card empty' }, 'No data yet. Plan a day and check things off to see your performance here.'));

    const n = S.statsRange === 'all' ? null : Number(S.statsRange);
    const start = n ? addDays(today, -(n - 1)) : first;
    const from = start > first ? start : first; // don't count days before you started using DayGoal
    const nDays = daysBetween(from, today) + 1;
    const inRange = (d, a = from, b = today) => d && d >= a && d <= b;
    const rangeName = n ? `last ${n} days` : 'all time';

    // --- Daily goals ---
    const period = (a, b) => {
      let planned = 0, done = 0, days = 0, perfect = 0, sum = 0;
      for (const [d, v] of byDay) if (inRange(d, a, b)) {
        planned += v.planned; done += v.done; days++; sum += v.done / v.planned;
        if (v.done === v.planned) perfect++;
      }
      return { planned, done, days, perfect, rate: planned ? done / planned : null, avgDay: days ? sum / days : null };
    };
    const cur = period(from, today);
    const prev = n ? period(addDays(start, -n), addDays(start, -1)) : null;
    let delta = null;
    if (prev?.rate != null && cur.rate != null) {
      const diff = Math.round((cur.rate - prev.rate) * 100);
      delta = h('div', { class: 'stat-sub delta ' + (diff > 0 ? 'up' : diff < 0 ? 'down' : '') },
        diff === 0 ? `Same as previous ${n} days` : `${diff > 0 ? '▲' : '▼'} ${Math.abs(diff)} pts vs previous ${n} days`);
    }

    const streaks = (has) => {
      let best = 0, run = 0;
      for (let d = first; d <= today; d = addDays(d, 1)) { run = has(d) ? run + 1 : 0; best = Math.max(best, run); }
      let current = 0, d = has(today) ? today : addDays(today, -1); // today still counts as in progress
      while (has(d)) { current++; d = addDays(d, -1); }
      return { current, best };
    };
    const streakTile = (label, s, what) => tile(label, `${s.current} day${s.current === 1 ? '' : 's'}`, `Best: ${s.best} · ${what}`);
    const winS = streaks((d) => byDay.get(d)?.done > 0);
    const planS = streaks((d) => byDay.has(d));
    const logS = streaks((d) => logs.has(d));

    // --- Trend (bucket size follows the range) ---
    const unit = nDays <= 31 ? 'day' : nDays <= 120 ? 'week' : 'month';
    const keyOf = (d) => (unit === 'day' ? d : unit === 'week' ? weekStart(d) : d.slice(0, 7));
    const buckets = new Map();
    for (let d = from; d <= today; d = addDays(d, 1)) {
      const k = keyOf(d), v = byDay.get(d);
      const b = buckets.get(k) || buckets.set(k, { planned: 0, done: 0 }).get(k);
      if (v) { b.planned += v.planned; b.done += v.done; }
    }
    const multiYear = from.slice(0, 4) !== today.slice(0, 4);
    const monthDate = (k) => parseYmd(k + '-01');
    const longLabel = (k) => unit === 'day' ? prettyDay(k, { weekday: 'short', month: 'short', day: 'numeric' })
      : unit === 'week' ? 'Week of ' + prettyDay(k, { month: 'short', day: 'numeric' })
      : monthDate(k).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const shortLabel = (k) => unit === 'month' ? monthDate(k).toLocaleDateString(undefined, { month: 'short', ...(multiYear ? { year: '2-digit' } : {}) })
      : nDays <= 7 ? prettyDay(k, { weekday: 'short' }) : prettyDay(k, { month: 'numeric', day: 'numeric' });
    const keys = [...buckets.keys()];
    const step = Math.ceil(keys.length / 10);
    const trend = keys.map((k, i) => {
      const b = buckets.get(k);
      return {
        value: b.planned ? b.done / b.planned : null,
        short: (keys.length - 1 - i) % step === 0 ? shortLabel(k) : '',
        tip: `${longLabel(k)}\n${b.planned ? `${b.done}/${b.planned} done · ${pct(b.done / b.planned)}` : 'Nothing planned'}`,
        onclick: unit === 'day' ? () => go('day', { day: k }) : null
      };
    });

    // --- Weekday ---
    const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const wd = WD.map(() => ({ planned: 0, done: 0, days: 0 }));
    for (const [d, v] of byDay) if (inRange(d)) {
      const w = wd[(parseYmd(d).getDay() + 6) % 7];
      w.planned += v.planned; w.done += v.done; w.days++;
    }
    const wdItems = wd.map((w, i) => ({
      value: w.planned ? w.done / w.planned : null, short: WD[i],
      tip: `${WD[i]}s\n${w.planned ? `${w.done}/${w.planned} done · ${pct(w.done / w.planned)} over ${w.days} day${w.days === 1 ? '' : 's'}` : 'Nothing planned'}`
    }));
    const ranked = wd.map((w, i) => [i, w.planned ? w.done / w.planned : -1]).filter((x) => x[1] >= 0).sort((a, b) => b[1] - a[1]);

    // --- Heatmap: last 26 weeks, always ---
    const hmStart = addDays(weekStart(today), -25 * 7);
    const cells = [];
    for (let i = 0; i < 26 * 7; i++) {
      const d = addDays(hmStart, i);
      if (d > today) { cells.push(h('i', { class: 'future' })); continue; }
      const v = byDay.get(d), r = v ? v.done / v.planned : null;
      const lvl = r == null ? 0 : r === 1 ? 4 : r >= 0.5 ? 3 : r > 0 ? 2 : 1;
      cells.push(h('i', {
        class: 'l' + lvl, tabindex: 0, onclick: () => go('day', { day: d }),
        'data-tip': `${prettyDay(d, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}\n${v ? `${v.done}/${v.planned} done · ${pct(r)}` : 'Nothing planned'}${logs.has(d) ? '\nEvening logged' : ''}`
      }));
    }

    // --- Long-term goals ---
    const top = tasks.filter((t) => !t.parent_id);
    const active = top.filter((t) => t.status !== 'done');
    const finished = top.filter((t) => t.status === 'done' && inRange(dayOf(t.completed_at)));
    const withDue = finished.filter((t) => t.due_date);
    const onTime = withDue.filter((t) => dayOf(t.completed_at) <= t.due_date).length;
    const overdue = active.filter((t) => t.due_date && t.due_date < today).length;
    const stepsDone = tasks.filter((t) => t.parent_id && t.status === 'done' && inRange(dayOf(t.completed_at))).length;
    const avgFinish = finished.length
      ? finished.reduce((s, t) => s + daysBetween(dayOf(t.created_at), dayOf(t.completed_at)), 0) / finished.length : null;

    // --- Journal & knowledge ---
    const loggedDays = [...logs.keys()].filter((d) => inRange(d));
    const wordCount = loggedDays.reduce((s, d) => s + words(logs.get(d)), 0);
    const rangeNotes = notes.filter((x) => inRange(x.day));
    const tagCount = new Map();
    rangeNotes.forEach((x) => (x.tags || []).forEach((t) => tagCount.set(t, (tagCount.get(t) || 0) + 1)));
    const topTags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

    const avg = (a, b) => (b ? (a / b).toFixed(1) : '—');
    return h('div', {}, head,
      from > start && h('div', { class: 'muted small', style: 'margin:-12px 0 14px' }, `Counting from your first day, ${prettyDay(from, { month: 'short', day: 'numeric', year: 'numeric' })}.`),

      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Daily goals'), h('span', { class: 'muted small' }, rangeName)),
        h('div', { class: 'stats-grid' },
          tile('Completion rate', pct(cur.rate), `${cur.done} of ${cur.planned} tasks done`, delta),
          tile('Average day', pct(cur.avgDay), 'mean % done per planned day'),
          tile('Perfect days', cur.perfect, `${pct(cur.days ? cur.perfect / cur.days : null)} of planned days hit 100%`),
          tile('Days planned', `${cur.days}/${nDays}`, `${pct(cur.days / nDays)} planning consistency`),
          tile('Tasks per day', avg(cur.planned, cur.days), `${avg(cur.done, cur.days)} completed on average`))),

      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Streaks'), h('span', { class: 'muted small' }, 'all time')),
        h('div', { class: 'stats-grid' },
          streakTile('Win streak', winS, 'days with at least 1 task done'),
          streakTile('Planning streak', planS, 'days with goals set'),
          streakTile('Journal streak', logS, 'evenings logged'))),

      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Completion trend'), h('span', { class: 'muted small' }, `% of tasks done, by ${unit}`)),
        barChart(trend)),

      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'By weekday'),
          ranked.length > 1 && h('span', { class: 'muted small' }, `Best: ${WD[ranked[0][0]]} (${pct(ranked[0][1])}) · Toughest: ${WD[ranked.at(-1)[0]]} (${pct(ranked.at(-1)[1])})`)),
        barChart(wdItems, 110)),

      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Last 26 weeks'), h('span', { class: 'muted small' }, 'Click a day to open it')),
        h('div', { class: 'heat-wrap' },
          h('div', { class: 'heat-days' }, WD.map((d, i) => h('span', {}, i % 2 === 0 ? d : ''))),
          h('div', { class: 'heat' }, cells)),
        h('div', { class: 'heat-legend' },
          h('i', { class: 'l0' }), 'Nothing planned', h('span', { style: 'width:14px' }),
          '0%', h('i', { class: 'l1' }), h('i', { class: 'l2' }), h('i', { class: 'l3' }), h('i', { class: 'l4' }), '100%')),

      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Long-term goals'), h('span', { class: 'muted small' }, rangeName)),
        h('div', { class: 'stats-grid' },
          tile('Completed', finished.length, `${stepsDone} step${stepsDone === 1 ? '' : 's'} checked off`),
          tile('On time', withDue.length ? pct(onTime / withDue.length) : '—', withDue.length ? `${onTime} of ${withDue.length} with a due date` : 'no due-dated goals finished'),
          tile('Active', active.length, `${active.filter((t) => t.status === 'doing').length} in progress`),
          tile('Overdue', overdue, 'active goals past due'),
          tile('Time to finish', avgFinish == null ? '—' : `${Math.round(avgFinish)}d`, 'average, created → done'))),

      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Journal & knowledge'), h('span', { class: 'muted small' }, rangeName)),
        h('div', { class: 'stats-grid' },
          tile('Evenings logged', `${loggedDays.length}/${nDays}`, `${pct(loggedDays.length / nDays)} of days`),
          tile('Words journaled', wordCount.toLocaleString(), `${avg(wordCount, loggedDays.length)} per logged day`),
          tile('Notes added', rangeNotes.length, `${avg(rangeNotes.length, nDays / 7)} per week`)),
        topTags.length > 0 && h('div', { style: 'margin-top:12px' },
          h('span', { class: 'muted small' }, 'Top tags: '),
          topTags.map(([t, c]) => h('span', { class: 'tag', onclick: () => { S.search.text = t; go('search'); } }, `#${t} · ${c}`)))));
  }

  // ---------- Search (literal substring) ----------
  function highlight(text, needle, cs) {
    const out = [];
    if (!needle) return [text];
    const hay = cs ? text : text.toLowerCase();
    const nd = cs ? needle : needle.toLowerCase();
    let i = 0, j;
    while ((j = hay.indexOf(nd, i)) !== -1) {
      if (j > i) out.push(text.slice(i, j));
      out.push(h('mark', {}, text.slice(j, j + needle.length)));
      i = j + needle.length;
    }
    out.push(text.slice(i));
    return out;
  }
  function snippet(text, needle, cs) {
    const hay = cs ? text : text.toLowerCase();
    const idx = hay.indexOf(cs ? needle : needle.toLowerCase());
    if (idx < 0 || text.length <= 220) return text.slice(0, 220) + (text.length > 220 ? '…' : '');
    const start = Math.max(0, idx - 80);
    return (start > 0 ? '…' : '') + text.slice(start, start + 220) + (start + 220 < text.length ? '…' : '');
  }

  async function viewSearch() {
    const input = h('input', { class: 'input search-box', placeholder: 'Search everything you have written…', value: S.search.text, 'data-autofocus': true });
    const cs = h('input', { type: 'checkbox', class: 'check', checked: S.search.cs });
    const results = h('div', {});
    const LABEL = { goal: 'Goal', done: 'Did', task: 'Long-term', note: 'Note' };

    const run = async () => {
      const text = input.value;
      S.search = { text, cs: cs.checked };
      if (!text) { results.replaceChildren(h('div', { class: 'empty' }, 'Type to search goals, daily logs, long-term goals and notes. Matches the exact text you type.')); return; }
      try {
        const rows = await db.search(text, cs.checked);
        if (input.value !== text) return;
        results.replaceChildren(
          h('div', { class: 'muted small', style: 'margin:4px 0 10px' }, `${rows.length} result${rows.length === 1 ? '' : 's'}`),
          ...rows.map((r) => {
            const body = r.item_body || '';
            return h('div', { class: 'result', onclick: () => openResult(r) },
              h('div', { class: 'row' },
                h('span', { class: 'badge' }, LABEL[r.kind] || r.kind),
                h('strong', { class: 'grow' }, highlight(r.item_title || 'Untitled', text, cs.checked)),
                r.item_day && h('span', { class: 'muted small' }, prettyDay(r.item_day, { month: 'short', day: 'numeric', year: 'numeric' }))),
              body && h('div', { class: 'snippet' }, highlight(snippet(body, text, cs.checked), text, cs.checked)));
          }));
      } catch (e) { fail(e); }
    };
    const runD = debounce(run, 250);
    input.oninput = runD;
    cs.onchange = run;
    setTimeout(run, 0);

    return h('div', {},
      h('div', { class: 'head' }, h('div', {}, h('h1', {}, 'Search'), h('div', { class: 'sub' }, 'Exact text match across everything.'))),
      input,
      h('label', { class: 'row small muted', style: 'margin:10px 0 16px;cursor:pointer;width:max-content' }, cs, 'Match case'),
      results);
  }

  async function openResult(r) {
    try {
      if (r.kind === 'goal' || r.kind === 'done') return go('day', { day: r.item_day });
      if (r.kind === 'note') { const n = await db.note(r.item_id); if (n) noteEditor(n); return; }
      if (r.kind === 'task') {
        const t = (await db.tasks()).find((x) => x.id === r.item_id);
        if (t?.parent_id) { S.taskFilter = 'all'; await go('tasks'); return; }
        if (t) { S.taskFilter = t.status === 'done' ? 'done' : 'active'; await go('tasks'); taskEditor(t); }
      }
    } catch (e) { fail(e); }
  }

  // ---------- Settings ----------
  async function viewSettings() {
    const morning = h('input', { class: 'input', type: 'time', value: S.settings.morning_time });
    const evening = h('input', { class: 'input', type: 'time', value: S.settings.evening_time });
    const autostart = h('input', { type: 'checkbox', class: 'check' });
    if (desk) desk.getAutoLaunch().then((v) => (autostart.checked = v));
    autostart.onchange = async () => { autostart.checked = await desk.setAutoLaunch(autostart.checked); toast(autostart.checked ? 'Will start with Windows' : 'Won\'t start with Windows'); };

    const save = async () => {
      try {
        S.settings = { morning_time: morning.value || '06:00', evening_time: evening.value || '21:00' };
        await db.saveSettings(S.settings);
        toast('Reminder times saved (synced to all devices)');
      } catch (e) { fail(e); }
    };

    return h('div', {},
      h('div', { class: 'head' }, h('h1', {}, 'Settings')),
      h('section', { class: 'card' },
        h('h2', { style: 'margin-bottom:12px' }, 'Daily reminders'),
        h('div', { class: 'row wrap', style: 'gap:24px' },
          h('label', { class: 'field' }, h('span', {}, 'Morning: set goals at'), morning),
          h('label', { class: 'field' }, h('span', {}, 'Evening: log what I did at'), evening)),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', onclick: save }, 'Save times'),
          h('button', { class: 'btn', onclick: () => morningPrompt() }, 'Try morning prompt'),
          h('button', { class: 'btn', onclick: () => eveningPrompt() }, 'Try evening prompt')),
        h('p', { class: 'muted small' }, 'If your PC is off at the set time, you\'ll be prompted the next time DayGoal runs that day.')),
      desk && h('section', { class: 'card' },
        h('h2', { style: 'margin-bottom:12px' }, 'This PC'),
        h('label', { class: 'row', style: 'cursor:pointer' }, autostart, 'Start DayGoal when Windows starts (runs in the tray)'),
        h('p', { class: 'muted small' }, 'Closing the window keeps DayGoal running in the system tray. Use the tray icon → Quit to exit.')),
      h('section', { class: 'card' },
        h('h2', { style: 'margin-bottom:12px' }, 'Account'),
        h('div', { class: 'row' }, h('span', { class: 'grow muted' }, S.user.email),
          h('button', { class: 'btn danger', onclick: async () => { await sb.auth.signOut(); } }, 'Sign out'))));
  }

  // ---------- Modal ----------
  let activeClose = null;
  function openModal(title, body, actions = [['Close', null]], opts = {}) {
    activeClose?.();
    const close = () => { if (activeClose === close) activeClose = null; $modal.replaceChildren(); document.removeEventListener('keydown', onKey, true); if (pendingRefresh) refresh(); };
    const run = async (fn, btn) => {
      if (!fn) return close();
      btn && (btn.disabled = true);
      try { const r = await fn(); if (r !== false) close(); } catch (e) { fail(e); } finally { btn && (btn.disabled = false); }
    };
    const btns = actions.map(([label, fn, cls]) => {
      const b = h('button', { class: 'btn ' + (cls || '') }, label);
      b.onclick = () => run(fn, b);
      return b;
    });
    const primary = actions.findIndex((a) => (a[2] || '').includes('primary'));
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      if (opts.ctrlEnter !== false && e.key === 'Enter' && (e.ctrlKey || e.metaKey) && primary >= 0) { e.preventDefault(); btns[primary].click(); }
      if (opts.enterSubmit !== false && e.key === 'Enter' && !e.ctrlKey && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && primary >= 0) { e.preventDefault(); btns[primary].click(); }
    };
    document.addEventListener('keydown', onKey, true);
    const overlay = h('div', { class: 'overlay', onmousedown: (e) => e.target === overlay && close() },
      h('div', { class: 'modal' }, h('h2', {}, title), opts.subtitle && h('div', { class: 'sub' }, opts.subtitle),
        h('div', { style: 'margin-top:14px' }, body), h('div', { class: 'actions' }, btns)));
    $modal.replaceChildren(overlay);
    activeClose = close;
    return close;
  }

  // ---------- Morning / Evening prompts ----------
  let promptOpen = false;
  async function morningPrompt(day = ymd()) {
    if (promptOpen || !S.user) return;
    promptOpen = true;
    try {
      if (day === ymd()) await addRecurringForToday();
      const [goals, tasks] = await Promise.all([db.goals(day), db.tasks()]);
      const composer = taskComposer();
      const active = tasks.filter((t) => t.status !== 'done');
      const parent = Object.fromEntries(tasks.map((t) => [t.id, t]));
      const body = h('div', {},
        goals.length > 0 && h('div', { style: 'margin-bottom:12px' },
          h('div', { class: 'small muted', style: 'margin-bottom:4px' }, 'Already planned:'),
          goals.map((g) => h('div', { class: 'small', style: 'white-space:pre-wrap' }, (g.completed ? '✓ ' : '• ') + g.text))),
        composer.el,
        h('div', { class: 'small muted', style: 'margin-top:8px' }, 'Enter: next task · Shift+Enter: new line · Ctrl+Enter: save all'),
        active.length > 0 && h('div', { style: 'margin-top:12px' },
          h('div', { class: 'small muted' }, 'Pull from long-term goals:'),
          h('div', { class: 'chips' }, active.slice(0, 20).map((t) => {
            const label = t.parent_id && parent[t.parent_id] ? `${parent[t.parent_id].title}: ${t.title}` : t.title;
            return h('button', { class: 'chip', onclick: () => composer.add(label) }, '+ ' + label);
          }))));
      openModal(day === ymd() ? 'Good morning! What do you want to accomplish today?' : `Goals for ${prettyDay(day)}`, body, [
        ['Later (30 min)', () => { snooze('m'); }],
        ['Save goals', async () => {
          const tasks = composer.values();
          if (tasks.length) await db.addGoals(day, tasks, goals.length);
          markDone('m');
          render();
        }, 'primary']
      ]);
      setTimeout(() => composer.focus(), 0);
    } catch (e) { fail(e); } finally {
      // promptOpen resets when the modal closes
      const obs = new MutationObserver(() => { if (!$modal.childElementCount) { promptOpen = false; obs.disconnect(); } });
      obs.observe($modal, { childList: true });
      if (!$modal.childElementCount) { promptOpen = false; obs.disconnect(); }
    }
  }

  async function eveningPrompt(day = ymd()) {
    if (promptOpen || !S.user) return;
    promptOpen = true;
    try {
      const [goals, entry] = await Promise.all([db.goals(day), db.entry(day)]);
      const ta = h('textarea', { class: 'input', rows: 8, placeholder: 'Everything you actually did today…', value: entry?.done_notes || '' });
      const body = h('div', {},
        goals.length > 0 && h('div', { style: 'margin-bottom:12px' },
          h('div', { class: 'small muted', style: 'margin-bottom:6px' }, 'This morning you planned — check off what got done:'),
          goals.map((g) => h('label', { class: 'goal', style: 'cursor:pointer' },
            h('input', { type: 'checkbox', class: 'check', checked: g.completed, onchange: (e) => db.updGoal(g.id, { completed: e.target.checked }).catch(fail) }),
            h('span', { class: 't' }, g.text)))),
        ta,
        h('button', { class: 'btn ghost sm', style: 'margin-top:8px', onclick: async () => {
          await db.saveEntry(day, ta.value).catch(fail);
          markDone('e');
          activeClose?.();
          setTimeout(() => noteEditor({ day }), 0);
        } }, 'Learned something? Add to knowledge bank →'));
      openModal('End of day: what did you actually do?', body, [
        ['Later (30 min)', () => { snooze('e'); }],
        ['Save', async () => { await db.saveEntry(day, ta.value); markDone('e'); render(); }, 'primary']
      ], { subtitle: 'Ctrl+Enter to save' });
      setTimeout(() => ta.focus(), 0);
    } catch (e) { fail(e); } finally {
      const obs = new MutationObserver(() => { if (!$modal.childElementCount) { promptOpen = false; obs.disconnect(); } });
      obs.observe($modal, { childList: true });
      if (!$modal.childElementCount) { promptOpen = false; obs.disconnect(); }
    }
  }

  // ---------- Reminder scheduler ----------
  // Flag per day: 'done' once handled, or a timestamp to wait for after snoozing.
  const flagKey = (k) => `prompt:${k}:${ymd()}`;
  const markDone = (k) => lsSet(flagKey(k), 'done');
  const snooze = (k) => lsSet(flagKey(k), String(Date.now() + 30 * 60 * 1000));
  const due = (k) => {
    const v = lsGet(flagKey(k));
    if (v === 'done') return false;
    if (v && Date.now() < Number(v)) return false;
    return true;
  };

  let ticking = false;
  async function tick() {
    if (!S.user || ticking || promptOpen) return;
    ticking = true;
    try {
      const now = new Date();
      const mins = now.getHours() * 60 + now.getMinutes();
      const m = toMin(S.settings.morning_time), e = toMin(S.settings.evening_time);
      const today = ymd();
      if (S.view === 'today' && S.day !== today) { S.day = today; render(); } // rolled past midnight
      await addRecurringForToday();

      if (mins >= e && due('e')) {
        markDone('m'); // too late for the morning prompt
        const entry = await db.entry(today);
        if (entry?.done_notes?.trim()) { markDone('e'); return; }
        markDone('e'); // will be overwritten by snooze if the user picks "Later"
        desk?.notify({ title: 'DayGoal: end of day', body: 'What did you actually get done today?', action: 'evening' });
        desk?.show();
        await eveningPrompt();
      } else if (mins >= m && mins < e && due('m')) {
        const goals = await db.goals(today);
        if (goals.some((g) => !g.recurring_id)) { markDone('m'); return; } // repeating goals alone still get the prompt
        markDone('m');
        desk?.notify({ title: 'DayGoal: good morning', body: 'What do you want to accomplish today?', action: 'morning' });
        desk?.show();
        await morningPrompt();
      }
    } catch (err) { console.error(err); } finally { ticking = false; }
  }

  desk?.onAction((a) => {
    if (a === 'morning') morningPrompt();
    else if (a === 'evening') eveningPrompt();
    else if (a === 'note') noteEditor({ day: ymd() });
    else if (a === 'tick') tick();
  });

  // ---------- Realtime sync ----------
  function subscribe() {
    S.channel?.unsubscribe();
    S.channel = sb.channel('daygoal-' + S.user.id);
    S.channel.on('postgres_changes', { event: '*', schema: 'public', table: 'recurring_goals', filter: `user_id=eq.${S.user.id}` }, () => { recurringCheckedFor = null; refresh(); });
    for (const table of ['goals', 'day_entries', 'tasks', 'notes']) {
      S.channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `user_id=eq.${S.user.id}` }, refresh);
    }
    S.channel.on('postgres_changes', { event: '*', schema: 'public', table: 'user_settings', filter: `user_id=eq.${S.user.id}` }, (p) => {
      if (p.new?.morning_time) S.settings = { morning_time: p.new.morning_time, evening_time: p.new.evening_time };
      if (S.view === 'settings') refresh();
    });
    S.channel.subscribe();
  }

  // ---------- Keyboard shortcuts ----------
  document.addEventListener('keydown', (e) => {
    if (!S.user || $modal.childElementCount || !(e.ctrlKey || e.metaKey)) return;
    const map = { '1': 'today', '2': 'journal', '3': 'tasks', '4': 'notes', '5': 'stats', f: 'search', k: 'search' };
    const v = map[e.key.toLowerCase()];
    if (v) { e.preventDefault(); go(v); }
    if (e.key.toLowerCase() === 'n') { e.preventDefault(); noteEditor({ day: S.view === 'day' || S.view === 'today' ? S.day : ymd() }); }
  });

  // ---------- Boot ----------
  let tickTimer = null;
  async function onSignedIn(user) {
    if (S.user?.id === user.id && $main) return;
    S.user = user;
    try {
      const s = await db.settings();
      if (s) S.settings = { morning_time: s.morning_time, evening_time: s.evening_time };
      else await db.saveSettings(S.settings);
    } catch (e) { console.error(e); }
    renderShell();
    await go('today');
    subscribe();
    clearInterval(tickTimer);
    tickTimer = setInterval(tick, 30 * 1000);
    setTimeout(tick, 1500);
  }

  function onSignedOut() {
    S.user = null; $main = null;
    S.channel?.unsubscribe(); S.channel = null;
    clearInterval(tickTimer);
    activeClose?.();
    renderAuth();
  }

  sb.auth.onAuthStateChange((event, session) => {
    // Defer to avoid calling Supabase inside the auth callback (can deadlock).
    setTimeout(() => {
      if (session?.user) onSignedIn(session.user);
      else if (event === 'SIGNED_OUT' || event === 'INITIAL_SESSION') onSignedOut();
    }, 0);
  });
})();
