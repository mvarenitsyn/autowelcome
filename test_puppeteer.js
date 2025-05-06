const puppeteer = require('puppeteer');
const { execSync } = require('child_process');

async function testPuppeteer() {
    console.log('Starting Puppeteer test...');

    // Check Chrome location
    try {
        const chromePathMac = execSync('which google-chrome || which chrome || which chromium || echo ""').toString().trim();
        console.log('Chrome path on Mac:', chromePathMac || 'Not found');
    } catch (err) {
        console.log('Error checking Chrome path:', err.message);
    }

    try {
        console.log('Launching browser...');
        const browser = await puppeteer.launch({
            headless: false,  // Set to false to see the browser
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-web-security'
            ]
        });

        console.log('Browser launched successfully!');
        console.log('Creating new page...');
        const page = await browser.newPage();

        console.log('Navigating to google.com...');
        await page.goto('https://www.google.com');

        console.log('Page loaded successfully');
        const title = await page.title();
        console.log(`Page title: ${title}`);

        console.log('Closing browser...');
        await browser.close();

        console.log('Test completed successfully!');
    } catch (error) {
        console.error('Error in Puppeteer test:', error);
    }
}

testPuppeteer();
