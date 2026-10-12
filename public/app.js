/**
 * Dashboard client: stats, project intake, task tracking, approval queue,
 * team administration and audit log. All rendering escapes untrusted text;
 * every request carries X-Requested-With so the server can reject cross-site
 * requests even if a browser omits Origin.
 */

(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };
  var esc = function (value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var fmt = function (date) {
    try { return date ? new Date(date).toLocaleString() : ''; } catch (e) { return String(date || ''); }
  };
  var statusLabel = function (status) {
    return { queued: 'queued', in_progress: 'in progress', completed: 'completed', blocked: 'blocked' }[status] || status;
  };

  /** @type {{id: string, email: string, name: string, role: string}|null} */
  var me = null;
  var toastTimer = null;

  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 3200);
  }

  function api(url, options) {
    options = options || {};
    var headers = Object.assign(
      { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      options.headers || {}
    );
    return fetch(url, Object.assign({}, options, { headers: headers })).then(function (res) {
      if (res.status === 401) {
        window.location.assign('/auth?returnTo=' + encodeURIComponent('/app'));
        throw new Error('Signing you in…');
      }
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || 'Request failed (' + res.status + ').');
        return data;
      });
    });
  }

  function isAdmin() { return Boolean(me && me.role === 'admin'); }
  function canEdit() { return me && (me.role === 'admin' || me.role === 'member'); }

  // --- rendering ----------------------------------------------------------

  function renderUser() {
    if (!me) return;
    $('#user-name').textContent = me.name || me.email;
    $('#user-role').textContent = me.role;
    $('#user-avatar').textContent = (me.name || me.email || '?').charAt(0).toUpperCase();
    $('#topbar-eyebrow').textContent = 'WORKSPACE / ' + (me.name || me.email).toUpperCase();
    $('#nav-team').hidden = !isAdmin();
    $('#team').hidden = !isAdmin();
    $('#approvals-role-pill').textContent = isAdmin() ? 'you can decide' : 'admin decision required';
    if (!canEdit()) {
      var form = $('#project-form');
      var btn = $('#create-btn');
      btn.disabled = true;
      form.classList.add('readonly');
      $('#form-message').textContent = 'Your role has read-only access. Ask an admin to create plans.';
    }
  }

  function renderProjects(projects) {
    var root = $('#project-list');
    if (!projects.length) {
      root.innerHTML = '<div class="empty-state">No projects yet. Create your first brief above.</div>';
      return;
    }
    root.innerHTML = projects.map(function (p) {
      var tasks = p.tasks || [];
      var done = tasks.filter(function (t) { return t.status === 'completed'; }).length;
      var taskRows = tasks.map(function (t) {
        var actions = '';
        if (canEdit()) {
          if (t.status === 'queued' || t.status === 'blocked') {
            actions += '<button class="small-button" data-task="in_progress" data-project="' + esc(p.id) + '" data-task-id="' + esc(t.id) + '">Start</button>';
          }
          if (t.status === 'in_progress' || t.status === 'blocked') {
            actions += '<button class="small-button approve" data-task="completed" data-project="' + esc(p.id) + '" data-task-id="' + esc(t.id) + '">Complete</button>';
          }
          if (t.status === 'completed') {
            actions += '<button class="small-button" data-task="queued" data-project="' + esc(p.id) + '" data-task-id="' + esc(t.id) + '">Reopen</button>';
          }
        }
        return '<li class="task-row task-' + esc(t.status) + '">' +
          '<div class="task-info"><strong>' + esc(t.title) + '</strong><small>' + esc(t.agent) + (t.requiresApproval ? ' · approval gate' : '') + '</small></div>' +
          '<span class="tag ' + (t.status === 'completed' ? 'green' : t.status === 'in_progress' ? 'blue' : t.status === 'blocked' ? 'danger' : '') + '">' + esc(statusLabel(t.status)) + '</span>' +
          (actions ? '<span class="task-actions">' + actions + '</span>' : '') +
          '</li>';
      }).join('');

      var deliverables = (p.plan && p.plan.deliverables ? p.plan.deliverables : [])
        .map(function (d) { return '<span class="tag">' + esc(d) + '</span>'; }).join('');

      var deleteBtn = isAdmin()
        ? '<button class="small-button danger" data-delete="' + esc(p.id) + '">Delete</button>'
        : '';

      return '<article class="project-card">' +
        '<div class="project-main">' +
          '<h3>' + esc(p.name) + '</h3>' +
          '<p class="project-prompt">' + esc(p.prompt) + '</p>' +
          '<div class="meta">' +
            '<span class="tag">' + esc((p.plan && p.plan.planningMode) || 'rules-based') + '</span>' +
            '<span class="tag">' + tasks.length + ' tasks</span>' +
            '<span class="tag ' + (p.status === 'completed' ? 'green' : 'warn') + '">' + esc(p.status) + '</span>' +
            '<span class="tag">' + esc((p.plan && p.plan.languageDetected) || '') + '</span>' +
            '<span class="tag">' + esc(fmt(p.createdAt)) + '</span>' +
            '<span class="tag">by ' + esc(p.createdByLabel || 'unknown') + '</span>' +
          '</div>' +
          '<div class="project-progress">' +
            '<progress max="' + tasks.length + '" value="' + done + '"></progress>' +
            '<span>' + done + '/' + tasks.length + ' tasks</span>' +
          '</div>' +
          '<details class="plan-details">' +
            '<summary>View plan &amp; tasks</summary>' +
            '<div class="plan-body">' +
              '<p><b>Summary:</b> ' + esc((p.plan && p.plan.summary) || '') + '</p>' +
              (deliverables ? '<p class="plan-line"><b>Deliverables:</b> <span class="meta">' + deliverables + '</span></p>' : '') +
              '<ul class="task-list">' + taskRows + '</ul>' +
              '<p class="safety-note">Safety: publishing, ad spend, purchases, deployment and outreach stay approval-gated. This system plans work; it does not execute external actions.</p>' +
            '</div>' +
          '</details>' +
        '</div>' +
        '<div class="project-actions">' +
          '<button class="small-button" data-copy="' + esc(p.id) + '">Copy brief</button>' +
          deleteBtn +
        '</div>' +
      '</article>';
    }).join('');

    root.querySelectorAll('[data-copy]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var project = projects.find(function (x) { return x.id === btn.getAttribute('data-copy'); });
        if (!project) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(project.prompt || '').then(function () { toast('Brief copied'); }).catch(function () { toast('Clipboard unavailable'); });
        } else {
          toast('Clipboard unavailable');
        }
      });
    });

    root.querySelectorAll('[data-delete]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-delete');
        if (!window.confirm('Delete this project and its approval records? This cannot be undone.')) return;
        api('/api/projects/' + encodeURIComponent(id), { method: 'DELETE' })
          .then(function () { toast('Project deleted'); return refresh(); })
          .catch(function (err) { toast(err.message); });
      });
    });

    root.querySelectorAll('[data-task]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        btn.disabled = true;
        var projectId = btn.getAttribute('data-project');
        var taskId = btn.getAttribute('data-task-id');
        var status = btn.getAttribute('data-task');
        api('/api/projects/' + encodeURIComponent(projectId) + '/tasks/' + encodeURIComponent(taskId), {
          method: 'PATCH',
          body: JSON.stringify({ status: status }),
        })
          .then(function () { return refresh(); })
          .catch(function (err) { toast(err.message); btn.disabled = false; });
      });
    });
  }

  function renderApprovals(items) {
    $('#nav-approval-count').textContent = String(items.filter(function (a) { return a.status === 'pending'; }).length);
    var root = $('#approval-list');
    if (!items.length) {
      root.innerHTML = '<div class="empty-state">No approval items yet. Social and growth tasks create review records automatically.</div>';
      return;
    }
    root.innerHTML = items.map(function (a) {
      var controls = '';
      if (a.status === 'pending') {
        if (isAdmin()) {
          controls = '<div class="approval-actions">' +
            '<input class="approval-note" data-note-for="' + esc(a.id) + '" maxlength="500" placeholder="Decision note (optional)">' +
            '<button class="small-button approve" data-decision="approved" data-id="' + esc(a.id) + '">Approve</button>' +
            '<button class="small-button reject" data-decision="rejected" data-id="' + esc(a.id) + '">Reject</button>' +
            '</div>';
        } else {
          controls = '<div class="approval-actions"><span class="tag">admin decision required</span></div>';
        }
      }
      return '<article class="approval-card">' +
        '<div>' +
          '<h3>' + esc(a.title) + '</h3>' +
          '<p>' + esc(a.description) + '</p>' +
          '<div class="meta">' +
            '<span class="tag ' + (a.status === 'pending' ? 'warn' : a.status === 'approved' ? 'green' : 'danger') + '">' + esc(a.status) + '</span>' +
            '<span class="tag">requested by ' + esc(a.requestedByLabel || 'unknown') + '</span>' +
            (a.decidedByLabel ? '<span class="tag">decided by ' + esc(a.decidedByLabel) + '</span>' : '') +
            '<span class="tag">' + esc(fmt(a.createdAt)) + '</span>' +
            (a.decidedAt ? '<span class="tag">' + esc(fmt(a.decidedAt)) + '</span>' : '') +
          '</div>' +
          (a.note ? '<p class="approval-note-text">Note: ' + esc(a.note) + '</p>' : '') +
        '</div>' +
        controls +
      '</article>';
    }).join('');

    root.querySelectorAll('[data-decision]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        btn.disabled = true;
        var noteEl = root.querySelector('[data-note-for="' + btn.getAttribute('data-id') + '"]');
        var note = noteEl ? noteEl.value : '';
        api('/api/approvals/' + encodeURIComponent(btn.getAttribute('data-id')), {
          method: 'POST',
          body: JSON.stringify({ decision: btn.getAttribute('data-decision'), note: note }),
        })
          .then(function () { toast('Approval ' + btn.getAttribute('data-decision')); return refresh(); })
          .catch(function (err) { toast(err.message); btn.disabled = false; });
      });
    });
  }

  function renderAudit(events) {
    var root = $('#audit-list');
    if (!events.length) {
      root.innerHTML = '<div class="empty-state">No audit events yet.</div>';
      return;
    }
    root.innerHTML = events.slice(0, 25).map(function (e) {
      return '<div class="audit-row">' +
        '<span><strong>' + esc(e.action) + '</strong> <span class="audit-entity">' + esc(e.entityId) + '</span>' +
        '<span class="audit-actor">by ' + esc(e.actorLabel || 'system') + '</span></span>' +
        '<time>' + esc(fmt(e.createdAt)) + '</time>' +
      '</div>';
    }).join('');
  }

  function renderUsers(users) {
    var root = $('#user-list');
    if (!root) return;
    if (!users.length) {
      root.innerHTML = '<div class="empty-state">No users yet.</div>';
      return;
    }
    root.innerHTML = users.map(function (u) {
      var roleOptions = ['admin', 'member', 'viewer'].map(function (role) {
        return '<option value="' + role + '"' + (u.role === role ? ' selected' : '') + '>' + role + '</option>';
      }).join('');
      return '<div class="user-row' + (u.active ? '' : ' inactive') + '">' +
        '<span class="user-avatar">' + esc((u.name || u.email).charAt(0).toUpperCase()) + '</span>' +
        '<div class="user-info"><strong>' + esc(u.name) + '</strong><small>' + esc(u.email) + '</small></div>' +
        '<div class="user-meta-col"><small>last login</small><strong>' + esc(u.lastLoginAt ? fmt(u.lastLoginAt) : 'never') + '</strong></div>' +
        '<select class="user-role-select" data-user="' + esc(u.id) + '" aria-label="Role for ' + esc(u.email) + '">' + roleOptions + '</select>' +
        '<button class="small-button' + (u.active ? ' reject' : ' approve') + '" data-active-user="' + esc(u.id) + '" data-active="' + (u.active ? 'true' : 'false') + '">' +
          (u.active ? 'Deactivate' : 'Reactivate') +
        '</button>' +
      '</div>';
    }).join('');

    root.querySelectorAll('.user-role-select').forEach(function (select) {
      select.addEventListener('change', function () {
        api('/api/users/' + encodeURIComponent(select.getAttribute('data-user')), {
          method: 'PATCH',
          body: JSON.stringify({ role: select.value }),
        })
          .then(function () { toast('Role updated'); return refresh(); })
          .catch(function (err) { toast(err.message); return refresh(); });
      });
    });

    root.querySelectorAll('[data-active-user]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var next = btn.getAttribute('data-active') === 'true' ? false : true;
        api('/api/users/' + encodeURIComponent(btn.getAttribute('data-active-user')), {
          method: 'PATCH',
          body: JSON.stringify({ active: next }),
        })
          .then(function () { toast(next ? 'User reactivated' : 'User deactivated'); return refresh(); })
          .catch(function (err) { toast(err.message); return refresh(); });
      });
    });
  }

  // --- data loading -------------------------------------------------------

  function refresh() {
    var requests = [
      api('/api/stats'),
      api('/api/projects'),
      api('/api/approvals'),
      api('/api/audit?limit=25'),
    ];
    if (isAdmin()) requests.push(api('/api/users'));

    return Promise.all(requests).then(function (results) {
      var stats = results[0];
      $('#stat-projects').textContent = stats.projects;
      $('#stat-tasks').textContent = stats.tasks;
      $('#stat-approvals').textContent = stats.pendingApprovals;
      $('#stat-completed').textContent = stats.completedTasks;
      renderProjects(results[1].projects);
      renderApprovals(results[2].approvals);
      renderAudit(results[3].events);
      if (isAdmin()) renderUsers(results[4].users);
    }).catch(function (err) {
      toast(err.message);
    });
  }

  // --- forms --------------------------------------------------------------

  $('#project-form').addEventListener('submit', function (event) {
    event.preventDefault();
    if (!canEdit()) return;
    var btn = $('#create-btn');
    var prompt = $('#project-prompt').value.trim();
    var name = $('#project-name').value.trim();
    if (prompt.length < 8) {
      $('#form-message').textContent = 'Please provide a more detailed brief.';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Planning…';
    $('#form-message').textContent = 'Creating a project plan. No external actions will run.';
    api('/api/projects', { method: 'POST', body: JSON.stringify({ name: name, prompt: prompt }) })
      .then(function (data) {
        $('#form-message').textContent = 'Project created using ' +
          ((data.project.plan && data.project.plan.planningMode) || 'planner') + '. ' +
          ((data.project.plan && data.project.plan.aiNote) || '');
        $('#project-prompt').value = '';
        toast('Project plan created');
        return refresh();
      })
      .catch(function (err) {
        $('#form-message').textContent = err.message;
        toast(err.message);
      })
      .then(function () {
        btn.disabled = false;
        btn.innerHTML = 'Generate project plan <span>→</span>';
      });
  });

  $('#refresh-btn').addEventListener('click', function () { refresh(); });

  $('#logout-btn').addEventListener('click', function () {
    api('/api/auth/logout', { method: 'POST' })
      .catch(function () { /* session may already be gone */ })
      .then(function () { window.location.assign('/auth'); });
  });

  var toggleUserForm = $('#toggle-user-form');
  if (toggleUserForm) {
    toggleUserForm.addEventListener('click', function () {
      var form = $('#user-form');
      form.hidden = !form.hidden;
      if (!form.hidden) $('#user-name-input').focus();
    });
  }

  var userForm = $('#user-form');
  if (userForm) {
    userForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var msg = $('#user-form-message');
      var payload = {
        name: $('#user-name-input').value.trim(),
        email: $('#user-email-input').value.trim().toLowerCase(),
        password: $('#user-password-input').value,
        role: $('#user-role-input').value,
      };
      api('/api/users', { method: 'POST', body: JSON.stringify(payload) })
        .then(function () {
          msg.textContent = 'User created.';
          msg.classList.remove('error');
          msg.classList.add('ok');
          userForm.reset();
          userForm.hidden = true;
          toast('Team member added');
          return refresh();
        })
        .catch(function (err) {
          msg.textContent = err.message;
          msg.classList.add('error');
          msg.classList.remove('ok');
        });
    });
  }

  // --- boot ---------------------------------------------------------------

  (function boot() {
    Promise.all([
      api('/api/me').then(function (data) { me = data.user; renderUser(); }),
      fetch('/api/health', { headers: { 'X-Requested-With': 'fetch' } })
        .then(function (r) { return r.json(); })
        .then(function (h) {
          $('#connection-status').textContent = h.aiConfigured ? 'AI provider configured' : 'System online · rules-based planner';
          $('#sidebar-mode').textContent = h.aiConfigured ? 'AI planning enabled' : 'Local starter mode';
        })
        .catch(function () {
          $('#connection-status').textContent = 'API unavailable';
        }),
    ]).then(function () {
      return refresh();
    }).catch(function (err) {
      toast(err.message);
    });
  })();
})();
