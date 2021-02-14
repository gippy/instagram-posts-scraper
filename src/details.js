const Apify = require('apify');
const Puppeteer = require('puppeteer'); // eslint-disable-line no-unused-vars
const { log, parseCaption, loadXHR } = require('./helpers');
const { PAGE_TYPES } = require('./consts');
const { getPostLikes } = require('./likes');
const { getProfileFollowedBy } = require('./followed_by');
const { getProfileFollowing } = require('./following');
const { xhrNotLoaded } = require('./errors');

const { sleep } = Apify.utils;

// Formats IGTV Video Post edge item into nicely formated output item
const formatIGTVVideo = (edge) => {
    const { node } = edge;
    return {
        type: 'Video',
        shortCode: node.shortcode,
        title: node.title,
        caption: node.edge_media_to_caption.edges.length ? node.edge_media_to_caption.edges[0].node.text : '',
        commentsCount: node.edge_media_to_comment.count,
        commentsDisabled: node.comments_disabled,
        dimensionsHeight: node.dimensions.height,
        dimensionsWidth: node.dimensions.width,
        displayUrl: node.display_url,
        likesCount: node.edge_liked_by ? node.edge_liked_by.count : null,
        videoDuration: node.video_duration || 0,
        videoViewCount: node.video_view_count,
    };
};

// Formats list of display recources into URLs
const formatDisplayResources = (resources) => {
    if (!resources) return [];
    return resources.map((resource) => resource.node.display_url);
};

// Format Post Edge item into cleaner output
const formatSinglePost = (node) => {
    const comments = node.edge_media_to_comment || node.edge_media_to_parent_comment || node.edge_media_preview_comment;
    const likes = node.edge_liked_by || node.edge_media_preview_like;
    const caption = (node.edge_media_to_caption && node.edge_media_to_caption.edges.length) ? node.edge_media_to_caption.edges[0].node.text : '';
    const { hashtags, mentions } = parseCaption(caption);

    const user = node.user
    const bio = user && user.biography;
    const numFollowers = user && user.edge_followed_by && user.edge_followed_by.count;
    const numFollowing = user && user.edge_follow && user.edge_follow.count;
    const numPosts =  user && user.edge_owner_to_timeline_media && user.edge_owner_to_timeline_media.count;

    return {
        // eslint-disable-next-line no-nested-ternary
        type: node.__typename ? node.__typename.replace('Graph', '') : (node.is_video ? 'Video' : 'Image'),
        shortCode: node.shortcode,
        caption,
        hashtags,
        mentions,
        url: `https://www.instagram.com/p/${node.shortcode}`,
        commentsCount: comments ? comments.count : null,
        latestComments: comments && comments.edges ? comments.edges.map((edge) => ({
            ownerUsername: edge.node.owner ? edge.node.owner.username : '',
            text: edge.node.text,
        })).reverse() : [],
        dimensionsHeight: node.dimensions.height,
        dimensionsWidth: node.dimensions.width,
        displayUrl: node.display_url,
        videoUrl: node.video_url,
        id: node.id,
        firstComment: comments && comments.edges && comments.edges[0] && comments.edges[0].node.text,
        alt: node.accessibility_caption,
        likesCount: likes ? likes.count : null,
        videoDuration: node.video_duration,
        videoViewCount: node.video_view_count,
        timestamp: node.taken_at_timestamp ? new Date(parseInt(node.taken_at_timestamp, 10) * 1000) : null,
        locationName: node.location ? node.location.name : null,
        locationId: node.location ? node.location.id : null,
        ownerFullName: node.owner ? node.owner.full_name : null,
        ownerUsername: node.owner ? node.owner.username : null,
        ownerId: node.owner ? node.owner.id : null,
        ownerBio: bio || null,
        ownerNumPosts: numPosts || null,
        ownerNumFollowers: numFollowers || null,
        ownerNumFollowing: numFollowing || null,
    };
};

// Translates word to have first letter uppercased so word will become Word
const uppercaseFirstLetter = (word) => {
    const uppercasedLetter = word.charAt(0).toUpperCase();
    const restOfTheWord = word.slice(1);
    return `${uppercasedLetter}${restOfTheWord}`;
};
// Formats address in JSON into an object
const formatJSONAddress = (jsonAddress) => {
    if (!jsonAddress) return '';
    let address;
    try {
        address = JSON.parse(jsonAddress);
    } catch (err) {
        return '';
    }
    const result = {};
    Object.keys(address).forEach((key) => {
        const parsedKey = key.split('_').map(uppercaseFirstLetter).join('');
        result[`address${parsedKey}`] = address[key];
    });
    return result;
};

// Formats data from window._shared_data.entry_data.ProfilePage[0].graphql.user to nicer output
const formatProfileOutput = async (input, request, data, page, itemSpec) => {
    const following = await getProfileFollowing(page, itemSpec, input);
    const followedBy = await getProfileFollowedBy(page, itemSpec, input);
    return {
        '#debug': Apify.utils.createRequestDebugInfo(request),
        id: data.id,
        username: data.username,
        fullName: data.full_name,
        biography: data.biography,
        externalUrl: data.external_url,
        externalUrlShimmed: data.external_url_linkshimmed,
        followersCount: data.edge_followed_by.count,
        followsCount: data.edge_follow.count,
        hasChannel: data.has_channel,
        highlightReelCount: data.highlight_reel_count,
        isBusinessAccount: data.is_business_account,
        joinedRecently: data.is_joined_recently,
        businessCategoryName: data.business_category_name,
        private: data.is_private,
        verified: data.is_verified,
        profilePicUrl: data.profile_pic_url,
        profilePicUrlHD: data.profile_pic_url_hd,
        facebookPage: data.connected_fb_page,
        igtvVideoCount: data.edge_felix_video_timeline.count,
        latestIgtvVideos: data.edge_felix_video_timeline ? data.edge_felix_video_timeline.edges.map(formatIGTVVideo) : [],
        postsCount: data.edge_owner_to_timeline_media.count,
        latestPosts: data.edge_owner_to_timeline_media ? data.edge_owner_to_timeline_media.edges.map((edge) => edge.node).map(formatSinglePost) : [],
        following,
        followedBy,
        has_public_story: data.has_public_story,
    };
};

// Formats data from window._shared_data.entry_data.LocationPage[0].graphql.location to nicer output
const formatPlaceOutput = (request, data) => ({
    '#debug': Apify.utils.createRequestDebugInfo(request),
    id: data.id,
    name: data.name,
    public: data.has_public_page,
    lat: data.lat,
    lng: data.lng,
    slug: data.slug,
    description: data.blurb,
    website: data.website,
    phone: data.phone,
    aliasOnFacebook: data.primary_alias_on_fb,
    ...formatJSONAddress(data.address_json),
    profilePicUrl: data.profile_pic_url,
    postsCount: data.edge_location_to_media.count,
    topPosts: data.edge_location_to_top_posts ? data.edge_location_to_top_posts.edges.map((edge) => edge.node).map(formatSinglePost) : [],
    latestPosts: data.edge_location_to_media ? data.edge_location_to_media.edges.map((edge) => edge.node).map(formatSinglePost) : [],
});

// Formats data from window._shared_data.entry_data.TagPage[0].graphql.hashtag to nicer output
const formatHashtagOutput = (request, data) => ({
    '#debug': Apify.utils.createRequestDebugInfo(request),
    id: data.id,
    name: data.name,
    public: data.has_public_page,
    topPostsOnly: data.is_top_media_only,
    profilePicUrl: data.profile_pic_url,
    postsCount: data.edge_hashtag_to_media.count,
    topPosts: data.edge_hashtag_to_top_posts ? data.edge_hashtag_to_top_posts.edges.map((edge) => edge.node).map(formatSinglePost) : [],
    latestPosts: data.edge_hashtag_to_media ? data.edge_hashtag_to_media.edges.map((edge) => edge.node).map(formatSinglePost) : [],
});

// Formats data from window._shared_data.entry_data.PostPage[0].graphql.shortcode_media to nicer output
const formatPostOutput = async (input, request, data, page, itemSpec) => {
    const likedBy = await getPostLikes(page, itemSpec, input);
    return {
        '#debug': Apify.utils.createRequestDebugInfo(request),
        ...formatSinglePost(data),
        captionIsEdited: typeof data.caption_is_edited !== 'undefined' ? data.caption_is_edited : null,
        hasRankedComments: data.has_ranked_comments,
        commentsDisabled: data.comments_disabled,
        displayResourceUrls: data.edge_sidecar_to_children ? formatDisplayResources(data.edge_sidecar_to_children.edges) : null,
        childPosts: data.edge_sidecar_to_children ? data.edge_sidecar_to_children.edges.map((child) => formatSinglePost(child.node)) : null,
        locationSlug: data.location ? data.location.slug : null,
        isAdvertisement: typeof data.is_ad !== 'undefined' ? data.is_ad : null,
        taggedUsers: data.edge_media_to_tagged_user ? data.edge_media_to_tagged_user.edges.map((edge) => edge.node.user.username) : [],
        likedBy,
    };
};

// Finds correct variable in window._shared_data.entry_data based on pageType
const getOutputFromEntryData = async ({ input, itemSpec, request, entryData, page }) => {
    switch (itemSpec.pageType) {
        case PAGE_TYPES.PLACE:
            return formatPlaceOutput(request, entryData.LocationsPage[0].graphql.location);
        case PAGE_TYPES.PROFILE:
            return formatProfileOutput(input, request, entryData.ProfilePage[0].graphql.user, page, itemSpec);
        case PAGE_TYPES.HASHTAG:
            return formatHashtagOutput(request, entryData.TagPage[0].graphql.hashtag);
        case PAGE_TYPES.POST:
            return formatPostOutput(input, request, entryData.PostPage[0].graphql.shortcode_media, page, itemSpec);
        default:
            throw new Error('Not supported');
    }
};

// Takes correct variable from window object and formats it into proper output
const scrapeDetails = async ({ input, request, itemSpec, data, page, proxy, includeHasStories, proxyUrl }) => {
    const entryData = data.entry_data;
    let hasPublicStories;
    if (includeHasStories) hasPublicStories = await loadHasPublicStories(request, page, data, proxyUrl);

    const output = await getOutputFromEntryData({ input, itemSpec, request, entryData, page });

    if (includeHasStories) output.hasPublicStory = hasPublicStories;

    await Apify.pushData(output);

    log(itemSpec, 'Page details saved, task finished');
};

/**
 * Load has_public_story from separate XHR request
 * @param {Request} request
 * @param {Puppeteer.Page} page
 * @param {Object} data
 * @param {String} proxyUrl
 * @returns {Promise<*>}
 */
const loadHasPublicStories = async (request, page, data, proxyUrl) => {
    const { csrf_token } = data.config;
    if (!data.entry_data.ProfilePage) throw 'Not a profile page';
    const userId = data.entry_data.ProfilePage[0].graphql.user.id;
    const url = `https://www.instagram.com/graphql/query/?query_hash=d4d88dc1500312af6f937f7b804c68c3&variables=%7B%22user_id%22%3A%22${userId}%22%2C%22include_chaining%22%3Afalse%2C%22include_reel%22%3Afalse%2C%22include_suggested_users%22%3Afalse%2C%22include_logged_out_extras%22%3Atrue%2C%22include_highlight_reels%22%3Afalse%2C%22include_live_status%22%3Atrue%7D`;

    const response = await loadXHR({ request, page, url, csrf_token, proxyUrl });

    if (response.statusCode === 200) {
        const responseData = JSON.parse(response.body);
        return responseData.data.user.has_public_story;
    }
    throw 'XHR for hasPublicStory not loaded correctly.';
};

module.exports = {
    scrapeDetails,
    formatSinglePost,
};
