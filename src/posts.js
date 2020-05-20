const Apify = require('apify');
const { getCheckedVariable, log } = require('./helpers');
const { PAGE_TYPES, GRAPHQL_ENDPOINT } = require('./consts');

const initData = {};
const posts = {};

/**
 * Takes type of page and data loaded through GraphQL and outputs
 * correct list of posts based on the page type.
 * @param {String} pageType Type of page we are scraping posts from
 * @param {Object} data GraphQL data
 */
const getPostsFromGraphQL = (pageType, data) => {
    let timeline;
    switch (pageType) {
        case PAGE_TYPES.PLACE:
            timeline = data.location.edge_location_to_media;
            break;
        case PAGE_TYPES.PROFILE:
            timeline = data && data.user && data.user.edge_owner_to_timeline_media;
            break;
        case PAGE_TYPES.HASHTAG:
            timeline = data.hashtag.edge_hashtag_to_media;
            break;
        default: throw new Error('Not supported');
    }
    const postItems = timeline ? timeline.edges : [];
    const hasNextPage = timeline ? timeline.page_info.has_next_page : false;
    return { posts: postItems, hasNextPage };
};

/**
 * Takes type of page and it's initial loaded data and outputs
 * correct list of posts based on the page type.
 * @param {String} pageType Type of page we are scraping posts from
 * @param {Object} data GraphQL data
 */
const getPostsFromEntryData = (pageType, data) => {
    let pageData;
    switch (pageType) {
        case PAGE_TYPES.PLACE:
            pageData = data.LocationsPage;
            break;
        case PAGE_TYPES.PROFILE:
            pageData = data.ProfilePage;
            break;
        case PAGE_TYPES.HASHTAG:
            pageData = data.TagPage;
            break;
        default: throw new Error('Not supported');
    }
    if (!pageData || !pageData.length) return null;

    return getPostsFromGraphQL(pageType, pageData[0].graphql);
};

/**
 * Attempts to scroll window and waits for XHR response, when response is fired
 * it returns back to caller, else it retries the attempt again.
 * @param {Object} pageData Object containing parsed page data
 * @param {Object} page Puppeteer Page object
 * @param {Integer} retry Retry attempts counter
 */
const loadMore = async (pageData, page, retry = 0) => {
    await page.keyboard.press('PageUp');
    const checkedVariable = getCheckedVariable(pageData.pageType);
    const responsePromise = page.waitForResponse(
        (response) => {
            const responseUrl = response.url();
            return responseUrl.startsWith(GRAPHQL_ENDPOINT)
                && responseUrl.includes(checkedVariable)
                && responseUrl.includes('%22first%22');
        },
        { timeout: 20000 },
    ).catch(() => null);

    let clicked;
    for (let i = 0; i < 10; i++) {
        const elements = await page.$x("//div[contains(text(), 'Show More Posts')]");
        if (elements.length === 0) {
            break;
        }
        const [button] = elements;

        clicked = await Promise.all([
            button.click(),
            page.waitForRequest(
                (request) => {
                    const requestUrl = request.url();
                    return requestUrl.startsWith(GRAPHQL_ENDPOINT)
                        && requestUrl.includes(checkedVariable)
                        && requestUrl.includes('%22first%22');
                },
                {
                    timeout: 1000,
                },
            ).catch(() => null),
        ]);
        if (clicked[1]) break;
    }

    let scrolled;
    for (let i = 0; i < 10; i++) {
        scrolled = await Promise.all([
            // eslint-disable-next-line no-restricted-globals
            page.evaluate(() => scrollBy(0, 9999999)),
            page.waitForRequest(
                (request) => {
                    const requestUrl = request.url();
                    return requestUrl.startsWith(GRAPHQL_ENDPOINT)
                        && requestUrl.includes(checkedVariable)
                        && requestUrl.includes('%22first%22');
                },
                {
                    timeout: 1000,
                },
            ).catch(() => null),
        ]);
        if (scrolled[1]) break;
    }

    let data = null;
    if (scrolled[1]) {
        try {
            const response = await responsePromise;
            const json = await response.json();
            // eslint-disable-next-line prefer-destructuring
            if (json) data = json.data;
        } catch (error) {
            Apify.utils.log.error(error);
        }
    }

    if (!data && retry < 10 && (scrolled[1] || retry < 5)) {
        const retryDelay = retry ? ++retry * retry * 1000 : ++retry * 1000;
        log(pageData, `Retry scroll after ${retryDelay / 1000} seconds`);
        await page.waitFor(retryDelay);
        const returnData = await loadMore(pageData, page, retry);
        return returnData;
    }

    await page.waitFor(500);
    return data;
};

/**
 * Scrolls page and loads data until the limit is reached or the page has no more posts
 * @param {Object} pageData
 * @param {Object} page
 * @param {Object} request
 * @param {Number} length
 */
const finiteScroll = async (pageData, page, request, length = 0) => {
    const data = await loadMore(pageData, page);
    if (data) {
        const timeline = getPostsFromGraphQL(pageData.pageType, data);
        if (!timeline.hasNextPage) return;
    }

    await page.waitFor(1500); // prevent rate limited error

    if (posts[pageData.id].length < request.userData.limit && posts[pageData.id].length !== length) {
        await finiteScroll(pageData, page, request, posts[pageData.id].length);
    }
};

const scrapePost = (request, itemSpec, entryData) => {
    const item = entryData.PostPage[0].graphql.shortcode_media;

    return {
        '#debug': {
            ...Apify.utils.createRequestDebugInfo(request),
            ...itemSpec,
            shortcode: item.shortcode,
            postLocationId: (item.location && item.location.id) || null,
            postOwnerId: (item.owner && item.owner.id) || null,
        },
        alt: item.accessibility_caption,
        url: `https://www.instagram.com/p/${item.shortcode}`,
        likesCount: item.edge_media_preview_like.count,
        imageUrl: item.display_url,
        firstComment: item.edge_media_to_caption.edges[0] && item.edge_media_to_caption.edges[0].node.text,
        timestamp: new Date(parseInt(item.taken_at_timestamp, 10) * 1000),
        locationName: (item.location && item.location.name) || null,
        ownerUsername: (item.owner && item.owner.username) || null,
    };
};

/**
 * Takes data from entry data and from loaded xhr requests and parses them into final output.
 * @param {Object} page Puppeteer Page object
 * @param {Object} request Apify Request object
 * @param {Object} itemSpec Parsed page data
 * @param {Object} entryData data from window._shared_data.entry_data
 * @param {Object} privateUserCallback a callback to be called when the profile scraped is private
 */
const scrapePosts = async (page, request, itemSpec, entryData, requestQueue, privateUserCallback) => {
    const timeline = getPostsFromEntryData(itemSpec.pageType, entryData);
    initData[itemSpec.id] = timeline;

    if (initData[itemSpec.id]) {
        posts[itemSpec.id] = timeline.posts;
        log(page.itemSpec, `${timeline.posts.length} items added, ${posts[page.itemSpec.id].length} items total`);
    } else {
        log(itemSpec, 'Waiting for initial data to load');
        while (!initData[itemSpec.id]) await page.waitFor(100);
    }

    await page.waitFor(500);

    const hasMostRecentPostsOnHashtagPage = itemSpec.pageType === PAGE_TYPES.HASHTAG
        ? await page.evaluate(() => document.querySelector('article > h2') !== null
        && document.querySelector('article > h2').textContent === 'Most recent')
        : true;

    if (initData[itemSpec.id].hasNextPage && posts[itemSpec.id].length < request.userData.limit && hasMostRecentPostsOnHashtagPage) {
        await page.waitFor(1000);
        await finiteScroll(itemSpec, page, request, posts.length);
    }

    const output = posts[itemSpec.id].map(item => ({
        '#debug': {
            ...Apify.utils.createRequestDebugInfo(request),
            ...itemSpec,
            shortcode: item.node.shortcode,
            postLocationId: (item.node.location && item.node.location.id) || null,
            postOwnerId: (item.node.owner && item.node.owner.id) || null,
        },
        alt: item.node.accessibility_caption,
        url: `https://www.instagram.com/p/${item.node.shortcode}`,
        likesCount: item.node.edge_media_preview_like.count,
        imageUrl: item.node.display_url,
        firstComment: item.node.edge_media_to_caption.edges[0] && item.node.edge_media_to_caption.edges[0].node.text,
        timestamp: new Date(parseInt(item.node.taken_at_timestamp, 10) * 1000),
        locationName: (item.node.location && item.node.location.name) || null,
        // usable by appending https://www.instagram.com/explore/locations/ to see the location
        locationId: (item.node.location && item.node.location.id) || null,
        ownerUsername: (item.node.owner && item.node.owner.username) || null,
    })).slice(0, request.userData.limit);

    for (const post of output) {
        if (itemSpec.pageType !== PAGE_TYPES.PROFILE && (post.locationName === null || post.ownerUsername === null)) {
            // Try to scrape at post detail
            await requestQueue.addRequest({ url: post.url, userData: { label: 'postDetail' } });
        } else {
            await Apify.pushData(post);
        }
    }

    const userIsPrivate = output.length === 0;
    if (userIsPrivate) {
        privateUserCallback(page.url())
    }
    log(itemSpec, `${output.length} items saved, task finished`);
};

/**
 * Catches GraphQL responses and if they contain post data, it stores the data
 * to the global variable.
 * @param {Object} page Puppeteer Page object
 * @param {Object} response Puppeteer Response object
 */
async function handlePostsGraphQLResponse(page, response) {
    const responseUrl = response.url();

    // Get variable we look for in the query string of request
    const checkedVariable = getCheckedVariable(page.itemSpec.pageType);

    // Skip queries for other stuff then posts
    if (!responseUrl.includes(checkedVariable) || !responseUrl.includes('%22first%22')) return;

    const data = await response.json();

    const timeline = getPostsFromGraphQL(page.itemSpec.pageType, data.data);

    posts[page.itemSpec.id] = posts[page.itemSpec.id].concat(timeline.posts);

    if (!initData[page.itemSpec.id]) initData[page.itemSpec.id] = timeline;
    else if (initData[page.itemSpec.id].hasNextPage && !timeline.hasNextPage) {
        initData[page.itemSpec.id].hasNextPage = false;
    }

    log(page.itemSpec, `${timeline.posts.length} items added, ${posts[page.itemSpec.id].length} items total`);
}

module.exports = {
    scrapePost,
    scrapePosts,
    handlePostsGraphQLResponse,
};
