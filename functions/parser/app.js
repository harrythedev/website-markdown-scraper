// --- Dependencies ---
// Mozilla Readability: extracts main article content from a webpage
import { Readability } from "@mozilla/readability";
// JSDOM: creates a virtual DOM from raw HTML for server-side parsing
import { JSDOM } from "jsdom";
// node-pandoc-promise: converts content between formats (e.g. HTML → Markdown)
import nodePandoc from "node-pandoc-promise";
// puppeteer-core: headless browser automation (no bundled Chromium)
import puppeteer from "puppeteer-core";
// @sparticuz/chromium: Lambda-compatible Chromium binary for puppeteer-core
import chromium from "@sparticuz/chromium";
// AWS SDK S3 client: for uploading output files to S3
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// --- Article Parsing ---
// Launches a headless browser, navigates to the URL, and extracts content
// using either a CSS selector (innerHTML) or Mozilla Readability (textContent).
const parseArticle = async (url, selector) => {
    console.log(`Fetching: ${url} using Puppeteer Core + @sparticuz/chromium (x86_64)`);

    // Launch Chromium with Lambda-optimised settings from @sparticuz/chromium
    const browser = await puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPSErrors: true,
    });

    try {
        const page = await browser.newPage();

        // Navigate to the target URL; wait until network is idle
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        // If a selector is provided, wait for it to appear (best-effort)
        if (selector) {
            try {
                await page.waitForSelector(selector, { timeout: 5000 });
            } catch (e) {
                // Selector not found within timeout — proceed anyway
                console.warn(`Selector '${selector}' not found within timeout.`);
            }
        }

        // Get the fully rendered HTML and parse it into a virtual DOM
        const html = await page.content();
        const dom = new JSDOM(html, { url });

        let contentToParse = '';
        let metadata = {};

        if (selector) {
            // --- Selector path ---
            // Extract the innerHTML of the matched element
            console.log(`Using custom selector: ${selector}`);
            const element = dom.window.document.querySelector(selector);
            if (!element) {
                throw new Error(`Element matching selector '${selector}' not found on the page.`);
            }
            contentToParse = element.innerHTML; // HTML string → pandoc will receive 'html'
            metadata = {
                title: dom.window.document.title,
                extractedVia: 'selector',
            };
        } else {
            // --- Readability path ---
            // Use Mozilla Readability to extract the main article as plain text
            console.log('Using Readability for extraction...');
            const reader = new Readability(dom.window.document);
            const article = reader.parse();
            if (!article) {
                throw new Error('Failed to parse article content');
            }
            contentToParse = article.textContent; // plain text → pandoc will receive 'plain'
            metadata = {
                title: article.title,
                byline: article.byline,
                excerpt: article.excerpt,
                extractedVia: 'readability',
            };
        }

        // --- Pandoc Conversion ---
        // Determine input format: selector provides HTML, readability provides plain text
        console.log('Converting to Markdown with pandoc...');
        const inputFormat = selector ? 'html' : 'plain';
        const markdown = await nodePandoc(contentToParse, ['-f', inputFormat, '-t', 'markdown']);

        return { markdown, metadata };
    } finally {
        // Always close the browser to free resources
        await browser.close();
    }
};

// --- S3 Upload ---
// Uploads the converted Markdown content to the configured S3 bucket
const uploadToS3 = async (fileName, content) => {
    const s3 = new S3Client({});
    const bucketName = process.env.BUCKET_NAME; // injected via Lambda env var (template.yaml)

    const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: fileName,           // e.g. "2026-03-06_article.md"
        Body: content,
        ContentType: 'text/markdown',
    });

    await s3.send(command);
    console.log(`Uploaded to s3://${bucketName}/${fileName}`);
    return bucketName;
};

// --- Lambda Handler ---
// Entry point invoked by another Lambda function.
// Expected event shape: { url: string, selector?: string, fileName: string }
export const handler = async (event) => {
    console.log(`Runtime Architecture: ${process.arch}`);
    console.log(`Platform: ${process.platform}`);

    const { url, selector, fileName } = event;

    // Validate required fields
    if (!url) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'url is required' }),
        };
    }

    if (!fileName) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'fileName is required' }),
        };
    }

    try {
        // Parse the article and upload the resulting Markdown to S3
        const { markdown, metadata } = await parseArticle(url, selector);
        const bucketName = await uploadToS3(fileName, markdown);

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: `Successfully saved to s3://${bucketName}/${fileName}`,
                fileName,
                ...metadata, // title, byline, excerpt, extractedVia
            }),
        };
    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message }),
        };
    }
};
