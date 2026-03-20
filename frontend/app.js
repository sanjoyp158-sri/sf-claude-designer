// ============================================
// SF Claude Designer - Frontend App Logic
// ============================================

const API_BASE = window.location.origin;

// State
let conversationHistory = [];
let isLoading = false;

// ─────────────────────────────────────────────
// INITIALIZATION
// ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Configure marked.js
  marked.setOptions({
    highlight: (code, lang) => {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
    breaks: true,
    gfm: true,
  });

  // Check if already connected
  await checkConnection();
});

// ─────────────────────────────────────────────
// CHECK EXISTING SESSION
// ─────────────────────────────────────────────
async function checkConnection() {
  try {
    const res = await fetch(`${API_BASE}/api/sf/status`, { credentials: 'include' });
    const data = await res.json();
    if (data.connected) {
      showMainApp(data.username, data.instance_url);
    }
  } catch (e) {
    console.log('No existing session');
  }
}

// ─────────────────────────────────────────────
// LOGIN HANDLER
// ─────────────────────────────────────────────
async function handleLogin() {
  const username = document.getElementById('sfUsername').value.trim();
  const password = document.getElementById('sfPassword').value;
  const securityToken = document.getElementById('sfToken').value.trim();
  const isSandbox = document.getElementById('isSandbox').checked;
  const errorEl = document.getElementById('loginError');
  const btnText = document.getElementById('loginBtnText');
  const spinner = document.getElementById('loginSpinner');
  const btn = document.getElementById('loginBtn');

  // Validate
  if (!username || !password) {
    showLoginError('Please enter your username and password.');
    return;
  }

  // Show loading
  errorEl.classList.add('hidden');
  btn.disabled = true;
  btnText.textContent = 'Connecting...';
  spinner.classList.remove('hidden');

  try {
    const res = await fetch(`${API_BASE}/api/sf/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password, securityToken, isSandbox }),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Login failed');
    }

    showMainApp(data.username, data.instance_url);

  } catch (err) {
    showLoginError(err.message);
  } finally {
    btn.disabled = false;
    btnText.textContent = 'Connect to Salesforce';
    spinner.classList.add('hidden');
  }
}

function showLoginError(msg) {
  const errorEl = document.getElementById('loginError');
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
}

// ─────────────────────────────────────────────
// SHOW MAIN APP
// ─────────────────────────────────────────────
function showMainApp(username, instanceUrl) {
  document.getElementById('loginModal').classList.remove('active');
  document.getElementById('mainApp').classList.remove('hidden');
  document.getElementById('connectedUser').textContent = username;
  conversationHistory = [];
}

// ─────────────────────────────────────────────
// LOGOUT HANDLER
// ─────────────────────────────────────────────
async function handleLogout() {
  try {
    await fetch(`${API_BASE}/api/sf/logout`, { method: 'POST', credentials: 'include' });
  } catch (e) {}
  document.getElementById('mainApp').classList.add('hidden');
  document.getElementById('loginModal').classList.add('active');
  document.getElementById('sfPassword').value = '';
  document.getElementById('sfToken').value = '';
  document.getElementById('loginError').classList.add('hidden');
  conversationHistory = [];
  document.getElementById('chatMessages').innerHTML = getWelcomeHTML();
}

// ─────────────────────────────────────────────
// LOAD SALESFORCE OBJECTS
// ─────────────────────────────────────────────
async function loadObjects() {
  const container = document.getElementById('objectsList');
  container.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px 0;">Loading...</div>';

  try {
    const res = await fetch(`${API_BASE}/api/sf/objects`, { credentials: 'include' });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error);

    const objects = data.objects.sort((a, b) => a.label.localeCompare(b.label));

    container.innerHTML = objects.map(obj => `
      <div class="object-item ${obj.custom ? 'custom' : ''}" onclick="insertPrompt('Generate a design spec for the ${obj.name} object')">
        ${obj.label} ${obj.custom ? '⚡' : ''}
      </div>
    `).join('');

  } catch (err) {
    container.innerHTML = `<div style="color:var(--error);font-size:12px;">${err.message}</div>`;
  }
}

// ─────────────────────────────────────────────
// SEND MESSAGE
// ─────────────────────────────────────────────
async function sendMessage() {
  if (isLoading) return;

  const input = document.getElementById('chatInput');
  const message = input.value.trim();
  if (!message) return;

  // Clear input
  input.value = '';
  input.style.height = 'auto';

  // Add user message to UI
  appendMessage('user', message);

  // Add to conversation history
  conversationHistory.push({ role: 'user', content: message });

  // Show thinking indicator
  const thinkingId = showThinking();

  isLoading = true;
  document.getElementById('sendBtn').disabled = true;

  try {
    const res = await fetch(`${API_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        message,
        conversationHistory: conversationHistory.slice(-10), // last 10 messages
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Chat failed');
    }

    // Remove thinking indicator
    removeThinking(thinkingId);

    // Add assistant response
    appendMessage('assistant', data.response, data.objectsAnalyzed);

    // Add to conversation history
    conversationHistory.push({ role: 'assistant', content: data.response });

  } catch (err) {
    removeThinking(thinkingId);
    appendMessage('assistant', `❌ **Error:** ${err.message}`);
  } finally {
    isLoading = false;
    document.getElementById('sendBtn').disabled = false;
  }
}

// ─────────────────────────────────────────────
// APPEND MESSAGE TO CHAT
// ─────────────────────────────────────────────
function appendMessage(role, content, objectsAnalyzed) {
  const messagesEl = document.getElementById('chatMessages');

  // Remove welcome message if it exists
  const welcome = messagesEl.querySelector('.welcome-message');
  if (welcome) welcome.remove();

  const isUser = role === 'user';
  const avatarContent = isUser ? 'You' : '🤖';
  const label = isUser ? 'You' : 'Claude AI';

  const renderedContent = isUser
    ? escapeHtml(content).replace(/\n/g, '<br>')
    : marked.parse(content);

  const objectBadges = objectsAnalyzed
    ? `<div class="objects-analyzed">Analyzed: ${objectsAnalyzed.map(o => `<span>${o}</span>`).join('')}</div>`
    : '';

  const messageEl = document.createElement('div');
  messageEl.className = `message ${isUser ? 'user-message' : 'assistant-message'}`;
  messageEl.innerHTML = `
    <div class="message-avatar ${isUser ? 'user-avatar' : 'assistant-avatar'}">${avatarContent}</div>
    <div class="message-content">
      <div class="message-label">${label}</div>
      <div class="message-bubble">${renderedContent}</div>
      ${objectBadges}
    </div>
  `;

  messagesEl.appendChild(messageEl);

  // Highlight code blocks
  messageEl.querySelectorAll('pre code').forEach(block => hljs.highlightElement(block));

  // Scroll to bottom
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ─────────────────────────────────────────────
// THINKING INDICATOR
// ─────────────────────────────────────────────
function showThinking() {
  const messagesEl = document.getElementById('chatMessages');
  const id = 'thinking-' + Date.now();
  const el = document.createElement('div');
  el.id = id;
  el.className = 'message assistant-message';
  el.innerHTML = `
    <div class="message-avatar assistant-avatar">🤖</div>
    <div class="message-content">
      <div class="message-label">Claude AI</div>
      <div class="message-bubble">
        <div class="thinking-indicator">
          Analyzing Salesforce metadata
          <div class="thinking-dots">
            <span></span><span></span><span></span>
          </div>
        </div>
      </div>
    </div>
  `;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return id;
}

function removeThinking(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

// ─────────────────────────────────────────────
// KEYBOARD HANDLING
// ─────────────────────────────────────────────
function handleKeyDown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

// ─────────────────────────────────────────────
// INSERT QUICK PROMPT
// ─────────────────────────────────────────────
function insertPrompt(text) {
  const input = document.getElementById('chatInput');
  input.value = text;
  input.focus();
  autoResize(input);
}

// ─────────────────────────────────────────────
// AUTO-RESIZE TEXTAREA
// ─────────────────────────────────────────────
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

// ─────────────────────────────────────────────
// HTML ESCAPE
// ─────────────────────────────────────────────
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────
// WELCOME HTML
// ─────────────────────────────────────────────
function getWelcomeHTML() {
  return `
    <div class="welcome-message">
      <div class="welcome-icon">🤖</div>
      <h2>Welcome to SF Claude Designer!</h2>
      <p>I'm connected to your Salesforce org. Ask me anything about your objects, fields, or request a design specification.</p>
      <div class="example-questions">
        <p><strong>Try asking:</strong></p>
        <ul>
          <li>"Generate a complete design spec for the Account object"</li>
          <li>"What are all the fields on the Opportunity object?"</li>
          <li>"Describe the relationship between Account, Contact and Opportunity"</li>
          <li>"What custom objects exist in my org?"</li>
        </ul>
      </div>
    </div>
  `;
}
