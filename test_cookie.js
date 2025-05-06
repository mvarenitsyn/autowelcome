const fs = require('fs');
const path = require('path');

// Function from instagram_bot.js with our fixes
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

        try {
            const cookies = JSON.parse(cookiesString);
            console.log('Successfully parsed JSON');
            console.log('Found', cookies.length, 'cookies');
            return { success: true, cookies };
        } catch (parseError) {
            console.error('Error parsing JSON:', parseError.message);
            console.log('First 100 characters of content:', cookiesString.substring(0, 100));
            throw new Error('Failed to parse cookie JSON');
        }
    } catch (error) {
        console.error('Error loading cookies:', error.message);
        throw error;
    }
}

// Test 1: Test with direct file path (should work)
console.log('\n=== Test 1: Path String ===');
try {
    const result1 = loadCookies(path.resolve(__dirname, '../rgamiamicookie.json'));
    console.log('Test 1 result:', result1.success);
} catch (error) {
    console.error('Test 1 failed:', error.message);
}

// Test 2: Simulate multer file object
console.log('\n=== Test 2: Multer-like Object ===');
try {
    // Create a mock file object similar to what multer provides
    const fileContent = fs.readFileSync(path.resolve(__dirname, '../rgamiamicookie.json'));
    const mockFile = {
        fieldname: 'cookieFile',
        originalname: 'rgamiamicookie.json',
        encoding: '7bit',
        mimetype: 'application/json',
        destination: 'uploads/',
        filename: 'test-filename',
        path: path.resolve(__dirname, '../rgamiamicookie.json'),
        size: fileContent.length
    };

    console.log('Testing with fixed loadCookies function...');
    const result2 = loadCookies(mockFile);
    console.log('Test 2 result:', result2.success);
} catch (error) {
    console.error('Test 2 failed:', error.message);
}

// Test 3: Using a real multer file from uploads
console.log('\n=== Test 3: Real Upload File ===');
try {
    // Find the latest upload file
    const uploadsDir = path.resolve(__dirname, 'uploads');
    const files = fs.readdirSync(uploadsDir);

    if (files.length > 0) {
        const latestFile = files[files.length - 1]; // Just pick the last file
        const uploadedFilePath = path.join(uploadsDir, latestFile);
        console.log('Testing with upload file:', uploadedFilePath);

        // Read the file to check its contents
        const fileContent = fs.readFileSync(uploadedFilePath, 'utf8');
        console.log('First 50 chars of file:', fileContent.substring(0, 50));

        // Create a multer-like object with this file
        const mockUploadedFile = {
            fieldname: 'cookieFile',
            originalname: 'uploaded-cookie.json',
            encoding: '7bit',
            mimetype: 'application/json',
            destination: 'uploads/',
            filename: latestFile,
            path: uploadedFilePath,
            size: fileContent.length
        };

        const result3 = loadCookies(mockUploadedFile);
        console.log('Test 3 result:', result3.success);
    } else {
        console.log('No upload files found');
    }
} catch (error) {
    console.error('Test 3 failed:', error.message);
}
