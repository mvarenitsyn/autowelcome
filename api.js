const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const instagramBot = require('./instagram_bot');
const jobManager = require('./job_manager');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Set up multer for file uploads
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Middleware
app.use(bodyParser.json());
app.use(express.static('public'));

// Clean up uploaded files after 24 hours
setInterval(() => {
    const uploadsDir = path.join(__dirname, 'uploads');
    if (fs.existsSync(uploadsDir)) {
        fs.readdir(uploadsDir, (err, files) => {
            if (err) {
                console.error('Error reading uploads directory:', err);
                return;
            }

            const now = Date.now();
            files.forEach(file => {
                const filePath = path.join(uploadsDir, file);
                if (file !== '.gitkeep') { // Don't delete placeholder files
                    fs.stat(filePath, (err, stats) => {
                        if (err) {
                            console.error(`Error getting file stats for ${file}:`, err);
                            return;
                        }

                        const fileAge = now - stats.mtime.getTime();
                        // Delete files older than 24 hours
                        if (fileAge > 24 * 60 * 60 * 1000) {
                            fs.unlink(filePath, err => {
                                if (err) {
                                    console.error(`Error deleting file ${file}:`, err);
                                } else {
                                    console.log(`Deleted old upload: ${file}`);
                                }
                            });
                        }
                    });
                }
            });
        });
    }
}, 60 * 60 * 1000); // Run cleanup every hour

// Home route
app.get('/', (req, res) => {
    res.send('Instagram Auto Welcome API running');
});

// API endpoint to process new followers (supports both synchronous and asynchronous modes)
app.post('/api/process-followers', upload.single('cookieFile'), async (req, res) => {
    try {
        const { username, welcomeMessage, browserlessApiKey, async } = req.body;
        const isAsync = async === 'true' || async === true;

        // Check for cookie file upload
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'Cookie file upload is required'
            });
        }

        if (!username) {
            return res.status(400).json({
                success: false,
                message: 'Account username is required'
            });
        }

        // If async mode is requested, create job and return immediately
        if (isAsync) {
            // Check if we should use browserless (if available)
            const useBrowserless = req.body.useBrowserless === 'true';

            // Get browserless API key, but only if we want to use it
            const apiKey = useBrowserless ?
                (browserlessApiKey || process.env.BROWSERLESS_API_KEY) :
                null;

            // Create job with or without browserless based on the setting
            const jobId = instagramBot.startProcessFollowers({
                cookieFile: req.file,
                username,
                welcomeMessage: welcomeMessage || process.env.WELCOME_MESSAGE || 'Thank you for following us!',
                headless: true, // Default to headless mode
                browserlessApiKey: apiKey // Will be null if useBrowserless is false
            }, jobManager);

            // Return immediately with job ID
            return res.json({
                success: true,
                jobId,
                message: 'Job created successfully. Use the job ID to check status.',
                async: true
            });
        }

        // Process followers synchronously (original behavior)
        const result = await instagramBot.processFollowers({
            cookieFile: req.file,
            username,
            welcomeMessage: welcomeMessage || process.env.WELCOME_MESSAGE || 'Thank you for following us!',
            headless: true, // Default to headless mode
            browserlessApiKey: browserlessApiKey || process.env.BROWSERLESS_API_KEY
        });

        // Clean up uploaded file after processing
        fs.unlinkSync(req.file.path);

        res.json({
            success: true,
            processedUsers: result.processedUsers,
            failedUsers: result.failedUsers,
            async: false
        });
    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({
            success: false,
            message: 'An error occurred while processing followers',
            error: error.message
        });
    }
});

// NEW API endpoint to create a processing job (asynchronous version)
app.post('/api/jobs/process-followers', upload.single('cookieFile'), (req, res) => {
    try {
        const { username, welcomeMessage, browserlessApiKey } = req.body;

        // Check for cookie file upload
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'Cookie file upload is required'
            });
        }

        if (!username) {
            return res.status(400).json({
                success: false,
                message: 'Account username is required'
            });
        }

        // Create job
        const jobId = instagramBot.startProcessFollowers({
            cookieFile: req.file,
            username,
            welcomeMessage: welcomeMessage || process.env.WELCOME_MESSAGE || 'Thank you for following us!',
            headless: true, // Default to headless mode
            browserlessApiKey: browserlessApiKey || process.env.BROWSERLESS_API_KEY
        }, jobManager);

        // Return immediately with job ID
        res.json({
            success: true,
            jobId,
            message: 'Job created successfully. Use the job ID to check status.'
        });
    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({
            success: false,
            message: 'An error occurred while creating the job',
            error: error.message
        });
    }
});

// API endpoint to check job status
app.get('/api/jobs/:jobId', (req, res) => {
    try {
        const jobId = req.params.jobId;
        const job = jobManager.getJob(jobId);

        if (!job) {
            return res.status(404).json({
                success: false,
                message: 'Job not found'
            });
        }

        res.json({
            success: true,
            job: {
                id: job.id,
                status: job.status,
                created: job.created,
                updated: job.updated,
                completed: job.completed,
                progress: job.progress,
                processedUsers: job.processedUsers,
                failedUsers: job.failedUsers,
                message: job.message,
                error: job.error
            }
        });
    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({
            success: false,
            message: 'An error occurred while fetching job status',
            error: error.message
        });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
