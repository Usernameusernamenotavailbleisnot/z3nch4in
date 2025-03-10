const { Web3 } = require('web3');
const chalk = require('chalk');
const ora = require('ora');
const solc = require('solc');
const constants = require('../utils/constants');
const { addRandomDelay, getTimestamp } = require('../utils/delayUtils');

class ContractDeployer {
    constructor(privateKey, config = {}) {
        // Default configuration
        this.defaultConfig = {
            enable_contract_deploy: true,
            contract_interactions: {
                enabled: true,
                count: {
                    min: 3,
                    max: 8
                },
                types: ["setValue", "increment", "decrement", "reset", "contribute"]
            },
            gas_price_multiplier: constants.GAS.PRICE_MULTIPLIER
        };
        
        // Load configuration, merging with defaults
        this.config = { ...this.defaultConfig, ...config };
        
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
            let multiplier = this.config.gas_price_multiplier || constants.GAS.PRICE_MULTIPLIER;
            
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
    
    async compileContract() {
        const spinner = ora('Compiling smart contract...').start();
        
        try {
            // Setup compiler input with specific EVM version to ensure compatibility
            const input = {
                language: 'Solidity',
                sources: {
                    'Contract.sol': {
                        content: constants.CONTRACT.SAMPLE_CONTRACT_SOURCE
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
            const contract = output.contracts['Contract.sol']['InteractiveContract'];
            
            spinner.succeed('Contract compiled successfully!');
            
            return {
                abi: contract.abi,
                bytecode: contract.evm.bytecode.object
            };
        } catch (error) {
            spinner.fail(`Failed to compile contract: ${error.message}`);
            throw error;
        }
    }
    
    async deployContract(compiledContract) {
        const spinner = ora('Deploying smart contract...').start();
        
        try {
            // Create contract instance for deployment
            const contract = new this.web3.eth.Contract(compiledContract.abi);
            
            // Prepare deployment transaction
            const deployTx = contract.deploy({
                data: '0x' + compiledContract.bytecode,
                arguments: []
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
                estimatedGas = 2000000; // Default for contract deployment
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
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Signing contract deployment transaction...`));
            const signedTx = await this.web3.eth.accounts.signTransaction(tx, this.account.privateKey);
            
            // Increment nonce before sending
            this.incrementNonce();
            
            // Restart spinner for transaction sending
            spinner.start('Sending contract deployment transaction...');
            
            // Send the transaction
            const receipt = await this.web3.eth.sendSignedTransaction(signedTx.rawTransaction);
            
            spinner.succeed(`Contract deployed at: ${receipt.contractAddress}`);
            
            return {
                contractAddress: receipt.contractAddress,
                abi: compiledContract.abi,
                txHash: receipt.transactionHash
            };
        } catch (error) {
            spinner.fail(`Failed to deploy contract: ${error.message}`);
            throw error;
        }
    }
    
    async interactWithContract(contractAddress, abi, interactionType) {
        try {
            // Create contract instance
            const contract = new this.web3.eth.Contract(abi, contractAddress);
            
            // Prepare the interaction based on type
            let method;
            let methodArgs = [];
            let value = '0';
            
            switch (interactionType) {
                case 'setValue':
                    const randomValue = Math.floor(Math.random() * 1000);
                    method = contract.methods.setValue(randomValue);
                    break;
                    
                case 'increment':
                    method = contract.methods.increment();
                    break;
                    
                case 'decrement':
                    method = contract.methods.decrement();
                    break;
                    
                case 'reset':
                    method = contract.methods.reset();
                    break;
                    
                case 'contribute':
                    method = contract.methods.contribute();
                    value = this.web3.utils.toWei('0.00001', 'ether'); // Small contribution
                    break;
                    
                default:
                    throw new Error(`Unknown interaction type: ${interactionType}`);
            }
            
            // Add random delay before this transaction
            await addRandomDelay(this.config, this.walletNum, `contract interaction (${interactionType})`);
            
            // Get nonce and gas price with optimizations
            const nonce = await this.getNonce();
            const gasPrice = await this.getGasPrice();
            
            // Create transaction template for gas estimation
            const txTemplate = {
                from: this.account.address,
                to: contractAddress,
                data: method.encodeABI(),
                nonce: nonce,
                value: value,
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
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Signing transaction for ${interactionType}...`));
            const signedTx = await this.web3.eth.accounts.signTransaction(tx, this.account.privateKey);
            
            // Increment nonce before sending
            this.incrementNonce();
            
            const receipt = await this.web3.eth.sendSignedTransaction(signedTx.rawTransaction);
            
            return {
                type: interactionType,
                txHash: receipt.transactionHash,
                success: true
            };
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Error with interaction ${interactionType}: ${error.message}`));
            return {
                type: interactionType,
                success: false,
                error: error.message
            };
        }
    }
    
    async executeContractOperations() {
        if (!this.config.enable_contract_deploy) {
            console.log(chalk.yellow(`${getTimestamp(this.walletNum)} ⚠ Contract deployment disabled in config`));
            return true;
        }
        
        console.log(chalk.blue.bold(`${getTimestamp(this.walletNum)} Starting contract operations...`));
        
        try {
            // Reset nonce tracking at the start of operations
            this.currentNonce = null;
            
            // Step 1: Compile the contract
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Compiling smart contract...`));
            const compiledContract = await this.compileContract();
            
            // Add random delay before contract deployment
            await addRandomDelay(this.config, this.walletNum, "contract deployment");
            
            // Step 2: Deploy the contract
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Deploying smart contract...`));
            const deployedContract = await this.deployContract(compiledContract);
            
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ Contract deployed at: ${deployedContract.contractAddress}`));
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ View transaction: ${constants.NETWORK.EXPLORER_URL}/tx/${deployedContract.txHash}`));
            
            // Skip interactions if disabled in config
            if (!this.config.contract_interactions?.enabled) {
                console.log(chalk.yellow(`${getTimestamp(this.walletNum)} ⚠ Contract interactions disabled in config`));
                return true;
            }
            
            // Step 3: Interact with the contract multiple times
            // Get interaction count from config, handling both object and direct value format
            let minInteractions = 3;
            let maxInteractions = 8;
            
            if (this.config.contract_interactions?.count) {
                if (typeof this.config.contract_interactions.count === 'object') {
                    // Using min/max format
                    minInteractions = Math.max(1, this.config.contract_interactions.count.min || 3);
                    maxInteractions = Math.max(minInteractions, this.config.contract_interactions.count.max || 8);
                } else {
                    // Using direct value format (for backward compatibility)
                    minInteractions = maxInteractions = this.config.contract_interactions.count;
                }
            }
            
            // Determine random interaction count between min and max
            const interactionCount = Math.floor(Math.random() * (maxInteractions - minInteractions + 1)) + minInteractions;
            
            const interactionTypes = this.config.contract_interactions?.types || ["setValue", "increment", "decrement", "reset"];
            
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Will perform ${interactionCount} interactions with contract (min: ${minInteractions}, max: ${maxInteractions})...`));
            
            let successCount = 0;
            for (let i = 0; i < interactionCount; i++) {
                // Select a random interaction type from the available types
                const interactionType = interactionTypes[Math.floor(Math.random() * interactionTypes.length)];
                
                console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Interaction ${i+1}/${interactionCount}: ${interactionType}...`));
                
                const result = await this.interactWithContract(
                    deployedContract.contractAddress,
                    deployedContract.abi,
                    interactionType
                );
                
                if (result.success) {
                    console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ ${interactionType} successful`));
                    console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ View transaction: ${constants.NETWORK.EXPLORER_URL}/tx/${result.txHash}`));
                    successCount++;
                } else {
                    console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ ${interactionType} failed: ${result.error}`));
                }
            }
            
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ Contract operations completed: ${successCount}/${interactionCount} successful interactions`));
            return true;
            
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Error in contract operations: ${error.message}`));
            return false;
        }
    }
}

module.exports = ContractDeployer;