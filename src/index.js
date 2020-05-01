const Apify = require('apify');
const safeEval = require('safe-eval');
const _ = require('underscore');

const { log } = Apify.utils;
const { scrapePosts, handlePostsGraphQLResponse, scrapePost } = require('./posts');
const { scrapeComments, handleCommentsGraphQLResponse } = require('./comments');
const { scrapeDetails } = require('./details');
const { searchUrls } = require('./search');
const { getItemSpec } = require('./helpers');
const { GRAPHQL_ENDPOINT, ABORTED_RESOURCE_TYPES, SCRAPE_TYPES } = require('./consts');
const errors = require('./errors');

async function main() {
    const input = await Apify.getInput();
    const { proxy, resultsType, resultsLimit = 200 } = input;

    let extendOutputFunction;
    if (typeof input.extendOutputFunction === 'string' && input.extendOutputFunction.trim() !== '') {
        try {
            extendOutputFunction = safeEval(input.extendOutputFunction);
        } catch (e) {
            throw new Error(`'extendOutputFunction' is not valid Javascript! Error: ${e}`);
        }
        if (typeof extendOutputFunction !== 'function') {
            throw new Error('extendOutputFunction is not a function! Please fix it or use just default ouput!');
        }
    }

    const foundUrls = await searchUrls(input);
    const urls = [
        ...(input.directUrls || []),
        ...foundUrls,
    ];

    if (urls.length === 0) {
        Apify.utils.log.info('No URLs to process');
        process.exit(0);
    }

    try {
        if (!proxy) throw errors.proxyIsRequired();
        if (!resultsType) throw errors.typeIsRequired();
        if (!Object.values(SCRAPE_TYPES).includes(resultsType)) throw errors.unsupportedType(resultsType);
    } catch (error) {
        log.info('--  --  --  --  --');
        log.info(' ');
        Apify.utils.log.error('Run failed because the provided input is incorrect:');
        Apify.utils.log.error(error.message);
        log.info(' ');
        log.info('--  --  --  --  --');
        process.exit(1);
    }

    const requestListSources = urls.map(url => ({
        url,
        userData: { limit: resultsLimit },
    }));

    const requestList = await Apify.openRequestList('request-list', requestListSources);

    const gotoFunction = async ({ request, page }) => {
        await page.setRequestInterception(true);

        page.on('request', (req) => {
            if (
                ABORTED_RESOURCE_TYPES.includes(req.resourceType())
                || req.url().includes('map_tile.php')
                || req.url().includes('logging_client_events')
            ) {
                return req.abort();
            }

            req.continue();
        });

        page.on('response', async (response) => {
            const responseUrl = response.url();

            // Skip non graphql responses
            if (!responseUrl.startsWith(GRAPHQL_ENDPOINT)) return;

            // Wait for the page to parse it's data
            while (!page.itemSpec) await page.waitFor(100);

            switch (resultsType) {
                case SCRAPE_TYPES.POSTS: return handlePostsGraphQLResponse(page, response)
                    .catch(error => Apify.utils.log.error(error));
                case SCRAPE_TYPES.COMMENTS: return handleCommentsGraphQLResponse(page, response)
                    .catch(error => Apify.utils.log.error(error));
                // no default
            }
        });

        return page.goto(request.url, {
            // itemSpec timeouts
            timeout: 60 * 1000,
        });
    };

    const handlePageFunction = async ({ page, request, response }) => {
        if (response.status() === 404) {
            Apify.utils.log.info(`Page "${request.url}" does not exist.`);
            return;
        }
        // eslint-disable-next-line no-underscore-dangle
        await page.waitFor(() => (!window.__initialData.pending && window.__initialData && window.__initialData.data), { timeout: 20000 });
        // eslint-disable-next-line no-underscore-dangle
        const { pending, data } = await page.evaluate(() => window.__initialData);
        if (pending) throw new Error('Page took too long to load initial data, trying again.');
        if (!data || !data.entry_data) throw new Error('Page does not contain initial data, trying again.');
        const { entry_data: entryData } = data;

        const itemSpec = getItemSpec(entryData);

        let userResult = {};
        if (extendOutputFunction) {
            userResult = await page.evaluate((functionStr) => {
                // eslint-disable-next-line no-eval
                const f = eval(functionStr);
                return f();
            }, input.extendOutputFunction);
        }

        if (request.userData.label === 'postDetail') {
            const result = scrapePost(request, itemSpec, entryData);
            _.extend(result, userResult);

            await Apify.pushData(result);
        } else {
            page.itemSpec = itemSpec;

            switch (resultsType) {
                case SCRAPE_TYPES.POSTS: return scrapePosts(page, request, itemSpec, entryData, requestQueue);
                case SCRAPE_TYPES.COMMENTS: return scrapeComments(page, request, itemSpec, entryData);
                case SCRAPE_TYPES.DETAILS: return scrapeDetails(request, itemSpec, entryData, userResult);
                default: throw new Error('Not supported');
            }
        }
    };

    if (proxy.apifyProxyGroups && proxy.apifyProxyGroups.length === 0) delete proxy.apifyProxyGroups;

    const requestQueue = await Apify.openRequestQueue();

    const crawler = new Apify.PuppeteerCrawler({
        requestList,
        requestQueue,
        gotoFunction,
        puppeteerPoolOptions: {
            maxOpenPagesPerInstance: 1,
            retireInstanceAfterRequestCount: 30,
        },
        launchPuppeteerOptions: {
            ...proxy,
            headless: true,
            stealth: true,
            ignoreHTTPSErrors: true,
            args: ['--enable-features=NetworkService', '--ignore-certificate-errors'],
        },
        maxConcurrency: 100,
        handlePageTimeoutSecs: 300 * 60, // Ex: 5 hours to crawl thousands of comments
        handlePageFunction,

        // If request failed 4 times then this function is executed.
        handleFailedRequestFunction: async ({ request }) => {
            Apify.utils.log.error(`${request.url}: Request ${request.url} failed 4 times`);
            await Apify.pushData({
                '#debug': Apify.utils.createRequestDebugInfo(request),
                '#error': request.url,
            });
        },
    });

    await crawler.run();
}

module.exports = main;
