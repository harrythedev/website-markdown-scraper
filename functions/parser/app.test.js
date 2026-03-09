import { jest } from '@jest/globals';
import { mockClient } from "aws-sdk-client-mock";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3Mock = mockClient(S3Client);

// Use unstable_mockModule for ESM mocking
jest.unstable_mockModule('puppeteer-core', () => ({
    default: {
        launch: jest.fn(),
    },
}));

jest.unstable_mockModule('@sparticuz/chromium', () => ({
    default: {
        args: [],
        defaultViewport: {},
        executablePath: jest.fn().mockResolvedValue('/usr/bin/chromium'),
        headless: true,
    },
}));

jest.unstable_mockModule('node-pandoc-promise', () => ({
    default: jest.fn(),
}));

// Re-import after mocking
const { handler } = await import('./app.js');
const { default: puppeteer } = await import('puppeteer-core');
const { default: nodePandoc } = await import('node-pandoc-promise');

describe('Lambda Handler Unit Tests', () => {
    const mockEvent = {
        url: 'https://example.com',
        selector: '.content',
        fileName: 'test-output.md'
    };

    beforeEach(() => {
        s3Mock.reset();
        jest.clearAllMocks();
        process.env.BUCKET_NAME = 'test-bucket';
    });

    test('should successfully parse and upload to S3', async () => {
        const mockPage = {
            goto: jest.fn().mockResolvedValue({}),
            waitForSelector: jest.fn().mockResolvedValue({}),
            content: jest.fn().mockResolvedValue('<html><body><div class="content">Test Content</div></body></html>'),
            close: jest.fn(),
        };
        const mockBrowser = {
            newPage: jest.fn().mockResolvedValue(mockPage),
            close: jest.fn(),
        };
        puppeteer.launch.mockResolvedValue(mockBrowser);
        nodePandoc.mockResolvedValue('## Test Content');
        s3Mock.on(PutObjectCommand).resolves({});

        const result = await handler(mockEvent);

        expect(result.statusCode).toBe(200);
        expect(JSON.parse(result.body).message).toContain('Successfully saved to s3');
        expect(s3Mock.calls()).toHaveLength(1);
        const s3Call = s3Mock.call(0).args[0].input;
        expect(s3Call.Bucket).toBe('test-bucket');
        expect(s3Call.Key).toBe('test-output.md');
        expect(s3Call.Body).toBe('## Test Content');
        // selector path -> HTML input format for pandoc
        expect(nodePandoc).toHaveBeenCalledWith(expect.any(String), ['-f', 'html', '-t', 'markdown']);
    });

    test('should use plain text format for pandoc when no selector (readability path)', async () => {
        const noSelectorEvent = { url: 'https://example.com', fileName: 'out.md' };
        const mockPage = {
            goto: jest.fn().mockResolvedValue({}),
            content: jest.fn().mockResolvedValue('<html><head><title>Test</title></head><body><p>Plain text article body</p></body></html>'),
            close: jest.fn(),
        };
        const mockBrowser = {
            newPage: jest.fn().mockResolvedValue(mockPage),
            close: jest.fn(),
        };
        puppeteer.launch.mockResolvedValue(mockBrowser);
        nodePandoc.mockResolvedValue('Plain text article body');
        s3Mock.on(PutObjectCommand).resolves({});

        const result = await handler(noSelectorEvent);

        expect(result.statusCode).toBe(200);
        // readability path -> plain text input format for pandoc
        expect(nodePandoc).toHaveBeenCalledWith(expect.any(String), ['-f', 'plain', '-t', 'markdown']);
    });

    test('should return 400 if url is missing', async () => {
        const invalidEvent = { fileName: 'test.md' };
        const result = await handler(invalidEvent);
        expect(result.statusCode).toBe(400);
        expect(JSON.parse(result.body).error).toContain('url is required');
    });
});
