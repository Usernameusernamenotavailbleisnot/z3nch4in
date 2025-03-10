const { Web3 } = require('web3');
const chalk = require('chalk');
const constants = require('../utils/constants');
const { addRandomDelay, getTimestamp } = require('../utils/delayUtils');

class TokenTransfer {
    constructor(config = {}) {
        // Set default config
        this.config = {
            enable_transfer: true,
            gas_price_multiplier: constants.GAS.PRICE_MULTIPLIER,
            transfer_amount_percentage: constants.TRANSFER.AMOUNT_PERCENTAGE,
            // Default to 1 transfer if not specified
            transfer_count: {
                min: 1,
                max: 1
            }
        };
        
        // Merge with provided config
        if (config) {
            this.config = { 
                ...this.config, 
                ...config,
                // Merge nested transfer_count object if it exists
                transfer_count: {
                    ...this.config.transfer_count,
                    ...(config.transfer_count || {})
                }
            };
        }
        
        // Setup web3 connection
        this.web3 = new Web3(constants.NETWORK.RPC_URL);
        
        // Current wallet number for logging
        this.currentWalletNum = 0;
        
        // Add nonce tracking to avoid transaction issues
        this.currentNonce = null;
    }
    
    // Get the next nonce, considering pending transactions
    async getNonce(address) {
        if (this.currentNonce === null) {
            // If this is the first transaction, get the nonce from the network
            this.currentNonce = await this.web3.eth.getTransactionCount(address);
            console.log(chalk.cyan(`${getTimestamp(this.currentWalletNum)} ℹ Initial nonce from network: ${this.currentNonce}`));
        } else {
            // For subsequent transactions, use the tracked nonce
            console.log(chalk.cyan(`${getTimestamp(this.currentWalletNum)} ℹ Using tracked nonce: ${this.currentNonce}`));
        }
        
        return this.currentNonce;
    }
    
    // Update nonce after a transaction is sent
    incrementNonce() {
        if (this.currentNonce !== null) {
            this.currentNonce++;
            console.log(chalk.cyan(`${getTimestamp(this.currentWalletNum)} ℹ Incremented nonce to: ${this.currentNonce}`));
        }
    }
    
    // Enhanced gas price calculation with retries
    async getGasPrice(retryCount = 0) {
        try {
            // Get the current gas price from the network
            const networkGasPrice = await this.web3.eth.getGasPrice();
            
            // Apply base multiplier from config
            let multiplier = this.config.gas_price_multiplier || constants.GAS.PRICE_MULTIPLIER;
            
            // Apply additional multiplier for retries
            if (retryCount > 0) {
                const retryMultiplier = Math.pow(constants.GAS.RETRY_INCREASE, retryCount);
                multiplier *= retryMultiplier;
                console.log(chalk.cyan(`${getTimestamp(this.currentWalletNum)} ℹ Applying retry multiplier: ${retryMultiplier.toFixed(2)}x (total: ${multiplier.toFixed(2)}x)`));
            }
            
            // Calculate gas price with multiplier
            const adjustedGasPrice = BigInt(Math.floor(Number(networkGasPrice) * multiplier));
            
            // Convert to gwei for display
            const gweiPrice = this.web3.utils.fromWei(adjustedGasPrice.toString(), 'gwei');
            console.log(chalk.cyan(`${getTimestamp(this.currentWalletNum)} ℹ Network gas price: ${this.web3.utils.fromWei(networkGasPrice, 'gwei')} gwei, using: ${gweiPrice} gwei (${multiplier.toFixed(2)}x)`));
            
            // Enforce min/max gas price in gwei
            const minGasPrice = BigInt(this.web3.utils.toWei(constants.GAS.MIN_GWEI.toString(), 'gwei'));
            const maxGasPrice = BigInt(this.web3.utils.toWei(constants.GAS.MAX_GWEI.toString(), 'gwei'));
            
            // Ensure gas price is within bounds
            let finalGasPrice = adjustedGasPrice;
            if (adjustedGasPrice < minGasPrice) {
                finalGasPrice = minGasPrice;
                console.log(chalk.yellow(`${getTimestamp(this.currentWalletNum)} ⚠ Gas price below minimum, using: ${constants.GAS.MIN_GWEI} gwei`));
            } else if (adjustedGasPrice > maxGasPrice) {
                finalGasPrice = maxGasPrice;
                console.log(chalk.yellow(`${getTimestamp(this.currentWalletNum)} ⚠ Gas price above maximum, using: ${constants.GAS.MAX_GWEI} gwei`));
            }
            
            return finalGasPrice.toString();
        } catch (error) {
            console.log(chalk.yellow(`${getTimestamp(this.currentWalletNum)} ⚠ Error getting gas price: ${error.message}`));
            
            // Fallback to a low gas price
            const fallbackGasPrice = this.web3.utils.toWei(constants.GAS.MIN_GWEI.toString(), 'gwei');
            console.log(chalk.yellow(`${getTimestamp(this.currentWalletNum)} ⚠ Using fallback gas price: ${constants.GAS.MIN_GWEI} gwei`));
            
            return fallbackGasPrice;
        }
    }
    
    // Improved gas estimation with buffer
    async estimateGas(txObject) {
        try {
            // Get the gas estimate from the blockchain
            const estimatedGas = await this.web3.eth.estimateGas(txObject);
            
            // Add 20% buffer for safety
            const gasWithBuffer = Math.floor(Number(estimatedGas) * 1.2);
            
            console.log(chalk.cyan(`${getTimestamp(this.currentWalletNum)} ℹ Estimated gas: ${estimatedGas}, with buffer: ${gasWithBuffer}`));
            
            return gasWithBuffer;
        } catch (error) {
            console.log(chalk.yellow(`${getTimestamp(this.currentWalletNum)} ⚠ Gas estimation failed: ${error.message}`));
            
            // Use default gas
            const defaultGas = constants.GAS.DEFAULT_GAS;
            console.log(chalk.yellow(`${getTimestamp(this.currentWalletNum)} ⚠ Using default gas: ${defaultGas}`));
            return defaultGas;
        }
    }

    async executeTransfer(privateKey, walletNum, transferNum = 1, totalTransfers = 1) {
        if (!this.config.enable_transfer) {
            return true;
        }

        this.currentWalletNum = walletNum;
        
        try {
            if (!privateKey.startsWith('0x')) {
                privateKey = '0x' + privateKey;
            }

            const account = this.web3.eth.accounts.privateKeyToAccount(privateKey);
            const balance = BigInt(await this.web3.eth.getBalance(account.address));
            
            if (balance === BigInt(0)) {
                console.log(chalk.yellow(`${getTimestamp(this.currentWalletNum)} ⚠ No balance to transfer`));
                return true;
            }

            // Add random delay before transfer
            await addRandomDelay(this.config, this.currentWalletNum, `transfer #${transferNum}/${totalTransfers}`);

            // Get nonce and gas price with optimizations
            const nonce = await this.getNonce(account.address);
            const gasPrice = await this.getGasPrice();
            
            // Estimate gas (should be 21000 for simple transfers)
            const txTemplate = {
                to: account.address,
                from: account.address,
                data: '0x',
                nonce: nonce,
                chainId: constants.NETWORK.CHAIN_ID
            };
            
            const gasLimit = await this.estimateGas(txTemplate) || 21000;
            
            // Calculate gas cost
            const gasCost = BigInt(gasLimit) * BigInt(gasPrice);
            
            // Calculate amount to transfer based on percentage
            const transferPercentage = BigInt(this.config.transfer_amount_percentage);
            const transferAmount = (balance * transferPercentage / BigInt(100)) - gasCost;

            if (transferAmount <= 0) {
                console.log(chalk.yellow(`${getTimestamp(this.currentWalletNum)} ⚠ Balance too low to cover gas`));
                return true;
            }
            
            // Create the transaction
            const transaction = {
                ...txTemplate,
                value: transferAmount.toString(),
                gas: gasLimit,
                gasPrice: gasPrice
            };

            // Sign and send transaction
            console.log(chalk.cyan(`${getTimestamp(this.currentWalletNum)} ℹ Sending transfer #${transferNum}/${totalTransfers} of ${this.web3.utils.fromWei(transferAmount.toString(), 'ether')} ${constants.NETWORK.CURRENCY_SYMBOL} to self`));
            
            // Increment nonce before sending
            this.incrementNonce();
            
            const signed = await this.web3.eth.accounts.signTransaction(transaction, privateKey);
            const receipt = await this.web3.eth.sendSignedTransaction(signed.rawTransaction);
            
            console.log(chalk.green(`${getTimestamp(this.currentWalletNum)} ✓ Transfer #${transferNum}/${totalTransfers} successful`));
            console.log(chalk.green(`${getTimestamp(this.currentWalletNum)} ✓ View transaction: ${constants.NETWORK.EXPLORER_URL}/tx/${receipt.transactionHash}`));
            
            return true;
            
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(this.currentWalletNum)} ✗ Error in transfer #${transferNum}/${totalTransfers}: ${error.message}`));
            return false;
        }
    }

    async transferToSelf(privateKey, walletNum = 0) {
        if (!this.config.enable_transfer) {
            return true;
        }

        this.currentWalletNum = walletNum;
        // Reset nonce tracking for new wallet
        this.currentNonce = null;

        console.log(chalk.blue.bold(`${getTimestamp(this.currentWalletNum)} Starting token transfer operations...`));
        
        try {
            // Get transfer count from config
            let minTransfers = 1;
            let maxTransfers = 1;
            
            if (this.config.transfer_count) {
                if (typeof this.config.transfer_count === 'object') {
                    // Using min/max format
                    minTransfers = Math.max(1, this.config.transfer_count.min || 1);
                    maxTransfers = Math.max(minTransfers, this.config.transfer_count.max || 1);
                } else {
                    // Using direct value format
                    minTransfers = maxTransfers = this.config.transfer_count;
                }
            }
            
            // Determine random transfer count between min and max
            const transferCount = Math.floor(Math.random() * (maxTransfers - minTransfers + 1)) + minTransfers;
            
            console.log(chalk.cyan(`${getTimestamp(this.currentWalletNum)} ℹ Will perform ${transferCount} self-transfers (min: ${minTransfers}, max: ${maxTransfers})...`));
            
            let successCount = 0;
            for (let i = 1; i <= transferCount; i++) {
                const success = await this.executeTransfer(privateKey, walletNum, i, transferCount);
                if (success) {
                    successCount++;
                }
                
                // Add delay between transfers if not the last one
                if (i < transferCount) {
                    await addRandomDelay(this.config, this.currentWalletNum, `next transfer (${i+1}/${transferCount})`);
                }
            }
            
            console.log(chalk.green(`${getTimestamp(this.currentWalletNum)} ✓ Self-transfer operations completed: ${successCount}/${transferCount} successful transfers`));
            return successCount > 0;
            
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(this.currentWalletNum)} ✗ Error in transfer operations: ${error.message}`));
            return false;
        }
    }
}

module.exports = TokenTransfer;