# Mailchimp MCP Server

An MCP server for integrating Mailchimp with AI agents.

## Prerequisites

- [Bun](https://bun.sh/) (JavaScript runtime)
- A Mailchimp account and an API Key.

## Tools

### 1. `create_campaign`
Creates a new Mailchimp campaign. It sets up the campaign's type, audience (list_id), and settings (subject line, from name, reply-to).
- **Example Input:** 
  ```json
  { 
    "type": "regular",
    "list_id": "aud123456",
    "subject_line": "Monthly Newsletter",
    "from_name": "Acme Corp",
    "reply_to": "newsletter@acmecorp.com"
  }
  ```
- **Example Output:** A JSON string containing the new campaign's ID and status.

### 2. `send_test_email`
Sends a test email for a Mailchimp campaign. The campaign must have content set before sending a test.
- **Example Input:** 
  ```json
  { 
    "campaign_id": "camp_123456",
    "test_emails": ["tester1@example.com", "tester2@example.com"],
    "send_type": "html"
  }
  ```
- **Example Output:** A simple confirmation text indicating success.

### 3. `set_campaign_content`
Sets the HTML content for a Mailchimp campaign. Mailchimp will automatically generate a plain-text version if not provided.
- **Example Input:** 
  ```json
  { 
    "campaign_id": "camp_123456",
    "html": "<html><body><h1>Hello, World!</h1></body></html>"
  }
  ```
- **Example Output:** A confirmation text including the campaign ID and the length of the content set.
