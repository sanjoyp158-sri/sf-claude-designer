// SF Claude Designer - Frontend

const chatMessages = document.getElementById('chatMessages');
const chatInput    = document.getElementById('chatInput');
const sendBtn      = document.getElementById('sendBtn');
const loginBtn     = document.getElementById('loginBtn');
const logoutBtn    = document.getElementById('logoutBtn');
const authStatus   = document.getElementById('authStatus');
const userInfo     = document.getElementById('userInfo');
const orgModal     = document.getElementById('orgModal');
const loginStatus  = document.getElementById('loginStatus');

let isConnected = false;
let authPopup = null;

// ——————————————————————————
// Auth State
// ——————————————————————————
async function checkAuthStatus() {
  try {
    const res = await fetch('/api/auth/status', { credentials: 'include' });
    const data = await res.json();
    data.connected ? setConnected(data.user) : setDisconnected();
  } catch {
    setDisconnected();
  }
}

function setConnected(user) {
  isConnected = true;
  loginBtn.style.display = 'none';
  logoutBtn.style.display = 'inline-block';
  authStatus.textContent = '● Connected';
  authStatus.className = 'auth-status connected';
  userInfo.textContent = user?.name || user?.email || 'Salesforce User';
  userInfo.style.display = 'block';
  chatInput.disabled = false;
  sendBtn.disabled = false;
  chatInput.placeholder = 'Ask about any Salesforce object to get design specs...';
  loginStatus.style.display = 'none';
}

function setDisconnected() {
  isConnected = false;
  loginBtn.style.display = 'inline-block';
  logoutBtn.style.display = 'none';
  authStatus.textContent = '● Not connected';
  authStatus.className = 'auth-status disconnected';
  userInfo.style.display = 'none';
  chatInput.disabled = true;
  sendBtn.disabled = true;
  chatInput.placeholder = 'Login to Salesforce to start chatting...';
}

// ——————————————————————————
// Login via Popup
// ——————————————————————————
loginBtn.addEventListener('click', () => {
  orgModal.style.display = 'flex';
});

orgModal.addEventListener('click', e => {
  if (e.target === orgModal) orgModal.style.display = 'none';
});

async function openSalesforceLogin(orgType) {
  orgModal.style.display = 'none';

  // Get the OAuth URL from server
  const res = await fetch('/auth/url?org_type=' + orgType);
  const { url } = await res.json();

  // Open Salesforce login in a popup window
  const w = 600, h = 700;
  const left = (screen.width - w) / 2;
  const top = (screen.height - h) / 2;
  authPopup = window.open(url, 'sf_login',
    'width=' + w + ',height=' + h + ',left=' + left + ',top=' + top +
    ',toolbar=no,menubar=no,scrollbars=yes,resizable=yes'
  );

  // Show waiting status
  loginStatus.style.display = 'flex';
  loginStatus.innerHTML = '<div class="spinner"></div><span>Waiting for Salesforce login...</span>';

  // Poll for popup close as fallback
  const pollTimer = setInterval(async () => {
    if (authPopup && authPopup.closed) {
      clearInterval(pollTimer);
      // Check if login succeeded
      const statusRes = await fetch('/api/auth/status', { credentials: 'include' });
      const status = await statusRes.json();
      if (status.connected) {
        setConnected(status.user);
        addMessage('assistant', '✅ Successfully connected to Salesforce as ' + (status.user?.name || status.user?.email) + '!\n\nYou can now ask me to generate design specs. Try: "Generate a design spec for the Account object"');
      } else {
        loginStatus.style.display = 'none';
        addMessage('assistant', '❌ Login was not completed. Please try again.');
      }
    }
  }, 1000);
}

// Listen for message from popup after OAuth callback
window.addEventListener('message', async (event) => {
  if (event.data?.type === 'SF_AUTH_SUCCESS') {
    if (authPopup) authPopup.close();
    const statusRes = await fetch('/api/auth/status', { credentials: 'include' });
    const status = await statusRes.json();
    if (status.connected) {
      setConnected(status.user);
      addMessage('assistant', '✅ Successfully connected to Salesforce as ' + (status.user?.name || status.user?.email) + '!\n\nYou can now ask me to generate design specs. Try: "Generate a design spec for the Account object"');
    }
  }
  if (event.data?.type === 'SF_AUTH_ERROR') {
    if (authPopup) authPopup.close();
    loginStatus.style.display = 'none';
    addMessage('assistant', '❌ Login failed: ' + event.data.error);
  }
});

// Org type buttons
document.getElementById('btnProduction').addEventListener('click', () => openSalesforceLogin('production'));
document.getElementById('btnSandbox').addEventListener('click', () => openSalesforceLogin('sandbox'));
document.getElementById('cancelOrgModal').addEventListener('click', () => { orgModal.style.display = 'none'; });

// ——————————————————————————
// Logout
// ——————————————————————————
logoutBtn.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  setDisconnected();
  addMessage('assistant', 'Logged out from Salesforce.');
});

// ——————————————————————————
// Chat
// ——————————————————————————
async function sendMessage() {
  const msg = chatInput.value.trim();
  if (!msg || !isConnected) return;
  chatInput.value = '';
  addMessage('user', msg);
  const typingId = addMessage('assistant', '', true);

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ message: msg })
    });
    const data = await res.json();
    removeMessage(typingId);
    addMessage('assistant', data.error ? '❌ ' + data.error : data.response);
  } catch {
    removeMessage(typingId);
    addMessage('assistant', '❌ Server error. Is the server running?');
  }
}

sendBtn.addEventListener('click', sendMessage);
chatInput.addEventListener('keypress', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

function addMessage(role, content, isTyping = false) {
  const id = 'msg-' + Date.now() + Math.random();
  const div = document.createElement('div');
  div.className = 'message ' + role;
  div.id = id;
  div.innerHTML = isTyping
    ? '<div class="typing"><span></span><span></span><span></span></div>'
    : '<div class="bubble">' + fmt(content) + '</div>';
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return id;
}

function removeMessage(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

function fmt(t) {
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,'<em>$1</em>')
    .replace(/`(.+?)`/g,'<code>$1</code>')
    .replace(/\n/g,'<br>');
}

// Init
checkAuthStatus();
addMessage('assistant', 'Welcome to SF Claude Designer! Click "Login to Salesforce" to connect your org.');
