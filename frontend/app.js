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
  const exportRow = document.getElementById('exportRow');

  // Track last message and response for export
  let lastMessage = '';
  let lastResponse = '';
  let semanticPending = false; // true when waiting for user Yes/No on semantic warning

  // ——————————————
  // AUTO-EXPAND TEXTAREA
  // Grows as user types, up to max-height (set in CSS as 300px)
  // Also allows manual drag-resize via CSS resize:vertical
  // ——————————————
  function autoExpandTextarea() {
    // Reset height so scrollHeight is accurate
    userInput.style.height = 'auto';
    // Set height to match content (capped by CSS max-height)
    const newHeight = Math.min(userInput.scrollHeight, 300);
    userInput.style.height = newHeight + 'px';
  }

  if (userInput) {
    userInput.addEventListener('input', autoExpandTextarea);
    // Also handle paste events
    userInput.addEventListener('paste', () => {
      setTimeout(autoExpandTextarea, 0);
    });
  }

  // ——————————————
  // Toggle password visibility
  // ——————————————
  if (togglePw && sfPassword) {
    togglePw.addEventListener('click', () => {
      sfPassword.type = sfPassword.type === 'password' ? 'text' : 'password';
      togglePw.textContent = sfPassword.type === 'password' ? '\uD83D\uDC41' : '\uD83D\uDD12';
    });
  }

  // ——————————————
  // Check if already logged in
  // ——————————————
  checkAuthStatus();
  async function checkAuthStatus() {
    try {
      const res = await fetch('/api/auth/status', { credentials: 'include' });
      const data = await res.json();
      if (data.connected) showChat(data.user);
    } catch (e) { console.error('Auth check failed:', e); }
  }

  // ——————————————
  // LOGIN FORM SUBMIT
  // ——————————————
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

  // ——————————————
  // LOGOUT
  // ——————————————
  logoutBtn.addEventListener('click', async () => {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch (e) {}
    showLogin();
  });

  // ——————————————
  // CHAT - Send message
  // ——————————————
  sendBtn.addEventListener('click', sendMessage);
  userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  async function sendMessage() {
    const message = userInput.value.trim();
    if (!message) return;
    addMessage(message, 'user');
    userInput.value = '';
    userInput.style.height = 'auto';
    sendBtn.disabled = true;
    hideExportButtons();
    hideSemanticButtons();
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
        if (data.isSemantic) {
          semanticPending = true;
          showSemanticButtons();
        } else if (data.isSemanticResolved || data.isConflict) {
          semanticPending = false;
          hideSemanticButtons();
        } else {
          semanticPending = false;
          showExportButtons();
          if (data.exportIntent && data.exportIntent.isWord) {
            addSystemMessage('\uD83D\uDCC4 Generating your Word document...');
            await triggerExport('word');
          } else if (data.exportIntent && data.exportIntent.isExcel) {
            addSystemMessage('\uD83D\uDCCA Generating your Excel file...');
            await triggerExport('excel');
          }
        }
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

  // ——————————————
  // SHARED EXPORT FUNCTION
  // ——————————————
  async function triggerExport(type) {
    const endpoint = type === 'word' ? '/api/export/word' : '/api/export/excel';
    const ext = type === 'word' ? 'docx' : 'xlsx';
    const btn = type === 'word' ? exportWordBtn : exportExcelBtn;

    if (btn) { btn.disabled = true; btn.textContent = '\u23F3 Generating...'; }

    try {
      const res = await fetch(endpoint, {
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
        a.download = 'SF_Design_Spec_' + new Date().toISOString().slice(0, 10) + '.' + ext;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        addSystemMessage('\u2705 ' + (type === 'word' ? 'Word document' : 'Excel file') + ' downloaded successfully!');
      } else {
        const err = await res.json();
        addSystemMessage('\u274C Export failed: ' + err.error);
      }
    } catch (e) {
      addSystemMessage('\u274C Export error: ' + e.message);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = type === 'word' ? '\uD83D\uDCC4 Export Word' : '\uD83D\uDCCA Export Excel';
      }
    }
  }


  // ——————————————
  // Semantic Yes/No handlers
  // ——————————————
  const semanticYesBtn = document.getElementById('semanticYesBtn');
  const semanticNoBtn = document.getElementById('semanticNoBtn');

  async function sendSemanticAnswer(answer) {
    hideSemanticButtons();
    hideExportButtons();
    semanticPending = false;
    const typingId = addTyping();
    sendBtn.disabled = true;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ message: '', semanticAnswer: answer })
      });
      const data = await res.json();
      removeTyping(typingId);
      if (res.ok) {
        lastResponse = data.response;
        addMessage(data.response, 'bot');
        if (!data.isSemanticResolved && data.exportIntent) {
          if (data.exportIntent.isWord) {
            showExportButtons();
            addSystemMessage('\uD83D\uDCC4 Generating your Word document...');
            await triggerExport('word');
          } else if (data.exportIntent.isExcel) {
            showExportButtons();
            addSystemMessage('\uD83D\uDCCA Generating your Excel file...');
            await triggerExport('excel');
          } else {
            showExportButtons();
          }
        }
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

  if (semanticYesBtn) semanticYesBtn.addEventListener('click', () => sendSemanticAnswer('yes'));
  if (semanticNoBtn) semanticNoBtn.addEventListener('click', () => sendSemanticAnswer('no'));

  // Export buttons (manual click)
  if (exportWordBtn) {
    exportWordBtn.addEventListener('click', async () => {
      if (!lastResponse) return;
      await triggerExport('word');
    });
  }

  if (exportExcelBtn) {
    exportExcelBtn.addEventListener('click', async () => {
      if (!lastResponse) return;
      await triggerExport('excel');
    });
  }

  // ——————————————
  // UI Helpers
  // ——————————————
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
    if (exportRow) exportRow.classList.remove('hidden');
  }

  function hideExportButtons() {
    if (exportWordBtn) exportWordBtn.classList.add('hidden');
    if (exportExcelBtn) exportExcelBtn.classList.add('hidden');
    if (exportRow) exportRow.classList.add('hidden');
  }

  function showSemanticButtons() {
    const semRow = document.getElementById('semanticRow');
    if (semRow) semRow.classList.remove('hidden');
  }
  function hideSemanticButtons() {
    const semRow = document.getElementById('semanticRow');
    if (semRow) semRow.classList.add('hidden');
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

  function removeTyping(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }
});
