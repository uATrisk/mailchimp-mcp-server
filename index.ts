import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createHash } from "node:crypto";

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
  settings?: {
    title?: string;
    subject_line?: string;
  };
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

export const sendCampaignSchema = z.object({
  campaign_id: z.string().describe("The unique ID of the campaign to send."),
  confirm: z.boolean().default(false).describe("SAFETY GATE: You must explicitly set this to true to actually send the campaign to all recipients. If false, the tool will act as a dry run and do nothing.")
});

export const sendCampaignCore = withMailchimpErrorHandling(async (args: z.infer<typeof sendCampaignSchema>) => {
  if (args.confirm !== true) {
    return {
      content: [{ type: "text", text: "Dry run: confirm flag was not set to true. The campaign was NOT sent. To actually send, call this tool again with \"confirm\": true." }]
    };
  }

  const config = getMailchimpConfig();
  const url = `${config.baseUrl}/campaigns/${args.campaign_id}/actions/send`;
  
  const response = await fetchWithRetry(url, {
    method: "POST",
    headers: mailchimpHeaders(config.apiKey),
    body: ""
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
    content: [{ type: "text", text: `Successfully sent campaign ${args.campaign_id}.` }]
  };
});

server.registerTool(
  "send_campaign",
  {
    description: "Send a Mailchimp campaign. IMPORTANT: You must explicitly pass confirm: true to actually send.",
    inputSchema: sendCampaignSchema,
  },
  async (args) => sendCampaignCore(args)
);

export const listCampaignsSchema = z.object({
  count: z.number().int().min(1).max(1000).default(10).describe("The number of campaigns to return."),
  offset: z.number().int().min(0).default(0).describe("The number of campaigns to skip (for pagination).")
});

export const listCampaignsCore = withMailchimpErrorHandling(async (args: z.infer<typeof listCampaignsSchema>) => {
  const config = getMailchimpConfig();
  const url = `${config.baseUrl}/campaigns?count=${args.count}&offset=${args.offset}`;
  
  const response = await fetchWithRetry(url, {
    method: "GET",
    headers: mailchimpHeaders(config.apiKey)
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

  const data = await response.json() as { campaigns: MailchimpCampaignResponse[], total_items: number };
  
  const campaigns = (data.campaigns || []).map(c => ({
    id: c.id,
    title: c.settings?.title || c.settings?.subject_line || "Untitled",
    status: c.status,
    type: c.type,
    create_time: c.create_time,
    archive_url: c.archive_url
  }));
  
  const result = {
    campaigns,
    total_items: data.total_items
  };
  
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
  };
});

server.registerTool(
  "list_campaigns",
  {
    description: "List Mailchimp campaigns with pagination.",
    inputSchema: listCampaignsSchema,
  },
  async (args) => listCampaignsCore(args)
);

export interface MailchimpAudienceResponse {
  id: string;
  name: string;
  stats?: {
    member_count: number;
    unsubscribe_count: number;
  };
}

export const listAudiencesSchema = z.object({
  count: z.number().int().min(1).max(1000).default(10).describe("The number of audiences to return."),
  offset: z.number().int().min(0).default(0).describe("The number of audiences to skip (for pagination).")
});

export const listAudiencesCore = withMailchimpErrorHandling(async (args: z.infer<typeof listAudiencesSchema>) => {
  const config = getMailchimpConfig();
  const url = `${config.baseUrl}/lists?count=${args.count}&offset=${args.offset}`;
  
  const response = await fetchWithRetry(url, {
    method: "GET",
    headers: mailchimpHeaders(config.apiKey)
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

  const data = await response.json() as { lists: MailchimpAudienceResponse[], total_items: number };
  
  const audiences = (data.lists || []).map(l => ({
    id: l.id,
    name: l.name,
    member_count: l.stats?.member_count ?? 0,
    unsubscribe_count: l.stats?.unsubscribe_count ?? 0
  }));
  
  const result = {
    audiences,
    total_items: data.total_items
  };
  
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
  };
});

server.registerTool(
  "list_audiences",
  {
    description: "List Mailchimp audiences (lists) with pagination.",
    inputSchema: listAudiencesSchema,
  },
  async (args) => listAudiencesCore(args)
);

export interface MailchimpReportResponse {
  id: string;
  campaign_title: string;
  emails_sent: number;
  unsubscribed: number;
  bounces?: {
    hard_bounces: number;
    soft_bounces: number;
    syntax_errors: number;
  };
  opens?: {
    opens_total: number;
    unique_opens: number;
    open_rate: number;
  };
  clicks?: {
    clicks_total: number;
    unique_clicks: number;
    click_rate: number;
  };
}

export const getCampaignReportSchema = z.object({
  campaign_id: z.string().describe("The ID of the campaign to get the report for.")
});

export const getCampaignReportCore = withMailchimpErrorHandling(async (args: z.infer<typeof getCampaignReportSchema>) => {
  const config = getMailchimpConfig();
  const url = `${config.baseUrl}/reports/${args.campaign_id}`;
  
  const response = await fetchWithRetry(url, {
    method: "GET",
    headers: mailchimpHeaders(config.apiKey)
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

  const data = await response.json() as MailchimpReportResponse;
  
  const report = {
    id: data.id,
    campaign_title: data.campaign_title,
    emails_sent: data.emails_sent,
    unsubscribed: data.unsubscribed,
    opens: data.opens ? {
      total: data.opens.opens_total,
      unique: data.opens.unique_opens,
      rate: data.opens.open_rate
    } : undefined,
    clicks: data.clicks ? {
      total: data.clicks.clicks_total,
      unique: data.clicks.unique_clicks,
      rate: data.clicks.click_rate
    } : undefined,
    bounces: data.bounces ? {
      hard: data.bounces.hard_bounces,
      soft: data.bounces.soft_bounces,
      syntax: data.bounces.syntax_errors
    } : undefined
  };
  
  return {
    content: [{ type: "text", text: JSON.stringify(report, null, 2) }]
  };
});

server.registerTool(
  "get_campaign_report",
  {
    description: "Get performance stats (opens, clicks, bounces, etc.) for a sent Mailchimp campaign.",
    inputSchema: getCampaignReportSchema,
  },
  async (args) => getCampaignReportCore(args)
);

export const subscribeMemberSchema = z.object({
  list_id: z.string().describe("The ID of the audience (list) to subscribe the member to."),
  email_address: z.string().email().describe("The email address of the new member."),
  status: z.enum(["pending", "subscribed"]).default("pending").describe("The subscription status (defaults to pending for double opt-in).")
});

export const subscribeMemberCore = withMailchimpErrorHandling(async (args: z.infer<typeof subscribeMemberSchema>) => {
  const config = getMailchimpConfig();
  const subscriberHash = createHash("md5").update(args.email_address.toLowerCase()).digest("hex");
  const url = `${config.baseUrl}/lists/${args.list_id}/members/${subscriberHash}`;
  
  const response = await fetchWithRetry(url, {
    method: "PUT",
    headers: mailchimpHeaders(config.apiKey),
    body: JSON.stringify({
      email_address: args.email_address,
      status_if_new: args.status,
      status: args.status
    })
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

  const data = await response.json() as { id?: string; email_address?: string; status?: string };
  
  const result = {
    id: data.id,
    email_address: data.email_address,
    status: data.status
  };
  
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
  };
});

server.registerTool(
  "subscribe_member",
  {
    description: "Subscribe a member to a Mailchimp audience (list). Acts as an upsert (add or update).",
    inputSchema: subscribeMemberSchema,
  },
  async (args) => subscribeMemberCore(args)
);

export const unsubscribeMemberSchema = z.object({
  list_id: z.string().describe("The ID of the audience (list) to unsubscribe the member from."),
  email_address: z.string().email().describe("The email address of the member to unsubscribe."),
  confirm: z.boolean().optional().describe("MUST be set to true to execute. If omitted or false, performs a dry-run.")
});

export const unsubscribeMemberCore = withMailchimpErrorHandling(async (args: z.infer<typeof unsubscribeMemberSchema>) => {
  if (!args.confirm) {
    return {
      content: [{ type: "text", text: `Dry run successful. To execute the unsubscribe operation for ${args.email_address}, you must pass confirm: true.` }]
    };
  }

  const config = getMailchimpConfig();
  const subscriberHash = createHash("md5").update(args.email_address.toLowerCase()).digest("hex");
  const url = `${config.baseUrl}/lists/${args.list_id}/members/${subscriberHash}`;
  
  const response = await fetchWithRetry(url, {
    method: "PUT",
    headers: mailchimpHeaders(config.apiKey),
    body: JSON.stringify({
      email_address: args.email_address,
      status_if_new: "unsubscribed",
      status: "unsubscribed"
    })
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

  const data = await response.json() as { id?: string; email_address?: string; status?: string };
  
  const result = {
    id: data.id,
    email_address: data.email_address,
    status: data.status
  };
  
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
  };
});

server.registerTool(
  "unsubscribe_member",
  {
    description: "Unsubscribe a member from a Mailchimp audience (list). Acts as an upsert (add or update) with unsubscribed status. Requires confirm: true.",
    inputSchema: unsubscribeMemberSchema,
  },
  async (args) => unsubscribeMemberCore(args)
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
