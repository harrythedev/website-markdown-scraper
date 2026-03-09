import { jest } from '@jest/globals';
import { mockClient } from "aws-sdk-client-mock";
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

// --- Mock S3 and Lambda clients ---
const s3Mock = mockClient(S3Client);
const lambdaMock = mockClient(LambdaClient);

// --- Mock global fetch ---
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Re-import handler after mocks are set up
const { handler } = await import('./index.js');

// --- Sample API response ---
const createApiResponse = (articles) => ({
    result: true,
    data: articles,
    total: articles.length,
    sizePerPage: 10,
    currentPage: 1,
    currentCount: articles.length,
    hasNext: false,
});

const makeArticle = (id, title = "Test Article") => ({
    id,
    title,
    created_at: "2026-03-06 10:00:00",
    menu_name: "글로벌 칼럼",
    filter_name: "섹터분석",
});

describe('Entrypoint Lambda Unit Tests', () => {
    const mockEvent = {
        apiUrl: "https://api.test.com/list",
        articleBaseUrl: "https://test.com/view?id=",
        selector: ".test-content"
    };

    beforeEach(() => {
        s3Mock.reset();
        lambdaMock.reset();
        mockFetch.mockReset();
        process.env.BUCKET_NAME = 'test-bucket';
        process.env.PARSER_FUNCTION_NAME = 'test-parser-function';
    });

    test('should invoke parser for new articles using event parameters', async () => {
        const articles = [
            makeArticle("article-1", "Old Article"),
            makeArticle("article-2", "New Article"),
        ];

        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => createApiResponse(articles),
        });

        s3Mock.on(HeadObjectCommand, { Key: "article-1.md" }).resolves({});
        s3Mock.on(HeadObjectCommand, { Key: "article-2.md" }).rejects({ name: "NotFound" });

        lambdaMock.on(InvokeCommand).resolves({});

        const result = await handler(mockEvent);

        expect(result.processed).toBe(1);
        expect(result.skipped).toBe(1);

        // Verify fetch used the event apiUrl
        expect(mockFetch).toHaveBeenCalledWith("https://api.test.com/list");

        // Verify Lambda payload used event articleBaseUrl and selector
        const invokePayload = JSON.parse(lambdaMock.call(0).args[0].input.Payload);
        expect(invokePayload.url).toBe("https://test.com/view?id=article-2");
        expect(invokePayload.selector).toBe(".test-content");
    });

    test('should use default parameters if event is empty', async () => {
        const articles = [makeArticle("article-new")];

        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => createApiResponse(articles),
        });

        s3Mock.on(HeadObjectCommand).rejects({ name: "NotFound" });
        lambdaMock.on(InvokeCommand).resolves({});

        await handler({}); // Empty event

        // Verify fetch used the default apiUrl
        expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("api.fruiting.co.kr"));

        const invokePayload = JSON.parse(lambdaMock.call(0).args[0].input.Payload);
        expect(invokePayload.url).toContain("fruiting.co.kr");
        expect(invokePayload.selector).toBe(".board-cont");
    });

    test('should use provided page and size for API URL', async () => {
        const pageEvent = { page: 5, size: 24 };
        const articles = [makeArticle("page-5-article")];

        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => createApiResponse(articles),
        });

        s3Mock.on(HeadObjectCommand).rejects({ name: "NotFound" });
        lambdaMock.on(InvokeCommand).resolves({});

        await handler(pageEvent);

        // Verify fetch used the page and size in the URL
        expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("page=5"));
        expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("size=24"));
    });

    test('should throw error if API returns non-ok response', async () => {
        mockFetch.mockResolvedValue({
            ok: false,
            status: 500,
            statusText: "Internal Server Error",
        });

        await expect(handler(mockEvent)).rejects.toThrow('API request failed: 500');
    });
});
