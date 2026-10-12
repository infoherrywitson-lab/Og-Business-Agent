/**
 * Auth page: first-run workspace setup and sign-in.
 * Mode is driven by /api/auth/state — setup is offered only while the
 * workspace has no users.
 */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var form = $('auth-form');
  var tabs = $('auth-tabs');
  var message = $('auth-message');
  var submitBtn = $('auth-submit');
  var mode = 'signin';
  var setupAvailable = false;

  function returnTo() {
    var raw = new URLSearchParams(window.location.search).get('returnTo') || '/app';
    if (raw.charAt(0) !== '/' || raw.charAt(1) === '/' || raw.indexOf('\\') !== -1) return '/app';
    return raw;
  }

  function showMessage(text, isError) {
    message.textContent = text || '';
    message.classList.toggle('error', isError !== false);
    message.classList.toggle('ok', isError === false);
  }

  function render() {
    var isSetup = mode === 'setup';
    $('field-name').hidden = !isSetup;
    $('password-hint').hidden = !isSetup;
    $('auth-name').required = isSetup;
    $('auth-password').setAttribute('autocomplete', isSetup ? 'new-password' : 'current-password');
    $('auth-kicker').textContent = isSetup ? 'FIRST RUN' : 'WELCOME BACK';
    $('auth-title').textContent = isSetup ? 'Create your workspace' : 'Sign in to your command center';
    $('auth-sub').textContent = isSetup
      ? 'The first account becomes the workspace admin and can invite the rest of the team.'
      : 'Use your workspace email and password.';
    submitBtn.textContent = isSetup ? 'Create workspace →' : 'Sign in';
    showMessage('');

    var buttons = tabs.querySelectorAll('button');
    buttons.forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
    });

    var alt = $('auth-alt');
    if (setupAvailable && !isSetup) {
      alt.hidden = false;
      alt.textContent = 'This workspace has no users yet — switch to “Create workspace” to get started.';
    } else if (!setupAvailable && isSetup) {
      alt.hidden = false;
      alt.textContent = 'This workspace is already set up. Sign in instead, or ask an admin for an invite.';
    } else {
      alt.hidden = true;
      alt.textContent = '';
    }
  }

  tabs.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.getAttribute) return;
    var requested = target.getAttribute('data-mode');
    if (!requested) return;
    if (requested === 'setup' && !setupAvailable) return;
    mode = requested;
    render();
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var email = $('auth-email').value.trim().toLowerCase();
    var password = $('auth-password').value;
    var name = $('auth-name').value.trim();

    if (!email || !password) {
      showMessage('Enter your email and password.');
      return;
    }
    if (mode === 'setup' && password.length < 10) {
      showMessage('Password must be at least 10 characters long.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = mode === 'setup' ? 'Creating…' : 'Signing in…';
    showMessage('');

    var payload = mode === 'setup'
      ? { email: email, password: password, name: name }
      : { email: email, password: password };
    var endpoint = mode === 'setup' ? '/api/auth/setup' : '/api/auth/login';

    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || 'Sign-in failed (' + res.status + ').');
          return data;
        });
      })
      .then(function () {
        window.location.assign(returnTo());
      })
      .catch(function (err) {
        showMessage(err.message || 'Something went wrong.');
        submitBtn.disabled = false;
        submitBtn.textContent = mode === 'setup' ? 'Create workspace →' : 'Sign in';
      });
  });

  fetch('/api/auth/state', { headers: { 'X-Requested-With': 'fetch' } })
    .then(function (res) { return res.json(); })
    .then(function (state) {
      setupAvailable = Boolean(state && state.setupRequired);
      var requestedSetup = new URLSearchParams(window.location.search).get('mode') === 'setup';
      mode = setupAvailable ? 'setup' : 'signin';
      tabs.hidden = !setupAvailable;
      if (!setupAvailable && requestedSetup) {
        $('auth-alt').hidden = false;
      }
      render();
    })
    .catch(function () {
      tabs.hidden = true;
      render();
      showMessage('Could not reach the server. Refresh to retry.');
    });
})();
