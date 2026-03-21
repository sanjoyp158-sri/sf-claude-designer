require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const session = require('express-session');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle, Table, TableRow, TableCell, WidthType, ShadingType } = require('docx');
const ExcelJS = require('exceljs');

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
// HELPER: SOAP Login
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
    { headers: { 'Content-Type': 'text/xml', 'SOAPAction': 'login' } }
  );

  const xml = response.data;
  if (xml.includes('<faultstring>')) {
    const faultMatch = xml.match(/<faultstring>(.*?)<\/faultstring>/s);
    throw new Error(faultMatch ? faultMatch[1].trim() : 'Login failed');
  }

  const sessionMatch = xml.match(/<sessionId>(.*?)<\/sessionId>/);
  const serverUrlMatch = xml.match(/<serverUrl>(.*?)<\/serverUrl>/);
  const userFullNameMatch = xml.match(/<userFullName>(.*?)<\/userFullName>/);
  const userEmailMatch = xml.match(/<userEmail>(.*?)<\/userEmail>/);

  if (!sessionMatch || !serverUrlMatch) throw new Error('Could not parse login response');

  const instanceUrl = serverUrlMatch[1].match(/^(https:\/\/[^\/]+)/)[1];

  return {
    access_token: sessionMatch[1],
    instance_url: instanceUrl,
    user_name: userFullNameMatch ? userFullNameMatch[1] : username,
    user_email: userEmailMatch ? userEmailMatch[1] : ''
  };
}

// ——————————————————————————
// ROUTE: Login
// ——————————————————————————
app.post('/api/login', async (req, res) => {
  const { username, password, securityToken, orgType } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

  try {
    const loginResult = await soapLogin(username, password, securityToken || '', orgType || 'production');
    req.session.sfAccessToken = loginResult.access_token;
    req.session.sfInstanceUrl = loginResult.instance_url;
    req.session.sfUserInfo = { name: loginResult.user_name, email: loginResult.user_email, preferred_username: username };
    res.json({ success: true, user: { name: loginResult.user_name, email: loginResult.user_email, username } });
  } catch (err) {
    console.error('Login error:', err.message);
    let errorMsg = err.message;
    if (errorMsg.includes('INVALID_LOGIN')) errorMsg = 'Invalid username or password. If your IP is not trusted, append your Security Token.';
    else if (errorMsg.includes('LOGIN_MUST_USE_SECURITY_TOKEN')) errorMsg = 'Your IP is not trusted. Please enter your Security Token.';
    res.status(401).json({ error: errorMsg });
  }
});

// ——————————————————————————
// ROUTE: Auth Status
// ——————————————————————————
app.get('/api/auth/status', (req, res) => {
  if (req.session.sfAccessToken) res.json({ connected: true, user: req.session.sfUserInfo });
  else res.json({ connected: false });
});

// ——————————————————————————
// ROUTE: Logout
// ——————————————————————————
app.post('/api/auth/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

// ——————————————————————————
// HELPER: Fetch metadata + call Claude
// ——————————————————————————
async function getDesignSpec(message, accessToken, instanceUrl) {
  let metadataContext = '';

  try {
    const descRes = await axios.get(instanceUrl + '/services/data/v57.0/sobjects/', {
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    const objects = descRes.data.sobjects.filter(o => o.queryable && o.createable).slice(0, 30).map(o => o.name).join(', ');
    metadataContext = 'Available Salesforce Objects: ' + objects + '\n\n';

    const matches = message.match(/\b([A-Z][a-zA-Z0-9_]+(?:__c)?)\b/g);
    if (matches) {
      for (const objName of matches.slice(0, 2)) {
        try {
          const objRes = await axios.get(instanceUrl + '/services/data/v57.0/sobjects/' + objName + '/describe/', {
            headers: { Authorization: 'Bearer ' + accessToken }
          });
          const fields = objRes.data.fields.map(f => ({ name: f.name, label: f.label, type: f.type, required: !f.nillable && !f.defaultedOnCreate }));
          metadataContext += 'Object: ' + objName + '\nLabel: ' + objRes.data.label + '\n';
          metadataContext += 'Fields (first 50): ' + JSON.stringify(fields.slice(0, 50), null, 2) + '\n\n';
        } catch (e) {}
      }
    }
  } catch (e) { console.error('Metadata error:', e.message); }

  const claudeRes = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 4000,
    system: `You are a Salesforce design specification expert. Based on the metadata provided, generate detailed design specs including: object overview, field specs (type/validation/required), UI/UX recommendations, business rules, relationships, and security considerations. Format your response with clear sections and subsections.

Salesforce Metadata:
${metadataContext}`,
    messages: [{ role: 'user', content: message }]
  });

  return claudeRes.content[0].text;
}

// ——————————————————————————
// ROUTE: Chat
// ——————————————————————————
app.post('/api/chat', async (req, res) => {
  if (!req.session.sfAccessToken) return res.status(401).json({ error: 'Not authenticated with Salesforce' });
  const { message } = req.body;
  try {
    const response = await getDesignSpec(message, req.session.sfAccessToken, req.session.sfInstanceUrl);
    res.json({ response });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ——————————————————————————
// ROUTE: Export to Word (.docx)
// ——————————————————————————
app.post('/api/export/word', async (req, res) => {
  if (!req.session.sfAccessToken) return res.status(401).json({ error: 'Not authenticated' });
  const { message, content } = req.body;

  try {
    let specText = content;
    if (!specText) {
      specText = await getDesignSpec(message, req.session.sfAccessToken, req.session.sfInstanceUrl);
    }

    // Parse the text into sections for Word
    const lines = specText.split('\n');
    const docChildren = [];

    // Title
    docChildren.push(new Paragraph({
      text: 'Salesforce Design Specification',
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 }
    }));

    // Subtitle with date
    docChildren.push(new Paragraph({
      children: [new TextRun({ text: 'Generated on: ' + new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }), color: '666666', size: 22 })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 600 }
    }));

    // Query info
    if (message) {
      docChildren.push(new Paragraph({
        children: [new TextRun({ text: 'Query: ', bold: true, size: 24 }), new TextRun({ text: message, size: 24 })],
        spacing: { after: 400 }
      }));
    }

    // Parse content lines into Word paragraphs
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        docChildren.push(new Paragraph({ text: '', spacing: { after: 120 } }));
        continue;
      }

      // Heading detection (lines with ## or ### or ALL CAPS short lines or ending with :)
      if (trimmed.startsWith('## ') || trimmed.startsWith('# ')) {
        const text = trimmed.replace(/^#+\s*/, '');
        docChildren.push(new Paragraph({
          text, heading: HeadingLevel.HEADING_1,
          spacing: { before: 400, after: 200 }
        }));
      } else if (trimmed.startsWith('### ') || trimmed.startsWith('#### ')) {
        const text = trimmed.replace(/^#+\s*/, '');
        docChildren.push(new Paragraph({
          text, heading: HeadingLevel.HEADING_2,
          spacing: { before: 300, after: 120 }
        }));
      } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('• ')) {
        const text = trimmed.replace(/^[-*•]\s*/, '');
        docChildren.push(new Paragraph({
          children: [new TextRun({ text })],
          bullet: { level: 0 },
          spacing: { after: 80 }
        }));
      } else if (/^\d+\.\s/.test(trimmed)) {
        const text = trimmed.replace(/^\d+\.\s*/, '');
        docChildren.push(new Paragraph({
          children: [new TextRun({ text })],
          numbering: { reference: 'default-numbering', level: 0 },
          spacing: { after: 80 }
        }));
      } else if (trimmed.startsWith('**') && trimmed.endsWith('**')) {
        const text = trimmed.replace(/\*\*/g, '');
        docChildren.push(new Paragraph({
          children: [new TextRun({ text, bold: true })],
          spacing: { after: 120 }
        }));
      } else {
        // Process inline bold
        const parts = trimmed.split(/\*\*(.*?)\*\*/g);
        const runs = parts.map((part, i) => new TextRun({ text: part, bold: i % 2 === 1 }));
        docChildren.push(new Paragraph({ children: runs, spacing: { after: 120 } }));
      }
    }

    const doc = new Document({
      numbering: {
        config: [{
          reference: 'default-numbering',
          levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START }]
        }]
      },
      sections: [{ properties: {}, children: docChildren }]
    });

    const buffer = await Packer.toBuffer(doc);
    const filename = 'SF_Design_Spec_' + new Date().toISOString().slice(0, 10) + '.docx';

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.send(buffer);

  } catch (err) {
    console.error('Word export error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ——————————————————————————
// ROUTE: Export to Excel (.xlsx)
// ——————————————————————————
app.post('/api/export/excel', async (req, res) => {
  if (!req.session.sfAccessToken) return res.status(401).json({ error: 'Not authenticated' });
  const { message, content } = req.body;

  try {
    let specText = content;
    if (!specText) {
      specText = await getDesignSpec(message, req.session.sfAccessToken, req.session.sfInstanceUrl);
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'SF Claude Designer';
    workbook.created = new Date();

    // ---- Sheet 1: Design Specification ----
    const sheet1 = workbook.addWorksheet('Design Specification', {
      pageSetup: { paperSize: 9, orientation: 'portrait' }
    });

    // Column widths
    sheet1.columns = [
      { key: 'col1', width: 30 },
      { key: 'col2', width: 80 }
    ];

    // Title row
    sheet1.mergeCells('A1:B1');
    const titleCell = sheet1.getCell('A1');
    titleCell.value = 'Salesforce Design Specification';
    titleCell.font = { name: 'Calibri', size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF032D60' } };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    sheet1.getRow(1).height = 40;

    // Date row
    sheet1.mergeCells('A2:B2');
    const dateCell = sheet1.getCell('A2');
    dateCell.value = 'Generated: ' + new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    dateCell.font = { name: 'Calibri', size: 11, color: { argb: 'FF666666' } };
    dateCell.alignment = { horizontal: 'center' };
    dateCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F6F9' } };
    sheet1.getRow(2).height = 22;

    // Query row
    if (message) {
      sheet1.mergeCells('A3:B3');
      const queryCell = sheet1.getCell('A3');
      queryCell.value = 'Query: ' + message;
      queryCell.font = { name: 'Calibri', size: 11, italic: true };
      queryCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F4FD' } };
      queryCell.alignment = { wrapText: true };
      sheet1.getRow(3).height = 25;
    }

    let rowIdx = message ? 5 : 4;

    // Parse content and add rows
    const lines = specText.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { rowIdx++; continue; }

      sheet1.mergeCells('A' + rowIdx + ':B' + rowIdx);
      const cell = sheet1.getCell('A' + rowIdx);
      cell.alignment = { wrapText: true, vertical: 'top' };

      if (trimmed.startsWith('## ') || trimmed.startsWith('# ')) {
        cell.value = trimmed.replace(/^#+\s*/, '');
        cell.font = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FF032D60' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD0E4F7' } };
        sheet1.getRow(rowIdx).height = 28;
      } else if (trimmed.startsWith('### ') || trimmed.startsWith('#### ')) {
        cell.value = trimmed.replace(/^#+\s*/, '');
        cell.font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FF0176D3' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F8FF' } };
        sheet1.getRow(rowIdx).height = 22;
      } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('• ')) {
        cell.value = '  • ' + trimmed.replace(/^[-*•]\s*/, '');
        cell.font = { name: 'Calibri', size: 11 };
        sheet1.getRow(rowIdx).height = 18;
      } else {
        cell.value = trimmed.replace(/\*\*/g, '');
        cell.font = { name: 'Calibri', size: 11 };
        sheet1.getRow(rowIdx).height = 18;
      }

      // Border
      cell.border = {
        bottom: { style: 'thin', color: { argb: 'FFE0E5EE' } }
      };

      rowIdx++;
    }

    // ---- Sheet 2: Fields Table (if metadata is available) ----
    const sheet2 = workbook.addWorksheet('Fields Summary');
    sheet2.columns = [
      { header: 'Field Name', key: 'name', width: 30 },
      { header: 'Label', key: 'label', width: 30 },
      { header: 'Type', key: 'type', width: 20 },
      { header: 'Required', key: 'required', width: 12 },
      { header: 'Notes', key: 'notes', width: 40 }
    ];

    // Style header row
    const headerRow = sheet2.getRow(1);
    headerRow.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Calibri' };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0176D3' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = { bottom: { style: 'medium', color: { argb: 'FF032D60' } } };
    });
    headerRow.height = 25;

    // Extract field info from specText using regex
    const fieldMatches = specText.matchAll(/[-•*]\s*\*{0,2}([\w\s]+?)\*{0,2}\s*[:(]\s*(\w+)[):]?/g);
    let dataRowIdx = 2;
    for (const match of fieldMatches) {
      if (dataRowIdx > 100) break;
      const row = sheet2.addRow({ name: match[1].trim(), label: match[1].trim(), type: match[2].trim(), required: 'No', notes: '' });
      row.eachCell(cell => {
        cell.font = { name: 'Calibri', size: 11 };
        cell.border = { bottom: { style: 'thin', color: { argb: 'FFE0E5EE' } } };
        if (dataRowIdx % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } };
      });
      dataRowIdx++;
    }

    // If no fields found, add placeholder
    if (dataRowIdx === 2) {
      sheet2.addRow({ name: 'See Design Specification tab', label: '', type: '', required: '', notes: 'Field details are in the main specification' });
    }

    // Auto-filter on sheet2
    sheet2.autoFilter = { from: 'A1', to: 'E1' };

    const filename = 'SF_Design_Spec_' + new Date().toISOString().slice(0, 10) + '.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');

    await workbook.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error('Excel export error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
