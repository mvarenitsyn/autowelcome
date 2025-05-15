# Instagram Auto Welcome API

An API for automatically welcoming new Instagram followers with customizable messages.

## Features

- RESTful API to automate sending welcome messages to new Instagram followers
- Uses cookies for authentication (no password required)
- File upload support for cookie files
- Customizable welcome messages
- MongoDB integration for tracking processed users
- Headless browser support for server deployment
- Browserless.io integration for scalable cloud deployments

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
BROWSERLESS_API_KEY=your-browserless-api-key # Optional, for browserless.io integration
```

## API Usage

### Process New Followers

**Endpoint**: `POST /api/process-followers`

This is a `multipart/form-data` request that accepts a cookie file upload.

**Form Parameters**:
- `cookieFile`: (required) JSON file containing Instagram cookies
- `username`: (required) Your Instagram username
- `welcomeMessage`: (optional) Custom welcome message
- `browserlessApiKey`: (optional) Your browserless.io API key for cloud browser execution
- `async`: (optional) Set to "true" to process followers asynchronously and return immediately with a job ID

**Synchronous Response** (when `async` is not set):
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
  "failedUsers": [],
  "async": false
}
```

**Asynchronous Response** (when `async` is set to "true"):
```json
{
  "success": true,
  "jobId": "abcdef123456789",
  "message": "Job created successfully. Use the job ID to check status.",
  "async": true
}
```

### Send a Custom Message to a Specific User

**Endpoint**: `POST /api/send-message`

This endpoint allows you to send a custom message to any Instagram user using your cookies. It supports synchronous and asynchronous (background job) modes, as well as browserless.io remote browser execution.

**Form Parameters**:
- `cookieFile`: (required) JSON file containing Instagram cookies
- `username`: (required) Instagram username to send the message to
- `message`: (required) The message to send
- `useBrowserless`: (optional) Set to "true" to use browserless.io remote browser
- `browserlessApiKey`: (optional) Your browserless.io API key
- `headless`: (optional) Set to "false" to see the browser window (default is true)
- `async`: (optional) Set to "true" to process the message sending as a background job

**Synchronous Response** (when `async` is not set):
```json
{
  "success": true,
  "message": "Message sent successfully"
}
```

**Asynchronous Response** (when `async` is set to "true"):
```json
{
  "success": true,
  "jobId": "abcdef123456789",
  "message": "Job created successfully. Use the job ID to check status.",
  "async": true
}
```

### Example with cURL

```bash
# Synchronous processing (wait for completion)
curl -X POST http://localhost:3000/api/process-followers \
  -F "cookieFile=@/path/to/your/cookies.json" \
  -F "username=your_instagram_username" \
  -F "welcomeMessage=Thank you for following me! I appreciate your support."

# Asynchronous processing (return immediately with job ID)
curl -X POST http://localhost:3000/api/process-followers \
  -F "cookieFile=@/path/to/your/cookies.json" \
  -F "username=your_instagram_username" \
  -F "welcomeMessage=Thank you for following me!" \
  -F "async=true"

# Using with browserless.io
curl -X POST http://localhost:3000/api/process-followers \
  -F "cookieFile=@/path/to/your/cookies.json" \
  -F "username=your_instagram_username" \
  -F "welcomeMessage=Thank you for following me!" \
  -F "browserlessApiKey=your-browserless-api-key" \
  -F "async=true"

# Send a custom message to a specific user
curl -X POST http://localhost:3000/api/send-message \
  -F "cookieFile=@/path/to/your/cookies.json" \
  -F "username=target_username" \
  -F "message=Hello from the API!"

# Asynchronous message sending (background job)
curl -X POST http://localhost:3000/api/send-message \
  -F "cookieFile=@/path/to/your/cookies.json" \
  -F "username=target_username" \
  -F "message=Hello from the API!" \
  -F "async=true"

# Using browserless.io for message sending
curl -X POST http://localhost:3000/api/send-message \
  -F "cookieFile=@/path/to/your/cookies.json" \
  -F "username=target_username" \
  -F "message=Hello from the API!" \
  -F "useBrowserless=true" \
  -F "browserlessApiKey=your-browserless-api-key"
```

### Example with JavaScript (Node.js)

#### Process New Followers
```js
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

const form = new FormData();
form.append('cookieFile', fs.createReadStream('./igcookie.json'));
form.append('username', 'your_instagram_username');
form.append('welcomeMessage', 'Thank you for following!');
// form.append('async', 'true'); // Uncomment for async
// form.append('useBrowserless', 'true'); // Uncomment for browserless.io
// form.append('browserlessApiKey', 'your-browserless-api-key');

axios.post('http://localhost:3003/api/process-followers', form, {
  headers: form.getHeaders()
}).then(res => {
  console.log(res.data);
}).catch(err => {
  if (err.response) console.error(err.response.data);
  else console.error(err);
});
```

#### Send a Custom Message to a Specific User
```js
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

const form = new FormData();
form.append('cookieFile', fs.createReadStream('./igcookie.json'));
form.append('username', 'target_username');
form.append('message', 'Hello from the API!');
// form.append('async', 'true'); // Uncomment for async
// form.append('useBrowserless', 'true'); // Uncomment for browserless.io
// form.append('browserlessApiKey', 'your-browserless-api-key');
// form.append('headless', 'false'); // Uncomment to see browser window

axios.post('http://localhost:3003/api/send-message', form, {
  headers: form.getHeaders()
}).then(res => {
  console.log(res.data);
}).catch(err => {
  if (err.response) console.error(err.response.data);
  else console.error(err);
});
```

### Cookie File Format

Your cookie file should be a JSON file containing an array of cookie objects:

```json
[
  {
    "name": "cookie_name",
    "value": "cookie_value",
    "domain": ".instagram.com",
    "path": "/",
    "secure": true,
    "httpOnly": true,
    "expirationDate": 1234567890
  },
  ...
]
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

### Check Job Status

**Endpoint**: `GET /api/jobs/:jobId`

Use this endpoint to check the status of an asynchronous job.

**URL Parameters**:
- `jobId`: (required) The job ID returned from the asynchronous API call

**Response**:
```json
{
  "success": true,
  "job": {
    "id": "abcdef123456789",
    "status": "completed",
    "created": "2023-08-01T12:00:00.000Z",
    "updated": "2023-08-01T12:05:00.000Z",
    "completed": "2023-08-01T12:05:00.000Z",
    "progress": {
      "total": 5,
      "processed": 5
    },
    "processedUsers": [
      {
        "username": "follower1",
        "status": "success",
        "timestamp": "2023-08-01T12:02:00.000Z"
      }
    ],
    "failedUsers": [],
    "message": null,
    "error": null
  }
}
```

**Possible Job Statuses**:
- `queued`: Job has been created but not yet started
- `initializing`: Job is initializing (e.g., browser setup)
- `initializing_browser`: Setting up the browser
- `checking_notifications`: Checking Instagram notifications
- `sending_messages`: Sending messages to followers
- `reconnecting`: Reconnecting after a connection issue
- `completed`: Job has completed successfully
- `failed`: Job has failed with an error

### Example Job Status Check with cURL

```bash
curl -X GET http://localhost:3000/api/jobs/abcdef123456789
```

- The API operates in headless mode by default for server environments
- When using browserless.io, set your API key in the environment variables or pass it with each request
- For optimal results, refresh your cookie file regularly as Instagram cookies expire
- Files uploaded to the API are automatically deleted after processing for security
- For processing many followers, the asynchronous mode is recommended to avoid timeouts
- Asynchronous mode works with both local and remote browsers:
  - Set `useBrowserless=false` in the form data to force using the local browser in async mode
  - When browserless.io is not used, the async job will run on the server's local browser
  - This gives you flexibility to choose between scale (remote) and privacy (local)

## Limitations

- Job status and progress are stored in memory. If the server restarts, all job data is lost. For production, consider using a persistent job store.

## Web Interface

A simple web interface is available when you access the root URL. It provides a form where you can:
1. Upload your Instagram cookies JSON file
2. Enter your Instagram username
3. Customize the welcome message
4. Submit the form to process new followers

## License

MIT
