import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "Mailchimp MCP Server",
  version: "1.0.0",
});

export function getDatacenter(key: string): string {
  const lastHyphenIndex = key.lastIndexOf('-');
  if (lastHyphenIndex === -1 || lastHyphenIndex === key.length - 1) {
    throw new Error("MAILCHIMP_API_KEY is malformed. Expected format: <key>-<dc>");
  }
  return key.substring(lastHyphenIndex + 1);
}

export function getMailchimpConfig() {
  const apiKey = process.env.MAILCHIMP_API_KEY;
  if (!apiKey) {
    throw new Error("MAILCHIMP_API_KEY environment variable is not set.");
  }
  const datacenter = getDatacenter(apiKey);
  const baseUrl = `https://${datacenter}.api.mailchimp.com/3.0`;
  return { apiKey, datacenter, baseUrl };
}

const createCampaignSchema = z.object({
  type: z.enum(["regular", "plaintext", "rss", "absplit"]).default("regular").describe("The type of campaign to create."),
  list_id: z.string().describe("The unique ID of the audience (list) to send to."),
  subject_line: z.string().describe("The subject line for the campaign."),
  from_name: z.string().describe("The 'from' name on the campaign (not an email address)."),
  reply_to: z.string().email().describe("The reply-to email address for the campaign.")
});

function mailchimpHeaders(apiKey: string) {
  const authHeader = Buffer.from(`anystring:${apiKey}`).toString('base64');
  return {
    "Authorization": `Basic ${authHeader}`,
    "Content-Type": "application/json"
  };
}

// Mailchimp limits are a concurrency cap (max 10 simultaneous connections per user), not a pure rate-over-time limit.
// Although this single-call tool doesn't need connection pooling, we include fetchWithRetry to handle standard network retries and 429s.
async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
  let attempt = 0;
  while (attempt < maxRetries) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);

      if (response.status === 429) {
        attempt++;
        if (attempt >= maxRetries) {
          return response;
        }
        
        let delayMs = 1000 * Math.pow(2, attempt - 1);
        
        const retryAfter = response.headers.get("Retry-After");
        if (retryAfter) {
          const parsed = parseInt(retryAfter, 10);
          if (!isNaN(parsed)) {
            delayMs = parsed * 1000;
          } else {
             const date = new Date(retryAfter);
             if (!isNaN(date.getTime())) {
                delayMs = Math.max(0, date.getTime() - Date.now());
             }
          }
        }
        
        delayMs += Math.random() * 500;
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }
      
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }
  throw new Error("Max retries exceeded");
}

function withMailchimpErrorHandling<T>(
  handler: (args: T) => Promise<{ content: { type: "text", text: string }[], isError?: boolean }>
): (args: T) => Promise<{ content: { type: "text", text: string }[], isError?: boolean }> {
  return async (args: T) => {
    try {
      return await handler(args);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
         return {
          isError: true,
          content: [{ type: "text", text: "Request to Mailchimp API timed out after 10 seconds." }]
        };
      }
      return {
        isError: true,
        content: [{ type: "text", text: `Unexpected error: ${error instanceof Error ? error.message : String(error)}` }]
      };
    }
  };
}

interface MailchimpCampaignResponse {
  id: string;
  status: string;
  type: string;
  create_time: string;
  archive_url: string;
}

export const createCampaignCore = withMailchimpErrorHandling(async (args: z.infer<typeof createCampaignSchema>) => {
  const config = getMailchimpConfig();
  const url = `${config.baseUrl}/campaigns`;
  
  const payload = {
    type: args.type,
    recipients: {
      list_id: args.list_id
    },
    settings: {
      subject_line: args.subject_line,
      from_name: args.from_name,
      reply_to: args.reply_to
    }
  };

  const response = await fetchWithRetry(url, {
    method: "POST",
    headers: mailchimpHeaders(config.apiKey),
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    let errorMessage = `Mailchimp API error: ${response.status} ${response.statusText}`;
    try {
      const errorData = await response.json() as { detail?: string };
      if (errorData && errorData.detail) {
        errorMessage += ` - ${errorData.detail}`;
      }
    } catch (e) {
      // Ignored if response isn't JSON
    }
    return {
      isError: true,
      content: [{ type: "text", text: errorMessage }]
    };
  }

  const data = await response.json() as MailchimpCampaignResponse;
  
  const result = {
    id: data.id,
    status: data.status,
    type: data.type,
    create_time: data.create_time,
    archive_url: data.archive_url
  };
  
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
  };
});

server.registerTool(
  "create_campaign",
  {
    description: "Create a new Mailchimp campaign.",
    inputSchema: createCampaignSchema,
  },
  async (args) => createCampaignCore(args)
);

export const sendTestEmailSchema = z.object({
  campaign_id: z.string().describe("The unique ID of the campaign to test."),
  test_emails: z.array(z.string().email()).min(1).describe("An array of valid email addresses to send the test to."),
  send_type: z.enum(["html", "plaintext"]).default("html").describe("The format of the test email (html or plaintext).")
});

export const sendTestEmailCore = withMailchimpErrorHandling(async (args: z.infer<typeof sendTestEmailSchema>) => {
  const config = getMailchimpConfig();
  const url = `${config.baseUrl}/campaigns/${args.campaign_id}/actions/test`;
  
  const payload = {
    test_emails: args.test_emails,
    send_type: args.send_type
  };

  const response = await fetchWithRetry(url, {
    method: "POST",
    headers: mailchimpHeaders(config.apiKey),
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    let errorMessage = `Mailchimp API error: ${response.status} ${response.statusText}`;
    try {
      const errorData = await response.json() as { detail?: string };
      if (errorData && errorData.detail) {
        errorMessage += ` - ${errorData.detail}`;
      }
    } catch (e) {
      // Ignored if response isn't JSON
    }
    return {
      isError: true,
      content: [{ type: "text", text: errorMessage }]
    };
  }

  return {
    content: [{ type: "text", text: `Successfully sent test email for campaign ${args.campaign_id} to: ${args.test_emails.join(', ')}` }]
  };
});

server.registerTool(
  "send_test_email",
  {
    description: "Send a test email for a Mailchimp campaign.",
    inputSchema: sendTestEmailSchema,
  },
  async (args) => sendTestEmailCore(args)
);

export const setCampaignContentSchema = z.object({
  campaign_id: z.string().describe("The unique ID of the campaign to modify."),
  html: z.string().describe("The raw HTML body of the email. Mailchimp will auto-generate the plain-text version if not separately provided.")
});

export const setCampaignContentCore = withMailchimpErrorHandling(async (args: z.infer<typeof setCampaignContentSchema>) => {
  const config = getMailchimpConfig();
  const url = `${config.baseUrl}/campaigns/${args.campaign_id}/content`;
  
  const payload = {
    html: args.html
  };

  const response = await fetchWithRetry(url, {
    method: "PUT",
    headers: mailchimpHeaders(config.apiKey),
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    let errorMessage = `Mailchimp API error: ${response.status} ${response.statusText}`;
    try {
      const errorData = await response.json() as { detail?: string };
      if (errorData && errorData.detail) {
        errorMessage += ` - ${errorData.detail}`;
      }
    } catch (e) {
      // Ignored if response isn't JSON
    }
    return {
      isError: true,
      content: [{ type: "text", text: errorMessage }]
    };
  }

  await response.json(); // Consume the body
  
  return {
    content: [{ type: "text", text: `Successfully set HTML content for campaign ${args.campaign_id} (Length: ${args.html.length} characters).` }]
  };
});

server.registerTool(
  "set_campaign_content",
  {
    description: "Set the HTML content for a Mailchimp campaign.",
    inputSchema: setCampaignContentSchema,
  },
  async (args) => setCampaignContentCore(args)
);

if (process.argv[1] && import.meta.url === Bun.pathToFileURL(process.argv[1]).href) {
  try {
    getMailchimpConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid API key configuration");
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  server.connect(transport).catch((err) => {
    console.error("Failed to connect transport:", err);
    process.exit(1);
  });
}

export { server };
