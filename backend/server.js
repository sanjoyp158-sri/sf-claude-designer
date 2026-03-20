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

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'sf-claude-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Serve frontend static files
app.use(express.static(path.join(__dirname, '../frontend')));

// ——————————————————————————
// ROUTE: Initiate Salesforce OAuth Login
// ——————————————————————————
app.get('/auth/salesforce', (req, res) => {
  const instanceUrl = req.query.instance_url || 'https://login.salesforce.com';
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SF_CLIENT_ID,
    redirect_uri: process.env.SF_CALLBACK_URL,
    scope: 'api full refresh_token',
    state: encodeURIComponent(instanceUrl)
  });
  const authUrl = instanceUrl + '/services/oauth2/authorize?' + params.toString();
  res.redirect(authUrl);
});

// ——————————————————————————
// ROUTE: OAuth Callback
// ——————————————————————————
app.get('/oauth/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect('/?error=' + encodeURIComponent(error));
  }

  const instanceUrl = decodeURIComponent(state || 'https://login.salesforce.com');

  try {
    const tokenResponse = await axios.post(instanceUrl + '/services/oauth2/token', new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.SF_CLIENT_ID,
      client_secret: process.env.SF_CLIENT_SECRET,
      redirect_uri: process.env.SF_CALLBACK_URL,
      code: code
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const { access_token, instance_url } = tokenResponse.data;

    // Get user info
    const userInfo = await axios.get(instance_url + '/services/oauth2/userinfo', {
      headers: { Authorization: 'Bearer ' + access_token }
    });

    req.session.sfAccessToken = access_token;
    req.session.sfInstanceUrl = instance_url;
    req.session.sfUserInfo = userInfo.data;

    res.redirect('/?connected=true');
  } catch (err) {
    console.error('OAuth callback error:', err.response?.data || err.message);
    res.redirect('/?error=' + encodeURIComponent('Authentication failed: ' + (err.response?.data?.error_description || err.message)));
  }
});

// ——————————————————————————
// ROUTE: Check Auth Status
// ——————————————————————————
app.get('/api/auth/status', (req, res) => {
  if (req.session.sfAccessToken) {
    res.json({
      connected: true,
      user: req.session.sfUserInfo
    });
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
// ROUTE: Chat with Claude
// ——————————————————————————
app.post('/api/chat', async (req, res) => {
  if (!req.session.sfAccessToken) {
    return res.status(401).json({ error: 'Not authenticated with Salesforce' });
  }

  const { message } = req.body;
  const accessToken = req.session.sfAccessToken;
  const instanceUrl = req.session.sfInstanceUrl;

  try {
    // Fetch Salesforce metadata
    let metadataContext = '';

    try {
      // Get list of objects
      const describeResponse = await axios.get(
        instanceUrl + '/services/data/v57.0/sobjects/',
        { headers: { Authorization: 'Bearer ' + accessToken } }
      );

      const objects = describeResponse.data.sobjects
        .filter(obj => obj.queryable && obj.createable)
        .slice(0, 30)
        .map(obj => obj.name)
        .join(', ');

      metadataContext = 'Available Salesforce Objects: ' + objects + '\n\n';

      // If user mentions a specific object, get its details
      const objectMatch = message.match(/\b([A-Z][a-zA-Z0-9_]+(?:__c)?)\b/g);
      if (objectMatch) {
        for (const objName of objectMatch.slice(0, 2)) {
          try {
            const objDescribe = await axios.get(
              instanceUrl + '/services/data/v57.0/sobjects/' + objName + '/describe/',
              { headers: { Authorization: 'Bearer ' + accessToken } }
            );

            const fields = objDescribe.data.fields.map(f => ({
              name: f.name,
              label: f.label,
              type: f.type,
              required: !f.nillable && !f.defaultedOnCreate
            }));

            metadataContext += 'Object: ' + objName + '\n';
            metadataContext += 'Label: ' + objDescribe.data.label + '\n';
            metadataContext += 'Fields: ' + JSON.stringify(fields.slice(0, 50), null, 2) + '\n\n';
          } catch (e) {
            // Object not found or no access, skip
          }
        }
      }
    } catch (metaErr) {
      console.error('Metadata fetch error:', metaErr.message);
      metadataContext = 'Unable to fetch metadata. ';
    }

    // Call Claude
    const systemPrompt = `You are a Salesforce design specification expert. Based on the Salesforce metadata provided, generate detailed, structured design specifications.

When creating design specs include:
- Object overview and purpose
- Field specifications (type, validation, required/optional)
- UI/UX recommendations  
- Business rules and logic
- Relationships and dependencies
- Security considerations

Salesforce Metadata Context:
${metadataContext}`;

    const claudeResponse = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      messages: [{ role: 'user', content: message }],
      system: systemPrompt
    });

    res.json({ response: claudeResponse.content[0].text });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Error processing request: ' + err.message });
  }
});

// ——————————————————————————
// START SERVER
// ——————————————————————————
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
