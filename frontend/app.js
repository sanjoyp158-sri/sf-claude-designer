// SF Claude Designer - Frontend App

const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const loginModal = document.getElementById('loginModal');
const authStatus = document.getElementById('authStatus');
const userInfo = document.getElementById('userInfo');

let isConnected = false;

async function checkAuthStatus() {
  try {
    const response = await fetch('/api/auth/status', { credentials: 'include' });
    const data = await response.json();
    if (data.connected) {
      setConnected(data.user);
    } else {
      setDisconnected();
    }
  } catch (err) {
    setDisconnected();
  }
}

function setConnected(user) {
  isConnected = true;
  loginBtn.style.display = 'none';
  logoutBtn.style.display = 'inline-block';
  authStatus.textContent = 'Connected to Salesforce';
  authStatus.className = 'auth-status connected';
  if (user) {
    userInfo.textContent = user.name || user.email || 'Salesforce User';
    userInfo.style.display = 'block';
  }
  chatInput.disabled = false;
  sendBtn.disabled = false;
  chatInput.placeholder = 'Ask about Salesforce objects, metadata, design specs...';

  const params = new URLSearchParams(window.location.search);
  if (params.get('connected') === 'true') {
    addMessage('assistant', '✅ Successfully connected to Salesforce! You can now ask me to generate design specs for any Salesforce object.\n\nTry asking: "Generate a design spec for the Account object"');
    window.history.replaceState({}, '', '/');
  }
}

function setDisconnected() {
  isConnected = false;
  loginBtn.style.display = 'inline-block';
  logoutBtn.style.display = 'none';
  authStatus.textContent = 'Not connected';
  authStatus.className = 'auth-status disconnected';
  userInfo.style.display = 'none';
  chatInput.disabled = true;
  sendBtn.disabled = true;
  chatInput.placeholder = 'Login to Salesforce to start chatting...';

  const params = new URLSearchParams(window.location.search);
  const error = params.get('error');
  if (error) {
    addMessage('assistant', '❌ Login failed: ' + decodeURIComponent(error) + '\n\nPlease try again.');
    window.history.replaceState({}, '', '/');
  }
}

loginBtn.addEventListener('click', () => {
  loginModal.style.display = 'flex';
});

loginModal.addEventListener('click', (e) => {
  if (e.target === loginModal) loginModal.style.display = 'none';
});

document.addEventListener('click', (e) => {
  // Production org button
  if (e.target.id === 'btnProduction') {
    loginModal.style.display = 'none';
    window.location.href = '/auth/salesforce?org_type=production';
  }
  // Sandbox org button
  if (e.target.id === 'btnSandbox') {
    loginModal.style.display = 'none';
    window.location.href = '/auth/salesforce?org_type=sandbox';
  }
  // Custom domain button
  if (e.target.id === 'btnCustomDomain') {
    const customUrl = document.getElementById('customDomainInput').value.trim();
    if (!customUrl) {
      alert('Please enter your org domain URL');
      return;
    }
    // Ensure it starts with https://
    const url = customUrl.startsWith('http') ? customUrl : 'https://' + customUrl;
    loginModal.style.display = 'none';
    window.location.href = '/auth/salesforce?org_type=custom&instance_url=' + encodeURIComponent(url);
  }
  if (e.target.id === 'cancelLogin') {
    loginModal.style.display = 'none';
  }
});

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  setDisconnected();
  addMessage('assistant', 'Logged out from Salesforce.');
});

async function sendMessage() {
  const message = chatInput.value.trim();
  if (!message || !isConnected) return;

  chatInput.value = '';
  addMessage('user', message);
  const typingId = addMessage('assistant', '...', true);

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ message })
    });

    const data = await response.json();
    removeMessage(typingId);

    if (data.error) {
      addMessage('assistant', '❌ Error: ' + data.error);
    } else {
      addMessage('assistant', data.response);
    }
  } catch (err) {
    removeMessage(typingId);
    addMessage('assistant', '❌ Error: Could not connect to server.');
  }
}

function addMessage(role, content, isTyping = false) {
  const id = 'msg-' + Date.now() + '-' + Math.random();
  const msgDiv = document.createElement('div');
  msgDiv.className = 'message ' + role;
  msgDiv.id = id;
  if (isTyping) {
    msgDiv.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
  } else {
    msgDiv.innerHTML = '<div class="message-content">' + formatMessage(content) + '</div>';
  }
  chatMessages.appendChild(msgDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return id;
}

function removeMessage(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

function formatMessage(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

sendBtn.addEventListener('click', sendMessage);
chatInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

checkAuthStatus();
addMessage('assistant', 'Welcome to SF Claude Designer! Click "Login to Salesforce" to connect your org and start generating design specs.');
