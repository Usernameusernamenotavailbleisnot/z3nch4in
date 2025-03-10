const { Web3 } = require('web3');
const chalk = require('chalk');
const ora = require('ora');
const solc = require('solc');
const crypto = require('crypto');
const constants = require('../utils/constants');
const { addRandomDelay, getTimestamp } = require('../utils/delayUtils');

class NFTManager {
    constructor(privateKey, config = {}) {
        // Default NFT configuration
        this.defaultConfig = {
            enable_nft: true,
            mint_count: {
                min: 2,
                max: 10
            },
            burn_percentage: 20,
            supply: {
                min: 100,
                max: 1000
            }
        };
        
        // Load configuration
        this.config = { ...this.defaultConfig, ...config.nft };
        
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
    
    generateRandomNFTName() {
        const prefix = constants.NFT.NAME_PREFIXES[Math.floor(Math.random() * constants.NFT.NAME_PREFIXES.length)];
        const suffix = constants.NFT.NAME_SUFFIXES[Math.floor(Math.random() * constants.NFT.NAME_SUFFIXES.length)];
        return `${prefix} ${suffix}`;
    }
    
    generateRandomNFTSymbol(name) {
        // Create a symbol from the first letters of each word in the name
        return name.split(' ')
            .map(word => word.charAt(0).toUpperCase())
            .join('');
    }
    
    async compileContract(contractName) {
        const spinner = ora(`Compiling NFT contract (${contractName})...`).start();
        
        try {
            // Replace placeholder in template with actual contract name
            const contractSource = constants.NFT.CONTRACT_TEMPLATE.replace(/{{CONTRACT_NAME}}/g, contractName);
            
            // Setup compiler input with specific EVM version to ensure compatibility
            const input = {
                language: 'Solidity',
                sources: {
                    'NFTContract.sol': {
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
            const contract = output.contracts['NFTContract.sol'][contractName];
            
            spinner.succeed('NFT contract compiled successfully!');
            
            return {
                abi: contract.abi,
                bytecode: contract.evm.bytecode.object
            };
        } catch (error) {
            spinner.fail(`Failed to compile contract: ${error.message}`);
            throw error;
        }
    }
    
    async deployContract(contractName, symbol, maxSupply) {
        const spinner = ora(`Deploying NFT contract "${contractName}" (${symbol})...`).start();
        
        try {
            // Format contract name for Solidity (remove spaces and special chars)
            const solContractName = contractName.replace(/[^a-zA-Z0-9]/g, '');
            
            // Compile the contract
            spinner.stop(); // Stop spinner before compilation
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Compiling NFT contract...`));
            const compiledContract = await this.compileContract(solContractName);
            
            // Add random delay before deployment
            spinner.stop();
            await addRandomDelay(this.config, this.walletNum, "NFT contract deployment");
            spinner.start(`Deploying NFT contract "${contractName}" (${symbol})...`);
            
            // Create contract instance for deployment
            const contract = new this.web3.eth.Contract(compiledContract.abi);
            
            // Prepare deployment transaction
            const deployTx = contract.deploy({
                data: '0x' + compiledContract.bytecode,
                arguments: [contractName, symbol, maxSupply]
            });
            
            // Get nonce and gas price with optimizations - stop spinner during this
            spinner.stop();
            const nonce = await this.getNonce();
            const gasPrice = await this.getGasPrice();
            
            // Estimate gas - still no spinner
            let estimatedGas;
            try {
                estimatedGas = await deployTx.estimateGas({
                    from: this.account.address
                });
                console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Estimated gas: ${estimatedGas}`));
            } catch (error) {
                console.log(chalk.yellow(`${getTimestamp(this.walletNum)} ⚠ Gas estimation failed: ${error.message}`));
                estimatedGas = 3000000; // Higher default for NFT contracts
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
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Signing NFT contract deployment transaction...`));
            const signedTx = await this.web3.eth.accounts.signTransaction(tx, this.account.privateKey);
            
            // Increment nonce before sending
            this.incrementNonce();
            
            // Restart spinner for transaction sending
            spinner.start('Sending NFT contract deployment transaction...');
            
            // Send the transaction
            const receipt = await this.web3.eth.sendSignedTransaction(signedTx.rawTransaction);
            
            spinner.succeed(`NFT contract deployed at: ${receipt.contractAddress}`);
            
            return {
                contractAddress: receipt.contractAddress,
                abi: compiledContract.abi,
                name: contractName,
                symbol: symbol,
                txHash: receipt.transactionHash
            };
        } catch (error) {
            spinner.fail(`Failed to deploy NFT contract: ${error.message}`);
            throw error;
        }
    }
    
    generateTokenMetadata(tokenId, collectionName) {
        // Generate random attributes
        const rarities = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Mythic'];
        const rarity = rarities[Math.floor(Math.random() * rarities.length)];
        
        const categories = ['Art', 'Collectible', 'Game', 'Meme', 'PFP', 'Utility'];
        const category = categories[Math.floor(Math.random() * categories.length)];
        
        // Generate metadata
        const crypto = require('crypto');

        // Generate metadata
        const metadata = {
            name: `${collectionName} #${tokenId}`,
            description: `A unique NFT from the ${collectionName} collection.`,
            image: `https://i.seadn.io/s/raw/files/${crypto.randomBytes(16).toString('hex')}.png?auto=format&dpr=1&w=1920`,
            attributes: [
                {
                    trait_type: 'Rarity',
                    value: rarity
                },
                {
                    trait_type: 'Category',
                    value: category
                },
                {
                    trait_type: 'Token ID',
                    value: tokenId.toString()
                },
                {
                    trait_type: 'Generation',
                    value: 'Genesis'
                }
            ]
        };
        
        // In a real application, you would upload this to IPFS or a similar service
        // For this example, we'll encode it as a data URI
        return `data:application/json;base64,${Buffer.from(JSON.stringify(metadata)).toString('base64')}`;
    }
    
    async mintNFT(contractAddress, abi, tokenId, tokenURI) {
        try {
            // Add random delay before minting
            await addRandomDelay(this.config, this.walletNum, `NFT minting (token #${tokenId})`);
            
            // Create contract instance
            const contract = new this.web3.eth.Contract(abi, contractAddress);
            
            // Prepare the mint transaction
            const mintTx = contract.methods.mint(this.account.address, tokenId, tokenURI);
            
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
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Signing transaction for NFT minting (#${tokenId})...`));
            const signedTx = await this.web3.eth.accounts.signTransaction(tx, this.account.privateKey);
            
            // Increment nonce before sending
            this.incrementNonce();
            
            const receipt = await this.web3.eth.sendSignedTransaction(signedTx.rawTransaction);
            
            return {
                tokenId,
                txHash: receipt.transactionHash,
                success: true
            };
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Error minting NFT ${tokenId}: ${error.message}`));
            return {
                tokenId,
                success: false,
                error: error.message
            };
        }
    }
    
    async burnNFT(contractAddress, abi, tokenId) {
        try {
            // Add random delay before burning
            await addRandomDelay(this.config, this.walletNum, `NFT burning (token #${tokenId})`);
            
            // Create contract instance
            const contract = new this.web3.eth.Contract(abi, contractAddress);
            
            // Make sure we own this token
            const tokenOwner = await contract.methods.ownerOf(tokenId).call();
            if (tokenOwner.toLowerCase() !== this.account.address.toLowerCase()) {
                throw new Error(`Token ${tokenId} not owned by this wallet`);
            }
            
            // Prepare the burn transaction
            const burnTx = contract.methods.burn(tokenId);
            
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
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Signing transaction for NFT burning (#${tokenId})...`));
            const signedTx = await this.web3.eth.accounts.signTransaction(tx, this.account.privateKey);
            
            // Increment nonce before sending
            this.incrementNonce();
            
            const receipt = await this.web3.eth.sendSignedTransaction(signedTx.rawTransaction);
            
            return {
                tokenId,
                txHash: receipt.transactionHash,
                success: true
            };
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Error burning NFT ${tokenId}: ${error.message}`));
            return {
                tokenId,
                success: false,
                error: error.message
            };
        }
    }
    
    async executeNFTOperations() {
        if (!this.config.enable_nft) {
            console.log(chalk.yellow(`${getTimestamp(this.walletNum)} ⚠ NFT operations disabled in config`));
            return true;
        }
        
        console.log(chalk.blue.bold(`${getTimestamp(this.walletNum)} Starting NFT operations...`));
        
        try {
            // Reset nonce tracking at the start of operations
            this.currentNonce = null;
            
            // Generate random NFT collection name and symbol
            const collectionName = this.generateRandomNFTName();
            const symbol = this.generateRandomNFTSymbol(collectionName);
            
            // Generate random max supply
            const minSupply = Math.max(10, this.config.supply.min || 100);
            const maxSupply = Math.max(minSupply, this.config.supply.max || 1000);
            const supply = Math.floor(Math.random() * (maxSupply - minSupply + 1)) + minSupply;
            
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ NFT Collection: ${collectionName} (${symbol})`));
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Max Supply: ${supply}`));
            
            // Deploy contract
            const deployedContract = await this.deployContract(collectionName, symbol, supply);
            
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ Contract deployed at: ${deployedContract.contractAddress}`));
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ View transaction: ${constants.NETWORK.EXPLORER_URL}/tx/${deployedContract.txHash}`));
            
            // Determine mint count based on config
            const minMint = Math.max(1, this.config.mint_count.min || 2);
            const maxMint = Math.min(supply, Math.max(minMint, this.config.mint_count.max || 10));
            const mintCount = Math.floor(Math.random() * (maxMint - minMint + 1)) + minMint;
            
            console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Will mint ${mintCount} NFTs...`));
            
            // Mint NFTs
            const mintedTokens = [];
            for (let i = 0; i < mintCount; i++) {
                const tokenId = i;
                const tokenURI = this.generateTokenMetadata(tokenId, collectionName);
                
                console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Minting token #${tokenId}...`));
                const mintResult = await this.mintNFT(
                    deployedContract.contractAddress,
                    deployedContract.abi,
                    tokenId,
                    tokenURI
                );
                
                if (mintResult.success) {
                    mintedTokens.push(tokenId);
                    console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ Token #${tokenId} minted successfully`));
                    console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ View transaction: ${constants.NETWORK.EXPLORER_URL}/tx/${mintResult.txHash}`));
                } else {
                    console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Failed to mint token #${tokenId}: ${mintResult.error}`));
                }
            }
            
            // Determine burn count based on config percentage
            const burnPercentage = Math.min(100, Math.max(0, this.config.burn_percentage || 20));
            const burnCount = Math.ceil(mintedTokens.length * burnPercentage / 100);
            
            if (burnCount > 0 && mintedTokens.length > 0) {
                console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Burning ${burnCount} NFTs (${burnPercentage}% of minted)...`));
                
                // Randomly select tokens to burn
                const tokensToBurn = [...mintedTokens]
                    .sort(() => Math.random() - 0.5) // Shuffle
                    .slice(0, burnCount);
                
                for (const tokenId of tokensToBurn) {
                    console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ Burning token #${tokenId}...`));
                    const burnResult = await this.burnNFT(
                        deployedContract.contractAddress,
                        deployedContract.abi,
                        tokenId
                    );
                    
                    if (burnResult.success) {
                        console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ Token #${tokenId} burned successfully`));
                        console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ View transaction: ${constants.NETWORK.EXPLORER_URL}/tx/${burnResult.txHash}`));
                    } else {
                        console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Failed to burn token #${tokenId}: ${burnResult.error}`));
                    }
                }
            } else {
                console.log(chalk.cyan(`${getTimestamp(this.walletNum)} ℹ No tokens to burn (burn percentage: ${burnPercentage}%)`));
            }
            
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ NFT operations completed successfully!`));
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ Contract address: ${deployedContract.contractAddress}`));
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ Total minted: ${mintedTokens.length}, Burned: ${burnCount}`));
            console.log(chalk.green(`${getTimestamp(this.walletNum)} ✓ View collection: ${constants.NETWORK.EXPLORER_URL}/address/${deployedContract.contractAddress}`));
            
            return true;
        } catch (error) {
            console.log(chalk.red(`${getTimestamp(this.walletNum)} ✗ Error executing NFT operations: ${error.message}`));
            return false;
        }
    }
}

module.exports = NFTManager;