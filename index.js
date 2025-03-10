const fs = require('fs').promises;
const chalk = require('chalk');
const ora = require('ora');
const path = require('path');
const crypto = require('crypto');
const _ = require('lodash');

// Import modules
const TokenTransfer = require('./src/transfer');
const ContractDeployer = require('./src/ContractDeployer');
const ERC20TokenDeployer = require('./src/ERC20TokenDeployer');
const NFTManager = require('./src/NFTManager');
const FaucetManager = require('./src/FaucetManager');
const ContractTesterManager = require('./src/ContractTesterManager');
const BatchOperationManager = require('./src/BatchOperationManager');
const constants = require('./utils/constants');
const { addRandomDelay, getTimestamp } = require('./utils/delayUtils');

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't crash the process
});

// Load configuration from JSON
async function loadConfig() {
    try {
        const jsonExists = await fs.access('config.json').then(() => true).catch(() => false);
        if (jsonExists) {
            console.log(chalk.green(`${getTimestamp()} ✓ Found config.json`));
            const jsonContent = await fs.readFile('config.json', 'utf8');
            return JSON.parse(jsonContent);
        }
        
        console.log(chalk.yellow(`${getTimestamp()} ⚠ No configuration file found, using defaults`));
        // Return a default configuration
        return {
            enable_transfer: true,
            enable_contract_deploy: true,
            erc20: { enable_erc20: true },
            nft: { enable_nft: true },
            faucet: { enable_faucet: true },
            contract_testing: { enable_contract_testing: true },
            batch_operations: { enable_batch_operations: true },
            operation_randomization: {
                enable_randomization: false,
                excluded_operations: ["faucet"],
                operations_to_run: ["faucet", "transfer", "contract_deploy", "contract_testing", "erc20", "nft", "batch_operations"]
            },
            gas_price_multiplier: constants.GAS.PRICE_MULTIPLIER,
            max_retries: constants.RETRY.MAX_RETRIES,
            base_wait_time: constants.RETRY.BASE_WAIT_TIME,
            transfer_amount_percentage: constants.TRANSFER.AMOUNT_PERCENTAGE
        };
    } catch (error) {
        console.log(chalk.red(`${getTimestamp()} ✗ Error loading configuration: ${error.message}`));
        return {
            enable_transfer: true,
            enable_contract_deploy: true,
            erc20: { enable_erc20: true },
            nft: { enable_nft: true },
            faucet: { enable_faucet: true },
            contract_testing: { enable_contract_testing: true },
            batch_operations: { enable_batch_operations: true },
            operation_randomization: {
                enable_randomization: false,
                excluded_operations: ["faucet"],
                operations_to_run: ["faucet", "transfer", "contract_deploy", "contract_testing", "erc20", "nft", "batch_operations"]
            },
            gas_price_multiplier: constants.GAS.PRICE_MULTIPLIER,
            max_retries: constants.RETRY.MAX_RETRIES,
            base_wait_time: constants.RETRY.BASE_WAIT_TIME,
            transfer_amount_percentage: constants.TRANSFER.AMOUNT_PERCENTAGE
        };
    }
}

// Load proxies from file
async function loadProxies() {
    try {
        const proxyFile = await fs.readFile('proxy.txt', 'utf8');
        const proxies = proxyFile.split('\n').map(line => line.trim()).filter(line => line);
        console.log(chalk.green(`${getTimestamp()} ✓ Successfully loaded ${proxies.length} proxies`));
        return proxies;
    } catch (error) {
        console.log(chalk.yellow(`${getTimestamp()} ⚠ proxy.txt not found, will not use proxies`));
        return [];
    }
}

// Countdown timer for waiting between batches
async function countdownTimer(hours = 8) {
    const totalSeconds = hours * 3600;
    let remainingSeconds = totalSeconds;

    while (remainingSeconds > 0) {
        const hours = Math.floor(remainingSeconds / 3600);
        const minutes = Math.floor((remainingSeconds % 3600) / 60);
        const seconds = remainingSeconds % 60;

        // Clear previous line and update countdown
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        process.stdout.write(
            chalk.blue(`${getTimestamp()} Next cycle in: `) + 
            chalk.yellow(`${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`)
        );

        await new Promise(resolve => setTimeout(resolve, 1000));
        remainingSeconds--;
    }

    // Clear the countdown line
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    console.log(chalk.green(`${getTimestamp()} ✓ Countdown completed!`));
}

// Execute faucet operations
async function executeFaucetOperation(faucetManager, walletAddress, config, walletNum) {
    if (config.faucet && config.faucet.enable_faucet) {
        try {
            console.log(chalk.blue.bold(`\n=== Running Faucet Operations for Wallet ${walletNum} ===\n`));
            
            // Initialize faucet manager with current config
            faucetManager.setWalletNum(walletNum);
            
            // Execute faucet operations - note we're not passing discordToken anymore
            await faucetManager.executeFaucetOperations(walletAddress);
            
            // Add random delay after faucet operations
            await addRandomDelay(config, walletNum, "next operation");
            
            return true;
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(walletNum)} ✗ Error in faucet operations: ${error.message}`));
            return false;
        }
    }
    return false;
}

// Execute transfer operations
async function executeTransferOperation(tokenTransfer, pk, config, walletNum) {
    if (config.enable_transfer) {
        let success = false;
        let attempt = 0;
        
        while (!success && attempt < config.max_retries) {
            console.log(chalk.blue.bold(`\n=== Running Transfer Operations for Wallet ${walletNum} ===\n`));
            console.log(chalk.blue.bold(`${getTimestamp(walletNum)} Transferring tokens... (Attempt ${attempt + 1}/${config.max_retries})`));
            success = await tokenTransfer.transferToSelf(pk, walletNum);
            
            if (!success) {
                attempt++;
                if (attempt < config.max_retries) {
                    const waitTime = Math.min(300, config.base_wait_time * (2 ** attempt));
                    console.log(chalk.yellow(`${getTimestamp(walletNum)} Waiting ${waitTime} seconds before retry...`));
                    await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
                }
            }
        }
        
        // Add random delay after transfer operations
        await addRandomDelay(config, walletNum, "next operation");
        return success;
    }
    return false;
}

// Execute contract deployment operations
async function executeContractOperation(pk, config, walletNum) {
    if (config.enable_contract_deploy) {
        try {
            console.log(chalk.blue.bold(`\n=== Running Contract Operations for Wallet ${walletNum} ===\n`));
            
            // Initialize contract deployer with wallet's private key and current config
            const contractDeployer = new ContractDeployer(pk, config);
            contractDeployer.setWalletNum(walletNum);
            
            // Execute contract operations (compile, deploy, interact)
            await contractDeployer.executeContractOperations();
            
            // Add random delay after contract operations
            await addRandomDelay(config, walletNum, "next operation");
            
            return true;
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(walletNum)} ✗ Error in contract operations: ${error.message}`));
            return false;
        }
    }
    return false;
}

// Execute ERC20 token operations
async function executeERC20Operation(pk, config, walletNum) {
    if (config.erc20 && config.erc20.enable_erc20) {
        try {
            console.log(chalk.blue.bold(`\n=== Running ERC20 Token Operations for Wallet ${walletNum} ===\n`));
            
            // Initialize ERC20 token deployer with wallet's private key and current config
            const erc20Deployer = new ERC20TokenDeployer(pk, config);
            erc20Deployer.setWalletNum(walletNum);
            
            // Execute ERC20 token operations (compile, deploy, mint, burn)
            await erc20Deployer.executeTokenOperations();
            
            // Add random delay after ERC20 operations
            await addRandomDelay(config, walletNum, "next operation");
            
            return true;
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(walletNum)} ✗ Error in ERC20 token operations: ${error.message}`));
            return false;
        }
    }
    return false;
}

// Execute NFT operations
async function executeNFTOperation(pk, config, walletNum) {
    if (config.nft && config.nft.enable_nft) {
        try {
            console.log(chalk.blue.bold(`\n=== Running NFT Operations for Wallet ${walletNum} ===\n`));
            
            // Initialize NFT manager with wallet's private key and current config
            const nftManager = new NFTManager(pk, config);
            nftManager.setWalletNum(walletNum);
            
            // Execute NFT operations (compile, deploy, mint, burn)
            await nftManager.executeNFTOperations();
            
            // Add random delay after NFT operations
            await addRandomDelay(config, walletNum, "completing wallet operations");
            
            return true;
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(walletNum)} ✗ Error in NFT operations: ${error.message}`));
            return false;
        }
    }
    return false;
}

// Execute contract testing operations
async function executeContractTestingOperation(pk, config, walletNum) {
    if (config.contract_testing && config.contract_testing.enable_contract_testing) {
        try {
            console.log(chalk.blue.bold(`\n=== Running Contract Testing Operations for Wallet ${walletNum} ===\n`));
            
            // Initialize contract tester manager with wallet's private key and current config
            const contractTesterManager = new ContractTesterManager(pk, config);
            contractTesterManager.setWalletNum(walletNum);
            
            // Execute contract testing operations
            await contractTesterManager.executeContractTestingOperations();
            
            // Add random delay after contract testing operations
            await addRandomDelay(config, walletNum, "next operation");
            
            return true;
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(walletNum)} ✗ Error in contract testing operations: ${error.message}`));
            return false;
        }
    }
    return false;
}

// Execute batch operations
async function executeBatchOperation(pk, config, walletNum) {
    if (config.batch_operations && config.batch_operations.enable_batch_operations) {
        try {
            console.log(chalk.blue.bold(`\n=== Running Batch Operations for Wallet ${walletNum} ===\n`));
            
            // Initialize batch operation manager with wallet's private key and current config
            const batchOperationManager = new BatchOperationManager(pk, config);
            batchOperationManager.setWalletNum(walletNum);
            
            // Execute batch operations
            await batchOperationManager.executeBatchOperationOperations();
            
            // Add random delay after batch operations
            await addRandomDelay(config, walletNum, "next operation");
            
            return true;
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(walletNum)} ✗ Error in batch operations: ${error.message}`));
            return false;
        }
    }
    return false;
}

// Randomize operations order
function getRandomizedOperations(config) {
    const randomizationConfig = config.operation_randomization || { 
        enable_randomization: false, 
        excluded_operations: ["faucet"],
        operations_to_run: ["faucet", "transfer", "contract_deploy", "contract_testing", "erc20", "nft", "batch_operations"]
    };
    
    // Define all operations
    const allOperations = [
        { name: "faucet", fn: executeFaucetOperation },
        { name: "transfer", fn: executeTransferOperation },
        { name: "contract_deploy", fn: executeContractOperation },
        { name: "contract_testing", fn: executeContractTestingOperation },
        { name: "erc20", fn: executeERC20Operation },
        { name: "nft", fn: executeNFTOperation },
        { name: "batch_operations", fn: executeBatchOperation }
    ];
    
    // Filter operations based on operations_to_run config
    const operationsToRun = randomizationConfig.operations_to_run || 
        ["faucet", "transfer", "contract_deploy", "contract_testing", "erc20", "nft", "batch_operations"];
    
    const filteredOperations = allOperations.filter(op => operationsToRun.includes(op.name));
    
    // Split operations into fixed and randomizable based on excluded_operations
    const excludedOps = randomizationConfig.excluded_operations || [];
    const fixedOps = filteredOperations.filter(op => excludedOps.includes(op.name));
    const randomizableOps = filteredOperations.filter(op => !excludedOps.includes(op.name));
    
    // Randomize operations if enabled
    if (randomizationConfig.enable_randomization && randomizableOps.length > 1) {
        // Fisher-Yates shuffle algorithm
        for (let i = randomizableOps.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [randomizableOps[i], randomizableOps[j]] = [randomizableOps[j], randomizableOps[i]];
        }
    }
    
    // Return operations in order: fixed operations first, then randomized operations
    return [...fixedOps, ...randomizableOps];
}

async function main() {
    while (true) {
        console.log(chalk.blue.bold('\n=== Zenchain Testnet Automation Tool ===\n'));

        try {
            // Load configuration
            const config = await loadConfig();
            console.log(chalk.green(`${getTimestamp()} ✓ Configuration loaded`));
            
            // Load proxies
            const proxies = await loadProxies();
            
            // Load private keys
            const privateKeys = (await fs.readFile('pk.txt', 'utf8'))
                .split('\n')
                .map(line => line.trim())
                .filter(line => line);

            console.log(chalk.green(`${getTimestamp()} ✓ Found ${privateKeys.length} private keys`));
            
            console.log(chalk.blue.bold(`${getTimestamp()} Initializing automation...`));

            // Create instances of our modules
            const tokenTransfer = new TokenTransfer(config);
            const faucetManager = new FaucetManager(config);

            // Process wallets
            console.log(chalk.blue.bold(`\nProcessing ${privateKeys.length} wallets...\n`));

            for (let i = 0; i < privateKeys.length; i++) {
                const walletNum = i + 1;
                const pk = privateKeys[i];
                
                console.log(chalk.blue.bold(`\n=== Processing Wallet ${walletNum}/${privateKeys.length} ===\n`));

                // Get random proxy if available
                const proxy = proxies.length > 0 ? 
                    proxies[Math.floor(Math.random() * proxies.length)] : null;
                
                if (proxy) {
                    console.log(chalk.cyan(`${getTimestamp(walletNum)} ℹ Using proxy: ${proxy}`));
                }
                
                // Create a Web3 account from the private key to get the address
                const { Web3 } = require('web3');
                const web3 = new Web3();
                const account = web3.eth.accounts.privateKeyToAccount(pk.startsWith('0x') ? pk : '0x' + pk);
                const walletAddress = account.address;
                
                // Get randomized operations
                const operations = getRandomizedOperations(config);
                
                // Create a fresh FaucetManager instance with the selected proxy
                const walletFaucetManager = new FaucetManager(config, proxy);
                
                // Log the operation sequence
                console.log(chalk.cyan(`${getTimestamp(walletNum)} ℹ Operations sequence: ${operations.map(op => op.name).join(' -> ')}`));
                
                // Execute operations in the determined order
                for (const operation of operations) {
                    if (operation.name === "faucet") {
                        await operation.fn(walletFaucetManager, walletAddress, config, walletNum);
                    } else if (operation.name === "transfer") {
                        await operation.fn(tokenTransfer, pk, config, walletNum);
                    } else {
                        await operation.fn(pk, config, walletNum);
                    }
                }

                // Wait between wallets
                if (i < privateKeys.length - 1) {
                    const waitTime = Math.floor(Math.random() * 11) + 5; // 5-15 seconds
                    console.log(chalk.yellow(`\n${getTimestamp(walletNum)} Waiting ${waitTime} seconds before next wallet...\n`));
                    await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
                }
            }

            console.log(chalk.green.bold('\nWallet processing completed! Starting 8-hour countdown...\n'));

            // Start the countdown timer
            await countdownTimer(8);

        } catch (error) {
            console.error(chalk.red(`\nError: ${error.message}`));
            process.exit(1);
        }
    }
}

main().catch(console.error);