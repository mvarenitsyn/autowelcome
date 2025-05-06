const puppeteer = require('puppeteer');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const tough = require('tough-cookie');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// MongoDB connection settings
const mongoUri = process.env.MONGODB_URI;
const dbName = process.env.DB_NAME || 'instagram_bot';
const collectionName = process.env.COLLECTION_NAME || 'processed_users';

/**
 * Connects to MongoDB
 */
async function connectToMongoDB() {
    const client = new MongoClient(mongoUri);

    try {
        await client.connect();
        console.log('Connected to MongoDB');

        const db = client.db(dbName);

        // Create collection if it doesn't exist
        const collections = await db.listCollections({ name: collectionName }).toArray();
        if (collections.length === 0) {
            await db.createCollection(collectionName);
            console.log(`Collection ${collectionName} created`);
        }

        const collection = db.collection(collectionName);

        return { client, collection };
    } catch (error) {
        console.error('Error connecting to MongoDB:', error);
        await client.close();
        throw error;
    }
}

/**
 * Load cookies from a JSON file or buffer
 */
function loadCookies(cookieInput) {
    try {
        let cookiesString;

        // Debug information
        console.log('Cookie input type:', typeof cookieInput);

        if (Buffer.isBuffer(cookieInput)) {
            // Handle direct buffer
            cookiesString = cookieInput.toString('utf8');
            console.log('Processing as direct buffer');
        } else if (typeof cookieInput === 'string' && fs.existsSync(cookieInput)) {
            // Handle direct file path
            cookiesString = fs.readFileSync(cookieInput, 'utf8');
            console.log('Processing as file path');
        } else if (typeof cookieInput === 'object' && cookieInput !== null) {
            // Handle various object formats
            console.log('Processing as object with keys:', Object.keys(cookieInput));

            // Case 1: Object with buffer property
            if (cookieInput.buffer) {
                cookiesString = Buffer.from(cookieInput.buffer).toString('utf8');
                console.log('Processing object with buffer property');
            }
            // Case 2: Multer file object (has path property and file exists)
            else if (cookieInput.path && fs.existsSync(cookieInput.path)) {
                cookiesString = fs.readFileSync(cookieInput.path, 'utf8');
                console.log('Processing multer file object with path:', cookieInput.path);
            }
            // Case 3: Object is a multer file (test additional properties)
            else if (cookieInput.fieldname === 'cookieFile' && cookieInput.originalname && cookieInput.path) {
                if (fs.existsSync(cookieInput.path)) {
                    cookiesString = fs.readFileSync(cookieInput.path, 'utf8');
                    console.log('Processing multer upload with path:', cookieInput.path);
                } else {
                    throw new Error(`Multer file not found at path: ${cookieInput.path}`);
                }
            } else {
                throw new Error('Invalid object structure for cookie input');
            }
        } else {
            throw new Error('Invalid cookie input');
        }
        const cookies = JSON.parse(cookiesString);

        // Transform cookies into tough-cookie format
        const cookieJar = new tough.CookieJar();
        cookies.forEach(cookie => {
            const cookieObj = new tough.Cookie({
                key: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path,
                secure: cookie.secure,
                httpOnly: cookie.httpOnly,
                expires: cookie.expirationDate ? new Date(cookie.expirationDate * 1000) : undefined,
            });

            cookieJar.setCookieSync(
                cookieObj.toString(),
                `https://${cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain}`
            );
        });

        console.log(`Loaded ${cookies.length} cookies from ${cookieInput}`);
        return { cookieJar, rawCookies: cookies };
    } catch (error) {
        console.error(`Error loading cookies from ${cookieInput}:`, error);
        throw error;
    }
}

/**
 * Initialize browser with cookies, supports browserless.io
 */
async function initBrowser(cookiesObj, headless = true, browserWSEndpoint = null) {
    let browser;
    if (browserWSEndpoint) {
        browser = await puppeteer.connect({
            browserWSEndpoint,
            defaultViewport: { width: 1280, height: 800 }
        });
    } else {
        browser = await puppeteer.launch({
            headless: headless ? 'new' : false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--window-size=1280,800',
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-extensions'
            ],
            defaultViewport: { width: 1280, height: 800 }
        });
    }

    const page = await browser.newPage();

    // Set a reasonable user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36');

    // Navigate to Instagram before setting cookies (cookies domain needs to match)
    await page.goto('https://www.instagram.com/');

    // Set cookies 
    const { rawCookies } = cookiesObj;
    const puppeteerCookies = rawCookies.map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expirationDate ? cookie.expirationDate : -1,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite || 'None'
    }));

    await page.setCookie(...puppeteerCookies);

    return { browser, page };
}

/**
 * Check notifications for new followers
 */
async function checkNotifications(page, collection, accountOwner) {
    try {
        console.log(`Checking notifications for new followers of ${accountOwner}...`);

        // Navigate to notifications page
        await page.goto('https://www.instagram.com/notifications/', { waitUntil: 'networkidle2' });

        // Wait for notification content to load
        await page.waitForSelector('body', { timeout: 30000 });

        // Scroll to load more notifications
        await autoScroll(page);

        // Extract follower notifications
        const newFollowers = await page.evaluate(() => {
            const followers = [];
            // Find all elements containing "started following you" text
            const elements = Array.from(document.querySelectorAll('div > div > div > span'));

            elements.forEach(element => {
                if (element.textContent.includes('started following you')) {
                    // Get the username from the link element
                    const usernameElement = element.closest('div').querySelector('a');
                    if (usernameElement) {
                        const username = usernameElement.textContent.trim();
                        if (username && !followers.includes(username)) {
                            followers.push(username);
                        }
                    }
                }
            });

            return followers;
        });

        console.log(`Found ${newFollowers.length} notifications about new followers`);

        // Filter out already processed users
        const unprocessedFollowers = [];
        for (const username of newFollowers) {
            const existingUser = await collection.findOne({
                followerUsername: username,
                accountOwner: accountOwner
            });
            if (!existingUser) {
                unprocessedFollowers.push(username);
            }
        }

        console.log(`${unprocessedFollowers.length} new followers to process`);
        return unprocessedFollowers;
    } catch (error) {
        console.error('Error checking notifications:', error);
        return [];
    }
}

/**
 * Auto-scroll to load more content
 */
async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 100;
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;

                if (totalHeight >= scrollHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 500);
        });
    });
}

/**
 * Sleep for a specified amount of time
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Load saved selectors from file
 */
function loadSelectors() {
    const selectorsFilePath = process.env.SELECTORS_FILE || 'instagram_selectors.json';
    try {
        if (fs.existsSync(selectorsFilePath)) {
            const selectorsData = fs.readFileSync(selectorsFilePath, 'utf8');
            return JSON.parse(selectorsData);
        } else {
            // Initialize with empty defaults
            return {
                messageButtons: [],
                optionsButtons: [],
                messageOptions: []
            };
        }
    } catch (error) {
        console.error(`Error loading selectors from ${selectorsFilePath}:`, error);
        return {
            messageButtons: [],
            optionsButtons: [],
            messageOptions: []
        };
    }
}

/**
 * Send welcome message to follower
 */
async function sendWelcomeMessage(page, username, message) {
    try {
        console.log(`Sending welcome message to ${username}...`);

        // Navigate to user's profile
        await page.goto(`https://www.instagram.com/${username}/`, { waitUntil: 'networkidle2' });
        await sleep(3000);

        // Load saved selectors
        const savedSelectors = loadSelectors();

        // Step 1: First try to find direct Message button on profile page
        console.log("Looking for direct Message button...");

        let messageButtonFound = false;
        const directMessageSelectors = [
            'div.x1i10hfl.xjqpnuy.xa49m3k.xqeqjp1.x2hbi6w.x972fbf.xcfux6l.x1qhh985.xm0m39n.xdl72j9.x2lah0s.xe8uvvx.xdj266r.x11i5rnm.xat24cr.x1mh8g0r.x2lwn1j.xeuugli.xexx8yu.x18d9i69.x1hl2dhg.xggy1nq.x1ja2u2z.x1t137rt.x1q0g3np.x1lku1pv.x1a2a7pz.x6s0dn4.xjyslct.x1lq5wgf.xgqcy7u.x30kzoy.x9jhf4c.x1ejq31n.xd10rxx.x1sy0etr.x17r0tee.x9f619.x1ypdohk.x78zum5.x1f6kntn.xwhw2v2.x10w6t97.xl56j7k.x17ydfre.x1swvt13.x1pi30zi.x1n2onr6.x2b8uid.xlyipyv.x87ps6o.x14atkfc.xcdnw81.x1i0vuye.x1gjpkn9.x5n08af.xsz8vos[role="button"]:has-text("Message")',
            'div.x1i10hfl.xjqpnuy.xa49m3k.xqeqjp1.x2hbi6w.x972fbf.xcfux6l.x1qhh985.xm0m39n.xdl72j9.x2lah0s.xe8uvvx.xdj266r.x11i5rnm.xat24cr.x1mh8g0r.x2lwn1j.xeuugli.xexx8yu.x18d9i69.x1hl2dhg.xggy1nq.x1ja2u2z.x1t137rt.x1q0g3np.x1lku1pv.x1a2a7pz.x6s0dn4.xjyslct.x1lq5wgf.xgqcy7u.x30kzoy.x9jhf4c.x1ejq31n.xd10rxx.x1sy0etr.x17r0tee.x9f619.x1ypdohk.x78zum5.x1f6kntn.xwhw2v2.x10w6t97.xl56j7k.x17ydfre.x1swvt13.x1pi30zi.x1n2onr6.x2b8uid.xlyipyv.x87ps6o.x14atkfc.xcdnw81.x1i0vuye.x1gjpkn9.x5n08af.xsz8vos[role="button"][tabindex="0"]:has-text("Message")',
            'div.x1i10hfl.xjqpnuy.xa49m3k.xqeqjp1.x2hbi6w.x972fbf.xcfux6l.x1qhh985.xm0m39n.xdl72j9.x2lah0s.xe8uvvx.xdj266r.x11i5rnm.xat24cr.x1mh8g0r.x2lwn1j.xeuugli.xexx8yu.x18d9i69.x1hl2dhg.xggy1nq.x1ja2u2z.x1t137rt.x1q0g3np.x1lku1pv.x1a2a7pz.x6s0dn4.xjyslct.x1lq5wgf.xgqcy7u.x30kzoy.x9jhf4c.x1ejq31n.xd10rxx.x1sy0etr.x17r0tee.x9f619.x1ypdohk.x78zum5.x1f6kntn.xwhw2v2.x10w6t97.xl56j7k.x17ydfre.x1swvt13.x1pi30zi.x1n2onr6.x2b8uid.xlyipyv.x87ps6o.x14atkfc.xcdnw81.x1i0vuye.x1gjpkn9.x5n08af.xsz8vos[role="button"][tabindex="0"]'
        ];

        // Try each direct message selector
        for (const selector of directMessageSelectors) {
            try {
                const elementExists = await page.evaluate((sel) => {
                    return !!document.querySelector(sel);
                }, selector);

                if (elementExists) {
                    await page.waitForSelector(selector, { timeout: 3000, visible: true });
                    await page.click(selector);
                    console.log(`Clicked direct message button using selector: ${selector}`);
                    messageButtonFound = true;

                    console.log("Waiting 3 seconds for 'Not Now' popup to appear...");
                    await sleep(3000);

                    // Check for "Not Now" popup after waiting
                    console.log("Checking for 'Not Now' popup after clicking Message button...");
                    try {
                        const notNowSelectors = [
                            'button._a9--._ap36._a9_1[tabindex="0"]',
                            'button._a9--._ap36._a9_1',
                            'button:has-text("Not Now")'
                        ];

                        let notNowFound = false;
                        for (const notNowSelector of notNowSelectors) {
                            const hasNotNow = await page.evaluate((sel) => {
                                return !!document.querySelector(sel);
                            }, notNowSelector);

                            if (hasNotNow) {
                                await page.waitForSelector(notNowSelector, { timeout: 2000, visible: true });
                                await page.click(notNowSelector);
                                console.log(`Clicked 'Not Now' button using selector: ${notNowSelector}`);
                                await sleep(2000);
                                notNowFound = true;
                                break;
                            }
                        }

                        if (!notNowFound) {
                            console.log("No 'Not Now' popup detected after Message button");
                        }
                    } catch (err) {
                        console.log("No 'Not Now' popup detected after Message button");
                    }

                    break;
                }
            } catch (err) {
                console.log(`Error with direct message selector ${selector}`);
            }
        }

        // If direct message button wasn't found, use the Options button approach
        if (!messageButtonFound) {
            // Try the Options button
            console.log("Looking for Options button...");

            let optionsClicked = false;
            const optionsSelectors = [
                'svg[aria-label="Options"][role="img"]',
                'svg[aria-label="Options"]',
                '[aria-label="Options"]',
                '[aria-label="More options"]'
            ];

            // Try option selectors
            for (const selector of optionsSelectors) {
                try {
                    const elementExists = await page.evaluate((sel) => {
                        return !!document.querySelector(sel);
                    }, selector);

                    if (elementExists) {
                        await page.waitForSelector(selector, { timeout: 3000, visible: true });
                        await page.click(selector);
                        console.log(`Clicked options button using selector: ${selector}`);
                        optionsClicked = true;
                        await sleep(3000);
                        break;
                    }
                } catch (err) {
                    console.log(`Error with options selector ${selector}`);
                }
            }

            if (!optionsClicked) {
                console.log(`Failed to click options button for ${username}`);
                return false;
            }

            // Click "Send message" in the popup
            console.log("Looking for 'Send message' button...");
            sleep(5000);
            let messageButtonClicked = false;
            const sendMessageSelectors = [
                // Exact path selector for the Send message button (highest priority)
                'body > div.x1n2onr6.xzkaem6 > div.x9f619.x1n2onr6.x1ja2u2z > div > div.x1uvtmcs.x4k7w5x.x1h91t0o.x1beo9mf.xaigb6o.x12ejxvf.x3igimt.xarpa2k.xedcshv.x1lytzrv.x1t2pt76.x7ja8zs.x1n2onr6.x1qrby5j.x1jfb8zj > div > div > div > div > div > button:nth-child(6)',
                // Simplified nth-child selector as backup
                'div.x1n2onr6.xzkaem6 button:nth-child(6)',
                // Position-based selector (6th button in the menu)
                'div > div > div > button:nth-child(6)',
                // More specific selectors that check for exact text content "Send message"
                'button.xjbqb8w.x1qhh985.xcfux6l.xm0m39n.x1yvgwvq.x13fuv20.x178xt8z.x1ypdohk.xvs91rp.x1evy7pa.xdj266r.x11i5rnm.xat24cr.x1mh8g0r.x1wxaq2x.x1iorvi4.x1sxyh0.xjkvuk6.xurb0ha.x2b8uid.x87ps6o.xxymvpz.xh8yej3.x52vrxo.x4gyw5p.x5n08af[tabindex="0"]:has-text("Send message")',
                // Using exact text matching with contains for better precision
                'button:has-text("Send message"):not(:has-text("Share"))',
                'button:has-text(/^Send message$/)',
                // Check for button elements specifically containing the text
                'button:has(span:has-text("Send message"))',
                // Fallback to role-based selectors
                '[role="button"]:has-text("Send message"):not(:has-text("Share"))',
                // Legacy selectors as final fallback
                'button:has-text("Send message")',
                '[role="button"]:has-text("Send message")'
            ];

            for (const selector of sendMessageSelectors) {
                try {
                    const elementExists = await page.evaluate((sel) => {
                        return !!document.querySelector(sel);
                    }, selector);

                    if (elementExists) {
                        await page.waitForSelector(selector, { timeout: 3000, visible: true });
                        await page.click(selector);
                        console.log(`Clicked "${selector}"`);
                        messageButtonClicked = true;
                        await sleep(3000);
                        break;
                    }
                } catch (err) {
                    console.log(`Error with selector ${selector}`);
                }
            }

            if (!messageButtonClicked) {
                console.log(`Failed to click message button for ${username}`);
                return false;
            }
        }

        // Handle "Not Now" popup if it appears
        console.log("Checking for general 'Not Now' popup...");

        try {
            const notNowSelectors = [
                'button._a9--._ap36._a9_1[tabindex="0"]',
                'button._a9--._ap36._a9_1',
                'button:has-text("Not Now")'
            ];

            let notNowFound = false;
            for (const notNowSelector of notNowSelectors) {
                const hasNotNow = await page.evaluate((sel) => {
                    return !!document.querySelector(sel);
                }, notNowSelector);

                if (hasNotNow) {
                    await page.waitForSelector(notNowSelector, { timeout: 2000, visible: true });
                    await page.click(notNowSelector);
                    console.log(`Clicked 'Not Now' button using selector: ${notNowSelector}`);
                    await sleep(2000);
                    notNowFound = true;
                    break;
                }
            }

            if (!notNowFound) {
                console.log("No general 'Not Now' popup detected");
            }
        } catch (err) {
            console.log("Error checking for 'Not Now' popup:", err.message);
        }

        // Find and click text area for typing
        console.log("Looking for message text area...");

        let textAreaClicked = false;
        const textAreaSelectors = [
            'div[contenteditable="true"]',
            'div[role="textbox"]',
            '[contenteditable="true"]'
        ];

        for (const selector of textAreaSelectors) {
            try {
                const elementExists = await page.evaluate((sel) => {
                    return !!document.querySelector(sel);
                }, selector);

                if (elementExists) {
                    await page.waitForSelector(selector, { timeout: 3000, visible: true });
                    await page.click(selector);
                    console.log(`Clicked text area using selector: ${selector}`);
                    textAreaClicked = true;
                    await sleep(1000);
                    break;
                }
            } catch (err) {
                console.log(`Error with text area selector ${selector}`);
            }
        }

        if (!textAreaClicked) {
            console.log(`Failed to click text area for ${username}`);
            return false;
        }

        // Type the message with Shift+Enter for line breaks
        console.log("Typing message...");

        try {
            // Split the message by newlines and type each line with shift+enter
            const messageLines = message.split('\n');
            for (let i = 0; i < messageLines.length; i++) {
                await page.keyboard.type(messageLines[i]);

                // Add Shift+Enter between lines, but not after the last line
                if (i < messageLines.length - 1) {
                    await page.keyboard.down('Shift');
                    await page.keyboard.press('Enter');
                    await page.keyboard.up('Shift');
                }
            }

            console.log("Message typed successfully");

            // Send the message
            await page.keyboard.press('Enter');
            console.log("Message sent");

            return true;
        } catch (err) {
            console.error("Error typing message:", err.message);
            return false;
        }
    } catch (error) {
        console.error(`Failed to message ${username}:`, error);
        return false;
    }
}

/**
 * Mark user as processed in MongoDB
 */
async function markUserAsProcessed(collection, followerUsername, accountOwner) {
    try {
        await collection.insertOne({
            followerUsername,
            accountOwner,
            processedAt: new Date()
        });
        console.log(`Marked ${followerUsername} as processed for account ${accountOwner}`);
        return true;
    } catch (error) {
        console.error(`Error marking ${followerUsername} as processed:`, error);
        return false;
    }
}

/**
 * Process followers - main function exposed to API
 */
async function processFollowers(options) {
    const {
        cookieFilePath,
        cookieFile, // Buffer or file object
        username,
        welcomeMessage = process.env.WELCOME_MESSAGE || 'Thank you for following us!',
        headless = true,
        browserlessApiKey // browserless.io API key
    } = options;

    let client, browser;
    const processedUsers = [];
    const failedUsers = [];

    // Set up browserless.io endpoint if API key is provided
    let browserlessWSEndpoint = null;
    if (browserlessApiKey) {
        browserlessWSEndpoint = `wss://chrome.browserless.io?token=${browserlessApiKey}`;
        console.log('Using browserless.io service');
    }

    try {
        // Load cookies
        let cookies;
        if (cookieFile) {
            console.log(`Loading cookies from uploaded file`);
            cookies = loadCookies(cookieFile);
        } else if (cookieFilePath) {
            console.log(`Loading cookies from ${cookieFilePath}`);
            cookies = loadCookies(cookieFilePath);
        } else {
            throw new Error('No cookie file or path provided');
        }

        // Connect to MongoDB
        const mongo = await connectToMongoDB();
        client = mongo.client;
        const collection = mongo.collection;

        // Initialize browser (support browserless.io)
        const browserObj = await initBrowser(cookies, headless, browserlessWSEndpoint);
        browser = browserObj.browser;
        const page = browserObj.page;

        // Check if we're successfully logged in
        await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2' });

        const isLoggedIn = await page.evaluate(() => {
            return !document.querySelector('input[name="username"]');
        });

        if (!isLoggedIn) {
            console.error('Not logged in. Please check your cookies.');
            throw new Error('Authentication failed - please check your cookie file');
        }

        console.log('Successfully logged in to Instagram');

        // Get the account owner username
        const accountOwner = username;
        console.log(`Processing followers for Instagram account: ${accountOwner}`);

        // Check notifications and get new followers
        const newFollowers = await checkNotifications(page, collection, accountOwner);

        // Send welcome messages to new followers
        for (const username of newFollowers) {
            console.log(`Processing follower: ${username}`);

            const success = await sendWelcomeMessage(page, username, welcomeMessage);

            if (success) {
                await markUserAsProcessed(collection, username, accountOwner);
                processedUsers.push({
                    username,
                    status: 'success',
                    timestamp: new Date().toISOString()
                });
            } else {
                console.log(`Failed to message ${username}, skipping this user`);
                failedUsers.push({
                    username,
                    status: 'failed',
                    timestamp: new Date().toISOString()
                });
            }

            // Add a delay between messages to avoid rate limiting
            await sleep(5000 + Math.floor(Math.random() * 5000));
        }

        console.log('Task completed successfully');
        return { processedUsers, failedUsers };
    } catch (error) {
        console.error('Error in processing followers:', error);
        throw error;
    } finally {
        // Clean up
        if (browser) await browser.close();
        if (client) await client.close();
    }
}

module.exports = {
    processFollowers
};
