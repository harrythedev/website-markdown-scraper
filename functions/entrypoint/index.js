// --- Dependencies ---
// AWS SDK S3: check if article already exists in S3
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";
// AWS SDK Lambda: invoke Parser Lambda for new articles
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

// --- S3 Check ---
// Returns true if the file already exists in S3, false otherwise
const fileExistsInS3 = async (s3, bucketName, key) => {
    try {
        await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
        return true; // file exists → already processed
    } catch (error) {
        if (error.name === "NotFound" || error.$metadata?.httpStatusCode === 404) {
            return false; // file does not exist → new article
        }
        throw error; // unexpected error → propagate
    }
};

// --- Parser Invocation ---
// Invokes the Parser Lambda asynchronously for a single article
const invokeParser = async (lambda, parserFunctionName, article, articleBaseUrl, selector) => {
    const payload = {
        url: `${articleBaseUrl}${article.id}`,
        selector: selector,
        fileName: `${article.id}.md`,
    };

    console.log(`Invoking parser for article: ${article.id} (${article.title})`);

    await lambda.send(new InvokeCommand({
        FunctionName: parserFunctionName,
        InvocationType: "Event",  // async — fire-and-forget
        Payload: JSON.stringify(payload),
    }));
};

// --- Lambda Handler ---
// Triggered by EventBridge every hour.
// Expected event: { apiUrl, articleBaseUrl, selector }
export const handler = async (event) => {
    const bucketName = process.env.BUCKET_NAME;
    const parserFunctionName = process.env.PARSER_FUNCTION_NAME;

    // Use parameters from event or fallback to defaults
    let apiUrl = event.apiUrl;
    const page = event.page || 1;
    const size = event.size || 10;

    if (!apiUrl) {
        apiUrl = `https://api.fruiting.co.kr/api/v1/list/all?exclude_filter_code=menu_code:ads,menu_code:gallery&page=${page}&size=${size}`;
    }

    const articleBaseUrl = event.articleBaseUrl || "https://www.fruiting.co.kr/board/board-view?id=";
    const selector = event.selector || ".board-cont";

    console.log(`Checking for new articles...`);
    console.log(`API: ${apiUrl} (Page: ${page}, Size: ${size})`);
    console.log(`Bucket: ${bucketName}, Parser: ${parserFunctionName}`);

    // 1. Fetch latest articles from Fruiting API
    const response = await fetch(apiUrl);
    if (!response.ok) {
        throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }

    const json = await response.json();
    if (!json.result || !Array.isArray(json.data)) {
        throw new Error(`Unexpected API response format: ${JSON.stringify(json).slice(0, 200)}`);
    }

    const articles = json.data;
    console.log(`Fetched ${articles.length} articles from API`);

    // 2. Check each article against S3
    const s3 = new S3Client({});
    const lambda = new LambdaClient({});

    const newArticles = [];
    const skipped = [];

    for (const article of articles) {
        const fileName = `${article.id}.md`;
        const exists = await fileExistsInS3(s3, bucketName, fileName);

        if (exists) {
            console.log(`Skipping (already exists): ${article.id}`);
            skipped.push(article.id);
        } else {
            newArticles.push(article);
        }
    }

    console.log(`New: ${newArticles.length}, Skipped: ${skipped.length}`);

    // 3. Invoke parser for each new article (separately)
    for (const article of newArticles) {
        await invokeParser(lambda, parserFunctionName, article, articleBaseUrl, selector);
    }

    return {
        processed: newArticles.length,
        skipped: skipped.length,
        newArticles: newArticles.map((a) => a.id),
    };
};
