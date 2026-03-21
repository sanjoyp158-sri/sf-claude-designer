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
// HELPER: Login via Salesforce SOAP API
// No Connected App needed — uses username + password + security token only
// ——————————————————————————
async function soapLogin(username, password, securityToken, orgType) {
  const loginUrl = orgType === 'sandbox'
    ? 'https://test.salesforce.com'
    : 'https://login.salesforce.com';

  const fullPassword = securityToken ? password + securityToken : password;

  const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:urn="urn:partner.soap.sforce.com">
  <soapenv:Body>
    <urn:login>
      <urn:username>${username}</urn:username>
      <urn:password>${fullPassword}</urn:password>
    </urn:login>
  </soapenv:Body>
</soapenv:Envelope>`;

  const response = await axios.post(
    loginUrl + '/services/Soap/u/57.0',
    soapBody,
    {
      headers: {
        'Content-Type': 'text/xml',
        'SOAPAction': 'login'
      }
    }
  );

  const xml = response.data;

  // Check for SOAP fault (login error)
  if (xml.includes('<faultstring>')) {
    const faultMatch = xml.match(/<faultstring>(.*?)<\/faultstring>/s);
    const fault = faultMatch ? faultMatch[1].trim() : 'Login failed';
    throw new Error(fault);
  }

  // Extract sessionId and serverUrl
  const sessionMatch = xml.match(/<sessionId>(.*?)<\/sessionId>/);
  const serverUrlMatch = xml.match(/<serverUrl>(.*?)<\/serverUrl>/);
  const userIdMatch = xml.match(/<userId>(.*?)<\/userId>/);
  const userFullNameMatch = xml.match(/<userFullName>(.*?)<\/userFullName>/);
  const userEmailMatch = xml.match(/<userEmail>(.*?)<\/userEmail>/);

  if (!sessionMatch || !serverUrlMatch) {
    throw new Error('Could not parse Salesforce login response');
  }

  const sessionId = sessionMatch[1];
  const serverUrl = serverUrlMatch[1];

  // Extract instance URL from serverUrl (e.g. https://cognizant39.my.salesforce.com/services/Soap/...)
  const instanceUrl = serverUrl.match(/^(https:\/\/[^\/]+)/)[1];

  return {
    access_token: sessionId,
    instance_url: instanceUrl,
    user_id: userIdMatch ? userIdMatch[1] : null,
    user_name: userFullNameMatch ? userFullNameMatch[1] : username,
    user_email: userEmailMatch ? userEmailMatch[1] : ''
  };
}

// ——————————————————————————
// ROUTE: Login
// ——————————————————————————
app.post('/api/login', async (req, res) => {
  const { username, password, securityToken, orgType } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  try {
    const loginResult = await soapLogin(username, password, securityToken || '', orgType || 'production');

    req.session.sfAccessToken = loginResult.access_token;
    req.session.sfInstanceUrl = loginResult.instance_url;
    req.session.sfUserInfo = {
      name: loginResult.user_name,
      email: loginResult.user_email,
      preferred_username: username
    };

    res.json({
      success: true,
      user: {
        name: loginResult.user_name,
        email: loginResult.user_email,
        username: username
      }
    });

  } catch (err) {
    console.error('Login error:', err.message);
    let errorMsg = err.message;

    if (errorMsg.includes('INVALID_LOGIN')) {
      errorMsg = 'Invalid username or password. If your IP is not trusted, append your Security Token to the password field.';
    } else if (errorMsg.includes('LOGIN_MUST_USE_SECURITY_TOKEN')) {
      errorMsg = 'Your IP address is not trusted. Please enter your Security Token in the field below.';
    } else if (errorMsg.includes('INVALID_SESSION_ID')) {
      errorMsg = 'Session expired. Please log in again.';
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
