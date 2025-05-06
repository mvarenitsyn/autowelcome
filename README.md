# Instagram Auto Welcome API

An API for automatically welcoming new Instagram followers with customizable messages.

## Features

- RESTful API to automate sending welcome messages to new Instagram followers
- Uses cookies for authentication (no password required)
- Customizable welcome messages
- MongoDB integration for tracking processed users
- Headless browser support for server deployment
- Browserless compatibility for cloud environments

## Prerequisites

- Node.js (v16 or higher)
- MongoDB database
- Instagram cookies (exported as JSON)

## Installation

```bash
# Clone the repository
git clone https://github.com/mvarenitsyn/autowelcome.git
cd autowelcome/api

# Install dependencies
npm install
```

## Environment Variables

Create a `.env` file in the API directory with the following variables:

```
PORT=3000
MONGODB_URI=mongodb+srv://your-connection-string
DB_NAME=instagram_bot
COLLECTION_NAME=processed_users
WELCOME_MESSAGE=Thank you for following us! We appreciate your support.
```

## API Usage

### Process New Followers

**Endpoint**: `POST /api/process-followers`

**Request Body**:
```json
{
  "cookieContent": [
    {
      "name": "cookie_name",
      "value": "cookie_value",
      "domain": ".instagram.com",
      "path": "/",
      "secure": true,
      "httpOnly": true,
      "expirationDate": 1234567890
    }
  ],
  "username": "your_instagram_username",
  "welcomeMessage": "Thank you for following us! We appreciate your support."
}
```

**Response**:
```json
{
  "success": true,
  "processedUsers": [
    {
      "username": "follower1",
      "status": "success",
      "timestamp": "2023-08-01T12:00:00.000Z"
    }
  ],
  "failedUsers": []
}
```

## Deploying to Railway

1. Create a new project on [Railway](https://railway.app/)
2. Connect your GitHub repository
3. Add the required environment variables in the Railway dashboard
4. Set the build command to `npm install` in the Project Settings
5. Set the start command to `node api.js` in the Project Settings
6. Deploy the application

## Local Development

```bash
# Start the server
npm start

# Start with nodemon (auto-restart on changes)
npm run dev
```

## Notes

- The API operates in headless mode by default for server environments
- When using browserless environments, ensure all dependencies are properly installed
- For optimal results, refresh your cookie file regularly as Instagram cookies expire

## Web Interface

A simple web interface is available when you access the root URL. It provides a form where you can:
1. Paste your Instagram cookies in JSON format
2. Enter your Instagram username
3. Customize the welcome message
4. Submit the form to process new followers

## License

MIT
