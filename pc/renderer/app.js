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
      for (const i of [email, pass, pass2]) if (i) i.onkeydown = (ev) => ev.key === 'Enter' && submit();

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
    ['day', 'Journal', 'Ctrl+2'],
    ['tasks', 'Long-term goals', 'Ctrl+3'],
    ['notes', 'Knowledge bank', 'Ctrl+4'],
    ['search', 'Search', 'Ctrl+F'],
    ['settings', 'Settings', '']
  ];
  let $main = null;

  function renderShell() {
    $app.replaceChildren();
    const side = h('nav', { class: 'side' },
      h('div', { class: 'brand' }, h('img', { src: '../assets/icon.png' }), 'DayGoal'),
      NAV.map(([id, label, key]) => h('button', {
        class: 'nav' + (S.view === id ? ' active' : ''), 'data-view': id,
        onclick: () => go(id)
      }, label, key && h('span', { class: 'k' }, key))),
      h('div', { class: 'spacer' }),
      h('div', { class: 'who' }, S.user.email));
    $main = h('main', { class: 'main' });
    $app.append(h('div', { class: 'shell' }, side, $main));
  }

  function go(view, opts = {}) {
    if (view === 'today') S.day = ymd();
    if (opts.day) S.day = opts.day;
    S.view = view;
    document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    return render();
  }

  let renderSeq = 0;
  async function render() {
    if (!$main) return;
    const seq = ++renderSeq;
    const views = { today: viewDay, day: viewDay, tasks: viewTasks, notes: viewNotes, search: viewSearch, settings: viewSettings };
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
    const [goals, entry, notes] = await Promise.all([db.goals(day), db.entry(day), db.notesForDay(day)]);
    const done = goals.filter((g) => g.completed).length;

    const dateInput = h('input', { class: 'input', type: 'date', value: day, onchange: (e) => e.target.value && go('day', { day: e.target.value }) });
    const head = h('div', { class: 'head' },
      h('div', {}, h('h1', {}, isToday ? 'Today' : prettyDay(day, { weekday: 'long', month: 'short', day: 'numeric' })),
        h('div', { class: 'sub' }, prettyDay(day))),
      h('div', { class: 'datebar' },
        h('button', { class: 'btn', title: 'Previous day', onclick: () => go('day', { day: addDays(day, -1) }) }, '‹'),
        dateInput,
        h('button', { class: 'btn', title: 'Next day', onclick: () => go('day', { day: addDays(day, 1) }) }, '›'),
        !isToday && h('button', { class: 'btn', onclick: () => go('today') }, 'Today')));

    // Goals
    const addInput = h('input', { class: 'input', placeholder: 'Add a goal for this day and press Enter' });
    addInput.onkeydown = async (e) => {
      if (e.key !== 'Enter' || !addInput.value.trim()) return;
      const lines = addInput.value.split('\n').map((s) => s.trim()).filter(Boolean);
      addInput.value = '';
      try { await db.addGoals(day, lines, goals.length); await render(); document.querySelector('.goals-add')?.focus(); } catch (err) { fail(err); }
    };
    addInput.classList.add('goals-add');
    const goalsCard = h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', {}, 'What I want to accomplish'),
        h('div', { class: 'row' },
          goals.length > 0 && h('span', { class: 'muted small' }, `${done}/${goals.length} done`),
          h('button', { class: 'btn sm', onclick: () => morningPrompt(day) }, 'Plan'))),
      goals.length > 0 && h('div', { class: 'progress', style: 'margin-bottom:10px' }, h('i', { style: `width:${(done / goals.length) * 100}%` })),
      goals.length === 0 && h('div', { class: 'empty' }, 'No goals set yet.'),
      goals.map((g) => h('div', { class: 'goal' + (g.completed ? ' done' : '') },
        h('input', { type: 'checkbox', class: 'check', checked: g.completed, onchange: async (e) => { try { await db.updGoal(g.id, { completed: e.target.checked }); render(); } catch (err) { fail(err); } } }),
        h('span', { class: 't', title: 'Double-click to edit', ondblclick: () => editGoal(g) }, g.text),
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
    const inp = h('input', { class: 'input', value: g.text });
    openModal('Edit goal', inp, [
      ['Cancel', null],
      ['Save', async () => { if (inp.value.trim()) await db.updGoal(g.id, { text: inp.value.trim() }); render(); }, 'primary']
    ]);
    setTimeout(() => inp.focus(), 0);
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
    title.onkeydown = (e) => e.key === 'Enter' && add();

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
          rows.map((r) => {
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
      if (e.key === 'Enter' && !e.ctrlKey && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && primary >= 0) { e.preventDefault(); btns[primary].click(); }
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
      const [goals, tasks] = await Promise.all([db.goals(day), db.tasks()]);
      const ta = h('textarea', { class: 'input', rows: 7, placeholder: 'One goal per line' });
      const active = tasks.filter((t) => t.status !== 'done');
      const parent = Object.fromEntries(tasks.map((t) => [t.id, t]));
      const addLine = (txt) => { ta.value = (ta.value.trim() ? ta.value.replace(/\s*$/, '\n') : '') + txt; ta.focus(); };
      const body = h('div', {},
        goals.length > 0 && h('div', { style: 'margin-bottom:12px' },
          h('div', { class: 'small muted', style: 'margin-bottom:4px' }, 'Already planned:'),
          goals.map((g) => h('div', { class: 'small' }, (g.completed ? '✓ ' : '• ') + g.text))),
        ta,
        active.length > 0 && h('div', { style: 'margin-top:12px' },
          h('div', { class: 'small muted' }, 'Pull from long-term goals:'),
          h('div', { class: 'chips' }, active.slice(0, 20).map((t) => {
            const label = t.parent_id && parent[t.parent_id] ? `${parent[t.parent_id].title}: ${t.title}` : t.title;
            return h('button', { class: 'chip', onclick: () => addLine(label) }, '+ ' + label);
          }))));
      openModal(day === ymd() ? 'Good morning! What do you want to accomplish today?' : `Goals for ${prettyDay(day)}`, body, [
        ['Later (30 min)', () => { snooze('m'); }],
        ['Save goals', async () => {
          const lines = ta.value.split('\n').map((s) => s.replace(/^[-*•]\s*/, '').trim()).filter(Boolean);
          if (lines.length) await db.addGoals(day, lines, goals.length);
          markDone('m');
          render();
        }, 'primary']
      ], { subtitle: 'Ctrl+Enter to save' });
      setTimeout(() => ta.focus(), 0);
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
        if (goals.length) { markDone('m'); return; }
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
    const map = { '1': 'today', '2': 'day', '3': 'tasks', '4': 'notes', f: 'search', k: 'search' };
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
