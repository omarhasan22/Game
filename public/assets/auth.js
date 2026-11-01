// Teacher pages: show the login form until the teacher is logged in, then call onReady().
async function requireLogin(onReady) {
  const main = $('#main'), login = $('#login');
  const show = admin => {
    main.classList.toggle('hidden', !admin);
    login.classList.toggle('hidden', admin);
    $('#logoutBtn').classList.toggle('hidden', !admin);
  };
  const me = await api('/api/me').catch(() => ({ admin: false }));
  show(me.admin);
  if (me.admin) onReady();
  else $('#password').focus();

  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('#loginError').textContent = '';
    try {
      await api('/api/login', { method: 'POST', body: { password: $('#password').value } });
      $('#password').value = '';
      show(true);
      onReady();
    } catch (err) {
      $('#loginError').textContent = err.message;
    }
  });
  $('#logoutBtn').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    location.reload();
  });
}

// Any request that comes back 401 means the session ended: go back to the login form.
function handleAuthError(err) {
  if (err.status === 401) { location.reload(); return true; }
  toast(err.message);
  return false;
}

const LOGIN_HTML = `
<section class="page hidden" id="login" style="max-width:400px;padding-top:10vh">
  <form class="card" id="loginForm">
    <h1>Teacher login</h1>
    <div class="field">
      <label for="password">Password</label>
      <input type="password" id="password" autocomplete="current-password" required>
    </div>
    <div class="error-text" id="loginError" role="alert"></div>
    <button class="btn primary" style="width:100%">Log in</button>
  </form>
</section>`;
document.currentScript.insertAdjacentHTML('afterend', LOGIN_HTML);
