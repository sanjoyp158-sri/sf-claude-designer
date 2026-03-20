# SF Claude Designer 🤖☁️

A web-based chat application that connects to your Salesforce org, reads live object metadata, and uses Claude AI to generate professional **design specifications**.

## Features

- 🔐 Secure Salesforce OAuth login (Production & Sandbox)
- 💬 Chat interface powered by Claude AI
- 📊 Reads live metadata from your Salesforce org
- 📋 Generates professional design specifications
- 🔍 Analyzes fields, relationships, validation rules
- ⚡ Quick prompt buttons for common objects
- 🌙 Dark mode UI

## Project Structure

```
sf-claude-designer/
├── backend/
│   ├── server.js          # Express server with SF + Claude API
│   ├── package.json       # Node.js dependencies
│   └── .env.example       # Environment variables template
├── frontend/
│   ├── index.html         # Main chat UI
│   ├── style.css          # Styles
│   └── app.js             # Frontend logic
└── README.md
```

## Prerequisites

- Node.js v18+
- Anthropic API key ([get one here](https://console.anthropic.com))
- Salesforce Connected App (see below)

## Setup

### 1. Create a Salesforce Connected App

1. Go to **Salesforce Setup → App Manager → New Connected App**
2. Enable **OAuth Settings**
3. Set Callback URL to: `http://localhost:3001/oauth/callback`
4. Add OAuth Scopes: `api`, `refresh_token`, `full`
5. Save and copy the **Consumer Key** and **Consumer Secret**

### 2. Clone and Configure

```bash
git clone https://github.com/sanjoyp158-sri/sf-claude-designer.git
cd sf-claude-designer/backend
cp .env.example .env
```

Edit `.env`:
```env
ANTHROPIC_API_KEY=your_anthropic_api_key
SF_CLIENT_ID=your_salesforce_consumer_key
SF_CLIENT_SECRET=your_salesforce_consumer_secret
SESSION_SECRET=any_random_long_string
PORT=3001
```

### 3. Install and Run

```bash
cd backend
npm install
npm start
```

Open your browser at **http://localhost:3001**

## Usage

1. Open the app in your browser
2. Enter your Salesforce **username**, **password**, and **security token**
3. Check "Sandbox" if connecting to a sandbox org
4. Click **Connect to Salesforce**
5. Start chatting! Ask things like:
   - *"Generate a design spec for the Account object"*
   - *"What custom fields are on the Opportunity object?"*
   - *"Describe the data model for Account, Contact and Opportunity"*

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express |
| AI | Claude claude-opus-4-5 (Anthropic) |
| Salesforce | REST API v59.0 |
| Auth | OAuth 2.0 Password Flow |
| Frontend | Vanilla HTML/CSS/JS |
| Markdown | marked.js + highlight.js |

## Security Notes

- Credentials are never stored permanently - only held in a server-side session
- Sessions expire after 24 hours
- Never commit your `.env` file to version control
