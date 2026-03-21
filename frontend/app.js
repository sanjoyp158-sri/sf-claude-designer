// SF Claude Designer - Frontend App Logic

document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const loginSection = document.getElementById('loginSection');
  const chatSection = document.getElementById('chatSection');
  const loginForm = document.getElementById('loginForm');
  const loginError = document.getElementById('loginError');
  const loginBtn = document.getElementById('loginBtn');
  const loginBtnText = document.getElementById('loginBtnText');
  const loginSpinner = document.getElementById('loginSpinner');
  const userInfo = document.getElementById('userInfo');
  const userName = document.getElementById('userName');
  const logoutBtn = document.getElementById('logoutBtn');
  const chatMessages = document.getElementById('chatMessages');
  const userInput = document.getElementById('userInput');
  const sendBtn = document.getElementById('sendBtn');
  const togglePw = document.getElementById('togglePw');
  const sfPassword = document.getElementById('sfPassword');
  const exportWordBtn = document.getElementById('exportWordBtn');
  const exportExcelBtn = document.getElementById('exportExcelBtn');

  // Track last message and response for export
  let lastMessage = '';
  let lastResponse = '';

  // ——————————————————
  // Toggle password visibility
  // ——————————————————
  if (togglePw && sfPassword) {
    togglePw.addEventListener('click', () => {
      sfPassword.type = sfPassword.type === 'password' ? 'text' : 'password';
      togglePw.textContent = sfPassword.type === 'password' ? '👁' : '🔒';
    });
  }

  // ——————————————————
  // Check if already logged in
  // ——————————————————
  checkAuthStatus();

  async function checkAuthStatus() {
    try {
      const res = await fetch('/api/auth/status', { credentials: 'include' });
      const data = await res.json();
      if (data.connected) showChat(data.user);
    } catch (e) { console.error('Auth check failed:', e); }
  }

  // ——————————————————
  // LOGIN FORM SUBMIT
  // ——————————————————
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('sfUsername').value.trim();
    const password = document.getElementById('sfPassword').value;
    const securityToken = document.getElementById('sfToken').value.trim();
    const orgType = document.querySelector('input[name="orgType"]:checked').value;

    if (!username || !password) { showError('Please enter your username and password.'); return; }

    setLoading(true);
    hideError();

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password, securityToken, orgType })
      });
      const data = await res.json();
      if (res.ok && data.success) showChat(data.user);
      else showError(data.error || 'Login failed. Please check your credentials.');
    } catch (err) {
      showError('Network error. Please check if the server is running.');
    } finally {
      setLoading(false);
    }
  });

  // ——————————————————
  // LOGOUT
  // ——————————————————
  logoutBtn.addEventListener('click', async () => {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch (e) {}
    showLogin();
  });

  // ——————————————————
  // CHAT - Send message
  // ——————————————————
  sendBtn.addEventListener('click', sendMessage);
  userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  async function sendMessage() {
    const message = userInput.value.trim();
    if (!message) return;

    addMessage(message, 'user');
    userInput.value = '';
    sendBtn.disabled = true;
    hideExportButtons();

    const typingId = addTyping();

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ message })
      });
      const data = await res.json();
      removeTyping(typingId);

      if (res.ok) {
        lastMessage = message;
        lastResponse = data.response;
        addMessage(data.response, 'bot');
        showExportButtons();
      } else if (res.status === 401) {
        addMessage('Your session expired. Please log in again.', 'error');
        setTimeout(showLogin, 2000);
      } else {
        addMessage('Error: ' + (data.error || 'Something went wrong.'), 'error');
      }
    } catch (err) {
      removeTyping(typingId);
      addMessage('Network error: ' + err.message, 'error');
    } finally {
      sendBtn.disabled = false;
    }
  }

  // ——————————————————
  // EXPORT TO WORD
  // ——————————————————
  if (exportWordBtn) {
    exportWordBtn.addEventListener('click', async () => {
      if (!lastResponse) return;
      exportWordBtn.disabled = true;
      exportWordBtn.textContent = '⏳ Generating...';
      try {
        const res = await fetch('/api/export/word', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ message: lastMessage, content: lastResponse })
        });
        if (res.ok) {
          const blob = await res.blob();
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'SF_Design_Spec_' + new Date().toISOString().slice(0,10) + '.docx';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          window.URL.revokeObjectURL(url);
          addSystemMessage('✅ Word document downloaded successfully!');
        } else {
          const err = await res.json();
          addSystemMessage('❌ Word export failed: ' + err.error);
        }
      } catch (e) {
        addSystemMessage('❌ Export error: ' + e.message);
      } finally {
        exportWordBtn.disabled = false;
        exportWordBtn.textContent = '📄 Export Word';
      }
    });
  }

  // ——————————————————
  // EXPORT TO EXCEL
  // ——————————————————
  if (exportExcelBtn) {
    exportExcelBtn.addEventListener('click', async () => {
      if (!lastResponse) return;
      exportExcelBtn.disabled = true;
      exportExcelBtn.textContent = '⏳ Generating...';
      try {
        const res = await fetch('/api/export/excel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ message: lastMessage, content: lastResponse })
        });
        if (res.ok) {
          const blob = await res.blob();
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'SF_Design_Spec_' + new Date().toISOString().slice(0,10) + '.xlsx';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          window.URL.revokeObjectURL(url);
          addSystemMessage('✅ Excel document downloaded successfully!');
        } else {
          const err = await res.json();
          addSystemMessage('❌ Excel export failed: ' + err.error);
        }
      } catch (e) {
        addSystemMessage('❌ Export error: ' + e.message);
      } finally {
        exportExcelBtn.disabled = false;
        exportExcelBtn.textContent = '📊 Export Excel';
      }
    });
  }

  // ——————————————————
  // UI Helpers
  // ——————————————————
  function showChat(user) {
    loginSection.classList.add('hidden');
    chatSection.classList.remove('hidden');
    userInfo.classList.remove('hidden');
    if (user) userName.textContent = user.name || user.preferred_username || 'Connected';
  }

  function showLogin() {
    chatSection.classList.add('hidden');
    loginSection.classList.remove('hidden');
    userInfo.classList.add('hidden');
    loginForm.reset();
    hideExportButtons();
  }

  function setLoading(loading) {
    loginBtn.disabled = loading;
    loginBtnText.textContent = loading ? 'Connecting...' : 'Connect to Salesforce';
    loginSpinner.classList.toggle('hidden', !loading);
  }

  function showError(msg) { loginError.textContent = msg; loginError.classList.remove('hidden'); }
  function hideError() { loginError.classList.add('hidden'); }

  function showExportButtons() {
    if (exportWordBtn) exportWordBtn.classList.remove('hidden');
    if (exportExcelBtn) exportExcelBtn.classList.remove('hidden');
  }

  function hideExportButtons() {
    if (exportWordBtn) exportWordBtn.classList.add('hidden');
    if (exportExcelBtn) exportExcelBtn.classList.add('hidden');
  }

  function addMessage(text, type) {
    const div = document.createElement('div');
    div.className = type === 'user' ? 'message-row user-row' : 'message-row bot-row';
    const bubble = document.createElement('div');
    bubble.className = type === 'user' ? 'user-bubble' : type === 'error' ? 'error-bubble' : 'bot-bubble';
    bubble.innerHTML = formatMessage(text);
    div.appendChild(bubble);
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return div;
  }

  function addSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'message-row bot-row';
    const bubble = document.createElement('div');
    bubble.className = 'system-bubble';
    bubble.textContent = text;
    div.appendChild(bubble);
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function formatMessage(text) {
    return text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code>$1</code>')
      .replace(/^### (.*$)/gm, '<h4>$1</h4>')
      .replace(/^## (.*$)/gm, '<h3>$1</h3>')
      .replace(/^# (.*$)/gm, '<h2>$1</h2>')
      .replace(/^[-*] (.*$)/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
      .replace(/\n/g, '<br>');
  }

  function addTyping() {
    const id = 'typing-' + Date.now();
    const div = document.createElement('div');
    div.id = id;
    div.className = 'message-row bot-row';
    div.innerHTML = '<div class="bot-bubble typing-indicator"><span></span><span></span><span></span></div>';
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return id;
  }

  function removeTyping(id) { const el = document.getElementById(id); if (el) el.remove(); }
});
