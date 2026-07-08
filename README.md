# mcp-web-validator

[![npm version](https://img.shields.io/npm/v/mcp-web-validator.svg)](https://www.npmjs.com/package/mcp-web-validator)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

A **Model Context Protocol (MCP) server** that empowers AI coding assistants (like Claude, Cursor, ChatGPT, etc.) to validate HTML/CSS markup against the official W3C specification engine and perform technical SEO/accessibility audits directly inside local workspaces.

---

## 💬 How It Works (Visual Flow)

Imagine asking your AI coding assistant:

> **User:** *"I just finished building my homepage. Can you validate it, check for SEO issues, and take responsive screenshots to see if it looks correct?"*

Here is the exact flow of how the assistant uses `mcp-web-validator` to audit the code and present results:

### 1️⃣ Step 1: Technical & SEO Score Card
The assistant automatically runs `generate_validation_report` which aggregates standard specs and outputs a unified PageSpeed-style scorecard directly in your chat:

# 📋 Web Validation & SEO Audit Report — 🟢 **92**/100
*Generated for: `index.html`*

#### ⚡ Page Health Scores (PageSpeed Inspired)
| Score Card | Status | Score |
| :--- | :---: | :---: |
| **W3C HTML Validation** | 🟠 Needs Work | **88** / 100 |
| **SEO & Accessibility** | 🟠 Warnings | **88** / 100 |
| **Links Integrity** | 🟢 All Good | **100** / 100 |

### 2️⃣ Step 2: Responsive Viewport Screenshot Audits
The assistant launches local Puppeteer using `capture_screenshots` to render the page across multiple devices:

| Desktop (1440x900) | Tablet (768x1024) | Mobile (375x812) |
| :---: | :---: | :---: |
| 🖥️ `desktop.png` | 📟 `tablet.png` | 📱 `mobile.png` |

---

## ✨ Features

- **HTML Validation**: Leverages the official W3C Nu HTML Checker API (no API keys required).
- **CSS Validation**: Calls the W3C Jigsaw CSS Validator API to debug stylesheets.
- **Technical SEO Check**: Audits title/description lengths, viewport responsiveness, heading hierarchies, Open Graph metadata, and image alt attributes.
- **Broken Link Checker**: Scans HTML documents for broken internal or external URLs.
- **Schema Validator**: Parses and validates embedded JSON-LD structured schemas.
- **Visual Viewport Audits**: Uses a headless Puppeteer browser locally to capture responsive layout screenshots (desktop, tablet, mobile) for design auditing.

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
8. `capture_screenshots`
   - **Arguments**: `targetPath: string` (Path to local HTML file or HTTP(S) URL), `outputDir?: string`, `viewports?: Array<{ name: string, width: number, height: number }>`
   - **Description**: Renders the target in a local headless browser and saves screenshots across desktop, tablet, and mobile views.

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
