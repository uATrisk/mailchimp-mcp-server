import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { createCampaignCore, getDatacenter, sendTestEmailCore, sendTestEmailSchema, setCampaignContentCore, sendCampaignCore } from "./index.ts";

describe("Mailchimp MCP Server Tools", () => {
  const originalFetch = global.fetch;
  const mockFetch = mock();

  let originalApiKey: string | undefined;

  beforeEach(() => {
    global.fetch = mockFetch as unknown as typeof fetch;
    mockFetch.mockClear();
    originalApiKey = process.env.MAILCHIMP_API_KEY;
    process.env.MAILCHIMP_API_KEY = "testkey-us6";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.MAILCHIMP_API_KEY;
    } else {
      process.env.MAILCHIMP_API_KEY = originalApiKey;
    }
  });

  describe("getDatacenter", () => {
    it("extracts the datacenter from a valid key", () => {
      expect(getDatacenter("123456789-us6")).toBe("us6");
      expect(getDatacenter("abc-def-us12")).toBe("us12");
    });

    it("throws an error for an invalid key", () => {
      expect(() => getDatacenter("invalidkeywithoutdatacenter")).toThrow("MAILCHIMP_API_KEY is malformed");
      expect(() => getDatacenter("invalidkey-")).toThrow("MAILCHIMP_API_KEY is malformed");
    });
  });

  describe("create_campaign", () => {
    const validArgs = {
      type: "regular" as const,
      list_id: "list123",
      subject_line: "Test Subject",
      from_name: "Test Name",
      reply_to: "test@example.com"
    };

    it("successful call", async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        id: "camp_123",
        status: "save",
        type: "regular",
        create_time: "2026-01-01T00:00:00+00:00",
        archive_url: "https://us6.campaign-archive.com/test"
      }), { status: 200 }));

      const result = await createCampaignCore(validArgs);

      expect(result.isError).toBeUndefined();
      expect(result.content?.[0]?.text).toContain("camp_123");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const fetchCall = mockFetch.mock.calls[0] as [string | URL, RequestInit];
      const url = fetchCall[0];
      const options = fetchCall[1];
      // Note: we're using "testkey-us6" from the env var during test execution
      expect(url).toBe("https://us6.api.mailchimp.com/3.0/campaigns");
      expect(options?.method).toBe("POST");
      
      const authHeader = options?.headers as any;
      expect(authHeader["Authorization"]).toBe("Basic YW55c3RyaW5nOnRlc3RrZXktdXM2"); // base64("anystring:testkey-us6")
      
      const body = JSON.parse(options?.body as string);
      expect(body.type).toBe("regular");
      expect(body.recipients.list_id).toBe("list123");
      expect(body.settings.subject_line).toBe("Test Subject");
    });

    it("error handling path (API error with detail)", async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        title: "Invalid Resource",
        status: 400,
        detail: "The list_id is invalid.",
        instance: "..."
      }), { status: 400, statusText: "Bad Request" }));

      const result = await createCampaignCore(validArgs);

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("Mailchimp API error: 400 Bad Request - The list_id is invalid.");
    });

    it("timeout error path", async () => {
      mockFetch.mockImplementation(async () => {
        return new Promise((_, reject) => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          setTimeout(() => reject(error), 10);
        });
      });

      const result = await createCampaignCore(validArgs);

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("Request to Mailchimp API timed out after 10 seconds.");
    });
  });

  describe("send_test_email", () => {
    const validArgs = {
      campaign_id: "camp_123",
      test_emails: ["test1@example.com"],
      send_type: "html" as const
    };

    it("successful call returns 204 confirmation", async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const result = await sendTestEmailCore(validArgs);

      expect(result.isError).toBeUndefined();
      expect(result.content?.[0]?.text).toContain("Successfully sent test email for campaign camp_123 to: test1@example.com");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("error handling path (campaign has no content precondition)", async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        title: "Bad Request",
        status: 400,
        detail: "The campaign must have content before sending a test.",
        instance: "..."
      }), { status: 400, statusText: "Bad Request" }));

      const result = await sendTestEmailCore(validArgs);

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("Mailchimp API error: 400 Bad Request - The campaign must have content before sending a test.");
    });

    it("timeout error path", async () => {
      mockFetch.mockImplementation(async () => {
        return new Promise((_, reject) => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          setTimeout(() => reject(error), 10);
        });
      });

      const result = await sendTestEmailCore(validArgs);

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("Request to Mailchimp API timed out after 10 seconds.");
    });

    it("schema rejects empty or omitted test_emails array", async () => {
      try {
        await sendTestEmailSchema.parseAsync({
          campaign_id: "camp_123",
          test_emails: [],
          send_type: "html"
        });
        expect().fail("Should have thrown zod error for empty array");
      } catch (e: any) {
        expect(e.message).toContain("expected array to have >=1 items");
      }
      
      try {
        await sendTestEmailSchema.parseAsync({
          campaign_id: "camp_123",
          send_type: "html"
        });
        expect().fail("Should have thrown zod error for missing test_emails");
      } catch (e: any) {
        expect(e.message).toContain("expected array, received undefined");
      }
    });
  });

  describe("set_campaign_content", () => {
    const validArgs = {
      campaign_id: "camp_123",
      html: "<html><body><h1>Hello!</h1></body></html>"
    };

    it("successful call returns confirmation with length", async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        plain_text: "Hello!",
        html: "<html><body><h1>Hello!</h1></body></html>",
        archive_html: "<html><body><h1>Hello!</h1></body></html>"
      }), { status: 200 }));

      const result = await setCampaignContentCore(validArgs);

      expect(result.isError).toBeUndefined();
      expect(result.content?.[0]?.text).toContain("Successfully set HTML content for campaign camp_123 (Length: 41 characters).");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const fetchCall = mockFetch.mock.calls[0] as [string | URL, RequestInit];
      const url = fetchCall[0];
      const options = fetchCall[1];
      expect(url).toBe("https://us6.api.mailchimp.com/3.0/campaigns/camp_123/content");
      expect(options?.method).toBe("PUT");
      
      const body = JSON.parse(options?.body as string);
      expect(body.html).toBe("<html><body><h1>Hello!</h1></body></html>");
    });

    it("error handling path (campaign already sent precondition)", async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        title: "Invalid Resource",
        status: 400,
        detail: "Cannot modify a campaign that has already been sent.",
        instance: "..."
      }), { status: 400, statusText: "Bad Request" }));

      const result = await setCampaignContentCore(validArgs);

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("Mailchimp API error: 400 Bad Request - Cannot modify a campaign that has already been sent.");
    });

    it("timeout error path", async () => {
      mockFetch.mockImplementation(async () => {
        return new Promise((_, reject) => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          setTimeout(() => reject(error), 10);
        });
      });

      const result = await setCampaignContentCore(validArgs);

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("Request to Mailchimp API timed out after 10 seconds.");
    });
  });

  describe("send_campaign", () => {
    const validArgs = {
      campaign_id: "camp_123",
      confirm: true
    };

    it("confirm omitted/false -> fetch is never called, response is not an error, dry-run message returned", async () => {
      const result = await sendCampaignCore({ campaign_id: "camp_123", confirm: false });
      
      expect(result.isError).toBeUndefined();
      expect(result.content?.[0]?.text).toContain("Dry run: confirm flag was not set to true. The campaign was NOT sent.");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("confirm true -> fetch called exactly once with correct URL/method/headers, success message returned", async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const result = await sendCampaignCore(validArgs);

      expect(result.isError).toBeUndefined();
      expect(result.content?.[0]?.text).toContain("Successfully sent campaign camp_123.");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const fetchCall = mockFetch.mock.calls[0] as [string | URL, RequestInit];
      expect(fetchCall[0]).toBe("https://us6.api.mailchimp.com/3.0/campaigns/camp_123/actions/send");
      expect(fetchCall[1]?.method).toBe("POST");
      expect(fetchCall[1]?.body).toBe("");
    });

    it("confirm true + API 400 error -> error path returns formatted message, isError true", async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        title: "Bad Request",
        status: 400,
        detail: "Cannot send a campaign that has already been sent.",
        instance: "..."
      }), { status: 400, statusText: "Bad Request" }));

      const result = await sendCampaignCore(validArgs);

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("Mailchimp API error: 400 Bad Request - Cannot send a campaign that has already been sent.");
    });

    it("confirm true + timeout (AbortError) -> standard timeout message, isError true", async () => {
      mockFetch.mockImplementation(async () => {
        return new Promise((_, reject) => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          setTimeout(() => reject(error), 10);
        });
      });

      const result = await sendCampaignCore(validArgs);

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("Request to Mailchimp API timed out after 10 seconds.");
    });
  });
});
