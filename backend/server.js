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

// SF_LOGIN_URL is the My Domain URL of your Salesforce org
// For External Client Apps, OAuth must go through the org's My Domain URL
// e.g. https://cognizant39.my.salesforce.com
const SF_PROD_URL = process.env.SF_LOGIN_URL || 'https://cognizant39.my.salesforce.com';
const SF_SANDBOX_URL = process.env.SF_SANDBOX_URL || 'https://test.salesforce.com';

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
// ROUTE: Get OAuth URL for popup
// ——————————————————————————
app.get('/auth/url', (req, res) => {
  const orgType = req.query.org_type || 'production';
  // For External Client Apps, MUST use the org's My Domain URL (not login.salesforce.com)
  const loginUrl = orgType === 'sandbox' ? SF_SANDBOX_URL : SF_PROD_URL;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SF_CLIENT_ID,
    redirect_uri: process.env.SF_CALLBACK_URL,
    scope: 'api full refresh_token',
    state: encodeURIComponent(loginUrl)
  });
  res.json({ url: loginUrl + '/services/oauth2/authorize?' + params.toString() });
});

// ——————————————————————————
// ROUTE: OAuth Callback (called after Salesforce login in popup)
// ——————————————————————————
app.get('/oauth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.send(`<!DOCTYPE html><html><body><script>
      window.opener && window.opener.postMessage({
        type: 'SF_AUTH_ERROR',
        error: '${(error_description || error).replace(/'/g, "\\'")}'
      }, '*');
      window.close();
    </script></body></html>`);
  }

  const loginUrl = decodeURIComponent(state || SF_PROD_URL);

  try {
    const tokenRes = await axios.post(
      loginUrl + '/services/oauth2/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.SF_CLIENT_ID,
        client_secret: process.env.SF_CLIENT_SECRET,
        redirect_uri: process.env.SF_CALLBACK_URL,
        code
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

    res.send(`<!DOCTYPE html><html><body><script>
      window.opener && window.opener.postMessage({
        type: 'SF_AUTH_SUCCESS',
        user: ${JSON.stringify({ name: userRes.data.name, email: userRes.data.email })}
      }, '*');
      window.close();
    </script><p>Login successful! Closing...</p></body></html>`);

  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    const msg = (err.response?.data?.error_description || err.message || 'OAuth failed').replace(/'/g, "\'");
    res.send(`<!DOCTYPE html><html><body><script>
      window.opener && window.opener.postMessage({
        type: 'SF_AUTH_ERROR',
        error: '${msg}'
      }, '*');
      window.close();
    </script><p>Login failed. Closing...</p></body></html>`);
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
