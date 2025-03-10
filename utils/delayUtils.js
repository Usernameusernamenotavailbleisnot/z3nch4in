const chalk = require('chalk');
const constants = require('./constants');

/**
 * Get a timestamp string for logging
 * @param {number|null} walletNum - Wallet number for contextual logging
 * @returns {string} - Formatted timestamp
 */
function getTimestamp(walletNum = null) {
    const now = new Date();
    const timestamp = now.toLocaleTimeString('en-US', { hour12: false });
    if (walletNum !== null) {
        return `[${timestamp} - Wallet ${walletNum}]`;
    }
    return `[${timestamp}]`;
}

/**
 * Adds a random delay between transactions based on config settings
 * @param {Object} config - The configuration object
 * @param {number} walletNum - The wallet number for logging
 * @param {string} operationName - The name of the operation (for logging)
 * @returns {Promise<void>}
 */
async function addRandomDelay(config, walletNum, operationName = 'next transaction') {
    try {
        // Get min and max delay from config or use defaults
        const minDelay = config?.delay?.min_seconds || constants.DELAY.MIN_SECONDS;
        const maxDelay = config?.delay?.max_seconds || constants.DELAY.MAX_SECONDS;
        
        // Generate random delay within the specified range
        const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
        
        console.log(chalk.yellow(`${getTimestamp(walletNum)} ⌛ Waiting ${delay} seconds before ${operationName}...`));
        await new Promise(resolve => setTimeout(resolve, delay * 1000));
        
        return true;
    } catch (error) {
        console.log(chalk.red(`${getTimestamp(walletNum)} ✗ Error in delay function: ${error.message}`));
        // Continue execution even if delay fails
        return false;
    }
}

module.exports = {
    addRandomDelay,
    getTimestamp
};