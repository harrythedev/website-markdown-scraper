import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

/**
 * Hydration Script: Loops through multiple pages of the Fruiting API
 * and invokes the Entrypoint Lambda for each page to ensure all historical
 * articles are processed and saved to S3.
 */

const FUNCTION_NAME = process.env.FUNCTION_NAME || "fruiting-crawler-EntrypointFunction-XXXXXXXXXX"; // Set FUNCTION_NAME env var or replace placeholder
const TOTAL_PAGES = 17;
const PAGE_SIZE = 24;

const lambda = new LambdaClient({ region: "us-east-1" });

const hydrate = async () => {
    console.log(`Starting hydration for ${TOTAL_PAGES} pages (size: ${PAGE_SIZE})...`);

    for (let page = 1; page <= TOTAL_PAGES; page++) {
        console.log(`\n--- Processing Page ${page}/${TOTAL_PAGES} ---`);

        const payload = {
            page: page,
            size: PAGE_SIZE,
            // Uses defaults from Entrypoint for articleBaseUrl and selector
        };

        try {
            const command = new InvokeCommand({
                FunctionName: FUNCTION_NAME,
                InvocationType: "RequestResponse", // Wait for response to see results in logs
                Payload: JSON.stringify(payload),
            });

            const response = await lambda.send(command);
            const result = JSON.parse(new TextDecoder().decode(response.Payload));

            console.log(`Page ${page} Result:`, result);
        } catch (error) {
            console.error(`Error processing page ${page}:`, error.message);
        }

        // Small delay to avoid hitting rate limits or overwhelming the Parser Lambda too fast
        await new Promise(resolve => setTimeout(resolve, 5000));
    }

    console.log("\n--- Hydration Complete ---");
};

hydrate().catch(console.error);
