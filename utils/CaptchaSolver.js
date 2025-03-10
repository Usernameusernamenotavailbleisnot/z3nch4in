const axios = require('axios');
const chalk = require('chalk');
const { getTimestamp } = require('./delayUtils');

class CaptchaSolver {
    constructor(apiKey, walletNum = null) {
        this.apiKey = apiKey;
        this.walletNum = walletNum;
        this.baseURL = 'https://api.capsolver.com';
    }
    
    setWalletNum(num) {
        this.walletNum = num;
    }
    
    async solveRecaptcha(websiteURL, websiteKey) {
        try {
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Solving reCAPTCHA for ${websiteURL}...`));
            
            // Create task to solve CAPTCHA
            const createTaskResponse = await axios.post(`${this.baseURL}/createTask`, {
                clientKey: this.apiKey,
                task: {
                    type: "ReCaptchaV2TaskProxyLess",
                    websiteURL: websiteURL,
                    websiteKey: websiteKey,
                    isInvisible: true,
                }
            });
            
            if (createTaskResponse.data.errorId !== 0) {
                throw new Error(`Error creating CAPTCHA task: ${createTaskResponse.data.errorDescription}`);
            }
            
            const taskId = createTaskResponse.data.taskId;
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ CAPTCHA task created, ID: ${taskId}`));
            
            // Poll for task result
            let attempts = 0;
            const maxAttempts = 30; // Maximum polling attempts
            
            while (attempts < maxAttempts) {
                attempts++;
                
                // Wait before polling
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // Get task result
                const taskResultResponse = await axios.post(`${this.baseURL}/getTaskResult`, {
                    clientKey: this.apiKey,
                    taskId: taskId
                });
                
                if (taskResultResponse.data.errorId !== 0) {
                    throw new Error(`Error getting CAPTCHA task result: ${taskResultResponse.data.errorDescription}`);
                }
                
                const status = taskResultResponse.data.status;
                
                if (status === 'ready') {
                    const recaptchaToken = taskResultResponse.data.solution.gRecaptchaResponse;
                    console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ CAPTCHA solved successfully!`));
                    return recaptchaToken;
                }
                
                // If not ready, log progress every 5 attempts
                if (attempts % 5 === 0) {
                    console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Waiting for CAPTCHA solution (${attempts}/${maxAttempts})...`));
                }
            }
            
            throw new Error(`CAPTCHA solving timed out after ${maxAttempts} attempts`);
            
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Error solving CAPTCHA: ${error.message}`));
            return null;
        }
    }
}

module.exports = CaptchaSolver;