const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const instagramBot = require('./instagram_bot');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(express.static('public'));

// Home route
app.get('/', (req, res) => {
    res.send('Instagram Auto Welcome API running');
});

// API endpoint to process new followers
app.post('/api/process-followers', async (req, res) => {
    try {
        const { cookieFilePath, username, welcomeMessage } = req.body;

        if (!cookieFilePath) {
            return res.status(400).json({
                success: false,
                message: 'Cookie file path is required'
            });
        }

        if (!username) {
            return res.status(400).json({
                success: false,
                message: 'Account username is required'
            });
        }

        // Process followers
        const result = await instagramBot.processFollowers({
            cookieFilePath,
            username,
            welcomeMessage: welcomeMessage || process.env.WELCOME_MESSAGE || 'Thank you for following us!',
            headless: true // Default to headless mode
        });

        res.json({
            success: true,
            processedUsers: result.processedUsers,
            failedUsers: result.failedUsers
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

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
