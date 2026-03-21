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
      if (data.connected) {
        showChat(data.user);
      }
    } catch (e) {
      console.error('Auth check failed:', e);
    }
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

    // Validate
    if (!username || !password) {
      showError('Please enter your username and password.');
      return;
    }

    // Show loading
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

      if (res.ok && data.success) {
        showChat(data.user);
      } else {
        showError(data.error || 'Login failed. Please check your credentials.');
      }
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
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch (e) {}
    showLogin();
  });

  // ——————————————————
  // CHAT - Send message
  // ——————————————————
  sendBtn.addEventListener('click', sendMessage);
  userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  async function sendMessage() {
    const message = userInput.value.trim();
    if (!message) return;

    // Add user message
    addMessage(message, 'user');
    userInput.value = '';
    sendBtn.disabled = true;

    // Show typing indicator
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
        addMessage(data.response, 'bot');
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
  // UI Helpers
  // ——————————————————
  function showChat(user) {
    loginSection.classList.add('hidden');
    chatSection.classList.remove('hidden');
    userInfo.classList.remove('hidden');
    if (user) {
      userName.textContent = user.name || user.preferred_username || 'Connected';
    }
  }

  function showLogin() {
    chatSection.classList.add('hidden');
    loginSection.classList.remove('hidden');
    userInfo.classList.add('hidden');
    loginForm.reset();
  }

  function setLoading(loading) {
    loginBtn.disabled = loading;
    loginBtnText.textContent = loading ? 'Connecting...' : 'Connect to Salesforce';
    loginSpinner.classList.toggle('hidden', !loading);
  }

  function showError(msg) {
    loginError.textContent = msg;
    loginError.classList.remove('hidden');
  }

  function hideError() {
    loginError.classList.add('hidden');
  }

  function addMessage(text, type) {
    const div = document.createElement('div');
    div.className = type === 'user' ? 'message-row user-row' : 'message-row bot-row';

    const bubble = document.createElement('div');
    bubble.className = type === 'user' ? 'user-bubble' :
                       type === 'error' ? 'error-bubble' : 'bot-bubble';

    // Convert markdown-style formatting to HTML
    bubble.innerHTML = formatMessage(text);
    div.appendChild(bubble);
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return div;
  }

  function formatMessage(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code>$1</code>')
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
