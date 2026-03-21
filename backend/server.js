require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const session = require('express-session');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'sf-claude-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, '../frontend')));

// ——————————————————————————
// ROUTE: Login with Username + Password + Security Token
// This uses the Salesforce OAuth Username-Password flow (no browser redirect needed)
// ——————————————————————————
app.post('/api/login', async (req, res) => {
  const { username, password, securityToken, orgType } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  // For External Client Apps, use the org My Domain URL
  // For sandbox, use test.salesforce.com
  const loginUrl = orgType === 'sandbox'
    ? 'https://test.salesforce.com'
    : 'https://login.salesforce.com';

  // Append security token to password if provided
  const fullPassword = securityToken ? password + securityToken : password;

  try {
    const tokenRes = await axios.post(
      loginUrl + '/services/oauth2/token',
      new URLSearchParams({
        grant_type: 'password',
        client_id: process.env.SF_CLIENT_ID,
        client_secret: process.env.SF_CLIENT_SECRET,
        username: username,
        password: fullPassword
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, instance_url } = tokenRes.data;

    // Get user info
    const userRes = await axios.get(instance_url + '/services/oauth2/userinfo', {
      headers: { Authorization: 'Bearer ' + access_token }
    });

    req.session.sfAccessToken = access_token;
    req.session.sfInstanceUrl = instance_url;
    req.session.sfUserInfo = userRes.data;

    res.json({
      success: true,
      user: {
        name: userRes.data.name,
        email: userRes.data.email,
        username: userRes.data.preferred_username
      }
    });

  } catch (err) {
    console.error('Login error:', err.response?.data || err.message);
    const sfError = err.response?.data;
    let errorMsg = sfError?.error_description || sfError?.error || err.message;

    // Helpful error messages
    if (errorMsg.includes('INVALID_LOGIN')) {
      errorMsg = 'Invalid username or password. If you have IP restrictions, append your Security Token to the password.';
    } else if (errorMsg.includes('invalid_client')) {
      errorMsg = 'Connected App configuration error. Please contact your admin.';
    }

    res.status(401).json({ error: errorMsg });
  }
});

// ——————————————————————————
// ROUTE: Auth Status
// ——————————————————————————
app.get('/api/auth/status', (req, res) => {
  if (req.session.sfAccessToken) {
    res.json({ connected: true, user: req.session.sfUserInfo });
  } else {
    res.json({ connected: false });
  }
});

// ——————————————————————————
// ROUTE: Logout
// ——————————————————————————
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ——————————————————————————
// ROUTE: Chat
// ——————————————————————————
app.post('/api/chat', async (req, res) => {
  if (!req.session.sfAccessToken) {
    return res.status(401).json({ error: 'Not authenticated with Salesforce' });
  }

  const { message } = req.body;
  const accessToken = req.session.sfAccessToken;
  const instanceUrl = req.session.sfInstanceUrl;

  try {
    let metadataContext = '';

    try {
      const descRes = await axios.get(instanceUrl + '/services/data/v57.0/sobjects/', {
        headers: { Authorization: 'Bearer ' + accessToken }
      });
      const objects = descRes.data.sobjects
        .filter(o => o.queryable && o.createable)
        .slice(0, 30).map(o => o.name).join(', ');
      metadataContext = 'Available Salesforce Objects: ' + objects + '\n\n';

      const matches = message.match(/\b([A-Z][a-zA-Z0-9_]+(?:__c)?)\b/g);
      if (matches) {
        for (const objName of matches.slice(0, 2)) {
          try {
            const objRes = await axios.get(
              instanceUrl + '/services/data/v57.0/sobjects/' + objName + '/describe/',
              { headers: { Authorization: 'Bearer ' + accessToken } }
            );
            const fields = objRes.data.fields.map(f => ({
              name: f.name,
              label: f.label,
              type: f.type,
              required: !f.nillable && !f.defaultedOnCreate
            }));
            metadataContext += 'Object: ' + objName + '\nLabel: ' + objRes.data.label + '\n';
            metadataContext += 'Fields (first 50): ' + JSON.stringify(fields.slice(0, 50), null, 2) + '\n\n';
          } catch (e) { /* skip unknown objects */ }
        }
      }
    } catch (e) {
      console.error('Metadata error:', e.message);
    }

    const claudeRes = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      system: `You are a Salesforce design specification expert. Based on the metadata provided, generate detailed design specs including: object overview, field specs (type/validation/required), UI/UX recommendations, business rules, relationships, and security considerations.

Salesforce Metadata:
${metadataContext}`,
      messages: [{ role: 'user', content: message }]
    });

    res.json({ response: claudeRes.content[0].text });

  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
