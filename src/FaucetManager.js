const { Web3 } = require('web3');
const axios = require('axios');
const chalk = require('chalk');
const constants = require('../utils/constants');
const { addRandomDelay, getTimestamp } = require('../utils/delayUtils');
const CaptchaSolver = require('../utils/CaptchaSolver');
const { HttpsProxyAgent } = require('https-proxy-agent'); // Correct import with destructuring

class FaucetManager {
    constructor(config = {}, proxy = null) {
        // Default faucet configuration
        this.defaultConfig = {
            enable_faucet: true,
            max_retries: 3,
            max_wait_time: 300000,  // 5 minutes default wait time for balance increase
            check_interval: 5000,    // 5 seconds default check interval
            captcha_api_key: ''      // API key for capsolver, should be provided in config
        };
        
        // Load configuration, merging with defaults
        this.config = { ...this.defaultConfig, ...config.faucet };
        
        // Include delay config if available
        if (config.delay) {
            this.config.delay = config.delay;
        }
        
        // Save proxy if provided
        this.proxy = proxy;
        
        // Setup web3 connection
        this.rpcUrl = constants.NETWORK.RPC_URL;
        this.web3 = new Web3(this.rpcUrl);
        
        this.walletNum = null;
        
        // Initialize captcha solver if API key is available
        if (this.config.captcha_api_key) {
            this.captchaSolver = new CaptchaSolver(this.config.captcha_api_key);
        }
    }
    
    setWalletNum(num) {
        this.walletNum = num;
        if (this.captchaSolver) {
            this.captchaSolver.setWalletNum(num);
        }
    }
    
    /**
     * Request tokens from the Zenchain faucet
     * @param {string} walletAddress - Wallet address to receive tokens
     * @returns {Promise<boolean>} - Success status
     */
    async requestFaucet(walletAddress) {
        // Maximum number of retries for faucet request
        const maxRetries = this.config.max_retries || 3;
        let retryCount = 0;
        
        while (retryCount < maxRetries) {
            try {
                console.log(chalk.blue.bold(`${getTimestamp(this.walletNum)} Requesting tokens from Zenchain faucet... (Attempt ${retryCount + 1}/${maxRetries})`));
                
                // Check if we have a captcha solver available
                if (!this.captchaSolver) {
                    throw new Error("No captcha API key provided in config. Cannot request from faucet.");
                }
                
                // Add random delay before faucet request (longer delay on retries)
                const delayMultiplier = retryCount + 1;
                await addRandomDelay({
                    delay: {
                        min_seconds: this.config.delay?.min_seconds * delayMultiplier || 5 * delayMultiplier,
                        max_seconds: this.config.delay?.max_seconds * delayMultiplier || 15 * delayMultiplier
                    }
                }, this.walletNum, `faucet request (attempt ${retryCount + 1})`);
                
                // Solve the reCAPTCHA
                const websiteURL = constants.FAUCET.FAUCET_WEBSITE_URL;
                const websiteKey = constants.FAUCET.RECAPTCHA_SITE_KEY;
                
                const recaptchaToken = await this.captchaSolver.solveRecaptcha(websiteURL, websiteKey);
                
                if (!recaptchaToken) {
                    throw new Error("Failed to solve CAPTCHA");
                }
                
                // Prepare the request with complete headers
                const headers = {
                    "Content-Type": "application/json",
                    "Accept": "*/*",
                    "Accept-Encoding": "gzip, deflate, br, zstd",
                    "Accept-Language": "en-US,en;q=0.9",
                    "Origin": constants.FAUCET.FAUCET_WEBSITE_URL,
                    "Referer": constants.FAUCET.FAUCET_WEBSITE_URL,
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
                    "sec-ch-ua": '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
                    "sec-ch-ua-mobile": "?0",
                    "sec-ch-ua-platform": '"Windows"',
                    "sec-fetch-dest": "empty",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-site": "same-origin"
                };
                
                const payload = {
                    "address": walletAddress,
                    "recaptcha": recaptchaToken
                };
                
                // Make the request to the faucet API
                console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Sending request to Zenchain faucet API...`));
                
                // Configure axios options with proxy if available
                const axiosOptions = { 
                    headers: headers 
                };
                
                // Add proxy configuration if available
                if (this.proxy) {
                    try {
                        console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Using proxy: ${this.proxy}`));
                        
                        // Create proxy agent using the correct syntax
                        const proxyAgent = new HttpsProxyAgent(this.proxy);
                        axiosOptions.httpsAgent = proxyAgent;
                        axiosOptions.proxy = false; // Don't use the default proxy settings, use our agent instead
                    } catch (error) {
                        console.log(chalk.yellow(`${getTimestamp(this.walletNum)} ⚠ Error setting up proxy: ${error.message}`));
                        console.log(chalk.yellow(`${getTimestamp(this.walletNum)} ⚠ Continuing without proxy...`));
                    }
                }
                
                const response = await axios.post(
                    constants.FAUCET.FAUCET_API_URL,
                    payload,
                    axiosOptions
                );
                
                if (response.data && response.data.hash) {
                    console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ Faucet request successful! Transaction hash: ${response.data.hash}`));
                    console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ Drip amount: ${response.data.dripAmount} ${constants.NETWORK.CURRENCY_SYMBOL}`));
                    return true;
                } else if (response.data && response.data.error) {
                    // Check for waitlist error - no point in retrying this
                    if (response.data.error.includes("waitlist")) {
                        console.log(chalk.yellow(`${getTimestamp(this.walletNum)} ⚠ Faucet access limited: ${response.data.error}`));
                        console.log(chalk.yellow(`${getTimestamp(this.walletNum)} ⚠ Visit https://zenchain.io to join the waitlist.`));
                        // Exit retry loop as this won't change with retries
                        return false;
                    }
                    
                    console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Faucet error: ${response.data.error}`));
                    
                    // Increment retry counter
                    retryCount++;
                    
                    if (retryCount < maxRetries) {
                        const waitTime = Math.min(300, this.config.base_wait_time * (2 ** retryCount) || 10 * (2 ** retryCount));
                        console.log(chalk.yellow(`${getTimestamp(this.walletNum)} Waiting ${waitTime} seconds before retry...`));
                        await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
                    }
                    
                    continue;
                } else {
                    console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Unexpected response from faucet: ${JSON.stringify(response.data)}`));
                    
                    // Increment retry counter
                    retryCount++;
                    
                    if (retryCount < maxRetries) {
                        const waitTime = Math.min(300, this.config.base_wait_time * (2 ** retryCount) || 10 * (2 ** retryCount));
                        console.log(chalk.yellow(`${getTimestamp(this.walletNum)} Waiting ${waitTime} seconds before retry...`));
                        await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
                    }
                    
                    continue;
                }
                
            } catch (error) {
                console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Error requesting from faucet: ${error.message}`));
                if (error.response) {
                    console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Response status: ${error.response.status}`));
                    console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Response data: ${JSON.stringify(error.response.data)}`));
                }
                
                // Increment retry counter
                retryCount++;
                
                if (retryCount < maxRetries) {
                    const waitTime = Math.min(300, this.config.base_wait_time * (2 ** retryCount) || 10 * (2 ** retryCount));
                    console.log(chalk.yellow(`${getTimestamp(this.walletNum)} Waiting ${waitTime} seconds before retry...`));
                    await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
                }
            }
        }
        
        console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Failed to request tokens from faucet after ${maxRetries} attempts.`));
        return false;
    }
    
    /**
     * Wait for the wallet balance to increase
     * @param {string} walletAddress - The wallet address to check
     * @param {number} initialBalance - The initial balance before claiming
     * @param {number} maxWaitTime - Maximum wait time in milliseconds 
     * @param {number} checkInterval - Interval between checks in milliseconds
     * @returns {Promise<boolean>} - True if balance increased, false if timeout
     */
    async waitForBalanceIncrease(walletAddress, initialBalance = null, maxWaitTime = 300000, checkInterval = 5000) {
        try {
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Waiting for balance to increase after faucet claim...`));
            
            // If initial balance not provided, get it now
            if (initialBalance === null) {
                initialBalance = await this.web3.eth.getBalance(walletAddress);
                initialBalance = BigInt(initialBalance);
                console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Initial balance: ${this.web3.utils.fromWei(initialBalance.toString(), 'ether')} ${constants.NETWORK.CURRENCY_SYMBOL}`));
            } else {
                initialBalance = BigInt(initialBalance);
            }
            
            const startTime = Date.now();
            let waitedTime = 0;
            
            // Loop until timeout or balance increases
            while (waitedTime < maxWaitTime) {
                // Add a short delay between checks
                await new Promise(resolve => setTimeout(resolve, checkInterval));
                waitedTime = Date.now() - startTime;
                
                // Check current balance
                const currentBalance = BigInt(await this.web3.eth.getBalance(walletAddress));
                
                // Log progress
                if (waitedTime % 30000 < checkInterval) { // Log approximately every 30 seconds
                    const timeWaited = Math.floor(waitedTime / 1000);
                    const timeLeft = Math.floor((maxWaitTime - waitedTime) / 1000);
                    console.log(chalk.cyan(
                        `${getTimestamp(this.walletNum)} ℹ Current balance: ${this.web3.utils.fromWei(currentBalance.toString(), 'ether')} ${constants.NETWORK.CURRENCY_SYMBOL} ` + 
                        `(Waited ${timeWaited}s, ${timeLeft}s remaining)`
                    ));
                }
                
                // If balance increased, return true
                if (currentBalance > initialBalance) {
                    console.log(chalk.green(
                        `${getTimestamp(this.walletNum)} ✓ Balance increased! From ${this.web3.utils.fromWei(initialBalance.toString(), 'ether')} to ` +
                        `${this.web3.utils.fromWei(currentBalance.toString(), 'ether')} ${constants.NETWORK.CURRENCY_SYMBOL}`
                    ));
                    return true;
                }
            }
            
            console.log(chalk.yellow(`${getTimestamp(this.walletNum)} ⚠ Timeout waiting for balance to increase after ${maxWaitTime/1000} seconds`));
            return false;
            
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Error waiting for balance increase: ${error.message}`));
            return false;
        }
    }
    
    /**
     * Execute faucet operations for a wallet
     * @param {string} walletAddress - Wallet address to receive tokens
     * @returns {Promise<boolean>} - Success status
     */
    async executeFaucetOperations(walletAddress) {
        if (!this.config.enable_faucet) {
            console.log(chalk.yellow(`${getTimestamp(this.walletNum)} ⚠ Faucet operations disabled in config`));
            return false;
        }
        
        try {
            // Get initial balance before faucet claim
            const initialBalance = await this.web3.eth.getBalance(walletAddress);
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Initial wallet balance: ${this.web3.utils.fromWei(initialBalance, 'ether')} ${constants.NETWORK.CURRENCY_SYMBOL}`));
            
            // Request tokens from the faucet
            const faucetSuccess = await this.requestFaucet(walletAddress);
            
            // If faucet request was successful, wait for balance to increase
            if (faucetSuccess) {
                // Get the wait time and check interval from config or use defaults
                const maxWaitTime = this.config.max_wait_time || 300000; // 5 minutes default
                const checkInterval = this.config.check_interval || 5000; // 5 seconds default
                
                // Wait for balance to increase
                return await this.waitForBalanceIncrease(walletAddress, initialBalance, maxWaitTime, checkInterval);
            }
            
            return faucetSuccess;
            
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Error in faucet operations: ${error.message}`));
            return false;
        }
    }
}

module.exports = FaucetManager;