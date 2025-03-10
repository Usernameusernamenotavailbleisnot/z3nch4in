const { Web3 } = require('web3');
const chalk = require('chalk');
const solc = require('solc');
const constants = require('../utils/constants');
const { addRandomDelay, getTimestamp } = require('../utils/delayUtils');

class BatchOperationManager {
    constructor(privateKey, config = {}) {
        // Default configuration
        this.defaultConfig = {
            enable_batch_operations: true,
            operations_per_batch: {
                min: 2,
                max: 5
            }
        };
        
        // Deep merge the configuration to properly handle nested objects
        this.config = {
            ...this.defaultConfig,
            ...(config.batch_operations || {})
        };
        
        // Explicitly ensure operations_per_batch settings are properly merged
        if (config.batch_operations && config.batch_operations.operations_per_batch) {
            this.config.operations_per_batch = {
                ...this.defaultConfig.operations_per_batch,
                ...config.batch_operations.operations_per_batch
            };
            
            // Log the actual operations_per_batch values being used
            console.log(chalk.cyan(`${getTimestamp()} ℹ Batch operations config: min=${this.config.operations_per_batch.min}, max=${this.config.operations_per_batch.max}`));
        }
        
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
    
    // Get batch processor contract source
    getBatchProcessorSource() {
        return `
        // SPDX-License-Identifier: MIT
        pragma solidity >=0.8.0 <0.9.0;
        
        contract BatchProcessor {
            address public owner;
            uint256 public operationCount;
            uint256 public lastValue;
            mapping(uint256 => string) public operations;
            
            event OperationExecuted(uint256 indexed opId, string operationType);
            event BatchProcessed(uint256 operationCount);
            
            constructor() {
                owner = msg.sender;
                operationCount = 0;
                lastValue = 0;
            }
            
            function setValue(uint256 _value) public {
                lastValue = _value;
                operations[operationCount] = "setValue";
                operationCount++;
                emit OperationExecuted(operationCount - 1, "setValue");
            }
            
            function incrementValue() public {
                lastValue++;
                operations[operationCount] = "incrementValue";
                operationCount++;
                emit OperationExecuted(operationCount - 1, "incrementValue");
            }
            
            function decrementValue() public {
                if (lastValue > 0) {
                    lastValue--;
                }
                operations[operationCount] = "decrementValue";
                operationCount++;
                emit OperationExecuted(operationCount - 1, "decrementValue");
            }
            
            function squareValue() public {
                lastValue = lastValue * lastValue;
                operations[operationCount] = "squareValue";
                operationCount++;
                emit OperationExecuted(operationCount - 1, "squareValue");
            }
            
            function resetValue() public {
                lastValue = 0;
                operations[operationCount] = "resetValue";
                operationCount++;
                emit OperationExecuted(operationCount - 1, "resetValue");
            }
            
            function multiplyValue(uint256 _multiplier) public {
                lastValue = lastValue * _multiplier;
                operations[operationCount] = "multiplyValue";
                operationCount++;
                emit OperationExecuted(operationCount - 1, "multiplyValue");
            }
            
            function executeBatch(string[] memory batchOperations, uint256[] memory parameters) public {
                require(batchOperations.length > 0, "Empty batch");
                require(batchOperations.length == parameters.length, "Operations and parameters length mismatch");
                
                uint256 initialOpCount = operationCount;
                
                for (uint256 i = 0; i < batchOperations.length; i++) {
                    bytes32 opHash = keccak256(abi.encodePacked(batchOperations[i]));
                    
                    if (opHash == keccak256(abi.encodePacked("setValue"))) {
                        setValue(parameters[i]);
                    } else if (opHash == keccak256(abi.encodePacked("incrementValue"))) {
                        incrementValue();
                    } else if (opHash == keccak256(abi.encodePacked("decrementValue"))) {
                        decrementValue();
                    } else if (opHash == keccak256(abi.encodePacked("squareValue"))) {
                        squareValue();
                    } else if (opHash == keccak256(abi.encodePacked("resetValue"))) {
                        resetValue();
                    } else if (opHash == keccak256(abi.encodePacked("multiplyValue"))) {
                        multiplyValue(parameters[i]);
                    } else {
                        revert("Unknown operation");
                    }
                }
                
                emit BatchProcessed(operationCount - initialOpCount);
            }
            
            function getStatus() public view returns (uint256, uint256) {
                return (operationCount, lastValue);
            }
        }
        `;
    }
    
    // Compile the batch processor contract
    async compileBatchProcessor() {
        try {
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Compiling BatchProcessor contract...`));
            
            // Setup compiler input with specific EVM version to ensure compatibility
            const input = {
                language: 'Solidity',
                sources: {
                    'BatchProcessor.sol': {
                        content: this.getBatchProcessorSource()
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
            const contract = output.contracts['BatchProcessor.sol']['BatchProcessor'];
            
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ BatchProcessor contract compiled successfully!`));
            
            return {
                abi: contract.abi,
                bytecode: contract.evm.bytecode.object
            };
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Failed to compile BatchProcessor contract: ${error.message}`));
            throw error;
        }
    }
    
    // Deploy the batch processor contract
    async deployBatchProcessor() {
        try {
            // Compile the contract
            const compiledContract = await this.compileBatchProcessor();
            
            // Add random delay before deployment
            await addRandomDelay(this.config, this.walletNum, "batch processor deployment");
            
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Deploying BatchProcessor contract...`));
            
            // Create contract instance for deployment
            const contract = new this.web3.eth.Contract(compiledContract.abi);
            
            // Prepare deployment transaction
            const deployTx = contract.deploy({
                data: '0x' + compiledContract.bytecode,
                arguments: []
            });
            
            // Get nonce and gas price
            const nonce = await this.getNonce();
            const gasPrice = await this.getGasPrice();
            
            // Estimate gas
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
                nonce: nonce,
                gas: Math.floor(Number(estimatedGas) * 1.2), // Add 20% buffer
                gasPrice: gasPrice,
                data: deployTx.encodeABI(),
                chainId: constants.NETWORK.CHAIN_ID
            };
            
            // Sign transaction
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Signing contract deployment transaction...`));
            const signedTx = await this.web3.eth.accounts.signTransaction(tx, this.account.privateKey);
            
            // Increment nonce before sending
            this.incrementNonce();
            
            // Send the transaction
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Sending contract deployment transaction...`));
            const receipt = await this.web3.eth.sendSignedTransaction(signedTx.rawTransaction);
            
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ BatchProcessor contract deployed at: ${receipt.contractAddress}`));
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ View transaction: ${constants.NETWORK.EXPLORER_URL}/tx/${receipt.transactionHash}`));
            
            return {
                contractAddress: receipt.contractAddress,
                abi: compiledContract.abi,
                txHash: receipt.transactionHash
            };
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Error deploying BatchProcessor contract: ${error.message}`));
            throw error;
        }
    }
    
    // Test individual operations for verification
    async testIndividualOperations(contractAddress, abi) {
        try {
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Testing individual operations...`));
            
            // Create contract instance
            const contract = new this.web3.eth.Contract(abi, contractAddress);
            
            // Test setValue operation
            const testValue = Math.floor(Math.random() * 100) + 1;
            
            // Add random delay before operation
            await addRandomDelay(this.config, this.walletNum, "individual operation test");
            
            // Prepare the setValue transaction
            const setValueTx = contract.methods.setValue(testValue);
            
            // Get nonce and gas price
            const nonce = await this.getNonce();
            const gasPrice = await this.getGasPrice();
            
            // Transaction template for gas estimation
            const txTemplate = {
                from: this.account.address,
                to: contractAddress,
                data: setValueTx.encodeABI(),
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
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Signing transaction for setValue(${testValue})...`));
            const signedTx = await this.web3.eth.accounts.signTransaction(tx, this.account.privateKey);
            
            // Increment nonce before sending
            this.incrementNonce();
            
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Sending setValue transaction...`));
            const receipt = await this.web3.eth.sendSignedTransaction(signedTx.rawTransaction);
            
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ setValue operation successful`));
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ View transaction: ${constants.NETWORK.EXPLORER_URL}/tx/${receipt.transactionHash}`));
            
            // Verify the value was set correctly
            const status = await contract.methods.getStatus().call();
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Current status - Operation count: ${status[0]}, Last value: ${status[1]}`));
            
            return {
                txHash: receipt.transactionHash,
                operationCount: status[0],
                lastValue: status[1],
                success: true
            };
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Error testing individual operations: ${error.message}`));
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    // Generate random batch operations
    generateBatchOperations() {
        // Available operations
        const operations = [
            "setValue",
            "incrementValue",
            "decrementValue",
            "squareValue",
            "resetValue",
            "multiplyValue"
        ];
        
        // Determine number of operations in batch - use exact values from config
        const minOps = this.config.operations_per_batch.min;
        const maxOps = this.config.operations_per_batch.max;
        
        // Log the actual values being used
        console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Using operations per batch range: min=${minOps}, max=${maxOps}`));
        
        // Calculate the actual number of operations
        const numOperations = Math.floor(Math.random() * (maxOps - minOps + 1)) + minOps;
        
        console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Generating batch with ${numOperations} operations...`));
        
        // Generate random operations and parameters
        const batchOperations = [];
        const parameters = [];
        
        for (let i = 0; i < numOperations; i++) {
            // Select random operation
            const operation = operations[Math.floor(Math.random() * operations.length)];
            batchOperations.push(operation);
            
            // Generate appropriate parameter based on operation
            let parameter = 0;
            if (operation === "setValue") {
                parameter = Math.floor(Math.random() * 100) + 1; // Random value from 1 to 100
            } else if (operation === "multiplyValue") {
                parameter = Math.floor(Math.random() * 5) + 2; // Random multiplier from 2 to 6
            } else {
                parameter = 0; // Other operations don't use parameters
            }
            parameters.push(parameter);
        }
        
        return { batchOperations, parameters };
    }
    
    // Execute batch operations
    async executeBatchOperations(contractAddress, abi) {
        try {
            // Generate random batch operations
            const { batchOperations, parameters } = this.generateBatchOperations();
            
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Executing batch operations: ${batchOperations.join(', ')}...`));
            
            // Add random delay before batch execution
            await addRandomDelay(this.config, this.walletNum, "batch execution");
            
            // Create contract instance
            const contract = new this.web3.eth.Contract(abi, contractAddress);
            
            // Prepare the executeBatch transaction
            const executeBatchTx = contract.methods.executeBatch(batchOperations, parameters);
            
            // Get nonce and gas price
            const nonce = await this.getNonce();
            const gasPrice = await this.getGasPrice();
            
            // Transaction template for gas estimation
            const txTemplate = {
                from: this.account.address,
                to: contractAddress,
                data: executeBatchTx.encodeABI(),
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
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Signing transaction for batch execution...`));
            const signedTx = await this.web3.eth.accounts.signTransaction(tx, this.account.privateKey);
            
            // Increment nonce before sending
            this.incrementNonce();
            
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Sending batch execution transaction...`));
            const receipt = await this.web3.eth.sendSignedTransaction(signedTx.rawTransaction);
            
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ Batch execution successful`));
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ View transaction: ${constants.NETWORK.EXPLORER_URL}/tx/${receipt.transactionHash}`));
            
            // Verify the status after batch execution
            const status = await contract.methods.getStatus().call();
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Status after batch execution - Operation count: ${status[0]}, Last value: ${status[1]}`));
            
            return {
                txHash: receipt.transactionHash,
                operations: batchOperations,
                parameters: parameters,
                operationCount: status[0],
                lastValue: status[1],
                success: true
            };
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Error executing batch operations: ${error.message}`));
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    // Execute multiple batches
    async executeMultipleBatches(contractAddress, abi) {
        try {
            // Determine number of batches to execute
            const numBatches = Math.floor(Math.random() * 2) + 1; // 1 to 2 batches
            
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Will execute ${numBatches} batch operations...`));
            
            const results = [];
            
            for (let i = 0; i < numBatches; i++) {
                console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Executing batch ${i + 1}/${numBatches}...`));
                
                // Execute batch
                const result = await this.executeBatchOperations(contractAddress, abi);
                results.push(result);
                
                // Add random delay between batches if not the last one
                if (i < numBatches - 1) {
                    await addRandomDelay(this.config, this.walletNum, `next batch (${i + 2}/${numBatches})`);
                }
            }
            
            return results;
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Error executing multiple batches: ${error.message}`));
            return [];
        }
    }
    
    // Execute all batch operation operations
    async executeBatchOperationOperations() {
        if (!this.config.enable_batch_operations) {
            console.log(chalk.yellow(`${getTimestamp(this.walletNum)} ⚠ Batch operations disabled in config`));
            return true;
        }
        
        console.log(chalk.blue.bold(`${getTimestamp(this.walletNum)} Starting batch operation operations...`));
        
        try {
            // Reset nonce tracking at the start of operations
            this.currentNonce = null;
            
            // Step 1: Deploy batch processor contract
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Step 1: Deploying batch processor contract...`));
            const batchProcessor = await this.deployBatchProcessor();
            
            // Step 2: Test individual operations for verification
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Step 2: Testing individual operations...`));
            await this.testIndividualOperations(batchProcessor.contractAddress, batchProcessor.abi);
            
            // Step 3: Execute multiple batches
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Step 3: Executing multiple batches...`));
            const batchResults = await this.executeMultipleBatches(batchProcessor.contractAddress, batchProcessor.abi);
            
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ Batch operation operations completed successfully!`));
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ Batch processor: ${batchProcessor.contractAddress}`));
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ View contract: ${constants.NETWORK.EXPLORER_URL}/address/${batchProcessor.contractAddress}`));
            
            return true;
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Error in batch operation operations: ${error.message}`));
            return false;
        }
    }
}

module.exports = BatchOperationManager;