const { Web3 } = require('web3');
const chalk = require('chalk');
const solc = require('solc');
const constants = require('../utils/constants');
const { addRandomDelay, getTimestamp } = require('../utils/delayUtils');

class ContractTesterManager {
    constructor(privateKey, config = {}) {
        // Default configuration
        this.defaultConfig = {
            enable_contract_testing: true,
            test_sequences: ["parameter_variation", "stress_test", "boundary_test"],
            iterations: {
                min: 3,
                max: 10
            }
        };
        
        // Deep merge the configuration to properly handle nested objects
        this.config = {
            ...this.defaultConfig,
            ...(config.contract_testing || {})
        };
        
        // Explicitly ensure iterations settings are properly merged
        if (config.contract_testing && config.contract_testing.iterations) {
            this.config.iterations = {
                ...this.defaultConfig.iterations,
                ...config.contract_testing.iterations
            };
            
            // Log the actual iteration values being used
            console.log(chalk.cyan(`${getTimestamp()} ℹ Contract testing iterations config: min=${this.config.iterations.min}, max=${this.config.iterations.max}`));
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
    
    // Compile the test contract
    async compileTestContract() {
        try {
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Compiling parameter tester contract...`));
            
            // Setup compiler input with specific EVM version to ensure compatibility
            const input = {
                language: 'Solidity',
                sources: {
                    'ParameterTesterContract.sol': {
                        content: constants.CONTRACT_TESTING.TEST_CONTRACT_SOURCE
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
            const contract = output.contracts['ParameterTesterContract.sol']['ParameterTesterContract'];
            
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ Parameter tester contract compiled successfully!`));
            
            return {
                abi: contract.abi,
                bytecode: contract.evm.bytecode.object
            };
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Failed to compile parameter tester contract: ${error.message}`));
            throw error;
        }
    }
    
    // Deploy the test contract
    async deployTestContract() {
        try {
            // Compile the contract
            const compiledContract = await this.compileTestContract();
            
            // Add random delay before deployment
            await addRandomDelay(this.config, this.walletNum, "test contract deployment");
            
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Deploying parameter tester contract...`));
            
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
            
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ Parameter tester contract deployed at: ${receipt.contractAddress}`));
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ View transaction: ${constants.NETWORK.EXPLORER_URL}/tx/${receipt.transactionHash}`));
            
            return {
                contractAddress: receipt.contractAddress,
                abi: compiledContract.abi,
                txHash: receipt.transactionHash
            };
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Error deploying parameter tester contract: ${error.message}`));
            throw error;
        }
    }
    
    // Generate test values for parameter variation
    generateTestValues() {
        // Generate a mix of regular, edge case, and random values
        const testValues = [
            0, // Zero
            1, // One
            10, // Small number
            100, // Medium number
            1000, // Large number
            10000, // Very large number
            2**32 - 1, // 32-bit max
            2**48 - 1, // 48-bit max
            Math.floor(Number.MAX_SAFE_INTEGER / 2), // Half of JS safe integer
            Number.MAX_SAFE_INTEGER // JS safe integer max
        ];
        
        // Add some random values
        for (let i = 0; i < 5; i++) {
            testValues.push(Math.floor(Math.random() * 1000000));
        }
        
        return testValues;
    }
    
    // Execute parameter variation tests
    async performParameterVariationTests(contractAddress, abi) {
        try {
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Starting parameter variation tests...`));
            
            // Create contract instance
            const contract = new this.web3.eth.Contract(abi, contractAddress);
            
            // Generate test values
            const testValues = this.generateTestValues();
            
            // Get number of iterations - ensure we're using exact values from config
            const minIterations = this.config.iterations.min;
            const maxIterations = this.config.iterations.max;
            
            // Log the actual values being used
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Using iterations range: min=${minIterations}, max=${maxIterations}`));
            
            // Calculate the actual number of iterations to run
            const iterations = Math.floor(Math.random() * (maxIterations - minIterations + 1)) + minIterations;
            
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Will perform ${iterations} iterations of parameter variation tests...`));
            
            let successCount = 0;
            
            for (let i = 0; i < iterations; i++) {
                // Select a random test value
                const value = testValues[Math.floor(Math.random() * testValues.length)];
                
                // Add random delay before test
                await addRandomDelay(this.config, this.walletNum, `parameter test ${i+1}/${iterations}`);
                
                console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Testing parameter value: ${value} (${i+1}/${iterations})...`));
                
                // Call setValue function
                try {
                    // Prepare transaction
                    const setValueTx = contract.methods.setValue(value);
                    
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
                    
                    // Sign and send transaction
                    console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Signing transaction for setValue(${value})...`));
                    const signedTx = await this.web3.eth.accounts.signTransaction(tx, this.account.privateKey);
                    
                    // Increment nonce before sending
                    this.incrementNonce();
                    
                    // Send transaction
                    const receipt = await this.web3.eth.sendSignedTransaction(signedTx.rawTransaction);
                    
                    console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ Parameter test successful: setValue(${value})`));
                    console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ View transaction: ${constants.NETWORK.EXPLORER_URL}/tx/${receipt.transactionHash}`));
                    successCount++;
                    
                    // After setting, verify the value was set correctly
                    const verifyValue = await contract.methods.getValue().call();
                    console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Verified value: ${verifyValue}`));
                } catch (error) {
                    console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Parameter test failed for value ${value}: ${error.message}`));
                }
            }
            
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ Parameter variation tests completed: ${successCount}/${iterations} successful`));
            return successCount > 0;
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Error in parameter variation tests: ${error.message}`));
            return false;
        }
    }
    
    // Execute stress tests
    async performStressTests(contractAddress, abi) {
        try {
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Starting stress tests...`));
            
            // Create contract instance
            const contract = new this.web3.eth.Contract(abi, contractAddress);
            
            // Define stress test operations
            const operations = [
                { name: "addValue", fn: (value) => contract.methods.addValue(value) },
                { name: "subtractValue", fn: (value) => contract.methods.subtractValue(value) }
            ];
            
            // Get number of iterations - use exact values from config
            const minIterations = this.config.iterations.min;
            const maxIterations = this.config.iterations.max;
            
            // Log the actual values being used
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Using iterations range: min=${minIterations}, max=${maxIterations}`));
            
            // Calculate the actual number of iterations to run
            const iterations = Math.floor(Math.random() * (maxIterations - minIterations + 1)) + minIterations;
            
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Will perform ${iterations} iterations of stress tests...`));
            
            let successCount = 0;
            
            // First set a base value
            try {
                const baseValue = 10000;
                
                // Prepare transaction
                const setValueTx = contract.methods.setValue(baseValue);
                
                // Get nonce and gas price
                const nonce = await this.getNonce();
                const gasPrice = await this.getGasPrice();
                
                // Transaction template
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
                
                // Sign and send transaction
                console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Setting base value for stress tests: ${baseValue}...`));
                const signedTx = await this.web3.eth.accounts.signTransaction(tx, this.account.privateKey);
                
                // Increment nonce before sending
                this.incrementNonce();
                
                // Send transaction
                const receipt = await this.web3.eth.sendSignedTransaction(signedTx.rawTransaction);
                
                console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ Base value set to ${baseValue}`));
                console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ View transaction: ${constants.NETWORK.EXPLORER_URL}/tx/${receipt.transactionHash}`));
            } catch (error) {
                console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Failed to set base value for stress tests: ${error.message}`));
                return false;
            }
            
            // Now perform stress tests
            for (let i = 0; i < iterations; i++) {
                // Select a random operation
                const operation = operations[Math.floor(Math.random() * operations.length)];
                
                // Generate a random value for the operation
                const value = Math.floor(Math.random() * 100) + 1;
                
                // Add random delay before test
                await addRandomDelay(this.config, this.walletNum, `stress test ${i+1}/${iterations}`);
                
                console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Stress test: ${operation.name}(${value}) (${i+1}/${iterations})...`));
                
                try {
                    // Prepare transaction
                    const operationTx = operation.fn(value);
                    
                    // Get nonce and gas price
                    const nonce = await this.getNonce();
                    const gasPrice = await this.getGasPrice();
                    
                    // Transaction template
                    const txTemplate = {
                        from: this.account.address,
                        to: contractAddress,
                        data: operationTx.encodeABI(),
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
                    
                    // Sign and send transaction
                    console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Signing transaction for ${operation.name}(${value})...`));
                    const signedTx = await this.web3.eth.accounts.signTransaction(tx, this.account.privateKey);
                    
                    // Increment nonce before sending
                    this.incrementNonce();
                    
                    // Send transaction
                    const receipt = await this.web3.eth.sendSignedTransaction(signedTx.rawTransaction);
                    
                    console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ Stress test successful: ${operation.name}(${value})`));
                    console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ View transaction: ${constants.NETWORK.EXPLORER_URL}/tx/${receipt.transactionHash}`));
                    successCount++;
                    
                    // Check current value
                    const currentValue = await contract.methods.getValue().call();
                    console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Current value after operation: ${currentValue}`));
                } catch (error) {
                    console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Stress test failed for ${operation.name}(${value}): ${error.message}`));
                }
            }
            
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ Stress tests completed: ${successCount}/${iterations} successful`));
            return successCount > 0;
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Error in stress tests: ${error.message}`));
            return false;
        }
    }
    
    // Execute boundary tests
    async performBoundaryTests(contractAddress, abi) {
        try {
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Starting boundary tests...`));
            
            // Create contract instance
            const contract = new this.web3.eth.Contract(abi, contractAddress);
            
            // Since boundary tests use fixed values, we'll log the config but not use random iterations
            const minIterations = this.config.iterations.min;
            const maxIterations = this.config.iterations.max;
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Config iterations range: min=${minIterations}, max=${maxIterations} (not used for boundary tests)`));
            
            // Define boundary test values
            const boundaryValues = [
                0, // Zero
                1, // One
                2**16 - 1, // 16-bit max (65535)
                2**16, // 16-bit max + 1
                2**32 - 1, // 32-bit max
                2**32, // 32-bit max + 1
                2**48 - 1, // 48-bit max
                2**48, // 48-bit max + 1
                Number.MAX_SAFE_INTEGER // JS safe integer max
            ];
            
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Will test ${boundaryValues.length} boundary values...`));
            
            let successCount = 0;
            
            for (let i = 0; i < boundaryValues.length; i++) {
                const value = boundaryValues[i];
                
                // Add random delay before test
                await addRandomDelay(this.config, this.walletNum, `boundary test ${i+1}/${boundaryValues.length}`);
                
                console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Boundary test: setValue(${value}) (${i+1}/${boundaryValues.length})...`));
                
                try {
                    // Prepare transaction
                    const setValueTx = contract.methods.setValue(value);
                    
                    // Get nonce and gas price
                    const nonce = await this.getNonce();
                    const gasPrice = await this.getGasPrice();
                    
                    // Transaction template
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
                    
                    // Sign and send transaction
                    console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Signing transaction for setValue(${value})...`));
                    const signedTx = await this.web3.eth.accounts.signTransaction(tx, this.account.privateKey);
                    
                    // Increment nonce before sending
                    this.incrementNonce();
                    
                    // Send transaction
                    const receipt = await this.web3.eth.sendSignedTransaction(signedTx.rawTransaction);
                    
                    console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ Boundary test successful: setValue(${value})`));
                    console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ View transaction: ${constants.NETWORK.EXPLORER_URL}/tx/${receipt.transactionHash}`));
                    successCount++;
                    
                    // Verify the value was set correctly
                    const verifyValue = await contract.methods.getValue().call();
                    console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Verified value: ${verifyValue}`));
                } catch (error) {
                    console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Boundary test failed for value ${value}: ${error.message}`));
                }
            }
            
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ Boundary tests completed: ${successCount}/${boundaryValues.length} successful`));
            return successCount > 0;
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Error in boundary tests: ${error.message}`));
            return false;
        }
    }
    
    // Execute all contract testing operations
    async executeContractTestingOperations() {
        if (!this.config.enable_contract_testing) {
            console.log(chalk.yellow(`${getTimestamp(this.walletNum)} ⚠ Contract testing operations disabled in config`));
            return true;
        }
        
        console.log(chalk.blue.bold(`${getTimestamp(this.walletNum)} Starting contract testing operations...`));
        
        try {
            // Reset nonce tracking at the start of operations
            this.currentNonce = null;
            
            // Deploy the test contract
            const deployedContract = await this.deployTestContract();
            
            // Get test sequences to run
            const testSequences = this.config.test_sequences || ["parameter_variation", "stress_test", "boundary_test"];
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Will run the following test sequences: ${testSequences.join(', ')}`));
            
            let results = {
                parameter_variation: false,
                stress_test: false,
                boundary_test: false
            };
            
            // Run selected test sequences
            for (const sequence of testSequences) {
                switch (sequence) {
                    case "parameter_variation":
                        results.parameter_variation = await this.performParameterVariationTests(deployedContract.contractAddress, deployedContract.abi);
                        break;
                    case "stress_test":
                        results.stress_test = await this.performStressTests(deployedContract.contractAddress, deployedContract.abi);
                        break;
                    case "boundary_test":
                        results.boundary_test = await this.performBoundaryTests(deployedContract.contractAddress, deployedContract.abi);
                        break;
                }
            }
            
            // Summarize results
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ Contract testing operations completed!`));
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ Contract address: ${deployedContract.contractAddress}`));
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ View contract: ${constants.NETWORK.EXPLORER_URL}/address/${deployedContract.contractAddress}`));
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ Test results:`));
            
            for (const [sequence, result] of Object.entries(results)) {
                if (testSequences.includes(sequence)) {
                    console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ - ${sequence}: ${result ? 'Successful' : 'Failed'}`));
                }
            }
            
            return true;
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Error in contract testing operations: ${error.message}`));
            return false;
        }
    }
}

module.exports = ContractTesterManager;