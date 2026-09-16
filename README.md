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
