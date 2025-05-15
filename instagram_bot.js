const { chromium } = require('playwright');
const { MongoClient } = require('mongodb');
const fs = require('fs');
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

        // Transform cookies into Playwright format
        const playwrightCookies = cookies.map(cookie => {
            let sameSite = 'None';
            if (typeof cookie.sameSite === 'string') {
                const s = cookie.sameSite.toLowerCase();
                if (s === 'strict' || s === 'lax' || s === 'none') {
                    sameSite = s.charAt(0).toUpperCase() + s.slice(1);
                }
            }
            return {
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path,
                expires: cookie.expirationDate ? cookie.expirationDate : -1,
                httpOnly: cookie.httpOnly || false,
                secure: cookie.secure || false,
                sameSite
            };
        });

        console.log(`Loaded ${cookies.length} cookies from ${cookieInput}`);
        return { playwrightCookies, rawCookies: cookies };
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
    const maxRetries = 5;
    let retryCount = 0;

    while (retryCount < maxRetries) {
        try {
            console.log(`Initializing browser (attempt ${retryCount + 1}/${maxRetries})...`);

            // Step 1: Launch or connect to browser with more robust error handling
            if (browserWSEndpoint) {
                console.log(`Connecting to remote browser at ${browserWSEndpoint}`);
                try {
                    // Connect to browserless.io
                    browser = await chromium.connect({
                        wsEndpoint: browserWSEndpoint,
                        timeout: 120000 // 2 minutes
                    });

                    console.log('Successfully connected to remote browser');
                } catch (connectError) {
                    console.error('Error connecting to remote browser:', connectError);
                    throw new Error(`Remote browser connection failed: ${connectError.message}`);
                }
            } else {
                // Local browser launch
                browser = await chromium.launch({
                    headless,
                    // Use executable path if provided
                    executablePath: process.env.CHROME_PATH || undefined,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--window-size=1280,800',
                    ],
                    timeout: 90000,
                    ignoreHTTPSErrors: true,
                });
            }

            // Step 2: Create and configure a new page with comprehensive error handling
            let context;
            let page;
            try {
                // Create browser context
                context = await browser.newContext({
                    viewport: { width: 1280, height: 800 },
                    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    extraHTTPHeaders: {
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Connection': 'keep-alive'
                    }
                });

                // Set cookies in the context
                const playwrightCookies = cookiesObj.playwrightCookies;
                await context.addCookies(playwrightCookies);

                // Create new page
                page = await context.newPage();

                // Set up page event listeners
                page.on('console', message => {
                    const messageText = message.text();
                    if (message.type() === 'warning' &&
                        messageText.startsWith('Error with Permissions-Policy header: Origin trial controlled feature not enabled:')) {
                        return;
                    }
                    // You could add additional console message handling here
                });

                // Set timeouts
                page.setDefaultTimeout(90000);
                page.setDefaultNavigationTimeout(90000);
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
                        timeout: 90000 // 90 seconds timeout
                    });
                    // Wait 2 seconds after navigation, then proceed
                    await new Promise(resolve => setTimeout(resolve, 2000));
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

            // Wait longer to stabilize
            await new Promise(resolve => setTimeout(resolve, 5000));

            console.log('Browser initialized successfully');
            return { browser, context, page };
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
            timeout: 60000
        });
        // Wait 2 seconds after navigation
        await new Promise(resolve => setTimeout(resolve, 2000));
        // Wait for notification content to load
        await page.waitForSelector('body', { timeout: 30000 });

        // Scroll to load more notifications
        await autoScroll(page);

        // Extract follower notifications with Playwright's evaluateHandle
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
    let maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let dtsgErrorDetected = false;
        const consoleListener = msg => {
            const text = msg.text();
            if (text && text.includes('DTSG response is not valid')) {
                dtsgErrorDetected = true;
            }
        };
        try {
            console.log(`Sending welcome message to ${username}... (attempt ${attempt + 1})`);
            await page.goto(`https://www.instagram.com/${username}/`, { timeout: 60000 });
            await sleep(2000);
            // Attach DTSG error listener immediately after navigation
            page.on('console', consoleListener);

            // Load saved selectors
            const savedSelectors = loadSelectors();

            // Step 1: First try to find direct Message button on profile page
            console.log("Looking for direct Message button...");

            let messageButtonFound = false;
            const directMessageSelectors = [
                'div[role="button"]:has-text("Message")',
                'div[role="button"][tabindex="0"]:has-text("Message")',
                'div[role="button"][tabindex="0"]'
            ];

            // Try each direct message selector
            for (const selector of directMessageSelectors) {
                try {
                    const messageButton = await page.$(selector);
                    if (messageButton) {
                        // Check if this button contains "Message" text
                        const buttonText = await messageButton.textContent();
                        if (buttonText && buttonText.includes('Message')) {
                            await messageButton.click();
                            console.log(`Clicked direct message button using selector: ${selector}`);
                            messageButtonFound = true;

                            console.log("Waiting 3 seconds for 'Not Now' popup to appear...");
                            await sleep(3000);

                            // Check for "Not Now" popup after waiting
                            console.log("Checking for 'Not Now' popup after clicking Message button...");
                            try {
                                const notNowSelectors = [
                                    'button:has-text("Not Now")'
                                ];

                                let notNowFound = false;
                                for (const notNowSelector of notNowSelectors) {
                                    const notNowButton = await page.$(notNowSelector);
                                    if (notNowButton) {
                                        await notNowButton.click();
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
                    'svg[aria-label="Options"]',
                    '[aria-label="Options"]',
                    '[aria-label="More options"]'
                ];

                // Try option selectors
                for (const selector of optionsSelectors) {
                    try {
                        const optionsButton = await page.$(selector);
                        if (optionsButton) {
                            await optionsButton.click();
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
                await sleep(5000);
                let messageButtonClicked = false;
                const sendMessageSelectors = [
                    'button:has-text("Send message")',
                    'button >> text=Send message',
                    '[role="button"]:has-text("Send message")'
                ];

                for (const selector of sendMessageSelectors) {
                    try {
                        const sendMessageButton = await page.$(selector);
                        if (sendMessageButton) {
                            await sendMessageButton.click();
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
                    'button:has-text("Not Now")'
                ];

                let notNowFound = false;
                for (const notNowSelector of notNowSelectors) {
                    const notNowButton = await page.$(notNowSelector);
                    if (notNowButton) {
                        await notNowButton.click();
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
                    const textArea = await page.$(selector);
                    if (textArea) {
                        await textArea.click();
                        console.log(`Clicked text area using selector: ${selector}`);
                        textAreaClicked = true;
                        await sleep(1000);
                        // As soon as we click the text area, stop listening for DTSG error for this user
                        page.off('console', consoleListener);
                        break;
                    }
                } catch (err) {
                    console.log(`Error with text area selector ${selector}`);
                }
            }

            if (!textAreaClicked) {
                // If we never clicked the text area, check for DTSG error and retry if needed
                page.off('console', consoleListener);
                if (dtsgErrorDetected) {
                    console.log('DTSG error detected before message text area, will retry profile navigation and message send.');
                    if (attempt < maxRetries) {
                        continue; // Retry
                    } else {
                        console.log('Max retries reached for DTSG error. Giving up.');
                        return false;
                    }
                }
                console.log(`Failed to click text area for ${username}`);
                return false;
            }

            // Type the message with Shift+Enter for line breaks
            console.log("Typing message...");
            try {
                const messageLines = message.split('\n');
                for (let i = 0; i < messageLines.length; i++) {
                    await page.keyboard.type(messageLines[i]);
                    if (i < messageLines.length - 1) {
                        await page.keyboard.down('Shift');
                        await page.keyboard.press('Enter');
                        await page.keyboard.up('Shift');
                    }
                }
                console.log("Message typed successfully");
                await page.keyboard.press('Enter');
                console.log("Message sent");
                await sleep(5000); // Wait 5 seconds after sending the message
                return true;
            } catch (err) {
                console.error("Error typing message:", err.message);
                return false;
            }
        } catch (error) {
            page.off('console', consoleListener);
            if (attempt < maxRetries) {
                console.log(`Error or DTSG error detected, retrying sendWelcomeMessage for ${username} (attempt ${attempt + 2})`);
                continue;
            }
            console.error(`Failed to message ${username}:`, error);
            return false;
        }
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

    let client, browser, context, page, collection = null;
    const processedUsers = [];
    const failedUsers = [];

    try {
        // Update job status to running
        if (jobManager && jobId) jobManager.updateJobStatus(jobId, 'running');

        // Set up browserless.io endpoint if API key is provided
        let browserlessWSEndpoint = null;
        if (browserlessApiKey) {
            try {
                // Use secure WebSocket connection with better error handling
                browserlessWSEndpoint = `wss://production-sfo.browserless.io/chromium/playwright?token=${browserlessApiKey}&proxy=residential&stealth=true`;
                console.log(`[Job ${jobId}] Using browserless.io service with enhanced parameters`);

                // Add a warning to the job for monitoring
                if (jobManager && jobId) jobManager.updateJobStatus(jobId, 'initializing', {
                    warning: 'Using remote browser service. Connection stability depends on network conditions.'
                });
            } catch (error) {
                console.error(`[Job ${jobId}] Error setting up browserless endpoint:`, error);
                if (jobManager && jobId) jobManager.updateJobStatus(jobId, 'warning', {
                    warning: 'Failed to set up browserless.io service, falling back to local browser'
                });
                // Ensure browserlessWSEndpoint is null for fallback
                browserlessWSEndpoint = null;
            }
        }

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
            if (jobManager && jobId) jobManager.failJob(jobId, `Cookie error: ${cookieError.message}`);
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
            if (jobManager && jobId) jobManager.updateJobStatus(jobId, 'warning', {
                warning: 'Database connection failed, proceeding without persistent storage'
            });
        }

        // Initialize browser with enhanced error handling
        if (jobManager && jobId) jobManager.updateJobStatus(jobId, 'initializing_browser');
        console.log(`[Job ${jobId}] Initializing browser...`);

        let browserObj;
        try {
            // Pass browserlessWSEndpoint safely - will be null if not set up properly
            browserObj = await initBrowser(cookies, headless, browserlessWSEndpoint);
            browser = browserObj.browser;
            context = browserObj.context;
            page = browserObj.page;
            console.log(`[Job ${jobId}] Browser successfully initialized`);
        } catch (browserError) {
            console.error(`[Job ${jobId}] Fatal browser initialization error:`, browserError);

            // If the error is related to browserWSEndpoint, try again with local browser
            if (browserlessWSEndpoint &&
                (browserError.message.includes('wsEndpoint') ||
                    browserError.message.includes('socket hang up') ||
                    browserError.message.includes('ECONNRESET') ||
                    browserError.message.includes('Connection timeout'))) {

                console.log(`[Job ${jobId}] Retrying with local browser after remote browser error`);
                if (jobManager && jobId) jobManager.updateJobStatus(jobId, 'retrying_with_local', {
                    warning: 'Remote browser connection failed, retrying with local browser'
                });

                try {
                    // Try again without browserless
                    browserObj = await initBrowser(cookies, headless, null);
                    browser = browserObj.browser;
                    context = browserObj.context;
                    page = browserObj.page;
                    console.log(`[Job ${jobId}] Browser successfully initialized with local browser`);
                } catch (localBrowserError) {
                    // If local browser also fails, then fail the job
                    console.error(`[Job ${jobId}] Local browser initialization also failed:`, localBrowserError);
                    if (jobManager && jobId) jobManager.failJob(jobId, `Browser initialization failed: ${localBrowserError.message}`);
                    throw localBrowserError;
                }
            } else {
                if (jobManager && jobId) jobManager.failJob(jobId, `Browser initialization failed: ${browserError.message}`);
                throw browserError;
            }
        }

        // Check if we're successfully logged in with robust error handling
        try {
            await page.goto('https://www.instagram.com/', {
                timeout: 90000 // 90 second timeout
            });

            const isLoggedIn = await page.evaluate(() => {
                return !document.querySelector('input[name="username"]');
            });

            if (!isLoggedIn) {
                console.error(`[Job ${jobId}] Not logged in. Please check your cookies.`);
                if (jobManager && jobId) jobManager.failJob(jobId, 'Authentication failed - please check your cookie file');
                throw new Error('Authentication failed - please check your cookie file');
            }

            console.log(`[Job ${jobId}] Successfully logged in to Instagram`);
        } catch (navError) {
            console.error(`[Job ${jobId}] Navigation or login check error:`, navError);
            if (jobManager && jobId) jobManager.failJob(jobId, `Instagram navigation failed: ${navError.message}`);
            throw navError;
        }

        // Get the account owner username
        const accountOwner = username;
        console.log(`[Job ${jobId}] Processing followers for Instagram account: ${accountOwner}`);
        if (jobManager && jobId) jobManager.updateJobStatus(jobId, 'checking_notifications');

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
                    if (jobManager && jobId) jobManager.updateJobStatus(jobId, 'warning', {
                        warning: 'Notification check failed, process may be incomplete'
                    });
                    // Continue with empty followers list rather than failing completely
                    newFollowers = [];
                }
            }
        }

        // Update job with total count
        if (jobManager && jobId) jobManager.setTotalFollowers(jobId, newFollowers.length);

        if (newFollowers.length === 0) {
            console.log(`[Job ${jobId}] No new followers to process`);
            if (jobManager && jobId) jobManager.updateJobStatus(jobId, 'completed', {
                message: 'No new followers to process'
            });
            return { processedUsers, failedUsers };
        }

        // Send welcome messages to new followers
        if (jobManager && jobId) jobManager.updateJobStatus(jobId, 'sending_messages');
        console.log(`[Job ${jobId}] Sending welcome messages to ${newFollowers.length} new followers...`);

        for (const username of newFollowers) {
            try {
                console.log(`[Job ${jobId}] Processing new follower: ${username}`);

                // Send the welcome message
                const messageSent = await sendWelcomeMessage(page, username, welcomeMessage);

                if (messageSent) {
                    console.log(`[Job ${jobId}] Welcome message sent to ${username}`);

                    // Mark user as processed in MongoDB only if message was sent
                    const marked = await markUserAsProcessed(collection, username, accountOwner);
                    if (marked) {
                        processedUsers.push(username);
                        if (jobManager && jobId) jobManager.addProcessedUser(jobId, username);
                    }
                } else {
                    failedUsers.push(username);
                    if (jobManager && jobId) jobManager.addFailedUser(jobId, username);
                }
            } catch (error) {
                console.error(`[Job ${jobId}] Error processing follower ${username}:`, error);
                failedUsers.push(username);
            }

            // Respect Instagram's rate limits - wait between 30 to 60 seconds between messages
            const waitTime = Math.floor(Math.random() * (60000 - 30000 + 1)) + 30000;
            console.log(`[Job ${jobId}] Waiting ${Math.round(waitTime / 1000)} seconds before next action...`);
            await sleep(waitTime);
        }

        console.log(`[Job ${jobId}] Processed ${processedUsers.length} users, failed to process ${failedUsers.length} users`);
        if (jobManager && jobId) jobManager.updateJobStatus(jobId, 'completed', {
            message: `Processed ${processedUsers.length} users, failed to process ${failedUsers.length} users`
        });

        return { processedUsers, failedUsers };
    } catch (error) {
        console.error(`[Job ${jobId}] Unexpected error:`, error);
        if (jobManager && jobId) jobManager.failJob(jobId, `Unexpected error: ${error.message}`);
        throw error;
    } finally {
        // Clean up resources
        try {
            if (browser) {
                await browser.close();
                console.log(`[Job ${jobId}] Browser closed`);
            }
            if (client) {
                await client.close();
                console.log(`[Job ${jobId}] MongoDB client closed`);
            }
        } catch (cleanupError) {
            console.error(`[Job ${jobId}] Error during cleanup:`, cleanupError);
        }
    }
}

module.exports = {
    processFollowers: async function (options) {
        // For sync API, run processFollowersJob without jobManager
        return await processFollowersJob(options, null, null);
    },
    startProcessFollowers,
    sendWelcomeMessage,
    loadCookies,
    initBrowser
};
