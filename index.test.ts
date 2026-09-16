import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { createCampaignCore, getDatacenter } from "./index.ts";

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
});
