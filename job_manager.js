const crypto = require('crypto');

// In-memory job store
const jobs = new Map();

/**
 * Generates a unique job ID
 */
function generateJobId() {
    return crypto.randomBytes(16).toString('hex');
}

/**
 * Create a new job and return its ID
 */
function createJob(params) {
    const jobId = generateJobId();

    jobs.set(jobId, {
        id: jobId,
        status: 'queued',
        created: new Date(),
        params,
        result: null,
        processedUsers: [],
        failedUsers: [],
        error: null,
        progress: {
            total: 0,
            processed: 0
        }
    });

    return jobId;
}

/**
 * Get job status by ID
 */
function getJob(jobId) {
    return jobs.get(jobId) || null;
}

/**
 * Update job status
 */
function updateJobStatus(jobId, status, data = {}) {
    const job = jobs.get(jobId);

    if (!job) return false;

    job.status = status;
    job.updated = new Date();

    // Update any additional data
    Object.keys(data).forEach(key => {
        job[key] = data[key];
    });

    return true;
}

/**
 * Add a processed user to the job
 */
function addProcessedUser(jobId, userData) {
    const job = jobs.get(jobId);

    if (!job) return false;

    job.processedUsers.push(userData);
    job.progress.processed += 1;

    return true;
}

/**
 * Add a failed user to the job
 */
function addFailedUser(jobId, userData) {
    const job = jobs.get(jobId);

    if (!job) return false;

    job.failedUsers.push(userData);
    job.progress.processed += 1;

    return true;
}

/**
 * Set total followers to process
 */
function setTotalFollowers(jobId, total) {
    const job = jobs.get(jobId);

    if (!job) return false;

    job.progress.total = total;

    return true;
}

/**
 * Complete a job
 */
function completeJob(jobId, result = {}) {
    const job = jobs.get(jobId);

    if (!job) return false;

    job.status = 'completed';
    job.result = result;
    job.completed = new Date();

    return true;
}

/**
 * Fail a job
 */
function failJob(jobId, error) {
    const job = jobs.get(jobId);

    if (!job) return false;

    job.status = 'failed';
    job.error = error;
    job.completed = new Date();

    return true;
}

/**
 * Clean up old jobs (optional, to prevent memory leaks)
 */
function cleanupOldJobs(maxAgeHours = 24) {
    const now = new Date();

    for (const [jobId, job] of jobs.entries()) {
        const jobDate = job.completed || job.created;
        const ageHours = (now - jobDate) / (1000 * 60 * 60);

        if (ageHours > maxAgeHours) {
            jobs.delete(jobId);
        }
    }
}

// Run cleanup every hour
setInterval(() => cleanupOldJobs(), 60 * 60 * 1000);

module.exports = {
    createJob,
    getJob,
    updateJobStatus,
    addProcessedUser,
    addFailedUser,
    setTotalFollowers,
    completeJob,
    failJob
};
