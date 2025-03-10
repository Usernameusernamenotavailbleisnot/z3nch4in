const { Web3 } = require('web3');
const chalk = require('chalk');
const ora = require('ora');
const solc = require('solc');
const constants = require('../utils/constants');
const { addRandomDelay, getTimestamp } = require('../utils/delayUtils');

class ERC20TokenDeployer {
    constructor(privateKey, config = {}) {
        // Default ERC20 configuration
        this.defaultConfig = {
            enable_erc20: true,
            mint_amount: {
                min: 1000000,
                max: 10000000
            },
            burn_percentage: 10,
            decimals: 18
        };
        
        // Load configuration
        this.config = { ...this.defaultConfig, ...config.erc20 };
        
        // Also include the delay config from the main config
        if (config.delay) {
            this.config.delay = config.delay;
        }
        
        // Setup web3 connection
        this.rpcUrl = constants.NETWORK.RPC_URL;
        this.web3 = new Web3(this.rpcUrl);
        
        // Setup account
        if (!privateKey.startsWith('0x')) {
            privateKey = '0x' + privateKey;
        }
        this.account = this.web3.eth.accounts.privateKeyToAccount(privateKey);
        
        this.walletNum = null;
        
        // Add nonce tracking to avoid transaction issues
        this.currentNonce = null;
    }
    
    setWalletNum(num) {
        this.walletNum = num;
    }
    
    // Get the next nonce, considering pending transactions
    async getNonce() {
        if (this.currentNonce === null) {
            // If this is the first transaction, get the nonce from the network
            this.currentNonce = await this.web3.eth.getTransactionCount(this.account.address);
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Initial nonce from network: ${this.currentNonce}`));
        } else {
            // For subsequent transactions, use the tracked nonce
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Using tracked nonce: ${this.currentNonce}`));
        }
        
        return this.currentNonce;
    }
    
    // Update nonce after a transaction is sent
    incrementNonce() {
        if (this.currentNonce !== null) {
            this.currentNonce++;
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Incremented nonce to: ${this.currentNonce}`));
        }
    }
    
    // Enhanced gas price calculation with retries
    async getGasPrice(retryCount = 0) {
        try {
            // Get the current gas price from the network
            const networkGasPrice = await this.web3.eth.getGasPrice();
            
            // Apply base multiplier from config
            let multiplier = constants.GAS.PRICE_MULTIPLIER;
            
            // Apply additional multiplier for retries
            if (retryCount > 0) {
                const retryMultiplier = Math.pow(constants.GAS.RETRY_INCREASE, retryCount);
                multiplier *= retryMultiplier;
                console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Applying retry multiplier: ${retryMultiplier.toFixed(2)}x (total: ${multiplier.toFixed(2)}x)`));
            }
            
            // Calculate gas price with multiplier
            const adjustedGasPrice = BigInt(Math.floor(Number(networkGasPrice) * multiplier));
            
            // Convert to gwei for display
            const gweiPrice = this.web3.utils.fromWei(adjustedGasPrice.toString(), 'gwei');
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Network gas price: ${this.web3.utils.fromWei(networkGasPrice, 'gwei')} gwei, using: ${gweiPrice} gwei (${multiplier.toFixed(2)}x)`));
            
            // Enforce min/max gas price in gwei
            const minGasPrice = BigInt(this.web3.utils.toWei(constants.GAS.MIN_GWEI.toString(), 'gwei'));
            const maxGasPrice = BigInt(this.web3.utils.toWei(constants.GAS.MAX_GWEI.toString(), 'gwei'));
            
            // Ensure gas price is within bounds
            let finalGasPrice = adjustedGasPrice;
            if (adjustedGasPrice < minGasPrice) {
                finalGasPrice = minGasPrice;
                console.log(chalk.yellow(`${getTimestamp(this.walletNum)} ⚠ Gas price below minimum, using: ${constants.GAS.MIN_GWEI} gwei`));
            } else if (adjustedGasPrice > maxGasPrice) {
                finalGasPrice = maxGasPrice;
                console.log(chalk.yellow(`${getTimestamp(this.walletNum)} ⚠ Gas price above maximum, using: ${constants.GAS.MAX_GWEI} gwei`));
            }
            
            return finalGasPrice.toString();
        } catch (error) {
            console.log(chalk.yellow(`${getTimestamp(this.walletNum)} ⚠ Error getting gas price: ${error.message}`));
            
            // Fallback to a low gas price
            const fallbackGasPrice = this.web3.utils.toWei(constants.GAS.MIN_GWEI.toString(), 'gwei');
            console.log(chalk.yellow(`${getTimestamp(this.walletNum)} ⚠ Using fallback gas price: ${constants.GAS.MIN_GWEI} gwei`));
            
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
            
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Estimated gas: ${estimatedGas}, with buffer: ${gasWithBuffer}`));
            
            return gasWithBuffer;
        } catch (error) {
            console.log(chalk.yellow(`${getTimestamp(this.walletNum)} ⚠ Gas estimation failed: ${error.message}`));
            
            // Use default gas
            const defaultGas = constants.GAS.DEFAULT_GAS;
            console.log(chalk.yellow(`${getTimestamp(this.walletNum)} ⚠ Using default gas: ${defaultGas}`));
            return defaultGas;
        }
    }
    
    generateRandomTokenName() {
        const prefix = constants.ERC20.TOKEN_NAME_PREFIXES[Math.floor(Math.random() * constants.ERC20.TOKEN_NAME_PREFIXES.length)];
        const suffix = constants.ERC20.TOKEN_NAME_SUFFIXES[Math.floor(Math.random() * constants.ERC20.TOKEN_NAME_SUFFIXES.length)];
        return `${prefix} ${suffix}`;
    }
    
    generateTokenSymbol(name) {
        // Create a symbol from the first letters of each word in the name, up to 4-5 characters
        const symbol = name.split(' ')
            .map(word => word.charAt(0).toUpperCase())
            .join('');
            
        // If symbol is too long, take first 4-5 chars of first word
        if (symbol.length > 5) {
            return name.split(' ')[0].substring(0, 4).toUpperCase();
        }
        
        return symbol;
    }
    
    async compileContract(contractName) {
        const spinner = ora(`Compiling ERC20 contract (${contractName})...`).start();
        
        try {
            // Replace placeholder in template with actual contract name
            const contractSource = constants.ERC20.CONTRACT_TEMPLATE.replace(/{{CONTRACT_NAME}}/g, contractName);
            
            // Setup compiler input with specific EVM version to ensure compatibility
            const input = {
                language: 'Solidity',
                sources: {
                    'ERC20Contract.sol': {
                        content: contractSource
                    }
                },
                settings: {
                    outputSelection: {
                        '*': {
                            '*': ['abi', 'evm.bytecode']
                        }
                    },
                    optimizer: {
                        enabled: true,
                        runs: 200
                    },
                    evmVersion: 'paris' // Use paris EVM version (before Shanghai which introduced PUSH0)
                }
            };
            
            // Compile the contract
            const output = JSON.parse(solc.compile(JSON.stringify(input)));
            
            // Check for errors
            if (output.errors) {
                const errors = output.errors.filter(error => error.severity === 'error');
                if (errors.length > 0) {
                    throw new Error(`Compilation errors: ${errors.map(e => e.message).join(', ')}`);
                }
            }
            
            // Extract the contract
            const contract = output.contracts['ERC20Contract.sol'][contractName];
            
            spinner.succeed('ERC20 contract compiled successfully!');
            
            return {
                abi: contract.abi,
                bytecode: contract.evm.bytecode.object
            };
        } catch (error) {
            spinner.fail(`Failed to compile contract: ${error.message}`);
            throw error;
        }
    }
    
    async deployContract(contractName, symbol, decimals) {
        const spinner = ora(`Deploying ERC20 contract "${contractName}" (${symbol})...`).start();
        
        try {
            // Format contract name for Solidity (remove spaces and special chars)
            const solContractName = contractName.replace(/[^a-zA-Z0-9]/g, '');
            
            // Compile the contract
            spinner.stop(); // Stop spinner before compilation
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Compiling ERC20 contract...`));
            const compiledContract = await this.compileContract(solContractName);
            
            // Add random delay before deployment
            spinner.stop();
            await addRandomDelay(this.config, this.walletNum, "ERC20 contract deployment");
            spinner.start(`Deploying ERC20 contract "${contractName}" (${symbol})...`);
            
            // Create contract instance for deployment
            const contract = new this.web3.eth.Contract(compiledContract.abi);
            
            // Prepare deployment transaction
            const deployTx = contract.deploy({
                data: '0x' + compiledContract.bytecode,
                arguments: [contractName, symbol, decimals]
            });
            
            // Get nonce and gas price with optimizations - stop spinner during this
            spinner.stop();
            const currentNonce = await this.getNonce();
            const currentGasPrice = await this.getGasPrice();
            
            // Estimate gas - still no spinner
            let estimatedGas;
            try {
                estimatedGas = await deployTx.estimateGas({
                    from: this.account.address
                });
                console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Estimated gas: ${estimatedGas}`));
            } catch (error) {
                console.log(chalk.yellow(`${getTimestamp(this.walletNum)} ⚠ Gas estimation failed: ${error.message}`));
                estimatedGas = 2500000; // Default for ERC20 deployment
                console.log(chalk.yellow(`${getTimestamp(this.walletNum)} ⚠ Using default gas: ${estimatedGas}`));
            }
            
            // Prepare transaction object
            const tx = {
                from: this.account.address,
                nonce: currentNonce,
                gas: Math.floor(Number(estimatedGas) * 1.2), // Add 20% buffer
                gasPrice: currentGasPrice,
                data: deployTx.encodeABI(),
                chainId: constants.NETWORK.CHAIN_ID
            };
            
            // Sign transaction
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Signing ERC20 contract deployment transaction...`));
            const signedTx = await this.web3.eth.accounts.signTransaction(tx, this.account.privateKey);
            
            // Increment nonce before sending
            this.incrementNonce();
            
            // Restart spinner for transaction sending
            spinner.start('Sending ERC20 contract deployment transaction...');
            
            // Send the transaction
            const receipt = await this.web3.eth.sendSignedTransaction(signedTx.rawTransaction);
            
            spinner.succeed(`ERC20 contract deployed at: ${receipt.contractAddress}`);
            
            return {
                contractAddress: receipt.contractAddress,
                abi: compiledContract.abi,
                name: contractName,
                symbol: symbol,
                txHash: receipt.transactionHash
            };
        } catch (error) {
            spinner.fail(`Failed to deploy ERC20 contract: ${error.message}`);
            throw error;
        }
    }
    
    formatTokenAmount(amount, decimals) {
        // Convert normal amount to token amount with decimals (e.g., 100 -> 100000000000000000000 for 18 decimals)
        return BigInt(amount) * BigInt(10) ** BigInt(decimals);
    }
    
    async mintTokens(contractAddress, abi, amount, decimals) {
        try {
            // Add random delay before minting
            await addRandomDelay(this.config, this.walletNum, "token minting");
            
            // Create contract instance
            const contract = new this.web3.eth.Contract(abi, contractAddress);
            
            // Format the amount with decimals
            const formattedAmount = this.formatTokenAmount(amount, decimals).toString();
            
            // Prepare the mint transaction
            const mintTx = contract.methods.mint(this.account.address, formattedAmount);
            
            // Get nonce and gas price with optimizations
            const nonce = await this.getNonce();
            const gasPrice = await this.getGasPrice();
            
            // Transaction template for gas estimation
            const txTemplate = {
                from: this.account.address,
                to: contractAddress,
                data: mintTx.encodeABI(),
                nonce: nonce,
                chainId: constants.NETWORK.CHAIN_ID
            };
            
            // Estimate gas
            const gasLimit = await this.estimateGas(txTemplate);
            
            // Create transaction object
            const tx = {
                ...txTemplate,
                gas: gasLimit,
                gasPrice: gasPrice
            };
            
            // Sign and send the transaction
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Signing transaction for token minting...`));
            const signedTx = await this.web3.eth.accounts.signTransaction(tx, this.account.privateKey);
            
            // Increment nonce before sending
            this.incrementNonce();
            
            const receipt = await this.web3.eth.sendSignedTransaction(signedTx.rawTransaction);
            
            return {
                amount: amount,
                formattedAmount: formattedAmount,
                txHash: receipt.transactionHash,
                success: true
            };
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Error minting tokens: ${error.message}`));
            return {
                amount: amount,
                success: false,
                error: error.message
            };
        }
    }
    
    async burnTokens(contractAddress, abi, amount, decimals) {
        try {
            // Add random delay before burning
            await addRandomDelay(this.config, this.walletNum, "token burning");
            
            // Create contract instance
            const contract = new this.web3.eth.Contract(abi, contractAddress);
            
            // Format the amount with decimals
            const formattedAmount = this.formatTokenAmount(amount, decimals).toString();
            
            // Prepare the burn transaction
            const burnTx = contract.methods.burn(formattedAmount);
            
            // Get nonce and gas price with optimizations
            const nonce = await this.getNonce();
            const gasPrice = await this.getGasPrice();
            
            // Transaction template for gas estimation
            const txTemplate = {
                from: this.account.address,
                to: contractAddress,
                data: burnTx.encodeABI(),
                nonce: nonce,
                chainId: constants.NETWORK.CHAIN_ID
            };
            
            // Estimate gas
            const gasLimit = await this.estimateGas(txTemplate);
            
            // Create transaction object
            const tx = {
                ...txTemplate,
                gas: gasLimit,
                gasPrice: gasPrice
            };
            
            // Sign and send the transaction
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Signing transaction for token burning...`));
            const signedTx = await this.web3.eth.accounts.signTransaction(tx, this.account.privateKey);
            
            // Increment nonce before sending
            this.incrementNonce();
            
            const receipt = await this.web3.eth.sendSignedTransaction(signedTx.rawTransaction);
            
            return {
                amount: amount,
                formattedAmount: formattedAmount,
                txHash: receipt.transactionHash,
                success: true
            };
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Error burning tokens: ${error.message}`));
            return {
                amount: amount,
                success: false,
                error: error.message
            };
        }
    }
    
    async executeTokenOperations() {
        if (!this.config.enable_erc20) {
            console.log(chalk.yellow(`${getTimestamp(this.walletNum)} ⚠ ERC20 token operations disabled in config`));
            return true;
        }
        
        console.log(chalk.blue.bold(`${getTimestamp(this.walletNum)} Starting ERC20 token operations...`));
        
        try {
            // Reset nonce tracking at the start of operations
            this.currentNonce = null;
            
            // Generate random token name and symbol
            const tokenName = this.generateRandomTokenName();
            const symbol = this.generateTokenSymbol(tokenName);
            const decimals = this.config.decimals || 18;
            
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Token: ${tokenName} (${symbol})`));
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Decimals: ${decimals}`));
            
            // Deploy token contract
            const deployedContract = await this.deployContract(tokenName, symbol, decimals);
            
            // Determine mint amount based on config
            const minMint = Math.max(1, this.config.mint_amount?.min || 1000000);
            const maxMint = Math.max(minMint, this.config.mint_amount?.max || 10000000);
            const mintAmount = Math.floor(Math.random() * (maxMint - minMint + 1)) + minMint;
            
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Will mint ${mintAmount.toLocaleString()} tokens...`));
            
            // Mint tokens
            const mintResult = await this.mintTokens(
                deployedContract.contractAddress,
                deployedContract.abi,
                mintAmount,
                decimals
            );
            
            if (mintResult.success) {
                console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ Minted ${mintAmount.toLocaleString()} ${symbol} tokens`));
                console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ View transaction: ${constants.NETWORK.EXPLORER_URL}/tx/${mintResult.txHash}`));
                
                // Determine burn amount based on config percentage
                const burnPercentage = Math.min(100, Math.max(0, this.config.burn_percentage || 10));
                const burnAmount = Math.floor(mintAmount * burnPercentage / 100);
                
                if (burnAmount > 0) {
                    console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Burning ${burnAmount.toLocaleString()} tokens (${burnPercentage}% of minted)...`));
                    
                    const burnResult = await this.burnTokens(
                        deployedContract.contractAddress,
                        deployedContract.abi,
                        burnAmount,
                        decimals
                    );
                    
                    if (burnResult.success) {
                        console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ Burned ${burnAmount.toLocaleString()} ${symbol} tokens`));
                        console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ View transaction: ${constants.NETWORK.EXPLORER_URL}/tx/${burnResult.txHash}`));
                    } else {
                        console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Failed to burn tokens: ${burnResult.error}`));
                    }
                } else {
                    console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ No tokens to burn (burn percentage: ${burnPercentage}%)`));
                }
            } else {
                console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Failed to mint tokens: ${mintResult.error}`));
            }
            
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ ERC20 token operations completed!`));
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ Contract address: ${deployedContract.contractAddress}`));
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ Token: ${tokenName} (${symbol})`));
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ View contract: ${constants.NETWORK.EXPLORER_URL}/address/${deployedContract.contractAddress}`));
            
            return true;
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Error executing ERC20 token operations: ${error.message}`));
            return false;
        }
    }
}

module.exports = ERC20TokenDeployer;