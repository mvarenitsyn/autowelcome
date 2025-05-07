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
        if (Buffer.isBuffer(cookieInput)) {
            cookiesString = cookieInput.toString('utf8');
        } else if (typeof cookieInput === 'string' && fs.existsSync(cookieInput)) {
            cookiesString = fs.readFileSync(cookieInput, 'utf8');
        } else if (typeof cookieInput === 'object' && cookieInput !== null) {
            // Handle multer file object
            if (cookieInput.path && fs.existsSync(cookieInput.path)) {
                cookiesString = fs.readFileSync(cookieInput.path, 'utf8');
            } else if (cookieInput.buffer) {
                cookiesString = Buffer.from(cookieInput.buffer).toString('utf8');
            } else {
                throw new Error('Invalid cookie input: Missing path or buffer');
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
    const maxRetries = 5; // Increased from 3 to 5
    let retryCount = 0;

    while (retryCount < maxRetries) {
        try {
            console.log(`Initializing browser (attempt ${retryCount + 1}/${maxRetries})...`);

            // Step 1: Launch or connect to browser with more robust error handling
            if (browserWSEndpoint) {
                console.log(`Connecting to remote browser at ${browserWSEndpoint}`);
                try {
                    // More robust browserWSEndpoint connection with timeout
                    const connectPromise = puppeteer.connect({
                        browserWSEndpoint,
                        defaultViewport: { width: 1280, height: 800 },
                        // Add a longer timeout for browserless.io connections
                        timeout: 120000 // 2 minutes
                    });

                    // Create a timeout promise
                    const timeoutPromise = new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Connection timeout')), 120000)
                    );

                    // Race the connection against the timeout
                    browser = await Promise.race([connectPromise, timeoutPromise]);

                    console.log('Successfully connected to remote browser');
                } catch (connectError) {
                    console.error('Error connecting to remote browser:', connectError);
                    throw new Error(`Remote browser connection failed: ${connectError.message}`);
                }
            } else {
                // Local browser launch with simplified stable options
                browser = await puppeteer.launch({
                    // Use classic headless mode unless `headless` is explicitly false
                    headless,
                    // Allow an externally‑installed Chrome/Chromium if provided
                    executablePath: process.env.CHROME_PATH || undefined,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--window-size=1280,800',
                        // Commented‑out flags below have been removed because they can
                        // crash Chrome or conflict with the DevTools websocket on macOS:
                        // '--disable-gpu',
                        // '--disable-dev-shm-usage',
                        // '--disable-accelerated-2d-canvas',
                        // '--disable-features=site-per-process',
                        // '--enable-features=NetworkService,NetworkServiceInProcess',
                        // '--disable-web-security',
                        // '--disable-features=IsolateOrigins,site-per-process',
                        // '--disable-background-timer-throttling',
                        // '--disable-backgrounding-occluded-windows',
                        // '--disable-renderer-backgrounding',
                    ],
                    defaultViewport: { width: 1280, height: 800 },
                    timeout: 90000,
                    ignoreHTTPSErrors: true,
                });
            }

            // Step 2: Create and configure a new page with comprehensive error handling
            let page;
            try {
                page = await browser.newPage();

                // Enhanced page setup with error handlers
                await page.setDefaultNavigationTimeout(90000); // 90 seconds
                await page.setDefaultTimeout(90000);
                await page.setCacheEnabled(true);

                // Set more realistic browser fingerprint
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                await page.setExtraHTTPHeaders({
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive' // Important for avoiding connection resets
                });

                // Set up page error handlers
                page.on('error', err => {
                    console.error('Page error:', err);
                });

                // Handle console messages from the browser for better debugging
                page.on('console', msg => {
                    const messageText = msg.text();
                    // Suppress common "Permissions-Policy header: Origin trial controlled feature not enabled" warnings
                    if (msg.type() === 'warning' &&
                        messageText.startsWith('Error with Permissions-Policy header: Origin trial controlled feature not enabled:')) {
                        // By returning here, we prevent these specific warnings from being logged by default.
                        // If you have custom console logging, ensure this effectively suppresses them.
                        return;
                    }
                    // You can add further handling for other console messages if needed, for example:
                    // if (msg.type() === 'error' || (msg.type() === 'warning' /* && !isSuppressedWarning */)) {
                    //    console.warn(`Browser console [${msg.type()}]: ${messageText}`);
                    // } else {
                    //    console.log(`Browser console [${msg.type()}]: ${messageText}`);
                    // }
                });
            } catch (pageError) {
                console.error('Error creating or configuring page:', pageError);
                if (browser) {
                    try { await browser.close(); } catch (e) { /* ignore */ }
                }
                throw pageError;
            }

            // Step 3: Navigate to Instagram with robust retry logic
            console.log('Loading Instagram homepage...');
            let navigationSuccess = false;
            const navigationRetries = 3;

            for (let navAttempt = 0; navAttempt < navigationRetries; navAttempt++) {
                try {
                    await page.goto('https://www.instagram.com/', {
                        waitUntil: 'networkidle2',
                        timeout: 90000 // 90 seconds timeout
                    });
                    navigationSuccess = true;
                    break;
                } catch (navError) {
                    console.error(`Navigation attempt ${navAttempt + 1}/${navigationRetries} failed:`, navError.message);
                    if (navAttempt + 1 < navigationRetries) {
                        // Wait before retry
                        await new Promise(resolve => setTimeout(resolve, 5000));
                        console.log(`Retrying navigation (attempt ${navAttempt + 2}/${navigationRetries})...`);
                    } else {
                        throw new Error(`Failed to navigate to Instagram after ${navigationRetries} attempts`);
                    }
                }
            }

            if (!navigationSuccess) {
                throw new Error('Failed to navigate to Instagram');
            }

            // Step 4: Set cookies with better error handling
            console.log('Setting cookies...');
            try {
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
            } catch (cookieError) {
                console.error('Error setting cookies:', cookieError);
                throw cookieError;
            }

            // Wait longer to stabilize
            await new Promise(resolve => setTimeout(resolve, 5000));

            console.log('Browser initialized successfully');
            return { browser, page };
        } catch (error) {
            console.error(`Browser initialization error (attempt ${retryCount + 1}/${maxRetries}):`, error);

            // Clean up if browser was created
            if (browser) {
                try {
                    await browser.close();
                } catch (closeError) {
                    console.error('Error closing browser:', closeError);
                }
            }

            retryCount++;

            if (retryCount >= maxRetries) {
                console.error('Max retries reached, giving up on browser initialization');
                throw new Error(`Failed to initialize browser after ${maxRetries} attempts: ${error.message}`);
            }

            // Wait longer before retrying
            const delayMs = 8000 * retryCount; // Increased delay with each retry
            console.log(`Waiting ${delayMs / 1000} seconds before next attempt...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
}

/**
 * Check notifications for new followers
 */
async function checkNotifications(page, collection, accountOwner) {
    try {
        console.log(`Checking notifications for new followers of ${accountOwner}...`);

        // Navigate to notifications page
        await page.goto('https://www.instagram.com/notifications/', {
            waitUntil: 'networkidle2',
            timeout: 60000
        });

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

        // Only filter if we have a valid collection (MongoDB connection)
        if (collection) {
            // Filter out already processed users
            const unprocessedFollowers = [];
            for (const username of newFollowers) {
                try {
                    const existingUser = await collection.findOne({
                        followerUsername: username,
                        accountOwner: accountOwner
                    });
                    if (!existingUser) {
                        unprocessedFollowers.push(username);
                    }
                } catch (dbError) {
                    console.error(`Error checking user ${username} in database:`, dbError);
                    // If there's a DB error, assume the user is unprocessed
                    unprocessedFollowers.push(username);
                }
            }
            console.log(`${unprocessedFollowers.length} new followers to process`);
            return unprocessedFollowers;
        } else {
            // If no collection, just return all followers
            console.log(`No database connection, processing all ${newFollowers.length} followers`);
            return newFollowers;
        }
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
    // Skip DB operations if collection is not available
    if (!collection) {
        console.log(`No database collection available. Skipping DB tracking for ${followerUsername}`);
        return true;
    }

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
        // Return true anyway since this isn't a critical failure
        // We still want to count the message as sent even if we can't record it
        return true;
    }
}

/**
 * Process followers - Immediate return version that returns a job ID
 */
function startProcessFollowers(options, jobManager) {
    const jobId = jobManager.createJob(options);

    // Start processing in the background
    processFollowersJob(options, jobId, jobManager)
        .catch(error => {
            console.error(`Job ${jobId} failed:`, error);
            jobManager.failJob(jobId, error.message);
        });

    return jobId;
}

/**
 * Process followers job - runs in the background
 */
async function processFollowersJob(options, jobId, jobManager) {
    const {
        cookieFilePath,
        cookieFile, // Buffer or file object
        username,
        welcomeMessage = process.env.WELCOME_MESSAGE || 'Thank you for following us!',
        headless = true,
        browserlessApiKey // browserless.io API key
    } = options;

    let client, browser, page, collection = null;
    const processedUsers = [];
    const failedUsers = [];

    // Update job status to running
    jobManager.updateJobStatus(jobId, 'running');

    // Set up browserless.io endpoint if API key is provided
    let browserlessWSEndpoint = null;
    if (browserlessApiKey) {
        try {
            // Use secure WebSocket connection with better error handling
            browserlessWSEndpoint = `wss://chrome.browserless.io?token=${browserlessApiKey}&--disable-features=WebRtcHideLocalIpsWithMdns,AudioServiceOutOfProcess&stealth=true`;
            console.log(`[Job ${jobId}] Using browserless.io service with enhanced parameters`);

            // Add a warning to the job for monitoring
            jobManager.updateJobStatus(jobId, 'initializing', {
                warning: 'Using remote browser service. Connection stability depends on network conditions.'
            });
        } catch (error) {
            console.error(`[Job ${jobId}] Error setting up browserless endpoint:`, error);
            jobManager.updateJobStatus(jobId, 'warning', {
                warning: 'Failed to set up browserless.io service, falling back to local browser'
            });
            // Ensure browserlessWSEndpoint is null for fallback
            browserlessWSEndpoint = null;
        }
    }

    // Setup process-wide error handler for unhandled promise rejections
    const originalUnhandledRejection = process.listeners('unhandledRejection').pop();
    process.removeAllListeners('unhandledRejection');

    process.on('unhandledRejection', (reason, promise) => {
        console.error(`[Job ${jobId}] Unhandled Rejection at:`, promise, 'reason:', reason);

        // Only log it but don't fail the whole process
        if (reason instanceof Error && reason.message.includes('socket hang up')) {
            console.error(`[Job ${jobId}] WebSocket connection issue detected: ${reason.message}`);
            // Don't throw - we'll handle this in the main try/catch
        } else if (originalUnhandledRejection) {
            // Call original handler for other types of errors
            originalUnhandledRejection(reason, promise);
        }
    });

    try {
        // Load cookies with better error handling
        let cookies;
        try {
            if (cookieFile) {
                console.log(`[Job ${jobId}] Loading cookies from uploaded file`);
                cookies = loadCookies(cookieFile);
            } else if (cookieFilePath) {
                console.log(`[Job ${jobId}] Loading cookies from ${cookieFilePath}`);
                cookies = loadCookies(cookieFilePath);
            } else {
                throw new Error('No cookie file or path provided');
            }

            // Validate cookies were loaded properly
            if (!cookies || !cookies.rawCookies || cookies.rawCookies.length === 0) {
                throw new Error('Invalid or empty cookies data');
            }

            console.log(`[Job ${jobId}] Successfully loaded ${cookies.rawCookies.length} cookies`);
        } catch (cookieError) {
            console.error(`[Job ${jobId}] Cookie loading error:`, cookieError);
            jobManager.failJob(jobId, `Cookie error: ${cookieError.message}`);
            throw cookieError;
        }

        // Connect to MongoDB if URI is provided
        try {
            if (!mongoUri) {
                console.log(`[Job ${jobId}] No MongoDB URI provided, skipping database connection`);
                // We'll just proceed without storing user data
            } else {
                const mongo = await connectToMongoDB();
                client = mongo.client;
                collection = mongo.collection;
                console.log(`[Job ${jobId}] Successfully connected to MongoDB`);
            }
        } catch (mongoError) {
            console.error(`[Job ${jobId}] Warning: MongoDB connection failed`, mongoError);
            // Continue without database - will just track users in memory
            jobManager.updateJobStatus(jobId, 'warning', {
                warning: 'Database connection failed, proceeding without persistent storage'
            });
        }

        // Initialize browser with enhanced error handling
        jobManager.updateJobStatus(jobId, 'initializing_browser');
        console.log(`[Job ${jobId}] Initializing browser...`);

        let browserObj;
        try {
            // Pass browserlessWSEndpoint safely - will be null if not set up properly
            browserObj = await initBrowser(cookies, headless, browserlessWSEndpoint);
            browser = browserObj.browser;
            page = browserObj.page;
            console.log(`[Job ${jobId}] Browser successfully initialized`);
        } catch (browserError) {
            console.error(`[Job ${jobId}] Fatal browser initialization error:`, browserError);

            // If the error is related to browserWSEndpoint, try again with local browser
            if (browserlessWSEndpoint &&
                (browserError.message.includes('browserWSEndpoint') ||
                    browserError.message.includes('socket hang up') ||
                    browserError.message.includes('ECONNRESET') ||
                    browserError.message.includes('Connection timeout'))) {

                console.log(`[Job ${jobId}] Retrying with local browser after remote browser error`);
                jobManager.updateJobStatus(jobId, 'retrying_with_local', {
                    warning: 'Remote browser connection failed, retrying with local browser'
                });

                try {
                    // Try again without browserless
                    browserObj = await initBrowser(cookies, headless, null);
                    browser = browserObj.browser;
                    page = browserObj.page;
                    console.log(`[Job ${jobId}] Browser successfully initialized with local browser`);
                } catch (localBrowserError) {
                    // If local browser also fails, then fail the job
                    console.error(`[Job ${jobId}] Local browser initialization also failed:`, localBrowserError);
                    jobManager.failJob(jobId, `Browser initialization failed: ${localBrowserError.message}`);
                    throw localBrowserError;
                }
            } else {
                jobManager.failJob(jobId, `Browser initialization failed: ${browserError.message}`);
                throw browserError;
            }
        }

        // Setup page and browser-level error handlers for better debugging
        browser.on('disconnected', () => {
            console.error(`[Job ${jobId}] Browser was disconnected unexpectedly`);
            // We'll handle this in the main catch block
        });

        // Check if we're successfully logged in with robust error handling
        try {
            await page.goto('https://www.instagram.com/', {
                waitUntil: 'networkidle2',
                timeout: 90000 // 90 second timeout
            });

            const isLoggedIn = await page.evaluate(() => {
                return !document.querySelector('input[name="username"]');
            });

            if (!isLoggedIn) {
                console.error(`[Job ${jobId}] Not logged in. Please check your cookies.`);
                jobManager.failJob(jobId, 'Authentication failed - please check your cookie file');
                throw new Error('Authentication failed - please check your cookie file');
            }

            console.log(`[Job ${jobId}] Successfully logged in to Instagram`);
        } catch (navError) {
            console.error(`[Job ${jobId}] Navigation or login check error:`, navError);
            jobManager.failJob(jobId, `Instagram navigation failed: ${navError.message}`);
            throw navError;
        }

        // Get the account owner username
        const accountOwner = username;
        console.log(`[Job ${jobId}] Processing followers for Instagram account: ${accountOwner}`);
        jobManager.updateJobStatus(jobId, 'checking_notifications');

        // Check notifications and get new followers with retry logic
        let newFollowers = [];
        const maxNotificationRetries = 3;

        for (let notifAttempt = 0; notifAttempt < maxNotificationRetries; notifAttempt++) {
            try {
                console.log(`[Job ${jobId}] Checking notifications (attempt ${notifAttempt + 1}/${maxNotificationRetries})...`);
                newFollowers = await checkNotifications(page, collection, accountOwner);
                break; // Success, exit the retry loop
            } catch (notifError) {
                console.error(`[Job ${jobId}] Error checking notifications (attempt ${notifAttempt + 1}/${maxNotificationRetries}):`, notifError);

                if (notifAttempt + 1 < maxNotificationRetries) {
                    console.log(`[Job ${jobId}] Retrying notification check in 10 seconds...`);
                    await sleep(10000);
                } else {
                    console.error(`[Job ${jobId}] Failed to check notifications after ${maxNotificationRetries} attempts`);
                    jobManager.updateJobStatus(jobId, 'warning', {
                        warning: 'Notification check failed, process may be incomplete'
                    });
                    // Continue with empty followers list rather than failing completely
                    newFollowers = [];
                }
            }
        }

        // Update job with total count
        jobManager.setTotalFollowers(jobId, newFollowers.length);

        if (newFollowers.length === 0) {
            console.log(`[Job ${jobId}] No new followers to process`);
            jobManager.updateJobStatus(jobId, 'completed', {
                message: 'No new followers to process'
            });
            return { processedUsers, failedUsers };
        }

        // Send welcome messages to new followers
        jobManager.updateJobStatus(jobId, 'sending_messages');
        console.log(`[Job ${jobId}] Starting to process ${newFollowers.length} followers`);

        // Track last successful user in case we need to restart after a WebSocket error
        let lastProcessedIndex = -1;

        for (let i = 0; i < newFollowers.length; i++) {
            const username = newFollowers[i];
            console.log(`[Job ${jobId}] Processing follower ${i + 1}/${newFollowers.length}: ${username}`);

            // If browser disconnected, try to reconnect once
            if (!browser.isConnected()) {
                console.log(`[Job ${jobId}] Browser disconnected, attempting to reconnect...`);
                jobManager.updateJobStatus(jobId, 'reconnecting', {
                    warning: 'Connection to browser lost, attempting to reconnect...'
                });

                try {
                    // Attempt to reinitialize browser
                    const newBrowserObj = await initBrowser(cookies, headless, browserWSEndpoint);
                    browser = newBrowserObj.browser;
                    page = newBrowserObj.page;
                    console.log(`[Job ${jobId}] Successfully reconnected to browser`);

                    // Update job status back to sending messages
                    jobManager.updateJobStatus(jobId, 'sending_messages', {
                        info: 'Reconnected successfully, continuing message sending'
                    });

                    // Use the new page for the current follower
                    try {
                        // Send message with timeout to prevent hanging
                        const messagePromise = sendWelcomeMessage(page, username, welcomeMessage);
                        const timeoutPromise = new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('Message sending timeout')), 120000)
                        );

                        // Race the operation against timeout
                        const success = await Promise.race([messagePromise, timeoutPromise]);

                        if (success) {
                            await markUserAsProcessed(collection, username, accountOwner);
                            const userData = {
                                username,
                                status: 'success',
                                timestamp: new Date().toISOString()
                            };
                            processedUsers.push(userData);
                            jobManager.addProcessedUser(jobId, userData);
                            lastProcessedIndex = i;
                        } else {
                            // Mark skipped user as processed so we don't retry next run
                            await markUserAsProcessed(collection, username, accountOwner);
                            console.log(`[Job ${jobId}] Failed to message ${username} after reconnection, skipping this user`);
                            const userData = {
                                username,
                                status: 'failed',
                                timestamp: new Date().toISOString(),
                                reason: 'Message sending failed after reconnection'
                            };
                            failedUsers.push(userData);
                            jobManager.addFailedUser(jobId, userData);
                        }

                        // Continue to next user after handling this one
                        continue;
                    } catch (msgError) {
                        console.error(`[Job ${jobId}] Error messaging ${username} after reconnection:`, msgError);
                        const userData = {
                            username,
                            status: 'failed',
                            timestamp: new Date().toISOString(),
                            error: msgError.message
                        };
                        failedUsers.push(userData);
                        jobManager.addFailedUser(jobId, userData);
                        // Ensure user is marked processed even when an error occurs
                        await markUserAsProcessed(collection, username, accountOwner);
                        // Continue to next user
                        continue;
                    }
                } catch (reconnectError) {
                    console.error(`[Job ${jobId}] Failed to reconnect to browser:`, reconnectError);

                    // Update job with partial completion information
                    const completionMessage =
                        `Process interrupted after ${processedUsers.length} successful messages. ` +
                        `${newFollowers.length - i} followers were not processed.`;

                    jobManager.failJob(jobId, `Connection error: ${reconnectError.message}. ${completionMessage}`);
                    throw new Error(completionMessage);
                }
            }

            try {
                // Send message with timeout to prevent hanging
                const messagePromise = sendWelcomeMessage(page, username, welcomeMessage);
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Message sending timeout')), 120000)
                );

                // Race the operation against timeout
                const success = await Promise.race([messagePromise, timeoutPromise]);

                if (success) {
                    await markUserAsProcessed(collection, username, accountOwner);
                    const userData = {
                        username,
                        status: 'success',
                        timestamp: new Date().toISOString()
                    };
                    processedUsers.push(userData);
                    jobManager.addProcessedUser(jobId, userData);
                    lastProcessedIndex = i;
                } else {
                    // Mark skipped user as processed so we don't retry next run
                    await markUserAsProcessed(collection, username, accountOwner);
                    console.log(`[Job ${jobId}] Failed to message ${username}, skipping this user`);
                    const userData = {
                        username,
                        status: 'failed',
                        timestamp: new Date().toISOString(),
                        reason: 'Message sending failed'
                    };
                    failedUsers.push(userData);
                    jobManager.addFailedUser(jobId, userData);
                }
            } catch (messageError) {
                console.error(`[Job ${jobId}] Error messaging ${username}:`, messageError);

                const userData = {
                    username,
                    status: 'failed',
                    timestamp: new Date().toISOString(),
                    error: messageError.message
                };
                failedUsers.push(userData);
                jobManager.addFailedUser(jobId, userData);
                await markUserAsProcessed(collection, username, accountOwner);

                // Check if it's a connection error - if so, we might need to reconnect
                if (messageError.message.includes('socket hang up') ||
                    messageError.message.includes('WebSocket') ||
                    messageError.message.includes('target closed') ||
                    messageError.message.includes('connection')) {

                    console.log(`[Job ${jobId}] Connection error detected, will attempt reconnection on next iteration`);
                    // Force disconnect so next iteration will reconnect
                    try {
                        await browser.disconnect();
                    } catch (e) { /* ignore */ }
                }
            }

            // Add a delay between messages to avoid rate limiting
            // Use a shorter delay if we had to reconnect to make up for lost time
            const delayTime = browser.isConnected() ?
                5000 + Math.floor(Math.random() * 5000) : 3000;
            await sleep(delayTime);
        }

        // Process completion
        const totalSuccessful = processedUsers.length;
        const totalFailed = failedUsers.length;
        console.log(`[Job ${jobId}] Task completed: ${totalSuccessful} messages sent, ${totalFailed} failed`);

        jobManager.completeJob(jobId, {
            processedUsers,
            failedUsers,
            summary: `Processed ${newFollowers.length} followers: ${totalSuccessful} successful, ${totalFailed} failed`
        });

        return { processedUsers, failedUsers };
    } catch (error) {
        console.error(`[Job ${jobId}] Error in processing followers:`, error);

        // Provide a detailed error message with recovery information
        let errorMessage = `Error: ${error.message}`;

        if (processedUsers.length > 0) {
            errorMessage += ` ${processedUsers.length} messages were successfully sent before the error.`;
        }

        jobManager.failJob(jobId, errorMessage);
        throw error;
    } finally {
        // Restore original unhandled rejection handler
        process.removeAllListeners('unhandledRejection');
        if (originalUnhandledRejection) {
            process.on('unhandledRejection', originalUnhandledRejection);
        }

        // Clean up with robust error handling
        try {
            if (browser) {
                console.log(`[Job ${jobId}] Closing browser`);
                try {
                    if (browser.isConnected()) {
                        await browser.close();
                    }
                } catch (closeError) {
                    console.error(`[Job ${jobId}] Error closing browser:`, closeError.message);
                }
            }
        } catch (e) {
            console.error(`[Job ${jobId}] Error during browser cleanup:`, e);
        }

        try {
            if (client) {
                console.log(`[Job ${jobId}] Closing MongoDB connection`);
                await client.close();
            }
        } catch (e) {
            console.error(`[Job ${jobId}] Error during MongoDB cleanup:`, e);
        }
    }
}

/**
 * Original synchronous process followers function (for backward compatibility)
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

    let client, browser, collection = null;
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

        // Connect to MongoDB if URI is provided
        try {
            if (!mongoUri) {
                console.log('No MongoDB URI provided, skipping database connection');
                // We'll just proceed without storing user data
            } else {
                const mongo = await connectToMongoDB();
                client = mongo.client;
                collection = mongo.collection;
                console.log('Successfully connected to MongoDB');
            }
        } catch (mongoError) {
            console.error('Warning: MongoDB connection failed:', mongoError.message);
            console.log('Continuing without database - users will not be tracked persistently');
            // Continue without database - will just process all followers
        }

        // Initialize browser with the more robust initBrowser function
        console.log('Initializing browser...');
        const browserObj = await initBrowser(cookies, headless, browserlessWSEndpoint);
        browser = browserObj.browser;
        const page = browserObj.page;

        // Check if we're successfully logged in (with longer timeout)
        await page.goto('https://www.instagram.com/', {
            waitUntil: 'networkidle2',
            timeout: 60000 // 60 second timeout
        });

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
        console.log('Checking notifications for new followers...');
        const newFollowers = await checkNotifications(page, collection, accountOwner);

        if (newFollowers.length === 0) {
            console.log('No new followers to process');
            return { processedUsers, failedUsers };
        }

        // Send welcome messages to new followers
        console.log(`Found ${newFollowers.length} new followers to process`);
        for (const username of newFollowers) {
            console.log(`Processing follower: ${username}`);

            try {
                const success = await sendWelcomeMessage(page, username, welcomeMessage);

                if (success) {
                    await markUserAsProcessed(collection, username, accountOwner);
                    processedUsers.push({
                        username,
                        status: 'success',
                        timestamp: new Date().toISOString()
                    });
                } else {
                    // Mark skipped user as processed so we don't retry next run
                    await markUserAsProcessed(collection, username, accountOwner);
                    console.log(`Failed to message ${username}, skipping this user`);
                    failedUsers.push({
                        username,
                        status: 'failed',
                        timestamp: new Date().toISOString()
                    });
                }
            } catch (messageError) {
                console.error(`Error messaging ${username}:`, messageError.message);
                failedUsers.push({
                    username,
                    status: 'failed',
                    error: messageError.message,
                    timestamp: new Date().toISOString()
                });
                await markUserAsProcessed(collection, username, accountOwner);
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
        if (browser) {
            console.log('Closing browser');
            try {
                await browser.close();
            } catch (closeError) {
                console.error('Error closing browser:', closeError.message);
            }
        }
        if (client) {
            console.log('Closing MongoDB connection');
            try {
                await client.close();
            } catch (closeError) {
                console.error('Error closing MongoDB connection:', closeError.message);
            }
        }
    }
}

module.exports = {
    processFollowers,
    startProcessFollowers,
    processFollowersJob
};
