# mcp-web-validator

[![npm version](https://img.shields.io/npm/v/mcp-web-validator.svg)](https://www.npmjs.com/package/mcp-web-validator)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

A **Model Context Protocol (MCP) server** that empowers AI coding assistants (like Claude, Cursor, ChatGPT, etc.) to validate HTML/CSS markup against the official W3C specification engine and perform technical SEO/accessibility audits directly inside local workspaces.

AI models write a lot of markup, but they cannot verify if it's syntactically valid or optimized for indexing. **`mcp-web-validator`** acts as an automated, offline/online debugger.

---

## ✨ Features

- **HTML Validation**: Leverages the official W3C Nu HTML Checker API (no API keys required).
- **CSS Validation**: Calls the W3C Jigsaw CSS Validator API to debug stylesheets.
- **Technical SEO Check**: Audits title/description lengths, viewport responsiveness, heading hierarchies, Open Graph metadata, and image alt attributes.
- **Broken Link Checker**: Scans HTML documents for broken internal or external URLs.
- **Schema Validator**: Parses and validates embedded JSON-LD structured schemas.

---

## 🛠️ Tools Exposed

1. `validate_local_html`
   - **Arguments**: `filePath: string` (Absolute or relative path to the local HTML file)
   - **Description**: Submits local HTML to the W3C Nu Checker and returns syntax errors/warnings.
2. `validate_url`
   - **Arguments**: `url: string` (The live public URL to audit)
   - **Description**: Validates live page markup against W3C standards.
3. `validate_local_css`
   - **Arguments**: `filePath: string` (Absolute or relative path to the CSS file)
   - **Description**: Checks local CSS syntax against the W3C Jigsaw API.
4. `audit_seo_metadata`
   - **Arguments**: `htmlContent: string` (Raw HTML string)
   - **Description**: Performs a fast, local SEO audit (titles, descriptions, headings, images, alt tags).
5. `check_broken_links`
   - **Arguments**: `htmlContent: string`, `baseUrl?: string`
   - **Description**: Tests all links in the document to detect 404s or broken URLs.
6. `validate_schema_markup`
   - **Arguments**: `htmlContent: string`
   - **Description**: Validates JSON-LD schema syntax.
7. `generate_validation_report`
   - **Arguments**: `htmlFilePath: string`, `cssFilePath?: string`, `baseUrl?: string`
   - **Description**: Automatically runs all checks (HTML/CSS syntax, SEO audit, JSON-LD, broken links) and generates a unified Markdown report card styled with PageSpeed-inspired scoring.

---

## 🚀 Configuration

### 1. Claude Desktop
Add this to your `claude_desktop_config.json`:

* **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
* **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mcp-web-validator": {
      "command": "npx",
      "args": ["-y", "mcp-web-validator"]
    }
  }
}
```

### 2. Cursor
To use this inside **Cursor**, navigate to **Settings > Features > MCP**:
1. Click **+ Add New MCP Server**.
2. Set Name: `mcp-web-validator`
3. Set Type: `command`
4. Set Command: `npx -y mcp-web-validator`

### 3. Development / Local Execution
To run and test the server locally:
```bash
git clone https://github.com/AKzar1el/mcp-web-validator.git
cd mcp-web-validator
npm install
npm run build
node dist/index.js
```

---

## 📄 License
This project is licensed under the MIT License - see the LICENSE file for details.
